import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, MotionConfig } from "motion/react";
import { invoke } from "@tauri-apps/api/core";
import type { Album, Artist, Playlist, SearchResults, Track } from "../datasource/types";
import { looksLikeYouTubeLink } from "../datasource/youtube/links";
import { useDisableContextMenu } from "./hooks/useDisableContextMenu";
import { HomePage } from "./pages/HomePage";

/*
 * Every page used to be statically imported, so the whole app — settings, lyrics, all four
 * browse views — was parsed before the first frame could paint. Only Home is reachable at
 * startup, so the rest load on first navigation.
 *
 * The chunks come off local disk in a Tauri app, not the network, so the win here is startup
 * parse/compile time rather than transfer size. Each page is a named export, hence the
 * default-shim; `lazy` requires a module whose default is the component.
 */
const AlbumView = lazy(() => import("./pages/AlbumView").then((m) => ({ default: m.AlbumView })));
const ArtistView = lazy(() => import("./pages/ArtistView").then((m) => ({ default: m.ArtistView })));
const PlaylistView = lazy(() =>
  import("./pages/PlaylistView").then((m) => ({ default: m.PlaylistView })));
const RelatedPage = lazy(() =>
  import("./pages/RelatedPage").then((m) => ({ default: m.RelatedPage })));
const SearchResultsPage = lazy(() =>
  import("./pages/SearchResultsPage").then((m) => ({ default: m.SearchResultsPage })));
const LibraryPage = lazy(() =>
  import("./pages/LibraryPage").then((m) => ({ default: m.LibraryPage })),
);
const BrowsePage = lazy(() =>
  import("./pages/BrowsePage").then((m) => ({ default: m.BrowsePage })),
);
const HistoryPage = lazy(() =>
  import("./pages/HistoryPage").then((m) => ({ default: m.HistoryPage })),
);
const SettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const LyricsView = lazy(() => import("./pages/LyricsView").then((m) => ({ default: m.LyricsView })));
import { SearchOverlay } from "./components/SearchOverlay";
import { TrackContextMenuProvider } from "./components/TrackContextMenu";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { VolumeSyncBridge } from "./components/player/VolumeSyncBridge";
import { PlaylistContextMenuProvider } from "./components/PlaylistContextMenu";
import { ArtistNavigationProvider } from "./components/ArtistLinks";
import { TitleBar } from "./components/TitleBar";
import { PlayerBar } from "./components/player/PlayerBar";
import { QueuePanel } from "./components/player/QueuePanel";
import { useQueuePanelCollapsed } from "./settings/queuePanel";

/** Wide enough for a 44px cover plus breathing room, matching the sidebar rail's feel. */
const COLLAPSED_QUEUE_WIDTH = 62;
import { Layout } from "./components/Layout";
import type { Tab, TabViewState } from "./types/tab";
import {
  libraryController,
  playerController,
  searchController,
  tabManager,
  useLibraryState,
  usePlayerSession,
  usePlayerSelector,
  shallowEqual,
} from "../player/playerStore";
import { clearAppSession, loadAppSession, saveAppSession } from "../player/appSession";
import { useMediaSession } from "../player/useMediaSession";
import { LastFmService } from "../player/LastFm";
import { playerUIStore, usePlayerUIState } from "./stores/playerUIStore";
import { AppLoadingScreen } from "./components/AppLoadingScreen";
import { AuthOverlay } from "./components/AuthOverlay";
import { UpdateToast } from "./components/UpdateToast";
import { ReleaseNoteDialog } from "./components/ReleaseNoteDialog";
import { markReleaseNoteSeen, resolveReleaseNoteVersion } from "../internal/releaseNote";
import {
  checkForUpdates,
  isUpdateSnoozed,
  type UpdateInfo,
} from "../internal/updateChecker";
import {
  clearAppSettings,
  getAppSetting,
  removeAppSetting,
  setAppSetting,
} from "../internal/appSettings";
import { clearCache } from "../internal/cache";
import {
  Onboarding,
  OnboardingCompleteToast,
  KeychainNotice,
  OnboardingWelcome,
  nextOnboardingStep,
  previousOnboardingStep,
  type OnboardingStep,
} from "./components/Onboarding";
import { isLinux, isMacOS } from "./platform";
import { usePaperPcMode } from "./settings/paperPcMode";

import { emit, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  availableMonitors,
  currentMonitor,
  getCurrentWindow,
  primaryMonitor,
} from "@tauri-apps/api/window";
import { logInternalWarn } from "../internal/logging";
import { PhysicalPosition } from "@tauri-apps/api/dpi";
import {
  destroyMiniPlayerWindow,
  ensureMiniPlayerWindow,
  getSavedMiniPlayerPosition,
  saveMiniPlayerPosition,
  useMiniPlayerEnabled,
} from "./settings/miniPlayer";
import { setAutostartEnabled } from "./settings/autostart";
import {
  eventMatchesShortcut,
  useKeyboardShortcuts,
  type KeyboardShortcutAction,
} from "./settings/keyboardShortcuts";
import { useLastFmScrobblingEnabled } from "./settings/lastfm";
import { persistMainWindowGeometry } from "./settings/mainWindowGeometry";
import { hydratePlaybackSettings } from "../player/playbackSettings";
const restoredSession = loadAppSession();
const LOADING_SCREEN_FADE_MS = 80;
const LOADING_SCREEN_MAX_MS = 4000;
const ONBOARDING_COMPLETE_KEY = "yt-music-dock:onboarding-complete";
const ONBOARDING_COMPLETE_SETTING_KEY = "onboardingComplete";
const KEYCHAIN_NOTICE_COMPLETE_KEY = "yt-music-dock:keychain-notice-complete";
const LOADING_SCREEN_MIN_MS = 1000;
const MOUSE_BACK_BUTTON = 3;
const MOUSE_FORWARD_BUTTON = 4;
const MINI_PLAYER_BOTTOM_MARGIN = 24;
// Safety net only — the suppression is normally cleared on pointerup or refocus.
// A long fixed timeout used to swallow the mini player when the window was moved
// and then minimised shortly after.
const MAIN_WINDOW_DRAG_BACKGROUND_SUPPRESS_MS = 1500;
const SLEEP_RECOVERY_TIMER_INTERVAL_MS = 15000;
const SLEEP_RECOVERY_TIMER_DRIFT_MS = 60000;
const TAB_SHORTCUT_ACTIONS: KeyboardShortcutAction[] = [
  "tab1",
  "tab2",
  "tab3",
  "tab4",
  "tab5",
  "tab6",
  "tab7",
  "tab8",
  "tab9",
];

/**
 * How many pages back a tab remembers.
 *
 * Each entry is a whole view — a playlist's entire track list, a page of search results — so an
 * uncapped stack grows by a hundred-odd KB per page navigated, per tab, for as long as the app
 * stays open. Nothing reads deeper than the user can click, and fifty is well past that.
 */
const MAX_NAVIGATION_HISTORY = 50;

function pushNavigationState(
  entries: readonly TabViewState[],
  state: TabViewState,
): TabViewState[] {
  return [...entries, state].slice(-MAX_NAVIGATION_HISTORY);
}

function getNavigationState(tab: Tab): TabViewState | null {
  if (tab.view === "settings") return null;

  return {
    title: tab.title,
    view: tab.view,
    album: tab.album,
    artist: tab.artist,
    playlist: tab.playlist,
    relatedTrack: tab.relatedTrack,
    searchQuery: tab.searchQuery,
    searchResults: tab.searchResults,
    mixedSearchResults: tab.mixedSearchResults,
    searchLoading: tab.searchLoading,
  };
}

function getNavigationKey(state: TabViewState): string {
  switch (state.view) {
    case "album":
      return `album:${state.album?.id ?? ""}`;
    case "artist":
      return `artist:${state.artist?.id ?? state.artist?.name ?? ""}`;
    case "playlist":
      return `playlist:${state.playlist?.id ?? ""}`;
    case "related":
      return `related:${state.relatedTrack?.id ?? ""}`;
    case "search":
      return `search:${state.searchQuery ?? ""}`;
    case "home":
      return "home";
    case "history":
      return "history";
    case "browse":
      return "browse";
    case "library":
      return "library";
  }
}

function applyNavigationState(tab: Tab, state: TabViewState): Tab {
  return {
    ...tab,
    title: state.title,
    view: state.view,
    album: state.album,
    artist: state.artist,
    playlist: state.playlist,
    relatedTrack: state.relatedTrack,
    searchQuery: state.searchQuery,
    searchResults: state.searchResults,
    mixedSearchResults: state.mixedSearchResults,
    searchLoading: state.searchLoading,
  };
}

function stripNavigationHistory(tab: Tab): Tab {
  const { navigationHistory, ...sessionTab } = tab;
  void navigationHistory;
  return sessionTab;
}

async function placeMiniPlayerAtBottomCenter(miniWin: WebviewWindow) {
  const savedPosition = getSavedMiniPlayerPosition();
  if (savedPosition) {
    await miniWin.setPosition(new PhysicalPosition(savedPosition.x, savedPosition.y));
    return;
  }

  const monitor = await currentMonitor()
    ?? await primaryMonitor()
    ?? (await availableMonitors())[0];
  if (!monitor) return;

  const size = await miniWin.outerSize();
  const x = monitor.position.x + Math.round((monitor.size.width - size.width) / 2);
  const y = monitor.position.y + monitor.size.height - size.height - MINI_PLAYER_BOTTOM_MARGIN;

  await miniWin.setPosition(new PhysicalPosition(x, y));
  saveMiniPlayerPosition({ x, y });
}

function readLocalOnboardingComplete(): boolean {
  try {
    return localStorage.getItem(ONBOARDING_COMPLETE_KEY) === "true";
  } catch {
    return false;
  }
}

function saveLocalOnboardingComplete(): void {
  try {
    localStorage.setItem(ONBOARDING_COMPLETE_KEY, "true");
  } catch {
    // Durable app settings are the source of truth.
  }
}

function clearLocalOnboardingComplete(): void {
  try {
    localStorage.removeItem(ONBOARDING_COMPLETE_KEY);
  } catch {
    // Durable app settings are the source of truth.
  }
}

async function hasStoredYoutubeSession(): Promise<boolean> {
  // The cookie is the session. This used to also consult an OAuth credential, which nothing in
  // the app has ever written — a branch that could only ever be false, dressed as a second way
  // of being signed in.
  const cookie = await Promise.allSettled([invoke<string | null>("load_youtube_music_cookie")]);
  return cookie[0].status === "fulfilled" && cookie[0].value !== null;
}

export default function App() {
  useDisableContextMenu();
  const libraryState = useLibraryState();
  /*
   * Only the three fields the root actually reads. Selecting the whole state here made the
   * application's largest component a subscriber to every field of it, including volume —
   * which commits on every pointer move of the slider. Narrowing it is also self-enforcing:
   * reading a field that is not selected is a type error rather than stale data.
   */
  const playerState = usePlayerSelector(
    (state) => ({
      currentTrack: state.currentTrack,
      status: state.status,
      error: state.error,
    }),
    shallowEqual,
  );
  const playerSession = usePlayerSession();
  /* Resolved once at startup. Null in every case except the first launch after an update —
     see resolveReleaseNoteVersion, which records silently for all the others. */
  const [releaseNoteVersion, setReleaseNoteVersion] = useState<string | null>(null);
  const playerUIState = usePlayerUIState();
  const miniPlayerEnabled = useMiniPlayerEnabled();
  const keyboardShortcuts = useKeyboardShortcuts();
  const lastFmScrobblingEnabled = useLastFmScrobblingEnabled();
  // Paper-PC mode kills CSS animation via !important; this makes beUI's JS-driven
  // motion honour the same setting, since motion only reads the OS media query.
  const paperPcMode = usePaperPcMode();

  // The window is transparent so the app root can round its own corners. When the window
  // is maximised or fullscreen those corners would expose the desktop, so drop the radius.
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let disposed = false;

    const syncWindowRadius = async () => {
      try {
        const [maximized, fullscreen] = await Promise.all([
          appWindow.isMaximized(),
          appWindow.isFullscreen(),
        ]);
        if (disposed) return;
        document.documentElement.toggleAttribute(
          "data-window-maximized",
          maximized || fullscreen,
        );
      } catch (error) {
        logInternalWarn("App.syncWindowRadius failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    void syncWindowRadius();
    const unlistenResized = appWindow.onResized(() => void syncWindowRadius());

    return () => {
      disposed = true;
      void unlistenResized.then((unlisten) => unlisten());
    };
  }, []);

  const [tabs, setTabs] = useState<Tab[]>(
    () => restoredSession?.tabs.map(stripNavigationHistory) ?? [{ id: "1", view: "home" }],
  );
  const [activeTabId, setActiveTabId] = useState(
    () => restoredSession?.activeTabId ?? "1",
  );
  const [nextTabId, setNextTabId] = useState(
    () => restoredSession?.nextTabId ?? 2,
  );
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  /*
   * The sidebar is a fixed icon rail. 72px sits below the Sidebar's own text-hide threshold,
   * so every row renders as artwork only and explains itself through a tooltip on hover.
   * Still state rather than a constant because TitleBar aligns its home button to this width.
   */
  const [sidebarWidth, setSidebarWidth] = useState(62);
  const [queuePanelWidth, setQueuePanelWidth] = useState(340);
  const isQueuePanelCollapsed = useQueuePanelCollapsed();
  const [loadingScreenState, setLoadingScreenState] = useState<"visible" | "leaving" | "hidden">("visible");
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(() =>
    readLocalOnboardingComplete() ? true : null
  );
  const [onboardingStep, setOnboardingStep] = useState<OnboardingStep | null>(null);
  const [showQueueMounted, setShowQueueMounted] = useState(false);
  const [onboardingFirstTabId, setOnboardingFirstTabId] = useState(activeTabId);
  const [onboardingSecondTabId, setOnboardingSecondTabId] = useState<string | null>(null);
  const [, setOnboardingSearchQuery] = useState("");
  const [showOnboardingComplete, setShowOnboardingComplete] = useState(false);
  const [showKeychainNotice, setShowKeychainNotice] = useState(
    () => isMacOS && localStorage.getItem(KEYCHAIN_NOTICE_COMPLETE_KEY) !== "true"
  );
  const [showOnboardingWelcome, setShowOnboardingWelcome] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void hydratePlaybackSettings().then((settings) => {
      if (cancelled) return;
      tabManager.applyPlaybackSettings(settings);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cleanup: (() => void) | null = null;
    let cancelled = false;

    void persistMainWindowGeometry().then((unlisten) => {
      if (cancelled) {
        unlisten();
        return;
      }
      cleanup = unlisten;
    });

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);
  const [availableUpdate, setAvailableUpdate] = useState<UpdateInfo | null>(null);
  const [isExpandedPlayerBar,setIsExpandedPlayerBar]=  useState(false)
  const dismissAvailableUpdate = useCallback(() => {
    setAvailableUpdate(null);
  }, []);
  const loadingScreenDismissedRef = useRef(false);
  const loadingScreenStartedAtRef = useRef(performance.now());
  const miniPlayerPositionedRef = useRef(false);
  const miniPlayerEnabledRef = useRef(miniPlayerEnabled);
  const miniPlayerRestoreSuppressUntilRef = useRef(0);
  const mainWindowDragSuppressUntilRef = useRef(0);
  const lastErrorAlertRef = useRef<string | null>(null);
  const sessionStateRef = useRef({ tabs, activeTabId, nextTabId });
  const sessionPersistenceDisabledRef = useRef(false);
  const sleepRecoveryLastTickRef = useRef(Date.now());
  const sleepRecoveryReloadingRef = useRef(false);
  sessionStateRef.current = { tabs, activeTabId, nextTabId };
  miniPlayerEnabledRef.current = miniPlayerEnabled;
  const persistAppSession = useCallback(() => {
    if (sessionPersistenceDisabledRef.current) return;
    const current = sessionStateRef.current;
    saveAppSession({
      version: 1,
      tabs: current.tabs.map((tab) => ({
        ...stripNavigationHistory(tab),
        searchLoading: false,
      })),
      activeTabId: current.activeTabId,
      nextTabId: current.nextTabId,
      player: tabManager.exportSession(),
    });
  }, []);

  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const isQueuePanelOpen = activeTab?.isQueueOpen ?? false;
  const canNavigateBack = (activeTab?.navigationHistory?.back.length ?? 0) > 0;
  const canNavigateForward = (activeTab?.navigationHistory?.forward.length ?? 0) > 0;

  const dismissLoadingScreen = useCallback(() => {
    if (loadingScreenDismissedRef.current) return;

    loadingScreenDismissedRef.current = true;
    setLoadingScreenState("leaving");
    window.setTimeout(() => {
      setLoadingScreenState("hidden");
    }, LOADING_SCREEN_FADE_MS);
  }, []);

  const markOnboardingComplete = useCallback((showCompleteToast: boolean) => {
    saveLocalOnboardingComplete();
    setOnboardingComplete(true);
    setOnboardingStep(null);
    setShowOnboardingWelcome(false);
    if (showCompleteToast) setShowOnboardingComplete(true);
    void setAppSetting(ONBOARDING_COMPLETE_SETTING_KEY, true);
  }, []);

  useEffect(() => {
    if (showKeychainNotice) return;

    let active = true;

    const loadOnboardingCompletion = async () => {
      if (readLocalOnboardingComplete()) {
        markOnboardingComplete(false);
        return;
      }

      const storedComplete = await getAppSetting<boolean>(ONBOARDING_COMPLETE_SETTING_KEY);
      if (!active) return;

      if (storedComplete === true) {
        markOnboardingComplete(false);
        return;
      }

      if (await hasStoredYoutubeSession()) {
        if (!active) return;
        markOnboardingComplete(false);
        return;
      }

      if (!active) return;
      setOnboardingComplete(false);
      setOnboardingStep("open-search");
      setShowOnboardingWelcome(true);
    };

    void loadOnboardingCompletion();
    return () => {
      active = false;
    };
  }, [markOnboardingComplete, showKeychainNotice]);

  const navigateTab = useCallback((tabId: string, nextState: TabViewState) => {
    setTabs((prevTabs) =>
      prevTabs.map((tab) => {
        if (tab.id !== tabId) return tab;
        const currentState = getNavigationState(tab);
        if (!currentState) return applyNavigationState(tab, nextState);

        const nextTab = applyNavigationState(tab, nextState);
        if (getNavigationKey(currentState) === getNavigationKey(nextState)) {
          return nextTab;
        }

        return {
          ...nextTab,
          navigationHistory: {
            back: pushNavigationState(tab.navigationHistory?.back ?? [], currentState),
            forward: [],
          },
        };
      })
    );
  }, []);

  const updateSearchTab = useCallback((tabId: string, query: string, nextState: TabViewState) => {
    setTabs((prevTabs) =>
      prevTabs.map((tab) => {
        if (tab.id !== tabId) return tab;

        const updateHistoryState = (state: TabViewState) =>
          state.view === "search" && state.searchQuery === query
            ? nextState
            : state;
        const navigationHistory = tab.navigationHistory
          ? {
              back: tab.navigationHistory.back.map(updateHistoryState),
              forward: tab.navigationHistory.forward.map(updateHistoryState),
            }
          : undefined;

        if (tab.searchQuery !== query) {
          return {
            ...tab,
            navigationHistory,
          };
        }

        return {
          ...applyNavigationState(tab, nextState),
          navigationHistory,
        };
      })
    );
  }, []);

  const handleNavigateBack = useCallback(() => {
    playerUIStore.setLyricsOpen(false);
    setTabs((prevTabs) =>
      prevTabs.map((tab) => {
        if (tab.id !== activeTabId) return tab;

        const currentState = getNavigationState(tab);
        const back = tab.navigationHistory?.back ?? [];
        if (!currentState || back.length === 0) return tab;

        const previousState = back[back.length - 1];
        const nextTab = applyNavigationState(tab, previousState);
        return {
          ...nextTab,
          navigationHistory: {
            back: back.slice(0, -1),
            forward: [currentState, ...(tab.navigationHistory?.forward ?? [])],
          },
        };
      })
    );
  }, [activeTabId]);

  const handleNavigateForward = useCallback(() => {
    playerUIStore.setLyricsOpen(false);
    setTabs((prevTabs) =>
      prevTabs.map((tab) => {
        if (tab.id !== activeTabId) return tab;

        const currentState = getNavigationState(tab);
        const forward = tab.navigationHistory?.forward ?? [];
        if (!currentState || forward.length === 0) return tab;

        const nextState = forward[0];
        const nextTab = applyNavigationState(tab, nextState);
        return {
          ...nextTab,
          navigationHistory: {
            back: pushNavigationState(tab.navigationHistory?.back ?? [], currentState),
            forward: forward.slice(1),
          },
        };
      })
    );
  }, [activeTabId]);

  const setIsQueuePanelOpen = useCallback(
    (open: boolean) => {
      setTabs((prevTabs) =>
        prevTabs.map((tab) =>
          tab.id === activeTabId
            ? { ...tab, isQueueOpen: open }
            : tab
        )
      );
    },
    [activeTabId],
  );

  useMediaSession(playerState, playerController);

  useEffect(() => {
    let cancelled = false;
    void resolveReleaseNoteVersion().then((version) => {
      if (!cancelled) setReleaseNoteVersion(version);
    });
    return () => {
      cancelled = true;
    };
  }, []);


  useEffect(() => {
    const syncLastFm = () => {
      LastFmService.updatePlayback({
        track: playerState.currentTrack,
        status: playerState.status,
        currentTime: playerController.getCurrentTime(),
        duration: playerController.getDuration(),
        enabled: lastFmScrobblingEnabled,
      });
    };

    syncLastFm();
    const intervalId = window.setInterval(syncLastFm, 1000);
    return () => window.clearInterval(intervalId);
  }, [
    lastFmScrobblingEnabled,
    playerState.currentTrack,
    playerState.status,
  ]);

  const activeViewKey = [
    activeTabId,
    activeTab?.view,
    activeTab?.album?.id,
    activeTab?.artist?.id,
    activeTab?.playlist?.id,
    activeTab?.searchQuery,
  ].filter(Boolean).join(":");

  const handleNavigateHome = () => {
    playerUIStore.setLyricsOpen(false);
    navigateTab(activeTabId, {
      title: activeTab?.title,
      view: "home",
    });
  };

  useEffect(() => {
    if (showKeychainNotice) return;
    void libraryController.initialize();
  }, [showKeychainNotice]);

  useEffect(() => {
    if (libraryState.status !== "error" || !libraryState.error) return;
    const message = `YouTube Music sign-in or library sync failed:\n\n${libraryState.error}`;
    if (lastErrorAlertRef.current === message) return;
    lastErrorAlertRef.current = message;
    window.alert(message);
  }, [libraryState.error, libraryState.status]);

  useEffect(() => {
    if (playerState.status !== "error" || !playerState.error) return;
    const message = `Playback failed:\n\n${playerState.error}`;
    if (lastErrorAlertRef.current === message) return;
    lastErrorAlertRef.current = message;
    window.alert(message);
  }, [playerState.error, playerState.status]);

  useEffect(() => {
    if (showKeychainNotice) return;

    const elapsed = performance.now() - loadingScreenStartedAtRef.current;
    const remainingMaximum = Math.max(0, LOADING_SCREEN_MAX_MS - LOADING_SCREEN_FADE_MS - elapsed);
    const maxTimer = window.setTimeout(dismissLoadingScreen, remainingMaximum);

    return () => {
      window.clearTimeout(maxTimer);
    };
  }, [dismissLoadingScreen, showKeychainNotice]);

  useEffect(() => {
    if (showKeychainNotice) {
      loadingScreenDismissedRef.current = true;
      setLoadingScreenState("hidden");
      return;
    }

    const hasRenderableLibrary = Boolean(libraryState.library);
    if (
      !hasRenderableLibrary
      && (libraryState.status === "restoring" || libraryState.status === "loading")
    ) {
      return;
    }

    let cancelled = false;
    let fadeTimer: number | undefined;

    const finishStartup = async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (cancelled || loadingScreenDismissedRef.current) return;

      const elapsed = performance.now() - loadingScreenStartedAtRef.current;
      const remainingMinimum = Math.max(0, LOADING_SCREEN_MIN_MS - elapsed);
      fadeTimer = window.setTimeout(() => {
        if (cancelled || loadingScreenDismissedRef.current) return;

        dismissLoadingScreen();
      }, remainingMinimum);
    };

    void finishStartup();
    return () => {
      cancelled = true;
      if (fadeTimer !== undefined) window.clearTimeout(fadeTimer);
    };
  }, [dismissLoadingScreen, libraryState.library, libraryState.status, showKeychainNotice]);

  useEffect(() => {
    const intervalId = window.setInterval(persistAppSession, 1000);
    window.addEventListener("beforeunload", persistAppSession);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("beforeunload", persistAppSession);
      persistAppSession();
    };
  }, [persistAppSession]);

  useEffect(() => {
    persistAppSession();
  }, [activeTabId, nextTabId, persistAppSession, playerSession, tabs]);

  useEffect(() => {
    const unlistenPromise = listen("main-window-recovery-reload", persistAppSession);
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [persistAppSession]);

  useEffect(() => {
    sleepRecoveryLastTickRef.current = Date.now();

    const resetSleepTimerOnVisible = () => {
      if (document.visibilityState === "visible") {
        sleepRecoveryLastTickRef.current = Date.now();
      }
    };
    document.addEventListener("visibilitychange", resetSleepTimerOnVisible);

    const intervalId = window.setInterval(() => {
      const now = Date.now();
      const elapsed = now - sleepRecoveryLastTickRef.current;
      sleepRecoveryLastTickRef.current = now;

      if (
        elapsed < SLEEP_RECOVERY_TIMER_INTERVAL_MS + SLEEP_RECOVERY_TIMER_DRIFT_MS
        || document.visibilityState === "hidden"
        || sleepRecoveryReloadingRef.current
      ) {
        return;
      }

      sleepRecoveryReloadingRef.current = true;
      persistAppSession();
      window.location.reload();
    }, SLEEP_RECOVERY_TIMER_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", resetSleepTimerOnVisible);
    };
  }, [persistAppSession]);

  const handleDeleteAllAppData = useCallback(async () => {
    sessionPersistenceDisabledRef.current = true;
    playerUIStore.setLyricsOpen(false);
    setIsSearchOpen(false);
    setShowQueueMounted(false);
    setAvailableUpdate(null);
    setOnboardingComplete(null);
    setOnboardingStep(null);
    setShowOnboardingComplete(false);
    setShowOnboardingWelcome(false);

    tabManager.reset("1");
    setTabs([{ id: "1", view: "home" }]);
    setActiveTabId("1");
    setNextTabId(2);
    setSidebarWidth(240);
    setQueuePanelWidth(340);
    clearAppSession();

    const results = await Promise.allSettled([
      setAutostartEnabled(false),
      libraryController.signOut(),
      clearCache(),
      clearAppSettings(),
    ]);

    try {
      localStorage.clear();
    } catch {
      clearLocalOnboardingComplete();
      clearAppSession();
    }

    const failed = results.find((result) => result.status === "rejected");
    if (failed) {
      throw failed.reason;
    }
  }, []);

  useEffect(() => {
    const tabId = tabManager.getActivePlayerId();
    if (!tabId) return;

    setTabs((prevTabs) =>
      prevTabs.map((tab) =>
        tab.id === tabId && tab.view !== "settings"
          ? { ...tab, title: playerState.currentTrack?.title }
          : tab
      )
    );
  }, [playerState.currentTrack, playerState.status]);

  useEffect(() => {
    if (!playerState.currentTrack && playerUIState.isLyricsOpen) {
      playerUIStore.setLyricsOpen(false);
    }
  }, [playerState.currentTrack, playerUIState.isLyricsOpen]);

  const handleNavigateAlbum = (album: Album) => {
    playerUIStore.setLyricsOpen(false);
    navigateTab(activeTabId, {
      title: activeTab?.title,
      view: "album",
      album,
    });
  };

  const handleNavigateArtist = (artist: Artist, openInNewTab = false) => {
    playerUIStore.setLyricsOpen(false);
    if (!artist.id) {
      const fallbackToSearch = () => handleSearch(artist.name, openInNewTab);
      void searchController.search(artist.name)
        .then((results) => {
          const normalizedName = artist.name.trim().toLocaleLowerCase();
          const resolved = results.artists.find(
            (candidate) => candidate.name.trim().toLocaleLowerCase() === normalizedName,
          ) ?? results.artists.find((candidate) => {
            const candidateName = candidate.name.trim().toLocaleLowerCase();
            return candidateName.includes(normalizedName)
              || normalizedName.includes(candidateName);
          }) ?? results.artists[0];

          if (resolved) {
            handleNavigateArtist(resolved, openInNewTab);
            return;
          }

          fallbackToSearch();
        })
        .catch(fallbackToSearch);
      return;
    }
    if (openInNewTab) {
      const newId = nextTabId.toString();
      tabManager.createTab(newId);
      void tabManager.setActive(newId);
      setTabs((prevTabs) => [
        ...prevTabs,
        { id: newId, view: "artist", artist, title: artist.name },
      ]);
      setActiveTabId(newId);
      setNextTabId((currentId) => currentId + 1);
      return;
    }

    navigateTab(activeTabId, {
      view: "artist",
      artist,
      title: artist.name,
    });
  };

  const handleConnectionRestored = async () => {
    await libraryController.recoverConnection();
  };

  const handleNavigatePlaylist = (playlist: Playlist) => {
    playerUIStore.setLyricsOpen(false);
    navigateTab(activeTabId, {
      title: activeTab?.title,
      view: "playlist",
      playlist,
    });
  };

  const handleNavigateRelated = (track: Track) => {
    playerUIStore.setLyricsOpen(false);
    navigateTab(activeTabId, {
      title: `Related to ${track.title}`,
      view: "related",
      relatedTrack: track,
    });
  };

  const createTab = () => {
    playerUIStore.setLyricsOpen(false);
    const newId = nextTabId.toString();
    tabManager.createTab(newId);
    void tabManager.setActive(newId);
    setTabs((prevTabs) => [
      ...prevTabs,
      { id: newId, view: "home" },
    ]);
    setActiveTabId(newId);
    setNextTabId((currentId) => currentId + 1);
    if (onboardingStep === "new-tab") {
      setOnboardingSecondTabId(newId);
      setOnboardingSearchQuery("");
      setOnboardingStep("type-second");
      setIsSearchOpen(true);
    }
  };

  const handleCreateTab = () => createTab();

  const handleSignIn = async () => {
    await libraryController.signIn();
    if (libraryController.getState().status !== "ready") return;

    playerUIStore.setLyricsOpen(false);
    const newId = nextTabId.toString();
    tabManager.createTab(newId);
    await tabManager.setActive(newId);
    setTabs((prevTabs) => [
      ...prevTabs,
      { id: newId, view: "home" },
    ]);
    setActiveTabId(newId);
    setNextTabId((currentId) => currentId + 1);
  };

  /**
   * Opens a pasted YouTube link instead of searching for its text.
   *
   * Searching for a URL returns nothing useful, so a link in the search box is treated as a
   * request to go there. Anything that fails to resolve falls through to an ordinary search,
   * which is the behaviour without this.
   */
  const handleOpenLink = async (url: string, openInNewTab: boolean): Promise<boolean> => {
    let resolved: Awaited<ReturnType<typeof libraryController.resolveLink>> = null;
    try {
      resolved = await libraryController.resolveLink(url);
    } catch {
      return false;
    }
    if (!resolved) return false;

    playerUIStore.setLyricsOpen(false);
    if (resolved.kind === "track") {
      await playerController.playTrackById(resolved.id);
      return true;
    }

    if (resolved.kind === "artist") {
      const page = await libraryController.getArtist(resolved.id);
      handleNavigateArtist(page.artist, openInNewTab);
      return true;
    }

    if (resolved.kind === "album") {
      /*
       * The link carries an id and nothing else, so the header would read "Album" until the
       * page loaded. Fetching the tracks first — a request the album view then serves from
       * cache — supplies a real title and cover from the first row.
       */
      const stub: Album = { id: resolved.id, title: "Album", artist: "" };
      const tracks = await libraryController.getAlbumTracks(stub).catch(() => [] as Track[]);
      handleNavigateAlbum({
        ...stub,
        title: tracks[0]?.album ?? stub.title,
        artist: tracks[0]?.artist ?? "",
        artworkUrl: tracks[0]?.artworkUrl,
      });
      return true;
    }

    // ponytail: a playlist link has no title until its page loads, and the tracks do not
    // carry one. Fetch the playlist header here if the placeholder ever becomes a complaint.
    const saved = libraryController.getState().library?.playlists.find(
      (item) => item.id.replace(/^VL/, "") === resolved.id.replace(/^VL/, ""),
    );
    handleNavigatePlaylist(saved ?? {
      id: resolved.id,
      title: "Playlist",
      owner: "",
    });
    return true;
  };

  const handleSearch = (query: string, openInNewTab: boolean) => {
    playerUIStore.setLyricsOpen(false);

    if (looksLikeYouTubeLink(query)) {
      void handleOpenLink(query, openInNewTab).then((opened) => {
        // Not a link Zuno can open after all — fall back to searching for the text, so a
        // paste that resolves to nothing still does something.
        if (!opened) runSearch(query, openInNewTab);
      });
      return;
    }

    runSearch(query, openInNewTab);
  };

  const runSearch = (query: string, openInNewTab: boolean) => {
    let targetTabId = activeTabId;

    if (openInNewTab) {
      targetTabId = nextTabId.toString();
      tabManager.createTab(targetTabId);
      void tabManager.setActive(targetTabId);
      setTabs((prevTabs) => [
        ...prevTabs,
        {
          id: targetTabId,
          view: "search",
          title: query,
          searchQuery: query,
          searchResults: [],
          mixedSearchResults: { artists: [], tracks: [], albums: [], playlists: [] },
          searchLoading: true,
        },
      ]);
      setActiveTabId(targetTabId);
      setNextTabId((currentId) => currentId + 1);
    } else {
      navigateTab(targetTabId, {
        view: "search",
        title: query,
        searchQuery: query,
        searchResults: [],
        mixedSearchResults: { artists: [], tracks: [], albums: [], playlists: [] },
        searchLoading: true,
      });
    }

    const searchTabId = targetTabId;
    if (onboardingStep === "type-first") setOnboardingStep("play-first");
    if (onboardingStep === "type-second") setOnboardingStep("play-second");
    const applySearchResults = (results: SearchResults) => {
      updateSearchTab(searchTabId, query, {
        view: "search",
        title: query,
        searchQuery: query,
        searchResults: results.tracks,
        mixedSearchResults: results,
        searchLoading: false,
      });
    };

    void searchController.search(query, applySearchResults)
      .then(applySearchResults)
      .catch(() => {
        updateSearchTab(searchTabId, query, {
          view: "search",
          title: query,
          searchQuery: query,
          searchResults: [],
          mixedSearchResults: { artists: [], tracks: [], albums: [], playlists: [] },
          searchLoading: false,
        });
      });
  };

  const handleOpenSettings = () => {
    playerUIStore.setLyricsOpen(false);
    const settingsTab = tabs.find((tab) => tab.view === "settings");
    if (settingsTab) {
      setActiveTabId(settingsTab.id);
      return;
    }

    const newId = nextTabId.toString();
    setTabs((prevTabs) => [
      ...prevTabs,
      { id: newId, view: "settings" },
    ]);
    setActiveTabId(newId);
    setNextTabId((currentId) => currentId + 1);
  };

  /* Reuses an open History tab the way Settings does — it is a single destination, not
     something you want three copies of. */
  const handleOpenHistory = () => {
    playerUIStore.setLyricsOpen(false);
    const historyTab = tabs.find((tab) => tab.view === "history");
    if (historyTab) {
      setActiveTabId(historyTab.id);
      return;
    }

    const newId = nextTabId.toString();
    setTabs((prevTabs) => [...prevTabs, { id: newId, view: "history", title: "History" }]);
    setActiveTabId(newId);
    setNextTabId((currentId) => currentId + 1);
  };

  const handleOpenLibrary = () => {
    playerUIStore.setLyricsOpen(false);
    const libraryTab = tabs.find((tab) => tab.view === "library");
    if (libraryTab) {
      setActiveTabId(libraryTab.id);
      return;
    }

    const newId = nextTabId.toString();
    setTabs((prevTabs) => [...prevTabs, { id: newId, view: "library", title: "Library" }]);
    setActiveTabId(newId);
    setNextTabId((currentId) => currentId + 1);
  };

  const handleOpenBrowse = (browseTab?: string) => {
    playerUIStore.setLyricsOpen(false);
    const existing = tabs.find((tab) => tab.view === "browse");
    if (existing) {
      // Reusing the tab must still honour the requested section, or "Downloads" would land
      // on whatever the Browse tab happened to be showing.
      if (browseTab && existing.browseTab !== browseTab) {
        setTabs((prevTabs) =>
          prevTabs.map((tab) => (tab.id === existing.id ? { ...tab, browseTab } : tab)));
      }
      setActiveTabId(existing.id);
      return;
    }

    const newId = nextTabId.toString();
    setTabs((prevTabs) => [
      ...prevTabs,
      { id: newId, view: "browse", title: "Browse", browseTab },
    ]);
    setActiveTabId(newId);
    setNextTabId((currentId) => currentId + 1);
  };

  const handleCloseTab = (tabId: string) => {
    playerUIStore.setLyricsOpen(false);
    if (tabs.length === 1) return;

    const closedTab = tabs.find((tab) => tab.id === tabId);
    if (!closedTab) return;

    const newTabs = tabs.filter((tab) => tab.id !== tabId);

    const closedIndex = tabs.findIndex((tab) => tab.id === tabId);
    const replacementMusicTab =
      tabs
        .slice(0, closedIndex)
        .reverse()
        .find((tab) => tab.id !== tabId && tab.view !== "settings") ??
      tabs
        .slice(closedIndex + 1)
        .find((tab) => tab.view !== "settings");

    if (closedTab.view !== "settings" && tabManager.getActiveId() === tabId) {
      if (replacementMusicTab) {
        void tabManager.setActive(replacementMusicTab.id);
      }
    }

    if (activeTabId === tabId) {
      const playingTabId = tabManager.getActiveId();
      const playingTab = newTabs.find((tab) => tab.id === playingTabId);

      if (closedTab.view === "settings" && playingTab) {
        setActiveTabId(playingTab.id);
      } else {
        const nextTab = replacementMusicTab ?? newTabs[Math.max(0, closedIndex - 1)];
        if (nextTab.view !== "settings" && tabManager.getActiveId() !== nextTab.id) {
          void tabManager.setActive(nextTab.id);
        }
        setActiveTabId(nextTab.id);
      }
    }

    if (closedTab.view !== "settings") {
      tabManager.removeTab(tabId);
    }
    setTabs(newTabs);
  };

  const handleSwitchTab = (tabId: string) => {
    playerUIStore.setLyricsOpen(false);
    const tab = tabs.find((item) => item.id === tabId);
    if (tab?.view !== "settings") {
      void tabManager.setActive(tabId);
    }
    setActiveTabId(tabId);
    if (onboardingStep === "switch-back" && tabId === onboardingFirstTabId) {
      markOnboardingComplete(true);
    }
  };

  const finishOnboarding = () => {
    markOnboardingComplete(false);
  };

  /*
   * Skipping advances the tour without performing the step.
   *
   * Deliberately not "do it for them": creating the tab or playing the track on their behalf
   * would make Skip an action button, and someone skipping a step is saying they do not want
   * that thing to happen. Later steps may then have nothing to point at, which is fine — they
   * are skippable too, and the last one finishes the tour.
   */
  const skipOnboardingStep = () => {
    if (!onboardingStep) return;
    const next = nextOnboardingStep(onboardingStep);
    if (next) setOnboardingStep(next);
    else markOnboardingComplete(true);
  };

  const backOnboardingStep = () => {
    if (!onboardingStep) return;
    const previous = previousOnboardingStep(onboardingStep);
    if (previous) setOnboardingStep(previous);
  };

  const handlePlaySearchTrack = async (track: Track) => {
    const stepAtStart = onboardingStep;
    const tabAtStart = activeTabId;
    const started = await playerController.playTrackById(track.id, [track], true);
    if (!started) return;

    if (
      (stepAtStart === "type-first" || stepAtStart === "play-first")
      && tabAtStart === onboardingFirstTabId
    ) {
      setOnboardingStep("new-tab");
      setIsSearchOpen(false);
    }
    if (
      (stepAtStart === "type-second" || stepAtStart === "play-second")
      && tabAtStart === onboardingSecondTabId
    ) {
      setOnboardingStep("switch-back");
      setIsSearchOpen(false);
    }
  };

  const handlePlaySearchResult = async (track: Track) => {
    const stepAtStart = onboardingStep;
    const tabAtStart = activeTabId;
    const started = await playerController.playTrackById(track.id, [track], true);
    if (!started) return;

    if (stepAtStart === "play-first" && tabAtStart === onboardingFirstTabId) {
      setOnboardingStep("new-tab");
    }
    if (stepAtStart === "play-second" && tabAtStart === onboardingSecondTabId) {
      setOnboardingStep("switch-back");
    }
  };

  const dismissSearch = () => {
    setIsSearchOpen(false);
    if (
      onboardingStep === "type-first"
      || onboardingStep === "play-first"
      || onboardingStep === "type-second"
      || onboardingStep === "play-second"
    ) {
      setOnboardingSearchQuery("");
      setOnboardingStep("open-search");
    }
  };

  const restartOnboarding = () => {
    const firstMusicTab = tabs.find((tab) => tab.view !== "settings");
    if (!firstMusicTab) return;
    clearLocalOnboardingComplete();
    setOnboardingComplete(false);
    setOnboardingFirstTabId(firstMusicTab.id);
    setOnboardingSecondTabId(null);
    setOnboardingSearchQuery("");
    setOnboardingStep("open-search");
    setShowOnboardingWelcome(false);
    void removeAppSetting(ONBOARDING_COMPLETE_SETTING_KEY);
    handleSwitchTab(firstMusicTab.id);
  };

  useEffect(() => {
    if (onboardingStep === "open-search" && isSearchOpen) {
      setOnboardingSearchQuery("");
      setOnboardingStep(
        onboardingSecondTabId && activeTabId === onboardingSecondTabId
          ? "type-second"
          : "type-first"
      );
    }
  }, [activeTabId, isSearchOpen, onboardingSecondTabId, onboardingStep]);

  useEffect(() => {
    if (!showOnboardingComplete) return;
    const timer = window.setTimeout(() => setShowOnboardingComplete(false), 3400);
    return () => window.clearTimeout(timer);
  }, [showOnboardingComplete]);

  useEffect(() => {
    if (!showOnboardingWelcome || loadingScreenState !== "hidden") return;
    const timer = window.setTimeout(() => setShowOnboardingWelcome(false), 2600);
    return () => window.clearTimeout(timer);
  }, [loadingScreenState, showOnboardingWelcome]);

  useEffect(() => {
    if (
      loadingScreenState !== "hidden"
      || showKeychainNotice
      || showOnboardingWelcome
    ) {
      return;
    }

    let active = true;
    const timer = window.setTimeout(() => {
      void checkForUpdates()
        .then((update) => {
          if (
            active
            && update
            && !isUpdateSnoozed(update.version)
          ) {
            setAvailableUpdate(update);
          }
        })
        .catch(() => {
          // Startup update checks should not interrupt the app.
        });
    }, 3000);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [loadingScreenState, showKeychainNotice, showOnboardingWelcome]);

  const handleToggleLyrics = () => {
    if (playerUIState.isLyricsOpen) {
      playerUIStore.setLyricsOpen(false);
      return;
    }

    const playbackTabId = tabManager.getPlaybackOwnerId();
    if (playbackTabId && playbackTabId !== activeTabId) {
      const playbackTab = tabs.find((tab) => tab.id === playbackTabId);
      if (playbackTab) {
        void tabManager.setActive(playbackTabId);
        setActiveTabId(playbackTabId);
      }
    }
    playerUIStore.setLyricsOpen(true);
  };

  const handleToggleQueue = () => {
    // Toggle asynchronously to avoid triggering synchronous store updates
    // during React commit phase which can cause "Maximum update depth".
    setTimeout(() => setIsQueuePanelOpen(!isQueuePanelOpen), 0);
  };

  useEffect(() => {
    if (isQueuePanelOpen) {
      // Mount the panel after commit to avoid nested update loops
      const id = window.setTimeout(() => setShowQueueMounted(true), 0);
      return () => window.clearTimeout(id);
    }
    const id = window.setTimeout(() => setShowQueueMounted(false), 200);
    return () => window.clearTimeout(id);
  }, [isQueuePanelOpen]);

  const handleKeychainNoticeContinue = () => {
    localStorage.setItem(KEYCHAIN_NOTICE_COMPLETE_KEY, "true");
    setShowKeychainNotice(false);
  };

  const handleReorderTab = (
    draggedTabId: string,
    targetTabId: string,
    insertAfter: boolean,
  ) => {
    setTabs((currentTabs) => {
      const draggedIndex = currentTabs.findIndex((tab) => tab.id === draggedTabId);
      const targetIndex = currentTabs.findIndex((tab) => tab.id === targetTabId);
      if (draggedIndex < 0 || targetIndex < 0 || draggedIndex === targetIndex) {
        return currentTabs;
      }

      const nextTabs = [...currentTabs];
      const [draggedTab] = nextTabs.splice(draggedIndex, 1);
      const adjustedTargetIndex = nextTabs.findIndex((tab) => tab.id === targetTabId);
      nextTabs.splice(adjustedTargetIndex + (insertAfter ? 1 : 0), 0, draggedTab);
      return nextTabs;
    });
    // Persist immediately so tab order survives app restart
    window.setTimeout(persistAppSession, 0);
  };

  useEffect(() => {
    const preventTabFocusTraversal = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;

      event.preventDefault();
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    };

    window.addEventListener("keydown", preventTabFocusTraversal);
    return () => window.removeEventListener("keydown", preventTabFocusTraversal);
  }, []);

  useEffect(() => {
    const isTextEntry = (target: EventTarget | null) => {
      return target instanceof Element
        && target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
        ) !== null;
    };

    const handleMouseNavigation = (event: MouseEvent) => {
      if (
        event.button !== MOUSE_BACK_BUTTON
        && event.button !== MOUSE_FORWARD_BUTTON
      ) {
        return;
      }
      if (isTextEntry(event.target)) return;

      if (event.button === MOUSE_BACK_BUTTON) {
        if (isSearchOpen && activeTab?.view !== "settings") {
          event.preventDefault();
          setIsSearchOpen(false);
          return;
        }
        if (canNavigateBack) {
          event.preventDefault();
          handleNavigateBack();
        }
        return;
      }

      if (canNavigateForward) {
        event.preventDefault();
        handleNavigateForward();
      }
    };

    const preventAuxNavigation = (event: MouseEvent) => {
      if (
        event.button === MOUSE_BACK_BUTTON
        || event.button === MOUSE_FORWARD_BUTTON
      ) {
        event.preventDefault();
      }
    };

    window.addEventListener("mousedown", handleMouseNavigation);
    window.addEventListener("auxclick", preventAuxNavigation);
    return () => {
      window.removeEventListener("mousedown", handleMouseNavigation);
      window.removeEventListener("auxclick", preventAuxNavigation);
    };
  }, [
    activeTab?.view,
    canNavigateBack,
    canNavigateForward,
    handleNavigateBack,
    handleNavigateForward,
    isSearchOpen,
  ]);

  useEffect(() => {
    const isTextEntry = (target: EventTarget | null) => {
      return target instanceof Element
        && target.closest(
          'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
        ) !== null;
    };

    const handleShortcut = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.defaultPrevented) return;
      const textEntry = isTextEntry(event.target);

      if (!textEntry) {
        const tabShortcutIndex = TAB_SHORTCUT_ACTIONS.findIndex((action) =>
          eventMatchesShortcut(event, keyboardShortcuts[action])
        );
        const tab = tabs[tabShortcutIndex];
        if (tabShortcutIndex >= 0 && tab) {
          event.preventDefault();
          handleSwitchTab(tab.id);
        }
        if (tabShortcutIndex >= 0) return;
      }

      if (textEntry) return;

      if (
        eventMatchesShortcut(event, keyboardShortcuts.search)
        && activeTab?.view !== "settings"
      ) {
        event.preventDefault();
        if (isSearchOpen) dismissSearch();
        else setIsSearchOpen(true);
        return;
      }

      if (eventMatchesShortcut(event, keyboardShortcuts.newTab)) {
        event.preventDefault();
        createTab();
        return;
      }

      if (eventMatchesShortcut(event, keyboardShortcuts.closeTab)) {
        event.preventDefault();
        handleCloseTab(activeTabId);
        return;
      }

      if (eventMatchesShortcut(event, keyboardShortcuts.navigateBack)) {
        if (isSearchOpen && activeTab?.view !== "settings") {
          event.preventDefault();
          setIsSearchOpen(false);
          return;
        }
        if (canNavigateBack) {
          event.preventDefault();
          handleNavigateBack();
        }
        return;
      }

      if (eventMatchesShortcut(event, keyboardShortcuts.navigateForward)) {
        if (canNavigateForward) {
          event.preventDefault();
          handleNavigateForward();
        }
        return;
      }

      if (
        eventMatchesShortcut(event, keyboardShortcuts.playPause)
        && playerState.currentTrack
        && playerState.status !== "loading"
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (event.target instanceof HTMLElement) {
          event.target.blur();
        }
        void playerController.togglePlayPause();
        return;
      }

      if (
        eventMatchesShortcut(event, keyboardShortcuts.mute)
        && playerState.currentTrack
        && playerState.status !== "loading"
      ) {
        event.preventDefault();
        void playerController.toggleMute();
        return;
      }

      if (
        eventMatchesShortcut(event, keyboardShortcuts.previousTrack)
        && playerState.currentTrack
        && playerState.status !== "loading"
      ) {
        event.preventDefault();
        void playerController.skipToPrevious();
        return;
      }

      if (
        eventMatchesShortcut(event, keyboardShortcuts.nextTrack)
        && playerState.currentTrack
        && playerState.status !== "loading"
      ) {
        event.preventDefault();
        void playerController.skipToNext();
      }
    };

    window.addEventListener("keydown", handleShortcut, true);
    return () => window.removeEventListener("keydown", handleShortcut, true);
  }, [
    activeTab?.view,
    activeTabId,
    canNavigateBack,
    canNavigateForward,
    handleNavigateBack,
    handleNavigateForward,
    isSearchOpen,
    keyboardShortcuts,
    nextTabId,
    onboardingStep,
    playerState.currentTrack,
    playerState.status,
    tabs,
  ]);


  const handlePlayerBarClick=()=>{
    setIsExpandedPlayerBar(!isExpandedPlayerBar)
  }



/*
 * The window follows the setting, rather than existing always and merely being hidden.
 *
 * Enabled: created up front, so the first time it is needed — backgrounding the app — it appears
 * immediately rather than after a webview cold start. Disabled: destroyed, which is the only
 * thing that actually returns its ~32 MB; hiding leaves the process resident.
 */
useEffect(() => {
  if (miniPlayerEnabled) {
    void ensureMiniPlayerWindow();
    return;
  }

  // The ref describes a window that is about to stop existing. Left set, the replacement made
  // on re-enable would be treated as already placed and open wherever the OS put it.
  miniPlayerPositionedRef.current = false;
  void destroyMiniPlayerWindow();
}, [miniPlayerEnabled]);


useEffect(() => {
  const setupListeners = async () => {
    const hideMiniPlayer = async () => {
      const miniWin = await WebviewWindow.getByLabel("mini-player");
      if (miniWin) await miniWin.hide();
    };

    /**
     * @param force bypasses the drag/restore suppression windows. Used for an explicit
     *   minimise, where the user's intent to background the app is unambiguous.
     */
    const showMiniPlayerIfAllowed = async (_event?: unknown, force = false) => {
      /*
       * Checked before the window is asked for, not after.
       *
       * Asking is now what creates it, so testing `enabled` afterwards would spawn the window
       * for the very users who turned it off, only to hide it again.
       */
      if (!miniPlayerEnabledRef.current) {
        await hideMiniPlayer();
        return;
      }

      // Covers the cold-start race: backgrounding the app in the first moments after launch
      // can arrive before the creation kicked off on mount has finished.
      const miniWin = await ensureMiniPlayerWindow();
      if (!miniWin) return;

      if (!force && Date.now() < mainWindowDragSuppressUntilRef.current) {
        await miniWin.hide();
        return;
      }

      if (!force && Date.now() < miniPlayerRestoreSuppressUntilRef.current) {
        await miniWin.hide();
        return;
      }

      if (!miniPlayerPositionedRef.current) {
        try {
          await placeMiniPlayerAtBottomCenter(miniWin);
        } catch (_) {}
        miniPlayerPositionedRef.current = true;
      }

      await miniWin.show();
      if (isLinux) {
        try {
          await placeMiniPlayerAtBottomCenter(miniWin);
        } catch (_) {}
      }
      await miniWin.setFocus();
    };

    const recoverMissedBackgroundEvent = async () => {
      const [mainWin, miniWin] = await Promise.all([
        WebviewWindow.getByLabel("main"),
        WebviewWindow.getByLabel("mini-player"),
      ]);
      if (!mainWin || !miniWin) return;

      const [mainFocused, miniFocused] = await Promise.all([
        mainWin.isFocused(),
        miniWin.isFocused(),
      ]);
      if (!mainFocused && !miniFocused) {
        await showMiniPlayerIfAllowed();
      }
    };

    const unlistenBackgrounded = await listen("main-window-backgrounded", () =>
      showMiniPlayerIfAllowed(),
    );
    // Minimise always wins over the drag suppression below.
    const unlistenMinimized = await listen("main-window-minimized", () =>
      showMiniPlayerIfAllowed(undefined, true),
    );

    const handleMainWindowDragStarted = () => {
      mainWindowDragSuppressUntilRef.current = Date.now() + MAIN_WINDOW_DRAG_BACKGROUND_SUPPRESS_MS;
    };
    // Dragging ends on pointer release; clearing here means the suppression lasts for the
    // gesture rather than for a fixed timeout that outlives it.
    const handleMainWindowDragEnded = () => {
      mainWindowDragSuppressUntilRef.current = 0;
    };

    const unlistenFocus = await listen("window-focused", () => {
      mainWindowDragSuppressUntilRef.current = 0;
      void hideMiniPlayer();
    });
    window.addEventListener("main-window-drag-started", handleMainWindowDragStarted);
    window.addEventListener("pointerup", handleMainWindowDragEnded);
    window.addEventListener("pointercancel", handleMainWindowDragEnded);
    const unlistenRestoreMain = await listen("mini-player:restore-main", async () => {
      miniPlayerRestoreSuppressUntilRef.current = Date.now() + 800;
      await hideMiniPlayer();
    });
    const unlistenPositionChanged = await listen<{ x: number; y: number }>(
      "mini-player:position-changed",
      (event) => {
        saveMiniPlayerPosition(event.payload);
      },
    );

    if (!miniPlayerEnabledRef.current) {
      await hideMiniPlayer();
    }
    void recoverMissedBackgroundEvent();

    return () => {
      window.removeEventListener("main-window-drag-started", handleMainWindowDragStarted);
      window.removeEventListener("pointerup", handleMainWindowDragEnded);
      window.removeEventListener("pointercancel", handleMainWindowDragEnded);
      unlistenBackgrounded();
      unlistenMinimized();
      unlistenFocus();
      unlistenRestoreMain();
      unlistenPositionChanged();
    };
  };

  const cleanup = setupListeners();
  return () => { cleanup.then(fn => fn?.()); };
}, []);


useEffect(() => {
  const setup = async () => {
    const unlistenPlayPause = await listen("mini-player:toggle-play-pause", () => {
      void playerController.togglePlayPause();
    });
    const unlistenNext = await listen("mini-player:skip-next", () => {
      void playerController.skipToNext();
    });
    const unlistenPrev = await listen("mini-player:skip-previous", () => {
      void playerController.skipToPrevious();
    });

    return () => {
      unlistenPlayPause();
      unlistenNext();
      unlistenPrev();
    };
  };

  const cleanup = setup();
  return () => { cleanup.then(fn => fn?.()); };
}, []);
useEffect(() => {
  let lastTrackId: string | null = null;
  let lastStatus: string | null = null;
  let lastArtworkUrl: string | null = null;

  const syncPlayerState = () => {
    const state = tabManager.getActiveState();
    const trackId = state.currentTrack?.id ?? null;
    const status = state.status;
    const artworkUrl = state.currentTrack?.artworkUrl ?? null;

    if (trackId === lastTrackId && status === lastStatus && artworkUrl === lastArtworkUrl) return;
    lastTrackId = trackId;
    lastStatus = status;
    lastArtworkUrl = artworkUrl;

    void emit("player-state-sync", {
      status,
      artworkUrl,
      title: state.currentTrack?.title ?? null,
      artist: state.currentTrack?.artist ?? null,
    });
  };

  syncPlayerState();
  const unsubscribe = tabManager.subscribe(syncPlayerState);

  const syncTime = () => {
    void emit("player-time-sync", {
      currentTime: playerController.getCurrentTime(),
      duration: playerController.getDuration(),
    });
    void emit("player-volume-sync", {
      muted: playerController.isMuted(),
      volume: playerController.getVolume(),
    });
  };

  syncTime();
  const timeSyncIntervalId = window.setInterval(syncTime, 1000);

  /*
   * A window that just appeared has missed every state emit so far, and the dedupe above means
   * the next one may be minutes away. Clearing the memo makes the following call unconditional.
   */
  const resync = listen("mini-player:request-sync", () => {
    lastTrackId = null;
    lastStatus = null;
    lastArtworkUrl = null;
    syncPlayerState();
    syncTime();
  });

  return () => {
    unsubscribe();
    window.clearInterval(timeSyncIntervalId);
    void resync.then((unlisten) => unlisten());
  };
}, []);

useEffect(() => {
  const setup = async () => {
    const unlisten = await listen<{ time: number }>("mini-player:seek", (event) => {
      void playerController.seekTo(event.payload.time);
    });
    return unlisten;
  };
  const cleanup = setup();
  return () => { cleanup.then(fn => fn()); };
}, []);

useEffect(() => {
  const setup = async () => {
    const unlisten = await listen<{ volume: number }>("mini-player:volume", (event) => {
      const volume = Math.min(1, Math.max(0, event.payload.volume));
      void playerController.setVolume(volume);
    });
    return unlisten;
  };
  const cleanup = setup();
  return () => { cleanup.then(fn => fn()); };
}, []);

  return (
    <MotionConfig reducedMotion={paperPcMode ? "always" : "user"}>
    <ArtistNavigationProvider onNavigate={handleNavigateArtist}>
    <TrackContextMenuProvider
      libraryController={libraryController}
      onOpenRelated={handleNavigateRelated}
    >
    <PlaylistContextMenuProvider libraryController={libraryController}>
    {/*
      `ring-inset` is load-bearing: the window is transparent, so an outward ring would be
      drawn into nothing and clipped. The specular line along the top edge is the same cue
      the picks cards and the mini player use, which is what makes the whole app read as one
      material rather than three separately-styled surfaces.
    */}
    <div className="relative flex h-screen flex-col overflow-hidden rounded-[var(--window-radius)] border border-border ring-1 ring-inset ring-[var(--window-edge)]">
 {/*    {!paperPcMode && <StarField />}
    <span
      className="pointer-events-none absolute inset-x-0 top-0 z-50 h-px bg-linear-to-r from-transparent via-[var(--window-edge-highlight)] to-transparent"
      aria-hidden="true"
    /> */}
      <TitleBar
        tabs={tabs}
        activeTabId={activeTabId}
        playingTabId={
          playerState.status === "playing"
            ? tabManager.getActivePlayerId()
            : null
        }
        sidebarWidth={sidebarWidth}
        isHomeActive={activeTab?.view === "home"}
        onNavigateHome={handleNavigateHome}
        onCreateTab={handleCreateTab}
        onCloseTab={handleCloseTab}
        onSwitchTab={handleSwitchTab}
        onReorderTab={handleReorderTab}
        onOpenSettings={handleOpenSettings}
        onOpenDownloads={() => handleOpenBrowse("downloads")}
        onboardingFirstTabId={onboardingStep ? onboardingFirstTabId : undefined}
      />
      
      <div className="flex min-h-0 flex-1 flex-col">
       
        <Layout
          sidebarWidth={sidebarWidth}
          onSidebarWidthChange={setSidebarWidth}
          onNavigateAlbum={handleNavigateAlbum}
          onNavigatePlaylist={handleNavigatePlaylist}
          showSearchBar={activeTab?.view !== "settings" && !playerUIState.isLyricsOpen}
          onOpenSearch={() => setIsSearchOpen(true)}
          canGoBack={canNavigateBack}
          canGoForward={canNavigateForward}
          onNavigateBack={handleNavigateBack}
          onNavigateForward={handleNavigateForward}
          fullBleedContent={playerUIState.isLyricsOpen}
          showTransientScrollbar={
            !playerUIState.isLyricsOpen
            && (activeTab?.view === "playlist" || activeTab?.view === "album")
          }
          rightPanelWidth={isQueuePanelCollapsed ? COLLAPSED_QUEUE_WIDTH : queuePanelWidth}
          onRightPanelWidthChange={isQueuePanelCollapsed ? undefined : setQueuePanelWidth}
          rightPanel={showQueueMounted ? (
            <QueuePanel
              isOpen={isQueuePanelOpen}
              onClose={() => setIsQueuePanelOpen(false)}
            />
          ) : undefined}
        >
{/* <ExpandedPlayerBar 
        isOpen={isExpandedPlayerBar} 
        onClose={() => setIsExpandedPlayerBar(false)} 
      /> */}

          {/* Chunks resolve off local disk in single-digit ms, so an empty fallback reads as
              an instant transition rather than a flash of spinner. */}
          {/*
            Keyed on the view so navigating away clears a caught error: a page that failed on
            one album's malformed response must not stay broken for the next one. The player
            bar and sidebar sit outside, so a dead page still leaves playback controllable.
          */}
          <ErrorBoundary
            key={`boundary:${activeViewKey}`}
            label="This page"
            onDismiss={canNavigateBack ? handleNavigateBack : undefined}
          >
          <Suspense fallback={<div className="min-h-0 flex-1" />}>
          {playerUIState.isLyricsOpen && activeTab?.view !== "settings" ? (
            <LyricsView onClose={() => playerUIStore.setLyricsOpen(false)} />
          ) : (
          <div key={activeViewKey} className="min-h-0 flex-1">
            {activeTab?.view === "home" && (
              <HomePage
                tabId={activeTabId}
                playerController={playerController}
                libraryController={libraryController}
                libraryState={libraryState}
                searchController={searchController}
                onSignIn={handleSignIn}
                destinations={{
                  onOpenLibrary: handleOpenLibrary,
                  onOpenBrowse: () => handleOpenBrowse(),
                  onOpenHistory: handleOpenHistory,
                  onOpenDownloads: () => handleOpenBrowse("downloads"),
                }}
              />
            )}
            {activeTab?.view === "album" && (
              <AlbumView
                album={activeTab?.album}
                playerController={playerController}
                libraryController={libraryController}
              />
            )}
            {activeTab?.view === "artist" && (
              <ArtistView
                artist={activeTab.artist}
                playerController={playerController}
                libraryController={libraryController}
                onOpenAlbum={handleNavigateAlbum}
                onOpenPlaylist={handleNavigatePlaylist}
              />
            )}
            {activeTab?.view === "playlist" && (
              <PlaylistView
                playlist={activeTab.playlist}
                playerController={playerController}
                libraryController={libraryController}
              />
            )}
            {activeTab?.view === "related" && activeTab.relatedTrack && (
              <RelatedPage
                track={activeTab.relatedTrack}
                playerController={playerController}
                onOpenAlbum={handleNavigateAlbum}
                onOpenArtist={(artist) => handleNavigateArtist(artist)}
                onOpenPlaylist={handleNavigatePlaylist}
              />
            )}
            {activeTab?.view === "search" && (
                <SearchResultsPage
                query={activeTab.searchQuery ?? ""}
                results={activeTab.mixedSearchResults ?? {
                  artists: [],
                  tracks: activeTab.searchResults ?? [],
                  albums: [],
                  playlists: [],
                }}
                isLoading={activeTab.searchLoading ?? false}
                  playerController={playerController}
                    onPlayTrack={handlePlaySearchResult}
                onOpenArtist={(artist) => handleNavigateArtist(artist)}
                onOpenAlbum={handleNavigateAlbum}
                onOpenPlaylist={handleNavigatePlaylist}
                />
            )}
            {activeTab?.view === "library" && (
              <LibraryPage
                libraryState={libraryState}
                playerController={playerController}
                onOpenAlbum={handleNavigateAlbum}
                onOpenArtist={(artist) => handleNavigateArtist(artist)}
                onOpenPlaylist={handleNavigatePlaylist}
              />
            )}
            {activeTab?.view === "browse" && (
              <BrowsePage
                key={activeTab.browseTab ?? "explore"}
                initialTab={(activeTab.browseTab ?? "explore") as never}
                playerController={playerController}
                libraryController={libraryController}
                onOpenAlbum={handleNavigateAlbum}
                onOpenArtist={(artist) => handleNavigateArtist(artist)}
                onOpenPlaylist={handleNavigatePlaylist}
              />
            )}
            {activeTab?.view === "history" && (
              <HistoryPage playerController={playerController} />
            )}
            {activeTab?.view === "settings" && (
              <SettingsPage
                libraryController={libraryController}
                libraryState={libraryState}
                onRestartOnboarding={restartOnboarding}
                onSignIn={handleSignIn}
                onDeleteAllAppData={handleDeleteAllAppData}
              />
            )}
          </div>
          )}
          </Suspense>
          </ErrorBoundary>
        </Layout>
      </div>
      
      <VolumeSyncBridge />

      {/* Its own boundary: the player bar is the one region whose loss ends the session —
          audio keeps playing but nothing can pause or skip it. */}
      <ErrorBoundary label="Playback controls">
        <PlayerBar
          onToggleLyrics={handleToggleLyrics}
          onToggleQueue={handleToggleQueue}
          isQueueOpen={isQueuePanelOpen}
          onConnectionRestored={handleConnectionRestored}
          handlePlayerBarClick={handlePlayerBarClick}
        />
      </ErrorBoundary>
      <SearchOverlay
        isOpen={isSearchOpen && activeTab?.view !== "settings"}
        activeTabId={activeTabId}
        searchController={searchController}
        albums={libraryState.library?.albums ?? []}
        playlists={libraryState.library?.playlists ?? []}
          onClose={() => setIsSearchOpen(false)}
          onDismiss={dismissSearch}
        onSubmit={handleSearch}
        onPlayTrack={(track) => void handlePlaySearchTrack(track)}
        onOpenAlbum={handleNavigateAlbum}
        onOpenArtist={(artist) => handleNavigateArtist(artist)}
        onOpenPlaylist={handleNavigatePlaylist}
        onQueryChange={setOnboardingSearchQuery}
      />
      {loadingScreenState !== "hidden" && (
        <AppLoadingScreen isLeaving={loadingScreenState === "leaving"} />
      )}
      {showKeychainNotice ? (
        <KeychainNotice onContinue={handleKeychainNoticeContinue} />
      ) : (
        <>
          {loadingScreenState === "hidden" && showOnboardingWelcome && (
            <OnboardingWelcome />
          )}
          {loadingScreenState === "hidden" && onboardingComplete === false && !showOnboardingWelcome && onboardingStep && (
            <Onboarding
              step={onboardingStep}
              onSkip={finishOnboarding}
              onSkipStep={skipOnboardingStep}
              onBack={backOnboardingStep}
            />
          )}
          {showOnboardingComplete && <OnboardingCompleteToast />}
        </>
      )}
      {availableUpdate && (
        <UpdateToast
          update={availableUpdate}
          onDismiss={dismissAvailableUpdate}
        />
      )}

      <ReleaseNoteDialog
        version={releaseNoteVersion}
        onDismiss={() => {
          if (releaseNoteVersion) markReleaseNoteSeen(releaseNoteVersion);
          setReleaseNoteVersion(null);
        }}
      />
      {/*
        Mounted only while a sign-in is running: `signInProgress` is null at every other moment,
        so the overlay and its animation cost nothing for the whole rest of the session.
      */}
      <AnimatePresence>
        {libraryState.authProgress && (
          <AuthOverlay
            progress={libraryState.authProgress}
            onCancel={() => void libraryController.cancelSignIn()}
          />
        )}
      </AnimatePresence>
    </div>
    </PlaylistContextMenuProvider>
    </TrackContextMenuProvider>
    </ArtistNavigationProvider>
    </MotionConfig>
  );
}
