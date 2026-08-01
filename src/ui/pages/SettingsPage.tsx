import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useState,
  useSyncExternalStore,
} from "react";
import { Switch } from "@/components/motion/switch";
import { RangeSlider } from "@/components/motion/range-slider";
import {
  MAX_CROSSFADE_SEC,
  setCrossfadeSec,
  setGaplessEnabled,
  useCrossfadeSec,
  useGaplessEnabled,
} from "../settings/playbackTransitions";
import {
  setSessionRestoreEnabled,
  useSessionRestoreEnabled,
} from "../settings/sessionRestore";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/motion/select";
import {
  BugIcon,
  FolderAddIcon,
  FolderIcon,
  FolderOpenIcon,
  KeyIcon,
  LastFmIcon,
  LogFileIcon,
  LogoutIcon,
  PaletteIcon,
  PlayIcon,
  QueuePanelIcon,
  RefreshIcon,
  StarIcon,
  TrashIcon,
  UserIcon,
} from "@/ui/icons";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import {
  setThemePreference,
  useThemePreference,
  type ThemePreference,
} from "../settings/theme";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  checkForUpdates,
  getUpdateFailureMessage,
  getInstalledVersion,
  installUpdate,
  type UpdateInfo,
  type UpdateInstallProgress,
} from "../../internal/updateChecker";
import {
  clearCache,
  DEFAULT_CACHE_SIZE_GB,
  getCacheStats,
  setCacheMaxBytes,
  type CacheStats,
} from "../../internal/cache";
import type { LibraryController, LibraryState } from "../../player/LibraryController";
import {
  getAutostartEnabled,
  setAutostartEnabled,
} from "../settings/autostart";
import {
  setCompactPlayerBar,
  setExtraPlayerControlsAlwaysVisible,
  useCompactPlayerBar,
  useExtraPlayerControlsAlwaysVisible,
} from "../settings/playerControls";
import { setPaperPcMode, usePaperPcMode } from "../settings/paperPcMode";
import { setMadeForYouVisible, useMadeForYouVisible } from "../settings/homeSections";
import { GoogleSignInButton } from "../components/GoogleSignInButton";
import { ExternalLinkButton } from "../components/ExternalLinkButton";
import {
  AUTO_LYRICS_SOURCE,
  setPreferredLyricsSourceId,
  usePreferredLyricsSourceId,
} from "../../internal/lyricsSourcePreference";
import { LYRICS_SOURCES } from "../../datasource/youtube/lyricsSources";
import {
  LYRICS_FONT_SCALES,
  setLyricsFontScale,
  useLyricsFontScale,
} from "../settings/lyricsFontScale";
import {
  TRANSLATION_LANGUAGES,
  TRANSLATION_OFF,
  getLanguageLabel,
  setLyricsTranslationLang,
  useLyricsTranslationLang,
} from "../settings/lyricsTranslation";
import {
  setToolbarItemVisible,
  TOOLBAR_ITEMS,
  useToolbarItemVisible,
} from "../settings/toolbarItems";
import {
  setNativeWindowControls,
  setWindowsStyleWindowControls,
  useNativeWindowControls,
  useWindowsStyleWindowControls,
} from "../settings/windowControls";
import {
  resetMiniPlayerPosition,
  setMiniPlayerEnabled,
  setMiniPlayerHoverAction,
  useMiniPlayerEnabled,
  useMiniPlayerHoverAction,
  type MiniPlayerHoverAction,
} from "../settings/miniPlayer";
import {
  setMainWindowGeometryPersistenceEnabled,
  useMainWindowGeometryPersistenceEnabled,
} from "../settings/mainWindowGeometry";
import { setMinimizeToTray, useMinimizeToTray } from "../settings/tray";
import {
  SIDEBAR_MODES,
  setSidebarMode,
  useSidebarMode,
  type SidebarMode,
} from "../settings/sidebarMode";
import {
  setAuthenticatedStreaming,
  setYouTubeScrobbling,
  useAuthenticatedStreaming,
  useYouTubeScrobbling,
} from "../settings/youtubeAccount";
import {
  AUDIO_ENGINE_MODES,
  setAudioEngineMode,
  useAudioEngineMode,
  type AudioEngineMode,
} from "../settings/audioEngine";
import {
  captureKeyboardShortcut,
  formatKeyboardShortcut,
  KEYBOARD_SHORTCUT_ACTIONS,
  resetKeyboardShortcut,
  resetKeyboardShortcuts,
  setKeyboardShortcut,
  useKeyboardShortcuts,
  type KeyboardShortcutAction,
} from "../settings/keyboardShortcuts";
import {
  addLocalPlaylistPath,
  createLocalPlaylist,
  deleteLocalPlaylist,
  getLocalPlaylists,
  removeLocalPlaylistPath,
  subscribeToLocalPlaylists,
} from "../../player/localPlaylists";
import { LastFmService, type LastFmAuthStart, type LastFmSessionStatus } from "../../player/LastFm";
import { DiscordRpcService } from "../../player/DiscordRPC";
import { useDiscordPresenceEnabled } from "../settings/discord";
import {
  setLastFmScrobblingEnabled,
  useLastFmScrobblingEnabled,
} from "../settings/lastfm";
import { isLinux } from "../platform";
import { GITHUB_NEW_ISSUE_URL, GITHUB_REPOSITORY_URL } from "../links";
import { AccountAvatar, AccountSwitcher } from "../components/AccountSwitcher";
import {
  AUDIO_QUALITY_LABELS,
  setDownloadQuality,
  setStreamingQuality,
  useDownloadQuality,
  useStreamingQuality,
  type AudioQuality,
} from "../../internal/audioQuality";
import {
  getOfflineMaxBytes,
  removeAllDownloads,
  setOfflineMaxBytes,
  useOfflineState,
} from "../../player/offlineStore";




/*
 * Label + description pair used by every settings row.
 *
 * `flex flex-col` is the load-bearing part: both children are inline elements, so without a
 * block/flex wrapper the description runs straight on from the label ("Scrobble playsSend
 * now playing updates...") — the CSS Modules used to stack them and the Tailwind migration
 * dropped it.
 */
const SETTING_LABEL =
  "flex flex-col gap-0.5 text-sm text-muted-foreground [&>strong]:text-sm [&>strong]:font-medium [&>strong]:text-foreground";

/** Section card. One shape for every group so the page reads as a single system. */
const SETTINGS_CARD = "flex flex-col gap-5 rounded-2xl bg-card/50 p-6";

/**
 * How long ago YouTube last answered as this account, in words.
 *
 * Deliberately visible rather than internal: with no telemetry, this one line is what turns
 * "liking songs stopped working" into a report somebody can act on.
 */
function formatSessionAge(confirmedAt: number | null): string {
  if (confirmedAt === null) return "not yet";
  const minutes = Math.floor((Date.now() - confirmedAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

/**
 * Text field. Preflight strips the browser's default input chrome, and these two fields were
 * left bare by the CSS Modules migration — they rendered as invisible text on the card.
 */
const SETTINGS_FIELD =
  "min-w-0 rounded-lg bg-background px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-inset focus:ring-ring/60";

/**
 * One settings row: label and description on the left, control on the right.
 *
 * The wrapper is a `div`, not a `label`, because the controls are now buttons
 * (`role="switch"`, `role="listbox"`) rather than native inputs — a button inside a label
 * gets its activation swallowed by the label's own click forwarding. The association is made
 * explicitly instead, via `aria-labelledby` on the control, so screen readers still announce
 * the row title when the control takes focus.
 */
function SettingRow({
  title,
  description,
  disabled,
  children,
}: {
  title: string;
  description?: ReactNode;
  disabled?: boolean;
  /** Receives the id of the row title so the control can point `aria-labelledby` at it. */
  children: (labelId: string) => ReactNode;
}) {
  const labelId = useId();
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-6 py-2.5",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <span className="flex min-w-0 flex-col gap-0.5">
        <span id={labelId} className="text-sm font-medium text-foreground">
          {title}
        </span>
        {description ? (
          <span className="text-sm text-muted-foreground">{description}</span>
        ) : null}
      </span>
      <span className="flex shrink-0 items-center gap-2 pt-0.5">{children(labelId)}</span>
    </div>
  );
}

/** Its own component so each row can hold its own subscription rather than one per item here. */
function ToolbarItemToggle({ item }: { item: (typeof TOOLBAR_ITEMS)[number] }) {
  const visible = useToolbarItemVisible(item.id);
  return (
    <SettingToggle
      title={item.label}
      description={item.description}
      checked={visible}
      onCheckedChange={(checked) => setToolbarItemVisible(item.id, checked)}
    />
  );
}

/** The common case: a row whose only control is a switch. */
function SettingToggle({
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  title: string;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <SettingRow title={title} description={description} disabled={disabled}>
      {(labelId) => (
        <Switch
          checked={checked}
          onCheckedChange={onCheckedChange}
          disabled={disabled}
          aria-labelledby={labelId}
        />
      )}
    </SettingRow>
  );
}

/**
 * Header for a settings card: icon, title and description on the left, status on the right.
 *
 * The four cards each rolled their own, and three of them put the status chip immediately
 * after the description inside a plain `flex gap-3` — so "Signed out" read as part of the
 * sentence rather than as the card's state. `justify-between` plus a `min-w-0 flex-1` text
 * column is what actually pins it to the right edge and truncates instead of overflowing.
 */
function SettingsCardHeader({
  title,
  titleId,
  description,
  icon,
  status,
}: {
  title: string;
  titleId: string;
  description: ReactNode;
  icon?: ReactNode;
  /** Right-aligned state, e.g. "Connected". */
  status?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      {icon ? (
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/15 text-primary">
          {icon}
        </span>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <h2 id={titleId} className="text-lg font-semibold text-foreground">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {status ? <span className="shrink-0 text-sm">{status}</span> : null}
    </div>
  );
}

/** Quiet outbound links in the page header. */
type SettingsTab = "about" | "appearance" | "playback" | "system" | "shortcuts" | "window";

const SETTINGS_TABS: Array<{
  id: SettingsTab;
  label: string;
  description: string;
  icon: typeof UserIcon;
}> = [
  { id: "about", label: "Account", description: "Sign-in, integrations, updates", icon: UserIcon },
  { id: "appearance", label: "Appearance", description: "Theme and motion", icon: PaletteIcon },
  {
    id: "playback",
    label: "Playback",
    description: "Transitions and session",
    icon: PlayIcon,
  },
  { id: "system", label: "Library", description: "Cache and local files", icon: FolderIcon },
  { id: "window", label: "Window", description: "Chrome and mini player", icon: QueuePanelIcon },
  { id: "shortcuts", label: "Shortcuts", description: "Keyboard bindings", icon: KeyIcon },
];

const THEME_OPTIONS: Array<{
  value: ThemePreference;
  label: string;
  hint: string;
  swatch: string;
}> = [
  { value: "light", label: "Light", hint: "Always light", swatch: "bg-white" },
  { value: "dark", label: "Dark", hint: "Always dark", swatch: "bg-neutral-900" },
  {
    value: "system",
    label: "System",
    hint: "Match the OS",
    swatch: "bg-linear-to-br from-white to-neutral-900",
  },
];

interface SettingsPageProps {
  libraryController: LibraryController;
  libraryState: LibraryState;
  onRestartOnboarding: () => void;
  onSignIn: () => Promise<void>;
  onDeleteAllAppData: () => Promise<void>;
}

export function SettingsPage({
  libraryController,
  libraryState,
  onRestartOnboarding,
  onSignIn,
  onDeleteAllAppData,
}: SettingsPageProps) {
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  const [cacheSizeGb, setCacheSizeGb] = useState(DEFAULT_CACHE_SIZE_GB.toString());
  const [cacheBusy, setCacheBusy] = useState(false);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [installedVersion, setInstalledVersion] = useState<string | null>(null);
  const [updateResult, setUpdateResult] = useState<UpdateInfo | null>(null);
  const [updateStatus, setUpdateStatus] = useState<
    "idle" | "checking" | "installing" | "current" | "error"
  >("idle");
  const [updateProgress, setUpdateProgress] = useState<UpdateInstallProgress | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [autostartEnabled, setAutostartEnabledState] = useState(false);
  const [autostartLoading, setAutostartLoading] = useState(true);
  const [autostartError, setAutostartError] = useState<string | null>(null);
  const [logOpening, setLogOpening] = useState(false);
  const [logError, setLogError] = useState<string | null>(null);
  const [miniPlayerResetting, setMiniPlayerResetting] = useState(false);
  const [resetSettingsConfirming, setResetSettingsConfirming] = useState(false);
  const [resetSettingsBusy, setResetSettingsBusy] = useState(false);
  const [resetSettingsError, setResetSettingsError] = useState<string | null>(null);
  const [localPlaylistName, setLocalPlaylistName] = useState("");
  const [localPlaylistPathInputs, setLocalPlaylistPathInputs] = useState<Record<string, string>>({});
  const [localPlaylistError, setLocalPlaylistError] = useState<string | null>(null);
  const [localPlaylistBrowsingId, setLocalPlaylistBrowsingId] = useState<string | null>(null);
  const [lastFmSession, setLastFmSession] = useState<LastFmSessionStatus | null>(null);
  const [lastFmAuth, setLastFmAuth] = useState<LastFmAuthStart | null>(null);
  const [lastFmBusy, setLastFmBusy] = useState(false);
  const [lastFmError, setLastFmError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>("about");
  const themePreference = useThemePreference();
  const [listeningShortcut, setListeningShortcut] = useState<KeyboardShortcutAction | null>(null);
  const keyboardShortcuts = useKeyboardShortcuts();
  const paperPcMode = usePaperPcMode();
  const miniPlayerEnabled = useMiniPlayerEnabled();
  const miniPlayerHoverAction = useMiniPlayerHoverAction();
  const sidebarMode = useSidebarMode();
  const audioEngineMode = useAudioEngineMode();
  const authenticatedStreaming = useAuthenticatedStreaming();
  const youtubeScrobbling = useYouTubeScrobbling();
  const preferredLyricsSource = usePreferredLyricsSourceId();
  const lyricsFontScale = useLyricsFontScale();
  const lyricsTranslationLang = useLyricsTranslationLang();
  const madeForYouVisible = useMadeForYouVisible();
  const crossfadeSec = useCrossfadeSec();
  const gaplessEnabled = useGaplessEnabled();
  const sessionRestoreEnabled = useSessionRestoreEnabled();
  const extraPlayerControlsAlwaysVisible = useExtraPlayerControlsAlwaysVisible();
  const compactPlayerBar = useCompactPlayerBar();
  const windowsStyleWindowControls = useWindowsStyleWindowControls();
  const nativeWindowControls = useNativeWindowControls();
  const mainWindowGeometryPersistenceEnabled = useMainWindowGeometryPersistenceEnabled();
  const minimizeToTray = useMinimizeToTray();
  const offlineState = useOfflineState();
  const streamingQuality = useStreamingQuality();
  const downloadQuality = useDownloadQuality();
  const [offlineMaxGb, setOfflineMaxGb] = useState(
    () => getOfflineMaxBytes() / 1024 ** 3,
  );
  const [clearingDownloads, setClearingDownloads] = useState(false);
  const lastFmScrobblingEnabled = useLastFmScrobblingEnabled();
  const discordPresenceEnabled = useDiscordPresenceEnabled();
  const localPlaylists = useSyncExternalStore(
    subscribeToLocalPlaylists,
    getLocalPlaylists,
    getLocalPlaylists,
  );
  const account = libraryState.library?.account;
  // Confirmed by YouTube rather than inferred from cached data — see LibraryState.
  const isSignedIn = libraryState.status === "ready"
    && account
    && libraryState.sessionConfirmedAt !== null;
  const authBusy = libraryState.status === "restoring"
    || libraryState.status === "authorizing"
    || libraryState.status === "loading";

  useEffect(() => {
    let active = true;
    void getCacheStats()
      .then((stats) => {
        if (!active) return;
        setCacheStats(stats);
        setCacheSizeGb((stats.maxBytes / 1024 ** 3).toString());
      })
      .catch(() => {
        if (active) setCacheError("Unable to load cache settings.");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void getInstalledVersion()
      .then((version) => {
        if (active) setInstalledVersion(version);
      })
      .catch(() => {
        if (active) setInstalledVersion("Unknown");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void LastFmService.getSession()
      .then((session) => {
        if (active) setLastFmSession(session);
      })
      .catch((error) => {
        if (active) {
          setLastFmError(error instanceof Error ? error.message : "Unable to load Last.fm connection.");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!resetSettingsConfirming) return undefined;
    const timeout = window.setTimeout(() => setResetSettingsConfirming(false), 4000);
    return () => window.clearTimeout(timeout);
  }, [resetSettingsConfirming]);

  const handleCheckForUpdates = async () => {
    setUpdateStatus("checking");
    setUpdateResult(null);
    setUpdateError(null);
    setUpdateProgress(null);
    try {
      const update = await checkForUpdates();
      setUpdateResult(update);
      setUpdateStatus(update ? "idle" : "current");
    } catch (error) {
      setUpdateError(getUpdateFailureMessage(error));
      setUpdateStatus("error");
    }
  };

  const handleInstallUpdate = async () => {
    if (!updateResult) return;
    setUpdateStatus("installing");
    setUpdateError(null);
    try {
      await installUpdate(updateResult, setUpdateProgress);
    } catch {
      setUpdateError("Unable to install the update. You can download it from GitHub.");
      setUpdateStatus("error");
    }
  };

  useEffect(() => {
    let active = true;
    void getAutostartEnabled()
      .then((enabled) => {
        if (active) setAutostartEnabledState(enabled);
      })
      .catch(() => {
        if (active) setAutostartError("Unable to load the startup setting.");
      })
      .finally(() => {
        if (active) setAutostartLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleAutostartChange = async (enabled: boolean) => {
    setAutostartLoading(true);
    setAutostartError(null);
    try {
      await setAutostartEnabled(enabled);
      setAutostartEnabledState(enabled);
    } catch {
      setAutostartError("Unable to update the startup setting.");
    } finally {
      setAutostartLoading(false);
    }
  };

  const handleOpenLog = async () => {
    setLogOpening(true);
    setLogError(null);
    try {
      await invoke("open_current_log");
    } catch {
      setLogError("Unable to open the log file.");
    } finally {
      setLogOpening(false);
    }
  };

  const handleResetMiniPlayerPosition = async () => {
    setMiniPlayerResetting(true);
    try {
      await resetMiniPlayerPosition();
    } finally {
      setMiniPlayerResetting(false);
    }
  };

  const saveCacheSize = async () => {
    const sizeGb = Number(cacheSizeGb);
    if (!Number.isFinite(sizeGb) || sizeGb < 0.25 || sizeGb > 64) {
      setCacheError("Cache size must be between 0.25 GB and 64 GB.");
      return;
    }

    setCacheBusy(true);
    setCacheError(null);
    try {
      setCacheStats(await setCacheMaxBytes(Math.round(sizeGb * 1024 ** 3)));
    } catch {
      setCacheError("Unable to save the cache size.");
    } finally {
      setCacheBusy(false);
    }
  };

  const handleClearCache = async () => {
    setCacheBusy(true);
    setCacheError(null);
    try {
      setCacheStats(await clearCache());
    } catch {
      setCacheError("Unable to clear cached content.");
    } finally {
      setCacheBusy(false);
    }
  };

  const handleClearAllSettings = async () => {
    setResetSettingsError(null);
    if (!resetSettingsConfirming) {
      setResetSettingsConfirming(true);
      return;
    }

    setResetSettingsBusy(true);
    try {
      await onDeleteAllAppData();
      await relaunch().catch(() => {
        window.location.reload();
      });
    } catch {
      setResetSettingsError("Unable to delete all app data.");
      setResetSettingsBusy(false);
      setResetSettingsConfirming(false);
    }
  };

  const handleCreateLocalPlaylist = () => {
    setLocalPlaylistError(null);
    try {
      createLocalPlaylist(localPlaylistName);
      setLocalPlaylistName("");
    } catch (error) {
      setLocalPlaylistError(error instanceof Error ? error.message : "Unable to create local playlist.");
    }
  };

  const handleStartLastFmAuth = async () => {
    setLastFmBusy(true);
    setLastFmError(null);
    try {
      const auth = await LastFmService.startAuth();
      setLastFmAuth(auth);
    } catch (error) {
      setLastFmError(error instanceof Error ? error.message : "Unable to start Last.fm sign-in.");
    } finally {
      setLastFmBusy(false);
    }
  };

  const handleFinishLastFmAuth = async () => {
    if (!lastFmAuth) return;
    setLastFmBusy(true);
    setLastFmError(null);
    try {
      const session = await LastFmService.completeAuth(lastFmAuth.token);
      setLastFmSession(session);
      setLastFmAuth(null);
      setLastFmScrobblingEnabled(true);
    } catch (error) {
      setLastFmError(error instanceof Error ? error.message : "Unable to finish Last.fm sign-in.");
    } finally {
      setLastFmBusy(false);
    }
  };

  const handleDisconnectLastFm = async () => {
    setLastFmBusy(true);
    setLastFmError(null);
    try {
      await LastFmService.disconnect();
      setLastFmSession(null);
      setLastFmAuth(null);
    } catch (error) {
      setLastFmError(error instanceof Error ? error.message : "Unable to disconnect Last.fm.");
    } finally {
      setLastFmBusy(false);
    }
  };

  const handleAddLocalPlaylistPath = (playlistId: string) => {
    setLocalPlaylistError(null);
    const path = localPlaylistPathInputs[playlistId]?.trim() ?? "";
    if (!path) {
      setLocalPlaylistError("Enter a folder path before adding it.");
      return;
    }
    addLocalPlaylistPath(playlistId, path);
    setLocalPlaylistPathInputs((current) => ({ ...current, [playlistId]: "" }));
  };

  const handleBrowseLocalPlaylistPath = async (playlistId: string) => {
    setLocalPlaylistError(null);
    setLocalPlaylistBrowsingId(playlistId);
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "Choose music folder",
      });
      if (typeof selected !== "string") return;
      addLocalPlaylistPath(playlistId, selected);
      setLocalPlaylistPathInputs((current) => ({
        ...current,
        [playlistId]: "",
      }));
    } catch {
      setLocalPlaylistError("Unable to open the folder picker.");
    } finally {
      setLocalPlaylistBrowsingId(null);
    }
  };

  const handleShortcutCapture = (
    event: KeyboardEvent<HTMLButtonElement>,
    action: KeyboardShortcutAction,
  ) => {
    if (listeningShortcut !== action) return;

    event.preventDefault();
    event.stopPropagation();

    if (event.code === "Escape") {
      setListeningShortcut(null);
      return;
    }

    const shortcut = captureKeyboardShortcut(event.nativeEvent);
    if (!shortcut) return;

    setKeyboardShortcut(action, shortcut);
    setListeningShortcut(null);
  };

  useEffect(() => {
    if (!listeningShortcut) return undefined;

    const handleShortcutKeyDown = (event: globalThis.KeyboardEvent) => {
      event.preventDefault();
      event.stopImmediatePropagation();

      if (event.code === "Escape") {
        setListeningShortcut(null);
        return;
      }

      const shortcut = captureKeyboardShortcut(event);
      if (!shortcut) return;

      setKeyboardShortcut(listeningShortcut, shortcut);
      setListeningShortcut(null);
    };

    window.addEventListener("keydown", handleShortcutKeyDown, true);
    return () => window.removeEventListener("keydown", handleShortcutKeyDown, true);
  }, [listeningShortcut]);

  const formatBytes = (bytes: number) => {
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-7">
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="flex flex-col gap-1.5">
          <h1>Settings</h1>
          <p className="text-sm text-muted-foreground">
            Manage your account, library, appearance, and window behaviour.
          </p>
        </div>

        {/*
          Card pills rather than the bare text links these were: at text weight they read as
          part of the description above and were routinely missed. They stay unfilled so they
          still sit below the category nav in the hierarchy.
        */}
        <div className="flex flex-wrap items-center gap-2">
          <ExternalLinkButton
            icon={<StarIcon size={16} aria-hidden="true" />}
            label="Star on GitHub"
            url={GITHUB_REPOSITORY_URL}
          />
          <ExternalLinkButton
            icon={<BugIcon size={16} aria-hidden="true" />}
            label="Report an issue"
            url={GITHUB_NEW_ISSUE_URL}
          />
        </div>
      </header>

      {/* Vertical nav rather than a pill row: it has room for a description per
          category and scales as sections are added, the way desktop settings do.
          The nav sticks so the categories stay reachable while a long panel scrolls. */}
      <div className="flex min-h-0 flex-1 items-start gap-10">
        <nav
          className="sticky top-0 flex w-56 shrink-0 flex-col gap-0.5"
          role="tablist"
          aria-label="Settings categories"
        >
          {SETTINGS_TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "group/tab relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  isActive ? "text-foreground" : "text-muted-foreground hover:bg-card/60 hover:text-foreground",
                )}
              >
                {isActive && (
                  <motion.span
                    layoutId="settings-tab-active"
                    transition={{ type: "spring", stiffness: 520, damping: 42 }}
                    className="absolute inset-0 -z-10 rounded-xl bg-card"
                  />
                )}
                <span
                  className={cn(
                    "grid size-8 shrink-0 place-items-center rounded-lg transition-colors",
                    isActive ? "bg-primary/15 text-primary" : "bg-card/70 text-muted-foreground",
                  )}
                >
                  <Icon size={17} aria-hidden="true" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{tab.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {tab.description}
                  </span>
                </span>
              </button>
            );
          })}
        </nav>

        <div className="flex min-h-0 w-full min-w-0 max-w-2xl flex-1 flex-col">

      {activeTab === "about" && (
        <div className="flex flex-col gap-5" role="tabpanel" aria-label="About settings">
          <section className={SETTINGS_CARD} aria-labelledby="account-settings-title">
            <SettingsCardHeader
              title="Account"
              titleId="account-settings-title"
              icon={<UserIcon size={18} aria-hidden="true" />}
              description={isSignedIn ? "Signed in to YouTube Music" : "No account connected"}
              status={
                <span className={isSignedIn ? "text-primary" : "text-muted-foreground"}>
                  {isSignedIn ? "Connected" : "Signed out"}
                </span>
              }
            />

            {/* `justify-between` with a `min-w-0 flex-1` text column: without both, the name
                and description push the sign-out button off the right edge on long channel
                names instead of truncating. */}
            <div className="flex items-center justify-between gap-3">
              <AccountAvatar artworkUrl={account?.artworkUrl} className="size-11" iconSize={26} />

              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-base font-medium text-foreground">
                  {isSignedIn ? account?.name || "YouTube Music" : "Not signed in"}
                </span>
                <span className="truncate text-sm text-muted-foreground">
                  {isSignedIn
                    ? `Session confirmed ${formatSessionAge(libraryState.sessionConfirmedAt)}.`
                    : "Sign in to load your library."}
                </span>
              </div>

              {isSignedIn ? (
                <button
                  className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-card disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  type="button"
                  onClick={() => void libraryController.signOut()}
                >
                  <LogoutIcon size={18} />
                  Sign out
                </button>
              ) : (
                <GoogleSignInButton
                  isBusy={authBusy}
                  onClick={() => void onSignIn()}
                />
              )}
            </div>

            {/* Renders nothing unless the account actually has more than one channel. */}
            {isSignedIn && (
              <div className="flex flex-col gap-1.5 border-t border-border pt-4">
                <span className="px-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Channel
                </span>
                <AccountSwitcher libraryController={libraryController} showSingle />
              </div>
            )}

            {libraryState.error && <p className="text-sm text-destructive">{libraryState.error}</p>}
          </section>

          <section className={SETTINGS_CARD} aria-labelledby="lastfm-settings-title">
            <SettingsCardHeader
              title="Last.fm"
              titleId="lastfm-settings-title"
              icon={<LastFmIcon size={18} aria-hidden="true" />}
              description={
                lastFmSession
                  ? `Connected as ${lastFmSession.username}`
                  : "Connect Last.fm to scrobble your listening history."
              }
              status={
                <span className={lastFmSession ? "text-primary" : "text-muted-foreground"}>
                  {lastFmSession ? "Connected" : "Signed out"}
                </span>
              }
            />

            <div className="flex flex-col gap-5">
              <SettingToggle
                title="Scrobble plays"
                description="Send now playing updates and scrobbles after a track reaches the Last.fm listening threshold."
                checked={lastFmSession ? lastFmScrobblingEnabled : false}
                disabled={!lastFmSession}
                onCheckedChange={setLastFmScrobblingEnabled}
              />

              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className={cn(SETTING_LABEL, "min-w-0 flex-1")}>
                  <strong>Account connection</strong>
                  <span>
                    {lastFmAuth
                      ? "Approve the connection in your browser, then finish it here."
                      : lastFmSession
                        ? "Disconnecting stops future Last.fm updates from this app."
                        : "A browser window will open so you can approve this app on Last.fm."}
                  </span>
                </span>
                {lastFmSession ? (
                  <button
                    className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-card disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    type="button"
                    disabled={lastFmBusy}
                    onClick={() => void handleDisconnectLastFm()}
                  >
                    <LastFmIcon size={18} />
                    {lastFmBusy ? "Disconnecting..." : "Disconnect"}
                  </button>
                ) : lastFmAuth ? (
                  <button
                    className="flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    type="button"
                    disabled={lastFmBusy}
                    onClick={() => void handleFinishLastFmAuth()}
                  >
                    <LastFmIcon size={18} />
                    {lastFmBusy ? "Finishing..." : "Finish connection"}
                  </button>
                ) : (
                  <button
                    className="flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    type="button"
                    disabled={lastFmBusy}
                    onClick={() => void handleStartLastFmAuth()}
                  >
                    <LastFmIcon size={18} />
                    {lastFmBusy ? "Opening..." : "Connect Last.fm"}
                  </button>
                )}
              </div>

              {lastFmError && <p className="text-sm text-destructive">{lastFmError}</p>}
            </div>
          </section>

          <section className={SETTINGS_CARD} aria-labelledby="discord-settings-title">
            <h2 className="text-lg font-semibold text-foreground" id="discord-settings-title">
              Discord
            </h2>

            <div className="flex flex-col gap-5">
              <SettingToggle
                title="Show what you're playing"
                description="Publishes the current track, artist and artwork to your Discord profile. Turning this off clears whatever is showing there now."
                checked={discordPresenceEnabled}
                onCheckedChange={(enabled) => void DiscordRpcService.setEnabled(enabled)}
              />
            </div>
          </section>

          <section className={SETTINGS_CARD} aria-labelledby="about-settings-title">
            <h2 className="text-lg font-semibold text-foreground" id="about-settings-title">
              About
            </h2>

            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className={cn(SETTING_LABEL, "min-w-0 flex-1")}>
                  <strong>Updates</strong>
                  <span>
                    Installed version: {
                      installedVersion
                        ? installedVersion === "Unknown" ? installedVersion : `v${installedVersion}`
                        : "Loading..."
                    }
                  </span>
                </span>
                <button
                  className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-card disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  type="button"
                  disabled={updateStatus === "checking"}
                  onClick={() => void handleCheckForUpdates()}
                >
                  <RefreshIcon size={18} />
                  {updateStatus === "checking" ? "Checking..." : "Check for updates"}
                </button>
              </div>

              {updateResult && (
                <div className="flex flex-col gap-1">
                  <span>
                    {updateStatus === "installing"
                      ? updateProgress?.percent !== undefined
                        ? `Downloading version ${updateResult.version}: ${updateProgress.percent}%`
                        : `Preparing version ${updateResult.version}...`
                      : `Version ${updateResult.version} is available.`}
                  </span>
                  {updateResult.canInstall && (
                    <button
                      className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-card disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      type="button"
                      disabled={updateStatus === "installing"}
                      onClick={() => void handleInstallUpdate()}
                    >
                      {updateStatus === "installing" ? "Installing..." : "Install"}
                    </button>
                  )}
                  {/* The one link where a silent failure strands the user: if this cannot
                      open, they have no other route to the download. */}
                  <ExternalLinkButton
                    label={updateResult.canInstall ? "View changes" : "Download"}
                    url={updateResult.releaseUrl}
                    className="px-4 py-2"
                  />
                </div>
              )}
              {updateStatus === "current" && (
                <p className="text-sm text-muted-foreground">You are up to date.</p>
              )}
              {updateStatus === "error" && (
                <p className="text-sm text-destructive">{updateError}</p>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className={cn(SETTING_LABEL, "min-w-0 flex-1")}>
                  <strong>Quick start</strong>
                  <span>Replay the guided introduction.</span>
                </span>
                <button
                  className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-card disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  type="button"
                  onClick={onRestartOnboarding}
                >
                  <RefreshIcon size={18} />
                  Start onboarding
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      {activeTab === "system" && (
        <div className="flex flex-col gap-5" role="tabpanel" aria-label="System settings">
          <section className={SETTINGS_CARD} aria-labelledby="system-settings-title">
            <h2 className="text-lg font-semibold text-foreground" id="system-settings-title">
              System
            </h2>

            <div className="flex flex-col gap-5">
              <SettingToggle
                title="Launch at startup"
                description="Start Zuno when your computer starts."
                checked={autostartEnabled}
                disabled={autostartLoading}
                onCheckedChange={(checked) => void handleAutostartChange(checked)}
              />

              {autostartError && <p className="text-sm text-destructive">{autostartError}</p>}

              <SettingRow
                title="Streaming quality"
                description="Applies to songs played over the network. Lower uses less data."
              >
                {(labelId) => (
                  <Select
                    className="w-52"
                    value={streamingQuality}
                    onValueChange={(value) => setStreamingQuality(value as AudioQuality)}
                  >
                    <SelectTrigger aria-labelledby={labelId}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(AUDIO_QUALITY_LABELS) as AudioQuality[]).map((quality) => (
                        <SelectItem key={quality} value={quality}>
                          {AUDIO_QUALITY_LABELS[quality]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </SettingRow>

              <SettingRow
                title="Download quality"
                description="Applies to songs saved for offline. Higher sounds better and uses more disk."
              >
                {(labelId) => (
                  <Select
                    className="w-52"
                    value={downloadQuality}
                    onValueChange={(value) => setDownloadQuality(value as AudioQuality)}
                  >
                    <SelectTrigger aria-labelledby={labelId}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(AUDIO_QUALITY_LABELS) as AudioQuality[]).map((quality) => (
                        <SelectItem key={quality} value={quality}>
                          {AUDIO_QUALITY_LABELS[quality]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </SettingRow>

              <SettingRow
                title="Translate lyrics"
                description="Shows a translation under each line. Sends the lyrics to Google Translate."
              >
                {(labelId) => (
                  <Select
                    className="w-52"
                    value={lyricsTranslationLang}
                    onValueChange={setLyricsTranslationLang}
                  >
                    <SelectTrigger aria-labelledby={labelId}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={TRANSLATION_OFF}>Off</SelectItem>
                      {TRANSLATION_LANGUAGES.map((code) => (
                        <SelectItem key={code} value={code}>
                          {getLanguageLabel(code)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </SettingRow>

              <SettingRow
                title="Lyrics text size"
                description="Scales the lyrics screen. The size still adapts to the window on top of this."
              >
                {(labelId) => (
                  <Select
                    className="w-52"
                    value={String(lyricsFontScale)}
                    onValueChange={(value) => setLyricsFontScale(Number(value))}
                  >
                    <SelectTrigger aria-labelledby={labelId}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LYRICS_FONT_SCALES.map((option) => (
                        <SelectItem key={option.value} value={String(option.value)}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </SettingRow>

              <SettingRow
                title="Preferred lyrics source"
                description="Tried first when a song opens. If it has nothing for that song, the others still run."
              >
                {(labelId) => (
                  <Select
                    className="w-52"
                    value={preferredLyricsSource}
                    onValueChange={setPreferredLyricsSourceId}
                  >
                    <SelectTrigger aria-labelledby={labelId}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={AUTO_LYRICS_SOURCE}>Automatic</SelectItem>
                      {LYRICS_SOURCES.map((source) => (
                        <SelectItem key={source.id} value={source.id}>
                          {source.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </SettingRow>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className={cn(SETTING_LABEL, "min-w-0 flex-1")}>
                  <strong>Downloads</strong>
                  <span>
                    {offlineState.usedBytes > 0 || Object.keys(offlineState.entries).length > 0
                      ? `${Object.keys(offlineState.entries).length} songs · ${formatBytes(offlineState.usedBytes)}`
                      : "No songs downloaded yet."}
                    {offlineState.downloadingId
                      ? offlineState.progress !== null
                        ? ` · downloading ${offlineState.progress}%`
                        : " · downloading"
                      : ""}
                    {offlineState.queued.length > 0
                      ? ` · ${offlineState.queued.length} queued`
                      : ""}
                  </span>
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Maximum size
                    <span className="flex w-28 items-center gap-1.5 rounded-lg bg-background px-2.5 py-1.5 text-sm text-foreground focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/60">
                      <input
                        className="w-full min-w-0 bg-transparent outline-none"
                        type="number"
                        min={1}
                        max={512}
                        value={Math.round(offlineMaxGb)}
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          if (!Number.isFinite(next)) return;
                          setOfflineMaxGb(next);
                          setOfflineMaxBytes(Math.max(1, next) * 1024 ** 3);
                        }}
                        aria-label="Maximum download size in gigabytes"
                      />
                      <span className="shrink-0 text-xs text-muted-foreground">GB</span>
                    </span>
                  </label>
                  <button
                    className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    type="button"
                    disabled={clearingDownloads || Object.keys(offlineState.entries).length === 0}
                    onClick={() => {
                      setClearingDownloads(true);
                      void removeAllDownloads().finally(() => setClearingDownloads(false));
                    }}
                  >
                    <TrashIcon size={18} />
                    {clearingDownloads ? "Removing..." : "Remove all"}
                  </button>
                </div>
              </div>

              <SettingToggle
                title="Minimize to tray"
                description="Closing the window hides Zuno to the system tray and keeps playing. Quit from the tray icon."
                checked={minimizeToTray}
                onCheckedChange={setMinimizeToTray}
              />

              <SettingToggle
                title="Remember window size and location"
                description="Reopen the main window with its last size and screen position."
                checked={mainWindowGeometryPersistenceEnabled}
                onCheckedChange={setMainWindowGeometryPersistenceEnabled}
              />

              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <span className={cn(SETTING_LABEL, "min-w-0 flex-1")}>
                    <strong>Local playlists</strong>
                    <span>Create playlists from folders on this computer.</span>
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      className={cn(SETTINGS_FIELD, "w-44")}
                      type="text"
                      value={localPlaylistName}
                      placeholder="Playlist name"
                      aria-label="Local playlist name"
                      onChange={(event) => setLocalPlaylistName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") handleCreateLocalPlaylist();
                      }}
                    />
                    <button
                      className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-card disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      type="button"
                      onClick={handleCreateLocalPlaylist}
                    >
                      <FolderAddIcon size={18} />
                      Create
                    </button>
                  </div>
                </div>

                {localPlaylistError && <p className="text-sm text-destructive">{localPlaylistError}</p>}

                {localPlaylists.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    {localPlaylists.map((playlist) => (
                      <div className="flex items-center justify-between gap-3 rounded-lg bg-background/40 px-3 py-2 text-sm" key={playlist.id}>
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-foreground">
                            <FolderIcon size={18} aria-hidden="true" />
                            {playlist.name}
                          </span>
                          <button
                            className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                            type="button"
                            onClick={() => deleteLocalPlaylist(playlist.id)}
                          >
                            <TrashIcon size={18} />
                            Delete
                          </button>
                        </div>

                        <div className="flex flex-col gap-2">
                          <span className="flex items-center gap-2">
                            <input
                              className={cn(SETTINGS_FIELD, "flex-1")}
                              type="text"
                              value={localPlaylistPathInputs[playlist.id] ?? ""}
                              placeholder="/Users/name/Music"
                              aria-label={`Folder path for ${playlist.name}`}
                              onChange={(event) => setLocalPlaylistPathInputs((current) => ({
                                ...current,
                                [playlist.id]: event.target.value,
                              }))}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") handleAddLocalPlaylistPath(playlist.id);
                              }}
                            />
                            <button
                              type="button"
                              className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-card disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                              disabled={localPlaylistBrowsingId === playlist.id}
                              title="Browse for folder"
                              aria-label={`Browse for a folder for ${playlist.name}`}
                              onClick={() => void handleBrowseLocalPlaylistPath(playlist.id)}
                            >
                              <FolderOpenIcon size={17} aria-hidden="true" />
                            </button>
                          </span>
                          <button
                            className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-card disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                            type="button"
                            onClick={() => handleAddLocalPlaylistPath(playlist.id)}
                          >
                            Add
                          </button>
                        </div>

                        {playlist.paths.length > 0 ? (
                          <div className="flex flex-col gap-1.5">
                            {playlist.paths.map((path) => (
                              <div className="flex items-center justify-between gap-3 rounded-lg bg-background/40 px-3 py-2 text-sm" key={path}>
                                <span>{path}</span>
                                <button
                                  type="button"
                                  aria-label={`Remove ${path}`}
                                  onClick={() => removeLocalPlaylistPath(playlist.id, path)}
                                >
                                  <TrashIcon size={16} aria-hidden="true" />
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="px-1 py-3 text-sm text-muted-foreground">No paths added yet.</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className={cn(SETTING_LABEL, "min-w-0 flex-1")}>
                  <strong>Application log</strong>
                  <span>Open the current log file for sharing or troubleshooting.</span>
                </span>
                <button
                  className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-card disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  type="button"
                  disabled={logOpening}
                  onClick={() => void handleOpenLog()}
                >
                  <LogFileIcon size={18} />
                  {logOpening ? "Opening..." : "Open log"}
                </button>
              </div>

              {logError && <p className="text-sm text-destructive">{logError}</p>}

              <SettingToggle
                title="Potato PC mode"
                description="Disables animations, blur effects, and the animated star background."
                checked={paperPcMode}
                onCheckedChange={setPaperPcMode}
              />

              <div className="flex flex-wrap items-end justify-between gap-4 py-2">
                <span className={cn(SETTING_LABEL, "min-w-0 flex-1")}>
                  <strong>Cache</strong>
                  <span className="tabular-nums">
                    {cacheStats
                      ? `${formatBytes(cacheStats.usedBytes)} of ${formatBytes(cacheStats.maxBytes)}`
                      : "Loading…"}
                    {cacheStats ? ` · ${cacheStats.entryCount} items` : ""}
                  </span>
                </span>

                <div className="flex flex-wrap items-center gap-2">
                  {/* The caption sits above the field rather than inside it: nested in a
                      fixed-width pill it wrapped onto two lines and squeezed the number. */}
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Maximum size
                    <span className="flex w-28 items-center gap-1.5 rounded-lg bg-background px-2.5 py-1.5 text-sm text-foreground focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/60">
                      <input
                        className="w-full min-w-0 bg-transparent tabular-nums outline-none"
                        type="number"
                        min="0.25"
                        max="64"
                        step="0.25"
                        value={cacheSizeGb}
                        disabled={cacheBusy}
                        onChange={(event) => setCacheSizeGb(event.target.value)}
                      />
                      <span className="shrink-0 text-muted-foreground">GB</span>
                    </span>
                  </label>
                  <button
                    className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-card disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    type="button"
                    disabled={cacheBusy}
                    onClick={() => void saveCacheSize()}
                  >
                    Save
                  </button>
                  <button
                    className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    type="button"
                    disabled={cacheBusy}
                    onClick={() => void handleClearCache()}
                  >
                    <TrashIcon size={18} />
                    Clear cache
                  </button>
                </div>
              </div>

              {cacheError && <p className="text-sm text-destructive">{cacheError}</p>}

              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className={cn(SETTING_LABEL, "min-w-0 flex-1")}>
                  <strong>Delete all app data</strong>
                  <span>Reset settings, cache, account, queue, tabs, onboarding, and local data.</span>
                </span>
                <button
                  className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  type="button"
                  disabled={resetSettingsBusy}
                  onClick={() => void handleClearAllSettings()}
                >
                  <TrashIcon size={18} />
                  {resetSettingsBusy
                    ? "Deleting..."
                    : resetSettingsConfirming
                      ? "Press again to confirm"
                      : "Delete everything"}
                </button>
              </div>

              {resetSettingsError && <p className="text-sm text-destructive">{resetSettingsError}</p>}
            </div>
          </section>
        </div>
      )}

      {activeTab === "shortcuts" && (
        <div className="flex flex-col gap-5" role="tabpanel" aria-label="Keyboard shortcut settings">
          <section className={SETTINGS_CARD} aria-labelledby="keyboard-shortcuts-settings-title">
            <h2
              className="text-lg font-semibold text-foreground"
              id="keyboard-shortcuts-settings-title"
            >
              Keyboard shortcuts
            </h2>

            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className={cn(SETTING_LABEL, "min-w-0 flex-1")}>
                  <strong>Reset shortcuts</strong>
                  <span>Restore every keyboard shortcut to its default.</span>
                </span>
                <button
                  className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-card disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  type="button"
                  onClick={resetKeyboardShortcuts}
                >
                  <RefreshIcon size={18} />
                  Reset all
                </button>
              </div>

              {KEYBOARD_SHORTCUT_ACTIONS.map((shortcutAction) => {
                const shortcut = keyboardShortcuts[shortcutAction.id];
                const isListening = listeningShortcut === shortcutAction.id;

                return (
                  <div className="flex items-center justify-between gap-4 py-2" key={shortcutAction.id}>
                    <span className={SETTING_LABEL}>
                      <strong>{shortcutAction.label}</strong>
                      <span>{shortcutAction.description}</span>
                    </span>
                    <div className="flex items-center gap-2">
                      <button
                        className={cn("min-w-32 rounded-lg bg-background px-2.5 py-1.5 text-center text-sm text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", isListening && "text-primary")}
                        type="button"
                        aria-pressed={isListening}
                        onClick={() => setListeningShortcut(shortcutAction.id)}
                        onKeyDown={(event) => handleShortcutCapture(event, shortcutAction.id)}
                        onBlur={() => {
                          if (isListening) setListeningShortcut(null);
                        }}
                      >
                        {isListening ? "Press shortcut..." : formatKeyboardShortcut(shortcut)}
                      </button>
                      <button
                        className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-card disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        type="button"
                        onClick={() => resetKeyboardShortcut(shortcutAction.id)}
                      >
                        Reset
                      </button>
                      <button
                        className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-card disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        type="button"
                        disabled={!shortcut}
                        onClick={() => setKeyboardShortcut(shortcutAction.id, null)}
                      >
                        Clear
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      )}

      {activeTab === "window" && (
        <div className="flex flex-col gap-5" role="tabpanel" aria-label="Style settings">
          <section className={SETTINGS_CARD} aria-labelledby="window-settings-title">
            <SettingsCardHeader
              title="Window controls"
              titleId="window-settings-title"
              icon={<QueuePanelIcon size={18} aria-hidden="true" />}
              description="Choose the title bar buttons and compact player behavior."
            />

            <SettingToggle
              title="Mini player"
              description="Show compact playback controls when the main window is not focused. Turning this off closes its window and frees around 30 MB."
              checked={miniPlayerEnabled}
              onCheckedChange={setMiniPlayerEnabled}
            />

            <SettingRow
              title="Library sidebar"
              description="How much room the playlist rail takes. Expand on hover keeps the collapsed width while still letting you read the list."
            >
              {() => (
                <Select
                  className="w-52"
                  value={sidebarMode}
                  onValueChange={(value) => setSidebarMode(value as SidebarMode)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SIDEBAR_MODES.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </SettingRow>

            <SettingRow
              title="Mini player hover bar"
              description="Choose what the expanded hover slider controls."
            >
              {() => (
                <Select
                  className="w-44"
                  value={miniPlayerHoverAction}
                  onValueChange={(value) =>
                    setMiniPlayerHoverAction(value as MiniPlayerHoverAction)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="seek">Song position</SelectItem>
                    <SelectItem value="volume">Volume</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </SettingRow>

            <div className="flex items-center justify-between gap-4 py-2">
              <span className={SETTING_LABEL}>
                <strong>Mini player position</strong>
                <span>Move the mini player back to the bottom center of this screen.</span>
              </span>
              <button
                className="flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-card disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                type="button"
                disabled={miniPlayerResetting}
                onClick={() => void handleResetMiniPlayerPosition()}
              >
                {miniPlayerResetting ? "Resetting..." : "Reset position"}
              </button>
            </div>

            <SettingToggle
              title="Windows-style controls"
              description="Use minimize, maximize, and close buttons with square edges."
              checked={windowsStyleWindowControls}
              disabled={nativeWindowControls}
              onCheckedChange={setWindowsStyleWindowControls}
            />

            <SettingToggle
              title="Use OS native controls"
              description={isLinux
                ? "Let the operating system draw the window frame and title bar. The app restarts to apply this on Linux."
                : "Let the operating system draw the window frame and title bar."}
              checked={nativeWindowControls}
              onCheckedChange={(checked) => {
                setNativeWindowControls(checked);
                if (isLinux) {
                  void relaunch().catch(() => window.location.reload());
                }
              }}
            />
          </section>

          <section className={SETTINGS_CARD} aria-labelledby="behavior-settings-title">
            <div className="flex items-center gap-2">
              <h2 className="text-lg" id="behavior-settings-title">Behavior</h2>
            </div>

            <SettingToggle
              title="Compact player bar"
              description="Tuck the seek bar under the transport controls instead of spanning the full width."
              checked={compactPlayerBar}
              onCheckedChange={setCompactPlayerBar}
            />

            <SettingToggle
              title="Always show extra controls"
              description="Keep lyrics and queue visible instead of showing them only on hover."
              checked={extraPlayerControlsAlwaysVisible}
              onCheckedChange={setExtraPlayerControlsAlwaysVisible}
            />
          </section>
        </div>
      )}

      {activeTab === "playback" && (
        <div className="flex flex-col gap-5" role="tabpanel" aria-label="Playback settings">
          <section className={SETTINGS_CARD} aria-labelledby="playback-engine-title">
            <SettingsCardHeader
              title="Audio engine"
              titleId="playback-engine-title"
              icon={<PlayIcon size={18} aria-hidden="true" />}
              description="What actually plays the sound."
            />

            <SettingRow
              title="Playback method"
              description={
                audioEngineMode === "native"
                  ? "Zuno plays each track itself. About 90 MB lighter, slower to start, no gapless or crossfade."
                  : "A hidden YouTube frame plays each track. Costs about 90 MB, starts faster, required for gapless and crossfade."
              }
            >
              {() => (
                <Select
                  className="w-52"
                  value={audioEngineMode}
                  onValueChange={(value) => setAudioEngineMode(value as AudioEngineMode)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AUDIO_ENGINE_MODES.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </SettingRow>

            <p className="px-1 text-xs text-muted-foreground">
              Applies from the next track.
            </p>

            <SettingToggle
              title="Resolve streams as your account"
              description="Attaches your session when resolving a track — required for Premium bitrates. Downloads always resolve anonymously."
              checked={authenticatedStreaming}
              onCheckedChange={setAuthenticatedStreaming}
            />

            <SettingToggle
              title="Add plays to YouTube Music history"
              description="Reports plays to YouTube, feeding its recommendations. Also enables the setting above. The YouTube frame always reports its own."
              checked={youtubeScrobbling}
              onCheckedChange={setYouTubeScrobbling}
            />
          </section>

          <section className={SETTINGS_CARD} aria-labelledby="playback-settings-title">
            <SettingsCardHeader
              title="Transitions"
              titleId="playback-settings-title"
              icon={<PlayIcon size={18} aria-hidden="true" />}
              description="How one track becomes the next."
            />

            <SettingToggle
              title="Gapless playback"
              description="Load the next track while the current one is still playing, so albums and live sets run without a pause between songs."
              checked={gaplessEnabled}
              onCheckedChange={setGaplessEnabled}
            />

            <SettingRow
              title="Crossfade"
              description={
                crossfadeSec > 0
                  ? `Overlap each track with the next by ${crossfadeSec} second${
                    crossfadeSec === 1 ? "" : "s"
                  }.`
                  : "Off. Move the slider to overlap the end of each track with the start of the next."
              }
            >
              {(labelId) => (
                <span className="flex items-center gap-3">
                  <RangeSlider
                    className="w-44"
                    value={crossfadeSec}
                    min={0}
                    max={MAX_CROSSFADE_SEC}
                    step={1}
                    onValueChange={setCrossfadeSec}
                    aria-label="Crossfade length in seconds"
                  />
                  <span
                    id={labelId}
                    className="w-10 shrink-0 text-right text-sm tabular-nums text-muted-foreground"
                  >
                    {crossfadeSec > 0 ? `${crossfadeSec}s` : "Off"}
                  </span>
                </span>
              )}
            </SettingRow>

            {/*
              Crossfading a downloaded track is not possible: offline files play through an
              audio element rather than the deck pair the overlap needs. Saying so beats
              leaving people to wonder why it only sometimes works.
            */}
            <p className="text-sm text-muted-foreground">
              Both apply to streamed tracks. Downloaded and local files always play back to back.
            </p>
          </section>

          <section className={SETTINGS_CARD} aria-labelledby="session-settings-title">
            <SettingsCardHeader
              title="Session"
              titleId="session-settings-title"
              icon={<QueuePanelIcon size={18} aria-hidden="true" />}
              description="What comes back when you reopen Zuno."
            />

            <SettingToggle
              title="Restore tabs and queues"
              description="Reopen your tabs, queues and playback position on launch. Playback always starts paused."
              checked={sessionRestoreEnabled}
              onCheckedChange={setSessionRestoreEnabled}
            />
          </section>
        </div>
      )}

      {activeTab === "appearance" && (
        <div className="flex flex-col gap-5" role="tabpanel" aria-label="Appearance settings">
          <section className={SETTINGS_CARD} aria-labelledby="theme-settings-title">
            <SettingsCardHeader
              title="Theme"
              titleId="theme-settings-title"
              icon={<PaletteIcon size={18} aria-hidden="true" />}
              description="Applies instantly across both windows."
            />

            <div
              className="grid grid-cols-3 gap-2"
              role="radiogroup"
              aria-labelledby="theme-settings-title"
            >
              {THEME_OPTIONS.map((option) => {
                const isActive = themePreference === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    onClick={() => setThemePreference(option.value)}
                    className={cn(
                      "flex flex-col items-center gap-2 rounded-xl p-3 transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      isActive ? "bg-primary/15" : "bg-background/40 hover:bg-card",
                    )}
                  >
                    {/* Miniature window preview rather than a colour dot — it shows what
                        the choice actually does. */}
                    <span
                      className={cn(
                        "flex h-12 w-full flex-col justify-end overflow-hidden rounded-lg p-1 ring-1",
                        option.swatch,
                        isActive ? "ring-primary" : "ring-black/10",
                      )}
                      aria-hidden="true"
                    >
                      <span
                        className={cn(
                          "h-2 w-full rounded-sm",
                          option.value === "light" ? "bg-neutral-300" : "bg-neutral-700",
                        )}
                      />
                    </span>
                    <span className="text-sm font-medium text-foreground">{option.label}</span>
                    <span className="text-xs text-muted-foreground">{option.hint}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className={SETTINGS_CARD} aria-labelledby="toolbar-settings-title">
            <div className="min-w-0">
              <h2 className="text-lg" id="toolbar-settings-title">Title bar</h2>
              <p className="text-sm text-muted-foreground">
                Which optional buttons sit next to the window controls.
              </p>
            </div>

            {TOOLBAR_ITEMS.map((item) => (
              <ToolbarItemToggle key={item.id} item={item} />
            ))}
          </section>

          <section className={SETTINGS_CARD} aria-labelledby="home-settings-title">
            <div className="min-w-0">
              <h2 className="text-lg" id="home-settings-title">Home</h2>
              <p className="text-sm text-muted-foreground">
                Which sections the home page shows.
              </p>
            </div>

            <SettingToggle
              title="Made for you"
              description="The recommendation carousel at the top. Hiding it leaves the surprise button and More recommendations working."
              checked={madeForYouVisible}
              onCheckedChange={setMadeForYouVisible}
            />
          </section>

          <section className={SETTINGS_CARD} aria-labelledby="motion-settings-title">
            <div className="min-w-0">
              <h2 className="text-lg" id="motion-settings-title">Motion &amp; performance</h2>
              <p className="text-sm text-muted-foreground">
                Turn these off on low-powered machines.
              </p>
            </div>

            <SettingToggle
              title="Reduced motion mode"
              description="Disables animations, blur and shadows across the app."
              checked={paperPcMode}
              onCheckedChange={setPaperPcMode}
            />
          </section>
        </div>
      )}

        </div>
      </div>
    </main>
  );
}
