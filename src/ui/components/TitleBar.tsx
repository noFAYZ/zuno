import { useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/motion/tooltip";
import { DiscordIcon, GitHubIcon, LastFmIcon, LoginIcon, SettingsIcon, YouTubeMusicIcon } from "@/ui/icons";
import { GITHUB_REPOSITORY_URL } from "../links";
import { DiscordRpcService } from "../../player/DiscordRPC";
import { useDiscordPresenceEnabled } from "../settings/discord";
import { setLastFmScrobblingEnabled, useLastFmScrobblingEnabled } from "../settings/lastfm";
import { setYouTubeScrobbling, useYouTubeScrobbling } from "../settings/youtubeAccount";
import { logInternalError, logInternalInfo, logInternalWarn } from "../../internal/logging";
import { MusicTabs } from "./MusicTabs";
import type { Tab } from "../types/tab";
import {
  useNativeWindowControls,
  useWindowsStyleWindowControls,
} from "../settings/windowControls";
import { Button } from "@/components/motion/button";
import { libraryController, useLibraryState } from "../../player/playerStore";
import { AccountAvatar, AccountSwitcher } from "./AccountSwitcher";
import { GoogleSignInButton } from "./GoogleSignInButton";
import { DownloadsPanel } from "./DownloadsPanel";
import { FloatingPanel } from "./FloatingPanel";
import { NotificationsPanel } from "./NotificationsPanel";
import { useToolbarItemVisible } from "../settings/toolbarItems";
import { motion } from "motion/react";
import appIcon from "../../../assets/img/Logo.png";

interface TitleBarProps {
  tabs: Tab[];
  activeTabId: string;
  playingTabId: string | null;
  sidebarWidth: number;
  isHomeActive: boolean;
  onNavigateHome: () => void;
  onCreateTab: () => void;
  onCloseTab: (tabId: string) => void;
  onSwitchTab: (tabId: string) => void;
  onReorderTab: (draggedTabId: string, targetTabId: string, insertAfter: boolean) => void;
  onOpenSettings: () => void;
  onOpenDownloads?: () => void;
  onboardingFirstTabId?: string;
}

const ACCOUNT_PANEL_ITEM =
  "flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm text-foreground transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** macOS-style traffic lights vs Windows-style square controls. */
const WINDOW_BUTTON_BASE =
  "flex items-center justify-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function TitleBar({
  tabs,
  activeTabId,
  playingTabId,
  sidebarWidth,
  isHomeActive,
  onNavigateHome,
  onCreateTab,
  onCloseTab,
  onSwitchTab,
  onReorderTab,
  onOpenSettings,
  onOpenDownloads,
  onboardingFirstTabId,
}: TitleBarProps) {
  const appWindow = getCurrentWindow();
  const libraryState = useLibraryState();
  const account = libraryState.library?.account;
  // Confirmed by YouTube, not merely by having a library on screen — a cache with no expiry
  // will happily supply one long after the session behind it stopped working.
  const isSignedIn = libraryState.status === "ready"
    && Boolean(account)
    && libraryState.sessionConfirmedAt !== null;
  // Startup restores the session before it can say whether there is one — "Not signed in" is
  // the wrong answer while that is still happening.
  const isConnecting = !isSignedIn
    && (libraryState.status === "restoring"
      || libraryState.status === "loading"
      || libraryState.status === "authorizing");
  const [isAccountPanelOpen, setIsAccountPanelOpen] = useState(false);
  const nativeWindowControls = useNativeWindowControls();
  const windowsStyleWindowControls = useWindowsStyleWindowControls();
  const discordEnabled = useDiscordPresenceEnabled();
  const lastFmEnabled = useLastFmScrobblingEnabled();
  const ytScrobblingEnabled = useYouTubeScrobbling();
  const notificationsVisible = useToolbarItemVisible("notifications");
  const downloadsVisible = useToolbarItemVisible("downloads");
  const discordVisible = useToolbarItemVisible("discord");
  const lastFmVisible = useToolbarItemVisible("lastfm");
  const ytMusicVisible = useToolbarItemVisible("ytmusic");
  const githubVisible = useToolbarItemVisible("github");
  const homePointerRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);
  const suppressHomeClickRef = useRef(false);
  const hideHomeText = sidebarWidth <= 120;

  const startWindowDrag = async () => {
    try {
      window.dispatchEvent(new Event("main-window-drag-started"));

      if (await appWindow.isMaximized()) {
        await appWindow.unmaximize();
      }

      await appWindow.startDragging();
    } catch (error) {
      logInternalError("TitleBar.startWindowDrag failed", error);
    }
  };

  const handleMinimize = async () => {
    try {
      if (await appWindow.isFullscreen()) {
        await appWindow.setFullscreen(false);
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }

      await appWindow.minimize();
    } catch (error) {
      logInternalError("TitleBar.minimize failed", error);
    }
  };

  const handleToggleMaximize = async () => {
    try {
      if (await appWindow.isMaximized()) {
        await appWindow.unmaximize();
      } else {
        await appWindow.maximize();
      }
    } catch (error) {
      logInternalError("TitleBar.maximize failed", error);
    }
  };

  return (
    <div className="relative z-30 flex h-[var(--titlebar-height)] shrink-0 items-stretch bg-background">
      <button
        type="button"
        style={{ width: `${sidebarWidth}px` }}
        className={cn(
          "flex shrink-0 items-center gap-1 px-4 text-sm font-bold  transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
          isHomeActive ? "text-primary" : "text-muted-foreground hover:text-foreground",
          hideHomeText && "justify-center gap-0 px-0",
        )}
        onClick={() => {
          if (suppressHomeClickRef.current) {
            suppressHomeClickRef.current = false;
            return;
          }
          onNavigateHome();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          suppressHomeClickRef.current = false;
          homePointerRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const pointer = homePointerRef.current;
          if (!pointer || pointer.pointerId !== event.pointerId) return;

          const distance = Math.hypot(
            event.clientX - pointer.startX,
            event.clientY - pointer.startY,
          );
          if (distance < 5) return;

          homePointerRef.current = null;
          suppressHomeClickRef.current = true;
          void startWindowDrag();
        }}
        onPointerUp={(event) => {
          if (homePointerRef.current?.pointerId === event.pointerId) {
            homePointerRef.current = null;
          }
        }}
        onPointerCancel={() => {
          homePointerRef.current = null;
        }}
        aria-label="Home"
        aria-current={isHomeActive ? "page" : undefined}
      >
         <motion.img
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: "spring", stiffness: 260, damping: 24 }}
          className="size-6 "
          src={appIcon}
          alt=""
        /> 
        {!hideHomeText && <h3 >zuno_</h3>}
      </button>

      <MusicTabs
        tabs={tabs}
        activeTabId={activeTabId}
        playingTabId={playingTabId}
        onCreateTab={onCreateTab}
        onCloseTab={onCloseTab}
        onSwitchTab={onSwitchTab}
        onReorderTab={onReorderTab}
        onboardingFirstTabId={onboardingFirstTabId}
      />

      <div
        className="min-w-6 flex-1"
        aria-label="Drag window"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          void startWindowDrag();
        }}
        onDoubleClick={() => void handleToggleMaximize()}
      />

      {/*
        App actions sit immediately left of the window controls, separated by a hairline so
        "things that act on the app" and "things that act on the window" stay legible as two
        groups. They render regardless of the native-controls setting, since on Linux/native
        chrome the window buttons disappear but these still belong here.
      */}
      <div className="flex shrink-0 items-center gap-1 pl-2 pr-1" aria-label="App actions">
        {/*
          Integration toggles.

          Both share what the user is listening to with a third party, which is exactly the kind
          of thing worth being able to stop in one click rather than three — hence a toolbar
          toggle rather than only a setting buried in a panel. Dimmed when off so the current
          state reads at a glance without a label.
        */}
        {notificationsVisible && (
          <NotificationsPanel signedIn={libraryState.status === "ready"} />
        )}
        {downloadsVisible && <DownloadsPanel onOpenDownloads={onOpenDownloads} />}
        {discordVisible && (
        <Tooltip
          side="bottom"
          content={discordEnabled ? "Discord presence on" : "Discord presence off"}
        >
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void DiscordRpcService.setEnabled(!discordEnabled)}
            aria-pressed={discordEnabled}
            aria-label={
              discordEnabled ? "Turn off Discord presence" : "Turn on Discord presence"
            }
          >
            <DiscordIcon
              size={16}
              aria-hidden="true"
              className={cn(
                "transition-opacity",
                discordEnabled ? "opacity-100 text-primary" : "opacity-40",
              )}
            />
          </Button>
        </Tooltip>
        )}
        {lastFmVisible && (
        <Tooltip
          side="bottom"
          content={lastFmEnabled ? "Last.fm scrobbling on" : "Last.fm scrobbling off"}
        >
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setLastFmScrobblingEnabled(!lastFmEnabled)}
            aria-pressed={lastFmEnabled}
            aria-label={
              lastFmEnabled ? "Turn off Last.fm scrobbling" : "Turn on Last.fm scrobbling"
            }
          >
            <LastFmIcon
              size={16}
              aria-hidden="true"
              className={cn(
                "transition-opacity",
                lastFmEnabled ? "opacity-100 text-primary" : "opacity-40",
              )}
            />
          </Button>
        </Tooltip>
        )}
        {ytMusicVisible && (
        <Tooltip
          side="bottom"
          content={
            ytScrobblingEnabled
              ? "Adding plays to YouTube Music history"
              : "Not adding plays to YouTube Music history"
          }
        >
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setYouTubeScrobbling(!ytScrobblingEnabled)}
            aria-pressed={ytScrobblingEnabled}
            aria-label={
              ytScrobblingEnabled
                ? "Stop adding plays to YouTube Music history"
                : "Add plays to YouTube Music history"
            }
          >
            <YouTubeMusicIcon
              size={16}
              aria-hidden="true"
              className={cn(
                "transition-opacity",
                ytScrobblingEnabled ? "opacity-100 text-primary" : "opacity-40",
              )}
            />
          </Button>
        </Tooltip>
        )}

        {githubVisible && (
        <Tooltip side="bottom" content="Source on GitHub">
          <Button
            variant='ghost'
          size='icon'
            onClick={() => void openUrl(GITHUB_REPOSITORY_URL)}
            aria-label="Open the project on GitHub"
          >
            <GitHubIcon size={16} aria-hidden="true"  />
          </Button>
        </Tooltip>
        )}
        <Tooltip side="bottom" content="Settings">
        <Button
            variant='ghost'
          size='icon'
            
            onClick={onOpenSettings}
            aria-label="Open settings"
          >
            <SettingsIcon size={17} aria-hidden="true" />
          </Button>
        </Tooltip>

        {/* Only once signed in: an avatar that opens nothing is worse than no avatar. The
            panel is portalled because the title bar clips its children. */}
        {/* Always present, signed in or not: when signed out it is the way *in*, so hiding
            it would leave the toolbar with no account affordance at all. */}
        <FloatingPanel
          open={isAccountPanelOpen}
          onOpenChange={setIsAccountPanelOpen}
          side="bottom"
          className="w-64"
          trigger={
            <Tooltip side="bottom" content={isSignedIn ? account?.name || "Account" : "Sign in"}>
              <button
                type="button"
                onClick={() => setIsAccountPanelOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={isAccountPanelOpen}
                aria-label={isSignedIn ? `Account: ${account?.name || "YouTube Music"}` : "Sign in"}
                className={cn(
                  "ml-0.5 grid size-7 place-items-center rounded-full transition-shadow",
                  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                  isAccountPanelOpen && "ring-1 ring-border",
                )}
              >
                <AccountAvatar
                  artworkUrl={isSignedIn ? account?.artworkUrl : undefined}
                  className="size-7"
                  iconSize={15}
                />
              </button>
            </Tooltip>
          }
        >
          {isSignedIn ? (
            <div className="flex flex-col gap-1">
              {/* Who you are, before what you can do about it: the avatar in the toolbar is
                  ambiguous on its own, and this line is the answer to the click. */}
              <div className="flex items-center gap-2.5 px-1 py-1.5">
                <AccountAvatar artworkUrl={account?.artworkUrl} className="size-9" iconSize={18} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">
                    {account?.name || "YouTube Music"}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">Signed in</span>
                </span>
              </div>

              <span className="my-0.5 h-px bg-border" aria-hidden="true" />

              <AccountSwitcher
                libraryController={libraryController}
                onSwitched={() => setIsAccountPanelOpen(false)}
              />

              <button
                type="button"
                className={ACCOUNT_PANEL_ITEM}
                onClick={() => {
                  setIsAccountPanelOpen(false);
                  onOpenSettings();
                }}
              >
                <SettingsIcon size={16} aria-hidden="true" />
                Account settings
              </button>
            </div>
          ) : (
            /*
             * Signed out, this panel is the way in, so it says what signing in gets you rather
             * than only offering a verb. The button hands off to settings because that screen
             * is where the device-code prompt is rendered — starting the flow from here would
             * put the code somewhere nobody is looking.
             */
            <div className="flex flex-col items-center gap-1 px-2 pb-2 pt-3 text-center">
              <span className="grid size-11 place-items-center rounded-full bg-primary/10 text-primary">
                <LoginIcon size={20} aria-hidden="true" />
              </span>
              <p className="mt-1 text-sm font-semibold text-foreground">
                {isConnecting ? "Connecting…" : "Not signed in"}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {isConnecting
                  ? "Restoring your YouTube Music session."
                  : "Connect YouTube Music for your library, playlists and likes."}
              </p>
              <GoogleSignInButton
                className="mt-2"
                fullWidth
                isBusy={isConnecting}
                onClick={() => {
                  setIsAccountPanelOpen(false);
                  onOpenSettings();
                }}
              />
            </div>
          )}
        </FloatingPanel>
      </div>

      {!nativeWindowControls && (
        <span className="my-3 w-px shrink-0 bg-border" aria-hidden="true" />
      )}

      {!nativeWindowControls && (
        <div
          className={cn(
            "flex shrink-0 items-center",
            windowsStyleWindowControls ? "gap-0" : "gap-1.5 px-3",
          )}
          aria-label="Window controls"
        >
          <button
            type="button"
            aria-label="Minimize"
            className={cn(
              WINDOW_BUTTON_BASE,
              windowsStyleWindowControls
                ? "h-full w-12 hover:bg-card"
                : "size-3 rounded-full bg-muted-foreground/40 hover:bg-muted-foreground",
            )}
            onClick={() => void handleMinimize()}
          >
            {windowsStyleWindowControls && <span aria-hidden="true">&#8211;</span>}
          </button>
          <button
            type="button"
            aria-label="Maximize"
            className={cn(
              WINDOW_BUTTON_BASE,
              windowsStyleWindowControls
                ? "h-full w-12 hover:bg-card"
                : "size-3 rounded-full bg-muted-foreground/40 hover:bg-muted-foreground",
            )}
            onClick={() => void handleToggleMaximize()}
          >
            {windowsStyleWindowControls && <span aria-hidden="true">□</span>}
          </button>
          <button
            type="button"
            aria-label="Close"
            className={cn(
              WINDOW_BUTTON_BASE,
              windowsStyleWindowControls
                ? "h-full w-12 hover:bg-destructive hover:text-destructive-foreground"
                : "size-3 rounded-full bg-muted-foreground/40 hover:bg-primary",
            )}
            onClick={() => {
              logInternalInfo("TitleBar.close clicked");
              void invoke("quit_app")
                .then(() => {
                  logInternalInfo("TitleBar.close quit_app invoked");
                })
                .catch((error) => {
                  logInternalError("TitleBar.close quit_app failed", error);
                  logInternalWarn("TitleBar.close fallback to appWindow.close");
                  void appWindow.close();
                });
            }}
          >
            {windowsStyleWindowControls && <span aria-hidden="true">&#10005;</span>}
          </button>
        </div>
      )}
    </div>
  );
}
