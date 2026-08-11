use block2::RcBlock;
use objc2::rc::{Allocated, Retained};
use objc2::runtime::{AnyClass, AnyObject};
use objc2::{class, msg_send};
use objc2_foundation::{NSData, NSMutableDictionary, NSNumber, NSSize, NSString};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const MEDIA_CONTROL_EVENT: &str = "macos-media-control";
const COMMAND_SUCCESS: isize = 0;

/// `MPNowPlayingPlaybackState`. macOS decides the Now Playing app from this, so without it the
/// media keys go elsewhere and none of the handlers below ever fire.
const PLAYBACK_STATE_PLAYING: usize = 1;
const PLAYBACK_STATE_PAUSED: usize = 2;
const PLAYBACK_STATE_STOPPED: usize = 3;

/// Matches the object arm of `NativeMediaAction` in useMediaSession.ts. `Clone` for `emit`.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SeekAction {
    action: &'static str,
    position_sec: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSessionUpdate {
    title: Option<String>,
    artist: Option<String>,
    artwork_url: Option<String>,
    status: String,
    duration_sec: Option<f64>,
    position_sec: Option<f64>,
}

#[derive(Default)]
struct SessionState {
    handlers_installed: bool,
    /// The built artwork and the URL it came from. Only ever touched on the main thread.
    artwork: Option<(String, Retained<AnyObject>)>,
    /// Bytes dropped off by the fetch task. Empty means "in flight, or nothing usable".
    fetch: Option<(String, Vec<u8>)>,
}

pub struct MacosMediaSession(Mutex<SessionState>);

unsafe impl Send for MacosMediaSession {}
unsafe impl Sync for MacosMediaSession {}

#[link(name = "MediaPlayer", kind = "framework")]
extern "C" {
    static MPMediaItemPropertyTitle: *const NSString;
    static MPMediaItemPropertyArtist: *const NSString;
    static MPMediaItemPropertyArtwork: *const NSString;
    static MPMediaItemPropertyPlaybackDuration: *const NSString;
    static MPNowPlayingInfoPropertyElapsedPlaybackTime: *const NSString;
    static MPNowPlayingInfoPropertyPlaybackRate: *const NSString;
}

impl MacosMediaSession {
    pub fn new() -> Self {
        Self(Mutex::new(SessionState::default()))
    }

    fn ensure_handlers(&self, app: &AppHandle) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|error| error.to_string())?;
        if state.handlers_installed {
            return Ok(());
        }

        install_remote_command_handler(app, "playCommand", "play")?;
        install_remote_command_handler(app, "pauseCommand", "pause")?;
        // The Play/Pause key on Apple keyboards, the Touch Bar and headphone buttons all send
        // this rather than play or pause.
        install_remote_command_handler(app, "togglePlayPauseCommand", "playPause")?;
        install_remote_command_handler(app, "nextTrackCommand", "next")?;
        install_remote_command_handler(app, "previousTrackCommand", "previous")?;
        install_position_command_handler(app)?;
        state.handlers_installed = true;
        eprintln!("[internal][tauri][info] macos media remote commands registered");
        Ok(())
    }

    fn update(&self, app: &AppHandle, update: MediaSessionUpdate) -> Result<(), String> {
        self.ensure_handlers(app)?;
        let artwork = update
            .artwork_url
            .as_deref()
            .and_then(|url| self.artwork_for(app, url));
        set_now_playing_info(update, artwork);
        Ok(())
    }

    /// Cached by URL: this runs once a second, and neither a download nor an image decode
    /// belongs on that path. A miss starts one fetch and shows nothing until it lands — the
    /// next position tick, or the metadata retry ladder in `useMediaSession`, picks it up.
    fn artwork_for(&self, app: &AppHandle, url: &str) -> Option<Retained<AnyObject>> {
        let mut state = self.0.lock().ok()?;

        if let Some((cached_url, artwork)) = &state.artwork {
            if cached_url == url {
                return Some(artwork.clone());
            }
        }

        match state.fetch.take() {
            Some((fetched_url, bytes)) if fetched_url == url => {
                // The bytes are consumed either way, so a picture that will not decode is not
                // re-decoded every second.
                state.fetch = Some((fetched_url, Vec::new()));
                if bytes.is_empty() {
                    return None;
                }
                let artwork = make_artwork(&bytes);
                state.artwork = artwork.clone().map(|artwork| (url.to_string(), artwork));
                artwork
            }
            _ => {
                state.fetch = Some((url.to_string(), Vec::new()));
                drop(state);
                spawn_artwork_fetch(app, url.to_string());
                None
            }
        }
    }
}

fn spawn_artwork_fetch(app: &AppHandle, url: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let bytes = load_artwork_bytes(&url).await.unwrap_or_default();
        let Some(session) = app.try_state::<MacosMediaSession>() else {
            return;
        };
        if let Ok(mut state) = session.0.lock() {
            state.fetch = Some((url, bytes));
        };
    });
}

async fn load_artwork_bytes(url: &str) -> Option<Vec<u8>> {
    use base64::Engine;

    // Embedded cover of a local file. The tag read blocks, but once per track, not per update.
    if let Some(path) = url.strip_prefix("local-art:") {
        let artwork = crate::local_audio_artwork(path.to_string()).ok()??;
        return base64::engine::general_purpose::STANDARD
            .decode(artwork.data_base64)
            .ok();
    }

    let response = reqwest::get(url).await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.bytes().await.ok().map(|bytes| bytes.to_vec())
}

/// `MPMediaItemArtwork` from encoded image bytes. Main thread only.
fn make_artwork(bytes: &[u8]) -> Option<Retained<AnyObject>> {
    let data = NSData::with_bytes(bytes);
    let image: Option<Retained<AnyObject>> = unsafe {
        let allocated: Allocated<AnyObject> = msg_send![class!(NSImage), alloc];
        msg_send![allocated, initWithData: &*data]
    };
    let image = image?;

    let size: NSSize = unsafe { msg_send![&*image, size] };
    if !(size.width > 0.0 && size.height > 0.0) {
        return None;
    }

    // The handler hands back the same image whatever size is asked for; scaling is the
    // system's problem. The artwork copies the block, so ours can drop.
    let handler = RcBlock::new(move |_size: NSSize| Retained::as_ptr(&image) as *mut AnyObject);
    unsafe {
        let allocated: Allocated<AnyObject> = msg_send![class!(MPMediaItemArtwork), alloc];
        msg_send![allocated, initWithBoundsSize: size, requestHandler: &*handler]
    }
}

fn command_center() -> *mut AnyObject {
    let class: &AnyClass = class!(MPRemoteCommandCenter);
    unsafe { msg_send![class, sharedCommandCenter] }
}

fn now_playing_info_center() -> *mut AnyObject {
    let class: &AnyClass = class!(MPNowPlayingInfoCenter);
    unsafe { msg_send![class, defaultCenter] }
}

fn install_remote_command_handler(
    app: &AppHandle,
    command_selector: &str,
    action: &'static str,
) -> Result<(), String> {
    let center = command_center();
    if center.is_null() {
        return Err("macOS remote command center unavailable".to_string());
    }

    let command: *mut AnyObject = unsafe {
        match command_selector {
            "playCommand" => msg_send![center, playCommand],
            "pauseCommand" => msg_send![center, pauseCommand],
            "togglePlayPauseCommand" => msg_send![center, togglePlayPauseCommand],
            "nextTrackCommand" => msg_send![center, nextTrackCommand],
            "previousTrackCommand" => msg_send![center, previousTrackCommand],
            _ => {
                return Err(format!(
                    "unsupported macOS media command: {command_selector}"
                ))
            }
        }
    };

    if command.is_null() {
        return Err(format!(
            "macOS media command unavailable: {command_selector}"
        ));
    }

    let app = app.clone();
    let block = RcBlock::new(move |_event: *mut AnyObject| {
        // Logged so "the key did nothing" can be told apart from "macOS never delivered it".
        eprintln!("[internal][tauri][info] macos media command {action}");
        let _ = app.emit(MEDIA_CONTROL_EVENT, action);
        COMMAND_SUCCESS
    });

    unsafe {
        let _: () = msg_send![command, setEnabled: true];
        let _: *mut AnyObject = msg_send![command, addTargetWithHandler: &*block];
    }

    std::mem::forget(block);
    Ok(())
}

/// Separate from the handler above because this one reads `positionTime` off the event, which
/// is what drives the Control Center scrubber.
fn install_position_command_handler(app: &AppHandle) -> Result<(), String> {
    let center = command_center();
    if center.is_null() {
        return Err("macOS remote command center unavailable".to_string());
    }

    let command: *mut AnyObject = unsafe { msg_send![center, changePlaybackPositionCommand] };
    if command.is_null() {
        return Err("macOS media command unavailable: changePlaybackPositionCommand".to_string());
    }

    let app = app.clone();
    let block = RcBlock::new(move |event: *mut AnyObject| {
        if event.is_null() {
            return COMMAND_SUCCESS;
        }
        let position_sec: f64 = unsafe { msg_send![event, positionTime] };
        if position_sec.is_finite() {
            let _ = app.emit(
                MEDIA_CONTROL_EVENT,
                SeekAction { action: "seekTo", position_sec: position_sec.max(0.0) },
            );
        }
        COMMAND_SUCCESS
    });

    unsafe {
        let _: () = msg_send![command, setEnabled: true];
        let _: *mut AnyObject = msg_send![command, addTargetWithHandler: &*block];
    }

    std::mem::forget(block);
    Ok(())
}

/// Set after `nowPlayingInfo`, which is the order Apple documents.
fn set_playback_state(center: *mut AnyObject, state: usize) {
    if center.is_null() {
        return;
    }
    unsafe {
        let _: () = msg_send![center, setPlaybackState: state];
    }
}

fn set_now_playing_info(update: MediaSessionUpdate, artwork: Option<Retained<AnyObject>>) {
    let center = now_playing_info_center();
    if center.is_null() {
        return;
    }

    let Some(title) = update.title else {
        let nil_info: *mut AnyObject = std::ptr::null_mut();
        unsafe {
            let _: () = msg_send![center, setNowPlayingInfo: nil_info];
        }
        set_playback_state(center, PLAYBACK_STATE_STOPPED);
        return;
    };

    let info = NSMutableDictionary::<NSString, AnyObject>::dictionaryWithCapacity(6);
    insert_string(&info, unsafe { &*MPMediaItemPropertyTitle }, &title);

    if let Some(artist) = update.artist {
        insert_string(&info, unsafe { &*MPMediaItemPropertyArtist }, &artist);
    }

    if let Some(artwork) = artwork {
        info.insert(unsafe { &*MPMediaItemPropertyArtwork }, &artwork);
    }

    if let Some(duration) = update.duration_sec.filter(|duration| duration.is_finite()) {
        insert_number(
            &info,
            unsafe { &*MPMediaItemPropertyPlaybackDuration },
            duration.max(0.0),
        );
    }

    if let Some(position) = update.position_sec.filter(|position| position.is_finite()) {
        insert_number(
            &info,
            unsafe { &*MPNowPlayingInfoPropertyElapsedPlaybackTime },
            position.max(0.0),
        );
    }

    let is_playing = update.status == "playing";
    insert_number(
        &info,
        unsafe { &*MPNowPlayingInfoPropertyPlaybackRate },
        if is_playing { 1.0 } else { 0.0 },
    );

    unsafe {
        let _: () = msg_send![center, setNowPlayingInfo: &*info];
    }

    // "loading" counts as playing: it is a track starting, and reporting stopped mid-handover
    // hands the media keys to another app.
    set_playback_state(
        center,
        match update.status.as_str() {
            "playing" | "loading" => PLAYBACK_STATE_PLAYING,
            "paused" => PLAYBACK_STATE_PAUSED,
            _ => PLAYBACK_STATE_STOPPED,
        },
    );
}

fn insert_string(info: &NSMutableDictionary<NSString, AnyObject>, key: &NSString, value: &str) {
    let value = NSString::from_str(value);
    let value: Retained<AnyObject> = value.into();
    info.insert(key, &value);
}

fn insert_number(info: &NSMutableDictionary<NSString, AnyObject>, key: &NSString, value: f64) {
    let value = NSNumber::new_f64(value);
    let value: Retained<AnyObject> = value.into();
    info.insert(key, &value);
}

#[tauri::command]
pub fn update_macos_media_session(
    app: AppHandle,
    state: tauri::State<'_, MacosMediaSession>,
    update: MediaSessionUpdate,
) -> Result<(), String> {
    state.update(&app, update)
}
