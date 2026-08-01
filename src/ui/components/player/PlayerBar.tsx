import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { SpinnerSteps } from "@/components/motion/loader";
import { cn } from "@/lib/utils";
import { PlayActiveIcon, QueuePanelIcon } from "@/ui/icons";
import { tauriFetch } from "../../../datasource/youtube/tauriFetch";
import { TrackInfo } from "./TrackInfo";
import { PlaybackControls } from "./PlaybackControls";
import { SeekBar } from "./SeekBar";
import { DownloadButton } from "./DownloadButton";
import { PlaybackOptions } from "./PlaybackOptions";
import { VolumeControl } from "./VolumeControl";
import { LyricsButton } from "./LyricsButton";
import {
  useCompactPlayerBar,
  useExtraPlayerControlsAlwaysVisible,
} from "../../settings/playerControls";

interface PlayerBarProps {
  onToggleLyrics: () => void;
  onToggleQueue: () => void;
  isQueueOpen: boolean;
  onConnectionRestored: () => Promise<void>;
  handlePlayerBarClick:()=>void;
}

const CONNECTION_CHECK_URLS = [
  "https://music.youtube.com/",
  "https://cp.cloudflare.com/generate_204",
];

export function PlayerBar({ onToggleLyrics, onToggleQueue, isQueueOpen, onConnectionRestored,handlePlayerBarClick }: PlayerBarProps) {
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [isCheckingConnection, setIsCheckingConnection] = useState(false);
 
  const connectionCheckRef = useRef<Promise<boolean> | null>(null);
  const wasOfflineRef = useRef(!navigator.onLine);
  const recoveryStartedRef = useRef(false);
  const failedChecksRef = useRef(0);

  const updateConnectionState = useCallback((connected: boolean) => {
    if (connected) failedChecksRef.current = 0;
    setIsOnline(connected);

    if (!connected) {
      wasOfflineRef.current = true;
      return;
    }

    if (wasOfflineRef.current && !recoveryStartedRef.current) {
      recoveryStartedRef.current = true;
      void onConnectionRestored();
    }
  }, [onConnectionRestored]);

  const checkConnection = useCallback(async () => {
    if (connectionCheckRef.current) return connectionCheckRef.current;

    const check = (async () => {
      if (!navigator.onLine) {
        failedChecksRef.current += 1;
        if (failedChecksRef.current >= 2) {
          updateConnectionState(false);
        } else {
          window.setTimeout(() => void checkConnection(), 1500);
        }
        return false;
      }

      const checks = await Promise.allSettled(
        CONNECTION_CHECK_URLS.map((url) =>
          tauriFetch(url, {
            cache: "no-store",
            method: "GET",
          })
        ),
      );
      const connected = checks.some((result) => result.status === "fulfilled");
      if (connected) {
        updateConnectionState(true);
      } else {
        failedChecksRef.current += 1;
        if (failedChecksRef.current >= 2) {
          updateConnectionState(false);
        } else {
          window.setTimeout(() => void checkConnection(), 1500);
        }
      }
      return connected;
    })();

    connectionCheckRef.current = check;
    try {
      return await check;
    } finally {
      connectionCheckRef.current = null;
    }
  }, [updateConnectionState]);

  useEffect(() => {
    const handleOnline = () => void checkConnection();
    const handleOffline = () => void checkConnection();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void checkConnection();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void checkConnection();

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [checkConnection, updateConnectionState]);

  useEffect(() => {
    if (isOnline) return;

    const retryTimer = window.setInterval(() => {
      void checkConnection();
    }, 5000);

    return () => window.clearInterval(retryTimer);
  }, [checkConnection, isOnline]);

  const reconnect = async () => {
    setIsCheckingConnection(true);

    try {
      await checkConnection();
    } finally {
      setIsCheckingConnection(false);
    }
  };

  const extraControlsAlwaysVisible = useExtraPlayerControlsAlwaysVisible();
  const compactPlayerBar = useCompactPlayerBar();



  return (
    <>
      <AnimatePresence>
        {!isOnline && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="flex shrink-0 items-center justify-center gap-3 overflow-hidden bg-muted px-2 py-1  text-sm text-foreground"
            role="status"
            aria-live="polite"
          >
            <span>You don't have an internet connection</span>
            <button
              type="button"
              className="flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors hover:bg-card disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => void reconnect()}
              disabled={isCheckingConnection}
              aria-label="Reconnect to the internet"
            >
              {isCheckingConnection ? (
                <SpinnerSteps   size={24}  />
              ) : (
                <PlayActiveIcon size={14} aria-hidden="true" />
              )}
              <span>{isCheckingConnection ? "Checking" : "Reconnect"}</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <div
        className="group/playerbar flex shrink-0 flex-col gap-1 bg-background px-4 pb-3 pt-2"
        onClick={handlePlayerBarClick}
      >
        {/* Expanded: the seek bar spans the full bar above everything. */}
        {!compactPlayerBar && <SeekBar />}

        <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4">
          <div className="min-w-0">
            <TrackInfo />
          </div>

          {/* Compact: the seek bar tucks under the controls, in the centre column only, so
              the bar keeps one row of height and the transport stays the anchor. */}
          <div className="flex flex-col items-center gap-1">
            <PlaybackControls extraControlsAlwaysVisible={extraControlsAlwaysVisible} />
            {compactPlayerBar && (
              <div className="w-full min-w-[22rem]">
                <SeekBar />
              </div>
            )}
          </div>

          <div className="flex min-w-0 items-center justify-end gap-1">
            <div
              className={cn(
                "flex items-center gap-1 transition-opacity",
                !extraControlsAlwaysVisible &&
                  "opacity-0 focus-within:opacity-100 group-hover/playerbar:opacity-100",
              )}
            >
              <LyricsButton onToggle={onToggleLyrics} />

              <button
                type="button"
                className={cn(
                  "flex size-8 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isQueueOpen
                    ? "bg-card text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={onToggleQueue}
                aria-label={isQueueOpen ? "Close queue" : "Open queue"}
                title={isQueueOpen ? "Close queue" : "Open queue"}
              >
                <QueuePanelIcon size={18} />
              </button>
            </div>

            <DownloadButton />
            <PlaybackOptions />
            <VolumeControl />
          </div>
        </div>
      </div>
    </>
  );
}
