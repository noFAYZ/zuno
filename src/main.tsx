import React from "react";
import ReactDOM from "react-dom/client";
import App from "./ui/App";
import { ErrorBoundary } from "./ui/components/ErrorBoundary";
import "./ui/styles/global.css";
import { logInternalError, logInternalInfo } from "./internal/logging";
import { applyPaperPcMode, hydratePaperPcMode } from "./ui/settings/paperPcMode";
import { applyTheme, hydrateTheme, watchSystemTheme } from "./ui/settings/theme";
import {
  applyNativeWindowControls,
  hydrateWindowControlSettings,
} from "./ui/settings/windowControls";
import { hydrateMiniPlayerSettings } from "./ui/settings/miniPlayer";
import { hydratePlayerControlSettings } from "./ui/settings/playerControls";
import { hydrateQueuePanelSettings } from "./ui/settings/queuePanel";
import { hydrateTraySettings } from "./ui/settings/tray";
import { hydrateAudioQualitySettings } from "./internal/audioQuality";
import { hydrateAudioEngineMode } from "./ui/settings/audioEngine";
import { notifyLocalPlaylistsChanged, syncLocalAudioWatcher } from "./player/localPlaylists";
import { listen } from "@tauri-apps/api/event";
import { hydrateLastFmSettings } from "./ui/settings/lastfm";
import { hydrateDiscordSettings } from "./ui/settings/discord";
import { hydrateSidebarSettings } from "./ui/settings/sidebarMode";
import { hydrateKeyboardShortcuts } from "./ui/settings/keyboardShortcuts";
import {
  hydrateMainWindowGeometry,
  restoreMainWindowGeometry,
} from "./ui/settings/mainWindowGeometry";
import { applyPlatformAttributes } from "./ui/platform";
import { hydrateArtworkCache } from "./internal/artworkCache";
import { DiscordRpcService } from "./player/DiscordRPC";
import { hydratePlaybackSettings } from "./player/playbackSettings";
import { hydratePlayHistory } from "./player/playHistory";
import { hydrateSessionRestoreSetting } from "./ui/settings/sessionRestore";
import { hydrateToolbarItemSettings } from "./ui/settings/toolbarItems";
import { hydrateHomeSectionSettings } from "./ui/settings/homeSections";

logInternalInfo("main.bootstrap start");
// Before React mounts: a resolution restored after first paint is a resolution that already
// let its image flash the fallback icon.
hydrateArtworkCache();
applyPlatformAttributes();
// Before React mounts: a late theme apply shows a flash of the wrong palette.
applyTheme();
watchSystemTheme();
applyPaperPcMode();
void applyNativeWindowControls();
void hydrateMainWindowGeometry().then(restoreMainWindowGeometry).catch((error) => {
  logInternalError("mainWindowGeometry.restore failed", error);
});
void Promise.all([
  hydratePaperPcMode(),
  hydrateTheme(),
  hydrateWindowControlSettings(),
  hydrateMiniPlayerSettings(),
  hydratePlayerControlSettings(),
  hydrateQueuePanelSettings(),
  hydrateTraySettings(),
  hydrateAudioQualitySettings(),
  hydrateAudioEngineMode(),
  hydrateLastFmSettings(),
  hydrateDiscordSettings(),
  hydrateSidebarSettings(),
  hydrateKeyboardShortcuts(),
  hydrateToolbarItemSettings(),
  hydrateHomeSectionSettings(),
  hydratePlaybackSettings(),
  hydratePlayHistory(),
  // Read synchronously from local storage at boot, so this only backfills a machine whose
  // local storage was cleared — it takes effect from the next launch.
  hydrateSessionRestoreSetting(),
]).catch((error) => {
  logInternalError("settings hydration failed", error);
});

// Initialize Discord RPC (non-blocking)
logInternalInfo("[Discord RPC] Initializing Discord RPC service");
try {
  void DiscordRpcService.init().catch((error) => {
    logInternalError("[Discord RPC] initialization error", error);
  });
} catch (error) {
  logInternalError("[Discord RPC] failed to initialize", error);
}

window.addEventListener("error", (event) => {
  logInternalError("window.error", event.error ?? event.message, {
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  logInternalError("window.unhandledrejection", event.reason);
});

/*
 * The outermost boundary. Nothing below it can be recovered from selectively, so its only
 * job is to make sure a render error leaves something on screen with a button on it rather
 * than a blank window — a desktop shell has no address bar to reload from.
 */
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary label="Zuno">
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

/*
 * Local folders are watched for the whole session. The event carries no detail on purpose —
 * a rescan is cheap and precisely diffing renames, temp files and write-then-replace editors
 * would be far more code for the same visible result.
 */
syncLocalAudioWatcher();
void listen("local-audio-changed", () => notifyLocalPlaylistsChanged());

