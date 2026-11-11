/*!
 * Native decode and output.
 *
 * symphonia decodes, cpal plays, rodio wires the two together and resamples to whatever the
 * output device wants. This exists to replace the hidden `youtube.com` IFrame — a whole
 * subframe process, roughly 90 MB — and the `<audio>` element behind it.
 *
 * Two sinks stand in for the two IFrame decks. The next track is decoded and appended to the
 * standby sink while the current one is still playing, so a handover is a volume ramp between
 * two live sinks rather than a stop followed by a load. That is what makes gapless and
 * crossfade work here, which they never did on the `<audio>` path.
 *
 * Everything runs on one owned thread behind a channel. cpal's stream handle is not `Send` on
 * every backend and Tauri state must be, so nothing but the `Sender` leaves this module. The
 * same thread runs the position tick out of its own `recv_timeout`, rather than a second thread
 * contending for the same state.
 */

use std::io::{self, Read, Seek, SeekFrom};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rodio::cpal::StreamError;
use rodio::stream::{DeviceSinkBuilder, MixerDeviceSink};
use rodio::{DeviceTrait, Player, Source};
use serde::Serialize;
use symphonia::core::io::MediaSource;
use tauri::{AppHandle, Emitter};

use crate::MediaBuffer;

/// How often position is reported and the end of a track is checked for.
///
/// Matches `TRANSITION_TICK_MS` in `PlayerController`, which is what consumes it — a faster
/// feed would be redundant, a slower one would make the progress bar visibly step.
const TICK: Duration = Duration::from_millis(250);

/// Ramp granularity during a crossfade. 50 steps a second is well below what the ear resolves
/// as stepping, and the thread is otherwise idle.
const FADE_STEP: Duration = Duration::from_millis(20);

/// How long a decoder read waits for bytes that have not landed yet before giving up.
const READ_TIMEOUT: Duration = Duration::from_secs(20);
/// Poll interval while waiting on the download. Short enough to be inaudible.
const READ_POLL: Duration = Duration::from_millis(10);

/// A stream that dies sooner than this after opening is a device that will not come back by
/// reopening it, so loads refuse for this long instead of walking the queue through it.
const STREAM_RETRY_WINDOW: Duration = Duration::from_secs(10);

/// A decoded stream ready to be handed to a deck. rodio resamples it to the device's rate.
pub(crate) type BoxedSource = Box<dyn Source + Send>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PositionEvent {
    track_id: String,
    position_sec: f64,
    duration_sec: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EndedEvent {
    track_id: String,
}

/**
 * A `Read + Seek` view over a body that is still downloading.
 *
 * This is what lets the first sample play before the last byte arrives: the decoder reads the
 * container header out of the head chunk while the rest is still in flight. `MediaBuffer` only
 * reports its contiguous prefix, so a read never sees a hole — it waits for one to fill.
 *
 * ponytail: the wait happens on rodio's mixing thread, so a connection that falls behind
 * playback is an audible stall rather than a dropped track. Move decoding onto its own thread
 * behind a bounded channel if that ever shows up in practice; with a 128 KiB head chunk and a
 * ~160 kbps stream there is a large margin.
 */
pub(crate) struct BufferReader {
    buffer: Arc<Mutex<MediaBuffer>>,
    position: usize,
}

impl BufferReader {
    pub(crate) fn new(buffer: Arc<Mutex<MediaBuffer>>) -> Self {
        Self { buffer, position: 0 }
    }

    /// `(contiguous_len, total, failed)` — read under one lock so the three cannot disagree.
    fn state(&self) -> io::Result<(usize, usize, bool)> {
        let guard = self
            .buffer
            .lock()
            .map_err(|_| io::Error::other("audio buffer lock poisoned"))?;
        Ok((guard.contiguous_len(), guard.total, guard.failed))
    }
}

impl Read for BufferReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() {
            return Ok(0);
        }

        let deadline = Instant::now() + READ_TIMEOUT;
        loop {
            let (available, total, failed) = self.state()?;

            if self.position >= total {
                return Ok(0);
            }
            if available > self.position {
                let want = out.len().min(available.min(total) - self.position);
                // Straight into the decoder's buffer: one copy, no intermediate Vec per read.
                let copied = self
                    .buffer
                    .lock()
                    .map_err(|_| io::Error::other("audio buffer lock poisoned"))?
                    .read_into(self.position, &mut out[..want]);
                self.position += copied;
                return Ok(copied);
            }
            /*
             * A failed download reports EOF rather than an error. The decoder then finishes the
             * frames it already has and the track ends early, which is a truncated song instead
             * of a dead sink that never reports `ended` and hangs the queue.
             */
            if failed {
                return Ok(0);
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "timed out waiting for audio bytes",
                ));
            }
            std::thread::sleep(READ_POLL);
        }
    }
}

/**
 * Seekable and self-describing, so symphonia can probe a container it is still downloading.
 *
 * `byte_len` comes from the URL's own `clen` rather than from what has arrived — the demuxer
 * uses it to locate the tail of a Matroska file, and answering with the current fill would
 * point it at the middle of the download.
 */
impl MediaSource for BufferReader {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        self.state().ok().map(|(_, total, _)| total as u64)
    }
}

impl Seek for BufferReader {
    fn seek(&mut self, from: SeekFrom) -> io::Result<u64> {
        let (_, total, _) = self.state()?;
        let target = match from {
            SeekFrom::Start(offset) => offset as i64,
            SeekFrom::Current(delta) => self.position as i64 + delta,
            SeekFrom::End(delta) => total as i64 + delta,
        };
        if target < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek before the start of the audio body",
            ));
        }
        /*
         * Seeking past what has arrived is allowed and does not wait. The next `read` is where
         * the wait belongs — symphonia probes by seeking around the container, and blocking on
         * a seek it may never read from would stall a load for no reason.
         */
        self.position = (target as usize).min(total);
        Ok(self.position as u64)
    }
}

/**
 * Whether the bytes behind a deck are still arriving.
 *
 * A deck is loaded as soon as the decoder can read the container header, which is the head of
 * the first chunk — the rest of the file is still downloading behind it. When that download
 * fails there is nothing about the deck itself that looks wrong: it holds a real source with a
 * real duration, and it will play the seconds it has and then simply stop.
 *
 * A closure rather than a field, because what "still arriving" means belongs to whoever opened
 * the reader. `lib.rs` builds one over the `MediaBuffer` for streams; offline and local files
 * have no such failure mode and pass `None`.
 */
pub(crate) type DeckHealth = Arc<dyn Fn() -> bool + Send + Sync>;

struct Deck {
    sink: Player,
    track_id: Option<String>,
    duration_sec: f64,
    health: Option<DeckHealth>,
}

impl Deck {
    fn clear(&mut self) {
        self.sink.stop();
        self.track_id = None;
        self.duration_sec = 0.0;
        self.health = None;
    }

    /// False only when a probe exists and says the source is broken. No probe means healthy.
    fn is_healthy(&self) -> bool {
        self.health.as_ref().is_none_or(|probe| probe())
    }
}

/// An in-progress crossfade. Held so the tick can advance it a step at a time instead of the
/// command loop sleeping through it and starving position events.
struct Fade {
    started_at: Instant,
    duration: Duration,
    /// The deck being faded out — already the standby by the time this exists.
    outgoing: usize,
}

pub(crate) enum Command {
    Load {
        track_id: String,
        source: BoxedSource,
        /// The provider's own duration, used when the container does not declare one — Opus in
        /// WebM usually does not, and a zero duration would break preload timing upstream.
        fallback_duration_sec: f64,
        decoded_duration_sec: Option<f64>,
        standby: bool,
        /// See `DeckHealth`. `None` for sources that cannot fail mid-playback.
        health: Option<DeckHealth>,
        reply: Sender<Result<f64, String>>,
    },
    Play(Sender<Result<(), String>>),
    Pause,
    Stop,
    Seek(f64),
    Volume {
        volume: f32,
        muted: bool,
    },
    Rate(f32),
    /// Reopens the stream on a different device, `None` for the OS default. Both decks are lost
    /// with the old stream — the caller reloads whatever was playing, the same way a track
    /// recovers from a dead connection elsewhere in this pipeline.
    SetOutputDevice {
        id: Option<String>,
        reply: Sender<Result<(), String>>,
    },
    Transition {
        track_id: String,
        fade_ms: u64,
        reply: Sender<bool>,
    },
    /// Whether `track_id` is sitting decoded on the standby deck.
    HasStandby {
        track_id: String,
        reply: Sender<bool>,
    },
    DropStandby,
    /// The output stream of this generation died. Sent by the stream's own error callback.
    StreamFailed(u64),
    /// Stops and clears the active deck only, leaving the standby deck untouched.
    ///
    /// The narrow counterpart to `DropStandby`, and the one a cancelled *load* needs: `Stop`
    /// clears both decks, which is right for an actual stop but wrong for a skip that lands
    /// mid-load — it discarded whatever the standby was decoding for the track the skip was
    /// heading towards, so a preload could never survive a second click arriving before the
    /// first one finished.
    DropActive,
}

/// The handle held as Tauri state. Cheap to clone, trivially `Send + Sync`.
pub(crate) struct NativeAudio {
    sender: Mutex<Option<Sender<Command>>>,
    app: AppHandle,
    /// Which device the next lazy thread start should open. Only consulted at startup — a
    /// change after that goes through `Command::SetOutputDevice` instead, via `set_output_device`.
    pending_device: Mutex<Option<String>>,
}

impl NativeAudio {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self { sender: Mutex::new(None), app, pending_device: Mutex::new(None) }
    }

    /**
     * Starts the audio thread on first use.
     *
     * Deliberately lazy: opening an output device claims a real handle from the OS mixer, and a
     * user on the IFrame engine should never pay for one. A failure here is what a machine with
     * no working audio device reports, so it is surfaced rather than swallowed.
     */
    pub(crate) fn send(&self, command: Command) -> Result<(), String> {
        let mut slot = self
            .sender
            .lock()
            .map_err(|_| "native audio lock poisoned".to_string())?;

        // Stopping an engine that never started has nothing to do, and must not open a device.
        if slot.is_none() && matches!(command, Command::Stop) {
            return Ok(());
        }
        let command = match slot.as_ref() {
            Some(sender) => match sender.send(command) {
                Ok(()) => return Ok(()),
                // The thread died (a panic): start a fresh one rather than fail forever.
                Err(mpsc::SendError(command)) => command,
            },
            None => command,
        };

        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let app = self.app.clone();
        let commands = tx.clone();
        let device = self
            .pending_device
            .lock()
            .map_err(|_| "native audio lock poisoned".to_string())?
            .clone();
        std::thread::Builder::new()
            .name("zuno-audio".into())
            .spawn(move || run(app, rx, commands, ready_tx, device))
            .map_err(|error| format!("audio thread failed to start: {error}"))?;
        ready_rx
            .recv()
            .map_err(|_| "audio thread stopped before it was ready".to_string())??;
        tx.send(command).map_err(|_| "audio thread is gone".to_string())?;
        *slot = Some(tx);
        Ok(())
    }

    /**
     * Sets which output device the engine writes to, `None` for the OS default.
     *
     * Before the thread exists this only records the preference for the next lazy start — it
     * does not claim a device handle early, the same laziness `send` documents above. Once the
     * thread is running, a change hot-swaps the live stream; `pending_device` is still kept
     * current for a thread restarted after a panic.
     */
    pub(crate) fn set_output_device(&self, id: Option<String>) -> Result<(), String> {
        // Recorded either way, so a thread started or restarted later opens the latest choice.
        *self
            .pending_device
            .lock()
            .map_err(|_| "native audio lock poisoned".to_string())? = id.clone();
        let sender = self
            .sender
            .lock()
            .map_err(|_| "native audio lock poisoned".to_string())?
            .clone();
        let Some(sender) = sender else { return Ok(()) };

        let (tx, rx) = mpsc::channel();
        // A dead thread is fine: the next command restarts it on the device recorded above.
        if sender.send(Command::SetOutputDevice { id, reply: tx }).is_err() {
            return Ok(());
        }
        rx.recv().map_err(|_| "audio thread dropped the request".to_string())?
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioOutputDevice {
    /// `DeviceId::to_string()` — opaque, and the only part of this that round-trips through
    /// `open_device_sink`. A device's name is not guaranteed unique or stable across a
    /// reconnect on every backend; its id is what cpal documents as surviving both.
    id: String,
    name: String,
    is_default: bool,
}

/**
 * Enumerates cpal output devices.
 *
 * Pure enumeration, not routed through the audio thread — it never opens a device, so an
 * IFrame-only user never pays for one just to see the dropdown, and it works before the thread
 * has ever started.
 */
pub(crate) fn list_output_devices() -> Result<Vec<AudioOutputDevice>, String> {
    // When a sound server owns the hardware, its own sink list is the truth about what's
    // actually plugged in (it already does jack-sensing); raw ALSA per-card enumeration below
    // can't tell a live port from an empty one and duplicates what the server already presents.
    #[cfg(target_os = "linux")]
    if let Some(sinks) = pipewire_sinks() {
        return Ok(sinks);
    }

    use rodio::cpal::traits::HostTrait;

    let host = rodio::cpal::default_host();
    let default_id = host.default_output_device().and_then(|device| device.id().ok());
    let devices = host
        .output_devices()
        .map_err(|error| format!("failed to list audio output devices: {error}"))?;

    Ok(devices
        .filter_map(|device| {
            let id = device.id().ok()?;
            let id_string = id.to_string();
            #[cfg(target_os = "linux")]
            if is_alsa_plugin_noise(&id_string) {
                return None;
            }
            let name = device.description().ok()?.name().to_string();
            let is_default = default_id.as_ref() == Some(&id);
            Some(AudioOutputDevice { id: id_string, name, is_default })
        })
        .collect())
}

/// ALSA registers dozens of generic "type" PCMs — rate converters, plugin wrappers, and
/// per-card surround/iec958 variants most cards don't actually support — globally in
/// alsa.conf regardless of what hardware is plugged in, and cpal's hint enumeration surfaces
/// every one of them. On top of that, cpal's physical-device probe re-adds every card as raw
/// `hw:`/`plughw:` entries, duplicating the friendly `sysdefault:`/`hdmi:` hints for the same
/// hardware. This keeps only the handful of genuinely distinct, selectable outputs (default,
/// pulse/pipewire, and each card's sysdefault:/typed hint) and drops the rest.
///
/// ponytail: excluding `hw`/`plughw` outright assumes every card also gets a friendly hint
/// (true for the stock alsa.conf `sysdefault` auto-config). A card with no such hint would
/// become unselectable — if that surfaces, add it back only when its CARD= has no other entry.
#[cfg(target_os = "linux")]
fn is_alsa_plugin_noise(id: &str) -> bool {
    const NOISY_TYPES: &[&str] = &[
        "null", "jack", "oss", "speex", "speexrate", "lavrate", "samplerate", "upmix", "vdownmix",
        "surround21", "surround40", "surround41", "surround50", "surround51", "surround71",
        "iec958", "spdif", "usbstream", "dmix", "dsnoop", "front", "rear", "center_lfe", "side",
        "modem", "phoneline", "shm", "tee", "file", "empty", "rate", "route", "mulaw", "alaw",
        "adpcm", "plug", "multi", "ladspa", "asym", "hw", "plughw",
    ];
    let type_name = id.split(':').next().unwrap_or(id);
    NOISY_TYPES.contains(&type_name)
}

#[cfg(all(test, target_os = "linux"))]
mod alsa_device_filter_tests {
    use super::is_alsa_plugin_noise;

    #[test]
    fn drops_alsa_plugin_and_virtual_types() {
        assert!(is_alsa_plugin_noise("null"));
        assert!(is_alsa_plugin_noise("surround51:CARD=PCH,DEV=0"));
        assert!(is_alsa_plugin_noise("iec958:CARD=PCH,DEV=0"));
        assert!(is_alsa_plugin_noise("usbstream:CARD=Device"));
        assert!(is_alsa_plugin_noise("front:CARD=PCH,DEV=0"));
        // Raw hw:/plughw: duplicate the friendly sysdefault:/hdmi: hints for the same card.
        assert!(is_alsa_plugin_noise("hw:CARD=PCH,DEV=0"));
        assert!(is_alsa_plugin_noise("plughw:CARD=PCH,DEV=0"));
    }

    #[test]
    fn keeps_genuinely_selectable_outputs() {
        assert!(!is_alsa_plugin_noise("default"));
        assert!(!is_alsa_plugin_noise("pulse"));
        assert!(!is_alsa_plugin_noise("pipewire"));
        assert!(!is_alsa_plugin_noise("sysdefault:CARD=PCH"));
        assert!(!is_alsa_plugin_noise("hdmi:CARD=HDMI,DEV=0"));
    }
}

/// Prefix marking an id as a PipeWire/PulseAudio sink name rather than a cpal `DeviceId` — the
/// two live in different namespaces and `open_device_sink` needs to tell them apart.
#[cfg(target_os = "linux")]
const PIPEWIRE_SINK_ID_PREFIX: &str = "pipewire-sink:";

/// Sink list from `pactl`, when a sound server is running. `None` means no server (or `pactl`
/// missing) — falls back to raw ALSA enumeration.
#[cfg(target_os = "linux")]
fn pipewire_sinks() -> Option<Vec<AudioOutputDevice>> {
    let output = std::process::Command::new("pactl")
        .args(["-f", "json", "list", "sinks"])
        .output()
        .ok()?;
    let sinks = serde_json::from_slice::<serde_json::Value>(&output.stdout).ok()?;
    let sinks = sinks.as_array().filter(|sinks| !sinks.is_empty())?;

    let default_name = std::process::Command::new("pactl")
        .arg("get-default-sink")
        .output()
        .ok()
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string());

    Some(
        sinks
            .iter()
            .filter_map(|sink| {
                let name = sink.get("name")?.as_str()?;
                let description = sink.get("description").and_then(|d| d.as_str()).unwrap_or(name);
                Some(AudioOutputDevice {
                    id: format!("{PIPEWIRE_SINK_ID_PREFIX}{name}"),
                    name: description.to_string(),
                    is_default: default_name.as_deref() == Some(name),
                })
            })
            .collect(),
    )
}

/// Steers our own stream to `sink_name` after it's already open on whatever the server picked.
/// The ALSA "pulse"/"pipewire" virtual device cpal opens can't target a specific sink by name —
/// that's a sound-server-level move, done here via `pactl` rather than at open time.
///
/// A failure here is never fatal: the stream keeps playing on the server's chosen sink, same as
/// before the user picked a different one, which is a smaller surprise than losing audio.
#[cfg(target_os = "linux")]
fn move_our_stream_to_pipewire_sink(sink_name: &str) {
    // ponytail: bounded retry rather than a proper "client registered" signal — PipeWire needs
    // a moment after the stream opens before our sink-input shows up in its graph.
    for attempt in 0..10 {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(50));
        }
        let Some(sink_input_id) = our_sink_input_id() else { continue };
        let moved = std::process::Command::new("pactl")
            .args(["move-sink-input", &sink_input_id.to_string(), sink_name])
            .status()
            .is_ok_and(|status| status.success());
        if moved {
            return;
        }
    }
    eprintln!(
        "[internal][tauri][warn] failed to move audio stream to pipewire sink sink={sink_name}"
    );
}

/// The freshest sink-input whose client name is ours — cpal opens a brand new PipeWire client
/// on every device switch, so the highest index among ours is the one that was just opened.
#[cfg(target_os = "linux")]
fn our_sink_input_id() -> Option<u64> {
    let output = std::process::Command::new("pactl")
        .args(["-f", "json", "list", "sink-inputs"])
        .output()
        .ok()?;
    let inputs = serde_json::from_slice::<serde_json::Value>(&output.stdout).ok()?;
    inputs
        .as_array()?
        .iter()
        .filter(|input| {
            input
                .get("properties")
                .and_then(|props| props.get("application.name"))
                .and_then(|name| name.as_str())
                .is_some_and(|name| name.contains(env!("CARGO_PKG_NAME")))
        })
        .filter_map(|input| input.get("index")?.as_u64())
        .max()
}

/**
 * Opens the sink for `id`, or the OS default when `id` is `None`.
 *
 * A device id that no longer resolves — unplugged, a saved choice from a machine that changed
 * underneath it — falls back to the default rather than refusing outright. The alternative is a
 * stored preference from weeks ago turning into silence the user has to notice and go fix in
 * settings, which is a worse failure than picking a device for them.
 */
fn open_device_sink(
    id: Option<&str>,
    on_error: impl FnMut(StreamError) + Send + 'static,
) -> Result<MixerDeviceSink, String> {
    #[cfg(target_os = "linux")]
    if let Some(sink_name) = id.and_then(|id| id.strip_prefix(PIPEWIRE_SINK_ID_PREFIX)) {
        let stream = open_default_sink(on_error)?;
        move_our_stream_to_pipewire_sink(sink_name);
        return Ok(stream);
    }

    let device = id.and_then(|id| {
        let device = find_output_device(id);
        if device.is_none() {
            eprintln!(
                "[internal][tauri][warn] native_audio output device not found, using default id={}",
                id
            );
        }
        device
    });

    match device {
        Some(device) => DeviceSinkBuilder::from_device(device)
            .and_then(|builder| builder.with_error_callback(on_error).open_stream())
            .map_err(|error| format!("failed to open audio output device: {error}")),
        None => open_default_sink(on_error),
    }
}

// ponytail: rodio's fallback to another device keeps its own logging callback, so a stream on
// a fallback device is not recovered. Reimplement `open_default_sink` if that ever matters.
fn open_default_sink(
    on_error: impl FnMut(StreamError) + Send + 'static,
) -> Result<MixerDeviceSink, String> {
    DeviceSinkBuilder::from_default_device()
        .and_then(|builder| builder.with_error_callback(on_error).open_stream())
        .or_else(|_| DeviceSinkBuilder::open_default_sink())
        .map_err(|error| format!("no audio output device: {error}"))
}

fn stream_failure_reporter(
    commands: Sender<Command>,
    generation: u64,
) -> impl FnMut(StreamError) + Send + 'static {
    let mut reported = false;
    move |error| {
        // cpal recovers underruns itself. Anything else leaves the stream dead, and on ALSA it
        // reports that POLLERR in a tight loop until the stream is dropped (#154).
        if matches!(error, StreamError::BufferUnderrun) || reported {
            return;
        }
        reported = true;
        eprintln!("[internal][tauri][warn] native_audio stream failed: {error}");
        let _ = commands.send(Command::StreamFailed(generation));
    }
}

/// Opens `id` with two fresh, paused decks on it. The stream reports its own death once, as
/// `StreamFailed(generation)`.
fn open_output(
    id: Option<&str>,
    commands: Sender<Command>,
    generation: u64,
) -> Result<(MixerDeviceSink, [Deck; 2]), String> {
    let stream = open_device_sink(id, stream_failure_reporter(commands, generation))?;
    let deck = || {
        let sink = Player::connect_new(stream.mixer());
        sink.pause();
        Deck { sink, track_id: None, duration_sec: 0.0, health: None }
    };
    let decks = [deck(), deck()];
    Ok((stream, decks))
}

fn find_output_device(id: &str) -> Option<rodio::Device> {
    use rodio::cpal::traits::HostTrait;

    let id: rodio::cpal::DeviceId = id.parse().ok()?;
    rodio::cpal::default_host().device_by_id(&id)
}

/// Sends a command and waits for its reply, mapping a dead thread to an error rather than a
/// hang. Every reply channel in `Command` is a one-shot, so a single `recv` is the whole
/// protocol.
pub(crate) fn request<T>(
    state: &NativeAudio,
    build: impl FnOnce(Sender<T>) -> Command,
) -> Result<T, String> {
    let (tx, rx) = mpsc::channel();
    state.send(build(tx))?;
    rx.recv()
        .map_err(|_| "audio thread dropped the request".to_string())
}

fn run(
    app: AppHandle,
    rx: Receiver<Command>,
    commands: Sender<Command>,
    ready: Sender<Result<(), String>>,
    initial_device: Option<String>,
) {
    let (stream, decks) = match open_output(initial_device.as_deref(), commands.clone(), 0) {
        Ok(output) => output,
        Err(error) => {
            let _ = ready.send(Err(error));
            return;
        }
    };

    let mut engine = Engine {
        app,
        stream: Some(stream),
        device_id: initial_device,
        commands,
        generation: 0,
        opened_at: Instant::now(),
        reopen_after: None,
        lost_track: None,
        decks,
        active: 0,
        volume: 1.0,
        muted: false,
        rate: 1.0,
        playing: false,
        fade: None,
    };

    if ready.send(Ok(())).is_err() {
        return;
    }

    let mut next_tick = Instant::now() + TICK;
    loop {
        let now = Instant::now();
        let until_tick = next_tick.saturating_duration_since(now);
        // A fade needs finer steps than the position tick, so whichever is due first wins.
        let timeout = if engine.fade.is_some() { until_tick.min(FADE_STEP) } else { until_tick };

        match rx.recv_timeout(timeout) {
            Ok(command) => {
                if engine.handle(command) {
                    return;
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            // Every sender is gone, which only happens at shutdown.
            Err(RecvTimeoutError::Disconnected) => return,
        }

        engine.advance_fade();
        if Instant::now() >= next_tick {
            engine.tick();
            next_tick = Instant::now() + TICK;
        }
    }
}

struct Engine {
    app: AppHandle,
    /// Dropping this closes the output device, so it outlives every deck connected to it.
    /// `None` once it has died, until the next load reopens it.
    stream: Option<MixerDeviceSink>,
    /// What to reopen, `None` for the OS default.
    device_id: Option<String>,
    /// Handed to each stream's error callback, the way back onto this thread.
    commands: Sender<Command>,
    /// Bumped per stream, so a late error from a replaced stream is ignored.
    generation: u64,
    opened_at: Instant,
    /// Loads refuse to reopen before this; see `STREAM_RETRY_WINDOW`.
    reopen_after: Option<Instant>,
    /// The track a paused deck lost with its stream, handed back for a reload on the next play.
    lost_track: Option<String>,
    decks: [Deck; 2],
    active: usize,
    volume: f32,
    muted: bool,
    rate: f32,
    playing: bool,
    fade: Option<Fade>,
}

impl Engine {
    fn standby(&self) -> usize {
        1 - self.active
    }

    fn output_volume(&self) -> f32 {
        if self.muted {
            0.0
        } else {
            self.volume
        }
    }

    /// Returns true when the thread should stop.
    fn handle(&mut self, command: Command) -> bool {
        match command {
            Command::Load {
                track_id,
                source,
                fallback_duration_sec,
                decoded_duration_sec,
                standby,
                health,
                reply,
            } => {
                if self.stream.is_none() {
                    let reopened = if self.reopen_after.is_some_and(|at| Instant::now() < at) {
                        Err("Audio output keeps failing. Try another output device or audio engine."
                            .to_string())
                    } else {
                        self.reopen(self.device_id.clone())
                    };
                    if let Err(error) = reopened {
                        let _ = reply.send(Err(error));
                        return false;
                    }
                }
                let index = if standby { self.standby() } else { self.active };
                if !standby {
                    // A fade against a deck that is being reloaded would ramp a track that is
                    // no longer there.
                    self.cancel_fade();
                }
                let duration = decoded_duration_sec
                    .filter(|value| *value > 0.0)
                    .unwrap_or(fallback_duration_sec)
                    .max(0.0);

                /*
                 * The standby is silent until a transition ramps it up. A deck that inherited
                 * the output volume would be audible the instant it was started, and a gapless
                 * swap starts it in the same tick it becomes active.
                 */
                let volume = if standby { 0.0 } else { self.output_volume() };
                let rate = self.rate;

                let deck = &mut self.decks[index];
                deck.sink.stop();
                deck.sink.append(source);
                deck.sink.pause();
                deck.sink.set_volume(volume);
                deck.sink.set_speed(rate);
                deck.track_id = Some(track_id);
                deck.duration_sec = duration;
                deck.health = health;

                if !standby {
                    self.playing = false;
                }
                let _ = reply.send(Ok(duration));
            }
            Command::Play(reply) => {
                // Paused when its stream died: handed back as an early end, which reloads it.
                if self.decks[self.active].track_id.is_none() {
                    if let Some(track_id) = self.lost_track.take() {
                        let _ = self.app.emit("native-audio-ended", EndedEvent { track_id });
                        let _ = reply.send(Ok(()));
                        return false;
                    }
                }
                /*
                 * A crossfade already started this deck and owns its volume. The player calls
                 * `play` right after a transition to take the claim, and writing full volume
                 * here would jump the ramp to its end for the rest of the fade window.
                 */
                let volume = self.fade.is_none().then(|| self.output_volume());
                let deck = &mut self.decks[self.active];
                if deck.track_id.is_none() {
                    let _ = reply.send(Err("no track is loaded".to_string()));
                    return false;
                }
                if let Some(volume) = volume {
                    deck.sink.set_volume(volume);
                }
                deck.sink.play();
                self.playing = true;
                let _ = reply.send(Ok(()));
            }
            Command::Pause => {
                self.decks[self.active].sink.pause();
                self.playing = false;
            }
            Command::Stop => {
                self.cancel_fade();
                for deck in &mut self.decks {
                    deck.clear();
                }
                self.playing = false;
            }
            Command::Seek(seconds) => {
                let target = Duration::from_secs_f64(seconds.max(0.0));
                if let Err(error) = self.decks[self.active].sink.try_seek(target) {
                    eprintln!("[internal][tauri][warn] native audio seek failed: {error}");
                }
            }
            Command::Volume { volume, muted } => {
                self.volume = volume.clamp(0.0, 1.0);
                self.muted = muted;
                // A fade owns both volumes until it finishes; writing here would jump the ramp.
                if self.fade.is_none() {
                    self.decks[self.active].sink.set_volume(self.output_volume());
                }
            }
            Command::Rate(rate) => {
                self.rate = rate.clamp(0.25, 4.0);
                for deck in &self.decks {
                    deck.sink.set_speed(self.rate);
                }
            }
            Command::Transition { track_id, fade_ms, reply } => {
                let standby = self.standby();
                if self.decks[standby].track_id.as_deref() != Some(track_id.as_str()) {
                    let _ = reply.send(false);
                    return false;
                }
                /*
                 * Checked again here, not only in `HasStandby`.
                 *
                 * The download can fail in the gap between the caller asking and the caller
                 * swapping, and this is the last point where refusing is free — past it the
                 * outgoing deck has been cleared and there is nothing to fall back to.
                 */
                if !self.decks[standby].is_healthy() {
                    eprintln!(
                        "[internal][tauri][warn] native_audio transition refused, download failed track_id={}",
                        track_id
                    );
                    self.decks[standby].clear();
                    let _ = reply.send(false);
                    return false;
                }

                self.cancel_fade();
                let target = self.output_volume();
                self.decks[standby]
                    .sink
                    .set_volume(if fade_ms > 0 { 0.0 } else { target });
                self.decks[standby].sink.set_speed(self.rate);
                self.decks[standby].sink.play();

                let outgoing = self.active;
                self.active = standby;
                self.playing = true;

                if fade_ms > 0 {
                    self.fade = Some(Fade {
                        started_at: Instant::now(),
                        duration: Duration::from_millis(fade_ms),
                        outgoing,
                    });
                } else {
                    self.decks[outgoing].clear();
                }
                let _ = reply.send(true);
            }
            Command::HasStandby { track_id, reply } => {
                let standby = self.standby();
                let matched = self.decks[standby].track_id.as_deref() == Some(track_id.as_str());
                /*
                 * A preloaded deck whose download died is worse than no preload at all: the
                 * caller would skip stream resolution, hand over gaplessly, and play the few
                 * seconds that did arrive. Reporting it as absent sends the caller down the
                 * normal load path, which resolves a fresh URL.
                 */
                if matched && !self.decks[standby].is_healthy() {
                    eprintln!(
                        "[internal][tauri][warn] native_audio standby discarded, download failed track_id={}",
                        track_id
                    );
                    self.decks[standby].clear();
                    let _ = reply.send(false);
                    return false;
                }
                let _ = reply.send(matched);
            }
            Command::DropStandby => {
                let standby = self.standby();
                self.decks[standby].clear();
            }
            Command::DropActive => {
                // A fade reads the active deck's volume every tick; cancel it first, or the
                // next tick would ramp a deck that was just cleared.
                self.cancel_fade();
                self.decks[self.active].clear();
                self.playing = false;
            }
            Command::SetOutputDevice { id, reply } => {
                let _ = reply.send(self.reopen(id));
            }
            Command::StreamFailed(generation) => {
                if generation != self.generation || self.stream.is_none() {
                    return false;
                }
                // Dropping it is what ends cpal's loop on the dead device.
                self.stream = None;
                self.fade = None;
                if self.opened_at.elapsed() < STREAM_RETRY_WINDOW {
                    self.reopen_after = Some(Instant::now() + STREAM_RETRY_WINDOW);
                }
                let lost = self.decks[self.active].track_id.clone();
                for deck in &mut self.decks {
                    deck.clear();
                }
                match lost {
                    // An early end is what the player already reloads from, at the same position.
                    Some(track_id) if self.playing => {
                        let _ = self.app.emit("native-audio-ended", EndedEvent { track_id });
                    }
                    lost => self.lost_track = lost,
                }
                self.playing = false;
            }
        }
        false
    }

    /// Reopens the output on `id`. Both decks go with the old stream; the caller reloads.
    fn reopen(&mut self, id: Option<String>) -> Result<(), String> {
        let generation = self.generation + 1;
        let (stream, decks) = open_output(id.as_deref(), self.commands.clone(), generation)?;
        // A fade on the old decks is stale — dropped rather than settled through `cancel_fade`,
        // which would write a volume to a deck this is about to discard anyway.
        self.fade = None;
        self.stream = Some(stream);
        self.decks = decks;
        self.device_id = id;
        self.generation = generation;
        self.opened_at = Instant::now();
        self.lost_track = None;
        self.active = 0;
        self.playing = false;
        Ok(())
    }

    fn cancel_fade(&mut self) {
        if self.fade.take().is_some() {
            let volume = self.output_volume();
            self.decks[self.active].sink.set_volume(volume);
        }
    }

    /// Moves an in-progress crossfade one step, and finishes it when the window closes.
    fn advance_fade(&mut self) {
        let Some(fade) = &self.fade else { return };
        let progress = (fade.started_at.elapsed().as_secs_f32()
            / fade.duration.as_secs_f32().max(f32::EPSILON))
        .clamp(0.0, 1.0);
        let outgoing = fade.outgoing;
        let target = self.output_volume();

        /*
         * Equal-power rather than linear. Two linear ramps crossing at half volume sum to an
         * audible dip in the middle, because loudness is not proportional to amplitude; the
         * sine/cosine pair holds perceived level constant across the transition.
         */
        self.decks[outgoing]
            .sink
            .set_volume(target * (progress * std::f32::consts::FRAC_PI_2).cos());
        self.decks[self.active]
            .sink
            .set_volume(target * (progress * std::f32::consts::FRAC_PI_2).sin());

        if progress >= 1.0 {
            self.fade = None;
            self.decks[outgoing].clear();
            self.decks[self.active].sink.set_volume(target);
        }
    }

    fn tick(&mut self) {
        let index = self.active;
        let Some(track_id) = self.decks[index].track_id.clone() else { return };

        /*
         * An empty sink means the decoder ran out, which is the only end-of-track signal there
         * is. Suppressed mid-fade: the outgoing deck emptying there is the transition working,
         * not the new track finishing.
         */
        if self.playing && self.fade.is_none() && self.decks[index].sink.empty() {
            self.decks[index].clear();
            self.playing = false;
            let _ = self.app.emit("native-audio-ended", EndedEvent { track_id });
            return;
        }

        if !self.playing {
            return;
        }
        let _ = self.app.emit(
            "native-audio-position",
            PositionEvent {
                track_id,
                position_sec: self.decks[index].sink.get_pos().as_secs_f64(),
                duration_sec: self.decks[index].duration_sec,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_failure_is_reported_once_and_underruns_never() {
        let (tx, rx) = mpsc::channel();
        let mut report = stream_failure_reporter(tx, 7);
        let pollerr = || StreamError::BackendSpecific {
            err: rodio::cpal::BackendSpecificError {
                description: "`alsa::poll()` returned POLLERR".to_string(),
            },
        };

        report(StreamError::BufferUnderrun);
        assert!(rx.try_recv().is_err(), "an underrun is recovered by cpal, not by reopening");

        for _ in 0..1000 {
            report(pollerr());
        }
        assert!(matches!(rx.try_recv(), Ok(Command::StreamFailed(7))));
        assert!(rx.try_recv().is_err(), "cpal repeats POLLERR in a loop; only the first counts");
    }
}
