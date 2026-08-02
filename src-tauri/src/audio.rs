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

use rodio::stream::{DeviceSinkBuilder, MixerDeviceSink};
use rodio::{Player, Source};
use serde::Serialize;
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
                let end = (self.position + out.len()).min(available).min(total) - 1;
                let bytes = {
                    let guard = self
                        .buffer
                        .lock()
                        .map_err(|_| io::Error::other("audio buffer lock poisoned"))?;
                    guard.read(self.position, end)
                };
                if bytes.is_empty() {
                    return Ok(0);
                }
                out[..bytes.len()].copy_from_slice(&bytes);
                self.position += bytes.len();
                return Ok(bytes.len());
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

struct Deck {
    sink: Player,
    track_id: Option<String>,
    duration_sec: f64,
}

impl Deck {
    fn clear(&mut self) {
        self.sink.stop();
        self.track_id = None;
        self.duration_sec = 0.0;
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
}

/// The handle held as Tauri state. Cheap to clone, trivially `Send + Sync`.
pub(crate) struct NativeAudio {
    sender: Mutex<Option<Sender<Command>>>,
    app: AppHandle,
}

impl NativeAudio {
    pub(crate) fn new(app: AppHandle) -> Self {
        Self { sender: Mutex::new(None), app }
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

        if slot.is_none() {
            let (tx, rx) = mpsc::channel();
            let (ready_tx, ready_rx) = mpsc::channel();
            let app = self.app.clone();
            std::thread::Builder::new()
                .name("zuno-audio".into())
                .spawn(move || run(app, rx, ready_tx))
                .map_err(|error| format!("audio thread failed to start: {error}"))?;

            ready_rx
                .recv()
                .map_err(|_| "audio thread stopped before it was ready".to_string())??;
            *slot = Some(tx);
        }

        slot.as_ref()
            .expect("sender was just installed")
            .send(command)
            .map_err(|_| "audio thread is gone".to_string())
    }
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

fn run(app: AppHandle, rx: Receiver<Command>, ready: Sender<Result<(), String>>) {
    let stream = match DeviceSinkBuilder::open_default_sink() {
        Ok(stream) => stream,
        Err(error) => {
            let _ = ready.send(Err(format!("no audio output device: {error}")));
            return;
        }
    };
    let decks = [
        Deck { sink: Player::connect_new(stream.mixer()), track_id: None, duration_sec: 0.0 },
        Deck { sink: Player::connect_new(stream.mixer()), track_id: None, duration_sec: 0.0 },
    ];
    for deck in &decks {
        deck.sink.pause();
    }

    let mut engine = Engine {
        app,
        _stream: stream,
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
    _stream: MixerDeviceSink,
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
                reply,
            } => {
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

                if !standby {
                    self.playing = false;
                }
                let _ = reply.send(Ok(duration));
            }
            Command::Play(reply) => {
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
                let _ = reply.send(matched);
            }
            Command::DropStandby => {
                let standby = self.standby();
                self.decks[standby].clear();
            }
        }
        false
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
