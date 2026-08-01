# Frontend — components, pages, modules

React 19 + TypeScript, Tailwind v4, `motion` for animation, Solar icons. No router, no state
library, no CSS Modules. See [architecture.md](./architecture.md) for the system view and
[backend.md](./backend.md) for the IPC surface.

---

## 1. Entry points

### `src/main.tsx` — main window

Runs before React mounts, in this order:

1. `hydrateArtworkCache()` — a resolution restored after first paint is one that already flashed the fallback icon.
2. `applyPlatformAttributes()` — sets `data-platform-linux` on `<html>`.
3. `applyTheme()` + `watchSystemTheme()` — sets `data-theme`; `system` keeps following the OS rather than resolving once.
4. `applyPaperPcMode()` / `applyNativeWindowControls()` — synchronous theme + decoration flags from localStorage.
5. `hydrateMainWindowGeometry()` → `restoreMainWindowGeometry()`.
6. `Promise.all` of ~18 `hydrate*` functions (paperPc, theme, windowControls, miniPlayer, playerControls, queuePanel, tray, audioQuality, audioEngineMode, lastFm, discord, sidebar, keyboardShortcuts, toolbarItems, homeSections, playbackSettings, playHistory, sessionRestore) — these reconcile localStorage against Rust-owned durable settings.
7. `DiscordRpcService.init()`.
8. `window.error` + `window.unhandledrejection` → `logInternalError`.
9. `createRoot().render(<StrictMode><ErrorBoundary label="Zuno"><App/></ErrorBoundary></StrictMode>)` — the outermost boundary exists because a desktop shell has no address bar to reload a blank window from.
10. `syncLocalAudioWatcher()` and `listen("local-audio-changed")` → `notifyLocalPlaylistsChanged()`.

### `src/mini.tsx` — mini-player window

Minimal: platform attributes, `hydrateMiniPlayerSettings()`, render `<MiniPlayer/>`. It holds no
controllers — all state arrives over Tauri events from the main window.

---

## 2. `App.tsx` — the root

2150 lines, the only component with meaningful state. It owns:

| Concern | State / refs |
|---|---|
| Tabs | `tabs: Tab[]`, `activeTabId`, `nextTabId` — restored from `loadAppSession()` |
| Navigation | Per-tab `navigationHistory: { back: TabViewState[], forward: TabViewState[] }` |
| Layout | `sidebarWidth`, queue-panel open/collapsed state |
| Onboarding | `onboardingStep`, keychain notice, completion toast |
| Updates | `availableUpdate`, snooze handling, release note dialog |
| Loading screen | `loadingScreenState`, min 1000 ms / max 4000 ms, 80 ms fade |
| Mini player | positioning, focus-driven create/destroy, suppression windows during drags |
| Recovery | sleep detection (15 s timer, 60 s drift threshold) → reload; connection recovery on window focus |
| Session persistence | an effect on `[tabs, activeTabId, nextTabId, playerSession]`, `beforeunload`, and a `SESSION_HEARTBEAT_MS` (5 s) heartbeat |

**On that heartbeat:** the effect and `beforeunload` are the real persistence path; the timer only
keeps `positionSec` fresh for a restore after a crash or a kill. It ran every second, rebuilding
every tab's full queue and history into a multi-megabyte object graph, stringifying it and writing
it synchronously — for a field that only has to be roughly right. At five seconds a hard kill costs
at most five seconds of position, and `saveAppSession` skips the write outright when the payload is
unchanged.

Every page below it is `lazy`-loaded behind `Suspense`. Only Home is reachable at startup; the
chunks come off local disk in a Tauri app, so the win is startup parse/compile time rather than
transfer size. Each page is a named export, hence the `.then(m => ({ default: m.X }))` shim.

### The tab model (`ui/types/tab.ts`)

```ts
type TabView =
  | "home" | "album" | "artist" | "playlist" | "related"
  | "search" | "history" | "browse" | "library" | "settings";
type NavigableTabView = Exclude<TabView, "settings">;

interface Tab {
  id: string;
  view: TabView;
  title?: string;
  browseTab?: string;                 // which Browse surface; only meaningful when view is "browse"
  album?: Album; artist?: Artist; playlist?: Playlist;
  relatedTrack?: Track;               // the track a "related" view is about
  searchQuery?: string; searchResults?: Track[]; mixedSearchResults?: SearchResults;
  searchLoading?: boolean;
  isQueueOpen?: boolean;
  navigationHistory?: TabNavigationHistory;
}
```

A tab is *both* a browser-style navigation context **and** an independent player. `settings` is
excluded from navigation history (`NavigableTabView`), so opening Settings never pollutes back/forward.
`getNavigationKey()` deduplicates consecutive identical entries; `stripNavigationHistory()` keeps
history out of the persisted session.

### Global keyboard handling

Shortcuts come from `ui/settings/keyboardShortcuts.ts` (user-remappable, persisted) — 19 actions:
`playPause`, `mute`, `previousTrack`, `nextTrack`, `closeTab`, `newTab`, `search`,
`navigateBack`/`Forward`, and `tab1`–`tab9`. `App.tsx` matches them with `eventMatchesShortcut`;
mouse buttons 3/4 map to back/forward. `ui/pages/pageSearchKeyboard.ts` decides when a bare
printable keypress should start in-page search — it refuses when focus is in a text field or when
the key matches any bound shortcut.

### Render tree

```
<MotionConfig reducedMotion>        driven by Paper-PC mode; stops beUI's JS motion
 <ArtistNavigationProvider>         artist-link click → navigate current tab
  <TrackContextMenuProvider>        right-click track menu, like/queue/playlist actions
   <PlaylistContextMenuProvider>    right-click playlist/album menu
    <TitleBar>                      drag region, MusicTabs, toolbar items, window controls
    <Layout sidebar + rightPanel>   Sidebar, SearchBar, StarField, custom scrollbar
      └ page (lazy): HomePage | AlbumView | ArtistView | PlaylistView | RelatedPage
                   | SearchResultsPage | LibraryPage | BrowsePage | HistoryPage | SettingsPage
      └ rightPanel: <QueuePanel>    full or collapsed to a 62px artwork rail
      └ overlay:    <LyricsView>
    <PlayerBar>                     TrackInfo, PlaybackControls, SeekBar, VolumeControl,
                                    DownloadButton, PlaybackOptions, LyricsButton
    <VolumeSyncBridge>              leaf subscriber; keeps volume drags off the root
    <SelectionBar>                  multi-select actions, docked above the player bar
    <SearchOverlay>                 Ctrl/⌘+K
    <AuthOverlay> <AppLoadingScreen> <KeychainNotice> <Onboarding*>
    <UpdateToast> <ReleaseNoteDialog>
```

---

## 3. Components (`src/ui/components/`)

Tailwind classes inline; there are no `*.module.css` files.

### Chrome and layout

| Component | Purpose |
|---|---|
| `TitleBar.tsx` | Custom frameless title bar: drag region, home button, embedded `MusicTabs`, optional toolbar items (downloads, notifications, account), and minimize/maximize/close. Honours the "Windows-style controls" and "native controls" settings; hidden entirely when native decorations are on. Carries the Discord / Last.fm / YouTube Music / GitHub indicators, each dimmed when its feature is off and each clickable to toggle it; all four are hideable via `toolbarItems.ts`. |
| `MusicTabs.tsx` | Tab strip with pointer-based drag reorder, close buttons, a volume icon marking the tab currently producing sound, and a title ellipsis. |
| `Layout.tsx` | Three-column shell: resizable sidebar, page content, optional right panel. Implements a custom transient scrollbar (browser scrollbars are hidden globally in `global.css`) with hover/drag persistence and auto-hide. Renders `StarField` unless Paper-PC mode is on, and subscribes to `ambientArtworkStore` for the accent wash behind the chrome. |
| `Sidebar.tsx` | Library rail: liked songs, playlists, albums, local playlists. Three width modes (`collapsed` 62px / `expanded` 240px / `hover`). Ordering, filtering and drag-reorder logic lives in `sidebarLibrary.ts` (with a `.check.ts`) precisely because dropping a row while the list is filtered or alphabetised would write an order derived from a list the user wasn't looking at. |
| `SearchBar.tsx` | Inline search entry in the layout header; opens the overlay. |
| `StarField.tsx` | Decorative animated background; skipped in Paper-PC mode. |
| `FloatingPanel.tsx` | Shared anchored-popover shell for the title-bar panels: side selection, 10px gap, 12px viewport margin. |
| `ErrorBoundary.tsx` | Wraps the app root and each lazy page. React unmounts the whole tree on an unhandled render error — in a desktop shell that's a permanently blank window. |

### Content and interaction

| Component | Purpose |
|---|---|
| `SearchOverlay.tsx` | ⌘/Ctrl+K palette. Fuzzy-scores your playlists/albums locally (`searchMatchScore`: exact 4 → prefix 3 → contains 2 → reverse-contains 1, with NFKD-normalized fallbacks), fetches remote suggestions, keeps recent searches, and recognises a pasted YouTube link (`looksLikeYouTubeLink`) to resolve rather than search. Shift-Enter opens results in a new tab. |
| `TrackRow.tsx` | The one row used by every track list. `memo`'d with `propsEqual`, which ignores handler identity — comparing inline arrows with `Object.is` meant the memo never returned true and did nothing at all, rebuilding 500 rows to repaint two. Handlers are invoked through a ref refreshed each render, which is what makes that safe. Also carries `content-visibility: auto` with `contain-intrinsic-size: auto 52px`, so off-screen rows skip layout, paint and compositing — see §8. |
| `TrackContextMenu.tsx` | React context provider + menu: like/dislike, play next, add to queue, add to playlist (with submenu and pending state), remove from playlist, download/remove download, edit tags (local files), copy link, search artist, go to related. Viewport-edge flipping via `useLayoutEffect`. |
| `PlaylistContextMenu.tsx` | Same pattern for playlists/albums: play, save/unsave, rename/describe/delete, local-playlist management, import/export, download all, remove. |
| `SelectionBar.tsx` | Bulk actions for a multi-selection, floating above the player bar so it doesn't push the list around as it appears. |
| `MediaHeader.tsx` | Shared album/playlist/artist header. Its "24 songs · 1 hr 32 min" line drops the duration unless every counted track reported one *and* the list is fully loaded — YouTube omits `durationSec` on most playlist entries, and summing what happens to be present read "98 songs · 3 min". |
| `BrowseShelves.tsx` | Horizontal scrollable shelves for browse/related surfaces, clipped at the edge to hint at more. |
| `HomeDestinations.tsx` | Library / History / Downloads / Browse entry points on the home page, with live counts — they moved off the collapsed rail because unlabelled glyphs there competed with playlist artwork for attention. |
| `AccountSwitcher.tsx` | Channel/brand-account picker plus the shared `AccountAvatar` (a new URL gets a fresh attempt, so one broken image doesn't poison the slot). |
| `GoogleSignInButton.tsx` | The single sign-in button used everywhere. Previously three different-looking buttons for the same consequential action. |
| `AuthOverlay.tsx` | Progress for sign-in and account-switch, driven by `LibraryState.authProgress`. The stages are listed per flow rather than filtered from one array — switching channel has no browser step, and rendering it as "skipped" would claim something that never happened. |
| `NotificationsPanel.tsx` | Artist release feed with an unseen badge, refreshed on a slow interval — new releases arrive on the order of days. |
| `DownloadsPanel.tsx` | Recent downloads (4) with progress and byte totals; the full list is the `downloads` browse surface. |
| `TagEditor.tsx` | Local-file tag editing via `local_audio_read_tags` / `local_audio_write_tags`. |
| `ArtistLinks.tsx` | Renders `Track.artists[]` as individually clickable links through `ArtistNavigationProvider`; falls back to the plain artist string. |
| `TrackArtwork.tsx` | Artwork with loading/fallback states, backed by `internal/artworkCache.ts` so remounts don't rewalk the candidate URLs. |
| `AlbumCard.tsx` / `PickCard.tsx` | Grid card and carousel card (the latter distinguishes a tap from a carousel drag with a 5px slop). |
| `DiceCard.tsx` | The "surprise me" shuffle entry point on the home page. |
| `ExternalLinkButton.tsx` | Open-or-copy with inline outcome feedback. |
| `Onboarding.tsx` | `OnboardingWelcome`, stepped `Onboarding` (`onboardingSteps.ts`), `OnboardingCompleteToast`, and `KeychainNotice` (macOS keychain-prompt explainer). |
| `AppLoadingScreen.tsx` | Startup splash with a leaving/fade state. |
| `UpdateToast.tsx` / `ReleaseNoteDialog.tsx` | Update available → download progress → restart (or "open release page" on macOS); and the one-time post-update note. |

### Player (`components/player/`)

| Component | Purpose |
|---|---|
| `PlayerBar.tsx` | Bottom bar composing the pieces below; also surfaces connection-restored recovery. Compact and expanded layouts (`playerControls.ts`). |
| `TrackInfo.tsx` | Artwork + title + `ArtistLinks`, click-through to album/artist. |
| `PlaybackControls.tsx` | Previous / play-pause / next, shuffle and repeat as independent toggles. |
| `SeekBar.tsx` | Position scrubber; writes `isSeeking` to `playerUIStore` so position polling doesn't fight the drag. |
| `VolumeControl.tsx` | Slider + mute; writes `isDraggingVolume` to the UI store. |
| `VolumeSyncBridge.tsx` | Mirrors volume/mute to the mini window. A leaf component rather than an effect in `App` on purpose: volume commits on every pointer move, and subscribing at the root re-rendered the whole tree per drag. |
| `DownloadButton.tsx` | Download / cancel / remove for the **now-playing** track specifically — an indicator that lit up for any queued download reported on a song the listener hadn't thought about in ten minutes. |
| `PlaybackOptions.tsx` | Playback speed (0.75–2×) and a sleep timer (15–90 min, plus "end of track"). |
| `LyricsButton.tsx` | Toggles the lyrics overlay. |
| `QueuePanel.tsx` | Right-panel queue with drag reorder, remove, jump-to-index, and stop-after-track. Collapses to a 62px artwork rail. Reordering is restricted to within a queue region (manual↔manual, automatic↔automatic) — `Queue.move()` rejects cross-region moves (`Queue.check.ts`). |
| `ExpandedPlayerBar.tsx` | **Not rendered** — its JSX in `App.tsx` is commented out. |

### Mini player (`components/mini-player/MiniPlayer.tsx`)

A transparent always-on-top pill in its own window (~1.1k lines).

- Created on `main-window-backgrounded` / `main-window-minimized`, **destroyed** on `window-focused`. Its own close button calls `win.destroy()` for the same reason. `handleRestore` raises the main window without awaiting its own `hide()`: the main window answers `mini-player:restore-main` by destroying this one, so an awaited self-call can reject after the window is gone and abort the restore.
- Expands on hover into a two-pill layout with transport controls.
- Right-mouse or empty-area drag moves the window; the position is debounced into settings and echoed as `mini-player:position-changed`.
- Hover behaviour over the progress area is configurable: `seek` or `volume` (`mini-player-hover-action`).
- Communicates purely over Tauri events. It asks for `mini-player:request-sync` only *after* its `player-state-sync` listener is live, so the reply can't arrive before anything is listening.

---

## 4. Pages (`src/ui/pages/`)

| Page | Notes |
|---|---|
| `HomePage.tsx` | Recently played, `HomeDestinations`, a `CylinderCarousel` of picks, and generated suggestions memoized in a module-level `Map` (20 entries, LRU) keyed by tab *and* a signature of the recently-played list. The key is computed above the `useState` calls so the initial render can read it — seeding from `tabId` alone meant the memo never hit and Home opened on a spinner every time. Falls back to canned queries when signed out. Sections are toggleable (`homeSections.ts`). |
| `LibraryPage.tsx` | The whole saved library in one view — playlists, albums, artists, songs. |
| `BrowsePage.tsx` | The non-search surfaces through `getBrowsePage` — `explore` / `charts` / `moods` / `podcasts`, plus the local `downloads` list. Which one opens is carried on `Tab.browseTab`. |
| `HistoryPage.tsx` | Local play log from `player/playHistory.ts`, with per-entry removal and clear-all. |
| `AlbumView.tsx` | Album header + track list, save/unsave, play-all, download-all, per-track context menu. |
| `ArtistView.tsx` | Artist header, subscribe toggle and notification level, popular songs, all songs, releases, playlists. Subscription state has a 60 s optimistic override because the remote value lags. |
| `PlaylistView.tsx` | Paginated track list (`getPlaylistTrackPage`, page-key session cached), in-page search filter, multi-select, drag reorder, rename/describe/delete, import/export, remove-from-playlist. |
| `RelatedPage.tsx` | `getRelated` shelves for a single track. |
| `SearchResultsPage.tsx` | Mixed results grouped by artists / tracks / albums / playlists, painted incrementally from streaming `onUpdate` callbacks, with per-category drill-down. |
| `LyricsView.tsx` | Overlay. Synced lyrics scroll to the active line; per-track timing offset, font scale, translation, and a source-attempt trail. Whether a karaoke highlight runs is decided by `lyricsTiming.ts` from the lines themselves, not from the provider's `timing` field — one line without a start time makes the highlight jump backwards. |
| `SettingsPage.tsx` | Six tabs: **Account** (sign-in, accounts, Last.fm, Discord, updates, delete all data), **Appearance** (theme light/dark/system, Paper-PC mode, made-for-you sections), **Playback** (audio engine, signed-in stream resolution, YouTube history reporting, streaming/download quality, gapless, crossfade, transitions, lyrics translation/size/source), **Library** (cache size and clearing, local music folders via `dialog:open` → `local_audio_scan`, downloads ceiling), **Window** (decorations, control style, mini player, sidebar mode, tray, geometry, session restore, autostart), **Shortcuts** (rebinding). |
| `collectTrackPages.ts` | Pages a track list to the end. Extracted from the views because the loop's *termination* is what fails quietly — a cursor that stops advancing spins forever (`collectTrackPages.check.ts`). |
| `pageSearchKeyboard.ts` | `shouldStartPageSearch()` — see §2. |

---

## 5. Settings modules (`src/ui/settings/`)

All follow the same shape: a storage key, a change-event name, `read*` / `set*` / `hydrate*`
functions, and a `use*` hook built on `useSyncExternalStore` that listens to both the custom event
and `storage` (for cross-window sync). Writes go to localStorage **and** durable Rust settings via
`internal/durableLocalSetting.ts`.

| Module | Setting(s) |
|---|---|
| `theme.ts` | `system` / `light` / `dark`, written as `data-theme` before React mounts. `system` keeps following the OS via a `matchMedia` listener rather than resolving once at startup. |
| `keyboardShortcuts.ts` | Remappable map for 19 actions, with `eventMatchesShortcut` and platform-aware modifier labels (⌘ vs Ctrl). |
| `miniPlayer.ts` | Enabled flag, saved position (debounced), hover action, `resetMiniPlayerPosition()`. Owns the window's whole lifecycle: `ensureMiniPlayerWindow()` / `destroyMiniPlayerWindow()` run through one serialized promise chain so a blur/focus pair can't interleave into an orphaned or prematurely-destroyed window. |
| `audioEngine.ts` | `iframe` (default) vs `native` playback. The value is cached in-module because `AudioEngine` reads it on every load, play, pause, seek and volume change — a raw localStorage hit would sit in the playback path. Exports `AUDIO_ENGINE_MODE_CHANGE_EVENT` so the engine can free its IFrame decks the moment the mode stops being `iframe`. |
| `youtubeAccount.ts` | Two account choices, both default off: resolve streams with the session attached, and report plays to YouTube Music history. `setYouTubeScrobbling` carries the streaming flag with it in both directions; `setAuthenticatedStreaming` leaves scrobbling alone, so signed-in playback without history is reachable. Both cached in-module — one is read on every track load, the other on every progress tick. |
| `mainWindowGeometry.ts` | Size + position persistence with a min-size guard (900×600) and monitor-bounds validation; toggleable, and clears the stored value when disabled. |
| `windowControls.ts` | `native-window-controls` (default on for Linux) and `windows-style-window-controls`; applies `setDecorations()` and toggles `data-native-window-controls`. |
| `paperPcMode.ts` | Low-end mode: kills animations, transitions, shadows, and backdrop filters via `data-paper-pc`. Reloads on Linux where blur can't be toggled live. |
| `sidebarMode.ts` | `collapsed` (62px) / `expanded` (240px) / `hover` — default `hover`. |
| `queuePanel.ts` | Queue collapsed to an artwork rail vs full list. Defaults to collapsed. |
| `toolbarItems.ts` | Which optional buttons the title bar carries. |
| `homeSections.ts` | Which optional sections the home page carries. |
| `playerControls.ts` | Compact vs expanded player bar; whether extra controls are always visible. |
| `playbackTransitions.ts` | Gapless flag and crossfade seconds, backed by `player/playbackSettings.ts`. |
| `sessionRestore.ts` | Whether tabs and queues come back after a restart. Read synchronously at boot, so the hydrate only backfills a cleared localStorage — it takes effect from the next launch. |
| `tray.ts` | `minimize-to-tray`; the one setting Rust reads out of `settings-v1.json` itself. |
| `lyricsTranslation.ts` | Target language or `off`. Off by default and off is a real value: translation sends the words of whatever is playing to a third-party endpoint, so it happens because someone asked. |
| `lyricsFontScale.ts` | A multiplier, not a size set — the underlying scale is a container-width `clamp()`, and fixed sizes would throw that away. |
| `lyricsOffset.ts` | Per-track timing nudge. LRCLIB matches on title/artist/±2 s duration, which is loose enough to return a different master whose words land a second off. |
| `lastfm.ts` / `discord.ts` | Scrobbling and rich-presence enable flags + connection state. |
| `autostart.ts` | `tauri-plugin-autostart` enable/disable/isEnabled. |

Non-`ui/settings` siblings that follow the same contract: `internal/audioQuality.ts` (streaming and
download caps set independently — the reason to cap one is not the reason to cap the other) and
`internal/lyricsSourcePreference.ts`.

---

## 6. Stores and hooks

| Export | Source | Purpose |
|---|---|---|
| `usePlayerState()` | `player/playerStore.ts` | Effective player's `PlayerState` (status, current track, history, order mode, shuffle, volume, muted) |
| `usePlayerSelector(select)` | same | Narrowed slice compared with `shallowEqual` — the preferred hook; the whole state object re-renders far more than any one component needs |
| `usePlayerSession()` | same | Full session snapshot including the queue |
| `useLibraryState()` | same | `LibraryController` state (status, snapshot, auth prompt, auth progress, pending likes, `sessionConfirmedAt`) |
| `usePlayerUIState()` | `ui/stores/playerUIStore.ts` | Transient UI: `isSeeking`, `isDraggingVolume`, `showAlbumArt`, `isLyricsOpen`, `isQueueOpen` |
| `useAmbientArtwork()` | `ui/stores/ambientArtworkStore.ts` | Artwork the current page wants the chrome tinted by. The page publishes, `Layout` subscribes — the wash starts above the search bar but the page that knows the artwork renders below it, inside a clipping scroll container |
| `useOfflineState()` | `player/offlineStore.ts` | Download manifest, statuses and progress |
| `usePlayHistory()` | `player/playHistory.ts` | Local play log |
| `useNowPlaying()` | `ui/hooks/` | Just the primitives a collection page needs to mark rows, so `TrackRow`'s memo stays cheap |
| `useTrackSelection()` | `ui/hooks/` | Multi-select modelled on file managers: ctrl/cmd toggles, shift extends from the last row touched, a plain click does nothing to the selection |
| `useDisableContextMenu()` | `ui/hooks/` | Suppresses the native WebView context menu app-wide |
| `isMacOS` / `isLinux` / `isWindows`, `primaryModifierLabel` | `ui/platform.ts` | UA-based platform detection |

`playerController` (from `playerStore`) is the facade any component should call — it always resolves
to the correct tab's `PlayerController` and claims playback ownership when starting new audio.

---

## 7. Styling

**Tailwind CSS v4** via `@tailwindcss/vite`, with one global sheet at `ui/styles/global.css`.
Inter is self-hosted through `@fontsource-variable/inter` — this is an offline desktop app, and a
CDN webfont that fails leaves the UI on a fallback face. `docs/` is excluded from Tailwind's source
scan (the reference dumps in there are full of class names the app never uses).

- **Design tokens live in a Tailwind `@theme` block** and follow shadcn naming, because that is
  what the vendored beUI components are written against: `--color-background`, `--color-foreground`,
  `--color-card`, `--color-popover`, `--color-muted` / `--color-muted-foreground`, `--color-border`,
  `--color-input`, `--color-ring`, `--color-destructive`, `--color-secondary`, `--color-primary`.
- The palette is **neutral shadcn surfaces + the app's `#ff0033` as `--color-primary`**. Red is an
  accent only — `bg-primary` / `text-primary` for play state, active tabs and primary actions,
  never for large surfaces. It stays `#ff0033` in both themes: it's the brand accent, not a surface.
- **Never put `backdrop-blur` on an opaque background.** `--color-background`, `--color-card` and
  `--color-popover` have no alpha in either theme, so a backdrop filter behind them costs a
  composited layer and a blur pass to render something nothing can see through. Seven always-on
  surfaces carried one — the content pane, title bar, sidebar, player bar, search field, right
  panel and queue header — and removing them changed nothing visually. Blur belongs only on a
  translucent fill (`bg-card/60`, `bg-background/70`).
- **Blur radius sizes the compositor's intermediate textures**, so the two always-on filters are
  kept modest: the ambient wash at `blur-[32px]` (its source is a 120px image stretched to full
  width — a ~20x upscale is already most of the softness) and StarField's blobs at `blur-2xl`
  (they are `rounded-full` gradients fading to transparent, so the fill does the work).
- The UI is **borderless** — surfaces are separated by background contrast, not outlines.
  `--color-border` / `--color-input` exist only because beUI internals reference them.
- Non-colour `:root` constants: `--ambient-bloom` (strength of the accent wash behind the window,
  a token because the same wash reads as a glow over near-black and a stain over near-white),
  `--window-edge` / `--window-edge-highlight` (the window is transparent with its OS shadow
  disabled, so a hairline is the only thing separating the app from what's behind it),
  `--titlebar-height`, `--sidebar-width`.
- Global resets beyond Tailwind preflight: `body { overflow: hidden }`, scrollbars zeroed out
  (`Layout.tsx` draws its own transient scrollbar), text selection disabled except in inputs,
  focus rings only on `:focus-visible`.
- **Theme/behaviour switches are HTML attributes**, not classes:
  - `html[data-theme="light" | "dark"]` — the `@theme` block is the dark default; the light block
    flips the same token names, so every component follows without knowing a theme exists.
  - `html[data-paper-pc]` — overrides the colours with fully opaque equivalents and kills
    animation, box-shadow and backdrop-filter. That only stops *CSS* animation; beUI's JS-driven
    motion is stopped by the `<MotionConfig reducedMotion>` bridge in `App.tsx`.
  - `html[data-platform-linux]` — disables backdrop filters (WebKitGTK performance).
  - `html[data-native-window-controls]` — hides the custom window buttons.

### Component vocabulary

Animated primitives are vendored from the [beUI](https://beui.dev) registry into
`src/components/motion/`, with shared helpers in `src/lib/` (`cn`, `ease`, `use-hover-capable`).
They are kept at the registry's own paths so a future re-pull drops in without rewriting imports.
App-owned components stay in `src/ui/`. `@` is aliased to `src/`, so beUI's `@/components/...`
imports resolve unchanged.

Vendored: `action-swap`, `bounce-sidebar`, `bouncy-accordion`, `button` (base/stateful/magnetic),
`center-morph-modal`, `command-palette`, `cylinder-carousel`, `drawer`, `input`, `loader`,
`magnetic`, `marquee`, `popover`, `range-slider`, `select`, `switch`, `tabs`, `tilt-card`, `tooltip`.

**When re-pulling from the registry**, run the de-lucide pass afterwards — beUI ships
`lucide-react` imports for its default icons, and this project uses Solar exclusively.

### Icons

All icons come from `@solar-icons/react` (pinned to `2.0.0-beta.0` — the v2 API does not exist on
the `latest` 1.x line) and are re-exported from **`src/ui/icons.tsx`** (~86 exports). Components
import only from there, never from `@solar-icons/react` directly, so a renamed upstream icon breaks
one file. Single-icon import paths are used deliberately: the style barrel makes the dev server
resolve ~1.2k modules per style.

Convention (see [solarIcons.md](./solarIcons.md)): the default export is Solar **Linear**
(resting/secondary state); a `*ActiveIcon` alias is Solar **Bold** (active/primary — playing, liked,
saved, selected). The weight change *is* the state signal. Solar ships no brand icons, so
`LastFmIcon` stays a hand-rolled inline SVG. Solar icons take `strokeWidth`, not the raw SVG
`stroke` attribute.

---

## 8. Conventions worth keeping

- **Feature-detect optional data-source methods** (`this.dataSource.getLyrics?.(...)`) instead of assuming.
- **Guard async work with request ids** — the codebase uses this everywhere for cancellation; a bare `await` that then calls `setState` is a bug waiting for a fast click.
- **Two-tier settings**: never write only to localStorage; use the `durableLocalSetting` helpers so the value survives a WebView data reset.
- **Prefer `usePlayerSelector` over `usePlayerState`**, and subscribe at the leaf that needs the value — `VolumeSyncBridge` exists solely because subscribing to volume at the root re-rendered the tree on every pointer move.
- **`memo` with `propsEqual`, not the default**, for row components handed inline arrows — and route the handlers through a ref so it stays correct.
- **The track lists are not windowed, deliberately.** `PlaylistView`, `AlbumView`, `SearchResultsPage`, `HistoryPage` and `QueuePanel` all map the full array; the `IntersectionObserver` in `PlaylistView` is infinite-scroll paging, not virtualization. Windowing fights two features that need the whole index space — drag-reorder (the dragged row must survive scrolling out of range) and `useTrackSelection`'s shift-range. `content-visibility: auto` on `TrackRow` buys most of the rendering win for one line instead: the nodes stay, the work does not. Use `contain-intrinsic-size` with the `auto` keyword so the browser prefers the height it last measured and the literal only covers rows never yet on screen.
- **Policy belongs in a named method, not a flag on a shared one.** `resolveStreamUrl` and `resolveDownloadUrl` wrap one private core; only the playback wrapper reads the authenticated-streaming setting, so downloads cannot inherit it through a mis-edited condition. A `purpose` parameter would have left that guarantee resting on a boolean.
- **Bound every module-level cache.** `artworkCache` (16 MB of blobs, 500 entries), `HomePage`'s `suggestionCache` (20 entries), `playHistory` (500), `playlistMembership` (1000) all evict oldest-first. A `Map` keyed by anything that varies with use — a tab id, a search key, a recently-played signature — grows for as long as the app is open.
- **Log through `internal/logging.ts`**, never raw `console.*` — it redacts secrets and mirrors to the on-disk log.
- **Non-trivial pure logic gets a `*.check.ts`** next to it, run by `npm run check`. That is the whole frontend test story; there is no component harness.
- **Optimistic mutations roll back**: `LibraryController` snapshots the previous library, applies the change, and restores on error. Match that pattern for new mutations.
- **New Tauri command?** Register it in `generate_handler!` — that is sufficient. The `command.allow` list in `capabilities/default.json` is Tauri 1 leftover and gates nothing (see [backend.md](./backend.md) §4).
