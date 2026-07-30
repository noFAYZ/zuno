use serde::Deserialize;
use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, PlatformConfig,
};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

const MEDIA_CONTROL_EVENT: &str = "linux-media-control";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSessionUpdate {
    title: Option<String>,
    artist: Option<String>,
    artwork_url: Option<String>,
    status: String,
    duration_sec: Option<f64>,
    position_sec: Option<f64>,
    _force_metadata: Option<bool>,
}

pub struct LinuxMediaSession(Mutex<Option<MediaControls>>);

impl LinuxMediaSession {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub fn ensure_controls(&self, app: &AppHandle) -> Result<(), String> {
        let mut controls_guard = self.0.lock().map_err(|e| e.to_string())?;
        if controls_guard.is_some() {
            return Ok(());
        }

        let config = PlatformConfig {
            dbus_name: "zuno",
            display_name: "Zuno",
            hwnd: None,
        };

        let mut controls = MediaControls::new(config).map_err(|e| e.to_string())?;

        let app_handle = app.clone();
        controls
            .attach(move |event| match event {
                MediaControlEvent::Play => {
                    let _ = app_handle.emit(MEDIA_CONTROL_EVENT, "play");
                }
                MediaControlEvent::Pause => {
                    let _ = app_handle.emit(MEDIA_CONTROL_EVENT, "pause");
                }
                MediaControlEvent::Toggle => {
                    let _ = app_handle.emit(MEDIA_CONTROL_EVENT, "playPause");
                }
                MediaControlEvent::Next => {
                    let _ = app_handle.emit(MEDIA_CONTROL_EVENT, "next");
                }
                MediaControlEvent::Previous => {
                    let _ = app_handle.emit(MEDIA_CONTROL_EVENT, "previous");
                }
                MediaControlEvent::SetPosition(souvlaki::MediaPosition(duration)) => {
                    let position_sec = duration.as_secs_f64();
                    let _ = app_handle.emit(
                        MEDIA_CONTROL_EVENT,
                        serde_json::json!({
                            "action": "seekTo",
                            "positionSec": position_sec
                        }),
                    );
                }
                _ => {}
            })
            .map_err(|e| e.to_string())?;

        *controls_guard = Some(controls);
        Ok(())
    }

    pub fn update(&self, app: &AppHandle, update: MediaSessionUpdate) -> Result<(), String> {
        self.ensure_controls(app)?;

        let mut controls_guard = self.0.lock().map_err(|e| e.to_string())?;
        let controls = match controls_guard.as_mut() {
            Some(c) => c,
            None => return Ok(()),
        };

        // Update playback status
        let playback = match update.status.as_str() {
            "playing" | "loading" => MediaPlayback::Playing {
                progress: update
                    .position_sec
                    .map(|p| souvlaki::MediaPosition(Duration::from_secs_f64(p.max(0.0)))),
            },
            "paused" => MediaPlayback::Paused {
                progress: update
                    .position_sec
                    .map(|p| souvlaki::MediaPosition(Duration::from_secs_f64(p.max(0.0)))),
            },
            _ => MediaPlayback::Stopped,
        };

        controls
            .set_playback(playback)
            .map_err(|e| e.to_string())?;

        // Update metadata
        let duration = update
            .duration_sec
            .filter(|&d| d > 0.0)
            .map(Duration::from_secs_f64);

        let metadata = MediaMetadata {
            title: update.title.as_deref(),
            artist: update.artist.as_deref(),
            album: None,
            cover_url: update.artwork_url.as_deref(),
            duration,
        };

        controls
            .set_metadata(metadata)
            .map_err(|e| e.to_string())?;

        Ok(())
    }
}

#[tauri::command]
pub fn update_linux_media_session(
    app: AppHandle,
    state: State<'_, LinuxMediaSession>,
    update: MediaSessionUpdate,
) -> Result<(), String> {
    state.update(&app, update)
}
