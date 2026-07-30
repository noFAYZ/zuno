# Backend — Rust / Tauri

`src-tauri/` — Tauri 2, edition 2021, crate `just_another_music_client_lib`.
See [architecture.md](./architecture.md) for the system view.

---

## 1. Files

| File | Lines | Responsibility |
|---|---|---|
| `main.rs` | 25 | Windows AppUserModelID, WebView2 diagnostics workaround, calls `run()` |
| `lib.rs` | ~2380 | Everything else: commands, cache, settings, logging, session storage, HTTP proxy, audio fetch, local media server, window events, builder wiring |
| `discord_rpc.rs` | 190 | Discord IPC client lifecycle and activity payloads |
| `lastfm.rs` | 283 | Last.fm auth + scrobbling |
| `windows_media.rs` | 630 | SMTC + taskbar thumbnail toolbar (Windows only) |
| `macos_media.rs` | 189 | `MPNowPlayingInfoCenter` (macOS only) |
| `linux_media.rs` | 120 | MPRIS2 D-Bus interface (`souvlaki`) (Linux only) |

### Dependencies of note

`tauri` (feature `macos-private-api`), `tauri-plugin-{autostart,opener,localhost,updater,process,dialog}`,
`reqwest` (rustls-tls, gzip/brotli/deflate), `keyring` 3.6 with native backends, `discord-rich-presence`,
`md5`, `base64`, `url`, `portpicker`.
macOS adds `aes-gcm`, `objc2`, `objc2-foundation`, `block2`, `rand`. Windows adds the `windows` crate
(Media, Media_Playback, Storage_Streams, Win32 Shell/Gdi/Com/UI).

---

## 2. `run()` — startup

```rust
manage(CacheLock)            // Mutex<()> serializing all cache file ops
manage(AppSettingsLock)      // Mutex<()> serializing settings file ops
manage(DiscordRpcManager)
plugin(autostart, updater, process, dialog, opener)

#[cfg(not(debug_assertions))]                 // release only
  port = pick_unused_port()
  config.build.frontend_dist = Url("http://localhost:{port}")
  plugin(tauri_plugin_localhost::Builder::new(port))

#[cfg(windows)] manage(WindowsMediaSession)
#[cfg(macos)]   manage(MacosMediaSession)

#[cfg(linux)] force main window decorations = true   // mutated on the config before build

setup      → initialize_app_log()
on_window_event → close / focus handling
invoke_handler(...)
```

Serving the frontend over `http://localhost` in release builds is deliberate: the YouTube IFrame
player API will not initialize under the `tauri://` custom protocol origin.

### Window events

| Event | Behaviour |
|---|---|
| `CloseRequested` on `main` | `api.prevent_close()` then `app.exit(0)` — quits the whole app rather than orphaning the mini-player window |
| `Focused(false)` on `main` | Spawns a thread, waits 100 ms, re-checks that neither main nor mini is focused, then emits `main-window-backgrounded` (debounce against focus flicker during window drags) |
| `Focused(true)` on `main` | Emits `window-focused` |

---

## 3. Command reference

Every command is invoked from TypeScript via `@tauri-apps/api/core`'s `invoke` and must also be
listed in `src-tauri/capabilities/default.json`.

### App settings — `<app_data_dir>/settings-v1.json`

| Command | Signature | Notes |
|---|---|---|
| `app_setting_get` | `(key) -> Option<Value>` | Whole-file read under `AppSettingsLock` |
| `app_setting_set` | `(key, value)` | Read-modify-write, atomic (`.tmp` + rename) |
| `app_setting_remove` | `(key)` | |
| `app_settings_clear` | `()` | Used by "delete all app data" |

Simple flat `HashMap<String, Value>`. Whole-file rewrite per key — fine at this scale, and the mutex
prevents interleaved writes.

### Data cache — `<app_cache_dir>/data-cache-v1/`

| Command | Signature | Notes |
|---|---|---|
| `cache_get` | `(key) -> Option<String>` | Touches `last_accessed_ms` and rewrites the entry |
| `cache_set` | `(key, value) -> { changed }` | `changed` lets the frontend skip re-rendering identical data after a background refresh |
| `cache_stats` | `() -> { maxBytes, usedBytes, entryCount }` | |
| `cache_set_max_bytes` | `(maxBytes) -> CacheStats` | Applies eviction immediately |
| `cache_clear` | `() -> CacheStats` | Removes and recreates `entries/` |

Implementation details:

- File per entry: `entries/<fnv1a-64 of key, 16 hex>.json`, holding `{ key, value, updatedAtMs, lastAccessedMs }`. The stored `key` is compared on read so a hash collision misses instead of corrupting.
- Writes are atomic: serialize → write `.tmp` → remove target → rename.
- `enforce_cache_limit` sorts entries by `last_accessed_ms` and deletes oldest-first until under budget. Runs on every `cache_set` — O(n) directory stat per write; acceptable at current entry counts, worth revisiting if the cache grows into tens of thousands of files.
- Default budget: 4 GiB (`DEFAULT_CACHE_MAX_BYTES`), configurable in Settings.

### Logging

| Command | Signature | Notes |
|---|---|---|
| `frontend_log` | `(level, context, payload)` | Appends a sanitized line to `<app_log_dir>/current.log` |
| `open_current_log` | `()` | Opens the log in the system handler |

`initialize_app_log` truncates `current.log` on every launch and deletes every other `*.log` in the
directory. A local `eprintln!` macro shadows the std one so *all* Rust logging is routed through
`sanitize_log_message` and appended to the same file.

### YouTube session

| Command | Signature | Notes |
|---|---|---|
| `sign_in_youtube_music` | `() -> String` | Opens the login window, polls for cookies, returns the Cookie header |
| `load_youtube_music_cookie` | `() -> Option<String>` | |
| `delete_youtube_music_cookie` | `()` | Also clears the login window's browsing data if present |
| `save_youtube_credentials` / `load_youtube_credentials` / `delete_youtube_credentials` | | Legacy OAuth-JSON slot, kept for migration/detection |

**Sign-in flow** (`sign_in_youtube_music`): create window `youtube-music-login` at `about:blank` →
`clear_all_browsing_data()` → navigate to the Google sign-in URL → poll once a second for up to 300
polls. Success requires *both* an auth cookie (`SAPISID` / `__Secure-1PAPISID` / `__Secure-3PAPISID`)
*and* the window sitting on `music.youtube.com`. On success the cookies are joined into one header,
persisted, and the window closes. If the user closes the window, the command errors with "cancelled".
macOS reads cookies via `window.cookies()` filtered by `cookie_domain_matches` (unit-tested); other
platforms use `cookies_for_url`. macOS also sets a Safari user agent so Google serves the desktop flow.

**Storage** (service name `com.ytmusicdock.app`, kept from before the rename):

- Windows / Linux — the header is split into ≤900-byte chunks across at most 16 keyring entries, plus a `chunks:<n>` manifest entry. Keyring backends cap individual secret sizes; a cookie header is far larger.
- macOS — the header is encrypted with AES-256-GCM (random 12-byte nonce prefixed to the ciphertext) into `<app_data_dir>/youtube-music-session-v1.bin`; only the 32-byte key lives in the keychain. This avoids repeated keychain prompts for 16 separate entries.

### HTTP proxy

| Command | Signature |
|---|---|
| `proxy_http_request` | `({ url, method, headers, body_base64, timeout_ms }) -> { status, headers, body_base64 }` |

Every youtubei.js request goes through here (`src/datasource/youtube/tauriFetch.ts` is the adapter).
Why: the WebView can't set `Cookie`/`Origin` headers or bypass CORS, and Innertube needs both.

- Fixed Chrome 135 user agent.
- `signed_googlevideo_local_address()` — signed googlevideo URLs embed an `ip=` parameter; the client binds `local_address` to the matching IP family (`0.0.0.0` or `::`) so the signature stays valid on dual-stack machines.
- Cookie and Authorization headers are redacted in logs.
- `/browse` responses under 400 get their renderer types counted into the debug log — a diagnostic for when YouTube changes response shapes.

### Audio

| Command | Signature | Notes |
|---|---|---|
| `fetch_audio_bytes` | `(url, trackId) -> Vec<u8>` | Downloads with YouTube-ish headers (Range, Origin, Referer, Sec-Fetch-*), same signed-IP handling |
| `fetch_audio_source` | `(url, trackId, mimeType) -> { url, mimeType, byteLength }` | Downloads, validates the MP4 `ftyp` box at offset 4, stores the bytes in the in-process media server, returns a `http://127.0.0.1:<port>/audio/<key>` URL |
| `fetch_youtube_music_audio` | `(videoId) -> { bodyBase64, mimeType }` | Direct InnerTube player API using iOS/TV contexts that return undeciphered URLs |
| `local_audio_scan` | `(paths: Vec<String>) -> Vec<LocalAudioFile>` | Recursive directory walk; extensions mp3, m4a, mp4, aac, flac, wav, ogg, oga, opus, webm. Sorted case-insensitively and deduped. Album name is inferred from the parent folder |
| `local_audio_read` | `(path) -> { bodyBase64, mimeType }` | Re-validates the path is a file with an allowed extension before reading |

**Media server**: a lazily started `TcpListener` on `127.0.0.1:0` with a thread per connection,
backed by `HashMap<key, MediaItem>`. It exists so the WebView can stream MP4 audio from a plain
`http://` origin — signed googlevideo URLs 403 when replayed from the WebView, and base64 blobs of
a whole track are wasteful. Entries are keyed `"<trackId>-<epoch_ms>"` and never evicted (in-memory,
process lifetime).

**Note:** with `AudioEngine.shouldUseNativeAudio()` hardcoded to `false`, `fetch_audio_bytes`,
`fetch_audio_source`, and `fetch_youtube_music_audio` are currently only reachable through the
local-file path or manual re-enablement.

### Integrations

| Command | Module | Notes |
|---|---|---|
| `discord_rpc_update` | `discord_rpc.rs` | Lazily connects on first use. Sends a raw `SET_ACTIVITY` payload of type 2 (Listening): title as `details`, artist (or `artist (paused)`) as `state`, artwork as the large image, `details_url`/`state_url`/`assets.large_url` pointing at the song/artist/album on YouTube Music, one button linking to the GitHub repo, and `start`/`end` timestamps derived from the play position so Discord renders a live progress bar. Client id `1515682467154100344` |
| `discord_rpc_clear` | | Clears presence on idle/error |
| `lastfm_auth_token` | `lastfm.rs` | `auth.getToken` → returns token + browser auth URL |
| `lastfm_complete_auth` | | `auth.getSession` → stores the session key in the keyring |
| `lastfm_get_session` / `lastfm_disconnect` | | |
| `lastfm_update_now_playing` / `lastfm_scrobble` | | MD5 `api_sig` over sorted params + shared secret |
| `update_windows_media_session` | `windows_media.rs` | Windows only |
| `update_macos_media_session` | `macos_media.rs` | macOS only |
| `quit_app` | `lib.rs` | `app.exit(0)` |
| `greet` | `lib.rs` | Tauri scaffolding leftover; unused |

**Windows media** (`windows_media.rs`): a `MediaPlayer` + `SystemMediaTransportControls` pair driving
the OS media overlay — metadata, thumbnail (downloaded and wrapped in a `RandomAccessStream`),
playback status, and timeline position. Button presses are emitted back to JS as
`windows-media-control` payloads (`"play" | "pause" | "playPause" | "next" | "previous"` or
`{ action: "seekTo", positionSec }`). It also installs a taskbar thumbnail toolbar
(`ITaskbarList3`) with previous/play-pause/next buttons via a Win32 subclass.

**macOS media** (`macos_media.rs`): populates `MPNowPlayingInfoCenter` through `objc2`. Requires
`macOSPrivateApi: true` in `tauri.conf.json`.

**Last.fm** (`lastfm.rs`): API key and shared secret are compiled in — standard for a desktop client,
since the secret only signs this app's requests and the user's session key is what actually
authorizes writes. Session key lives in the keyring under `lastfm-session-v1`.

---

## 4. Capabilities and security

`src-tauri/capabilities/default.json` scopes both windows (`main`, `mini-player`):

- Core window permissions: drag, minimize/maximize/unmaximize, fullscreen, decorations, show/hide/focus, position/size get+set, cursor position and icon, ignore-cursor-events (the mini player's click-through behaviour).
- Plugin permissions: `autostart:{enable,disable,is-enabled}`, `opener:default`, `updater:default`, `process:allow-restart`, `dialog:{allow-open,allow-message}`.
- An explicit `command.allow` list naming every custom command.
- `remote.urls` permits `https://**` and localhost/127.0.0.1.

`app.security.csp` is `null` — no CSP. Required because the YouTube IFrame API script is loaded from
`youtube.com` at runtime. If native playback ever replaces the IFrame path, this should be tightened.

Defense in depth that *is* in place:

- Two-stage log redaction (TS `sanitizeForLog` → Rust `sanitize_log_message`).
- Discord artwork restricted to `i.ytimg.com` / `lh3.googleusercontent.com` / `yt3.ggpht.com`, presence links to YouTube hosts, HTTPS only.
- `local_audio_read` re-validates path and extension rather than trusting the frontend.
- Secrets never touch localStorage — keyring or an encrypted file only.

---

## 5. Updater

```json
"plugins": { "updater": {
  "pubkey": "<minisign public key>",
  "endpoints": [
    "https://github.com/noFAYZ/zuno/releases/latest/download/latest.json",
    "https://raw.githubusercontent.com/noFAYZ/zuno/updater-channel/latest.json"
  ]}}
```

`createUpdaterArtifacts: true` in the bundle config produces signed artifacts. Two endpoints give a
fallback if the Releases redirect is unavailable. macOS skips the plugin entirely
(`internal/updateChecker.ts` uses the GitHub Releases API and only links to the download page).

---

## 6. Tests

`lib.rs` carries one `#[cfg(test)]` module covering `cookie_domain_matches` — exact, parent-domain,
and rejection cases. That's the whole automated test suite; there is no frontend test harness.
