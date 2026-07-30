// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use base64::{engine::general_purpose::STANDARD, Engine as _};
#[cfg(not(debug_assertions))]
use portpicker::pick_unused_port;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

macro_rules! eprintln {
    ($($arg:tt)*) => {{
        let message = $crate::sanitize_log_message(&format!($($arg)*));
        std::eprintln!("{}", message);
        $crate::append_log_line(format_args!("{}", message));
    }};
}

#[cfg(not(debug_assertions))]
use tauri::utils::config::FrontendDist;
#[cfg(not(debug_assertions))]
use tauri::utils::config_v1::WindowUrl;

use tauri::{Emitter, Manager};

#[cfg(target_os = "macos")]
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
#[cfg(target_os = "macos")]
use rand::{rngs::OsRng, RngCore};

#[cfg(target_os = "macos")]
mod macos_media;
#[cfg(target_os = "windows")]
mod windows_media;
#[cfg(target_os = "linux")]
mod linux_media;

mod discord_rpc;
mod lastfm;

// Keep the legacy service name so existing sign-in credentials survive the product rename.
const KEYRING_SERVICE: &str = "com.ytmusicdock.app";

/// Durable settings store. Also the marker the app-data migration checks for.
const APP_SETTINGS_FILE_NAME: &str = "settings-v1.json";

/// Copies the pre-rename app-data directory into the current one, once.
///
/// Runs on every start but does nothing after the first: the presence of a settings file in
/// the new location is the "already migrated" marker. Deliberately a copy rather than a
/// move, so a half-finished run cannot destroy the only copy of the user's settings — the
/// old directory is left untouched for them to delete when they are satisfied.
///
/// Only the roaming data directory is migrated. Caches, logs and the webview profile live in
/// the local data directory and all regenerate on their own; copying them would mean moving
/// hundreds of megabytes to no benefit.
fn migrate_legacy_app_data(app: &tauri::AppHandle) {
    let Ok(new_dir) = app.path().app_data_dir() else {
        return;
    };
    // Marker: anything already written here means this ran before, or the user is new.
    if new_dir.join(APP_SETTINGS_FILE_NAME).exists() {
        return;
    }
    let Some(base) = new_dir.parent() else {
        return;
    };
    let legacy_dir = base.join(LEGACY_BUNDLE_IDENTIFIER);
    if !legacy_dir.is_dir() || legacy_dir == new_dir {
        return;
    }

    if let Err(error) = copy_dir_contents(&legacy_dir, &new_dir) {
        eprintln!("[internal][tauri][warn] legacy app data migration failed: {error}");
        return;
    }
    eprintln!(
        "[internal][tauri][info] migrated app data from {}",
        legacy_dir.display()
    );
}

fn copy_dir_contents(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_contents(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Bundle identifier used before the rename to Zuno.
///
/// Tauri derives the app-data directory from the identifier, so changing it points the app
/// at an empty folder and strands every stored preference — including user-created local
/// playlists. `migrate_legacy_app_data` copies the old directory across once.
///
/// Sign-in credentials are unaffected: they live in the OS keyring under `KEYRING_SERVICE`,
/// which is deliberately decoupled from the identifier.
const LEGACY_BUNDLE_IDENTIFIER: &str = "com.justanothermusicclient.desktop";
const KEYRING_USER: &str = "youtube-oauth";
const YOUTUBE_COOKIE_KEYRING_USER: &str = "youtube-music-cookie";
#[cfg(target_os = "macos")]
const YOUTUBE_COOKIE_ENCRYPTION_KEY_USER: &str = "youtube-music-cookie-encryption-key-v1";
#[cfg(target_os = "macos")]
const YOUTUBE_COOKIE_ENCRYPTED_FILE: &str = "youtube-music-session-v1.bin";
const YOUTUBE_LOGIN_WINDOW: &str = "youtube-music-login";
const YOUTUBE_LOGIN_URL: &str = "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fmusic.youtube.com%2F";
/// Storage partition for the sign-in webview, so clearing it cannot touch the app's own.
///
/// `clear_all_browsing_data` is a *profile*-wide operation on every platform — WebView2 calls
/// `ClearBrowsingDataAll` on the profile, WKWebView empties the shared default data store — and
/// every webview in the process shares one profile by default. The login window used to clear
/// that shared profile twice per sign-in cycle, which wiped the main window's localStorage:
/// the downloads manifest, local playlists, play history, tabs, shortcuts, the lot. Worse, a
/// lost manifest made the next launch delete every downloaded file as an orphan.
const YOUTUBE_LOGIN_DATA_DIR: &str = "youtube-login-webview";
/// The same partition across launches, so the login window is not a fresh profile every time.
#[cfg(target_os = "macos")]
const YOUTUBE_LOGIN_DATA_STORE_ID: [u8; 16] = [
    0x7a, 0x75, 0x6e, 0x6f, 0x6c, 0x6f, 0x67, 0x69, 0x6e, 0x77, 0x65, 0x62, 0x76, 0x69, 0x65, 0x77,
];
const YOUTUBE_PLAYER_API_URL: &str = "https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false";
const YOUTUBE_MUSIC_PLAYER_API_URL: &str = "https://music.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8&prettyPrint=false";
#[cfg(target_os = "macos")]
const MACOS_LOGIN_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
const YOUTUBE_COOKIE_CHUNK_SIZE: usize = 900;
const YOUTUBE_COOKIE_MAX_CHUNKS: usize = 16;
/// How often a rotated cookie is written back to secure storage.
///
/// Not on every response: Google rotates SIDCC on almost all of them, and the Windows
/// credential store takes sixteen writes per save. Rotation matters on a scale of hours, so
/// persisting a few minutes behind the live value costs nothing — the first change after a
/// launch is written immediately, which is what a short session needs.
const YOUTUBE_COOKIE_PERSIST_INTERVAL: Duration = Duration::from_secs(300);
/// Seconds a silent renewal may spend before giving up and asking the user.
const YOUTUBE_SILENT_REFRESH_POLLS: u32 = 12;
const DEFAULT_CACHE_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const CURRENT_LOG_FILE_NAME: &str = "current.log";

static APP_LOG_FILE: OnceLock<Mutex<Option<File>>> = OnceLock::new();

struct CacheLock(Mutex<()>);
struct AppSettingsLock(Mutex<()>);

/// The live YouTube cookie, kept current from every response that rotates it.
///
/// The signed-in session used to be a snapshot taken once at sign-in and replayed forever,
/// with every `Set-Cookie` thrown away. Google rotates `SIDCC` and `__Secure-*PSIDTS`
/// continuously and stops trusting a session that keeps presenting stale ones, so the app
/// quietly lost its authentication overnight while still looking signed in. This is the one
/// authoritative copy: `proxy_http_request` stamps outgoing requests from it and folds every
/// `Set-Cookie` back into it.
#[derive(Default)]
struct CookieJarState {
    cookie: Option<String>,
    persisted_at: Option<Instant>,
}

struct YoutubeCookieJar(Mutex<CookieJarState>);

fn parse_cookie_header(header: &str) -> Vec<(String, String)> {
    header
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .map(|(name, value)| (name.trim().to_string(), value.trim().to_string()))
        .collect()
}

fn serialize_cookie_pairs(pairs: &[(String, String)]) -> String {
    pairs
        .iter()
        .map(|(name, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

/// Folds one `Set-Cookie` value into the jar, reporting whether anything changed.
///
/// Only the leading `name=value` matters. The attributes after it describe where a browser
/// should send the cookie, and this jar has exactly one destination.
fn apply_set_cookie(pairs: &mut Vec<(String, String)>, set_cookie: &str) -> bool {
    let Some((name, value)) = set_cookie
        .split(';')
        .next()
        .and_then(|pair| pair.split_once('='))
    else {
        return false;
    };
    let name = name.trim().to_string();
    let value = value.trim().to_string();
    if name.is_empty() {
        return false;
    }

    // Google clears a cookie by echoing it back empty or as a tombstone rather than by
    // omitting it. Keeping those would keep presenting a value the server has retired.
    if value.is_empty() || value == "EXPIRED" || value == "deleted" {
        let before = pairs.len();
        pairs.retain(|(existing, _)| existing != &name);
        return pairs.len() != before;
    }

    match pairs.iter_mut().find(|(existing, _)| existing == &name) {
        Some(entry) if entry.1 == value => false,
        Some(entry) => {
            entry.1 = value;
            true
        }
        None => {
            pairs.push((name, value));
            true
        }
    }
}

fn is_youtube_cookie_host(url: &url::Url) -> bool {
    url.host_str()
        .is_some_and(|host| host == "youtube.com" || host.ends_with(".youtube.com"))
}

/// Merges rotated cookies into the jar, returning the new header when it changed.
fn refresh_youtube_cookie_jar(
    app: &tauri::AppHandle,
    jar: &YoutubeCookieJar,
    set_cookies: &[String],
) -> Option<String> {
    let (merged, should_persist) = {
        let mut state = jar.0.lock().ok()?;
        // No stored session means an anonymous request; it has no jar to update.
        let mut pairs = parse_cookie_header(state.cookie.as_deref()?);
        // Every cookie is applied; `any` would stop at the first change and drop the rest.
        let mut changed = false;
        for set_cookie in set_cookies {
            changed |= apply_set_cookie(&mut pairs, set_cookie);
        }
        if !changed {
            return None;
        }

        let merged = serialize_cookie_pairs(&pairs);
        state.cookie = Some(merged.clone());
        let should_persist = state
            .persisted_at
            .is_none_or(|at| at.elapsed() >= YOUTUBE_COOKIE_PERSIST_INTERVAL);
        if should_persist {
            state.persisted_at = Some(Instant::now());
        }
        (merged, should_persist)
    };

    // Outside the guard: the keyring write is slow and every other request wants the jar.
    if should_persist {
        match save_youtube_music_cookie(app, &merged) {
            Ok(()) => eprintln!(
                "[internal][tauri][info] youtube cookie rotated and persisted bytes={}",
                merged.len()
            ),
            Err(error) => eprintln!(
                "[internal][tauri][warn] youtube cookie persist failed: {}",
                error.message
            ),
        }
    }
    Some(merged)
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheSettings {
    max_bytes: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheEntry {
    key: String,
    value: String,
    updated_at_ms: u64,
    last_accessed_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheStats {
    max_bytes: u64,
    used_bytes: u64,
    entry_count: usize,
}

#[derive(Serialize)]
struct CacheWriteResult {
    changed: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalAudioFile {
    path: String,
    title: String,
    album: Option<String>,
    duration_sec: Option<u64>,
}

fn cache_error(message: impl Into<String>) -> CommandError {
    CommandError {
        message: message.into(),
    }
}

fn signed_googlevideo_local_address(url: &url::Url) -> Option<IpAddr> {
    if !url
        .host_str()
        .is_some_and(|host| host.ends_with(".googlevideo.com"))
    {
        return None;
    }

    let signed_ip = url.query_pairs().find_map(|(key, value)| {
        (key == "ip")
            .then(|| value.parse::<IpAddr>().ok())
            .flatten()
    })?;

    Some(match signed_ip {
        IpAddr::V4(_) => IpAddr::V4(Ipv4Addr::UNSPECIFIED),
        IpAddr::V6(_) => IpAddr::V6(Ipv6Addr::UNSPECIFIED),
    })
}

fn local_audio_mime_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "mp3" => "audio/mpeg",
        "m4a" | "mp4" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "webm" => "audio/webm",
        _ => "application/octet-stream",
    }
}

fn is_local_audio_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "mp3" | "m4a" | "mp4" | "aac" | "flac" | "wav" | "ogg" | "oga" | "opus" | "webm"
    )
}

fn local_audio_title(path: &Path) -> String {
    path.file_stem()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Untitled")
        .to_string()
}

fn scan_local_audio_path(path: &Path, files: &mut Vec<LocalAudioFile>) -> Result<(), CommandError> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return Ok(()),
    };

    if metadata.is_file() {
        if is_local_audio_file(path) {
            files.push(LocalAudioFile {
                path: path.to_string_lossy().to_string(),
                title: local_audio_title(path),
                album: path
                    .parent()
                    .and_then(|parent| parent.file_name())
                    .and_then(|name| name.to_str())
                    .map(|name| name.to_string()),
                duration_sec: None,
            });
        }
        return Ok(());
    }

    if !metadata.is_dir() {
        return Ok(());
    }

    let entries = fs::read_dir(path).map_err(|error| CommandError {
        message: format!("local audio directory read failed: {error}"),
    })?;

    for entry in entries.flatten() {
        scan_local_audio_path(&entry.path(), files)?;
    }

    Ok(())
}

#[tauri::command]
fn local_audio_scan(paths: Vec<String>) -> Result<Vec<LocalAudioFile>, CommandError> {
    let mut files = Vec::new();
    for path in paths {
        let trimmed_path = path.trim();
        if trimmed_path.is_empty() {
            continue;
        }
        scan_local_audio_path(Path::new(trimmed_path), &mut files)?;
    }
    files.sort_by(|left, right| left.path.to_lowercase().cmp(&right.path.to_lowercase()));
    files.dedup_by(|left, right| left.path == right.path);
    Ok(files)
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct LocalAudioTags {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    album_artist: Option<String>,
    genre: Option<String>,
    track_number: Option<u32>,
    year: Option<u32>,
}

/// Reads real tags from a file.
///
/// The scanner falls back to the filename and parent folder, which is fine for a quick list
/// but wrong often enough that an editor needs the actual values — otherwise "save" would
/// write the guessed name back into the file as if it were the truth.
/// Reads a user-chosen text file. Used for playlist import.
///
/// Size-capped: the picker lets someone choose any file at all, and reading a multi-gigabyte
/// one into a string to discover it is not a playlist would take the app down with it.
#[tauri::command]
fn read_text_file(path: String) -> Result<String, CommandError> {
    const MAX_IMPORT_BYTES: u64 = 16 * 1024 * 1024;

    let path = PathBuf::from(path);
    let metadata = fs::metadata(&path)
        .map_err(|error| cache_error(format!("file read failed: {error}")))?;
    if metadata.len() > MAX_IMPORT_BYTES {
        return Err(cache_error("that file is too large to be a playlist"));
    }

    fs::read_to_string(&path).map_err(|error| cache_error(format!("file read failed: {error}")))
}

/// Writes a user-chosen text file. Used for playlist export.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), CommandError> {
    let path = PathBuf::from(path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| cache_error(format!("directory creation failed: {error}")))?;
    }
    fs::write(&path, contents).map_err(|error| cache_error(format!("file write failed: {error}")))
}

#[tauri::command]
fn local_audio_read_tags(path: String) -> Result<LocalAudioTags, CommandError> {
    use lofty::file::TaggedFileExt;
    use lofty::tag::Accessor;

    let path = PathBuf::from(path);
    if !path.is_file() || !is_local_audio_file(&path) {
        return Err(cache_error("local audio file is unavailable."));
    }

    let tagged = lofty::read_from_path(&path)
        .map_err(|error| cache_error(format!("tag read failed: {error}")))?;
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return Ok(LocalAudioTags::default());
    };

    Ok(LocalAudioTags {
        title: tag.title().map(|value| value.to_string()),
        artist: tag.artist().map(|value| value.to_string()),
        album: tag.album().map(|value| value.to_string()),
        album_artist: tag
            .get_string(lofty::tag::ItemKey::AlbumArtist)
            .map(|value| value.to_string()),
        genre: tag.genre().map(|value| value.to_string()),
        track_number: tag.track(),
        // Year lives under a plain item key rather than an Accessor method in lofty 0.24.
        year: tag
            .get_string(lofty::tag::ItemKey::Year)
            .and_then(|value| value.trim().get(..4).and_then(|text| text.parse().ok())),
    })
}

#[tauri::command]
fn local_audio_write_tags(path: String, tags: LocalAudioTags) -> Result<(), CommandError> {
    use lofty::config::WriteOptions;
    use lofty::file::{AudioFile, TaggedFileExt};
    use lofty::tag::{Accessor, ItemKey, Tag};

    let path = PathBuf::from(path);
    if !path.is_file() || !is_local_audio_file(&path) {
        return Err(cache_error("local audio file is unavailable."));
    }

    let mut tagged = lofty::read_from_path(&path)
        .map_err(|error| cache_error(format!("tag read failed: {error}")))?;

    // A file with no tag at all still needs somewhere to put these, so one is created in the
    // format that file type expects rather than failing the edit.
    let tag_type = tagged.primary_tag_type();
    if tagged.primary_tag().is_none() {
        tagged.insert_tag(Tag::new(tag_type));
    }
    let Some(tag) = tagged.primary_tag_mut() else {
        return Err(cache_error("this file cannot store tags"));
    };

    fn apply(tag: &mut Tag, key: ItemKey, value: Option<&String>) {
        match value.map(|text| text.trim()).filter(|text| !text.is_empty()) {
            // An empty field is an instruction to clear the tag, not to leave it alone.
            Some(text) => {
                let _ = tag.insert_text(key, text.to_string());
            }
            None => {
                let _ = tag.remove_key(key);
            }
        }
    }

    apply(tag, ItemKey::TrackTitle, tags.title.as_ref());
    apply(tag, ItemKey::TrackArtist, tags.artist.as_ref());
    apply(tag, ItemKey::AlbumTitle, tags.album.as_ref());
    apply(tag, ItemKey::AlbumArtist, tags.album_artist.as_ref());
    apply(tag, ItemKey::Genre, tags.genre.as_ref());

    match tags.track_number {
        Some(number) => tag.set_track(number),
        None => tag.remove_track(),
    }
    match tags.year {
        Some(year) => {
            let _ = tag.insert_text(ItemKey::Year, year.to_string());
        }
        None => {
            let _ = tag.remove_key(ItemKey::Year);
        }
    }

    tagged
        .save_to_path(&path, WriteOptions::default())
        .map_err(|error| cache_error(format!("tag write failed: {error}")))?;

    eprintln!(
        "[internal][tauri][info] local_audio_write_tags path={}",
        path.display()
    );
    Ok(())
}

/// Holds the active folder watcher. Replaced wholesale whenever the watched set changes.
struct LocalAudioWatcher(Mutex<Option<notify::RecommendedWatcher>>);

/// Watches folders for changes and tells the frontend to rescan.
///
/// Deliberately coarse: it emits one debounced "something changed" event rather than a diff.
/// The scan is cheap, and a precise change feed would have to model renames, temp files and
/// editors that write-then-replace — all of which produce the same user-visible outcome.
#[tauri::command]
fn local_audio_watch(
    app: tauri::AppHandle,
    state: tauri::State<'_, LocalAudioWatcher>,
    paths: Vec<String>,
) -> Result<(), CommandError> {
    use notify::{RecursiveMode, Watcher};

    let mut guard = state
        .0
        .lock()
        .map_err(|_| cache_error("watcher lock unavailable"))?;
    // Dropping the previous watcher unregisters every path it held.
    *guard = None;

    if paths.is_empty() {
        return Ok(());
    }

    let emitter = app.clone();
    let last_emit = Arc::new(Mutex::new(Instant::now() - Duration::from_secs(60)));
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
        let Ok(event) = event else { return };
        if !matches!(
            event.kind,
            notify::EventKind::Create(_) | notify::EventKind::Remove(_) | notify::EventKind::Modify(_)
        ) {
            return;
        }

        // A single save can fire several events; one rescan per second is plenty.
        if let Ok(mut last) = last_emit.lock() {
            if last.elapsed() < Duration::from_millis(1000) {
                return;
            }
            *last = Instant::now();
        }
        let _ = emitter.emit("local-audio-changed", ());
    })
    .map_err(|error| cache_error(format!("watcher creation failed: {error}")))?;

    for path in &paths {
        let candidate = Path::new(path.trim());
        if !candidate.exists() {
            continue;
        }
        if let Err(error) = watcher.watch(candidate, RecursiveMode::Recursive) {
            eprintln!(
                "[internal][tauri][warn] local_audio_watch failed path={} error={}",
                path, error
            );
        }
    }

    *guard = Some(watcher);
    eprintln!(
        "[internal][tauri][info] local_audio_watch watching {} paths",
        paths.len()
    );
    Ok(())
}

#[tauri::command]
fn local_audio_unwatch(state: tauri::State<'_, LocalAudioWatcher>) -> Result<(), CommandError> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| cache_error("watcher lock unavailable"))?;
    *guard = None;
    Ok(())
}

#[tauri::command]
fn local_audio_read(path: String) -> Result<AudioPayload, CommandError> {
    let path = PathBuf::from(path);
    if !path.is_file() || !is_local_audio_file(&path) {
        return Err(CommandError {
            message: "local audio file is unavailable.".to_string(),
        });
    }
    let bytes = fs::read(&path).map_err(|error| CommandError {
        message: format!("local audio read failed: {error}"),
    })?;
    Ok(AudioPayload {
        body_base64: STANDARD.encode(bytes),
        mime_type: local_audio_mime_type(&path).to_string(),
    })
}

fn cache_root(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    app.path()
        .app_cache_dir()
        .map(|path| path.join("data-cache-v1"))
        .map_err(|error| cache_error(format!("cache directory unavailable: {error}")))
}

fn cache_entries_dir(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    Ok(cache_root(app)?.join("entries"))
}

fn cache_settings_path(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    Ok(cache_root(app)?.join("settings.json"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn cache_key_hash(key: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in key.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn cache_entry_path(app: &tauri::AppHandle, key: &str) -> Result<PathBuf, CommandError> {
    Ok(cache_entries_dir(app)?.join(format!("{:016x}.json", cache_key_hash(key))))
}

fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), CommandError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| cache_error(format!("cache directory creation failed: {error}")))?;
    }
    let bytes = serde_json::to_vec(value)
        .map_err(|error| cache_error(format!("cache serialization failed: {error}")))?;
    let temp_path = path.with_extension("tmp");
    fs::write(&temp_path, bytes)
        .map_err(|error| cache_error(format!("cache write failed: {error}")))?;
    if path.exists() {
        fs::remove_file(path)
            .map_err(|error| cache_error(format!("cache replacement failed: {error}")))?;
    }
    fs::rename(&temp_path, path)
        .map_err(|error| cache_error(format!("cache finalize failed: {error}")))
}

fn app_settings_path(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(APP_SETTINGS_FILE_NAME))
        .map_err(|error| CommandError {
            message: format!("application settings directory unavailable: {error}"),
        })
}

fn read_app_settings(
    app: &tauri::AppHandle,
) -> Result<HashMap<String, serde_json::Value>, CommandError> {
    let path = app_settings_path(app)?;
    if !path.exists() {
        return Ok(HashMap::new());
    }

    let bytes = fs::read(path).map_err(|error| CommandError {
        message: format!("application settings read failed: {error}"),
    })?;
    if bytes.iter().all(|byte| byte.is_ascii_whitespace()) {
        return Ok(HashMap::new());
    }
    serde_json::from_slice(&bytes).map_err(|error| CommandError {
        message: format!("application settings parse failed: {error}"),
    })
}

#[tauri::command]
fn app_setting_get(
    app: tauri::AppHandle,
    lock: tauri::State<'_, AppSettingsLock>,
    key: String,
) -> Result<Option<serde_json::Value>, CommandError> {
    let _guard = lock.0.lock().map_err(|_| CommandError {
        message: "application settings lock unavailable".to_string(),
    })?;
    Ok(read_app_settings(&app)?.remove(&key))
}

#[tauri::command]
fn app_setting_set(
    app: tauri::AppHandle,
    lock: tauri::State<'_, AppSettingsLock>,
    key: String,
    value: serde_json::Value,
) -> Result<(), CommandError> {
    let _guard = lock.0.lock().map_err(|_| CommandError {
        message: "application settings lock unavailable".to_string(),
    })?;
    let mut settings = read_app_settings(&app)?;
    settings.insert(key, value);
    write_json_file(&app_settings_path(&app)?, &settings)
}

#[tauri::command]
fn app_setting_remove(
    app: tauri::AppHandle,
    lock: tauri::State<'_, AppSettingsLock>,
    key: String,
) -> Result<(), CommandError> {
    let _guard = lock.0.lock().map_err(|_| CommandError {
        message: "application settings lock unavailable".to_string(),
    })?;
    let mut settings = read_app_settings(&app)?;
    settings.remove(&key);
    write_json_file(&app_settings_path(&app)?, &settings)
}

fn current_log_path(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    app.path()
        .app_log_dir()
        .map(|path| path.join(CURRENT_LOG_FILE_NAME))
        .map_err(|error| CommandError {
            message: format!("log directory unavailable: {error}"),
        })
}

fn initialize_app_log(app: &tauri::AppHandle) -> Result<(), CommandError> {
    let log_path = current_log_path(app)?;
    let log_dir = log_path.parent().ok_or_else(|| CommandError {
        message: "log directory unavailable".to_string(),
    })?;

    fs::create_dir_all(log_dir).map_err(|error| CommandError {
        message: format!("log directory creation failed: {error}"),
    })?;

    if let Ok(entries) = fs::read_dir(log_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path != log_path
                && path
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("log"))
            {
                let _ = fs::remove_file(path);
            }
        }
    }

    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&log_path)
        .map_err(|error| CommandError {
            message: format!("log file creation failed: {error}"),
        })?;

    let log_file = APP_LOG_FILE.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = log_file.lock() {
        *guard = Some(file);
    }

    append_log_line(format_args!(
        "[internal][tauri][info] log initialized path={}",
        log_path.display()
    ));
    Ok(())
}

pub(crate) fn append_log_line(args: fmt::Arguments<'_>) {
    let Some(log_file) = APP_LOG_FILE.get() else {
        return;
    };
    let Ok(mut guard) = log_file.lock() else {
        return;
    };
    let Some(file) = guard.as_mut() else {
        return;
    };
    let _ = writeln!(file, "{args}");
}

pub(crate) fn sanitize_log_message(message: &str) -> String {
    message
        .split_whitespace()
        .map(sanitize_log_token)
        .collect::<Vec<_>>()
        .join(" ")
}

fn sanitize_log_token(token: &str) -> String {
    if let Some((key, value)) = token.split_once('=') {
        let normalized_key = key
            .trim_matches(|character: char| !character.is_ascii_alphanumeric() && character != '_')
            .to_ascii_lowercase();
        if normalized_key.contains("cookie")
            || normalized_key.contains("authorization")
            || normalized_key.contains("credential")
            || normalized_key.contains("token")
            || normalized_key.contains("secret")
            || normalized_key.contains("password")
            || normalized_key.contains("signature")
            || normalized_key.contains("cipher")
            || normalized_key.contains("visitor")
        {
            return format!("{key}=[redacted]");
        }
        if value.starts_with("http://") || value.starts_with("https://") {
            return format!("{key}={}", sanitize_log_url(value));
        }
    }

    if token.starts_with("http://") || token.starts_with("https://") {
        return sanitize_log_url(token);
    }

    token.to_string()
}

/// Query parameters kept verbatim when a URL is logged.
///
/// An allowlist, not a blocklist: googlevideo grows new parameters constantly and a blocklist
/// would silently start writing down the next credential it invents. Everything here is
/// descriptive — expiry, format, size, client identity — and none of it authenticates anything.
const LOGGABLE_URL_PARAMS: &[&str] = &[
    "expire", "id", "itag", "source", "mime", "clen", "dur", "lmt", "c", "cver", "mn", "ms",
    "mv", "mt", "fvip", "keepalive", "ratebypass", "requiressl", "gir", "sq", "rn", "ver",
    "xpc", "spc", "vprv", "svpuc", "txp", "range", "met", "rqh", "aitags", "sabr", "pcm2",
];

/// Renders a URL for the log with its credentials removed but its diagnostics intact.
///
/// The previous behaviour dropped the whole query string, which made a signed media URL
/// unreadable — the parameters that explain a 403 (expiry, itag, client version) were discarded
/// alongside the ones that must never be written down. Withheld values are replaced by their
/// length, which answers the question actually being asked of them ("is it present and
/// plausible, or missing and truncated?") without recording the secret itself.
fn sanitize_log_url(value: &str) -> String {
    let Ok(parsed) = url::Url::parse(value) else {
        return "[redacted-url]".to_string();
    };

    let base = format!(
        "{}://{}{}",
        parsed.scheme(),
        parsed.host_str().unwrap_or("?"),
        parsed.path()
    );

    let query: Vec<String> = parsed
        .query_pairs()
        .map(|(key, value)| {
            if LOGGABLE_URL_PARAMS.contains(&key.as_ref()) {
                format!("{key}={value}")
            } else {
                format!("{key}=[{}ch]", value.len())
            }
        })
        .collect();

    if query.is_empty() {
        base
    } else {
        format!("{base}?{}", query.join("&"))
    }
}

#[tauri::command]
fn open_current_log(app: tauri::AppHandle) -> Result<(), CommandError> {
    let log_path = current_log_path(&app)?;
    if !log_path.exists() {
        initialize_app_log(&app)?;
    }
    tauri_plugin_opener::open_path(&log_path, None::<&str>).map_err(|error| CommandError {
        message: format!("unable to open log file: {error}"),
    })
}

#[tauri::command]
fn app_settings_clear(
    app: tauri::AppHandle,
    lock: tauri::State<'_, AppSettingsLock>,
) -> Result<(), CommandError> {
    let _guard = lock.0.lock().map_err(|_| CommandError {
        message: "application settings lock unavailable".to_string(),
    })?;
    let path = app_settings_path(&app)?;
    if path.exists() {
        fs::remove_file(path).map_err(|error| CommandError {
            message: format!("application settings clear failed: {error}"),
        })?;
    }
    Ok(())
}

fn read_cache_settings(app: &tauri::AppHandle) -> Result<CacheSettings, CommandError> {
    let path = cache_settings_path(app)?;
    if !path.exists() {
        return Ok(CacheSettings {
            max_bytes: DEFAULT_CACHE_MAX_BYTES,
        });
    }
    let bytes = fs::read(path)
        .map_err(|error| cache_error(format!("cache settings read failed: {error}")))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| cache_error(format!("cache settings parse failed: {error}")))
}

fn cache_files(app: &tauri::AppHandle) -> Result<Vec<PathBuf>, CommandError> {
    let directory = cache_entries_dir(app)?;
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let files = fs::read_dir(directory)
        .map_err(|error| cache_error(format!("cache directory read failed: {error}")))?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension == "json")
        })
        .collect::<Vec<_>>();
    Ok(files)
}

fn read_cache_entry(path: &Path) -> Result<CacheEntry, CommandError> {
    let bytes =
        fs::read(path).map_err(|error| cache_error(format!("cache entry read failed: {error}")))?;
    serde_json::from_slice(&bytes)
        .map_err(|error| cache_error(format!("cache entry parse failed: {error}")))
}

fn calculate_cache_stats(app: &tauri::AppHandle) -> Result<CacheStats, CommandError> {
    let files = cache_files(app)?;
    let used_bytes = files
        .iter()
        .filter_map(|path| fs::metadata(path).ok().map(|metadata| metadata.len()))
        .sum();
    Ok(CacheStats {
        max_bytes: read_cache_settings(app)?.max_bytes,
        used_bytes,
        entry_count: files.len(),
    })
}

fn enforce_cache_limit(app: &tauri::AppHandle) -> Result<(), CommandError> {
    let max_bytes = read_cache_settings(app)?.max_bytes;
    let mut entries = cache_files(app)?
        .into_iter()
        .filter_map(|path| {
            let size = fs::metadata(&path).ok()?.len();
            let last_accessed_ms = read_cache_entry(&path).ok()?.last_accessed_ms;
            Some((path, size, last_accessed_ms))
        })
        .collect::<Vec<_>>();
    let mut used_bytes = entries.iter().map(|(_, size, _)| *size).sum::<u64>();
    entries.sort_by_key(|(_, _, last_accessed_ms)| *last_accessed_ms);

    for (path, size, _) in entries {
        if used_bytes <= max_bytes {
            break;
        }
        if fs::remove_file(path).is_ok() {
            used_bytes = used_bytes.saturating_sub(size);
        }
    }
    Ok(())
}

#[tauri::command]
fn cache_get(
    app: tauri::AppHandle,
    lock: tauri::State<'_, CacheLock>,
    key: String,
) -> Result<Option<String>, CommandError> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| cache_error("cache lock unavailable"))?;
    let path = cache_entry_path(&app, &key)?;
    if !path.exists() {
        return Ok(None);
    }
    let mut entry = match read_cache_entry(&path) {
        Ok(entry) if entry.key == key => entry,
        Ok(_) => return Ok(None),
        Err(_) => {
            let _ = fs::remove_file(path);
            return Ok(None);
        }
    };
    entry.last_accessed_ms = now_ms();
    let value = entry.value.clone();
    write_json_file(&path, &entry)?;
    Ok(Some(value))
}

#[tauri::command]
fn cache_set(
    app: tauri::AppHandle,
    lock: tauri::State<'_, CacheLock>,
    key: String,
    value: String,
) -> Result<CacheWriteResult, CommandError> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| cache_error("cache lock unavailable"))?;
    let path = cache_entry_path(&app, &key)?;
    let existing = if path.exists() {
        read_cache_entry(&path)
            .ok()
            .filter(|entry| entry.key == key)
    } else {
        None
    };
    let changed = existing.as_ref().map_or(true, |entry| entry.value != value);
    let timestamp = now_ms();
    let entry = CacheEntry {
        key,
        value,
        updated_at_ms: if changed {
            timestamp
        } else {
            existing
                .as_ref()
                .map(|entry| entry.updated_at_ms)
                .unwrap_or(timestamp)
        },
        last_accessed_ms: timestamp,
    };
    write_json_file(&path, &entry)?;
    enforce_cache_limit(&app)?;
    Ok(CacheWriteResult { changed })
}

#[tauri::command]
fn cache_stats(
    app: tauri::AppHandle,
    lock: tauri::State<'_, CacheLock>,
) -> Result<CacheStats, CommandError> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| cache_error("cache lock unavailable"))?;
    calculate_cache_stats(&app)
}

#[tauri::command]
fn cache_set_max_bytes(
    app: tauri::AppHandle,
    lock: tauri::State<'_, CacheLock>,
    max_bytes: u64,
) -> Result<CacheStats, CommandError> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| cache_error("cache lock unavailable"))?;
    write_json_file(&cache_settings_path(&app)?, &CacheSettings { max_bytes })?;
    enforce_cache_limit(&app)?;
    calculate_cache_stats(&app)
}

#[tauri::command]
fn cache_clear(
    app: tauri::AppHandle,
    lock: tauri::State<'_, CacheLock>,
) -> Result<CacheStats, CommandError> {
    let _guard = lock
        .0
        .lock()
        .map_err(|_| cache_error("cache lock unavailable"))?;
    let entries = cache_entries_dir(&app)?;
    if entries.exists() {
        fs::remove_dir_all(&entries)
            .map_err(|error| cache_error(format!("cache clear failed: {error}")))?;
    }
    fs::create_dir_all(entries)
        .map_err(|error| cache_error(format!("cache directory creation failed: {error}")))?;
    calculate_cache_stats(&app)
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Key written by the frontend's durable settings layer. Read here rather than pushed from
/// JS so the close handler answers correctly even before the webview has finished booting.
const MINIMIZE_TO_TRAY_SETTING: &str = "minimize-to-tray";

fn minimize_to_tray_enabled(app: &tauri::AppHandle) -> bool {
    read_app_settings(app)
        .ok()
        .and_then(|settings| settings.get(MINIMIZE_TO_TRAY_SETTING).and_then(|v| v.as_bool()))
        .unwrap_or(false)
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Hides to the tray when the user asked for that, otherwise exits.
///
/// Both the titlebar close button and the OS close request come through here so they cannot
/// disagree — a window that vanishes from one and quits from the other is the classic
/// minimize-to-tray bug.
fn close_or_hide_main_window(app: &tauri::AppHandle) {
    if minimize_to_tray_enabled(app) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
        eprintln!("[internal][tauri][info] main window hidden to tray");
        return;
    }
    app.exit(0);
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "tray-show", "Show Zuno", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit Zuno", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            tauri::Error::AssetNotFound("default window icon".to_string())
        })?)
        .tooltip("Zuno")
        .menu(&menu)
        // The menu is for the right-click; a left click should just bring the window back.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "tray-show" => show_main_window(app),
            // The only path that always exits, whatever the setting says.
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button, button_state, .. } = event {
                if button == tauri::tray::MouseButton::Left
                    && button_state == tauri::tray::MouseButtonState::Up
                {
                    show_main_window(tray.app_handle());
                }
            }
        })
        .build(app)?;
    Ok(())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    eprintln!("[internal][tauri][info] quit_app invoked");
    close_or_hide_main_window(&app);
}

#[tauri::command]
fn frontend_log(level: String, context: String, payload: String) {
    eprintln!("[internal][frontend][{}] {} {}", level, context, payload);
}

fn youtube_keyring_entry() -> Result<keyring::Entry, CommandError> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|error| CommandError {
        message: format!("credential store unavailable: {error}"),
    })
}

fn youtube_cookie_keyring_entry() -> Result<keyring::Entry, CommandError> {
    keyring::Entry::new(KEYRING_SERVICE, YOUTUBE_COOKIE_KEYRING_USER).map_err(|error| {
        CommandError {
            message: format!("credential store unavailable: {error}"),
        }
    })
}

fn youtube_cookie_chunk_entry(index: usize) -> Result<keyring::Entry, CommandError> {
    keyring::Entry::new(
        KEYRING_SERVICE,
        &format!("{YOUTUBE_COOKIE_KEYRING_USER}-{index}"),
    )
    .map_err(|error| CommandError {
        message: format!("credential store unavailable: {error}"),
    })
}

fn save_youtube_music_cookie_entries(cookie: &str) -> Result<(), CommandError> {
    let chunks = cookie
        .as_bytes()
        .chunks(YOUTUBE_COOKIE_CHUNK_SIZE)
        .map(|chunk| std::str::from_utf8(chunk).expect("YouTube cookie header must be UTF-8"))
        .collect::<Vec<_>>();

    if chunks.len() > YOUTUBE_COOKIE_MAX_CHUNKS {
        return Err(CommandError {
            message: "YouTube Music session is too large for secure storage.".to_string(),
        });
    }

    eprintln!(
        "[internal][tauri][info] save_youtube_music_cookie chunks={} bytes={}",
        chunks.len(),
        cookie.len()
    );
    delete_youtube_music_cookie_entries()?;
    for (index, chunk) in chunks.iter().enumerate() {
        youtube_cookie_chunk_entry(index)?
            .set_password(chunk)
            .map_err(|error| CommandError {
                message: format!("YouTube Music session chunk {index} save failed: {error}"),
            })?;
    }
    youtube_cookie_keyring_entry()?
        .set_password(&format!("chunks:{}", chunks.len()))
        .map_err(|error| CommandError {
            message: format!("YouTube Music session manifest save failed: {error}"),
        })?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn youtube_cookie_encryption_key_entry() -> Result<keyring::Entry, CommandError> {
    keyring::Entry::new(KEYRING_SERVICE, YOUTUBE_COOKIE_ENCRYPTION_KEY_USER).map_err(|error| {
        CommandError {
            message: format!("credential store unavailable: {error}"),
        }
    })
}

#[cfg(target_os = "macos")]
fn youtube_cookie_encrypted_file(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(YOUTUBE_COOKIE_ENCRYPTED_FILE))
        .map_err(|error| CommandError {
            message: format!("application data directory unavailable: {error}"),
        })
}

#[cfg(target_os = "macos")]
fn load_or_create_cookie_encryption_key() -> Result<[u8; 32], CommandError> {
    let entry = youtube_cookie_encryption_key_entry()?;
    match entry.get_password() {
        Ok(encoded) => {
            let decoded = STANDARD.decode(encoded).map_err(|error| CommandError {
                message: format!("stored session encryption key is invalid: {error}"),
            })?;
            decoded.try_into().map_err(|_| CommandError {
                message: "stored session encryption key has an invalid length.".to_string(),
            })
        }
        Err(keyring::Error::NoEntry) => {
            let mut key = [0_u8; 32];
            OsRng.fill_bytes(&mut key);
            entry
                .set_password(&STANDARD.encode(key))
                .map_err(|error| CommandError {
                    message: format!("session encryption key save failed: {error}"),
                })?;
            Ok(key)
        }
        Err(error) => Err(CommandError {
            message: format!("session encryption key load failed: {error}"),
        }),
    }
}

#[cfg(target_os = "macos")]
fn save_youtube_music_cookie(app: &tauri::AppHandle, cookie: &str) -> Result<(), CommandError> {
    let key = load_or_create_cookie_encryption_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|error| CommandError {
        message: format!("session encryption setup failed: {error}"),
    })?;
    let mut nonce_bytes = [0_u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let encrypted = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), cookie.as_bytes())
        .map_err(|error| CommandError {
            message: format!("session encryption failed: {error}"),
        })?;

    let path = youtube_cookie_encrypted_file(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| CommandError {
            message: format!("session directory creation failed: {error}"),
        })?;
    }
    let mut contents = Vec::with_capacity(nonce_bytes.len() + encrypted.len());
    contents.extend_from_slice(&nonce_bytes);
    contents.extend_from_slice(&encrypted);
    fs::write(path, contents).map_err(|error| CommandError {
        message: format!("encrypted session save failed: {error}"),
    })
}

#[cfg(not(target_os = "macos"))]
fn save_youtube_music_cookie(_app: &tauri::AppHandle, cookie: &str) -> Result<(), CommandError> {
    save_youtube_music_cookie_entries(cookie)
}

fn delete_youtube_music_cookie_entries() -> Result<(), CommandError> {
    match youtube_cookie_keyring_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(error) => {
            return Err(CommandError {
                message: format!("YouTube Music session manifest delete failed: {error}"),
            });
        }
    }

    for index in 0..YOUTUBE_COOKIE_MAX_CHUNKS {
        match youtube_cookie_chunk_entry(index)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => {
                return Err(CommandError {
                    message: format!("YouTube Music session chunk {index} delete failed: {error}"),
                });
            }
        }
    }
    Ok(())
}

/// Clears the OAuth credential left behind by the version of the app that used one.
///
/// Nothing writes that entry any more — sign-in is entirely cookie-based — but an install old
/// enough to predate the change may still be holding one in the keyring. Removing it on sign-out
/// is the only reason this key is still known about; there is no command for it, because a
/// command implies a second way of being signed in and there is no such thing.
fn delete_legacy_youtube_credentials() {
    if let Ok(entry) = youtube_keyring_entry() {
        match entry.delete_credential() {
            Ok(()) => eprintln!("[internal][tauri][info] removed legacy OAuth credential"),
            Err(keyring::Error::NoEntry) => {}
            Err(error) => eprintln!(
                "[internal][tauri][warn] legacy OAuth credential delete failed: {error}"
            ),
        }
    }
}

fn load_youtube_music_cookie_entries() -> Result<Option<String>, CommandError> {
    match youtube_cookie_keyring_entry()?.get_password() {
        Ok(manifest) if manifest.starts_with("chunks:") => {
            let chunk_count = manifest
                .trim_start_matches("chunks:")
                .parse::<usize>()
                .map_err(|error| CommandError {
                    message: format!("invalid YouTube Music session manifest: {error}"),
                })?;
            if chunk_count == 0 || chunk_count > YOUTUBE_COOKIE_MAX_CHUNKS {
                return Err(CommandError {
                    message: "invalid YouTube Music session chunk count.".to_string(),
                });
            }

            let mut cookie = String::new();
            for index in 0..chunk_count {
                let chunk = youtube_cookie_chunk_entry(index)?
                    .get_password()
                    .map_err(|error| CommandError {
                        message: format!(
                            "YouTube Music session chunk {index} load failed: {error}"
                        ),
                    })?;
                cookie.push_str(&chunk);
            }
            eprintln!(
                "[internal][tauri][info] load_youtube_music_cookie assembled chunks={} bytes={}",
                chunk_count,
                cookie.len(),
            );
            Ok(Some(cookie))
        }
        Ok(cookie) => {
            eprintln!(
                "[internal][tauri][info] load_youtube_music_cookie found legacy credential bytes={}",
                cookie.len()
            );
            Ok(Some(cookie))
        }
        Err(keyring::Error::NoEntry) => {
            eprintln!("[internal][tauri][info] load_youtube_music_cookie no credential");
            Ok(None)
        }
        Err(error) => Err(CommandError {
            message: format!("YouTube Music session load failed: {error}"),
        }),
    }
}

#[cfg(target_os = "macos")]
fn load_encrypted_youtube_music_cookie(
    app: &tauri::AppHandle,
) -> Result<Option<String>, CommandError> {
    let path = youtube_cookie_encrypted_file(app)?;
    let contents = match fs::read(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(CommandError {
                message: format!("encrypted session load failed: {error}"),
            })
        }
    };
    if contents.len() <= 12 {
        return Err(CommandError {
            message: "encrypted session file is invalid.".to_string(),
        });
    }
    let key = load_or_create_cookie_encryption_key()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|error| CommandError {
        message: format!("session decryption setup failed: {error}"),
    })?;
    let decrypted = cipher
        .decrypt(Nonce::from_slice(&contents[..12]), &contents[12..])
        .map_err(|error| CommandError {
            message: format!("session decryption failed: {error}"),
        })?;
    String::from_utf8(decrypted)
        .map(Some)
        .map_err(|error| CommandError {
            message: format!("decrypted session is invalid: {error}"),
        })
}

fn read_stored_youtube_music_cookie(app: &tauri::AppHandle) -> Result<Option<String>, CommandError> {
    #[cfg(target_os = "macos")]
    {
        if let Some(cookie) = load_encrypted_youtube_music_cookie(app)? {
            return Ok(Some(cookie));
        }
        if let Some(cookie) = load_youtube_music_cookie_entries()? {
            save_youtube_music_cookie(app, &cookie)?;
            delete_youtube_music_cookie_entries()?;
            return Ok(Some(cookie));
        }
        return Ok(None);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        load_youtube_music_cookie_entries()
    }
}

#[tauri::command]
fn load_youtube_music_cookie(
    app: tauri::AppHandle,
    jar: tauri::State<'_, YoutubeCookieJar>,
) -> Result<Option<String>, CommandError> {
    let cookie = read_stored_youtube_music_cookie(&app)?;
    if let Ok(mut state) = jar.0.lock() {
        state.cookie = cookie.clone();
        state.persisted_at = None;
    }
    Ok(cookie)
}

#[cfg(any(target_os = "macos", test))]
fn cookie_domain_matches(host: &str, cookie_domain: Option<&str>) -> bool {
    let Some(cookie_domain) = cookie_domain else {
        return false;
    };
    let cookie_domain = cookie_domain.trim_start_matches('.');

    host.eq_ignore_ascii_case(cookie_domain)
        || host
            .strip_suffix(cookie_domain)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

/// Builds the sign-in webview on its own storage partition.
///
/// `loaded` is raised once a navigation finishes, which the silent refresh needs: cookies read
/// before the page has actually loaded are the same stale ones we already hold.
fn build_login_window(
    app: &tauri::AppHandle,
    visible: bool,
    loaded: Arc<AtomicBool>,
) -> Result<tauri::WebviewWindow, CommandError> {
    if let Some(existing) = app.get_webview_window(YOUTUBE_LOGIN_WINDOW) {
        let _ = existing.close();
    }

    let blank_url = "about:blank".parse().map_err(|error| CommandError {
        message: format!("invalid blank login URL: {error}"),
    })?;
    let window_builder = tauri::WebviewWindowBuilder::new(
        app,
        YOUTUBE_LOGIN_WINDOW,
        tauri::WebviewUrl::External(blank_url),
    )
    .title("Sign in to YouTube Music")
    .visible(visible)
    .skip_taskbar(!visible)
    .inner_size(520.0, 760.0)
    .on_page_load(move |_window, payload| {
        if payload.event() == tauri::webview::PageLoadEvent::Finished {
            loaded.store(true, Ordering::Relaxed);
        }
    });
    // See YOUTUBE_LOGIN_DATA_DIR: without its own partition, clearing this window's data
    // clears the main window's storage too.
    #[cfg(not(target_os = "macos"))]
    let window_builder = window_builder.data_directory(
        app.path()
            .app_local_data_dir()
            .map_err(|error| CommandError {
                message: format!("sign-in data directory unavailable: {error}"),
            })?
            .join(YOUTUBE_LOGIN_DATA_DIR),
    );
    #[cfg(target_os = "macos")]
    let window_builder = window_builder
        .user_agent(MACOS_LOGIN_USER_AGENT)
        // macOS 14+ only; older versions fall back to the shared store, as they did before.
        .data_store_identifier(YOUTUBE_LOGIN_DATA_STORE_ID);

    window_builder.build().map_err(|error| CommandError {
        message: format!("unable to open YouTube Music sign-in: {error}"),
    })
}

/// The session cookie as the login webview currently holds it, if it holds one at all.
fn harvest_session_cookie(
    window: &tauri::WebviewWindow,
) -> Result<Option<String>, CommandError> {
    #[cfg(target_os = "macos")]
    let cookies = window
        .cookies()
        .map_err(|error| CommandError {
            message: format!("unable to read YouTube Music session: {error}"),
        })?
        .into_iter()
        .filter(|cookie| cookie_domain_matches("music.youtube.com", cookie.domain()))
        .collect::<Vec<_>>();
    #[cfg(not(target_os = "macos"))]
    let cookies = {
        let cookie_url: url::Url = "https://music.youtube.com/"
            .parse()
            .map_err(|error| CommandError {
                message: format!("invalid YouTube Music cookie URL: {error}"),
            })?;
        window
            .cookies_for_url(cookie_url)
            .map_err(|error| CommandError {
                message: format!("unable to read YouTube Music session: {error}"),
            })?
    };

    let cookie_names = cookies
        .iter()
        .map(|cookie| cookie.name())
        .collect::<std::collections::HashSet<_>>();
    let has_auth_cookie = ["SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"]
        .iter()
        .any(|name| cookie_names.contains(name));
    let on_music_page = window
        .url()
        .map(|url| url.domain() == Some("music.youtube.com"))
        .unwrap_or(false);
    if !has_auth_cookie || !on_music_page {
        return Ok(None);
    }

    Ok(Some(
        cookies
            .iter()
            .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
            .collect::<Vec<_>>()
            .join("; "),
    ))
}

fn store_session_cookie(
    app: &tauri::AppHandle,
    jar: &YoutubeCookieJar,
    cookie: &str,
) -> Result<(), CommandError> {
    save_youtube_music_cookie(app, cookie)?;
    if let Ok(mut state) = jar.0.lock() {
        state.cookie = Some(cookie.to_string());
        state.persisted_at = Some(Instant::now());
    }
    Ok(())
}

#[tauri::command]
async fn sign_in_youtube_music(
    app: tauri::AppHandle,
    jar: tauri::State<'_, YoutubeCookieJar>,
) -> Result<String, CommandError> {
    eprintln!("[internal][tauri][info] sign_in_youtube_music start");
    /*
     * Deliberately *not* cleared here any more.
     *
     * The partition is now the app's durable record of who is signed in — the thing
     * refresh_youtube_music_cookie renews the session from without troubling the user. Wiping
     * it on every sign-in threw that away and made a full interactive login the only way back.
     * Sign-out still clears it, which is where "forget me" belongs.
     */
    let window = build_login_window(&app, true, Arc::new(AtomicBool::new(false)))?;
    eprintln!("[internal][tauri][info] sign_in_youtube_music login window created");

    let login_url = YOUTUBE_LOGIN_URL.parse().map_err(|error| CommandError {
        message: format!("invalid YouTube Music sign-in URL: {error}"),
    })?;
    window.navigate(login_url).map_err(|error| CommandError {
        message: format!("unable to navigate to YouTube Music sign-in: {error}"),
    })?;
    eprintln!("[internal][tauri][info] sign_in_youtube_music navigated to Google sign-in");

    for poll in 1..=300 {
        if let Some(cookie_header) = harvest_session_cookie(&window)? {
            eprintln!(
                "[internal][tauri][info] sign_in_youtube_music detected session poll={} credential_bytes={}",
                poll,
                cookie_header.len()
            );
            store_session_cookie(&app, &jar, &cookie_header)?;
            let _ = window.close();
            return Ok(cookie_header);
        }

        if app.get_webview_window(YOUTUBE_LOGIN_WINDOW).is_none() {
            eprintln!(
                "[internal][tauri][warn] sign_in_youtube_music cancelled poll={}",
                poll
            );
            return Err(CommandError {
                message: "YouTube Music sign-in was cancelled.".to_string(),
            });
        }
        thread::sleep(Duration::from_secs(1));
    }

    let _ = window.close();
    eprintln!("[internal][tauri][warn] sign_in_youtube_music timed out");
    Err(CommandError {
        message: "YouTube Music sign-in timed out.".to_string(),
    })
}

/// Renews the session from the sign-in partition without involving the user.
///
/// The partition holds a real browser session that Google keeps alive on its own terms, so
/// loading music.youtube.com in it is usually enough to mint a working cookie again. Returns
/// `None` when that fails — which means the sign-in genuinely lapsed and only the user can fix
/// it. Deliberately short: this runs while somebody is waiting to press Like, and a hidden
/// window that needs interaction is a window that is never going to finish.
#[tauri::command]
async fn refresh_youtube_music_cookie(
    app: tauri::AppHandle,
    jar: tauri::State<'_, YoutubeCookieJar>,
) -> Result<Option<String>, CommandError> {
    eprintln!("[internal][tauri][info] refresh_youtube_music_cookie start");
    let loaded = Arc::new(AtomicBool::new(false));
    let window = build_login_window(&app, false, loaded.clone())?;

    let music_url = "https://music.youtube.com/"
        .parse()
        .map_err(|error| CommandError {
            message: format!("invalid YouTube Music URL: {error}"),
        })?;
    window.navigate(music_url).map_err(|error| CommandError {
        message: format!("unable to open YouTube Music silently: {error}"),
    })?;

    for poll in 1..=YOUTUBE_SILENT_REFRESH_POLLS {
        // Only after a load: harvesting early returns the same stale cookie we came in with,
        // because nothing has been through a round trip to Google yet.
        if loaded.load(Ordering::Relaxed) {
            if let Some(cookie_header) = harvest_session_cookie(&window)? {
                eprintln!(
                    "[internal][tauri][info] refresh_youtube_music_cookie renewed poll={} credential_bytes={}",
                    poll,
                    cookie_header.len()
                );
                store_session_cookie(&app, &jar, &cookie_header)?;
                let _ = window.close();
                return Ok(Some(cookie_header));
            }
        }
        thread::sleep(Duration::from_secs(1));
    }

    let _ = window.close();
    eprintln!("[internal][tauri][info] refresh_youtube_music_cookie found no usable session");
    Ok(None)
}

#[tauri::command]
async fn delete_youtube_music_cookie(
    app: tauri::AppHandle,
    jar: tauri::State<'_, YoutubeCookieJar>,
) -> Result<(), CommandError> {
    eprintln!("[internal][tauri][info] delete_youtube_music_cookie start");
    if let Ok(mut state) = jar.0.lock() {
        state.cookie = None;
        state.persisted_at = None;
    }
    delete_legacy_youtube_credentials();
    /*
     * Sign-out is the one place the sign-in partition is wiped, because it is the only place
     * the user has said "forget me". The window is built purely to reach the profile behind
     * it — clearing it is what makes the next sign-in offer a fresh account chooser instead of
     * silently resuming the account that just left.
     */
    if let Ok(window) = build_login_window(&app, false, Arc::new(AtomicBool::new(false))) {
        let _ = window.clear_all_browsing_data();
        // The clear is asynchronous underneath and reports through a handler nobody waits on;
        // closing the webview out from under it can leave the profile half-cleared.
        thread::sleep(Duration::from_millis(750));
        let _ = window.close();
    }

    #[cfg(target_os = "macos")]
    {
        let path = youtube_cookie_encrypted_file(&app)?;
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(CommandError {
                    message: format!("encrypted session delete failed: {error}"),
                })
            }
        }
    }

    #[cfg(not(target_os = "macos"))]
    delete_youtube_music_cookie_entries()?;
    eprintln!("[internal][tauri][info] delete_youtube_music_cookie complete");
    Ok(())
}

#[derive(Serialize)]
struct CommandError {
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioPayload {
    body_base64: String,
    mime_type: String,
}

#[derive(serde::Deserialize)]
struct ProxyHttpRequestInput {
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body_base64: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Serialize)]
struct ProxyHttpResponse {
    status: u16,
    headers: HashMap<String, String>,
    body_base64: String,
    /// The rotated cookie, when this response changed it. Absent means "unchanged".
    #[serde(skip_serializing_if = "Option::is_none")]
    cookie: Option<String>,
}

#[derive(Clone)]
struct MediaItem {
    bytes: Arc<Vec<u8>>,
    mime_type: String,
}

struct MediaServer {
    origin: String,
    items: Arc<Mutex<HashMap<String, MediaItem>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioSourcePayload {
    url: String,
    mime_type: String,
    byte_length: usize,
}

static MEDIA_SERVER: OnceLock<MediaServer> = OnceLock::new();

fn collect_json_renderer_counts(value: &serde_json::Value, counts: &mut HashMap<String, usize>) {
    match value {
        serde_json::Value::Object(object) => {
            for (key, child) in object {
                if key.ends_with("Renderer")
                    || key.ends_with("Continuation")
                    || key.ends_with("Command")
                {
                    *counts.entry(key.clone()).or_default() += 1;
                }
                collect_json_renderer_counts(child, counts);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_json_renderer_counts(item, counts);
            }
        }
        _ => {}
    }
}

fn media_server() -> Result<&'static MediaServer, CommandError> {
    if let Some(server) = MEDIA_SERVER.get() {
        return Ok(server);
    }

    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| CommandError {
        message: format!("media server bind failed: {error}"),
    })?;
    let port = listener.local_addr().map_err(|error| CommandError {
        message: format!("media server local address failed: {error}"),
    })?.port();
    let items = Arc::new(Mutex::new(HashMap::<String, MediaItem>::new()));
    let thread_items = Arc::clone(&items);
    thread::spawn(move || {
        for stream in listener.incoming() {
            match stream {
                Ok(stream) => {
                    let items = Arc::clone(&thread_items);
                    thread::spawn(move || handle_media_request(stream, items));
                }
                Err(error) => {
                    eprintln!("[internal][tauri][warn] media server accept failed error={}", error);
                }
            }
        }
    });

    let server = MediaServer {
        origin: format!("http://127.0.0.1:{port}"),
        items,
    };
    let _ = MEDIA_SERVER.set(server);
    MEDIA_SERVER.get().ok_or_else(|| CommandError {
        message: "media server initialization failed".into(),
    })
}

fn handle_media_request(
    mut stream: std::net::TcpStream,
    items: Arc<Mutex<HashMap<String, MediaItem>>>,
) {
    let mut buffer = [0_u8; 4096];
    let read_len = match stream.read(&mut buffer) {
        Ok(len) => len,
        Err(error) => {
            eprintln!("[internal][tauri][warn] media server read failed error={}", error);
            return;
        }
    };
    let request = String::from_utf8_lossy(&buffer[..read_len]);
    let mut lines = request.lines();
    let request_line = lines.next().unwrap_or_default();
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default();
    let path = request_parts.next().unwrap_or_default();
    if method != "GET" && method != "HEAD" {
        let _ = stream.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n");
        return;
    }

    let range_header = lines.find_map(|line| {
        line.strip_prefix("Range:")
            .or_else(|| line.strip_prefix("range:"))
            .map(str::trim)
            .map(str::to_string)
    });
    let key = path
        .trim_start_matches("/audio/")
        .split('?')
        .next()
        .unwrap_or_default();
    let item = match items.lock().ok().and_then(|items| items.get(key).cloned()) {
        Some(item) => item,
        None => {
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
            return;
        }
    };

    let total_len = item.bytes.len();
    let (status, start, end) = parse_media_range(range_header.as_deref(), total_len)
        .unwrap_or(("200 OK", 0, total_len.saturating_sub(1)));
    let body_len = if total_len == 0 { 0 } else { end - start + 1 };
    let content_range = if status.starts_with("206") {
        format!("Content-Range: bytes {start}-{end}/{total_len}\r\n")
    } else {
        String::new()
    };
    let headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {}\r\nAccept-Ranges: bytes\r\n{}Content-Length: {body_len}\r\nConnection: close\r\n\r\n",
        item.mime_type,
        content_range,
    );
    let _ = stream.write_all(headers.as_bytes());
    if method == "HEAD" || total_len == 0 {
        return;
    }
    let _ = stream.write_all(&item.bytes[start..=end]);
}

fn parse_media_range(range_header: Option<&str>, total_len: usize) -> Option<(&'static str, usize, usize)> {
    let value = range_header?.strip_prefix("bytes=")?;
    if total_len == 0 {
        return None;
    }
    let (start_raw, end_raw) = value.split_once('-')?;
    let start = if start_raw.is_empty() {
        let suffix_len = end_raw.parse::<usize>().ok()?;
        total_len.saturating_sub(suffix_len)
    } else {
        start_raw.parse::<usize>().ok()?
    };
    let end = if end_raw.is_empty() {
        total_len - 1
    } else {
        end_raw.parse::<usize>().ok()?.min(total_len - 1)
    };
    (start <= end && start < total_len).then_some(("206 Partial Content", start, end))
}

#[tauri::command]
async fn fetch_audio_bytes(
    url: String,
    track_id: String,
    cookie: Option<String>,
) -> Result<Vec<u8>, CommandError> {
    let started_at = Instant::now();
    eprintln!(
        "[internal][tauri][info] fetch_audio_bytes start url={} track_id={}",
        url, track_id
    );
    let request_url = url::Url::parse(&url).map_err(|error| CommandError {
        message: format!("audio URL parse failed: {error}"),
    })?;
    let mut client_builder = reqwest::Client::builder();
    if let Some(local_address) = signed_googlevideo_local_address(&request_url) {
        eprintln!(
            "[internal][tauri][info] fetch_audio_bytes forcing signed IP family family={}",
            if local_address.is_ipv6() { "ipv6" } else { "ipv4" }
        );
        client_builder = client_builder.local_address(local_address);
    }
    let client = client_builder.build().map_err(|error| CommandError {
        message: format!("audio HTTP client creation failed: {error}"),
    })?;
    /*
     * The whole file in one request, asked for the way the browser asks: `range=0-{clen-1}` in
     * the query string. When `clen` is absent there is nothing to bound the request with, so it
     * goes out plain — still without a Range header, which is what gets these refused.
     */
    let ranged_url = match signed_content_length(&request_url) {
        Some(total) if total > 0 => audio_url_with_range(&url, 0, total - 1),
        _ => url.clone(),
    };
    let response = send_audio_request(&client, &ranged_url, cookie.as_deref(), &track_id).await?;

    let body = response.bytes().await.map_err(|error| {
        eprintln!(
            "[internal][tauri][error] fetch_audio_bytes body read failed url={} error={}",
            url, error
        );
        CommandError {
            message: format!("read body failed: {error}"),
        }
    })?;

    eprintln!(
        "[internal][tauri][info] fetch_audio_bytes success url={} bytes={} duration_ms={}",
        url,
        body.len(),
        started_at.elapsed().as_millis()
    );

    Ok(body.to_vec())
}

/// Where downloaded audio lives. Separate from the metadata cache on purpose: that one is
/// JSON and size-capped for throwaway data, whereas these files are the user's explicit
/// "keep this" and must survive a cache clear.
fn offline_dir(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("offline-audio-v1"))
        .map_err(|error| cache_error(format!("offline directory unavailable: {error}")))
}

/// Track ids come from YouTube and are already filename-safe, but a hostile id must not be
/// able to escape the directory.
fn offline_entry_path(app: &tauri::AppHandle, track_id: &str) -> Result<PathBuf, CommandError> {
    let unsafe_char = track_id
        .chars()
        .any(|value| value == '/' || value == '\\' || value == ':' || value == '\0');
    if track_id.is_empty() || unsafe_char || track_id.contains("..") {
        return Err(cache_error("invalid offline track id"));
    }
    Ok(offline_dir(app)?.join(format!("{track_id}.bin")))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OfflineEntryInfo {
    track_id: String,
    byte_length: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OfflineStats {
    entry_count: u64,
    used_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OfflineProgress {
    track_id: String,
    received_bytes: u64,
    total_bytes: u64,
    percent: u8,
}

/// Bytes per range request. Large enough that per-request overhead is negligible, small
/// enough that several are in flight at once on an ordinary connection.
const OFFLINE_CHUNK_BYTES: u64 = 4 * 1024 * 1024;

/// Range requests in flight at once.
///
/// googlevideo throttles a single sequential stream hard — that is the documented behaviour
/// media downloaders work around, and it is why downloading a track took far longer than
/// streaming the same track takes to buffer. Several ranges in parallel side-step it. Kept
/// modest so a download does not starve playback of the same connection.
const OFFLINE_CHUNK_CONCURRENCY: usize = 6;

fn offline_http_client(request_url: &url::Url) -> Result<reqwest::Client, CommandError> {
    let mut client_builder = reqwest::Client::builder();
    if let Some(local_address) = signed_googlevideo_local_address(request_url) {
        client_builder = client_builder.local_address(local_address);
    }
    client_builder
        .build()
        .map_err(|error| cache_error(format!("audio HTTP client creation failed: {error}")))
}

/// Appends googlevideo's `range` query parameter.
///
/// The browser asks for bytes *here*, not with a Range header: a live YouTube Music session
/// sends `&range=1754030-3508710` and no Range header at all. A signed URL fetched with a Range
/// header is refused with a bare 403 and an empty body.
///
/// This is why every earlier attempt failed identically — two header styles, a bounded range and
/// an open one, four combinations, all refused. The Range header itself was the problem, so
/// varying its value or the headers around it could never have helped.
fn audio_url_with_range(url: &str, start: u64, end: u64) -> String {
    let separator = if url.contains('?') { '&' } else { '?' };
    format!("{url}{separator}range={start}-{end}")
}

/// Total byte length as declared by the URL's own `clen`.
///
/// Needed because a `range=` query answers 200 with just that slice rather than 206 with a
/// Content-Range, so the response cannot say how large the whole file is.
fn signed_content_length(request_url: &url::Url) -> Option<u64> {
    request_url
        .query_pairs()
        .find(|(key, _)| key == "clen")
        .and_then(|(_, value)| value.parse::<u64>().ok())
}

/// A googlevideo media request, dressed the way the browser dresses one.
///
/// Origin and Referer name music.youtube.com because that is the session the URL was issued to,
/// and the cookie because the player's own media requests are credentialed — googlevideo echoes
/// `access-control-allow-credentials` back at them.
fn googlevideo_audio_request(
    client: &reqwest::Client,
    url: &str,
    cookie: Option<&str>,
) -> reqwest::RequestBuilder {
    let request = client
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .header("Accept", "*/*")
        // identity so the CDN does not gzip audio that is already compressed; the length
        // check downstream depends on Content-Length meaning what it says.
        .header("Accept-Encoding", "identity;q=1, *;q=0")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Origin", "https://music.youtube.com")
        .header("Referer", "https://music.youtube.com/");

    match cookie.filter(|value| !value.trim().is_empty()) {
        Some(cookie) => request.header("Cookie", cookie),
        None => request,
    }
}

/// Fetches a signed audio URL whose byte range, if any, is already in the URL.
async fn send_audio_request(
    client: &reqwest::Client,
    url: &str,
    cookie: Option<&str>,
    track_id: &str,
) -> Result<reqwest::Response, CommandError> {
    let started_at = Instant::now();
    let response = googlevideo_audio_request(client, url, cookie)
        .send()
        .await
        .map_err(|error| cache_error(format!("audio request failed: {error}")))?;

    if response.status().is_success() {
        return Ok(response);
    }

    /*
     * googlevideo answers a refused media request with an empty body, so its reason — if it gives
     * one at all — is only ever in the response headers. None of them are secret.
     */
    let headers: Vec<String> = response
        .headers()
        .iter()
        .map(|(name, value)| format!("{name}={}", value.to_str().unwrap_or("?")))
        .collect();
    let status = response.status();
    eprintln!(
        "[internal][tauri][warn] googlevideo refused track_id={} status={} duration_ms={} headers=[{}]",
        track_id,
        status,
        started_at.elapsed().as_millis(),
        headers.join(", ")
    );

    Err(cache_error(format!("request returned {status}")))
}

fn emit_offline_progress(
    app: &tauri::AppHandle,
    track_id: &str,
    received: u64,
    total: u64,
    last_percent: &mut u8,
) {
    if total == 0 {
        return;
    }
    let percent = ((received * 100) / total).min(100) as u8;
    // One event per whole percent; a chunk-rate feed would flood the webview.
    if percent > *last_percent {
        *last_percent = percent;
        let _ = app.emit(
            "offline-download-progress",
            OfflineProgress {
                track_id: track_id.to_string(),
                received_bytes: received,
                total_bytes: total,
                percent,
            },
        );
    }
}

/// Downloads a track to the offline store, reporting real progress as it goes.
///
/// Tries parallel range requests first and falls back to a single stream when the server
/// answers 200 instead of 206 — a server that ignores Range would otherwise hand back the
/// whole body for every chunk and the pieces would be spliced into nonsense.
#[tauri::command]
async fn offline_audio_save(
    app: tauri::AppHandle,
    url: String,
    track_id: String,
    cookie: Option<String>,
) -> Result<u64, CommandError> {
    use futures_util::stream::StreamExt;

    let request_url = url::Url::parse(&url)
        .map_err(|error| cache_error(format!("audio URL parse failed: {error}")))?;
    let client = offline_http_client(&request_url)?;
    let started_at = Instant::now();

    /*
     * One line per download attempt, carrying the track it belongs to. The refusals used to be
     * correlatable only by their position in the file, which made a ladder of attempts across
     * several tracks genuinely hard to read.
     *
     * The URL is passed raw: the eprintln! macro sanitizes every line on its way out, so
     * pre-sanitizing here would redact the redaction and report the length of "[105ch]" rather
     * than of the signature.
     */
    eprintln!(
        "[internal][tauri][info] offline_audio_save request track_id={} url={}",
        track_id, url
    );

    /*
     * `clen` rather than a probe request. A `range=` query is answered with 200 and just that
     * slice — there is no 206 and no Content-Range — so the response cannot report the total
     * size and the old probe-and-inspect dance has nothing left to inspect. The URL states the
     * length itself, and it is covered by the signature, so it cannot disagree with the file.
     */
    let total_bytes = signed_content_length(&request_url).unwrap_or(0);

    let mut last_percent: u8 = 0;
    let mut bytes: Vec<u8>;

    if total_bytes > OFFLINE_CHUNK_BYTES {
        let mut received = 0u64;

        let mut ranges = Vec::new();
        let mut start = 0u64;
        while start < total_bytes {
            let end = (start + OFFLINE_CHUNK_BYTES - 1).min(total_bytes - 1);
            ranges.push((start, end));
            start = end + 1;
        }

        let mut chunks: Vec<(u64, Vec<u8>)> = Vec::with_capacity(ranges.len());
        let mut stream = futures_util::stream::iter(ranges.into_iter().map(|(start, end)| {
            let client = client.clone();
            let url = url.clone();
            let cookie = cookie.clone();
            async move {
                let response =
                    googlevideo_audio_request(&client, &audio_url_with_range(&url, start, end), cookie.as_deref())
                        .send()
                        .await
                        .map_err(|error| {
                            cache_error(format!("audio range request failed: {error}"))
                        })?;
                if !response.status().is_success() {
                    return Err(cache_error(format!("range returned {}", response.status())));
                }
                let body = response
                    .bytes()
                    .await
                    .map_err(|error| cache_error(format!("audio range read failed: {error}")))?;
                Ok::<(u64, Vec<u8>), CommandError>((start, body.to_vec()))
            }
        }))
        .buffer_unordered(OFFLINE_CHUNK_CONCURRENCY);

        let mut chunk_error: Option<CommandError> = None;
        while let Some(result) = stream.next().await {
            let (start, body) = match result {
                Ok(value) => value,
                Err(error) => {
                    chunk_error = Some(error);
                    break;
                }
            };
            received += body.len() as u64;
            emit_offline_progress(&app, &track_id, received, total_bytes, &mut last_percent);
            chunks.push((start, body));
        }

        // One refused chunk invalidates the whole assembly, so restart on the proven path
        // instead of writing a file with a hole in it.
        if let Some(error) = chunk_error {
            eprintln!(
                "[internal][tauri][warn] offline_audio_save chunk failed ({}) falling back",
                error.message
            );
            let whole = fetch_audio_bytes(url.clone(), track_id.clone(), cookie.clone()).await?;
            if whole.is_empty() {
                return Err(cache_error("audio download returned no data"));
            }
            return write_offline_entry(&app, &track_id, &whole, started_at, false);
        }

        // Ranges complete out of order, so the file is reassembled by offset.
        chunks.sort_by_key(|(start, _)| *start);
        bytes = Vec::with_capacity(total_bytes as usize);
        for (_, body) in chunks {
            bytes.extend_from_slice(&body);
        }
    } else {
        // Small enough for one request, or `clen` was absent and there is nothing to chunk by.
        let whole = fetch_audio_bytes(url.clone(), track_id.clone(), cookie.clone()).await?;
        bytes = whole;
        let received = bytes.len() as u64;
        emit_offline_progress(
            &app,
            &track_id,
            received,
            if total_bytes > 0 { total_bytes } else { received },
            &mut last_percent,
        );
    }

    if bytes.is_empty() {
        return Err(cache_error("audio download returned no data"));
    }
    if total_bytes > 0 && (bytes.len() as u64) != total_bytes {
        return Err(cache_error(format!(
            "audio download was incomplete: {} of {} bytes",
            bytes.len(),
            total_bytes
        )));
    }

    write_offline_entry(&app, &track_id, &bytes, started_at, total_bytes > OFFLINE_CHUNK_BYTES)
}

/// Commits a completed download to the offline store.
///
/// Shared by the ranged and fallback paths so the temp-file-then-rename guarantee holds for
/// both: an interrupted write must never leave a truncated file that looks complete and then
/// fails to play.
fn write_offline_entry(
    app: &tauri::AppHandle,
    track_id: &str,
    bytes: &[u8],
    started_at: Instant,
    ranged: bool,
) -> Result<u64, CommandError> {
    let path = offline_entry_path(app, track_id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| cache_error(format!("offline directory creation failed: {error}")))?;
    }
    let temp_path = path.with_extension("part");
    fs::write(&temp_path, bytes)
        .map_err(|error| cache_error(format!("offline write failed: {error}")))?;
    fs::rename(&temp_path, &path)
        .map_err(|error| cache_error(format!("offline rename failed: {error}")))?;

    eprintln!(
        "[internal][tauri][info] offline_audio_save track_id={} bytes={} ranged={} duration_ms={}",
        track_id,
        bytes.len(),
        ranged,
        started_at.elapsed().as_millis()
    );
    Ok(bytes.len() as u64)
}

/// Serves an already-downloaded track through the same local media server the online path
/// uses, so playback needs no special case for offline sources.
#[tauri::command]
fn offline_audio_source(
    app: tauri::AppHandle,
    track_id: String,
    mime_type: String,
) -> Result<AudioSourcePayload, CommandError> {
    let path = offline_entry_path(&app, &track_id)?;
    let bytes =
        fs::read(&path).map_err(|error| cache_error(format!("offline read failed: {error}")))?;
    let byte_length = bytes.len();

    let server = media_server()?;
    let key = format!("offline-{track_id}");
    {
        let mut items = server.items.lock().map_err(|_| CommandError {
            message: "media server cache lock poisoned".into(),
        })?;
        items.insert(
            key.clone(),
            MediaItem {
                bytes: Arc::new(bytes),
                mime_type: mime_type.clone(),
            },
        );
    }

    Ok(AudioSourcePayload {
        url: format!("{}/audio/{}", server.origin, key),
        mime_type,
        byte_length,
    })
}

#[tauri::command]
fn offline_audio_has(app: tauri::AppHandle, track_id: String) -> Result<bool, CommandError> {
    Ok(offline_entry_path(&app, &track_id)?.exists())
}

#[tauri::command]
fn offline_audio_remove(app: tauri::AppHandle, track_id: String) -> Result<(), CommandError> {
    let path = offline_entry_path(&app, &track_id)?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|error| cache_error(format!("offline delete failed: {error}")))?;
    }
    Ok(())
}

/// The source of truth for what is downloaded. The frontend keeps its own manifest for track
/// metadata, but this is what reconciles it when the two disagree.
#[tauri::command]
fn offline_audio_list(app: tauri::AppHandle) -> Result<Vec<OfflineEntryInfo>, CommandError> {
    let dir = offline_dir(&app)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    let read_dir = fs::read_dir(&dir)
        .map_err(|error| cache_error(format!("offline listing failed: {error}")))?;
    for entry in read_dir.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("bin") {
            continue;
        }
        let Some(track_id) = path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        entries.push(OfflineEntryInfo {
            track_id: track_id.to_string(),
            byte_length: entry.metadata().map(|meta| meta.len()).unwrap_or(0),
        });
    }
    Ok(entries)
}

#[tauri::command]
fn offline_audio_stats(app: tauri::AppHandle) -> Result<OfflineStats, CommandError> {
    let entries = offline_audio_list(app)?;
    Ok(OfflineStats {
        entry_count: entries.len() as u64,
        used_bytes: entries.iter().map(|entry| entry.byte_length).sum(),
    })
}

/// Deletes least-recently-*modified* entries until the store fits `max_bytes`.
///
/// Modification time rather than access time: access times are unreliable on Windows and
/// playing a track does not rewrite the file, so mtime is effectively "when it was
/// downloaded" -- a blunt but stable ordering.
#[tauri::command]
fn offline_audio_prune(app: tauri::AppHandle, max_bytes: u64) -> Result<OfflineStats, CommandError> {
    let dir = offline_dir(&app)?;
    if !dir.exists() {
        return Ok(OfflineStats {
            entry_count: 0,
            used_bytes: 0,
        });
    }

    let mut files: Vec<(PathBuf, u64, SystemTime)> = fs::read_dir(&dir)
        .map_err(|error| cache_error(format!("offline listing failed: {error}")))?
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("bin") {
                return None;
            }
            let meta = entry.metadata().ok()?;
            Some((path, meta.len(), meta.modified().unwrap_or(UNIX_EPOCH)))
        })
        .collect();

    files.sort_by_key(|(_, _, modified)| *modified);
    let mut used_bytes: u64 = files.iter().map(|(_, size, _)| *size).sum();
    let mut entry_count = files.len() as u64;

    for (path, size, _) in &files {
        if used_bytes <= max_bytes {
            break;
        }
        if fs::remove_file(path).is_ok() {
            used_bytes = used_bytes.saturating_sub(*size);
            entry_count = entry_count.saturating_sub(1);
        }
    }

    Ok(OfflineStats {
        entry_count,
        used_bytes,
    })
}

#[tauri::command]
async fn fetch_audio_source(
    url: String,
    track_id: String,
    mime_type: String,
    cookie: Option<String>,
) -> Result<AudioSourcePayload, CommandError> {
    let bytes = fetch_audio_bytes(url, track_id.clone(), cookie).await?;
    if bytes.len() >= 12 && &bytes[4..8] != b"ftyp" {
        let preview = String::from_utf8_lossy(&bytes[..bytes.len().min(120)]).replace('\n', " ");
        return Err(CommandError {
            message: format!("Audio download was not an MP4 file. Response started with: {preview}"),
        });
    }

    let server = media_server()?;
    let key = format!(
        "{}-{}",
        track_id,
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default()
    );
    let byte_length = bytes.len();
    {
        let mut items = server.items.lock().map_err(|_| CommandError {
            message: "media server cache lock poisoned".into(),
        })?;
        items.insert(
            key.clone(),
            MediaItem {
                bytes: Arc::new(bytes),
                mime_type: mime_type.clone(),
            },
        );
    }

    Ok(AudioSourcePayload {
        url: format!("{}/audio/{}", server.origin, key),
        mime_type,
        byte_length,
    })
}

#[tauri::command]
async fn fetch_youtube_music_audio(video_id: String) -> Result<AudioPayload, CommandError> {
    let started_at = Instant::now();
    eprintln!(
        "[internal][tauri][info] fetch_youtube_music_audio start video_id={}",
        video_id
    );

    let client = reqwest::Client::new();

    // Mobile and TV clients are preferred because they are more likely to
    // return direct media URLs that do not require player-JavaScript deciphering.
    let api_attempts = vec![
        ("YouTube iOS", YOUTUBE_PLAYER_API_URL, create_ios_context()),
        (
            "YouTube ANDROID",
            YOUTUBE_PLAYER_API_URL,
            create_android_context(),
        ),
        ("YouTube TV", YOUTUBE_PLAYER_API_URL, create_tv_context()),
        ("YouTube WEB", YOUTUBE_PLAYER_API_URL, create_web_context()),
        (
            "YouTube Music WEB_REMIX",
            YOUTUBE_MUSIC_PLAYER_API_URL,
            create_web_remix_context(),
        ),
    ];

    let mut failures = Vec::new();
    for (attempt_name, api_url, context) in api_attempts {
        eprintln!(
            "[internal][tauri][info] fetch_youtube_music_audio trying {} video_id={}",
            attempt_name, video_id
        );

        match try_youtube_api(&client, &api_url, &context, &video_id, &attempt_name).await {
            Ok(audio_bytes) => {
                eprintln!(
                    "[internal][tauri][info] fetch_youtube_music_audio success video_id={} attempt={} bytes={} duration_ms={}",
                    video_id,
                    attempt_name,
                    audio_bytes.body_base64.len(),
                    started_at.elapsed().as_millis()
                );
                return Ok(audio_bytes);
            }
            Err(error) => {
                eprintln!(
                    "[internal][tauri][error] fetch_youtube_music_audio attempt failed video_id={} attempt={} error={}",
                    video_id, attempt_name, error.message
                );
                failures.push(format!("{attempt_name}: {}", error.message));
            }
        }
    }

    eprintln!(
        "[internal][tauri][error] fetch_youtube_music_audio all attempts failed video_id={}",
        video_id
    );
    Err(CommandError {
        message: format!("all YouTube API attempts failed: {}", failures.join("; ")),
    })
}

fn create_web_remix_context() -> serde_json::Value {
    serde_json::json!({
        "client": {
            "clientName": "WEB_REMIX",
            "clientVersion": "1.20250506.00.00",
            "hl": "en",
            "gl": "US",
            "platform": "DESKTOP",
            "osName": "Windows",
            "osVersion": "10.0",
            "browserName": "Chrome",
            "browserVersion": "135.0.0.0",
            "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
        }
    })
}

fn create_web_context() -> serde_json::Value {
    serde_json::json!({
        "client": {
            "clientName": "WEB",
            "clientVersion": "2.20260206.01.00",
            "hl": "en",
            "gl": "US",
            "platform": "DESKTOP",
            "osName": "Windows",
            "osVersion": "10.0",
            "browserName": "Chrome",
            "browserVersion": "135.0.0.0",
            "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
        }
    })
}

fn create_ios_context() -> serde_json::Value {
    serde_json::json!({
        "client": {
            "clientName": "IOS",
            "clientVersion": "20.11.6",
            "hl": "en",
            "gl": "US",
            "deviceModel": "iPhone10,4",
            "osName": "iPhone",
            "osVersion": "16.7.7.20H330",
            "userAgent": "com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)"
        }
    })
}

fn create_android_context() -> serde_json::Value {
    serde_json::json!({
        "client": {
            "clientName": "ANDROID",
            "clientVersion": "21.03.36",
            "hl": "en",
            "gl": "US",
            "platform": "MOBILE",
            "osName": "Android",
            "osVersion": "16",
            "androidSdkVersion": 36,
            "userAgent": "com.google.android.youtube/21.03.36(Linux; U; Android 16; en_US; SM-S908E Build/TP1A.220624.014) gzip"
        }
    })
}

fn create_tv_context() -> serde_json::Value {
    serde_json::json!({
        "client": {
            "clientName": "TVHTML5",
            "clientVersion": "7.20260311.12.00",
            "hl": "en",
            "gl": "US",
            "platform": "TV",
            "osName": "Linux",
            "userAgent": "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version"
        }
    })
}

async fn try_youtube_api(
    client: &reqwest::Client,
    api_url: &str,
    context: &serde_json::Value,
    video_id: &str,
    attempt_name: &str,
) -> Result<AudioPayload, CommandError> {
    let request_body = serde_json::json!({
        "context": context,
        "videoId": video_id,
        "racyCheckOk": true,
        "contentCheckOk": true
    });

    let request_body_str = serde_json::to_string(&request_body).map_err(|error| CommandError {
        message: format!("json serialize failed: {error}"),
    })?;

    let referer = if attempt_name.contains("Music") {
        "https://music.youtube.com/"
    } else {
        "https://www.youtube.com/"
    };

    let user_agent = if attempt_name.contains("iOS") {
        "com.google.ios.youtube/20.11.6 (iPhone10,4; U; CPU iOS 16_7_7 like Mac OS X)"
    } else if attempt_name.contains("ANDROID") {
        "com.google.android.youtube/21.03.36(Linux; U; Android 16; en_US; SM-S908E Build/TP1A.220624.014) gzip"
    } else if attempt_name.contains("TV") {
        "Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version"
    } else {
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
    };
    let client_name = if attempt_name.contains("iOS") {
        "5"
    } else if attempt_name.contains("ANDROID") {
        "3"
    } else if attempt_name.contains("Music") {
        "67"
    } else if attempt_name.contains("TV") {
        "7"
    } else {
        "1"
    };
    let client_version = context
        .get("client")
        .and_then(|client| client.get("clientVersion"))
        .and_then(|version| version.as_str())
        .unwrap_or_default();

    eprintln!(
        "[internal][tauri][debug] YOUTUBE API REQUEST - {} url={} body_bytes={}",
        attempt_name,
        api_url,
        request_body_str.len()
    );

    let response = client
        .post(api_url)
        .header("Content-Type", "application/json")
        .header("User-Agent", user_agent)
        .header("Accept", "application/json")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("X-YouTube-Client-Name", client_name)
        .header("X-YouTube-Client-Version", client_version)
        .header("Referer", referer)
        .header("Origin", referer.trim_end_matches('/'))
        .body(request_body_str)
        .send()
        .await
        .map_err(|error| CommandError {
            message: format!("api request failed: {error}"),
        })?;

    let response_status = response.status();
    let response_text = response.text().await.map_err(|error| CommandError {
        message: format!("response read failed: {error}"),
    })?;
    if !response_status.is_success() {
        let response_preview = response_text.chars().take(500).collect::<String>();
        return Err(CommandError {
            message: format!("api request returned {response_status}: {response_preview}"),
        });
    }

    eprintln!(
        "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - response_bytes={}",
        attempt_name,
        response_text.len()
    );

    let response_json: serde_json::Value =
        serde_json::from_str(&response_text).map_err(|error| CommandError {
            message: format!("json parse failed: {error}"),
        })?;
    let visitor_data = response_json
        .get("responseContext")
        .and_then(|context| context.get("visitorData"))
        .and_then(|value| value.as_str());

    // LOG PARSED RESPONSE STRUCTURE
    eprintln!(
        "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - PARSED STRUCTURE",
        attempt_name
    );
    eprintln!(
        "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - TOP LEVEL KEYS: {:?}",
        attempt_name,
        response_json
            .as_object()
            .map(|obj| obj.keys().collect::<Vec<_>>())
            .unwrap_or_default()
    );

    // Check for playability status first
    if let Some(playability_status) = response_json.get("playabilityStatus") {
        let status = playability_status
            .get("status")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        let reason = playability_status
            .get("reason")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        eprintln!(
            "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - PLAYABILITY STATUS status={} has_reason={}",
            attempt_name, status, !reason.is_empty()
        );

        if status != "OK" {
            eprintln!(
                "[internal][tauri][warn] YOUTUBE API RESPONSE - {} - VIDEO NOT PLAYABLE: status={} has_reason={}",
                attempt_name, status, !reason.is_empty()
            );
            return Err(CommandError {
                message: format!("video not playable: {status}"),
            });
        }
    }

    // Check for video details
    if let Some(video_details) = response_json.get("videoDetails") {
        let duration_seconds = video_details
            .get("lengthSeconds")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        eprintln!(
            "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - VIDEO DETAILS has_title={} duration_seconds={}",
            attempt_name,
            video_details.get("title").is_some(),
            duration_seconds
        );
    }

    // Check for streaming data existence
    let has_streaming_data = response_json.get("streamingData").is_some();
    eprintln!(
        "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - HAS STREAMING DATA: {}",
        attempt_name, has_streaming_data
    );

    if has_streaming_data {
        if let Some(streaming_data) = response_json.get("streamingData") {
            eprintln!(
                "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - STREAMING DATA KEYS: {:?}",
                attempt_name,
                streaming_data
                    .as_object()
                    .map(|obj| obj.keys().collect::<Vec<_>>())
                    .unwrap_or_default()
            );

            // Log adaptive formats if they exist
            if let Some(adaptive_formats) = streaming_data.get("adaptiveFormats") {
                if let Some(formats_array) = adaptive_formats.as_array() {
                    eprintln!(
                        "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - ADAPTIVE FORMATS COUNT: {}",
                        attempt_name,
                        formats_array.len()
                    );

                    // Count audio vs video formats
                    let mut audio_count = 0;
                    let mut video_count = 0;
                    let mut audio_with_url = 0;
                    let mut video_with_url = 0;

                    for format in formats_array {
                        if let Some(format_obj) = format.as_object() {
                            if let Some(mime_type) =
                                format_obj.get("mimeType").and_then(|m| m.as_str())
                            {
                                if mime_type.contains("audio") {
                                    audio_count += 1;
                                    if format_obj.get("url").is_some() {
                                        audio_with_url += 1;
                                    }
                                } else if mime_type.contains("video") {
                                    video_count += 1;
                                    if format_obj.get("url").is_some() {
                                        video_with_url += 1;
                                    }
                                }
                            }
                        }
                    }

                    eprintln!(
                        "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - FORMAT SUMMARY: audio_total={}, audio_with_url={}, video_total={}, video_with_url={}",
                        attempt_name,
                        audio_count,
                        audio_with_url,
                        video_count,
                        video_with_url
                    );
                }
            }

            // Log regular formats if they exist
            if let Some(formats) = streaming_data.get("formats") {
                if let Some(formats_array) = formats.as_array() {
                    eprintln!(
                        "[internal][tauri][debug] YOUTUBE API RESPONSE - {} - REGULAR FORMATS COUNT: {}",
                        attempt_name,
                        formats_array.len()
                    );
                }
            }
        }
    }

    // Look for streaming data in the response
    let streaming_data = response_json
        .get("streamingData")
        .and_then(|sd| sd.get("adaptiveFormats"))
        .and_then(|af| af.as_array())
        .ok_or_else(|| {
            eprintln!(
                "[internal][tauri][error] YOUTUBE API RESPONSE - {} - NO STREAMING DATA FOUND",
                attempt_name
            );
            CommandError {
                message: "no streaming data found".to_string(),
            }
        })?;

    // Ciphered formats require YouTube's player JavaScript. This backend only
    // accepts direct URLs instead of sending an invalid encrypted signature.
    let mut best_audio_url: Option<String> = None;
    let mut best_mime_type: Option<String> = None;
    let mut best_is_mp4 = false;
    let mut best_bitrate: u32 = 0;

    for format in streaming_data {
        if let Some(format_obj) = format.as_object() {
            if let (Some(mime_type), Some(bitrate)) = (
                format_obj.get("mimeType"),
                format_obj.get("bitrate").and_then(|b| b.as_u64()),
            ) {
                if let Some(mime_str) = mime_type.as_str() {
                    let is_mp4 = mime_str.starts_with("audio/mp4");
                    let is_better = is_mp4 && !best_is_mp4
                        || is_mp4 == best_is_mp4 && bitrate > best_bitrate as u64;
                    if mime_str.starts_with("audio/") && is_better {
                        if let Some(url) = format_obj.get("url").and_then(|u| u.as_str()) {
                            best_audio_url = Some(url.to_string());
                            best_mime_type = Some(
                                mime_str
                                    .split(';')
                                    .next()
                                    .unwrap_or("audio/mp4")
                                    .to_string(),
                            );
                            best_is_mp4 = is_mp4;
                            best_bitrate = bitrate as u32;
                        }
                    }
                }
            }
        }
    }

    let audio_url = best_audio_url.ok_or_else(|| CommandError {
        message: "no suitable audio format found".to_string(),
    })?;
    let mime_type = best_mime_type.unwrap_or_else(|| "audio/mp4".to_string());

    eprintln!(
        "[internal][tauri][debug] Attempting to download audio from URL (first 200 chars): {}",
        audio_url.chars().take(200).collect::<String>()
    );

    let audio_url_parsed = url::Url::parse(&audio_url).map_err(|error| CommandError {
        message: format!("audio URL parse failed: {error}"),
    })?;
    let mut audio_client_builder = reqwest::Client::builder();
    if let Some(local_address) = signed_googlevideo_local_address(&audio_url_parsed) {
        eprintln!(
            "[internal][tauri][info] fetch_youtube_music_audio forcing signed IP family attempt={} family={}",
            attempt_name,
            if local_address.is_ipv6() { "ipv6" } else { "ipv4" }
        );
        audio_client_builder = audio_client_builder.local_address(local_address);
    }
    let audio_client = audio_client_builder.build().map_err(|error| CommandError {
        message: format!("audio HTTP client creation failed: {error}"),
    })?;

    // Download the audio
    let mut audio_request = audio_client
        .get(&audio_url)
        .header("User-Agent", user_agent)
        .header("Accept", "*/*")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Accept-Encoding", "identity;q=1, *;q=0")
        .header("Range", "bytes=0-");

    if let Some(visitor_data) = visitor_data {
        audio_request = audio_request.header("X-Goog-Visitor-Id", visitor_data);
    }

    if !attempt_name.contains("iOS") && !attempt_name.contains("ANDROID") {
        audio_request = audio_request
            .header("Referer", referer)
            .header("Origin", referer.trim_end_matches('/'))
            .header("Sec-Fetch-Dest", "audio")
            .header("Sec-Fetch-Mode", "no-cors")
            .header("Sec-Fetch-Site", "cross-site");
    }

    let audio_response = audio_request.send().await.map_err(|error| CommandError {
        message: format!("download failed: {error}"),
    })?;

    if !audio_response.status().is_success() {
        return Err(CommandError {
            message: format!("download returned {}", audio_response.status()),
        });
    }

    let audio_body = audio_response.bytes().await.map_err(|error| CommandError {
        message: format!("download body read failed: {error}"),
    })?;

    Ok(AudioPayload {
        body_base64: STANDARD.encode(audio_body),
        mime_type,
    })
}

#[tauri::command]
async fn proxy_http_request(
    app: tauri::AppHandle,
    jar: tauri::State<'_, YoutubeCookieJar>,
    mut input: ProxyHttpRequestInput,
) -> Result<ProxyHttpResponse, CommandError> {
    let started_at = Instant::now();
    let request_url = url::Url::parse(&input.url).map_err(|error| CommandError {
        message: format!("invalid URL: {error}"),
    })?;
    let request_target = format!(
        "{}://{}{}",
        request_url.scheme(),
        request_url.host_str().unwrap_or("unknown"),
        request_url.path()
    );
    eprintln!(
        "[internal][tauri][info] proxy_http_request start method={} url={} headers={} has_body={}",
        input.method,
        request_target,
        input.headers.len(),
        input.body_base64.is_some()
    );

    /*
     * Outgoing cookies come from the jar, not from the caller.
     *
     * youtubei.js bakes the cookie into a session when the client is constructed, so a session
     * that has been alive for hours would otherwise keep replaying whatever was current when it
     * was built. Only requests that already carry a Cookie header are stamped: the download
     * client is deliberately anonymous and has to stay that way.
     */
    let youtube_host = is_youtube_cookie_host(&request_url);
    if youtube_host {
        let live_cookie = jar
            .0
            .lock()
            .ok()
            .and_then(|state| state.cookie.clone());
        if let Some(live_cookie) = live_cookie {
            if let Some(key) = input
                .headers
                .keys()
                .find(|key| key.eq_ignore_ascii_case("cookie"))
                .cloned()
            {
                input.headers.insert(key, live_cookie);
            }
        }
    }

    eprintln!("[internal][tauri][debug] proxy_http_request headers:");
    for (key, value) in &input.headers {
        let normalized_key = key.to_ascii_lowercase();
        let safe_value = if normalized_key == "authorization" || normalized_key == "cookie" {
            "[redacted]"
        } else {
            value
        };
        eprintln!("  {}: {}", key, safe_value);
    }
    let method = reqwest::Method::from_bytes(input.method.as_bytes()).map_err(|error| {
        eprintln!(
            "[internal][tauri][error] proxy_http_request invalid method={} error={}",
            input.method, error
        );
        CommandError {
            message: format!("invalid method: {error}"),
        }
    })?;

    let mut client_builder = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36");

    if let Some(timeout_ms) = input.timeout_ms {
        client_builder = client_builder.timeout(Duration::from_millis(timeout_ms));
    }

    if let Some(local_address) = signed_googlevideo_local_address(&request_url) {
        eprintln!(
            "[internal][tauri][info] proxy_http_request forcing signed IP family url={} family={}",
            request_target,
            if local_address.is_ipv6() { "ipv6" } else { "ipv4" }
        );
        client_builder = client_builder.local_address(local_address);
    }

    let client = client_builder.build().map_err(|error| CommandError {
        message: format!("HTTP client creation failed: {error}"),
    })?;
    let mut request = client.request(method, &input.url);

    for (key, value) in &input.headers {
        request = request.header(key, value);
    }

    if let Some(body_base64) = input.body_base64 {
        let bytes = STANDARD.decode(body_base64).map_err(|error| {
            eprintln!(
                "[internal][tauri][error] proxy_http_request body decode failed url={} error={}",
                input.url, error
            );
            CommandError {
                message: format!("invalid body encoding: {error}"),
            }
        })?;
        request = request.body(bytes);
    }

    let response = request.send().await.map_err(|error| {
        eprintln!(
            "[internal][tauri][error] proxy_http_request request failed url={} error={}",
            input.url, error
        );
        CommandError {
            message: format!("request failed: {error}"),
        }
    })?;

    let status = response.status().as_u16();
    let mut headers = HashMap::new();
    for (key, value) in response.headers() {
        if let Ok(value_str) = value.to_str() {
            headers.insert(key.to_string(), value_str.to_string());
        }
    }

    // Read before the map above flattens them: a response sets several cookies at once, and a
    // HashMap keeps only the last.
    let refreshed_cookie = if youtube_host {
        let set_cookies = response
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok().map(str::to_string))
            .collect::<Vec<_>>();
        (!set_cookies.is_empty())
            .then(|| refresh_youtube_cookie_jar(&app, &jar, &set_cookies))
            .flatten()
    } else {
        None
    };

    let body = response.bytes().await.map_err(|error| {
        eprintln!(
            "[internal][tauri][error] proxy_http_request body read failed url={} error={}",
            input.url, error
        );
        CommandError {
            message: format!("read body failed: {error}"),
        }
    })?;

    if request_url.path().ends_with("/browse") && status < 400 {
        if let Ok(json) = serde_json::from_slice::<serde_json::Value>(&body) {
            let top_level_keys = json
                .as_object()
                .map(|object| object.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            let mut renderer_counts = HashMap::new();
            collect_json_renderer_counts(&json, &mut renderer_counts);
            eprintln!(
                "[internal][tauri][debug] proxy_http_request browse_shape top_level_keys={:?} renderer_counts={:?}",
                top_level_keys, renderer_counts
            );
        }
    }

    if status >= 400 {
        eprintln!(
            "[internal][tauri][warn] proxy_http_request error_response method={} url={} status={} bytes={}",
            input.method,
            request_target,
            status,
            body.len()
        );
    }

    eprintln!(
        "[internal][tauri][info] proxy_http_request success method={} url={} status={} bytes={} duration_ms={}",
        input.method,
        request_target,
        status,
        body.len(),
        started_at.elapsed().as_millis()
    );

    Ok(ProxyHttpResponse {
        status,
        headers,
        body_base64: STANDARD.encode(body),
        cookie: refreshed_cookie,
    })
}

#[tauri::command]
fn discord_rpc_update(
    discord_manager: tauri::State<
        '_,
        std::sync::Arc<std::sync::Mutex<discord_rpc::DiscordRpcManager>>,
    >,
    title: String,
    artist: String,
    album: String,
    artwork_url: Option<String>,
    song_url: Option<String>,
    artist_url: Option<String>,
    album_url: Option<String>,
    duration: u64,
    current_time: u64,
    is_playing: bool,
) -> Result<(), CommandError> {
    let data = discord_rpc::DiscordPresenceData {
        title,
        artist,
        album,
        artwork_url,
        song_url,
        artist_url,
        album_url,
        duration,
        current_time,
        is_playing,
    };

    match discord_manager.lock() {
        Ok(manager) => {
            if let Err(e) = manager.update_presence(data) {
                eprintln!("[internal][discord_rpc] failed to update presence: {}", e);
                // Don't return error - Discord might not be running
            }
        }
        Err(e) => {
            eprintln!("[internal][discord_rpc] failed to lock manager: {}", e);
        }
    }
    Ok(())
}

#[tauri::command]
fn discord_rpc_clear(
    discord_manager: tauri::State<
        '_,
        std::sync::Arc<std::sync::Mutex<discord_rpc::DiscordRpcManager>>,
    >,
) -> Result<(), CommandError> {
    match discord_manager.lock() {
        Ok(manager) => {
            if let Err(e) = manager.clear_presence() {
                eprintln!("[internal][discord_rpc] failed to clear presence: {}", e);
            }
        }
        Err(e) => {
            eprintln!("[internal][discord_rpc] failed to lock manager: {}", e);
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize Discord RPC manager
    let discord_manager =
        std::sync::Arc::new(std::sync::Mutex::new(discord_rpc::DiscordRpcManager::new()));

    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[cfg(target_os = "linux")]
    {
        for window in &mut context.config_mut().app.windows {
            if window.label == "main" {
                window.decorations = true;
            }
        }
    }
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .manage(CacheLock(Mutex::new(())))
        .manage(AppSettingsLock(Mutex::new(())))
        .manage(YoutubeCookieJar(Mutex::new(CookieJarState::default())))
        .manage(discord_manager)
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(not(debug_assertions))]
    {
        let port = pick_unused_port().expect("failed to find an unused localhost port");
        let url: url::Url = format!("http://localhost:{}", port)
            .parse()
            .expect("failed to parse localhost url");
        let _window_url = WindowUrl::External(url.clone());

        context.config_mut().build.frontend_dist = Some(FrontendDist::Url(url));
        builder = builder.plugin(tauri_plugin_localhost::Builder::new(port).build());
    }

    #[cfg(target_os = "windows")]
    let builder = builder.manage(windows_media::WindowsMediaSession::new());
    #[cfg(target_os = "macos")]
    let builder = builder.manage(macos_media::MacosMediaSession::new());
    #[cfg(target_os = "linux")]
    let builder = builder.manage(linux_media::LinuxMediaSession::new());

    builder
        .manage(LocalAudioWatcher(Mutex::new(None)))
        .setup(|app| {
            // Before the log is initialised, so a first run after the rename still logs to
            // the directory the user's settings were just restored into.
            migrate_legacy_app_data(app.handle());
            if let Err(error) = initialize_app_log(app.handle()) {
                std::eprintln!("[internal][tauri][warn] {}", error.message);
            }
            // Always built, so toggling the setting takes effect without a restart.
            if let Err(error) = build_tray(app.handle()) {
                std::eprintln!("[internal][tauri][warn] tray unavailable: {error}");
            }
            Ok(())
        })
        .on_window_event(move |window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                eprintln!(
                    "[internal][tauri][info] window close requested label={}",
                    window.label()
                );
                if window.label() == "main" {
                    api.prevent_close();
                    close_or_hide_main_window(window.app_handle());
                }
            }
            tauri::WindowEvent::Focused(false) => {
                if window.label() == "main" {
                    let app = window.app_handle().clone();
                    thread::spawn(move || {
                        thread::sleep(Duration::from_millis(100));

                        let main = app.get_webview_window("main");

                        if let Some(main) = &main {
                            if let Ok(true) = main.is_focused() {
                                return;
                            }
                        }

                        if let Some(mini) = app.get_webview_window("mini-player") {
                            if let Ok(true) = mini.is_focused() {
                                return;
                            }
                        }

                        // Minimising is an unambiguous "put this away" — the frontend shows the
                        // mini player for it even while a recent window drag is suppressing the
                        // ordinary blur signal.
                        let minimized = main
                            .as_ref()
                            .and_then(|main| main.is_minimized().ok())
                            .unwrap_or(false);
                        if minimized {
                            let _ = app.emit("main-window-minimized", ());
                            return;
                        }

                        let _ = app.emit("main-window-backgrounded", ());
                    });
                }
            }
            tauri::WindowEvent::Focused(true) => {
                if window.label() == "main" {
                    let _ = window.app_handle().emit("window-focused", ());
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            quit_app,
            frontend_log,
            app_setting_get,
            app_setting_set,
            app_setting_remove,
            app_settings_clear,
            open_current_log,
            fetch_audio_bytes,
            fetch_audio_source,
            offline_audio_save,
            offline_audio_source,
            offline_audio_has,
            offline_audio_remove,
            offline_audio_list,
            offline_audio_stats,
            offline_audio_prune,
            fetch_youtube_music_audio,
            proxy_http_request,
            load_youtube_music_cookie,
            sign_in_youtube_music,
            refresh_youtube_music_cookie,
            delete_youtube_music_cookie,
            cache_get,
            cache_set,
            cache_stats,
            cache_set_max_bytes,
            cache_clear,
            local_audio_scan,
            local_audio_read,
            read_text_file,
            write_text_file,
            local_audio_read_tags,
            local_audio_write_tags,
            local_audio_watch,
            local_audio_unwatch,
            lastfm::lastfm_auth_token,
            lastfm::lastfm_complete_auth,
            lastfm::lastfm_disconnect,
            lastfm::lastfm_get_session,
            lastfm::lastfm_scrobble,
            lastfm::lastfm_update_now_playing,
            discord_rpc_update,
            discord_rpc_clear,
            #[cfg(target_os = "macos")]
            macos_media::update_macos_media_session,
            #[cfg(target_os = "windows")]
            windows_media::update_windows_media_session,
            #[cfg(target_os = "linux")]
            linux_media::update_linux_media_session
        ])
        .run(context)
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        apply_set_cookie, audio_url_with_range, cookie_domain_matches, is_youtube_cookie_host,
        parse_cookie_header, sanitize_log_url, serialize_cookie_pairs, signed_content_length,
    };

    /// The whole point of the jar: a rotated value replaces the stale one, a new value joins,
    /// an unchanged value reports no change, and a tombstone drops the cookie.
    #[test]
    fn set_cookie_merges_rotations_into_the_stored_session() {
        let mut pairs = parse_cookie_header("SAPISID=keepme; SIDCC=old; YSC=stay");

        assert!(apply_set_cookie(
            &mut pairs,
            "SIDCC=new; expires=Fri, 01 Jan 2027 00:00:00 GMT; path=/; secure",
        ));
        assert!(apply_set_cookie(&mut pairs, "__Secure-3PSIDTS=fresh; path=/"));
        // Same value again is not a rotation, and must not trigger a keyring write.
        assert!(!apply_set_cookie(&mut pairs, "SIDCC=new; path=/"));
        // Order is preserved, so a merged header still reads like the one YouTube issued.
        assert_eq!(
            serialize_cookie_pairs(&pairs),
            "SAPISID=keepme; SIDCC=new; YSC=stay; __Secure-3PSIDTS=fresh"
        );

        assert!(apply_set_cookie(
            &mut pairs,
            "YSC=EXPIRED; expires=Thu, 01 Jan 1970 00:00:00 GMT",
        ));
        assert_eq!(
            serialize_cookie_pairs(&pairs),
            "SAPISID=keepme; SIDCC=new; __Secure-3PSIDTS=fresh"
        );
        // Dropping something already gone is not a change either.
        assert!(!apply_set_cookie(&mut pairs, "YSC=; max-age=0"));
    }

    #[test]
    fn only_youtube_hosts_touch_the_cookie_jar() {
        let youtube = |url: &str| is_youtube_cookie_host(&url::Url::parse(url).unwrap());
        assert!(youtube("https://music.youtube.com/youtubei/v1/browse"));
        assert!(youtube("https://youtube.com/"));
        // A suffix match alone would hand the session to a lookalike domain.
        assert!(!youtube("https://notyoutube.com/"));
        assert!(!youtube("https://rr6.googlevideo.com/videoplayback"));
    }

    #[test]
    fn audio_url_with_range_appends_without_disturbing_the_signature() {
        // The real shape: a query already present, so the range joins it with `&`.
        assert_eq!(
            audio_url_with_range("https://rr6.googlevideo.com/videoplayback?itag=140", 0, 1023),
            "https://rr6.googlevideo.com/videoplayback?itag=140&range=0-1023"
        );
        // A URL with no query at all still has to produce a valid one.
        assert_eq!(
            audio_url_with_range("https://rr6.googlevideo.com/videoplayback", 10, 20),
            "https://rr6.googlevideo.com/videoplayback?range=10-20"
        );
        // Percent-encoded values must survive untouched — re-encoding `==` breaks the signature.
        assert!(audio_url_with_range("https://x/y?xpc=EgVo2aDSNQ%3D%3D", 0, 1)
            .contains("xpc=EgVo2aDSNQ%3D%3D"));
    }

    #[test]
    fn signed_content_length_reads_clen() {
        let url = url::Url::parse("https://rr6.googlevideo.com/videoplayback?itag=140&clen=4844302")
            .expect("test URL parses");
        assert_eq!(signed_content_length(&url), Some(4_844_302));

        let no_clen =
            url::Url::parse("https://rr6.googlevideo.com/videoplayback?itag=140").expect("parses");
        assert_eq!(signed_content_length(&no_clen), None);
    }


    #[test]
    fn sanitize_log_url_withholds_credentials_and_keeps_diagnostics() {
        let sanitized = sanitize_log_url(
            "https://rr6---sn-2uja.googlevideo.com/videoplayback\
             ?expire=1790000000&itag=140&mime=audio%2Fmp4&clen=4844302&c=WEB_REMIX&cver=1.0\
             &ip=203.0.113.7&sig=SECRETSIG&lsig=SECRETLSIG&pot=SECRETPOT&n=SECRETN",
        );

        // Nothing secret survives, checked by value so a future allowlist edit that admits one
        // of these fails here rather than in production.
        for secret in ["SECRETSIG", "SECRETLSIG", "SECRETPOT", "SECRETN", "203.0.113.7"] {
            assert!(!sanitized.contains(secret), "leaked {secret} in {sanitized}");
        }

        // ...and the parameters that explain a 403 are still readable.
        for kept in ["expire=1790000000", "itag=140", "c=WEB_REMIX", "cver=1.0", "clen=4844302"] {
            assert!(sanitized.contains(kept), "dropped {kept} from {sanitized}");
        }

        // Withheld values report their length, which is how a present-but-truncated signature is
        // told apart from a missing one.
        assert!(sanitized.contains("sig=[9ch]"), "{sanitized}");
        assert!(sanitized.contains("https://rr6---sn-2uja.googlevideo.com/videoplayback?"));
    }

    #[test]
    fn sanitize_log_url_rejects_unparseable_input() {
        assert_eq!(sanitize_log_url("not a url"), "[redacted-url]");
    }

    #[test]
    fn cookie_domain_matches_exact_and_parent_domains() {
        assert!(cookie_domain_matches(
            "music.youtube.com",
            Some("music.youtube.com")
        ));
        assert!(cookie_domain_matches(
            "music.youtube.com",
            Some(".youtube.com")
        ));
        assert!(cookie_domain_matches(
            "music.youtube.com",
            Some("youtube.com")
        ));
    }

    #[test]
    fn cookie_domain_rejects_unrelated_and_partial_domains() {
        assert!(!cookie_domain_matches(
            "music.youtube.com",
            Some("accounts.google.com")
        ));
        assert!(!cookie_domain_matches(
            "music.youtube.com",
            Some("notyoutube.com")
        ));
        assert!(!cookie_domain_matches("music.youtube.com", None));
    }
}
