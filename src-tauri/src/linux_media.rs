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
    force_metadata: Option<bool>,
}

#[derive(PartialEq, Clone)]
struct CachedMetadata {
    title: Option<String>,
    artist: Option<String>,
    artwork_url: Option<String>,
    duration: Option<Duration>,
}

pub struct LinuxMediaSession {
    controls: Mutex<Option<MediaControls>>,
    metadata: Mutex<Option<CachedMetadata>>,
}

impl LinuxMediaSession {
    pub fn new() -> Self {
        Self {
            controls: Mutex::new(None),
            metadata: Mutex::new(None),
        }
    }

    pub fn ensure_controls(&self, app: &AppHandle) -> Result<(), String> {
        let mut controls_guard = self.controls.lock().map_err(|e| e.to_string())?;
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

        let mut controls_guard = self.controls.lock().map_err(|e| e.to_string())?;
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

        // Update metadata only when metadata changes or force_metadata is true
        let duration = update
            .duration_sec
            .filter(|&d| d > 0.0)
            .map(Duration::from_secs_f64);

        let next_metadata = CachedMetadata {
            title: update.title.clone(),
            artist: update.artist.clone(),
            artwork_url: update.artwork_url.clone(),
            duration,
        };

        let force_metadata = update.force_metadata.unwrap_or(false);
        let mut current_metadata = self.metadata.lock().map_err(|e| e.to_string())?;

        if force_metadata || current_metadata.as_ref() != Some(&next_metadata) {
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

            *current_metadata = Some(next_metadata);
        }

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
