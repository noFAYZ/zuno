# Backend — Rust / Tauri

`src-tauri/` — Tauri 2, edition 2021, crate `zuno`, lib target `zuno_lib`.
See [architecture.md](./architecture.md) for the system view.

---

## 1. Files

| File | Lines | Responsibility |
|---|---|---|
| `main.rs` | 24 | Windows AppUserModelID, WebView2 diagnostics workaround, calls `run()` |
| `lib.rs` | ~3940 | Everything else: commands, cache, settings, logging, session storage + cookie jar, HTTP proxy, audio fetch, offline store, local files/tags/watcher, media server, tray, window events, builder wiring |
| `audio.rs` | ~460 | The native engine: two rodio decks, the crossfade ramp, the position tick, and the blocking reader that lets symphonia decode a body still downloading |
| `opus_source.rs` | ~250 | Opus playback — symphonia demuxes the WebM/Ogg container, libopus decodes the packets, the result is a rodio `Source` |
| `discord_rpc.rs` | 213 | Discord IPC client lifecycle and activity payloads |
| `lastfm.rs` | 283 | Last.fm auth + scrobbling |
| `windows_media.rs` | 630 | SMTC + taskbar thumbnail toolbar (Windows only) |
| `macos_media.rs` | 189 | `MPNowPlayingInfoCenter` (macOS only) |

### Dependencies of note

`tauri` (features `macos-private-api`, `tray-icon`, `image-png`),
`tauri-plugin-{autostart,opener,localhost,updater,process,dialog}`,
`reqwest` (rustls-tls, gzip/brotli/deflate, **stream**), `futures-util` (parallel range downloads),
`rodio` 0.22 with `symphonia-all` (symphonia decodes, cpal plays, rodio resamples between them),
`symphonia` 0.5 directly for demuxing and `opus` 0.3 for the one codec symphonia lacks,
`keyring` 3.6 with native backends, `lofty` 0.24 (audio tag read/write), `notify` 8.2 (folder
watching), `discord-rich-presence`, `md5`, `base64`, `url`, `portpicker`.
macOS adds `aes-gcm`, `objc2`, `objc2-foundation`, `block2`, `rand`. Windows adds the `windows`
crate (Media, Media_Playback, Storage_Streams, Win32 Shell/Gdi/Com/UI/Controls).

---

## 2. `run()` — startup

```rust
manage(CacheLock)            // Mutex<()> serializing all cache file ops
manage(AppSettingsLock)      // Mutex<()> serializing settings file ops
manage(YoutubeCookieJar)     // Mutex<CookieJarState> — the live session cookies
manage(DiscordRpcManager)
plugin(autostart, updater, process, dialog, opener)

#[cfg(not(debug_assertions))]                 // release only
  port = pick_unused_port()
  config.build.frontend_dist = Url("http://localhost:{port}")
  plugin(tauri_plugin_localhost::Builder::new(port))

#[cfg(windows)] manage(WindowsMediaSession)
#[cfg(macos)]   manage(MacosMediaSession)
manage(LocalAudioWatcher)

#[cfg(linux)] force main window decorations = true   // mutated on the config before build

setup      → migrate_legacy_app_data()   // before the log opens, so a first run after the
           → initialize_app_log()        //   rename logs into the restored directory
           → build_tray()                // always built; the setting only changes behaviour
on_window_event → close / focus handling
invoke_handler(...)
```

Serving the frontend over `http://localhost` in release builds is deliberate: the YouTube IFrame
player API will not initialize under the `tauri://` custom protocol origin.

`migrate_legacy_app_data` copies app data from the pre-rename
`com.justanothermusicclient.desktop` identifier into `com.zuno.desktop` on first run.

### Window events

| Event | Behaviour |
|---|---|
| `CloseRequested` on `main` | `api.prevent_close()` then `close_or_hide_main_window()` — hides to the tray if `minimize-to-tray` is set, otherwise `app.exit(0)`. The titlebar button routes through the same function via `quit_app`, so the two can't disagree |
| `Focused(false)` on `main` | Spawns a thread, waits 100 ms, re-checks that neither main nor mini is focused, then emits `main-window-minimized` (if the window is minimized) or `main-window-backgrounded` — the debounce guards against focus flicker during window drags |
| `Focused(true)` on `main` | Emits `window-focused` |

### Tray

`build_tray()` installs a `main-tray` icon with a two-item menu (**Show Zuno** / **Quit Zuno**).
Left click restores the window; the menu is right-click only. **Quit Zuno** is the one path that
always exits regardless of the minimize-to-tray setting.

---

## 3. Command reference

Every command is invoked from TypeScript via `@tauri-apps/api/core`'s `invoke` and registered in
`tauri::generate_handler!`.

### App settings — `<app_data_dir>/settings-v1.json`

| Command | Signature | Notes |
|---|---|---|
| `app_setting_get` | `(key) -> Option<Value>` | Whole-file read under `AppSettingsLock` |
| `app_setting_set` | `(key, value)` | Read-modify-write, atomic (`.tmp` + rename) |
| `app_setting_remove` | `(key)` | |
| `app_settings_clear` | `()` | Used by "delete all app data" |

Simple flat `HashMap<String, Value>`. Whole-file rewrite per key — fine at this scale, and the mutex
prevents interleaved writes. Rust reads one key of its own out of this file: `minimize-to-tray`.

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

`sanitize_log_url` is the interesting half: it keeps the parameters that explain a googlevideo 403
(`expire`, `itag`, `mime`, `clen`, `c`, `cver`) and replaces the rest — `sig`, `lsig`, `pot`, `n`,
`ip` — with a `[9ch]`-style length marker, so a truncated signature is distinguishable from a
missing one without leaking either. Unparseable input becomes `[redacted-url]`.

### YouTube session

| Command | Signature | Notes |
|---|---|---|
| `sign_in_youtube_music` | `() -> String` | Opens the login window, polls for cookies, returns the Cookie header |
| `refresh_youtube_music_cookie` | `() -> Option<String>` | Silent re-mint in a hidden window, up to `YOUTUBE_SILENT_REFRESH_POLLS` (25) polls |
| `load_youtube_music_cookie` | `() -> Option<String>` | Also seeds the in-memory cookie jar |
| `delete_youtube_music_cookie` | `()` | Also clears the login window's browsing data if present |

**Sign-in flow** (`sign_in_youtube_music`): create window `youtube-music-login` at `about:blank` →
`clear_all_browsing_data()` → navigate to the Google sign-in URL → poll once a second for up to 300
polls. Success requires *both* an auth cookie (`SAPISID` / `__Secure-1PAPISID` / `__Secure-3PAPISID`)
*and* the window sitting on `music.youtube.com`. On success the cookies are joined into one header,
persisted, and the window closes. If the user closes the window, the command errors with "cancelled".
macOS reads cookies via `window.cookies()` filtered by `cookie_domain_matches` (unit-tested); other
platforms use `cookies_for_url`. macOS also sets a Safari user agent so Google serves the desktop flow.

**Cookie jar.** Google rotates session cookies continuously, and a session that only ever stores what
sign-in returned goes stale overnight. `proxy_http_request` feeds every `Set-Cookie` from a YouTube
host through `apply_set_cookie`, which merges it into `YoutubeCookieJar` in original order:

- a rotated value replaces the stale one and reports a change,
- the same value again reports *no* change, so it triggers no keyring write,
- an expiry/`max-age=0` tombstone drops the cookie.

Credential rotations (`__Secure-*PSIDTS`, `SAPISID`, …) are persisted immediately.
`is_slow_persist_cookie` marks only the noisy `SIDCC` family as allowed to wait for the
`YOUTUBE_COOKIE_PERSIST_INTERVAL` (5 min) — getting that list backwards is what once made a session
look lost after a `PSIDTS` rotated at 23:58 and never got written. `is_youtube_cookie_host` gates
the whole thing: a suffix match alone would hand the session to `notyoutube.com`.

`cookie_account_identity()` reduces a header to its `SAPISID` (falling back to
`__Secure-1PAPISID` / `__Secure-3PAPISID`), so a re-signed-in session is recognised as the same
account and keeps its cache, while a genuinely different account drops it. An empty value returns
`None` rather than `""`, so two unknowns don't compare equal.

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
- Merges response `Set-Cookie` headers into the cookie jar (see above).
- `signed_googlevideo_local_address()` — signed googlevideo URLs embed an `ip=` parameter; the client binds `local_address` to the matching IP family (`0.0.0.0` or `::`) so the signature stays valid on dual-stack machines.
- Cookie and Authorization headers are redacted in logs.
- `/browse` responses under 400 get their renderer types counted into the debug log — a diagnostic for when YouTube changes response shapes.

### Audio — streaming and fallback

| Command | Signature | Notes |
|---|---|---|
| `fetch_audio_bytes` | `(url, trackId) -> Vec<u8>` | Downloads with YouTube-ish headers (Range, Origin, Referer, Sec-Fetch-*), same signed-IP handling |
| `fetch_audio_source` | `(url, trackId, mimeType, cookie?) -> { url, mimeType, byteLength }` | Downloads via `fetch_audio_ranged`, publishes the bytes under `stream-<trackId>`, returns a `http://127.0.0.1:<port>/audio/<key>` URL. The `ftyp` check runs only when `mimeType` is MP4 — Opus-in-WebM has no such box |
| `fetch_youtube_music_audio` | `(videoId) -> { bodyBase64, mimeType }` | Direct InnerTube player API using web-remix / web / iOS / Android / TV contexts that return undeciphered URLs |

**Media server**: a lazily started `TcpListener` on `127.0.0.1:0` with a thread per connection,
backed by `HashMap<key, MediaItem>`, and `parse_media_range` implementing HTTP Range so the WebView
can seek. It exists because signed googlevideo URLs 403 when replayed from the WebView, and base64
blobs of a whole track are wasteful.

Three things about it are load-bearing, and each fixed half of a leak that only became hot once
`native` playback made `fetch_audio_source` the default streaming path:

- **`store_media_item()` caps the map at `MEDIA_SERVER_MAX_ITEMS` (3)**, evicting the coldest by an `AtomicU64` sequence — a counter rather than a timestamp, because two inserts inside a millisecond still need an order. Two is the real working set (playing track plus preloaded); the third is slack for a fast skip. The map was previously insert-only, so every song ever played stayed resident.
- **Keys are stable** — `stream-<trackId>` and `offline-<trackId>`. `fetch_audio_source` used to append a millisecond timestamp, so a replay stored a second copy of the same song *and* left the webview holding a response under a URL it would never request again.
- **Responses carry `Cache-Control: no-store`.** Without it the webview keeps its own copy of every audio body — whole songs, in the renderer process, retained a second time by the one place that cannot be asked to give them back. The cost is that seeking backwards re-requests a range instead of reading the webview's copy, which over loopback against an in-memory `Vec<u8>` is a memcpy.

Replacing a key mid-playback is safe: `handle_media_request` clones the `Arc` before it writes, so
a request already in flight finishes against the bytes it started with.

**Note:** which of these runs for ordinary streaming depends on the audio-engine setting. In
`iframe` mode (the default) none of them do — the IFrame decks stream directly. In `rust` mode the
media server is bypassed too: `native_audio_load` reads through `MediaBuffer` in-process. Downloads
always use `offline_audio_save` below.

### Audio — the native engine (`audio.rs`)

| Command | Signature | Notes |
|---|---|---|
| `native_audio_load` | `(track_id, source, duration_sec?, standby?) -> f64` | Decodes onto the active deck, or the standby one when `standby`. Returns the duration decoded, falling back to the provider's when the container declares none — Opus in WebM usually does not |
| `native_audio_play` / `_pause` / `_stop` | `()` | |
| `native_audio_seek` | `(position_sec)` | |
| `native_audio_set_volume` | `(volume, muted)` | |
| `native_audio_set_rate` | `(rate)` | Resamples, so it transposes. See §7 |
| `native_audio_transition` | `(track_id, fade_ms) -> bool` | Swaps to the standby deck. `fade_ms` of 0 is the gapless case; above 0 both decks play and their volumes ramp past each other. False means nothing was preloaded |
| `native_audio_has_standby` | `(track_id) -> bool` | |
| `native_audio_drop_standby` | `()` | |
| `media_server_release` | `() -> usize` | Drops every body the media server holds, and returns how many. Called once on the first Rust load, after the `<audio>` element is torn down |

`NativeAudioSource` is one of `stream` (a signed googlevideo URL), `offline` (a track id) or
`file` (a path, re-validated here rather than trusted from the frontend). Each carries a mime
type, because that is what picks the decoder — but for anything already on disk the *bytes* win:
`sniff_container_mime` reads the first 64 and rewinds. `Track.mimeType` describes what was
resolved for streaming and a row from a playlist listing has none at all, so a downloaded Opus
file arrived declared `audio/mp4` and went to rodio, which parsed the Matroska and then had no
Opus decoder for what was inside.

**Opus is not optional.** symphonia has no Opus decoder in 0.5 — not a feature flag, the codec is
absent — and YouTube serves `audio/webm; codecs="opus"` for the large majority of tracks at
`high` quality, and as the *only* audio offered for many of them. So `opus_source.rs` uses
symphonia purely as a demuxer and hands the packets to libopus; everything else (AAC, FLAC, MP3,
ALAC, Vorbis, WAV) stays on `rodio::Decoder`. `is_opus()` routes on the declared mime type, and
getting it wrong is a failed load rather than a fallback — neither decoder can read the other's
format. Two details are load-bearing: OpusHead's **pre-skip** is discarded, or every track opens
with an audible tick, and a **seek resets the decoder state**, or the first frames after a jump
are reconstructed against samples from somewhere else and arrive as noise.

**Build requirements this adds.** `opus` builds libopus from source with **cmake**, and `cpal`
links **ALSA** on Linux (`libasound2-dev` / `alsa-lib`). Both are in `ci.yml`, `release.yml` and
the AUR PKGBUILD. On Windows, cmake ships with the Visual Studio Build Tools but is not on `PATH`
by default.

**The media server is not needed on this path at all.** `media_server()` is lazy, so an app that
launches straight into `rust` mode never binds the listener — `fetch_audio_source` and
`offline_audio_source` are the only callers and neither runs. Switching *into* `rust` mid-session
is the case that matters, and `media_server_release` handles it: up to `MEDIA_SERVER_MAX_ITEMS`
whole songs are dropped at the first Rust load, once the `<audio>` element that could still be
range-requesting them is gone. The listener thread and its port stay — reclaiming those means the
`OnceLock` has to become something emptiable *and* restartable, because the other two engines
still need the server.

Three things are load-bearing:

- **One owned thread behind a channel.** cpal's stream handle is not `Send` on every backend and
  Tauri state must be, so only the `Sender` escapes the module. The same thread runs the 250 ms
  position tick out of its own `recv_timeout`, and steps an in-progress crossfade at 20 ms — a
  fade that slept in the command loop would starve position events for its whole window.
- **The decoder is built off the audio thread.** `rodio::Decoder::new` reads the container header,
  which for a stream means waiting on the network; `native_audio_load` does it on a blocking pool
  thread and sends the thread a ready `Box<dyn Source + Send>`. Preloading the next track therefore
  never stalls the position feed of the one playing.
- **`BufferReader` blocks rather than reporting a short read.** `MediaBuffer` only exposes its
  contiguous prefix, so a read either returns bytes from offset 0 without a hole or waits for the
  gap to fill. A short read would look like the end of the stream to symphonia. A failed download
  reports EOF, not an error, so the track ends and the queue advances instead of hanging on a deck
  that will never empty.

**`fetch_audio_ranged`** is the one downloader both playback and the offline store use, so the
two cannot drift apart on speed — playback used to take the single-request path while downloads
took the parallel one, and a skip paid the difference.

- Ranges are sized by `audio_chunk_size(total)`: aim for roughly `OFFLINE_CHUNK_CONCURRENCY` (6) of them, floored at `AUDIO_MIN_CHUNK_BYTES` (512 KiB) and capped at `OFFLINE_CHUNK_BYTES` (4 MiB). A fixed 4 MiB was previously *both* the range size and the threshold, so a typical 2–4 MB song never split at all.
- Below the floor, or with no `clen` to plan from, it falls back to one request.
- One refused range aborts the assembly and restarts on the single-request path rather than returning a buffer with a hole in it.
- `on_progress(received, total)` is caller-supplied; the offline store emits `offline-download-progress`, playback passes a no-op.

### Audio — offline downloads

| Command | Signature | Notes |
|---|---|---|
| `offline_audio_save` | `(url, trackId, cookie?) -> u64` | Downloads the signed URL into `<app_data_dir>/offline-audio-v1/<trackId>.bin`, returns byte length |
| `offline_audio_source` | `(trackId, mimeType) -> { url, mimeType, byteLength }` | Loads the stored bytes into the media server under key `offline-<trackId>` and returns its URL |
| `offline_audio_has` | `(trackId) -> bool` | |
| `offline_audio_remove` | `(trackId)` | |
| `offline_audio_list` | `() -> Vec<{ trackId, byteLength }>` | The source of truth the frontend manifest reconciles against |
| `offline_audio_stats` | `() -> { entryCount, usedBytes }` | |
| `offline_audio_prune` | `(maxBytes) -> OfflineStats` | Deletes oldest-first until under the ceiling |

- **Ranged and parallel.** `OFFLINE_CHUNK_BYTES` is 4 MiB and `OFFLINE_CHUNK_CONCURRENCY` is 6.
  googlevideo throttles a single sequential stream hard, which is why downloading a track used to
  take far longer than streaming the same track takes to buffer; several ranges in flight side-step
  it. `signed_content_length()` reads `clen` from the URL to plan the ranges, and
  `audio_url_with_range()` appends `range=start-end` without re-encoding the query (re-encoding `==`
  breaks the signature).
- **Progress.** `emit_offline_progress` emits `offline-download-progress`
  `{ trackId, receivedBytes, totalBytes, percent }`.
- **Path safety.** `offline_entry_path` rejects ids that are empty, contain `..`, or contain
  `/ \ : \0` — track ids come from YouTube and are filename-safe, but a hostile one must not escape
  the directory.

### Local files

| Command | Signature | Notes |
|---|---|---|
| `local_audio_scan` | `(paths: Vec<String>) -> Vec<LocalAudioFile>` | Recursive directory walk; extensions mp3, m4a, mp4, aac, flac, wav, ogg, oga, opus, webm. Sorted case-insensitively and deduped. Album name is inferred from the parent folder |
| `local_audio_read` | `(path) -> { bodyBase64, mimeType }` | Re-validates the path is a file with an allowed extension before reading |
| `local_audio_read_tags` | `(path) -> LocalAudioTags` | `lofty` |
| `local_audio_write_tags` | `(path, tags)` | `lofty` |
| `local_audio_watch` | `(paths: Vec<String>)` | Replaces the active `notify` watcher wholesale; emits `local-audio-changed` at most once a second |
| `local_audio_unwatch` | `()` | Drops the watcher, which unregisters every path |
| `read_text_file` | `(path) -> String` | Playlist import. Capped at 16 MiB — the picker allows any file, and reading a multi-gigabyte one into a `String` to discover it isn't a playlist would take the app down |
| `write_text_file` | `(path, contents)` | Playlist export; creates the parent directory |

The watcher is deliberately coarse: one debounced "something changed" event, no diff. A precise
change feed would have to model renames, temp files and write-then-replace editors, all of which
produce the same user-visible outcome — a rescan.

### Integrations

| Command | Module | Notes |
|---|---|---|
| `discord_rpc_update` | `discord_rpc.rs` | Lazily connects on first use. Sends a raw `SET_ACTIVITY` payload of type 2 (Listening): title as `details`, artist (or `artist (paused)`) as `state`, artwork as the large image, `details_url`/`state_url`/`assets.large_url` pointing at the song/artist/album on YouTube Music, one button linking to the GitHub repo, and `start`/`end` timestamps derived from the play position so Discord renders a live progress bar. Client id `1515682467154100344` |
| `discord_rpc_clear` | | Clears presence on idle/error |
| `lastfm_auth_token` | `lastfm.rs` | `auth.getToken` → returns token + browser auth URL |
| `lastfm_complete_auth` | | `auth.getSession` → stores the session key in the keyring |
| `lastfm_get_session` / `lastfm_disconnect` | | |
| `lastfm_update_now_playing` / `lastfm_scrobble` | | MD5 `api_sig` over sorted params + shared secret |
| `update_windows_media_session` | `windows_media.rs` | Windows only (`#[cfg]` inside `generate_handler!`) |
| `update_macos_media_session` | `macos_media.rs` | macOS only |
| `quit_app` | `lib.rs` | Routes to `close_or_hide_main_window` |
| `native_audio_*` | `audio.rs` | See §3. Emits `native-audio-position` and `native-audio-ended` |
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

- Core window permissions: drag, minimize/maximize/unmaximize, fullscreen, decorations, show/hide/focus/destroy, position/size get+set, current monitor, cursor position and icon, ignore-cursor-events (the mini player's click-through behaviour), and webview-window creation.
- Plugin permissions: `autostart:{enable,disable,is-enabled}`, `opener:default`, `updater:default`, `process:allow-restart`, `dialog:{allow-open,allow-message}`.
- `remote.urls` permits `https://**` and localhost/127.0.0.1.

**The `command.allow` and `allowlist.shell` blocks in that file are Tauri 1 syntax and gate nothing
in Tauri 2** — capabilities scope *core and plugin* permissions; your own `#[tauri::command]`
functions are callable from the app's own windows once they're in `generate_handler!`. The proof is
that the list is missing every command added since it was written (all `offline_audio_*`,
`read_text_file`, `write_text_file`, `local_audio_*_tags`, `local_audio_watch`/`unwatch`,
`refresh_youtube_music_cookie`, `open_current_log`) and all of them work. Either delete the two
blocks or stop treating them as a checklist; do not add to them expecting an effect.

`app.security.csp` is `null` — no CSP. Required because the YouTube IFrame API script is loaded from
`youtube.com` at runtime. The `rust` audio engine loads nothing from `youtube.com`, so retiring the
IFrame path is the precondition for tightening this.

Defense in depth that *is* in place:

- Two-stage log redaction (TS `sanitizeForLog` → Rust `sanitize_log_message` / `sanitize_log_url`).
- Cookie jar writes are gated on `is_youtube_cookie_host`, an exact-or-parent-domain check.
- Discord artwork restricted to `i.ytimg.com` / `lh3.googleusercontent.com` / `yt3.ggpht.com`, presence links to YouTube hosts, HTTPS only.
- `local_audio_read` / `local_audio_write_tags` re-validate path and extension rather than trusting the frontend; `read_text_file` is size-capped.
- `offline_entry_path` rejects traversal in track ids.
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

Linux packaging lives outside `src-tauri/`: `packaging/aur/` (PKGBUILD + `.SRCINFO`),
`packaging/flatpak/` (manifest, desktop entry, metainfo), and `manifests/` for winget — each with a
release workflow under `.github/workflows/`.

---

## 6. Tests

`cargo test` runs the `#[cfg(test)]` module at the bottom of `lib.rs`:

| Test | Covers |
|---|---|
| `set_cookie_merges_rotations_into_the_stored_session` | `apply_set_cookie` — replace, add, no-op, tombstone, order preservation |
| `only_the_noisy_cookies_may_be_persisted_late` | `is_slow_persist_cookie` — `SIDCC` may wait, credentials may not |
| `account_identity_survives_a_renewal_and_changes_with_the_account` | `cookie_account_identity` fallbacks and the empty-value `None` |
| `only_youtube_hosts_touch_the_cookie_jar` | `is_youtube_cookie_host` rejects `notyoutube.com` and googlevideo |
| `audio_url_with_range_appends_without_disturbing_the_signature` | query present/absent, percent-encoding preserved |
| `signed_content_length_reads_clen` | `clen` parsing |
| `audio_chunk_size_splits_a_song_and_bounds_the_extremes` | a 2.5 MB song splits into several ranges; tiny files stay at the floor, huge ones at the cap |
| `sanitize_log_url_*` | secrets withheld by value, diagnostics kept, unparseable input |
| `cookie_domain_matches_*` | exact, parent-domain, and rejection cases |
| `media_items_stay_capped_and_evict_the_coldest_first` | `store_media_item` holds the cap and drops the oldest, not an arbitrary entry |
| `restoring_the_same_track_replaces_rather_than_accumulates` | a stable key means a replay reuses its slot |
| `buffer_reader_serves_only_the_contiguous_prefix` | `BufferReader` waits for the head instead of serving a chunk that landed early, spans chunk boundaries in one read, reports EOF on a failed download, and clamps a seek past the end |

The frontend's equivalent is `npm run check` (`scripts/run-checks.mjs` over `src/**/*.check.ts`).
There is no component/DOM test harness on either side.
