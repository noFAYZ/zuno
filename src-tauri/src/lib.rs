// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, TcpListener};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
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
// Unconditional: OsRng also backs generate_slot_id, used on every platform for account slot
// ids, not just the macOS-only encryption key it originally served.
use rand::{rngs::OsRng, RngCore};

#[cfg(target_os = "macos")]
mod macos_media;
#[cfg(target_os = "windows")]
mod windows_media;
#[cfg(target_os = "linux")]
mod linux_media;

mod audio;
mod process_memory;
mod discord_rpc;
mod equalizer;
mod opus_source;
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
/// Slot id for the one account that existed before multi-account support.
///
/// Pinned rather than randomly generated so migrating an existing install keeps using the
/// *exact* original shared webview partition (`YOUTUBE_LOGIN_DATA_DIR` /
/// `YOUTUBE_LOGIN_DATA_STORE_ID`, unsuffixed) instead of a fresh, empty one — see
/// `login_partition_directory_name`. A fresh partition has no warm Google browser session in
/// it, which would have made silent refresh less reliable for every existing user on the very
/// next launch after this shipped.
const LEGACY_ACCOUNT_SLOT_ID: &str = "legacy-primary-account";
#[cfg(target_os = "macos")]
const YOUTUBE_COOKIE_ENCRYPTION_KEY_USER: &str = "youtube-music-cookie-encryption-key-v1";
#[cfg(target_os = "macos")]
const YOUTUBE_COOKIE_ENCRYPTED_FILE: &str = "youtube-music-session-v1.bin";
#[cfg(windows)]
const YOUTUBE_COOKIE_DPAPI_FILE: &str = "youtube-music-session-v1.dpapi";
const YOUTUBE_LOGIN_WINDOW: &str = "youtube-music-login";
/// The sign-in window holds two webviews: a read-only address bar on top and Google below.
const YOUTUBE_LOGIN_ADDRESS_BAR: &str = "youtube-music-login-address";
const YOUTUBE_LOGIN_PAGE: &str = "youtube-music-login-page";
const YOUTUBE_LOGIN_ADDRESS_BAR_HEIGHT: f64 = 36.0;
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
#[cfg(target_os = "macos")]
const MACOS_LOGIN_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";
const YOUTUBE_COOKIE_CHUNK_SIZE: usize = 900;
/// Bytes: `YOUTUBE_COOKIE_CHUNK_SIZE * YOUTUBE_COOKIE_MAX_CHUNKS` ~= 57.6 KB.
///
/// One account's cookie header used to be the whole stored blob; it is now one entry in a JSON
/// array of them, so the ceiling went up from a single session (~14.4 KB of headroom) to
/// comfortably cover several. Nobody is juggling dozens of Google accounts in a desktop music
/// app — this is generous, not unlimited.
const YOUTUBE_COOKIE_MAX_CHUNKS: usize = 64;
/// How often a rotation of `YOUTUBE_SLOW_PERSIST_COOKIES` is written back to secure storage.
///
/// Not on every response: Google rotates SIDCC on almost all of them, and the Windows
/// credential store takes sixteen writes per save. Every *other* rotation is written at once —
/// see `YOUTUBE_SLOW_PERSIST_COOKIES` for why that distinction is the whole game.
const YOUTUBE_COOKIE_PERSIST_INTERVAL: Duration = Duration::from_secs(300);
/// Cookies whose rotation may be persisted late, because nothing authenticates with them.
///
/// Everything else — `__Secure-*PSIDTS` above all — is written the moment it changes. Google
/// retires the superseded value, so quitting inside the throttle window left a dead credential
/// on disk and the next launch presented it: the session looked lost overnight when it was only
/// lost between the last rotation and the last write.
const YOUTUBE_SLOW_PERSIST_COOKIES: [&str; 3] = ["SIDCC", "__Secure-1PSIDCC", "__Secure-3PSIDCC"];
/// Seconds a silent renewal may spend before giving up and asking the user.
///
/// Generous enough for a cold WebView2 start plus the Google redirect chain, because the cost of
/// being a second too impatient is a sign-in prompt the user did not need.
const YOUTUBE_SILENT_REFRESH_POLLS: u32 = 25;
const DEFAULT_CACHE_MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const CURRENT_LOG_FILE_NAME: &str = "current.log";

const PREVIOUS_LOG_FILE_NAME: &str = "previous.log";
/// A days-long session in the tray must not grow the log without bound.
const MAX_LOG_BYTES: u64 = 32 * 1024 * 1024;

static APP_LOG_FILE: OnceLock<Mutex<Option<(File, u64)>>> = OnceLock::new();

/// Guards the cache directory and carries its running byte total once known.
struct CacheLock(Mutex<Option<u64>>);
/// Serializes every read-modify-write of the YouTube account store — sign-in, silent refresh,
/// switch, remove, and the ambient cookie-rotation persist inside `proxy_http_request` all go
/// through it. Without this, two of those racing (e.g. a rotation persisting at the same moment
/// a different window removes an account) could interleave: both read the same base, and
/// whichever writes last silently undoes the other's change — an account switch reverting, or a
/// removed account coming back.
struct AccountStoreLock(Mutex<()>);

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

/// The leading `name=value` of a `Set-Cookie` value.
///
/// The attributes after it describe where a browser should send the cookie, and this jar has
/// exactly one destination.
fn split_set_cookie(set_cookie: &str) -> Option<(&str, &str)> {
    let (name, value) = set_cookie.split(';').next()?.split_once('=')?;
    let name = name.trim();
    if name.is_empty() {
        return None;
    }
    Some((name, value.trim()))
}

/// Folds one `Set-Cookie` value into the jar, reporting whether anything changed.
fn apply_set_cookie(pairs: &mut Vec<(String, String)>, set_cookie: &str) -> bool {
    let Some((name, value)) = split_set_cookie(set_cookie) else {
        return false;
    };
    let name = name.to_string();
    let value = value.to_string();

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

/// Joins an error with its full `.source()` chain, so a wrapper like reqwest's "error sending
/// request for url" comes with the DNS/TLS/connection failure underneath it instead of hiding it.
fn error_cause_chain(error: &dyn std::error::Error) -> String {
    let mut parts = vec![error.to_string()];
    let mut source = error.source();
    while let Some(cause) = source {
        parts.push(cause.to_string());
        source = cause.source();
    }
    parts.join(" -> caused by: ")
}

fn is_youtube_cookie_host(url: &url::Url) -> bool {
    // HTTPS only: the jar holds Secure cookies, which must never travel in plaintext.
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| host == "youtube.com" || host.ends_with(".youtube.com"))
}

/// Whether this rotation may wait for `YOUTUBE_COOKIE_PERSIST_INTERVAL` before being stored.
fn is_slow_persist_cookie(set_cookie: &str) -> bool {
    split_set_cookie(set_cookie)
        .is_some_and(|(name, _)| YOUTUBE_SLOW_PERSIST_COOKIES.contains(&name))
}

/// Which Google account a cookie header belongs to, as far as the app needs to care.
///
/// Used for one question: did signing in again land on the same account? A re-mint of a lapsed
/// session keeps this value, so answering "same" is what lets a renewal keep the cached library
/// and the chosen channel instead of resyncing from scratch. It is a fingerprint, never logged
/// and never handed to the frontend — only the boolean answer is.
fn cookie_account_identity(cookie: &str) -> Option<String> {
    let pairs = parse_cookie_header(cookie);
    ["SAPISID", "__Secure-3PAPISID", "__Secure-1PAPISID"]
        .iter()
        .find_map(|name| {
            pairs
                .iter()
                .find(|(existing, value)| existing == name && !value.is_empty())
                .map(|(_, value)| value.clone())
        })
}

fn generate_slot_id() -> String {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unix_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// One signed-in Google account's durable session.
///
/// `identity` is the same fingerprint `cookie_account_identity` documents: never serialized to
/// the frontend (see the `YoutubeAccountSummary` DTO, which omits it entirely), kept only so a
/// re-authentication of an already-stored account can be recognized as a refresh rather than a
/// new slot.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct StoredYoutubeAccount {
    slot_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    identity: Option<String>,
    cookie: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    avatar_url: Option<String>,
    added_at_ms: u64,
}

/// Every Google account with a stored session, and which one is active.
///
/// This is the one blob persisted through the existing `save_youtube_music_cookie` /
/// `read_stored_youtube_music_cookie` transport — macOS's AES-GCM-encrypted file (orphan
/// recovery included) or the chunked OS-keyring entries elsewhere — unchanged underneath. Only
/// what gets encrypted changed, from a bare cookie header to this struct's JSON.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct YoutubeAccountStore {
    #[serde(skip_serializing_if = "Option::is_none")]
    active_slot_id: Option<String>,
    accounts: Vec<StoredYoutubeAccount>,
}

impl YoutubeAccountStore {
    /// A bare cookie header from before multi-account support, as the one stored account.
    fn from_legacy_cookie(cookie: &str, slot_id: String) -> Self {
        YoutubeAccountStore {
            active_slot_id: Some(slot_id.clone()),
            accounts: vec![StoredYoutubeAccount {
                slot_id,
                identity: cookie_account_identity(cookie),
                cookie: cookie.to_string(),
                display_name: None,
                avatar_url: None,
                added_at_ms: unix_millis(),
            }],
        }
    }

    /// The active account, self-healing to the first stored one if the recorded active slot id
    /// does not (or no longer) match anything — corrupt state should degrade to "signed in as
    /// *someone*" rather than "signed out" when there is clearly at least one stored session.
    fn active(&self) -> Option<&StoredYoutubeAccount> {
        self.active_slot_id
            .as_deref()
            .and_then(|id| self.find(id))
            .or_else(|| self.accounts.first())
    }

    fn find(&self, slot_id: &str) -> Option<&StoredYoutubeAccount> {
        self.accounts.iter().find(|account| account.slot_id == slot_id)
    }

    fn find_by_identity(&self, identity: &str) -> Option<&StoredYoutubeAccount> {
        self.accounts.iter().find(|account| account.identity.as_deref() == Some(identity))
    }

    /// Interactive sign-in landed on `cookie`. Refreshes the matching stored account in place
    /// when this identity is already known — so re-authenticating an account you already have
    /// never creates a duplicate slot — otherwise stores it fresh under `candidate_slot_id`.
    /// Either way the result is active afterward.
    ///
    /// Returns the slot id that ended up holding this cookie (the caller's candidate, or the
    /// existing one it matched) and whether that differs from whatever was active before —
    /// the signal for whether this is a new account instead of a lapsed-session renewal.
    fn upsert_signed_in_account(&mut self, cookie: &str, candidate_slot_id: String) -> (String, bool) {
        let previously_active = self.active_slot_id.clone();
        let identity = cookie_account_identity(cookie);
        let matched_slot_id = identity
            .as_deref()
            .and_then(|identity| self.find_by_identity(identity))
            .map(|account| account.slot_id.clone());

        let slot_id = match matched_slot_id {
            Some(existing_slot_id) => {
                if let Some(account) =
                    self.accounts.iter_mut().find(|account| account.slot_id == existing_slot_id)
                {
                    account.cookie = cookie.to_string();
                }
                existing_slot_id
            }
            None => {
                self.accounts.push(StoredYoutubeAccount {
                    slot_id: candidate_slot_id.clone(),
                    identity,
                    cookie: cookie.to_string(),
                    display_name: None,
                    avatar_url: None,
                    added_at_ms: unix_millis(),
                });
                candidate_slot_id
            }
        };
        self.active_slot_id = Some(slot_id.clone());
        let account_changed = previously_active.as_deref() != Some(slot_id.as_str());
        (slot_id, account_changed)
    }

    /// Removes one stored account. When it was the active one, another stored account (if any)
    /// becomes active in its place — the whole point being that losing one account should not
    /// force the others out too. Returns the newly active cookie, if any, and whether a slot
    /// actually existed to remove.
    fn remove(&mut self, slot_id: &str) -> (Option<String>, bool) {
        let existed = self.accounts.iter().any(|account| account.slot_id == slot_id);
        self.accounts.retain(|account| account.slot_id != slot_id);
        if self.active_slot_id.as_deref() == Some(slot_id) {
            self.active_slot_id = self.accounts.first().map(|account| account.slot_id.clone());
        }
        (self.active().map(|account| account.cookie.clone()), existed)
    }

    /// Makes a stored account active, e.g. for a switch that does not need the browser at all.
    /// `None` means it is not (or no longer) stored — removed from another window, perhaps.
    fn switch_active(&mut self, slot_id: &str) -> Option<String> {
        let cookie = self.find(slot_id)?.cookie.clone();
        self.active_slot_id = Some(slot_id.to_string());
        Some(cookie)
    }
}

/// Merges rotated cookies into the jar, returning the new header when it changed.
fn refresh_youtube_cookie_jar(
    app: &tauri::AppHandle,
    jar: &YoutubeCookieJar,
    account_lock: &AccountStoreLock,
    set_cookies: &[String],
) -> Option<String> {
    let (merged, should_persist) = {
        let mut state = jar.0.lock().ok()?;
        // No stored session means an anonymous request; it has no jar to update.
        let mut pairs = parse_cookie_header(state.cookie.as_deref()?);
        // Every cookie is applied; `any` would stop at the first change and drop the rest.
        let mut changed = false;
        let mut credential_changed = false;
        for set_cookie in set_cookies {
            if apply_set_cookie(&mut pairs, set_cookie) {
                changed = true;
                credential_changed |= !is_slow_persist_cookie(set_cookie);
            }
        }
        if !changed {
            return None;
        }

        let merged = serialize_cookie_pairs(&pairs);
        state.cookie = Some(merged.clone());
        // A rotated credential is written now; only the noisy ones wait for the interval.
        let should_persist = credential_changed
            || state
                .persisted_at
                .is_none_or(|at| at.elapsed() >= YOUTUBE_COOKIE_PERSIST_INTERVAL);
        if should_persist {
            state.persisted_at = Some(Instant::now());
        }
        (merged, should_persist)
    };

    // Outside the guard: the keyring write is slow and every other request wants the jar. The
    // jar itself is already updated above; this only needs to reach the durable store, so it
    // goes through the plain (non-jar-touching) persist rather than `persist_active_account_cookie`.
    if should_persist {
        let active_slot_id = match load_account_store(app) {
            Ok(store) => store.active_slot_id,
            Err(error) => {
                eprintln!(
                    "[internal][tauri][warn] youtube cookie persist skipped, account store unreadable: {}",
                    error.message
                );
                None
            }
        };
        // No active slot (e.g. mid-removal in another window): the live jar still serves this session.
        if let Some(slot_id) = active_slot_id {
            match persist_account_cookie(app, account_lock, &slot_id, &merged) {
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
    artist: Option<String>,
    album: Option<String>,
    duration_sec: Option<u64>,
    /// Whether the file carries embedded cover art, so the UI knows to ask for it.
    has_artwork: bool,
}

/// Embedded cover art. Base64 because a `Vec<u8>` crosses Tauri's IPC as a JSON number array.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalArtwork {
    mime_type: String,
    data_base64: String,
}

fn cache_error(message: impl Into<String>) -> CommandError {
    CommandError {
        message: message.into(),
    }
}

/// Pooled clients (keep-alive, TLS resumption), one per local address family: default, IPv4, IPv6.
static HTTP_CLIENTS: LazyLock<[reqwest::Client; 3]> = LazyLock::new(|| {
    // OS trust store; bundled roots alone reject TLS-inspecting proxies/AV (#143). One cert
    // rustls rejects would fail every build, hence the filter.
    let roots: Vec<_> = rustls_native_certs::load_native_certs()
        .certs
        .into_iter()
        .filter(|cert| rustls::RootCertStore::empty().add(cert.clone()).is_ok())
        .filter_map(|cert| reqwest::Certificate::from_der(&cert).ok())
        .collect();
    [None, Some(IpAddr::V4(Ipv4Addr::UNSPECIFIED)), Some(IpAddr::V6(Ipv6Addr::UNSPECIFIED))].map(
        |local| {
            roots
                .iter()
                .cloned()
                .fold(reqwest::Client::builder(), reqwest::ClientBuilder::add_root_certificate)
                .local_address(local)
                .connect_timeout(Duration::from_secs(15))
                .read_timeout(Duration::from_secs(30))
                .build()
                .expect("HTTP client must build with the OS trust store")
        },
    )
});

/// The shared client, bound to `family` when a signed googlevideo URL requires one.
pub(crate) fn http_client(family: Option<IpAddr>) -> &'static reqwest::Client {
    &HTTP_CLIENTS[match family {
        None => 0,
        Some(IpAddr::V4(_)) => 1,
        Some(IpAddr::V6(_)) => 2,
    }]
}

/// localStorage is keyed by origin, port included: a new port every launch silently wipes it.
/// The fixed port keeps the origin stable; a random one is only the fallback when it is taken.
#[cfg(not(debug_assertions))]
fn ui_port() -> u16 {
    const PREFERRED_UI_PORT: u16 = 47_731;
    [PREFERRED_UI_PORT, 0]
        .into_iter()
        .find_map(|port| TcpListener::bind(("127.0.0.1", port)).ok()?.local_addr().ok())
        .map(|address| address.port())
        .inspect(|port| {
            if *port != PREFERRED_UI_PORT {
                eprintln!("[internal][tauri][warn] UI port {PREFERRED_UI_PORT} busy, using {port}; local storage starts empty");
            }
        })
        .expect("no loopback port available for the UI")
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

/**
 * One scanned file, described by its tags.
 *
 * The filename and the parent folder are the fallback, not the answer. The scan used to stop
 * there — every local track came back titled after its file, attributed to nothing, with no
 * duration and no art, because the tag reader existed only behind the tag editor.
 *
 * A tag read per file makes the scan slower than a `read_dir`; that is the cost of the metadata
 * being right, and it is paid once per page load rather than per play.
 */
fn local_audio_entry(path: &Path) -> LocalAudioFile {
    use lofty::file::{AudioFile, TaggedFileExt};
    use lofty::tag::Accessor;

    let mut entry = LocalAudioFile {
        path: path.to_string_lossy().to_string(),
        title: local_audio_title(path),
        artist: None,
        album: path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .map(|name| name.to_string()),
        duration_sec: None,
        has_artwork: false,
    };

    // An unreadable or untagged file keeps the filesystem fallback rather than disappearing.
    let Ok(tagged) = lofty::read_from_path(path) else {
        return entry;
    };

    let duration = tagged.properties().duration().as_secs();
    if duration > 0 {
        entry.duration_sec = Some(duration);
    }

    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return entry;
    };

    let text = |value: Option<std::borrow::Cow<'_, str>>| {
        value
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };

    if let Some(title) = text(tag.title()) {
        entry.title = title;
    }
    entry.artist = text(tag.artist());
    if let Some(album) = text(tag.album()) {
        entry.album = Some(album);
    }
    entry.has_artwork = !tag.pictures().is_empty();

    entry
}

/**
 * Reads an image the user picked, for the tag editor to preview and then embed.
 *
 * The magic-byte check is the point: a file picker filter is a suggestion, and lofty will
 * happily embed whatever bytes it is handed under whatever mime type it is told — which
 * produces a file every other player renders as a broken cover.
 */
#[tauri::command(async)]
fn read_image_file(path: String) -> Result<LocalArtwork, CommandError> {
    use base64::Engine;

    let path = PathBuf::from(path);
    let data = fs::read(&path).map_err(|error| cache_error(format!("image read failed: {error}")))?;
    if data.len() > MAX_ARTWORK_BYTES {
        return Err(cache_error("that image is too large to embed"));
    }

    let Some(mime_type) = sniff_image_mime(&data) else {
        return Err(cache_error("that file is not a PNG, JPEG, GIF, BMP or WebP image"));
    };

    Ok(LocalArtwork {
        mime_type: mime_type.to_string(),
        data_base64: base64::engine::general_purpose::STANDARD.encode(&data),
    })
}

fn sniff_image_mime(data: &[u8]) -> Option<&'static str> {
    match data {
        [0xff, 0xd8, 0xff, ..] => Some("image/jpeg"),
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        [b'B', b'M', ..] => Some("image/bmp"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        _ => None,
    }
}

/// The first embedded picture, for the one file the UI is about to show.
#[tauri::command(async)]
fn local_audio_artwork(path: String) -> Result<Option<LocalArtwork>, CommandError> {
    use base64::Engine;
    use lofty::file::TaggedFileExt;

    let path = PathBuf::from(path);
    if !path.is_file() || !is_local_audio_file(&path) {
        return Err(cache_error("local audio file is unavailable."));
    }

    let tagged = lofty::read_from_path(&path)
        .map_err(|error| cache_error(format!("tag read failed: {error}")))?;
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return Ok(None);
    };
    let Some(picture) = tag.pictures().first() else {
        return Ok(None);
    };

    Ok(Some(LocalArtwork {
        mime_type: picture
            .mime_type()
            .map(|mime| mime.to_string())
            .unwrap_or_else(|| "image/jpeg".to_string()),
        data_base64: base64::engine::general_purpose::STANDARD.encode(picture.data()),
    }))
}

fn scan_local_audio_path(path: &Path, files: &mut Vec<LocalAudioFile>) -> Result<(), CommandError> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return Ok(()),
    };

    if metadata.is_file() {
        if is_local_audio_file(path) {
            files.push(local_audio_entry(path));
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

#[tauri::command(async)]
fn local_audio_scan(paths: Vec<String>) -> Result<Vec<LocalAudioFile>, CommandError> {
    let mut files = Vec::new();
    for path in paths {
        let trimmed_path = path.trim();
        if trimmed_path.is_empty() {
            continue;
        }
        scan_local_audio_path(Path::new(trimmed_path), &mut files)?;
    }
    files.sort_by_cached_key(|file| file.path.to_lowercase());
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
    /// Write-only: absent means leave the existing cover alone. See `ArtworkEdit`.
    #[serde(default, skip_serializing)]
    artwork: Option<ArtworkEdit>,
}

/**
 * What to do with the file's cover on save.
 *
 * Three states, not two. A plain `Option<Picture>` could only say "set this" or "remove it",
 * so every save from a dialog the user never touched the artwork in would rewrite or delete a
 * cover they meant to keep.
 */
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
enum ArtworkEdit {
    Keep,
    Remove,
    Replace {
        mime_type: String,
        data_base64: String,
    },
}

/// Cover art is embedded in the file, so an unreasonable one bloats every copy of the song.
const MAX_ARTWORK_BYTES: usize = 12 * 1024 * 1024;

#[derive(Deserialize)]
struct TextFileFormat {
    name: String,
    extensions: Vec<String>,
    contents: String,
}

#[derive(Serialize)]
struct SavedTextFile {
    path: String,
    /// Index into the formats offered, picked by the extension the user chose.
    format: usize,
}

/// Save dialog and write in one step, so the renderer never names a path to write to.
#[tauri::command]
async fn export_text_file(
    app: tauri::AppHandle,
    title: String,
    file_name: String,
    formats: Vec<TextFileFormat>,
) -> Result<Option<SavedTextFile>, CommandError> {
    use tauri_plugin_dialog::DialogExt;
    let mut dialog = app.dialog().file().set_title(title).set_file_name(file_name);
    for format in &formats {
        let extensions: Vec<&str> = format.extensions.iter().map(String::as_str).collect();
        dialog = dialog.add_filter(&format.name, &extensions);
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    dialog.save_file(move |path| {
        let _ = sender.send(path);
    });
    let Some(path) = receiver.await.ok().flatten().and_then(|path| path.into_path().ok()) else {
        return Ok(None);
    };
    let extension = path.extension().and_then(|extension| extension.to_str()).unwrap_or_default();
    let format = formats
        .iter()
        .position(|format| format.extensions.iter().any(|candidate| candidate.eq_ignore_ascii_case(extension)))
        .unwrap_or(0);
    let contents = formats.get(format).map_or("", |format| format.contents.as_str());
    fs::write(&path, contents).map_err(|error| cache_error(format!("file write failed: {error}")))?;
    Ok(Some(SavedTextFile { path: path.display().to_string(), format }))
}

#[derive(Serialize)]
struct OpenedTextFile {
    path: String,
    contents: String,
}

/// Open dialog and read in one step, size-capped: the user can pick any file at all.
#[tauri::command]
async fn import_text_file(
    app: tauri::AppHandle,
    title: String,
    filter_name: String,
    extensions: Vec<String>,
) -> Result<Option<OpenedTextFile>, CommandError> {
    use tauri_plugin_dialog::DialogExt;
    const MAX_IMPORT_BYTES: u64 = 16 * 1024 * 1024;
    let extensions: Vec<&str> = extensions.iter().map(String::as_str).collect();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_title(title)
        .add_filter(filter_name, &extensions)
        .pick_file(move |path| {
            let _ = sender.send(path);
        });
    let Some(path) = receiver.await.ok().flatten().and_then(|path| path.into_path().ok()) else {
        return Ok(None);
    };
    if fs::metadata(&path).map_err(|error| cache_error(format!("file read failed: {error}")))?.len() > MAX_IMPORT_BYTES {
        return Err(cache_error("that file is too large to be a playlist"));
    }
    let contents = fs::read_to_string(&path).map_err(|error| cache_error(format!("file read failed: {error}")))?;
    Ok(Some(OpenedTextFile { path: path.display().to_string(), contents }))
}

/// Real tags from the file: the scanner's filename guesses must not be saved back as truth.
#[tauri::command(async)]
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
        artwork: None,
    })
}

#[tauri::command(async)]
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
                tag.remove_key(key);
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
            tag.remove_key(ItemKey::Year);
        }
    }

    match tags.artwork {
        None | Some(ArtworkEdit::Keep) => {}
        Some(ArtworkEdit::Remove) => {
            // Every picture, not just the front cover: leaving a stray back-cover or artist
            // shot behind is what makes a "removed" cover reappear somewhere else.
            while !tag.pictures().is_empty() {
                let _ = tag.remove_picture(0);
            }
        }
        Some(ArtworkEdit::Replace {
            mime_type,
            data_base64,
        }) => {
            use base64::Engine;
            use lofty::picture::{MimeType, Picture, PictureType};

            let data = base64::engine::general_purpose::STANDARD
                .decode(data_base64.as_bytes())
                .map_err(|error| cache_error(format!("artwork decode failed: {error}")))?;
            if data.is_empty() {
                return Err(cache_error("that image is empty"));
            }
            if data.len() > MAX_ARTWORK_BYTES {
                return Err(cache_error("that image is too large to embed"));
            }

            while !tag.pictures().is_empty() {
                let _ = tag.remove_picture(0);
            }
            tag.push_picture(
                Picture::unchecked(data)
                    .pic_type(PictureType::CoverFront)
                    .mime_type(MimeType::from_str(&mime_type))
                    .build(),
            );
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
#[tauri::command(async)]
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

#[tauri::command(async)]
fn local_audio_read(path: String) -> Result<tauri::ipc::Response, CommandError> {
    let path = PathBuf::from(path);
    if !path.is_file() || !is_local_audio_file(&path) {
        return Err(cache_error("local audio file is unavailable."));
    }
    let bytes = fs::read(&path).map_err(|error| cache_error(format!("local audio read failed: {error}")))?;
    framed_response(&serde_json::json!({ "mimeType": local_audio_mime_type(&path) }), &bytes)
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

/// Renames `temp` over `path`; the old file stays until the new one lands (#155). Retried because a
/// Windows scanner or the indexer often holds a just-written file for a moment.
fn replace_file(temp: &Path, path: &Path) -> std::io::Result<()> {
    let mut attempts = 0;
    loop {
        match fs::rename(temp, path) {
            Err(_) if attempts < 10 => {
                attempts += 1;
                thread::sleep(Duration::from_millis(50));
            }
            result => return result,
        }
    }
}

fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), CommandError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| cache_error(format!("directory creation failed: {error}")))?;
    }
    let bytes = serde_json::to_vec(value).map_err(|error| cache_error(format!("serialization failed: {error}")))?;
    let temp_path = path.with_extension("tmp");
    fs::write(&temp_path, bytes).map_err(|error| cache_error(format!("write failed: {error}")))?;
    replace_file(&temp_path, path).map_err(|error| cache_error(format!("finalize failed: {error}")))
}

fn app_settings_path(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    app.path()
        .app_data_dir()
        .map(|path| path.join(APP_SETTINGS_FILE_NAME))
        .map_err(|error| CommandError {
            message: format!("application settings directory unavailable: {error}"),
        })
}

type SettingsMap = HashMap<String, serde_json::Value>;

/// Durable settings, read from disk once and then served from memory.
#[derive(Default)]
struct AppSettings(Mutex<Option<SettingsMap>>);

/// The settings file, falling back to `.bak` when it is missing, empty or corrupt.
fn load_settings_file(path: &Path) -> SettingsMap {
    for candidate in [path.to_path_buf(), path.with_extension("bak")] {
        let Ok(bytes) = fs::read(&candidate) else { continue };
        if bytes.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        match serde_json::from_slice(&bytes) {
            Ok(settings) => return settings,
            Err(error) => eprintln!(
                "[internal][tauri][error] settings unreadable path={} error={error}",
                candidate.display()
            ),
        }
    }
    SettingsMap::new()
}

/// fsync, keep the previous file as `.bak`, then rename into place: a crash at any point
/// leaves either the new file or the last good one.
fn write_settings_file(path: &Path, settings: &SettingsMap) -> Result<(), CommandError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| cache_error(format!("directory creation failed: {error}")))?;
    }
    let temp_path = path.with_extension("tmp");
    let write = || -> std::io::Result<()> {
        let mut file = File::create(&temp_path)?;
        serde_json::to_writer(&mut file, settings)?;
        file.sync_all()
    };
    write().map_err(|error| cache_error(format!("settings write failed: {error}")))?;
    // Copied, not moved, so the live file is never missing if the replace fails.
    let _ = fs::copy(path, path.with_extension("bak"));
    replace_file(&temp_path, path).map_err(|error| cache_error(format!("settings finalize failed: {error}")))
}

/// Runs `f` on the in-memory settings; returning `true` alongside the result persists them.
fn with_settings<T>(
    app: &tauri::AppHandle,
    f: impl FnOnce(&mut SettingsMap) -> (T, bool),
) -> Result<T, CommandError> {
    let state = app.state::<AppSettings>();
    let mut guard = state.0.lock().map_err(|_| cache_error("application settings lock unavailable"))?;
    let path = app_settings_path(app)?;
    let settings = guard.get_or_insert_with(|| load_settings_file(&path));
    let (result, dirty) = f(settings);
    if dirty {
        write_settings_file(&path, settings)?;
    }
    Ok(result)
}

fn read_app_setting(app: &tauri::AppHandle, key: &str) -> Option<serde_json::Value> {
    with_settings(app, |settings| (settings.get(key).cloned(), false)).ok().flatten()
}

#[tauri::command(async)]
fn app_setting_get(app: tauri::AppHandle, key: String) -> Option<serde_json::Value> {
    read_app_setting(&app, &key)
}

#[tauri::command(async)]
fn app_setting_set(app: tauri::AppHandle, key: String, value: serde_json::Value) -> Result<(), CommandError> {
    if key == MINIMIZE_TO_TRAY_SETTING {
        set_tray_visible(&app, value.as_bool().unwrap_or(false));
    }
    with_settings(&app, |settings| {
        let changed = settings.get(&key) != Some(&value);
        settings.insert(key, value);
        ((), changed)
    })
}

#[tauri::command(async)]
fn app_setting_remove(app: tauri::AppHandle, key: String) -> Result<(), CommandError> {
    with_settings(&app, |settings| ((), settings.remove(&key).is_some()))
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

    // The last session's log survives one relaunch: that is the one a crash report needs.
    let _ = fs::rename(&log_path, log_path.with_file_name(PREVIOUS_LOG_FILE_NAME));

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
        *guard = Some((file, 0));
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
    let Some((file, written)) = guard.as_mut() else {
        return;
    };
    if *written >= MAX_LOG_BYTES {
        return;
    }
    let line = format!("{args}\n");
    *written += line.len() as u64;
    let _ = file.write_all(line.as_bytes());
    if *written >= MAX_LOG_BYTES {
        let _ = file.write_all(b"[internal][tauri][warn] log size cap reached; further lines dropped\n");
    }
}

/// Panics go to the log as well as stderr: a release build on Windows has no console.
fn install_panic_logger() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        append_log_line(format_args!("[internal][tauri][error] panic: {info}"));
        default_hook(info);
    }));
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

#[tauri::command(async)]
fn open_current_log(app: tauri::AppHandle) -> Result<(), CommandError> {
    let log_path = current_log_path(&app)?;
    if !log_path.exists() {
        initialize_app_log(&app)?;
    }
    tauri_plugin_opener::open_path(&log_path, None::<&str>).map_err(|error| CommandError {
        message: format!("unable to open log file: {error}"),
    })
}

#[tauri::command(async)]
fn app_settings_clear(app: tauri::AppHandle) -> Result<(), CommandError> {
    with_settings(&app, |settings| {
        let had_any = !settings.is_empty();
        settings.clear();
        ((), had_any)
    })
}

fn read_cache_max_bytes(app: &tauri::AppHandle) -> u64 {
    cache_settings_path(app)
        .ok()
        .and_then(|path| fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<CacheSettings>(&bytes).ok())
        .map_or(DEFAULT_CACHE_MAX_BYTES, |settings| settings.max_bytes)
}

/// `(modified, size, path)` per entry. `cache_get` touches mtime, so oldest = least recently used.
fn cache_files(directory: &Path) -> Vec<(SystemTime, u64, PathBuf)> {
    let Ok(entries) = fs::read_dir(directory) else { return Vec::new() };
    entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let path = entry.path();
            if path.extension()? != "json" {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            Some((metadata.modified().ok()?, metadata.len(), path))
        })
        .collect()
}

fn calculate_cache_stats(app: &tauri::AppHandle) -> Result<CacheStats, CommandError> {
    let files = cache_files(&cache_entries_dir(app)?);
    Ok(CacheStats {
        max_bytes: read_cache_max_bytes(app),
        used_bytes: files.iter().map(|(_, size, _)| size).sum(),
        entry_count: files.len(),
    })
}

/// Evicts least-recently-used entries down to 90% of the cap, from metadata alone; returns the
/// bytes left. The headroom stops a cache sitting at its cap from evicting on every write.
fn enforce_cache_limit(directory: &Path, max_bytes: u64) -> u64 {
    let mut entries = cache_files(directory);
    let mut used_bytes = entries.iter().map(|(_, size, _)| size).sum::<u64>();
    if used_bytes <= max_bytes {
        return used_bytes;
    }
    entries.sort_unstable_by_key(|(modified, _, _)| *modified);
    for (_, size, path) in entries {
        if used_bytes <= max_bytes / 10 * 9 {
            break;
        }
        if fs::remove_file(path).is_ok() {
            used_bytes -= size;
        }
    }
    used_bytes
}

fn read_cache_entry(path: &Path) -> Option<CacheEntry> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

#[tauri::command(async)]
fn cache_get(app: tauri::AppHandle, lock: tauri::State<'_, CacheLock>, key: String) -> Result<Option<String>, CommandError> {
    let _guard = lock.0.lock().map_err(|_| cache_error("cache lock unavailable"))?;
    let path = cache_entry_path(&app, &key)?;
    let Some(entry) = read_cache_entry(&path).filter(|entry| entry.key == key) else {
        return Ok(None);
    };
    touch(&path);
    Ok(Some(entry.value))
}

/// Recency lives in mtime, so marking an entry used costs no rewrite.
fn touch(path: &Path) {
    if let Ok(file) = File::options().write(true).open(path) {
        let _ = file.set_modified(SystemTime::now());
    }
}

#[tauri::command(async)]
fn cache_set(
    app: tauri::AppHandle,
    lock: tauri::State<'_, CacheLock>,
    key: String,
    value: String,
) -> Result<CacheWriteResult, CommandError> {
    let mut used_bytes = lock.0.lock().map_err(|_| cache_error("cache lock unavailable"))?;
    let path = cache_entry_path(&app, &key)?;
    if read_cache_entry(&path).is_some_and(|entry| entry.key == key && entry.value == value) {
        touch(&path);
        return Ok(CacheWriteResult { changed: false });
    }
    let size = |path: &Path| fs::metadata(path).map_or(0, |metadata| metadata.len());
    let previous = size(&path);
    write_json_file(&path, &CacheEntry { key, value })?;
    let max_bytes = read_cache_max_bytes(&app);
    // Seeded from disk once; after that each write only adjusts the running total.
    let total = match *used_bytes {
        Some(total) => total.saturating_sub(previous) + size(&path),
        None => enforce_cache_limit(&cache_entries_dir(&app)?, max_bytes),
    };
    *used_bytes = Some(if total > max_bytes { enforce_cache_limit(&cache_entries_dir(&app)?, max_bytes) } else { total });
    Ok(CacheWriteResult { changed: true })
}

#[tauri::command(async)]
fn cache_stats(app: tauri::AppHandle) -> Result<CacheStats, CommandError> {
    calculate_cache_stats(&app)
}

#[tauri::command(async)]
fn cache_set_max_bytes(
    app: tauri::AppHandle,
    lock: tauri::State<'_, CacheLock>,
    max_bytes: u64,
) -> Result<CacheStats, CommandError> {
    let mut used_bytes = lock.0.lock().map_err(|_| cache_error("cache lock unavailable"))?;
    write_json_file(&cache_settings_path(&app)?, &CacheSettings { max_bytes })?;
    *used_bytes = Some(enforce_cache_limit(&cache_entries_dir(&app)?, max_bytes));
    calculate_cache_stats(&app)
}

#[tauri::command(async)]
fn cache_clear(app: tauri::AppHandle, lock: tauri::State<'_, CacheLock>) -> Result<CacheStats, CommandError> {
    let mut used_bytes = lock.0.lock().map_err(|_| cache_error("cache lock unavailable"))?;
    *used_bytes = Some(0);
    let entries = cache_entries_dir(&app)?;
    if entries.exists() {
        fs::remove_dir_all(&entries)
            .map_err(|error| cache_error(format!("cache clear failed: {error}")))?;
    }
    fs::create_dir_all(entries)
        .map_err(|error| cache_error(format!("cache directory creation failed: {error}")))?;
    calculate_cache_stats(&app)
}

/// Key written by the frontend's durable settings layer. Read here rather than pushed from
/// JS so the close handler answers correctly even before the webview has finished booting.
const MINIMIZE_TO_TRAY_SETTING: &str = "minimize-to-tray";

fn minimize_to_tray_enabled(app: &tauri::AppHandle) -> bool {
    read_app_setting(app, MINIMIZE_TO_TRAY_SETTING)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

/// Lets WebView2 trim the renderer's memory while the main window is out of sight. Audio is in
/// Rust, so nothing audible depends on the renderer staying warm.
#[cfg(windows)]
fn set_webview_memory_low(window: &tauri::WebviewWindow, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows::core::Interface;
    let level = if low {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
    } else {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
    };
    let _ = window.with_webview(move |webview| unsafe {
        // Older runtimes lack ICoreWebView2_19; they simply keep the default level.
        if let Ok(core) = webview.controller().CoreWebView2().and_then(|core| core.cast::<ICoreWebView2_19>()) {
            let _ = core.SetMemoryUsageTargetLevel(level);
        }
    });
}

#[cfg(not(windows))]
fn set_webview_memory_low(_window: &tauri::WebviewWindow, _low: bool) {}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        set_webview_memory_low(&window, false);
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
            set_webview_memory_low(&window, true);
        }
        eprintln!("[internal][tauri][info] main window hidden to tray");
        return;
    }
    app.exit(0);
}

// The tray only exists to bring back a hidden window, so it follows minimize-to-tray (#145).
fn set_tray_visible(app: &tauri::AppHandle, visible: bool) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_visible(visible);
    }
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

#[tauri::command(async)]
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
fn save_youtube_music_cookie(app: &tauri::AppHandle, cookie: &str) -> Result<(), CommandError> {
    let saved = save_youtube_music_cookie_entries(cookie);
    #[cfg(windows)]
    {
        let path = dpapi_session_file(app)?;
        let error = match saved {
            // Credential Manager holds it again; a fallback copy would only go stale.
            Ok(()) => {
                let _ = fs::remove_file(&path);
                return Ok(());
            }
            Err(error) => error.message,
        };
        eprintln!("[internal][tauri][warn] credential manager refused the session ({error}); using the DPAPI file");
        let encrypted = dpapi(cookie.as_bytes(), true).map_err(|dpapi_error| CommandError {
            message: format!("{error}; DPAPI fallback failed: {dpapi_error}"),
        })?;
        let temp_path = path.with_extension("tmp");
        fs::write(&temp_path, encrypted)
            .and_then(|()| replace_file(&temp_path, &path))
            .map_err(|io_error| CommandError {
                message: format!("{error}; DPAPI session save failed: {io_error}"),
            })
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        saved
    }
}

/// Where the session goes when Credential Manager refuses a write, as some machines do with
/// "Windows error code 8" (#171). DPAPI ties the file to this Windows user, as the vault would.
#[cfg(windows)]
fn dpapi_session_file(app: &tauri::AppHandle) -> Result<PathBuf, CommandError> {
    let dir = app.path().app_local_data_dir().map_err(|error| CommandError {
        message: format!("application data directory unavailable: {error}"),
    })?;
    fs::create_dir_all(&dir).map_err(|error| CommandError {
        message: format!("session directory creation failed: {error}"),
    })?;
    Ok(dir.join(YOUTUBE_COOKIE_DPAPI_FILE))
}

#[cfg(windows)]
fn dpapi(data: &[u8], protect: bool) -> Result<Vec<u8>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr().cast_mut() };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
    unsafe {
        if protect {
            CryptProtectData(&input, PCWSTR::null(), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        } else {
            CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        }
        .map_err(|error| error.to_string())?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData.cast())));
        Ok(bytes)
    }
}

/// The fallback session, if there is one. A file this user can no longer decrypt (the profile
/// was reset) is dropped, so the next sign-in starts clean instead of failing on it forever.
#[cfg(windows)]
fn load_dpapi_session(app: &tauri::AppHandle) -> Result<Option<String>, CommandError> {
    let path = dpapi_session_file(app)?;
    let encrypted = match fs::read(&path) {
        Ok(encrypted) => encrypted,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(CommandError { message: format!("DPAPI session load failed: {error}") })
        }
    };
    match dpapi(&encrypted, false).map(String::from_utf8) {
        Ok(Ok(cookie)) => Ok(Some(cookie)),
        Ok(Err(error)) => discard_dpapi_session(&path, &error.to_string()),
        Err(error) => discard_dpapi_session(&path, &error),
    }
}

#[cfg(windows)]
fn discard_dpapi_session(path: &Path, reason: &str) -> Result<Option<String>, CommandError> {
    eprintln!("[internal][tauri][warn] discarding unreadable DPAPI session: {reason}");
    let _ = fs::remove_file(path);
    Ok(None)
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
        // Chunks are contiguous, so stop at the first gap; sweeping every slot floods D-Bus (#144).
        match youtube_cookie_chunk_entry(index)?.delete_credential() {
            Ok(()) => {}
            Err(keyring::Error::NoEntry) => break,
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

/*
 * The Keychain entry backing `load_or_create_cookie_encryption_key` is scoped to this build's
 * code signature. Zuno's macOS builds are ad-hoc signed (no paid Developer ID), so that
 * signature — and with it, access to the old key — changes on every single update. Before this
 * guarded against it, a stale key read as `NoEntry`, the loader minted a brand new random one,
 * and it was handed straight to AES-GCM against ciphertext only the *old* key could ever open:
 * decryption fails its tag check, load_youtube_music_cookie surfaces that as an Err, and
 * restoreSession's catch quietly reports the user as logged out. The file never gets cleaned up,
 * so every later launch repeats the exact same failure — indistinguishable, from a signed-in
 * user's perspective, from having never logged in at all.
 *
 * Anything that goes wrong past "the file exists" is therefore treated as an orphaned session
 * rather than a hard error: delete the undecryptable file and report no session, so the state is
 * clean and the next login starts fresh instead of retrying against the same dead bytes forever.
 */
#[cfg(target_os = "macos")]
fn load_encrypted_youtube_music_cookie(
    app: &tauri::AppHandle,
) -> Result<Option<String>, CommandError> {
    let path = youtube_cookie_encrypted_file(app)?;
    let contents = match fs::read(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(CommandError {
                message: format!("encrypted session load failed: {error}"),
            })
        }
    };

    let discard_orphaned_session = |reason: String| -> Result<Option<String>, CommandError> {
        eprintln!(
            "[internal][tauri][warn] discarding unreadable YouTube Music session: {reason}"
        );
        let _ = fs::remove_file(&path);
        Ok(None)
    };

    if contents.len() <= 12 {
        return discard_orphaned_session("encrypted session file is invalid.".to_string());
    }
    let key = match load_or_create_cookie_encryption_key() {
        Ok(key) => key,
        Err(error) => return discard_orphaned_session(error.message),
    };
    let cipher = match Aes256Gcm::new_from_slice(&key) {
        Ok(cipher) => cipher,
        Err(error) => {
            return discard_orphaned_session(format!("session decryption setup failed: {error}"))
        }
    };
    let decrypted = match cipher.decrypt(Nonce::from_slice(&contents[..12]), &contents[12..]) {
        Ok(decrypted) => decrypted,
        Err(error) => {
            return discard_orphaned_session(format!("session decryption failed: {error}"))
        }
    };
    match String::from_utf8(decrypted) {
        Ok(cookie) => Ok(Some(cookie)),
        Err(error) => discard_orphaned_session(format!("decrypted session is invalid: {error}")),
    }
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
        let stored = load_youtube_music_cookie_entries();
        #[cfg(windows)]
        if !matches!(stored, Ok(Some(_))) {
            if let Some(cookie) = load_dpapi_session(app)? {
                return Ok(Some(cookie));
            }
        }
        let _ = app;
        stored
    }
}

/// Loads the account store, transparently migrating a pre-multi-account install's bare cookie
/// header into it the first time it is read.
///
/// The migration is persisted immediately (pinned to `LEGACY_ACCOUNT_SLOT_ID`, not a random id)
/// so it happens once, not on every call — and so every other command sees an ordinary
/// multi-account store from then on, never the legacy shape.
fn load_account_store(app: &tauri::AppHandle) -> Result<YoutubeAccountStore, CommandError> {
    let Some(blob) = read_stored_youtube_music_cookie(app)? else {
        return Ok(YoutubeAccountStore::default());
    };
    match serde_json::from_str::<YoutubeAccountStore>(&blob) {
        Ok(store) => Ok(store),
        Err(_) => {
            let migrated = YoutubeAccountStore::from_legacy_cookie(&blob, LEGACY_ACCOUNT_SLOT_ID.to_string());
            match save_account_store(app, &migrated) {
                Ok(()) => eprintln!(
                    "[internal][tauri][info] migrated legacy single-account session to the multi-account store"
                ),
                Err(error) => eprintln!(
                    "[internal][tauri][warn] could not persist migrated account store: {}",
                    error.message
                ),
            }
            Ok(migrated)
        }
    }
}

fn save_account_store(app: &tauri::AppHandle, store: &YoutubeAccountStore) -> Result<(), CommandError> {
    let json = serde_json::to_string(store).map_err(|error| CommandError {
        message: format!("account store encode failed: {error}"),
    })?;
    save_youtube_music_cookie(app, &json)
}

/// Writes one slot's cookie into the durable store only — the live in-memory jar is untouched.
/// Used by the cookie-rotation path in `refresh_youtube_cookie_jar`, which has already updated
/// the jar itself and would otherwise redo that work.
fn persist_account_cookie(
    app: &tauri::AppHandle,
    account_lock: &AccountStoreLock,
    slot_id: &str,
    cookie: &str,
) -> Result<(), CommandError> {
    let _guard = account_lock.0.lock().map_err(|_| CommandError {
        message: "account store lock unavailable".to_string(),
    })?;
    let mut store = load_account_store(app)?;
    let Some(account) = store.accounts.iter_mut().find(|account| account.slot_id == slot_id) else {
        // Removed mid-flight (e.g. from another window) — nothing durable left to update.
        return Ok(());
    };
    account.cookie = cookie.to_string();
    if account.identity.is_none() {
        account.identity = cookie_account_identity(cookie);
    }
    save_account_store(app, &store)
}

/// `persist_account_cookie`, plus updating the live jar — for callers (silent renewal) that
/// have not already updated it themselves.
fn persist_active_account_cookie(
    app: &tauri::AppHandle,
    account_lock: &AccountStoreLock,
    jar: &YoutubeCookieJar,
    slot_id: &str,
    cookie: &str,
) -> Result<(), CommandError> {
    persist_account_cookie(app, account_lock, slot_id, cookie)?;
    if let Ok(mut state) = jar.0.lock() {
        state.cookie = Some(cookie.to_string());
        state.persisted_at = Some(Instant::now());
    }
    Ok(())
}

/// Removes one stored account and, when it was active, falls the active slot back to another
/// stored account if any remain. Shared by `delete_youtube_music_cookie` (removes whichever is
/// active — today's "sign out") and `remove_youtube_music_account` (removes a specific one).
fn remove_account_slot(
    app: &tauri::AppHandle,
    account_lock: &AccountStoreLock,
    jar: &YoutubeCookieJar,
    slot_id: &str,
) -> Result<Option<String>, CommandError> {
    let (new_active_cookie, existed) = {
        let _guard = account_lock.0.lock().map_err(|_| CommandError {
            message: "account store lock unavailable".to_string(),
        })?;
        let mut store = load_account_store(app)?;
        let result = store.remove(slot_id);
        save_account_store(app, &store)?;
        result
    };
    if existed {
        // Idempotent and cheap; sign-out has always swept this pre-cookie-auth leftover too.
        delete_legacy_youtube_credentials();
        remove_login_partition(app, slot_id);
    }
    if let Ok(mut state) = jar.0.lock() {
        state.cookie = new_active_cookie.clone();
        state.persisted_at = new_active_cookie.as_ref().map(|_| Instant::now());
    }
    Ok(new_active_cookie)
}

#[tauri::command(async)]
fn load_youtube_music_cookie(
    app: tauri::AppHandle,
    jar: tauri::State<'_, YoutubeCookieJar>,
    account_lock: tauri::State<'_, AccountStoreLock>,
) -> Result<Option<String>, CommandError> {
    let _guard = account_lock.0.lock().map_err(|_| CommandError {
        message: "account store lock unavailable".to_string(),
    })?;
    let cookie = load_account_store(&app)?.active().map(|account| account.cookie.clone());
    if let Ok(mut state) = jar.0.lock() {
        state.cookie = cookie.clone();
        state.persisted_at = None;
    }
    Ok(cookie)
}

/// Every stored Google account, for the account switcher. Never includes the identity
/// fingerprint — only `slot_id`, an opaque random id with no information content, crosses into
/// the frontend.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct YoutubeAccountSummary {
    slot_id: String,
    name: Option<String>,
    avatar_url: Option<String>,
    is_active: bool,
}

#[tauri::command(async)]
fn list_youtube_music_accounts(
    app: tauri::AppHandle,
    account_lock: tauri::State<'_, AccountStoreLock>,
) -> Result<Vec<YoutubeAccountSummary>, CommandError> {
    let _guard = account_lock.0.lock().map_err(|_| CommandError {
        message: "account store lock unavailable".to_string(),
    })?;
    let store = load_account_store(&app)?;
    Ok(store
        .accounts
        .iter()
        .map(|account| YoutubeAccountSummary {
            slot_id: account.slot_id.clone(),
            name: account.display_name.clone(),
            avatar_url: account.avatar_url.clone(),
            is_active: store.active_slot_id.as_deref() == Some(account.slot_id.as_str()),
        })
        .collect())
}

/// Makes a stored account active without touching the browser at all — the whole point being
/// that this is instant, unlike sign-in.
#[tauri::command]
async fn switch_youtube_music_account(
    app: tauri::AppHandle,
    jar: tauri::State<'_, YoutubeCookieJar>,
    account_lock: tauri::State<'_, AccountStoreLock>,
    slot_id: String,
) -> Result<Option<String>, CommandError> {
    eprintln!("[internal][tauri][info] switch_youtube_music_account slot={slot_id}");
    let cookie = {
        let _guard = account_lock.0.lock().map_err(|_| CommandError {
            message: "account store lock unavailable".to_string(),
        })?;
        let mut store = load_account_store(&app)?;
        let Some(cookie) = store.switch_active(&slot_id) else {
            return Err(CommandError {
                message: "That account is no longer signed in on this device.".to_string(),
            });
        };
        save_account_store(&app, &store)?;
        cookie
    };
    if let Ok(mut state) = jar.0.lock() {
        state.cookie = Some(cookie.clone());
        state.persisted_at = Some(Instant::now());
    }
    Ok(Some(cookie))
}

/// Forgets one stored account. Removing the active one falls back to another stored account
/// automatically, the same as `delete_youtube_music_cookie` — see `remove_account_slot`.
#[tauri::command]
async fn remove_youtube_music_account(
    app: tauri::AppHandle,
    jar: tauri::State<'_, YoutubeCookieJar>,
    account_lock: tauri::State<'_, AccountStoreLock>,
    slot_id: String,
) -> Result<Option<String>, CommandError> {
    eprintln!("[internal][tauri][info] remove_youtube_music_account slot={slot_id}");
    remove_account_slot(&app, &account_lock, &jar, &slot_id)
}

/// Labels a stored account for the switcher UI. Best-effort from the caller's point of view —
/// Rust has no notion of "display name", it only stores whatever the frontend already fetched
/// from YouTube for that account.
#[tauri::command(async)]
fn update_youtube_music_account_profile(
    app: tauri::AppHandle,
    account_lock: tauri::State<'_, AccountStoreLock>,
    slot_id: String,
    name: Option<String>,
    avatar_url: Option<String>,
) -> Result<(), CommandError> {
    let _guard = account_lock.0.lock().map_err(|_| CommandError {
        message: "account store lock unavailable".to_string(),
    })?;
    let mut store = load_account_store(&app)?;
    let Some(account) = store.accounts.iter_mut().find(|account| account.slot_id == slot_id) else {
        return Ok(()); // Removed already; nothing left to label.
    };
    account.display_name = name;
    account.avatar_url = avatar_url;
    save_account_store(&app, &store)
}

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

/// The webview data directory name for one account slot's own login partition.
///
/// The legacy slot keeps the exact original, unsuffixed name — see `LEGACY_ACCOUNT_SLOT_ID`.
/// Every other slot gets a directory nothing else uses, so two stored accounts can never share
/// (and therefore never cross-contaminate) a browser cookie jar.
fn login_partition_directory_name(slot_id: &str) -> String {
    if slot_id == LEGACY_ACCOUNT_SLOT_ID {
        YOUTUBE_LOGIN_DATA_DIR.to_string()
    } else {
        format!("{YOUTUBE_LOGIN_DATA_DIR}-{slot_id}")
    }
}

/// The macOS `WKWebsiteDataStore` identifier for one account slot's own login partition.
///
/// Decodes the slot id's own bytes back out rather than hashing the string: slot ids are
/// generated as 32 hex characters over exactly 16 random bytes (`generate_slot_id`), so this is
/// a plain, lossless encoding round-trip — stable forever. Hashing with something like
/// `DefaultHasher` would not be: its output is only guaranteed stable within one build, and this
/// id has to keep pointing at the same data store across every future release.
#[cfg(target_os = "macos")]
fn login_partition_store_id(slot_id: &str) -> [u8; 16] {
    if slot_id == LEGACY_ACCOUNT_SLOT_ID {
        return YOUTUBE_LOGIN_DATA_STORE_ID;
    }
    decode_slot_id_bytes(slot_id)
}

/// Decodes a slot id's own hex characters back into the 16 raw bytes `generate_slot_id` drew
/// from `OsRng` — a lossless, stable-forever encoding round-trip, not a hash. Any byte pair that
/// somehow is not valid hex (should not happen for an id this code generated itself) decodes to
/// 0 rather than panicking, so a garbled id degrades to a well-defined value instead of crashing
/// whatever asked for it.
///
/// Its one real caller, `login_partition_store_id`, is macOS-only, which makes this dead code by
/// the compiler's count on every other platform — split out anyway so the tests that exercise it
/// everywhere aren't gated to macOS along with it.
#[allow(dead_code)]
fn decode_slot_id_bytes(slot_id: &str) -> [u8; 16] {
    let mut bytes = [0_u8; 16];
    for (index, chunk) in slot_id.as_bytes().chunks(2).take(16).enumerate() {
        if let Ok(text) = std::str::from_utf8(chunk) {
            if let Ok(byte) = u8::from_str_radix(text, 16) {
                bytes[index] = byte;
            }
        }
    }
    bytes
}

/// Builds the sign-in webview on one account slot's own storage partition.
///
/// Every slot — including a brand new candidate one about to attempt an interactive sign-in —
/// gets its own partition, never shared with any other slot. That is what makes "add another
/// account" foolproof without having to reverse-engineer Google's own multi-login cookie
/// behavior inside a WebView2/WKWebView profile: a fresh, empty partition can only ever show a
/// clean login/account-chooser screen, and a silent refresh against a specific slot's partition
/// can only ever renew *that* account's session, never a different stored one.
///
/// The window also shows a read-only address bar above the page, as a browser would, so users
/// can check that they are typing their password into accounts.google.com and not a lookalike.
/// It is a separate webview with no IPC access, and only this function writes to it, so the
/// page being shown cannot fake it.
///
/// `loaded` is raised once a navigation finishes, which the silent refresh needs: cookies read
/// before the page has actually loaded are the same stale ones we already hold.
fn build_login_window(
    app: &tauri::AppHandle,
    visible: bool,
    loaded: Arc<AtomicBool>,
    slot_id: &str,
) -> Result<tauri::Webview, CommandError> {
    if let Some(existing) = app.get_window(YOUTUBE_LOGIN_WINDOW) {
        let _ = existing.close();
    }

    let build_error = |error: tauri::Error| CommandError {
        message: format!("unable to open YouTube Music sign-in: {error}"),
    };
    let (width, height) = (520.0, 760.0);
    let window = tauri::window::WindowBuilder::new(app, YOUTUBE_LOGIN_WINDOW)
        .title("Sign in to YouTube Music")
        .visible(visible)
        .skip_taskbar(!visible)
        .inner_size(width, height)
        .build()
        .map_err(build_error)?;

    window
        .add_child(
            tauri::webview::WebviewBuilder::new(
                YOUTUBE_LOGIN_ADDRESS_BAR,
                tauri::WebviewUrl::App("login-bar.html".into()),
            ),
            tauri::LogicalPosition::new(0.0, 0.0),
            tauri::LogicalSize::new(width, YOUTUBE_LOGIN_ADDRESS_BAR_HEIGHT),
        )
        .map_err(build_error)?;

    let blank_url = "about:blank".parse().map_err(|error| CommandError {
        message: format!("invalid blank login URL: {error}"),
    })?;
    let page_builder = tauri::webview::WebviewBuilder::new(
        YOUTUBE_LOGIN_PAGE,
        tauri::WebviewUrl::External(blank_url),
    )
    .on_page_load(move |page, payload| {
        // Both events, so the bar already shows the new address while a slow page loads.
        if let Some(address_bar) = page.get_webview(YOUTUBE_LOGIN_ADDRESS_BAR) {
            let url = serde_json::Value::from(payload.url().as_str());
            let _ = address_bar.eval(format!("window.showUrl?.({url})"));
        }
        if payload.event() == tauri::webview::PageLoadEvent::Finished {
            loaded.store(true, Ordering::Relaxed);
        }
    });
    // See YOUTUBE_LOGIN_DATA_DIR: without its own partition, clearing this window's data
    // clears the main window's storage too.
    #[cfg(not(target_os = "macos"))]
    let page_builder = page_builder.data_directory(
        app.path()
            .app_local_data_dir()
            .map_err(|error| CommandError {
                message: format!("sign-in data directory unavailable: {error}"),
            })?
            .join(login_partition_directory_name(slot_id)),
    );
    #[cfg(target_os = "macos")]
    let page_builder = page_builder
        .user_agent(MACOS_LOGIN_USER_AGENT)
        // macOS 14+ only; older versions fall back to the shared store, as they did before.
        .data_store_identifier(login_partition_store_id(slot_id));

    let page = window
        .add_child(
            page_builder,
            tauri::LogicalPosition::new(0.0, YOUTUBE_LOGIN_ADDRESS_BAR_HEIGHT),
            tauri::LogicalSize::new(width, height - YOUTUBE_LOGIN_ADDRESS_BAR_HEIGHT),
        )
        .map_err(build_error)?;

    // On Linux the child webviews are packed into the window's GTK box, which ignores their
    // bounds and gives each the same share of the height. Pin the bar to its own height there
    // and let the page take the rest; GTK keeps that layout through resizes by itself.
    #[cfg(target_os = "linux")]
    {
        let gtk_window = window.clone();
        let _ = window.run_on_main_thread(move || {
            use gtk::prelude::*;
            let Ok(vbox) = gtk_window.default_vbox() else { return };
            if let Some(bar) = vbox.children().first() {
                bar.set_size_request(-1, YOUTUBE_LOGIN_ADDRESS_BAR_HEIGHT as i32);
                bar.set_vexpand(false);
                vbox.set_child_packing(bar, false, true, 0, gtk::PackType::Start);
            }
        });
    }

    // Elsewhere child webviews keep their bounds when the window is resized, so lay them out
    // again: the bar keeps its height and the page takes the rest.
    #[cfg(not(target_os = "linux"))]
    {
        let content = page.clone();
        window.on_window_event(move |event| {
            let tauri::WindowEvent::Resized(size) = event else { return };
            let Some(bar) = content.get_webview(YOUTUBE_LOGIN_ADDRESS_BAR) else { return };
            let bar_height = (YOUTUBE_LOGIN_ADDRESS_BAR_HEIGHT * bar.window().scale_factor().unwrap_or(1.0)) as u32;
            let _ = bar.set_bounds(tauri::Rect {
                position: tauri::PhysicalPosition::new(0, 0).into(),
                size: tauri::PhysicalSize::new(size.width, bar_height).into(),
            });
            let _ = content.set_bounds(tauri::Rect {
                position: tauri::PhysicalPosition::new(0, bar_height).into(),
                size: tauri::PhysicalSize::new(size.width, size.height.saturating_sub(bar_height)).into(),
            });
        });
    }

    Ok(page)
}

/// Clears a stored account's own webview partition, e.g. when it is removed or when an
/// interactive sign-in's throwaway candidate partition went unused (it matched an
/// already-stored identity instead of becoming a new slot).
///
/// Goes through the webview's own `clear_all_browsing_data`, the same safe mechanism sign-out
/// has always used, rather than deleting files out from under a browser engine that might still
/// hold them open. The legacy partition is never touched here — it is shared with whichever
/// slot came from a pre-multi-account install, and clearing it out from under a *different*
/// stored account would be exactly the cross-contamination this design exists to prevent.
fn remove_login_partition(app: &tauri::AppHandle, slot_id: &str) {
    if slot_id == LEGACY_ACCOUNT_SLOT_ID {
        return;
    }
    let Ok(page) = build_login_window(app, false, Arc::new(AtomicBool::new(false)), slot_id) else {
        return;
    };
    let _ = page.clear_all_browsing_data();
    // The clear is asynchronous underneath and reports through a handler nobody waits on;
    // closing the webview out from under it can leave the partition half-cleared.
    thread::sleep(Duration::from_millis(750));
    let _ = page.window().close();
}

/// The session cookie as the login webview currently holds it, if it holds one at all.
fn harvest_session_cookie(
    window: &tauri::Webview,
) -> Result<Option<String>, CommandError> {
    // Not `cookies_for_url`: Tauri holds the webview's lock until the main thread replies, and a
    // focus change handled while WebView2 fetches the cookies needs that lock, so it deadlocked.
    let cookies = window
        .cookies()
        .map_err(|error| CommandError {
            message: format!("unable to read YouTube Music session: {error}"),
        })?
        .into_iter()
        .filter(|cookie| cookie_domain_matches("music.youtube.com", cookie.domain()))
        .collect::<Vec<_>>();

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

/// The outcome of an interactive sign-in.
///
/// `account_changed` is what stops a renewal from costing the user their library. Signing in
/// again is usually not a new account at all — it is the same person recovering a session that
/// lapsed, and wiping the cache and the chosen channel for that is a resync nobody asked for.
/// `slot_id` is the account's opaque handle for `switch_youtube_music_account` /
/// `remove_youtube_music_account` / `update_youtube_music_account_profile`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignInResult {
    cookie: String,
    account_changed: bool,
    slot_id: String,
}

#[tauri::command]
async fn sign_in_youtube_music(
    app: tauri::AppHandle,
    jar: tauri::State<'_, YoutubeCookieJar>,
    account_lock: tauri::State<'_, AccountStoreLock>,
) -> Result<SignInResult, CommandError> {
    eprintln!("[internal][tauri][info] sign_in_youtube_music start");
    /*
     * A brand new candidate slot, up front — every interactive sign-in gets its own empty
     * webview partition (see `build_login_window`), so Google always shows a clean login or
     * account-chooser screen instead of silently continuing whatever identity a *shared*
     * partition last held. That ambiguity is exactly how adding a second account could
     * otherwise clobber the first one's session.
     *
     * If this sign-in turns out to re-authenticate an account already stored,
     * `upsert_signed_in_account` below finds it by identity and this candidate partition goes
     * unused — cleaned up rather than left as an orphaned directory.
     */
    let candidate_slot_id = generate_slot_id();
    let window = build_login_window(&app, true, Arc::new(AtomicBool::new(false)), &candidate_slot_id)?;
    eprintln!("[internal][tauri][info] sign_in_youtube_music login window created");

    let result = poll_for_sign_in(&app, &jar, &account_lock, &window, &candidate_slot_id);
    // Any failure (cancel, timeout, keyring error) must not leave the window up or the partition behind (#144).
    if result.is_err() {
        let _ = window.window().close();
        remove_login_partition(&app, &candidate_slot_id);
    }
    result
}

fn poll_for_sign_in(
    app: &tauri::AppHandle,
    jar: &YoutubeCookieJar,
    account_lock: &AccountStoreLock,
    window: &tauri::Webview,
    candidate_slot_id: &str,
) -> Result<SignInResult, CommandError> {
    let login_url = YOUTUBE_LOGIN_URL.parse().map_err(|error| CommandError {
        message: format!("invalid YouTube Music sign-in URL: {error}"),
    })?;
    window.navigate(login_url).map_err(|error| CommandError {
        message: format!("unable to navigate to YouTube Music sign-in: {error}"),
    })?;
    eprintln!("[internal][tauri][info] sign_in_youtube_music navigated to Google sign-in");

    for poll in 1..=300 {
        let harvested = match harvest_session_cookie(window) {
            // Closing the window mid-read fails the read on macOS; that is still a cancel (#143).
            Err(_) if app.get_window(YOUTUBE_LOGIN_WINDOW).is_none() => None,
            other => other?,
        };
        if let Some(cookie_header) = harvested {
            let (slot_id, account_changed, reused_existing_slot) = {
                let _guard = account_lock.0.lock().map_err(|_| CommandError {
                    message: "account store lock unavailable".to_string(),
                })?;
                let mut store = load_account_store(app)?;
                let (slot_id, account_changed) =
                    store.upsert_signed_in_account(&cookie_header, candidate_slot_id.to_string());
                save_account_store(app, &store)?;
                (slot_id.clone(), account_changed, slot_id != candidate_slot_id)
            };
            if reused_existing_slot {
                remove_login_partition(app, candidate_slot_id);
            }
            if let Ok(mut state) = jar.0.lock() {
                state.cookie = Some(cookie_header.clone());
                state.persisted_at = Some(Instant::now());
            }

            eprintln!(
                "[internal][tauri][info] sign_in_youtube_music detected session poll={} credential_bytes={} account_changed={} slot={}",
                poll,
                cookie_header.len(),
                account_changed,
                slot_id,
            );
            let _ = window.window().close();
            return Ok(SignInResult {
                cookie: cookie_header,
                account_changed,
                slot_id,
            });
        }

        if app.get_window(YOUTUBE_LOGIN_WINDOW).is_none() {
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

    eprintln!("[internal][tauri][warn] sign_in_youtube_music timed out");
    Err(CommandError {
        message: "YouTube Music sign-in timed out.".to_string(),
    })
}

/// Renews the session from the sign-in partition without involving the user.
///
/// Navigates to `YOUTUBE_LOGIN_URL` — the same Google entry point the interactive sign-in uses,
/// and the reason this works at all. Loading music.youtube.com directly does *not* re-mint
/// anything: presented with a retired `__Secure-*PSIDTS` it simply renders the signed-out page,
/// so this used to harvest the dead cookie back, report a renewal, and leave the app to discover
/// seconds later that it was still signed out. Only the accounts.google.com round trip reissues
/// the YouTube-domain cookies from the Google session the partition still holds.
///
/// The landing check in `harvest_session_cookie` does double duty here: reaching
/// music.youtube.com *is* the proof that Google accepted the session without asking anything.
/// When it needs a password or a second factor the redirect stops short, nothing is harvested,
/// and `None` says what it has always said — the sign-in genuinely lapsed and only the user can
/// fix it. Hidden throughout, because a window that needs interaction nobody can see is a window
/// that never finishes.
#[tauri::command]
async fn refresh_youtube_music_cookie(
    app: tauri::AppHandle,
    jar: tauri::State<'_, YoutubeCookieJar>,
    account_lock: tauri::State<'_, AccountStoreLock>,
) -> Result<Option<String>, CommandError> {
    eprintln!("[internal][tauri][info] refresh_youtube_music_cookie start");
    let active_slot_id = {
        let _guard = account_lock.0.lock().map_err(|_| CommandError {
            message: "account store lock unavailable".to_string(),
        })?;
        load_account_store(&app)?.active_slot_id
    };
    let Some(active_slot_id) = active_slot_id else {
        eprintln!("[internal][tauri][info] refresh_youtube_music_cookie no active account to renew");
        return Ok(None);
    };

    let loaded = Arc::new(AtomicBool::new(false));
    let window = build_login_window(&app, false, loaded.clone(), &active_slot_id)?;

    // Closed on every exit: an early error used to leave the hidden window running.
    let result = (|| {
        let login_url = YOUTUBE_LOGIN_URL.parse().map_err(|error| CommandError {
            message: format!("invalid YouTube Music sign-in URL: {error}"),
        })?;
        window.navigate(login_url).map_err(|error| CommandError {
            message: format!("unable to renew the YouTube Music session silently: {error}"),
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
                    persist_active_account_cookie(&app, &account_lock, &jar, &active_slot_id, &cookie_header)?;
                    return Ok(Some(cookie_header));
                }
            }
            thread::sleep(Duration::from_secs(1));
        }

        eprintln!("[internal][tauri][info] refresh_youtube_music_cookie found no usable session");
        Ok(None)
    })();
    let _ = window.window().close();
    result
}

/// Signs out of whichever account is currently active — today's one-account "sign out".
///
/// With more than one account stored, another one automatically becomes active in its place
/// (the returned cookie is Some) rather than dropping to fully signed out, the same way removing
/// your active Google account from a browser falls back to another one still signed in there.
/// Signing out of the *last* account behaves exactly as it always has: fully signed out.
#[tauri::command]
async fn delete_youtube_music_cookie(
    app: tauri::AppHandle,
    jar: tauri::State<'_, YoutubeCookieJar>,
    account_lock: tauri::State<'_, AccountStoreLock>,
) -> Result<Option<String>, CommandError> {
    eprintln!("[internal][tauri][info] delete_youtube_music_cookie start");
    let active_slot_id = {
        let _guard = account_lock.0.lock().map_err(|_| CommandError {
            message: "account store lock unavailable".to_string(),
        })?;
        load_account_store(&app)?.active_slot_id
    };
    let Some(active_slot_id) = active_slot_id else {
        // Nothing was signed in at all; still clear the live jar for good measure.
        if let Ok(mut state) = jar.0.lock() {
            state.cookie = None;
            state.persisted_at = None;
        }
        eprintln!("[internal][tauri][info] delete_youtube_music_cookie nothing signed in");
        return Ok(None);
    };
    let new_active_cookie = remove_account_slot(&app, &account_lock, &jar, &active_slot_id)?;
    eprintln!(
        "[internal][tauri][info] delete_youtube_music_cookie complete fell_back={}",
        new_active_cookie.is_some()
    );
    Ok(new_active_cookie)
}

#[derive(Debug, Serialize)]
struct CommandError {
    message: String,
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
    /// The rotated cookie, when this response changed it. Absent means "unchanged".
    #[serde(skip_serializing_if = "Option::is_none")]
    cookie: Option<String>,
}

#[derive(Clone)]
/**
 * A media body, which may still be arriving.
 *
 * Ranges are fetched in parallel and therefore land out of order, so "how much can be served"
 * is the leading run of present chunks — not how many bytes have arrived in total. A request
 * for a range past that prefix waits for it rather than being answered short, which is what
 * lets an `<audio>` element start on the first chunk while the rest is still downloading.
 */
pub(crate) struct MediaBuffer {
    /// Sized on creation; each slot's length is its own chunk size, so no stride is stored.
    chunks: Vec<Option<Vec<u8>>>,
    pub(crate) total: usize,
    /// Set when the download gave up. The server answers 503 rather than waiting out the clock.
    pub(crate) failed: bool,
}

impl MediaBuffer {
    fn complete(bytes: Vec<u8>) -> Self {
        let total = bytes.len();
        Self { chunks: vec![Some(bytes)], total, failed: false }
    }

    fn pending(total: usize, chunk_count: usize) -> Self {
        Self { chunks: vec![None; chunk_count], total, failed: false }
    }

    /// Bytes servable from offset 0 without a hole.
    pub(crate) fn contiguous_len(&self) -> usize {
        let mut len = 0;
        for chunk in &self.chunks {
            match chunk {
                Some(bytes) => len += bytes.len(),
                None => break,
            }
        }
        len
    }

    /// Replaces everything with one finished body, for the whole-file fallback.
    fn adopt_complete(&mut self, bytes: Vec<u8>) {
        self.total = bytes.len();
        self.chunks = vec![Some(bytes)];
    }

    fn put(&mut self, index: usize, bytes: Vec<u8>) {
        if index < self.chunks.len() {
            self.chunks[index] = Some(bytes);
        }
    }

    /// Copies from `start` straight into `out`, across chunk boundaries; returns bytes copied.
    pub(crate) fn read_into(&self, start: usize, out: &mut [u8]) -> usize {
        let (mut copied, mut offset) = (0, 0);
        for bytes in self.chunks.iter().map_while(Option::as_ref) {
            let chunk_end = offset + bytes.len();
            let position = start + copied;
            if position >= offset && position < chunk_end {
                let count = (chunk_end - position).min(out.len() - copied);
                out[copied..copied + count].copy_from_slice(&bytes[position - offset..][..count]);
                copied += count;
                if copied == out.len() {
                    break;
                }
            }
            offset = chunk_end;
        }
        copied
    }

    /// `start..=end` as an owned copy, for callers that keep the bytes.
    pub(crate) fn read(&self, start: usize, end: usize) -> Vec<u8> {
        if end < start {
            return Vec::new();
        }
        let mut out = vec![0; end - start + 1];
        let copied = self.read_into(start, &mut out);
        out.truncate(copied);
        out
    }
}

/// Cloned per request so the handler can release the map lock before it waits on bytes.
#[derive(Clone)]
struct MediaItem {
    buffer: Arc<Mutex<MediaBuffer>>,
    mime_type: String,
    /// Insertion order, for evicting the coldest entry. A counter rather than a timestamp:
    /// two inserts inside the same millisecond still have to be orderable.
    sequence: u64,
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
static MEDIA_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/**
 * Audio bodies held in memory at once.
 *
 * Two is the real working set — the track playing, and the one preloaded behind it — with a
 * third as slack for a fast skip that starts a fourth before the first has been let go. Each
 * entry is a whole song, so a slot costs megabytes: this is a cap, not a cache.
 */
const MEDIA_SERVER_MAX_ITEMS: usize = 3;

/// How long a range request waits for bytes that are still downloading before giving up.
const MEDIA_WAIT_TIMEOUT: Duration = Duration::from_secs(30);
/// Poll interval while waiting. Short enough to be invisible, long enough not to spin.
const MEDIA_WAIT_POLL: Duration = Duration::from_millis(20);

/**
 * Publishes a body under `key`, evicting the coldest entries to stay under the cap.
 *
 * The eviction is the point. This map was insert-only, so with native audio on, every track
 * ever played stayed resident for the life of the process — a few megabytes per song, never
 * returned.
 *
 * Replacing an existing key is safe mid-playback: `handle_media_request` clones the `Arc`
 * before it writes, so a request already in flight finishes against the bytes it started with.
 */
fn store_media_item(
    items: &Arc<Mutex<HashMap<String, MediaItem>>>,
    key: String,
    bytes: Vec<u8>,
    mime_type: String,
) -> Result<(), CommandError> {
    store_media_buffer(items, key, Arc::new(Mutex::new(MediaBuffer::complete(bytes))), mime_type)
}

/// Publishes a body that may still be arriving. Same eviction rules as `store_media_item`.
fn store_media_buffer(
    items: &Arc<Mutex<HashMap<String, MediaItem>>>,
    key: String,
    buffer: Arc<Mutex<MediaBuffer>>,
    mime_type: String,
) -> Result<(), CommandError> {
    let mut items = items.lock().map_err(|_| CommandError {
        message: "media server cache lock poisoned".into(),
    })?;

    items.insert(
        key,
        MediaItem {
            buffer,
            mime_type,
            sequence: MEDIA_SEQUENCE.fetch_add(1, Ordering::Relaxed),
        },
    );

    while items.len() > MEDIA_SERVER_MAX_ITEMS {
        let coldest = items
            .iter()
            .min_by_key(|(_, item)| item.sequence)
            .map(|(key, _)| key.clone());
        match coldest {
            Some(key) => {
                items.remove(&key);
            }
            None => break,
        }
    }

    Ok(())
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

/**
 * Drops every audio body the media server is holding.
 *
 * What it costs to leave running is the map, not the socket: up to `MEDIA_SERVER_MAX_ITEMS`
 * whole songs, megabytes each, kept resident so an `<audio>` element can re-request a range.
 * The Rust engine reads through `MediaBuffer` in-process and never asks the server for
 * anything, so once it takes over those bodies are unreachable as well as unused.
 *
 * ponytail: the listener thread and its loopback port stay. Reclaiming them means turning the
 * `OnceLock` into a lock that can be emptied and teaching the accept loop to stop, and the
 * server would then have to be able to *restart* — the other two engines still need it. One
 * thread parked in `accept()` is not worth that; the megabytes were the point.
 *
 * Returns how many entries were dropped. Zero is the ordinary answer: in `rust` mode from a
 * cold start `media_server()` is never called, so there is nothing to release.
 */
#[tauri::command(async)]
fn media_server_release() -> Result<usize, CommandError> {
    let Some(server) = MEDIA_SERVER.get() else {
        return Ok(0);
    };
    let mut items = server.items.lock().map_err(|_| CommandError {
        message: "media server cache lock poisoned".into(),
    })?;

    let released = items.len();
    if released > 0 {
        /*
         * Safe against a request already in flight: `handle_media_request` clones the `Arc`
         * before it reads, so a range being served finishes against the bytes it started with
         * rather than finding an empty map.
         */
        items.clear();
        eprintln!("[internal][tauri][info] media_server_release entries={released}");
    }
    Ok(released)
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

    let total_len = match item.buffer.lock() {
        Ok(buffer) => buffer.total,
        Err(_) => {
            let _ = stream.write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\n\r\n");
            return;
        }
    };
    let has_range = range_header.is_some();
    let (status, start, mut end) = parse_media_range(range_header.as_deref(), total_len)
        .unwrap_or(("200 OK", 0, total_len.saturating_sub(1)));

    /*
     * A ranged request is answered as soon as its *first* byte exists, with however much of the
     * range is contiguously available — not by waiting for all of it.
     *
     * This is the whole point of publishing a body before it has finished downloading. Media
     * elements open with `Range: bytes=0-`, which asks for the entire file; waiting for that
     * put the full download back in front of playback and made progressive serving worth
     * nothing. A short 206 is legitimate — the element reads what it gets and asks for the
     * rest — so the first chunk is enough to start on.
     *
     * A request with no Range header is different: it can only be answered 200, and a 200 whose
     * Content-Length disagrees with the body is a truncated track. Those still wait for it all.
     */
    if total_len > 0 && method != "HEAD" {
        let needed = if has_range { start } else { end };
        let deadline = Instant::now() + MEDIA_WAIT_TIMEOUT;
        loop {
            let Ok(buffer) = item.buffer.lock() else { break };
            if buffer.failed {
                drop(buffer);
                let _ = stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
                return;
            }
            let available = buffer.contiguous_len();
            if available > needed {
                if has_range {
                    end = end.min(available.saturating_sub(1));
                }
                break;
            }
            drop(buffer);
            if Instant::now() >= deadline {
                let _ = stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
                return;
            }
            thread::sleep(MEDIA_WAIT_POLL);
        }
    }

    let body_len = if total_len == 0 { 0 } else { end - start + 1 };
    let content_range = if status.starts_with("206") {
        format!("Content-Range: bytes {start}-{end}/{total_len}\r\n")
    } else {
        String::new()
    };
    /*
     * `no-store` is load-bearing, not hygiene.
     *
     * Without it the webview keeps its own copy of every audio body it fetches — whole songs,
     * several megabytes each, in the renderer process. That is memory this process is already
     * holding, retained a second time by the one place that cannot be asked to give it back.
     */
    let headers = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\n{}Content-Length: {body_len}\r\nConnection: close\r\n\r\n",
        item.mime_type,
        content_range,
    );
    let _ = stream.write_all(headers.as_bytes());
    if method == "HEAD" || total_len == 0 {
        return;
    }
    let body = match item.buffer.lock() {
        Ok(buffer) => buffer.read(start, end),
        Err(_) => return,
    };
    let _ = stream.write_all(&body);
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
    let client = http_client(signed_googlevideo_local_address(&request_url));
    /*
     * The whole file in one request, asked for the way the browser asks: `range=0-{clen-1}` in
     * the query string. When `clen` is absent there is nothing to bound the request with, so it
     * goes out plain — still without a Range header, which is what gets these refused.
     */
    let ranged_url = match signed_content_length(&request_url) {
        Some(total) if total > 0 => audio_url_with_range(&url, 0, total - 1),
        _ => url.clone(),
    };
    let response = send_audio_request(client, &ranged_url, cookie.as_deref(), &track_id).await?;

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
    has_artwork: bool,
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

/**
 * One playback fill at a time, process-wide.
 *
 * Not a rate limit — a correctness guard. googlevideo answers 403 on the later of two range
 * requests that overlap on one session, so two tracks filling at once means the one being
 * listened to loses its tail. See `fill_media_buffer`, which holds this for its whole run.
 *
 * Downloads (`fetch_audio_ranged`) deliberately stay outside it: they fan out six ways on
 * purpose, they are a user-initiated bulk action rather than something a listener is waiting
 * on, and that path has not shown this failure.
 */
static PLAYBACK_FILL_LOCK: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

/** Attempts per playback range before falling back. A 403 here is usually transient. */
const PLAYBACK_RANGE_ATTEMPTS: usize = 3;
/** Delay before retrying a refused range; doubled on each further attempt. */
const PLAYBACK_RETRY_BACKOFF: Duration = Duration::from_millis(250);

/**
 * One counter per native-audio load slot — foreground (`0`) and standby (`1`) — bumped every
 * time a new load targets that slot.
 *
 * A fill still running under a stale generation has been superseded: nobody is waiting on it
 * any more, so it abandons instead of running its retries and whole-file fallback to
 * completion. Without this, a track that died left its fill orphaned but still holding
 * `PLAYBACK_FILL_LOCK` — a single global permit — for as long as its own retries took to
 * exhaust. That is exactly what the one reload `recoverFromPrematureEnd` sends right behind it
 * needs to not queue up behind, and a starved retry there is what turned one stalled download
 * into a skipped track.
 */
static LOAD_GENERATION: [AtomicU64; 2] = [AtomicU64::new(0), AtomicU64::new(0)];

/// True once a fill's slot has moved on to a newer load. `None` opts out, for the media-server
/// (`<audio>`) path, which has no load slots to be superseded in.
fn load_superseded(slot: Option<(usize, u64)>) -> bool {
    match slot {
        Some((index, generation)) => LOAD_GENERATION[index].load(Ordering::SeqCst) != generation,
        None => false,
    }
}

/**
 * Smallest total worth splitting, and the floor on a range.
 *
 * Chunking a file below this buys nothing: the per-request overhead is a larger share than the
 * parallelism recovers.
 */
const AUDIO_MIN_CHUNK_BYTES: u64 = 512 * 1024;

/**
 * Range size for a given total.
 *
 * Aims for roughly `OFFLINE_CHUNK_CONCURRENCY` ranges so the whole file is in flight at once,
 * floored so a small file does not become a swarm of tiny requests and capped so a large one
 * does not become a handful of huge ones.
 *
 * A fixed 4 MiB was both the range size *and* the threshold, which meant a typical song — 2 to
 * 4 MB of Opus — fell under it and took the single sequential stream this exists to avoid.
 */
/**
 * Bytes in the first range.
 *
 * Deliberately much smaller than the rest. A media element cannot report `canplay` until it
 * has the container header and a little audio, and it asks for the whole file in one range —
 * so whatever the first chunk weighs is exactly how long a click waits for sound. Sizing it
 * like the others meant ~700 KB before the first note; this is enough to decode a header.
 */
const AUDIO_HEAD_CHUNK_BYTES: usize = 128 * 1024;

/**
 * The two ranges a *playback* body is fetched in: a small head, then all the rest.
 *
 * Playback does not fan out. googlevideo refuses ranges when several are in flight on one
 * session — always the later ones, never the first — and with a track playing and another
 * warming behind it there are always two fills competing. Lowering the fan-out did not stop
 * it; removing it does, and this is how a browser streams the same file anyway.
 *
 * The speed argument for fanning out does not apply here. It exists so a *download* finishes
 * quickly; playback only has to outrun the listener, and a ~130 kbps track needs about 16 KB/s
 * against a single stream that delivers far more. Latency is already handled by the head being
 * small — that is the only part a click waits for.
 */
fn playback_ranges(total: usize) -> Vec<(usize, usize)> {
    if total == 0 {
        return Vec::new();
    }
    let head = AUDIO_HEAD_CHUNK_BYTES.min(total);
    let mut ranges = vec![(0, head - 1)];
    if head < total {
        ranges.push((head, total - 1));
    }
    ranges
}

fn audio_chunk_size(total: u64) -> u64 {
    (total / OFFLINE_CHUNK_CONCURRENCY as u64).clamp(AUDIO_MIN_CHUNK_BYTES, OFFLINE_CHUNK_BYTES)
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
    let request_url = url::Url::parse(&url)
        .map_err(|error| cache_error(format!("audio URL parse failed: {error}")))?;
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

    let total_bytes = signed_content_length(&request_url).unwrap_or(0);
    let mut last_percent: u8 = 0;
    let bytes = fetch_audio_ranged(&url, &track_id, cookie.as_deref(), |received, total| {
        emit_offline_progress(&app, &track_id, received, total, &mut last_percent);
    })
    .await?;

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

    write_offline_entry(&app, &track_id, &bytes, started_at, total_bytes > AUDIO_MIN_CHUNK_BYTES)
}

/**
 * Downloads a signed audio URL, in parallel ranges whenever the size is known.
 *
 * googlevideo throttles a single sequential stream hard, which is why one whole-file request
 * takes far longer than the same bytes fetched as several ranges at once. Shared by the
 * offline store and by native playback so the two cannot drift apart on speed — playback used
 * the slow path while the download feature used this one, and a skip paid for the difference.
 *
 * `on_progress` receives `(received, total)`. Playback passes a closure that does nothing.
 */
async fn fetch_audio_ranged(
    url: &str,
    track_id: &str,
    cookie: Option<&str>,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<Vec<u8>, CommandError> {
    use futures_util::stream::StreamExt;

    let request_url = url::Url::parse(url)
        .map_err(|error| cache_error(format!("audio URL parse failed: {error}")))?;

    /*
     * `clen` rather than a probe request. A `range=` query is answered with 200 and just that
     * slice — there is no 206 and no Content-Range — so the response cannot report the total
     * size. The URL states the length itself, and it is covered by the signature, so it cannot
     * disagree with the file.
     */
    let total_bytes = signed_content_length(&request_url).unwrap_or(0);

    // Small enough for one request, or `clen` was absent and there is nothing to chunk by.
    if total_bytes <= AUDIO_MIN_CHUNK_BYTES {
        let whole = fetch_audio_bytes(
            url.to_string(),
            track_id.to_string(),
            cookie.map(str::to_string),
        )
        .await?;
        let received = whole.len() as u64;
        on_progress(received, if total_bytes > 0 { total_bytes } else { received });
        return Ok(whole);
    }

    let client = http_client(signed_googlevideo_local_address(&request_url));

    let chunk_size = audio_chunk_size(total_bytes);
    let mut ranges = Vec::new();
    let mut start = 0u64;
    while start < total_bytes {
        let end = (start + chunk_size - 1).min(total_bytes - 1);
        ranges.push((start, end));
        start = end + 1;
    }

    let mut chunks: Vec<(u64, Vec<u8>)> = Vec::with_capacity(ranges.len());
    let mut received = 0u64;
    let mut stream = futures_util::stream::iter(ranges.into_iter().map(|(start, end)| {
        let client = client.clone();
        let url = url.to_string();
        let cookie = cookie.map(str::to_string);
        async move {
            let response = googlevideo_audio_request(
                &client,
                &audio_url_with_range(&url, start, end),
                cookie.as_deref(),
            )
            .send()
            .await
            .map_err(|error| cache_error(format!("audio range request failed: {error}")))?;
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
        match result {
            Ok((start, body)) => {
                received += body.len() as u64;
                on_progress(received, total_bytes);
                chunks.push((start, body));
            }
            Err(error) => {
                chunk_error = Some(error);
                break;
            }
        }
    }
    drop(stream);

    // One refused chunk invalidates the whole assembly, so restart on the proven path instead
    // of returning a buffer with a hole in it.
    if let Some(error) = chunk_error {
        eprintln!(
            "[internal][tauri][warn] fetch_audio_ranged chunk failed ({}) falling back track_id={}",
            error.message, track_id
        );
        return fetch_audio_bytes(
            url.to_string(),
            track_id.to_string(),
            cookie.map(str::to_string),
        )
        .await;
    }

    // Ranges complete out of order, so the buffer is reassembled by offset.
    chunks.sort_by_key(|(start, _)| *start);
    let mut bytes = Vec::with_capacity(total_bytes as usize);
    for (_, body) in chunks {
        bytes.extend_from_slice(&body);
    }
    Ok(bytes)
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
#[tauri::command(async)]
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
    store_media_item(&server.items, key.clone(), bytes, mime_type.clone())?;

    Ok(AudioSourcePayload {
        url: format!("{}/audio/{}", server.origin, key),
        mime_type,
        byte_length,
    })
}

#[tauri::command(async)]
fn offline_audio_remove(app: tauri::AppHandle, track_id: String) -> Result<(), CommandError> {
    let path = offline_entry_path(&app, &track_id)?;
    let _ = fs::remove_file(path.with_extension("art"));
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|error| cache_error(format!("offline delete failed: {error}")))?;
    }
    Ok(())
}

/// The saved cover behind an `offline-artwork:<trackId>` URL, for the OS media controls.
pub(crate) fn offline_artwork_file(app: &tauri::AppHandle, url: &str) -> Option<PathBuf> {
    let track_id = url.strip_prefix("offline-artwork:")?;
    let path = offline_entry_path(app, track_id).ok()?.with_extension("art");
    path.is_file().then_some(path)
}

/// Saves a downloaded track's cover next to its audio, so it still shows with no network.
#[tauri::command]
async fn offline_artwork_save(
    app: tauri::AppHandle,
    track_id: String,
    url: String,
) -> Result<(), CommandError> {
    let path = offline_entry_path(&app, &track_id)?.with_extension("art");
    if !url.starts_with("https://") {
        return Err(cache_error("artwork URL must be https"));
    }
    let bytes = http_client(None)
        .get(&url)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|error| cache_error(format!("artwork request failed: {error}")))?
        .bytes()
        .await
        .map_err(|error| cache_error(format!("artwork read failed: {error}")))?;
    if bytes.len() > MAX_ARTWORK_BYTES || sniff_image_mime(&bytes).is_none() {
        return Err(cache_error("artwork response is not a usable image"));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| cache_error(format!("offline directory creation failed: {error}")))?;
    }
    fs::write(&path, &bytes).map_err(|error| cache_error(format!("artwork save failed: {error}")))
}

#[tauri::command(async)]
fn offline_artwork(app: tauri::AppHandle, track_id: String) -> Result<Option<LocalArtwork>, CommandError> {
    use base64::Engine;

    let path = offline_entry_path(&app, &track_id)?.with_extension("art");
    let data = match fs::read(&path) {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(cache_error(format!("artwork read failed: {error}"))),
    };
    Ok(sniff_image_mime(&data).map(|mime_type| LocalArtwork {
        mime_type: mime_type.to_string(),
        data_base64: base64::engine::general_purpose::STANDARD.encode(&data),
    }))
}

/// The source of truth for what is downloaded. The frontend keeps its own manifest for track
/// metadata, but this is what reconciles it when the two disagree.
#[tauri::command(async)]
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
            has_artwork: path.with_extension("art").exists(),
        });
    }
    Ok(entries)
}

/// Deletes least-recently-*modified* entries until the store fits `max_bytes`.
///
/// Modification time rather than access time: access times are unreliable on Windows and
/// playing a track does not rewrite the file, so mtime is effectively "when it was
/// downloaded" -- a blunt but stable ordering.
#[tauri::command(async)]
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
            let _ = fs::remove_file(path.with_extension("art"));
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
    let request_url = url::Url::parse(&url)
        .map_err(|error| cache_error(format!("audio URL parse failed: {error}")))?;
    let total = signed_content_length(&request_url).unwrap_or(0) as usize;
    let server = media_server()?;
    let key = format!("stream-{track_id}");

    /*
     * Too small to stream progressively, or no `clen` to plan a fill with. Downloading it whole
     * costs one request either way, and the caller gets a body that is already complete.
     */
    if total <= AUDIO_MIN_CHUNK_BYTES as usize {
        let bytes = fetch_audio_ranged(&url, &track_id, cookie.as_deref(), |_, _| {}).await?;
        verify_audio_container(&bytes, &mime_type)?;
        let byte_length = bytes.len();
        store_media_item(&server.items, key.clone(), bytes, mime_type.clone())?;
        return Ok(AudioSourcePayload {
            url: format!("{}/audio/{}", server.origin, key),
            mime_type,
            byte_length,
        });
    }

    /*
     * Published empty, then filled behind the caller.
     *
     * Playback used to wait for the last byte of the file before it was handed a URL, which put
     * the whole download between a click and the first sound. The entry now carries its final
     * size from the start, so the media element can request the head of the file and begin
     * while the rest is still arriving; `handle_media_request` waits for whichever range it
     * asks for.
     */
    let ranges = playback_ranges(total);
    let buffer = Arc::new(Mutex::new(MediaBuffer::pending(total, ranges.len())));
    store_media_buffer(&server.items, key.clone(), Arc::clone(&buffer), mime_type.clone())?;

    tauri::async_runtime::spawn(fill_media_buffer(
        url,
        track_id,
        cookie,
        mime_type.clone(),
        buffer,
        ranges,
        None,
    ));

    Ok(AudioSourcePayload {
        url: format!("{}/audio/{}", server.origin, key),
        mime_type,
        byte_length: total,
    })
}

/**
 * Rejects a body that is not the container that was asked for.
 *
 * Only meaningful for MP4: `resolveStreamUrl` falls back to Opus-in-WebM when a track has no
 * AAC, and "high" ranks across every format, so this has to follow what was requested rather
 * than assume.
 */
fn verify_audio_container(bytes: &[u8], mime_type: &str) -> Result<(), CommandError> {
    if !mime_type.contains("mp4") || bytes.len() < 12 || &bytes[4..8] == b"ftyp" {
        return Ok(());
    }
    let preview = String::from_utf8_lossy(&bytes[..bytes.len().min(120)]).replace('\n', " ");
    Err(CommandError {
        message: format!("Audio download was not an MP4 file. Response started with: {preview}"),
    })
}

/**
 * A short, log-safe look at bytes a decoder just rejected.
 *
 * `verify_audio_container` above only ever checks MP4 — a WebM/Opus response that is not
 * actually WebM sails through it untouched and is only ever caught once symphonia's probe
 * chokes on it, by which point the only trace left of *what* arrived is whatever this prints.
 * Both hex and a lossy UTF-8 decode: binary garbage reads as hex, but a wrong response is often
 * an HTML or JSON error page, which is unreadable as hex and exactly the case this exists for.
 */
fn bytes_preview(bytes: &[u8]) -> String {
    let head = &bytes[..bytes.len().min(32)];
    let hex: String = head.iter().map(|byte| format!("{byte:02x}")).collect();
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(120)]).replace('\n', " ");
    format!("{} bytes, starts hex={hex} text={text:?}", bytes.len())
}

/**
 * Fills a published buffer with parallel range requests.
 *
 * Chunks land out of order, which is why the buffer tracks them by index and serves only its
 * contiguous prefix. A failure marks the buffer so waiting requests get a 503 instead of
 * sitting out the timeout — the media element then reports an error and playback fails loudly
 * rather than hanging.
 *
 * `slot` is the native-audio load slot this fill belongs to (see `LOAD_GENERATION`), `None` for
 * the media-server path. Checked at every point that would otherwise spend time on a track
 * nobody wants any more, so a superseded fill gives up `PLAYBACK_FILL_LOCK` promptly instead of
 * running its retries and fallback to completion first.
 */
async fn fill_media_buffer(
    url: String,
    track_id: String,
    cookie: Option<String>,
    mime_type: String,
    buffer: Arc<Mutex<MediaBuffer>>,
    ranges: Vec<(usize, usize)>,
    slot: Option<(usize, u64)>,
) {
    use futures_util::stream::StreamExt;

    let fail = |buffer: &Arc<Mutex<MediaBuffer>>| {
        if let Ok(mut guard) = buffer.lock() {
            guard.failed = true;
        }
    };

    /*
     * Held for the whole fill, both ranges and the fallback.
     *
     * `playback_ranges` removed the fan-out *within* a track after googlevideo was found to
     * refuse ranges whenever several are in flight on one session — always the later ones,
     * never the first. What it could not fix from where it sat is the fan-out *across* tracks:
     * `warmNextTrack` starts the next track's fill the moment the current one loads, so two
     * fills raced roughly 15 ms apart and the playing track's tail range came back 403. The
     * whole-file fallback, issued while the other fill was still going, was refused in turn,
     * and the track died.
     *
     * The warmed track waits, which is the right way round: it is an optimisation, and the one
     * making sound is not.
     */
    let _fill_permit = PLAYBACK_FILL_LOCK.acquire().await;

    // The wait for the permit above is where a superseded fill most likely spent its time —
    // recheck now, before spending a request on a track that moved on while this was queued.
    if load_superseded(slot) {
        eprintln!(
            "[internal][tauri][info] fill_media_buffer superseded before start track_id={}",
            track_id
        );
        return;
    }

    let Ok(request_url) = url::Url::parse(&url) else {
        fail(&buffer);
        return;
    };
    let client = http_client(signed_googlevideo_local_address(&request_url));

    let mut stream = futures_util::stream::iter(ranges.into_iter().enumerate().map(
        |(index, (start, end))| {
            let client = client.clone();
            let url = url.clone();
            let cookie = cookie.clone();
            let abandoned = Arc::clone(&buffer);
            async move {
                /*
                 * Checked here rather than between chunks because `buffered(1)` starts the next
                 * request as soon as it is polled — by the time the outer loop could look, the
                 * range is already in flight. `failed` is set by whoever gave up on the body:
                 * the fill itself, or a decode that could not use it. `load_superseded` catches
                 * the third way a range stops mattering: a newer load took this slot, and this
                 * one is still going only because nothing had told it to stop.
                 */
                if abandoned.lock().map(|guard| guard.failed).unwrap_or(true)
                    || load_superseded(slot)
                {
                    return Err((index, cache_error("fill abandoned")));
                }
                /*
                 * Retried before it is given up on. A 403 on a range is usually transient —
                 * googlevideo throttling rather than a URL that has gone bad — and abandoning
                 * the assembly on the first one sent every such track down the whole-file
                 * path, which can be refused in turn and then the play simply fails.
                 */
                let ranged = audio_url_with_range(&url, start as u64, end as u64);
                let mut backoff = PLAYBACK_RETRY_BACKOFF;
                let mut last: CommandError = cache_error("range never attempted");

                for attempt in 0..PLAYBACK_RANGE_ATTEMPTS {
                    // Re-checked every attempt: a supersede mid-backoff must not spend the next
                    // request anyway, and this is what stops it doing that.
                    if load_superseded(slot) {
                        return Err((index, cache_error("fill abandoned")));
                    }
                    if attempt > 0 {
                        tokio::time::sleep(backoff).await;
                        backoff *= 2;
                    }
                    match googlevideo_audio_request(&client, &ranged, cookie.as_deref())
                        .send()
                        .await
                    {
                        Ok(response) if response.status().is_success() => {
                            match response.bytes().await {
                                Ok(body) => return Ok((index, body.to_vec())),
                                Err(error) => {
                                    last = cache_error(format!("audio range read failed: {error}"));
                                }
                            }
                        }
                        Ok(response) => {
                            last = cache_error(format!("range returned {}", response.status()));
                        }
                        Err(error) => {
                            last = cache_error(format!("audio range request failed: {error}"));
                        }
                    }
                }
                Err::<(usize, Vec<u8>), (usize, CommandError)>((index, last))
            }
        },
    ))
    .buffered(1);

    while let Some(result) = stream.next().await {
        match result {
            Ok((index, body)) => {
                // The first chunk is the only one that can prove the container.
                if index == 0 {
                    if let Err(error) = verify_audio_container(&body, &mime_type) {
                        eprintln!(
                            "[internal][tauri][warn] fill_media_buffer bad container track_id={} error={}",
                            track_id, error.message
                        );
                        fail(&buffer);
                        return;
                    }
                }
                match buffer.lock() {
                    Ok(mut guard) => guard.put(index, body),
                    Err(_) => return,
                }
            }
            Err((index, error)) => {
                /*
                 * An abandoned fill must not fall back — the fallback downloads the *whole*
                 * body, which is precisely the work being called off. Only a genuine refusal
                 * gets the retry below.
                 */
                if buffer.lock().map(|guard| guard.failed).unwrap_or(true) {
                    eprintln!(
                        "[internal][tauri][info] fill_media_buffer abandoned track_id={}",
                        track_id
                    );
                    return;
                }
                // Same reasoning, for the one case above cannot see: superseded rather than
                // failed. The whole-file fallback below is the expensive part of this function —
                // not worth starting for a track nobody is playing or preloading any more.
                if load_superseded(slot) {
                    eprintln!(
                        "[internal][tauri][info] fill_media_buffer superseded, skipping fallback track_id={}",
                        track_id
                    );
                    return;
                }
                /*
                 * One refused range is not a dead track.
                 *
                 * googlevideo answers 403 on individual ranges often enough that the ranged
                 * fetcher has always fallen back to a single whole-file request — this task
                 * lost that when it was split out, so a transient refusal became a failed
                 * play. Slower, but it is the path that has always worked.
                 */
                eprintln!(
                    "[internal][tauri][warn] fill_media_buffer chunk {} failed ({}) falling back track_id={}",
                    index, error.message, track_id
                );
                drop(stream);
                match fetch_audio_bytes(url.clone(), track_id.clone(), cookie.clone()).await {
                    Ok(whole) if !whole.is_empty() => {
                        if verify_audio_container(&whole, &mime_type).is_err() {
                            fail(&buffer);
                            return;
                        }
                        if let Ok(mut guard) = buffer.lock() {
                            guard.adopt_complete(whole);
                        }
                    }
                    _ => fail(&buffer),
                }
                return;
            }
        }
    }
}

/* ---------------------------------------------------------------------------------------- *
 * Native audio engine
 *
 * The `<audio>` path above hands bytes to the webview over loopback HTTP and lets Chromium
 * decode them. These commands hand the same bytes to symphonia instead, so nothing leaves the
 * Rust process — no media server round trip, no second copy of the song in the renderer, and
 * two real decks to fade between. `audio.rs` owns the decoding and output; this layer only
 * resolves a source into something readable and forwards the request.
 * ---------------------------------------------------------------------------------------- */

/**
 * Where a track's bytes come from. The three cases the player actually has.
 *
 * Each variant carries its **own** `rename_all`. The container attribute renames the *variants*
 * — which is what matches `kind: "stream"` — and does nothing at all to the fields inside them,
 * so with only the outer one this asked the frontend for `mime_type` and rejected every load
 * with "missing field `mime_type`". `rename_all_fields` would also work; this spells it out per
 * variant so a serde downgrade cannot quietly take it away again.
 */
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
enum NativeAudioSource {
    /// A signed googlevideo URL, decoded as it downloads.
    #[serde(rename_all = "camelCase")]
    Stream {
        url: String,
        mime_type: String,
        cookie: Option<String>,
    },
    /// A track already in the offline store.
    #[serde(rename_all = "camelCase")]
    Offline { track_id: String, mime_type: String },
    /// A file the user pointed at a music folder.
    #[serde(rename_all = "camelCase")]
    File { path: String },
}

/**
 * Opens a source as a blocking reader.
 *
 * The streaming case is the interesting one: it publishes an empty buffer sized from the URL's
 * own `clen`, starts the same ranged fill the media server uses, and returns a reader over it
 * straight away. The decoder then reads the container header out of the head chunk while the
 * rest is still arriving — which is the whole difference from the `<audio>` path, where the
 * body had to be published before an element could be pointed at it.
 *
 * `standby` picks the load slot for `LOAD_GENERATION`: this load's fill becomes the one worth
 * waiting for in its slot, and whatever fill was previously running there — a track that has
 * since died, been skipped, or already played out — is now free to abandon instead of running
 * its retries and fallback to completion.
 */
fn open_native_audio_reader(
    app: &tauri::AppHandle,
    track_id: &str,
    source: NativeAudioSource,
    standby: bool,
) -> Result<NativeAudioReader, CommandError> {
    match source {
        NativeAudioSource::Stream {
            url,
            mime_type,
            cookie,
        } => {
            let request_url = url::Url::parse(&url)
                .map_err(|error| cache_error(format!("audio URL parse failed: {error}")))?;
            let total = signed_content_length(&request_url).unwrap_or(0) as usize;
            if total == 0 {
                return Err(cache_error("audio URL declared no length"));
            }

            let ranges = playback_ranges(total);
            let buffer = Arc::new(Mutex::new(MediaBuffer::pending(total, ranges.len())));
            let slot_index = standby as usize;
            let generation = LOAD_GENERATION[slot_index].fetch_add(1, Ordering::SeqCst) + 1;
            tauri::async_runtime::spawn(fill_media_buffer(
                url,
                track_id.to_string(),
                cookie,
                mime_type.clone(),
                Arc::clone(&buffer),
                ranges,
                Some((slot_index, generation)),
            ));
            Ok(NativeAudioReader {
                reader: Box::new(audio::BufferReader::new(Arc::clone(&buffer))),
                mime_type,
                buffer: Some(buffer),
            })
        }
        NativeAudioSource::Offline { track_id, mime_type } => {
            let path = offline_entry_path(app, &track_id)?;
            let mut file = File::open(&path)
                .map_err(|error| cache_error(format!("offline read failed: {error}")))?;
            Ok(NativeAudioReader {
                mime_type: sniffed_mime(&mut file, mime_type, &track_id),
                reader: Box::new(file),
                buffer: None,
            })
        }
        NativeAudioSource::File { path } => {
            let path = PathBuf::from(path);
            // Re-validated here rather than trusted from the frontend, exactly as
            // `local_audio_read` does — this is the same trust boundary.
            if !path.is_file() || !is_local_audio_file(&path) {
                return Err(cache_error("local audio file is unavailable."));
            }
            // The extension is the only codec hint a local file carries, and it is a claim
            // rather than a fact — the bytes below get the final say.
            let declared = local_audio_mime_type(&path).to_string();
            let mut file = File::open(&path)
                .map_err(|error| cache_error(format!("local audio read failed: {error}")))?;
            let label = path.file_name().and_then(|name| name.to_str()).unwrap_or("file");
            Ok(NativeAudioReader {
                mime_type: sniffed_mime(&mut file, declared, label),
                reader: Box::new(file),
                buffer: None,
            })
        }
    }
}

/**
 * The container a stored body really is, preferring its own bytes over what was declared.
 *
 * Only for things already on disk. A *stream* keeps its declared type: that came from the format
 * selection which produced the very URL being fetched, so it cannot drift, and sniffing it would
 * mean waiting on the network before choosing a decoder.
 */
fn sniffed_mime(
    file: &mut File,
    declared: String,
    label: &str,
) -> String {
    match opus_source::sniff_container_mime(file) {
        Ok(Some(sniffed)) if sniffed != declared => {
            eprintln!(
                "[internal][tauri][info] container sniffed {} declared={} actual={}",
                label, declared, sniffed
            );
            sniffed.to_string()
        }
        Ok(_) => declared,
        // Unreadable here means unreadable for the decoder too; let that report it.
        Err(_) => declared,
    }
}

/**
 * A reader, plus the buffer behind it when one is still filling.
 *
 * The buffer comes back so a *failed* decode can abandon the download. Without it a track whose
 * codec symphonia cannot handle still pulled its whole body over the network — and, worse, held
 * `PLAYBACK_FILL_LOCK` while doing it, so every refusal delayed the next real load.
 */
struct NativeAudioReader {
    /// `MediaSource` is `Read + Seek + Send + Sync` plus a length — exactly what symphonia's
    /// probe needs and a superset of what rodio's decoder does, so one box serves both.
    reader: Box<dyn symphonia::core::io::MediaSource>,
    /// The declared codec, which is what decides *which* decoder gets the box.
    mime_type: String,
    buffer: Option<Arc<Mutex<MediaBuffer>>>,
}



/**
 * Decodes a track onto a deck.
 *
 * `standby` loads it onto the idle deck instead of the playing one, which is what
 * `native_audio_transition` later swaps to. Returns the duration actually decoded, falling back
 * to the provider's when the container declares none — Opus in WebM usually does not.
 *
 * The decode runs on a blocking pool thread, not on the audio thread: building a decoder reads
 * the container header, and for a stream that means waiting on the network. Doing it here keeps
 * the audio thread free to go on reporting the position of the track that is still playing.
 */
#[tauri::command]
async fn native_audio_load(
    app: tauri::AppHandle,
    state: tauri::State<'_, audio::NativeAudio>,
    track_id: String,
    source: NativeAudioSource,
    duration_sec: Option<f64>,
    standby: Option<bool>,
    loudness_db: Option<f32>,
) -> Result<f64, CommandError> {
    let NativeAudioReader { reader, mime_type, buffer } =
        open_native_audio_reader(&app, &track_id, source, standby.unwrap_or(false))?;
    let started_at = Instant::now();

    let decoded = tauri::async_runtime::spawn_blocking(move || {
        /*
         * Opus goes to libopus, everything else to rodio.
         *
         * Not a preference — symphonia has no Opus decoder at all, and rodio can only offer
         * what symphonia implements. WebM/Opus is the majority of what YouTube serves at
         * `high`, and the only audio offered for a large share of tracks, so this branch is
         * most of playback rather than an edge case.
         */
        if opus_source::is_opus(&mime_type) {
            return opus_source::OpusSource::new(reader, &mime_type)
                .map(|source| equalized(source, loudness_db));
        }
        rodio::Decoder::new(reader)
            .map(|source| equalized(source, loudness_db))
            .map_err(|error| format!("audio decode failed: {error}"))
    })
    .await
    .map_err(|error| cache_error(format!("audio decode task failed: {error}")))?;

    /*
     * A decode that failed has no reader left, so the fill behind it is downloading a body
     * nobody will ever read. Marking the buffer stops it at its next range and, more to the
     * point, gives up the fill permit — otherwise a run of undecodable tracks queues a run of
     * pointless downloads in front of the next one that would have played.
     */
    let (decoded, decoded_duration) = match decoded {
        Ok(decoded) => decoded,
        Err(message) => {
            // Read before `failed` is set — the preview is what actually arrived, and setting
            // the flag first would not change these bytes, only make the intent read backwards.
            let preview = buffer.as_ref().and_then(|buffer| {
                let guard = buffer.lock().ok()?;
                let available = guard.contiguous_len();
                Some(bytes_preview(&guard.read(0, available.saturating_sub(1))))
            });
            if let Some(buffer) = &buffer {
                if let Ok(mut guard) = buffer.lock() {
                    guard.failed = true;
                }
            }
            eprintln!(
                "[internal][tauri][warn] native_audio_load decode failed track_id={} error={} preview=[{}]",
                track_id, message, preview.as_deref().unwrap_or("no stream buffer"),
            );
            return Err(cache_error(message));
        }
    };

    /*
     * The deck's window onto its own download.
     *
     * A deck is reported loaded as soon as the decoder can read the container header out of the
     * head chunk, while the rest of the file is still arriving. If that fill then fails — and
     * googlevideo refuses individual ranges often enough that it does — the deck still holds a
     * real source with a real duration, and nothing about it looks wrong until it is played and
     * stops after a few seconds. Handing the deck a probe is what lets `HasStandby` and
     * `Transition` refuse it instead of swapping into a track that cannot finish.
     *
     * Offline and local files pass `None`: their bytes are already on disk, so there is no
     * fill to fail.
     */
    let health: Option<audio::DeckHealth> = buffer.map(|buffer| {
        Arc::new(move || buffer.lock().map(|guard| !guard.failed).unwrap_or(false))
            as audio::DeckHealth
    });

    let duration = audio::request(&state, |reply| audio::Command::Load {
        track_id: track_id.clone(),
        source: decoded,
        fallback_duration_sec: duration_sec.unwrap_or(0.0),
        decoded_duration_sec: decoded_duration,
        standby: standby.unwrap_or(false),
        health,
        reply,
    })
    .map_err(cache_error)?
    .map_err(cache_error)?;

    eprintln!(
        "[internal][tauri][info] native_audio_load track_id={} standby={} duration_sec={} decode_ms={}",
        track_id,
        standby.unwrap_or(false),
        duration,
        started_at.elapsed().as_millis()
    );
    Ok(duration)
}

/**
 * Puts the equaliser and a limiter between a decoded stream and its deck.
 *
 * The limiter is not decoration. Ten bands boosted 12 dB is far more headroom than a normalised
 * track has, and without it the sum clips into distortion that sounds like a broken decoder
 * rather than like an equaliser set too high. rodio ships one, so this is a line.
 *
 * The duration is read *before* wrapping: it is what the caller reports back to the frontend,
 * and reading it through two adapters is one more place for it to go missing.
 */
fn equalized<S>(source: S, loudness_db: Option<f32>) -> (audio::BoxedSource, Option<f64>)
where
    S: rodio::Source + Send + 'static,
{
    use rodio::Source as _;
    let duration = source.total_duration().map(|value| value.as_secs_f64());
    let shaped = equalizer::EqualizedSource::new(source, loudness_db)
        .limit(rodio::source::LimitSettings::new());
    (Box::new(shaped) as audio::BoxedSource, duration)
}

/// Volume normalisation from each track's measured loudness. Applies immediately, and never
/// starts the audio thread.
#[tauri::command]
fn native_audio_set_normalization(enabled: bool) {
    equalizer::set_normalize(enabled);
}

/// The ten band gains and the preamp, in dB. Applies to whatever is playing, immediately.
#[tauri::command(async)]
fn native_audio_set_equalizer(preamp_db: f32, bands_db: Vec<f32>) -> Result<(), CommandError> {
    if bands_db.len() != equalizer::BAND_COUNT {
        return Err(cache_error(format!(
            "equaliser expects {} bands, got {}",
            equalizer::BAND_COUNT,
            bands_db.len()
        )));
    }
    let mut values =
        equalizer::EqualizerValues { preamp_db, bands_db: [0.0; equalizer::BAND_COUNT] };
    values.bands_db.copy_from_slice(&bands_db);
    equalizer::set_values(values);
    Ok(())
}

#[tauri::command(async)]
fn native_audio_play(state: tauri::State<'_, audio::NativeAudio>) -> Result<(), CommandError> {
    audio::request(&state, audio::Command::Play)
        .map_err(cache_error)?
        .map_err(cache_error)
}

#[tauri::command(async)]
fn native_audio_pause(state: tauri::State<'_, audio::NativeAudio>) -> Result<(), CommandError> {
    state.send(audio::Command::Pause).map_err(cache_error)
}

#[tauri::command(async)]
fn native_audio_stop(state: tauri::State<'_, audio::NativeAudio>) -> Result<(), CommandError> {
    state.send(audio::Command::Stop).map_err(cache_error)
}

#[tauri::command(async)]
fn native_audio_seek(
    state: tauri::State<'_, audio::NativeAudio>,
    position_sec: f64,
) -> Result<(), CommandError> {
    state
        .send(audio::Command::Seek(position_sec))
        .map_err(cache_error)
}

#[tauri::command(async)]
fn native_audio_set_volume(
    state: tauri::State<'_, audio::NativeAudio>,
    volume: f32,
    muted: bool,
) -> Result<(), CommandError> {
    state
        .send(audio::Command::Volume { volume, muted })
        .map_err(cache_error)
}

/// Playback speed, which keeps pitch, and pitch as a frequency ratio, which keeps speed.
#[tauri::command(async)]
fn native_audio_set_rate(
    state: tauri::State<'_, audio::NativeAudio>,
    rate: f32,
    pitch: Option<f32>,
) -> Result<(), CommandError> {
    let command = audio::Command::Rate { speed: rate, pitch: pitch.unwrap_or(1.0) };
    state.send(command).map_err(cache_error)
}

/// Hands playback to the standby deck, over an equal-power crossfade when `fade_ms` is above
/// zero and in a single step when it is not. False means nothing was preloaded and the caller
/// should load normally.
#[tauri::command(async)]
fn native_audio_transition(
    state: tauri::State<'_, audio::NativeAudio>,
    track_id: String,
    fade_ms: u64,
) -> Result<bool, CommandError> {
    audio::request(&state, |reply| audio::Command::Transition {
        track_id,
        fade_ms,
        reply,
    })
    .map_err(cache_error)
}

#[tauri::command(async)]
fn native_audio_has_standby(
    state: tauri::State<'_, audio::NativeAudio>,
    track_id: String,
) -> Result<bool, CommandError> {
    audio::request(&state, |reply| audio::Command::HasStandby { track_id, reply })
        .map_err(cache_error)
}

#[tauri::command(async)]
fn native_audio_drop_standby(
    state: tauri::State<'_, audio::NativeAudio>,
) -> Result<(), CommandError> {
    state.send(audio::Command::DropStandby).map_err(cache_error)
}

/// Abandons the active deck's load without touching a standby that may already hold the next
/// track. See `Command::DropActive`.
#[tauri::command(async)]
fn native_audio_drop_active(
    state: tauri::State<'_, audio::NativeAudio>,
) -> Result<(), CommandError> {
    state.send(audio::Command::DropActive).map_err(cache_error)
}

/// Arms the audio thread to start the standby itself when this track runs dry. See
/// `Command::QueueNext`; `None` disarms.
#[tauri::command(async)]
fn native_audio_queue_next(
    state: tauri::State<'_, audio::NativeAudio>,
    track_id: Option<String>,
) -> Result<(), CommandError> {
    state.send(audio::Command::QueueNext(track_id)).map_err(cache_error)
}

/// Devices cpal can currently see, for the output-device picker in Settings.
#[tauri::command(async)]
fn native_audio_list_output_devices() -> Result<Vec<audio::AudioOutputDevice>, CommandError> {
    audio::list_output_devices().map_err(cache_error)
}

/// Switches the device the Rust engine plays to, by the `id` `native_audio_list_output_devices`
/// reported. `id: None` is the OS default. See `NativeAudio::set_output_device` for what this
/// does before playback has started versus during it — the latter clears both decks, so the
/// frontend reloads whatever was playing.
#[tauri::command(async)]
fn native_audio_set_output_device(
    state: tauri::State<'_, audio::NativeAudio>,
    id: Option<String>,
) -> Result<(), CommandError> {
    state.set_output_device(id).map_err(cache_error)
}

/// Rejects targets a compromised renderer could use to reach the machine or its LAN.
fn is_public_http_target(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => {
            matches!(url.scheme(), "https" | "http") && !host.eq_ignore_ascii_case("localhost")
        }
        Some(url::Host::Ipv4(ip)) => {
            !(ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified())
        }
        Some(url::Host::Ipv6(ip)) => {
            !(ip.is_loopback() || ip.is_unspecified() || ip.is_unique_local() || ip.is_unicast_link_local())
        }
        None => false,
    }
}

/// `[u32 LE meta length][meta JSON][body]`: binary IPC, so bodies are never base64-inflated.
fn framed_response(meta: &impl Serialize, body: &[u8]) -> Result<tauri::ipc::Response, CommandError> {
    let meta = serde_json::to_vec(meta).map_err(|error| cache_error(error.to_string()))?;
    let mut frame = Vec::with_capacity(4 + meta.len() + body.len());
    frame.extend_from_slice(&(meta.len() as u32).to_le_bytes());
    frame.extend_from_slice(&meta);
    frame.extend_from_slice(body);
    Ok(tauri::ipc::Response::new(frame))
}

#[tauri::command]
async fn proxy_http_request(
    app: tauri::AppHandle,
    jar: tauri::State<'_, YoutubeCookieJar>,
    account_lock: tauri::State<'_, AccountStoreLock>,
    mut input: ProxyHttpRequestInput,
) -> Result<tauri::ipc::Response, CommandError> {
    let started_at = Instant::now();
    let request_url = url::Url::parse(&input.url)
        .ok()
        .filter(is_public_http_target)
        .ok_or_else(|| cache_error("URL is not an allowed request target"))?;
    let request_target = format!(
        "{}://{}{}",
        request_url.scheme(),
        request_url.host_str().unwrap_or("unknown"),
        request_url.path()
    );

    // Outgoing cookies come from the jar: a long-lived youtubei.js session would replay a stale one.
    // Only requests already carrying a Cookie are stamped, so the anonymous download client stays so.
    let youtube_host = is_youtube_cookie_host(&request_url);
    if youtube_host {
        let live_cookie = jar.0.lock().ok().and_then(|state| state.cookie.clone());
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

    let method = reqwest::Method::from_bytes(input.method.as_bytes())
        .map_err(|error| cache_error(format!("invalid method: {error}")))?;
    let mut request = http_client(signed_googlevideo_local_address(&request_url))
        .request(method, request_url.clone());
    if !input.headers.keys().any(|key| key.eq_ignore_ascii_case("user-agent")) {
        request = request.header(reqwest::header::USER_AGENT, BROWSER_USER_AGENT);
    }
    for (key, value) in &input.headers {
        request = request.header(key, value);
    }
    if let Some(timeout_ms) = input.timeout_ms {
        request = request.timeout(Duration::from_millis(timeout_ms));
    }
    if let Some(body_base64) = input.body_base64 {
        let bytes = STANDARD
            .decode(body_base64)
            .map_err(|error| cache_error(format!("invalid body encoding: {error}")))?;
        request = request.body(bytes);
    }

    let response = request.send().await.map_err(|error| {
        // The cause chain holds the real reason (DNS, TLS, reset); Display alone hides it.
        let cause = error_cause_chain(&error);
        eprintln!("[internal][tauri][error] proxy_http_request failed url={request_target} error={cause}");
        cache_error(format!("request failed: {cause}"))
    })?;

    let status = response.status().as_u16();
    // Collected before the header map flattens them: one response can set several cookies.
    let refreshed_cookie = if youtube_host {
        let set_cookies = response
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok().map(str::to_string))
            .collect::<Vec<_>>();
        (!set_cookies.is_empty())
            .then(|| refresh_youtube_cookie_jar(&app, &jar, &account_lock, &set_cookies))
            .flatten()
    } else {
        None
    };
    let headers: HashMap<String, String> = response
        .headers()
        .iter()
        .filter_map(|(key, value)| Some((key.to_string(), value.to_str().ok()?.to_string())))
        .collect();
    let body = response.bytes().await.map_err(|error| {
        eprintln!("[internal][tauri][error] proxy_http_request body read failed url={request_target} error={error}");
        cache_error(format!("read body failed: {error}"))
    })?;

    eprintln!(
        "[internal][tauri][info] proxy_http_request {} url={} status={} bytes={} duration_ms={}",
        input.method,
        request_target,
        status,
        body.len(),
        started_at.elapsed().as_millis()
    );
    framed_response(&ProxyHttpResponse { status, headers, cookie: refreshed_cookie }, &body)
}

// Arguments mirror the JS payload one-to-one; a wrapper struct would only rename them.
#[allow(clippy::too_many_arguments)]
#[tauri::command(async)]
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

#[tauri::command(async)]
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

/// The compositor the app is running under, so the frontend can decide whether the
/// window manager already provides window management (tiling compositors) or the app
/// must draw its own buttons.
#[tauri::command(async)]
fn desktop_environment() -> String {
    std::env::var("XDG_CURRENT_DESKTOP")
        .or_else(|_| std::env::var("XDG_SESSION_DESKTOP"))
        .unwrap_or_default()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Initialize Discord RPC manager
    let discord_manager =
        std::sync::Arc::new(std::sync::Mutex::new(discord_rpc::DiscordRpcManager::new()));

    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        /*
         * First among plugins, per the plugin's own docs — it is the one deciding whether this
         * process gets to keep running at all, so everything else registering a window, a tray
         * icon or a background task first would be work thrown away the instant a second launch
         * turns out to be redundant.
         *
         * The callback runs in the *original* process when a second launch is attempted; a
         * second launch's own `main` never reaches this builder at all, since the plugin exits
         * it immediately. Reuses the tray's own "bring to front" — a second launch is exactly
         * that, wherever it came from.
         */
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .manage(CacheLock(Mutex::new(None)))
        .manage(AppSettings::default())
        .manage(AccountStoreLock(Mutex::new(())))
        .manage(YoutubeCookieJar(Mutex::new(CookieJarState::default())))
        .manage(discord_manager)
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(not(debug_assertions))]
    {
        let port = ui_port();
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
            /*
             * The audio thread and its output device are not opened here — `NativeAudio` starts
             * them on the first command. A listener on the IFrame engine should never claim a
             * handle from the OS mixer for a decoder they will not use.
             */
            app.manage(audio::NativeAudio::new(app.handle().clone()));
            // Before the log is initialised, so a first run after the rename still logs to
            // the directory the user's settings were just restored into.
            migrate_legacy_app_data(app.handle());
            install_panic_logger();
            if let Err(error) = initialize_app_log(app.handle()) {
                std::eprintln!("[internal][tauri][warn] {}", error.message);
            }
            // A missing or outdated WebView2 is the usual cause of a window that never paints.
            match tauri::webview_version() {
                Ok(version) => eprintln!("[internal][tauri][info] webview version={version}"),
                Err(error) => eprintln!("[internal][tauri][warn] webview version unavailable: {error}"),
            }
            #[cfg(target_os = "linux")]
            linux_media::mirror_volume(app.handle());
            // Always built, so toggling the setting takes effect without a restart.
            if let Err(error) = build_tray(app.handle()) {
                std::eprintln!("[internal][tauri][warn] tray unavailable: {error}");
            }
            set_tray_visible(app.handle(), minimize_to_tray_enabled(app.handle()));
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
            tauri::WindowEvent::Focused(true) if window.label() == "main" => {
                if let Some(main) = window.app_handle().get_webview_window("main") {
                    set_webview_memory_low(&main, false);
                }
                let _ = window.app_handle().emit("window-focused", ());
            }
            // Minimise and restore both arrive as resizes.
            tauri::WindowEvent::Resized(_) if window.label() == "main" => {
                if let Some(main) = window.app_handle().get_webview_window("main") {
                    set_webview_memory_low(&main, main.is_minimized().unwrap_or(false));
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            desktop_environment,
            quit_app,
            frontend_log,
            app_setting_get,
            app_setting_set,
            app_setting_remove,
            app_settings_clear,
            open_current_log,
            fetch_audio_source,
            offline_audio_save,
            offline_audio_source,
            offline_audio_remove,
            offline_audio_list,
            offline_artwork_save,
            offline_artwork,
            offline_audio_prune,
            native_audio_load,
            native_audio_play,
            native_audio_pause,
            native_audio_stop,
            native_audio_seek,
            native_audio_set_volume,
            native_audio_set_rate,
            native_audio_transition,
            native_audio_has_standby,
            native_audio_drop_standby,
            native_audio_drop_active,
            native_audio_queue_next,
            native_audio_set_equalizer,
            native_audio_set_normalization,
            native_audio_list_output_devices,
            native_audio_set_output_device,
            media_server_release,
            proxy_http_request,
            load_youtube_music_cookie,
            sign_in_youtube_music,
            refresh_youtube_music_cookie,
            delete_youtube_music_cookie,
            list_youtube_music_accounts,
            switch_youtube_music_account,
            remove_youtube_music_account,
            update_youtube_music_account_profile,
            cache_get,
            cache_set,
            cache_stats,
            cache_set_max_bytes,
            cache_clear,
            local_audio_scan,
            local_audio_read,
            import_text_file,
            export_text_file,
            local_audio_read_tags,
            local_audio_artwork,
            read_image_file,
            process_memory::app_memory_report,
            local_audio_write_tags,
            local_audio_watch,
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
        apply_set_cookie, audio_url_with_range, cookie_account_identity, cookie_domain_matches,
        error_cause_chain, is_slow_persist_cookie, is_youtube_cookie_host, parse_cookie_header, sanitize_log_url,
        audio_chunk_size, playback_ranges, serialize_cookie_pairs, MediaBuffer, AUDIO_HEAD_CHUNK_BYTES, signed_content_length, store_media_item,
        MediaItem, AUDIO_MIN_CHUNK_BYTES, MEDIA_SERVER_MAX_ITEMS, OFFLINE_CHUNK_BYTES,
        load_superseded, LOAD_GENERATION, bytes_preview,
        YoutubeAccountStore, generate_slot_id, login_partition_directory_name,
        decode_slot_id_bytes, LEGACY_ACCOUNT_SLOT_ID,
        enforce_cache_limit, is_public_http_target, load_settings_file, write_settings_file, SettingsMap,
    };
    use std::sync::atomic::Ordering;
    use super::audio::BufferReader;
    use super::NativeAudioSource;
    use std::collections::HashMap;
    use std::io::{Read, Seek, SeekFrom};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    // The #171 fallback: only this Windows user can open the file, and garbage is refused.
    #[cfg(windows)]
    #[test]
    fn dpapi_round_trips_and_rejects_foreign_bytes() {
        let sealed = super::dpapi(b"SAPISID=abc", true).unwrap();
        assert_ne!(sealed.as_slice(), b"SAPISID=abc");
        assert_eq!(super::dpapi(&sealed, false).unwrap(), b"SAPISID=abc");
        assert!(super::dpapi(b"not a dpapi blob", false).is_err());
    }

    // Replacing must not depend on deleting the old file first, or a failed save loses it (#155).
    #[test]
    fn write_json_file_replaces_an_existing_file() {
        let dir = std::env::temp_dir().join(format!("zuno-write-json-{}", std::process::id()));
        let path = dir.join("settings-v1.json");
        assert!(super::write_json_file(&path, &HashMap::from([("minimize-to-tray", false)])).is_ok());
        assert!(super::write_json_file(&path, &HashMap::from([("minimize-to-tray", true)])).is_ok());

        let saved: HashMap<String, bool> =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved.get("minimize-to-tray"), Some(&true));
        assert!(!path.with_extension("tmp").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    // Every request goes through this builder; a root reqwest refuses would break all of them (#143).
    fn scratch_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("zuno-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn settings_survive_a_corrupt_file_via_the_backup() {
        let path = scratch_dir("settings").join("settings.json");
        let mut first = SettingsMap::new();
        first.insert("theme".into(), serde_json::json!("dark"));
        write_settings_file(&path, &first).unwrap();
        let mut second = first.clone();
        second.insert("volume".into(), serde_json::json!(0.5));
        write_settings_file(&path, &second).unwrap();
        assert_eq!(load_settings_file(&path), second);

        // A torn or corrupt write falls back to the previous good file instead of starting empty.
        std::fs::write(&path, b"{\"theme\": ").unwrap();
        assert_eq!(load_settings_file(&path), first);
        std::fs::write(&path, b"").unwrap();
        assert_eq!(load_settings_file(&path), first);
    }

    #[test]
    fn cache_eviction_drops_least_recently_used_first() {
        let dir = scratch_dir("cache");
        let now = std::time::SystemTime::now();
        for (index, name) in ["old", "mid", "new"].iter().enumerate() {
            let path = dir.join(format!("{name}.json"));
            std::fs::write(&path, vec![b'x'; 100]).unwrap();
            let age = std::time::Duration::from_secs(30 - index as u64 * 10);
            std::fs::File::options().write(true).open(&path).unwrap().set_modified(now - age).unwrap();
        }
        assert_eq!(enforce_cache_limit(&dir, 1_000), 300, "under the cap nothing is evicted");
        assert_eq!(enforce_cache_limit(&dir, 250), 200);
        assert!(!dir.join("old.json").exists() && dir.join("mid.json").exists() && dir.join("new.json").exists());
    }

    #[test]
    fn proxy_refuses_local_and_private_targets() {
        let allowed = |url: &str| is_public_http_target(&url::Url::parse(url).unwrap());
        assert!(allowed("https://music.youtube.com/youtubei/v1/browse"));
        assert!(allowed("https://8.8.8.8/"));
        for blocked in [
            "http://localhost:47731/",
            "http://127.0.0.1/",
            "http://192.168.1.1/admin",
            "http://10.0.0.2/",
            "http://169.254.169.254/latest/meta-data",
            "http://[::1]/",
            "http://[fd00::1]/",
            "file:///C:/Windows/win.ini",
        ] {
            assert!(!allowed(blocked), "{blocked}");
        }
    }

    #[test]
    fn media_buffer_reads_across_chunks_into_a_slice() {
        let mut buffer = MediaBuffer::pending(6, 3);
        buffer.put(0, vec![1, 2]);
        buffer.put(1, vec![3, 4]);
        let mut out = [0u8; 4];
        assert_eq!(buffer.read_into(1, &mut out), 3, "stops at the first missing chunk");
        assert_eq!(&out[..3], &[2, 3, 4]);
        buffer.put(2, vec![5, 6]);
        assert_eq!(buffer.read_into(1, &mut out), 4);
        assert_eq!(out, [2, 3, 4, 5]);
    }

    #[test]
    fn http_client_builds_with_the_os_trust_store() {
        let _ = super::http_client(None);
    }

    /**
     * Which decoder a track is sent to.
     *
     * The consequence of getting this wrong is not a fallback, it is a failed load: rodio
     * cannot decode Opus at all, and libopus cannot read anything else. The `audio/mp4` case is
     * the one that already worked when every WebM track was failing, so it is the one that must
     * not start being routed to libopus.
     */
    #[test]
    fn opus_routing_follows_the_declared_codec() {
        use super::opus_source::is_opus;

        // What YouTube actually serves at `high` — 13 of 14 resolves in the log that found this.
        assert!(is_opus(r#"audio/webm; codecs="opus""#));
        assert!(is_opus("audio/opus"), "a local .opus file");
        assert!(is_opus("audio/webm"), "WebM carries no other audio codec worth guessing");
        assert!(is_opus("AUDIO/WEBM; CODECS=\"OPUS\""), "the header case is not ours to assume");

        assert!(!is_opus(r#"audio/mp4; codecs="mp4a.40.2""#), "AAC is rodio's");
        assert!(!is_opus("audio/flac"));
        assert!(!is_opus("audio/mpeg"));
        // Ogg is Vorbis far more often than Opus, and rodio has a Vorbis decoder. An Opus
        // stream in an `.ogg` wrapper is the one shape this deliberately misroutes.
        assert!(!is_opus("audio/ogg"));
    }

    /**
     * The exact JSON `rustAudio.ts` puts on the wire.
     *
     * A cross-language boundary that neither `tsc` nor `cargo` can see across: TypeScript sends
     * `mimeType`, and `#[serde(rename_all)]` on an *enum* renames its variants and not their
     * fields, so every load was rejected with "missing field `mime_type`" while both sides
     * compiled and every other check passed. The payloads below are copied from the invoke
     * calls; keep them that way.
     */
    #[test]
    fn native_audio_source_parses_what_the_frontend_sends() {
        let stream = serde_json::from_str::<NativeAudioSource>(
            r#"{"kind":"stream","url":"https://r1.googlevideo.com/videoplayback?clen=99","mimeType":"audio/webm; codecs=\"opus\"","cookie":"SAPISID=x"}"#,
        )
        .expect("stream source");
        match stream {
            NativeAudioSource::Stream { url, mime_type, cookie } => {
                assert!(url.contains("googlevideo"));
                assert_eq!(mime_type, "audio/webm; codecs=\"opus\"");
                assert_eq!(cookie.as_deref(), Some("SAPISID=x"));
            }
            _ => panic!("kind did not select the stream variant"),
        }

        // The cookie is absent when the session is signed out, and absent must not mean invalid.
        let anonymous = serde_json::from_str::<NativeAudioSource>(
            r#"{"kind":"stream","url":"https://r1.googlevideo.com/videoplayback","mimeType":"audio/mp4"}"#,
        );
        assert!(anonymous.is_ok(), "a missing cookie is a signed-out session, not an error");

        let offline = serde_json::from_str::<NativeAudioSource>(
            r#"{"kind":"offline","trackId":"dQw4w9WgXcQ","mimeType":"audio/webm; codecs=\"opus\""}"#,
        )
        .expect("offline source");
        // The mime type rides along because a downloaded body has no extension to read it from,
        // and it is what decides whether libopus or rodio gets the file.
        match offline {
            NativeAudioSource::Offline { track_id, mime_type } => {
                assert_eq!(track_id, "dQw4w9WgXcQ");
                assert!(super::opus_source::is_opus(&mime_type));
            }
            _ => panic!("kind did not select the offline variant"),
        }

        let file = serde_json::from_str::<NativeAudioSource>(
            r#"{"kind":"file","path":"C:\\Music\\song.flac"}"#,
        )
        .expect("file source");
        assert!(matches!(file, NativeAudioSource::File { path } if path.ends_with("song.flac")));

        // snake_case is what the bug accepted; it must not be what the contract accepts.
        assert!(
            serde_json::from_str::<NativeAudioSource>(
                r#"{"kind":"stream","url":"https://x/y","mime_type":"audio/mp4"}"#,
            )
            .is_err(),
            "the wire format is camelCase and only camelCase",
        );
    }

    /**
     * The streaming reader the Rust decoder pulls through.
     *
     * This is the one place a mistake is inaudible until it is a corrupted song: ranges land
     * out of order, so a reader that measured "how much has arrived" rather than "how much has
     * arrived *from the start*" would happily hand the decoder chunk 1 as though it were chunk
     * 0 and splice the file together wrong.
     */
    #[test]
    fn buffer_reader_serves_only_the_contiguous_prefix() {
        let buffer = Arc::new(Mutex::new(MediaBuffer::pending(6, 3)));
        let mut reader = BufferReader::new(Arc::clone(&buffer));

        // The second range wins the race. Nothing is servable yet regardless: byte 0 is missing.
        buffer.lock().unwrap().put(1, vec![3, 4]);

        let filling = Arc::clone(&buffer);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            filling.lock().unwrap().put(0, vec![1, 2]);
        });

        let started_at = std::time::Instant::now();
        let mut head = [0u8; 2];
        let read = reader.read(&mut head).unwrap();
        /*
         * Two things at once: the bytes are the head, not the chunk that happened to land
         * first, and getting them took the wait. A reader that returned 0 here would look like
         * the end of the stream to the decoder, and one that returned `[3, 4]` would play the
         * middle of the song as its beginning.
         */
        assert_eq!(&head[..read], &[1, 2]);
        assert!(started_at.elapsed() >= Duration::from_millis(25));

        // The prefix is served as one run rather than one chunk at a time — the chunk layout is
        // the downloader's business, not something the decoder should feel.
        let mut out = [0u8; 8];
        let read = reader.read(&mut out).unwrap();
        assert_eq!(&out[..read], &[3, 4]);

        /*
         * The tail never arrives and the download gives up. EOF, not an error and not a hang:
         * the decoder finishes the frames it has and the track reports its end, so the queue
         * advances instead of stalling on a deck that will never empty.
         */
        buffer.lock().unwrap().failed = true;
        assert_eq!(reader.read(&mut out).unwrap(), 0);

        // Symphonia probes containers by seeking around; past the end must clamp rather than
        // fail, or a probe of a body still downloading kills the load.
        assert_eq!(reader.seek(SeekFrom::End(0)).unwrap(), 6);
        assert_eq!(reader.seek(SeekFrom::Start(999)).unwrap(), 6);
        assert_eq!(reader.seek(SeekFrom::Start(2)).unwrap(), 2);
    }

    /// The head decides how long a click waits for sound, and the two ranges must tile the
    /// body exactly — a gap here is a hole in the audio.
    #[test]
    fn playback_ranges_lead_with_a_small_head_and_cover_everything() {
        let total = 4_000_000;
        let ranges = playback_ranges(total);

        assert_eq!(ranges.len(), 2, "playback fetches a head and then the rest, nothing more");
        assert_eq!(ranges[0], (0, AUDIO_HEAD_CHUNK_BYTES - 1));
        assert_eq!(ranges[1], (AUDIO_HEAD_CHUNK_BYTES, total - 1));

        let mut next = 0;
        for (start, end) in &ranges {
            assert_eq!(*start, next, "ranges must tile without a gap");
            next = end + 1;
        }
        assert_eq!(next, total, "ranges must cover the whole body");

        // Smaller than one head is a single range, and nothing at all is no ranges.
        assert_eq!(playback_ranges(1000), vec![(0, 999)]);
        assert!(playback_ranges(0).is_empty());
    }

    /**
     * A fill knows when a newer load has taken its slot.
     *
     * This is what lets an orphaned fill — one whose track died, was skipped, or already
     * finished — give up `PLAYBACK_FILL_LOCK` instead of running its retries and whole-file
     * fallback to completion first, which is what starved the one retry
     * `recoverFromPrematureEnd` sends right behind it.
     */
    #[test]
    fn a_fill_notices_its_slot_was_taken_by_a_newer_load() {
        let slot_index = 1; // Standby — kept off slot 0 so a parallel test on the other slot can't race this one.
        let first = LOAD_GENERATION[slot_index].fetch_add(1, Ordering::SeqCst) + 1;
        assert!(
            !load_superseded(Some((slot_index, first))),
            "the load that just claimed the slot is not superseded by itself",
        );

        // A second load for the same slot — the track that died gets reloaded, or the queue
        // just moved on — bumps past it.
        let second = LOAD_GENERATION[slot_index].fetch_add(1, Ordering::SeqCst) + 1;
        assert!(
            load_superseded(Some((slot_index, first))),
            "the first load must see itself superseded once a second one claims the slot",
        );
        assert!(!load_superseded(Some((slot_index, second))), "the newest load is never stale");

        // No slot at all — the media-server path — is never superseded.
        assert!(!load_superseded(None));
    }

    /// Ranges land out of order, so what can be served is the leading run of chunks — not the
    /// byte count. Serving past a hole would hand the media element a corrupt body.
    #[test]
    fn media_buffer_serves_only_its_contiguous_prefix() {
        let mut buffer = MediaBuffer::pending(10, 4);
        assert_eq!(buffer.contiguous_len(), 0);

        // The tail arrives first: still nothing servable, because byte 0 is missing.
        buffer.put(2, vec![9, 9]);
        assert_eq!(buffer.contiguous_len(), 0);

        buffer.put(0, vec![1, 2, 3, 4]);
        assert_eq!(buffer.contiguous_len(), 4, "only the head is contiguous");

        // The hole closes and the whole file becomes readable in one step.
        buffer.put(1, vec![5, 6, 7, 8]);
        assert_eq!(buffer.contiguous_len(), 10);

        // A read spanning three chunks is reassembled in order.
        assert_eq!(buffer.read(2, 8), vec![3, 4, 5, 6, 7, 8, 9]);
        assert_eq!(buffer.read(0, 0), vec![1]);
    }

    /// A typical song is 2-4 MB. A fixed 4 MiB range size meant exactly those never split at
    /// all, which is why a skip waited on the one throttled stream this is meant to avoid.
    #[test]
    fn audio_chunk_size_splits_a_song_and_bounds_the_extremes() {
        let song = 2_562_800_u64;
        let size = audio_chunk_size(song);
        assert!(size >= AUDIO_MIN_CHUNK_BYTES);
        assert!(song.div_ceil(size) > 1, "a song must split into several ranges");

        // Tiny files stay at the floor rather than becoming a swarm of requests.
        assert_eq!(audio_chunk_size(600_000), AUDIO_MIN_CHUNK_BYTES);
        // Large files stay capped rather than becoming a few huge ones.
        assert_eq!(audio_chunk_size(500 * 1024 * 1024), OFFLINE_CHUNK_BYTES);
    }

    /// The guard on the leak: this map was insert-only, so every song ever played stayed in
    /// memory for the life of the process.
    #[test]
    fn media_items_stay_capped_and_evict_the_coldest_first() {
        let items: Arc<Mutex<HashMap<String, MediaItem>>> = Arc::new(Mutex::new(HashMap::new()));

        for index in 0..MEDIA_SERVER_MAX_ITEMS + 3 {
            store_media_item(
                &items,
                format!("stream-track{index}"),
                vec![0_u8; 8],
                "audio/mp4".into(),
            )
            .map_err(|error| error.message)
            .expect("store succeeds");
        }

        let stored = items.lock().expect("lock");
        assert_eq!(stored.len(), MEDIA_SERVER_MAX_ITEMS, "cap is not enforced");
        // The newest survive; the first inserts are the ones that had to go.
        assert!(stored.contains_key(&format!("stream-track{}", MEDIA_SERVER_MAX_ITEMS + 2)));
        assert!(!stored.contains_key("stream-track0"));
    }

    /// A replay must reuse its slot rather than add a second copy of the same song — the other
    /// half of the leak, caused by the key carrying a timestamp.
    #[test]
    fn restoring_the_same_track_replaces_rather_than_accumulates() {
        let items: Arc<Mutex<HashMap<String, MediaItem>>> = Arc::new(Mutex::new(HashMap::new()));

        for _ in 0..5 {
            store_media_item(&items, "stream-same".into(), vec![7_u8; 4], "audio/mp4".into())
                .map_err(|error| error.message)
                .expect("store succeeds");
        }

        let stored = items.lock().expect("lock");
        assert_eq!(stored.len(), 1);
        assert_eq!(
            stored["stream-same"].buffer.lock().expect("buffer lock").total,
            4,
        );
    }

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

    /// Which rotations may wait for the interval. Getting this backwards is what made a session
    /// look lost overnight: a `PSIDTS` rotated at 23:58 and never written before the app quit.
    #[test]
    fn only_the_noisy_cookies_may_be_persisted_late() {
        assert!(is_slow_persist_cookie("SIDCC=abc; path=/; secure"));
        assert!(is_slow_persist_cookie("__Secure-3PSIDCC=abc; path=/"));
        assert!(!is_slow_persist_cookie("__Secure-3PSIDTS=fresh; path=/"));
        assert!(!is_slow_persist_cookie("SAPISID=abc; path=/"));
        // A tombstone for a credential still has to be stored at once: it is a real change.
        assert!(!is_slow_persist_cookie("__Secure-1PSID=; max-age=0"));
        assert!(!is_slow_persist_cookie("not-a-cookie"));
    }

    /// Same account or not, which decides whether signing in again costs a full resync.
    #[test]
    fn account_identity_survives_a_renewal_and_changes_with_the_account() {
        let lapsed = "SAPISID=account-one; SIDCC=stale; __Secure-3PSIDTS=stale";
        let renewed = "SAPISID=account-one; SIDCC=fresh; __Secure-3PSIDTS=fresh";
        let other = "SAPISID=account-two; SIDCC=fresh";

        assert_eq!(
            cookie_account_identity(lapsed),
            cookie_account_identity(renewed),
            "a re-minted session is the same account and must keep its cache"
        );
        assert_ne!(cookie_account_identity(lapsed), cookie_account_identity(other));
        // Fallbacks, for a cookie set that carries no plain SAPISID.
        assert_eq!(
            cookie_account_identity("__Secure-3PAPISID=third-party; YSC=x").as_deref(),
            Some("third-party")
        );
        // Nothing to compare is treated as a different account by the caller, so it must be None
        // rather than an empty string that would match another empty one.
        assert_eq!(cookie_account_identity("SAPISID=; YSC=x"), None);
        assert_eq!(cookie_account_identity("YSC=x"), None);
    }

    #[test]
    fn only_youtube_hosts_touch_the_cookie_jar() {
        let youtube = |url: &str| is_youtube_cookie_host(&url::Url::parse(url).unwrap());
        assert!(youtube("https://music.youtube.com/youtubei/v1/browse"));
        assert!(youtube("https://youtube.com/"));
        // A suffix match alone would hand the session to a lookalike domain.
        assert!(!youtube("https://notyoutube.com/"));
        assert!(!youtube("http://music.youtube.com/"));
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
    fn error_cause_chain_walks_the_full_source_chain() {
        #[derive(Debug)]
        struct Wrapped(&'static str, Option<Box<dyn std::error::Error>>);
        impl std::fmt::Display for Wrapped {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{}", self.0)
            }
        }
        impl std::error::Error for Wrapped {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                self.1.as_deref()
            }
        }

        let dns_failure = Wrapped("dns error: no such host", None);
        let send_failure = Wrapped(
            "error sending request for url (https://www.youtube.com/iframe_api)",
            Some(Box::new(dns_failure)),
        );

        assert_eq!(
            error_cause_chain(&send_failure),
            "error sending request for url (https://www.youtube.com/iframe_api) -> caused by: dns error: no such host",
            "the underlying DNS/TLS/connection cause must survive, not just reqwest's wrapper text",
        );

        let bare = Wrapped("connection refused", None);
        assert_eq!(error_cause_chain(&bare), "connection refused");
    }

    /// A cookie header carrying just enough for `cookie_account_identity` to fingerprint it.
    fn fake_account_cookie(sapisid: &str) -> String {
        format!("SAPISID={sapisid}; HSID=unrelated")
    }

    #[test]
    fn generate_slot_id_is_32_lowercase_hex_chars_and_not_a_repeat() {
        let a = generate_slot_id();
        let b = generate_slot_id();
        assert_eq!(a.len(), 32, "16 bytes, hex-encoded: {a}");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()), "{a}");
        assert_ne!(a, b, "two draws from OsRng landing on the same 128 bits would mean it is broken");
    }

    #[test]
    fn decode_slot_id_bytes_round_trips_what_generate_slot_id_produces() {
        let slot_id = generate_slot_id();
        let decoded = decode_slot_id_bytes(&slot_id);
        let reencoded: String = decoded.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(reencoded, slot_id, "the macOS data-store id must be a lossless view of the slot id");
    }

    #[test]
    fn login_partition_directory_name_keeps_the_legacy_slot_unsuffixed_and_others_distinct() {
        assert_eq!(login_partition_directory_name(LEGACY_ACCOUNT_SLOT_ID), "youtube-login-webview");
        let a = generate_slot_id();
        let b = generate_slot_id();
        assert_eq!(login_partition_directory_name(&a), format!("youtube-login-webview-{a}"));
        assert_ne!(
            login_partition_directory_name(&a),
            login_partition_directory_name(&b),
            "two stored accounts must never resolve to the same webview partition",
        );
    }

    #[test]
    fn from_legacy_cookie_becomes_one_active_account_pinned_to_the_legacy_slot() {
        let store = YoutubeAccountStore::from_legacy_cookie(
            &fake_account_cookie("alice"),
            LEGACY_ACCOUNT_SLOT_ID.to_string(),
        );
        assert_eq!(store.accounts.len(), 1);
        assert_eq!(store.active_slot_id.as_deref(), Some(LEGACY_ACCOUNT_SLOT_ID));
        assert_eq!(store.active().unwrap().slot_id, LEGACY_ACCOUNT_SLOT_ID);
    }

    #[test]
    fn upsert_new_identity_creates_a_slot_and_reports_the_account_as_changed() {
        let mut store = YoutubeAccountStore::default();
        let (slot_id, changed) =
            store.upsert_signed_in_account(&fake_account_cookie("alice"), "candidate-1".to_string());
        assert_eq!(slot_id, "candidate-1");
        assert!(changed, "the very first sign-in is always a change from signed-out");
        assert_eq!(store.accounts.len(), 1);
        assert_eq!(store.active_slot_id.as_deref(), Some("candidate-1"));
    }

    #[test]
    fn upsert_same_identity_while_already_active_refreshes_in_place_without_a_duplicate() {
        let mut store = YoutubeAccountStore::default();
        store.upsert_signed_in_account(&fake_account_cookie("alice"), "candidate-1".to_string());

        // Re-authenticating the same Google account through a brand new candidate partition
        // (a lapsed-session renewal) must find the existing slot, not create a second one.
        let (slot_id, changed) = store.upsert_signed_in_account(
            &fake_account_cookie("alice"),
            "candidate-2-unused".to_string(),
        );
        assert_eq!(slot_id, "candidate-1", "must land back on the original slot, not the throwaway candidate");
        assert!(!changed, "same account, still active: not a change the caller should resync for");
        assert_eq!(store.accounts.len(), 1, "must not create a duplicate slot for the same identity");
    }

    #[test]
    fn upsert_a_second_known_identity_switches_and_reports_changed() {
        let mut store = YoutubeAccountStore::default();
        let (alice_slot, _) =
            store.upsert_signed_in_account(&fake_account_cookie("alice"), "candidate-1".to_string());
        store.upsert_signed_in_account(&fake_account_cookie("bob"), "candidate-2".to_string());

        // Signing back in as alice (already stored, but not currently active) must switch to
        // her slot and report a change, even though her identity was already known.
        let (slot_id, changed) =
            store.upsert_signed_in_account(&fake_account_cookie("alice"), "candidate-3-unused".to_string());
        assert_eq!(slot_id, alice_slot);
        assert!(changed, "switching back to a different stored account is a change");
        assert_eq!(store.accounts.len(), 2, "still exactly the two real accounts, no throwaway slots kept");
    }

    #[test]
    fn remove_falls_back_to_another_stored_account_when_the_active_one_is_removed() {
        let mut store = YoutubeAccountStore::default();
        let (alice_slot, _) =
            store.upsert_signed_in_account(&fake_account_cookie("alice"), "candidate-1".to_string());
        let (bob_slot, _) =
            store.upsert_signed_in_account(&fake_account_cookie("bob"), "candidate-2".to_string());
        assert_eq!(store.active_slot_id.as_deref(), Some(bob_slot.as_str()));

        let (new_active_cookie, existed) = store.remove(&bob_slot);
        assert!(existed);
        assert_eq!(store.accounts.len(), 1);
        assert_eq!(store.active_slot_id.as_deref(), Some(alice_slot.as_str()), "falls back to whoever is left");
        assert_eq!(new_active_cookie.as_deref(), Some(fake_account_cookie("alice").as_str()));
    }

    #[test]
    fn remove_the_last_account_leaves_the_store_cleanly_empty() {
        let mut store = YoutubeAccountStore::default();
        let (slot_id, _) =
            store.upsert_signed_in_account(&fake_account_cookie("alice"), "candidate-1".to_string());
        let (new_active_cookie, existed) = store.remove(&slot_id);
        assert!(existed);
        assert!(new_active_cookie.is_none());
        assert!(store.active_slot_id.is_none());
        assert!(store.accounts.is_empty());
        assert!(store.active().is_none());
    }

    #[test]
    fn remove_an_unknown_slot_is_a_harmless_no_op() {
        let mut store = YoutubeAccountStore::default();
        store.upsert_signed_in_account(&fake_account_cookie("alice"), "candidate-1".to_string());
        let before = store.accounts.len();
        let (new_active_cookie, existed) = store.remove("never-stored");
        assert!(!existed);
        assert_eq!(store.accounts.len(), before, "removing a slot that was never there must not disturb the rest");
        assert!(new_active_cookie.is_some(), "the real account is still active throughout");
    }

    #[test]
    fn switch_active_moves_to_a_stored_slot_and_rejects_an_unknown_one_without_side_effects() {
        let mut store = YoutubeAccountStore::default();
        let (alice_slot, _) =
            store.upsert_signed_in_account(&fake_account_cookie("alice"), "candidate-1".to_string());
        store.upsert_signed_in_account(&fake_account_cookie("bob"), "candidate-2".to_string());

        let cookie = store.switch_active(&alice_slot);
        assert_eq!(cookie.as_deref(), Some(fake_account_cookie("alice").as_str()));
        assert_eq!(store.active_slot_id.as_deref(), Some(alice_slot.as_str()));

        let previously_active = store.active_slot_id.clone();
        assert!(
            store.switch_active("never-stored").is_none(),
            "switching to an account removed elsewhere in the meantime must fail cleanly",
        );
        assert_eq!(store.active_slot_id, previously_active, "a failed switch must not change who is active");
    }

    #[test]
    fn active_self_heals_when_the_recorded_active_slot_no_longer_exists() {
        let mut store = YoutubeAccountStore::default();
        store.upsert_signed_in_account(&fake_account_cookie("alice"), "candidate-1".to_string());
        // Simulates corrupt/stale state rather than reachable through the public methods.
        store.active_slot_id = Some("does-not-exist".to_string());
        assert!(
            store.active().is_some(),
            "at least one account is stored, so this should read as signed in as *someone*, not signed out",
        );
    }

    #[test]
    fn account_store_round_trips_through_json() {
        let mut store = YoutubeAccountStore::default();
        store.upsert_signed_in_account(&fake_account_cookie("alice"), "candidate-1".to_string());
        let json = serde_json::to_string(&store).unwrap();
        let restored: YoutubeAccountStore = serde_json::from_str(&json).unwrap();
        assert_eq!(restored.active_slot_id, store.active_slot_id);
        assert_eq!(restored.accounts.len(), store.accounts.len());
        assert_eq!(restored.accounts[0].cookie, store.accounts[0].cookie);
    }

    #[test]
    fn a_bare_legacy_cookie_header_is_not_mistaken_for_json_and_vice_versa() {
        // This is the exact discriminator `load_account_store` relies on to tell a pre-existing
        // install's bare cookie header apart from the new JSON shape.
        let legacy_blob = fake_account_cookie("alice");
        assert!(serde_json::from_str::<YoutubeAccountStore>(&legacy_blob).is_err());

        let store = YoutubeAccountStore::from_legacy_cookie(&legacy_blob, LEGACY_ACCOUNT_SLOT_ID.to_string());
        let json_blob = serde_json::to_string(&store).unwrap();
        assert!(serde_json::from_str::<YoutubeAccountStore>(&json_blob).is_ok());
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

    /// A decode failure's log line has to be readable whichever way the response was wrong —
    /// binary garbage as hex, an error page as text.
    #[test]
    fn bytes_preview_reads_both_binary_and_text_content() {
        let matroska_start = bytes_preview(&[0x1A, 0x45, 0xDF, 0xA3, 0x00, 0x01]);
        assert!(matroska_start.contains("hex=1a45dfa30001"));

        let error_page = bytes_preview(b"{\"error\":\"forbidden\"}");
        assert!(error_page.contains("text=\"{\\\"error\\\":\\\"forbidden\\\"}\""));

        assert_eq!(bytes_preview(&[]), "0 bytes, starts hex= text=\"\"");
    }
}
