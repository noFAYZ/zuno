import { useCallback, useEffect, useMemo } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PlayerState } from "./PlayerController";
import type { PlayerControllerActions } from "./playerStore";
import { logInternalWarn } from "../internal/logging";
import { useLinuxMediaSession } from "../ui/settings/mediaSession";

type NativeMediaAction =
  | "play"
  | "pause"
  | "playPause"
  | "next"
  | "previous"
  | { action: "seekTo"; positionSec: number };

const usesNativeWindowsMediaSession =
  isTauri() && /Windows/i.test(navigator.userAgent);
/*
 * macOS goes through MPNowPlayingInfoCenter rather than the WebView's media session, because
 * only the native centre reaches Control Center, the lock screen and the F7-F9 keys. The Rust
 * side (`macos_media.rs`) has always been built and registered — it simply had no caller, so
 * the app was invisible to macOS media controls.
 *
 * Linux registers its own MPRIS2 D-Bus interface (`linux_media.rs`, via souvlaki) rather than
 * relying on WebKitGTK's own bridge, because the bridge doesn't surface next/previous through
 * the desktop widget or media keys. Unlike Windows/macOS this one has an on/off switch — the
 * existing "Show in system media controls" setting — since it's the only platform that ever had
 * one to turn off.
 */
const usesNativeMacosMediaSession =
  isTauri() && /Macintosh|Mac OS X/i.test(navigator.userAgent);
const usesNativeLinuxMediaSession =
  isTauri() && /Linux/i.test(navigator.userAgent);
const usesNativeMediaSession =
  usesNativeWindowsMediaSession ||
  usesNativeMacosMediaSession ||
  usesNativeLinuxMediaSession;

function getNativeMediaCommand(linuxEnabled: boolean): string | null {
  if (usesNativeWindowsMediaSession) return "update_windows_media_session";
  if (usesNativeMacosMediaSession) return "update_macos_media_session";
  if (usesNativeLinuxMediaSession && linuxEnabled) return "update_linux_media_session";
  return null;
}

function getNativeMediaControlEvent(linuxEnabled: boolean): string | null {
  if (usesNativeWindowsMediaSession) return "windows-media-control";
  if (usesNativeMacosMediaSession) return "macos-media-control";
  if (usesNativeLinuxMediaSession && linuxEnabled) return "linux-media-control";
  return null;
}

function getBrowserPlaybackState(status: PlayerState["status"]): MediaSessionPlaybackState {
  if (status === "playing" || status === "loading") return "playing";
  if (status === "paused") return "paused";
  return "none";
}

function getClampedPosition(duration: number, position: number): number {
  const safePosition = Number.isFinite(position) ? Math.max(0, position) : 0;
  if (!Number.isFinite(duration) || duration <= 0) return safePosition;
  return Math.min(duration, safePosition);
}

/**
 * Only the two fields this actually reads.
 *
 * Taking the whole `PlayerState` made every caller a subscriber to all of it — including
 * volume, which commits on every pointer move — to satisfy a signature that never looked at
 * more than the track and the status.
 */
type MediaSessionState = Pick<PlayerState, "currentTrack" | "status">;

export function useMediaSession(
  state: MediaSessionState,
  controller: PlayerControllerActions,
): void {
  const linuxMediaSession = useLinuxMediaSession();
  // The browser `mediaSession` bridge must stay off everywhere a native session exists:
  // WebView2, WKWebView and WebKitGTK all bridge it to SMTC / MPNowPlayingInfoCenter / MPRIS on
  // their own, so enabling it too produces a second now-playing entry and double-fired media
  // keys. On Linux this also means turning the setting off hides Zuno from system media
  // controls entirely, rather than falling back to the browser bridge.
  const mediaSessionEnabled = !usesNativeMediaSession && linuxMediaSession;
  // ponytail: turning the toggle off just stops sending updates — the MPRIS entry freezes at
  // its last state instead of disappearing, since souvlaki has no unregister call. Add a
  // drop_controls command in linux_media.rs if a live "off" needs to clear it.
  const nativeMediaCommand = useMemo(
    () => getNativeMediaCommand(linuxMediaSession),
    [linuxMediaSession],
  );
  const nativeMediaControlEvent = useMemo(
    () => getNativeMediaControlEvent(linuxMediaSession),
    [linuxMediaSession],
  );
  const sendNativeMediaUpdate = useCallback((context: string, forceMetadata = false) => {
    if (!nativeMediaCommand) return;

    const track = state.currentTrack;
    const duration = controller.getDuration() || track?.durationSec || 0;
    void invoke(nativeMediaCommand, {
      update: {
        title: track?.title ?? null,
        artist: track?.artist ?? null,
        artworkUrl: track?.artworkUrl ?? null,
        status: state.status,
        durationSec: duration || null,
        positionSec: getClampedPosition(duration, controller.getCurrentTime()),
        forceMetadata,
      },
    }).catch((error) => {
      logInternalWarn(`useMediaSession native ${context} update failed`, {
        error: String(error),
      });
    });
  }, [controller, nativeMediaCommand, state.currentTrack, state.status]);

  useEffect(() => {
    if (!nativeMediaControlEvent) return;

    const unlistenPromise = listen<NativeMediaAction>(
      nativeMediaControlEvent,
      ({ payload }) => {
        if (typeof payload === "object") {
          if (payload.action === "seekTo") void controller.seekTo(payload.positionSec);
          return;
        }

        if (payload === "play") void controller.play();
        if (payload === "pause") void controller.pause();
        if (payload === "playPause") void controller.togglePlayPause();
        if (payload === "next") void controller.skipToNext();
        if (payload === "previous") void controller.skipToPrevious();
      },
    );

    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [controller, nativeMediaControlEvent]);

  useEffect(() => {
    if (!nativeMediaCommand) return;

    sendNativeMediaUpdate("state", true);
    const retryDelaysMs = [250, 1000, 2500];
    const retryIds = retryDelaysMs.map((delayMs) => (
      window.setTimeout(() => sendNativeMediaUpdate("state retry", true), delayMs)
    ));
    return () => retryIds.forEach((retryId) => window.clearTimeout(retryId));
  }, [nativeMediaCommand, sendNativeMediaUpdate]);

  /*
   * Position goes out once per second while playing, and once per transition otherwise.
   *
   * The OS needs a fresh position for its scrubber, but a paused track's position is fresh
   * already — this was an IPC call every second for as long as a track was loaded, whether or
   * not it was moving. `state.status` is a dependency so pausing, resuming and seeking each
   * still push one update immediately.
   */
  useEffect(() => {
    if (!nativeMediaCommand || !state.currentTrack) return;

    sendNativeMediaUpdate("position");
    if (state.status !== "playing") return;

    const intervalId = window.setInterval(
      () => sendNativeMediaUpdate("position"),
      1000,
    );
    return () => window.clearInterval(intervalId);
  }, [nativeMediaCommand, sendNativeMediaUpdate, state.currentTrack, state.status]);

  useEffect(() => {
    if (mediaSessionEnabled || !("mediaSession" in navigator)) return;

    // Toggle turned off, or the platform uses its native session: clear whatever the
    // browser bridge was showing so no duplicate now-playing entry survives.
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
      for (const action of [
        "play", "pause", "stop", "nexttrack", "previoustrack",
        "seekto", "seekbackward", "seekforward",
      ] as MediaSessionAction[]) {
        navigator.mediaSession.setActionHandler(action, null);
      }
    } catch {
      // WebView media-session support varies by installed runtime version.
    }
  }, [mediaSessionEnabled]);

  useEffect(() => {
    if (!mediaSessionEnabled || !("mediaSession" in navigator)) return;

    const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: () => void controller.play(),
      pause: () => void controller.pause(),
      stop: () => void controller.pause(),
      nexttrack: () => void controller.skipToNext(),
      previoustrack: () => void controller.skipToPrevious(),
      seekto: (details) => {
        if (details.seekTime !== undefined) void controller.seekTo(details.seekTime);
      },
      seekbackward: (details) => {
        const offset = details.seekOffset ?? 10;
        void controller.seekTo(Math.max(0, controller.getCurrentTime() - offset));
      },
      seekforward: (details) => {
        const duration = controller.getDuration();
        const offset = details.seekOffset ?? 10;
        void controller.seekTo(Math.min(duration, controller.getCurrentTime() + offset));
      },
    };

    for (const [action, handler] of Object.entries(handlers)) {
      try {
        navigator.mediaSession.setActionHandler(
          action as MediaSessionAction,
          handler as MediaSessionActionHandler,
        );
      } catch {
        // WebView media-session support varies by installed runtime version.
      }
    }

    return () => {
      for (const action of Object.keys(handlers) as MediaSessionAction[]) {
        try {
          navigator.mediaSession.setActionHandler(action, null);
        } catch {
          // Ignore actions unsupported by the current WebView runtime.
        }
      }
    };
  }, [controller, mediaSessionEnabled]);

  useEffect(() => {
    if (!mediaSessionEnabled || !("mediaSession" in navigator)) return;

    const track = state.currentTrack;
    try {
      navigator.mediaSession.metadata = track
        ? new MediaMetadata({
            title: track.title,
            artist: track.artist,
            artwork: track.artworkUrl ? [{ src: track.artworkUrl }] : [],
          })
        : null;
      navigator.mediaSession.playbackState = getBrowserPlaybackState(state.status);
    } catch {
      // WebView media-session support varies by installed runtime version.
    }
  }, [state.currentTrack, state.status, mediaSessionEnabled]);

  useEffect(() => {
    if (
      !mediaSessionEnabled
      || !("mediaSession" in navigator)
      || !state.currentTrack
    ) return;

    const updatePosition = () => {
      const duration = controller.getDuration() || state.currentTrack?.durationSec || 0;
      const position = Math.min(duration, Math.max(0, controller.getCurrentTime()));
      if (duration > 0) {
        try {
          navigator.mediaSession.setPositionState({
            duration,
            playbackRate: 1,
            position,
          });
        } catch {
          // WebView media-session support varies by installed runtime version.
        }
      }
    };

    // Same reasoning as the native path above: only a moving position needs re-publishing.
    updatePosition();
    if (state.status !== "playing") return;

    const intervalId = window.setInterval(updatePosition, 1000);
    return () => window.clearInterval(intervalId);
  }, [controller, state.currentTrack, state.status, mediaSessionEnabled]);
}
