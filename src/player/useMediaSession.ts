import { useCallback, useEffect, useMemo } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PlayerState } from "./PlayerController";
import type { PlayerControllerActions } from "./playerStore";
import { logInternalWarn } from "../internal/logging";

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
 * Linux is deliberately absent: WebKitGTK bridges `navigator.mediaSession` to MPRIS on its
 * own, so the fallback below already puts Zuno on the desktop's media widget. A native D-Bus
 * server would be a second implementation of something the platform is already doing.
 */
const usesNativeMacosMediaSession =
  isTauri() && /Macintosh|Mac OS X/i.test(navigator.userAgent);
const usesNativeLinuxMediaSession =
  isTauri() && /Linux/i.test(navigator.userAgent);
const usesNativeMediaSession =
  usesNativeWindowsMediaSession ||
  usesNativeMacosMediaSession ||
  usesNativeLinuxMediaSession;



function getNativeMediaCommand(): string | null {
  if (usesNativeWindowsMediaSession) return "update_windows_media_session";
  if (usesNativeMacosMediaSession) return "update_macos_media_session";
  if (usesNativeLinuxMediaSession) return "update_linux_media_session";
  return null;
}

function getNativeMediaControlEvent(): string | null {
  if (usesNativeWindowsMediaSession) return "windows-media-control";
  if (usesNativeMacosMediaSession) return "macos-media-control";
  if (usesNativeLinuxMediaSession) return "linux-media-control";
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
  const nativeMediaCommand = useMemo(getNativeMediaCommand, []);
  const nativeMediaControlEvent = useMemo(getNativeMediaControlEvent, []);
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

  useEffect(() => {
    if (!nativeMediaCommand || !state.currentTrack) return;

    sendNativeMediaUpdate("position");
    const intervalId = window.setInterval(
      () => sendNativeMediaUpdate("position"),
      1000,
    );
    return () => window.clearInterval(intervalId);
  }, [nativeMediaCommand, sendNativeMediaUpdate, state.currentTrack]);

  useEffect(() => {
    if (usesNativeMediaSession || !("mediaSession" in navigator)) return;

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
  }, [controller]);

  useEffect(() => {
    if (!usesNativeMediaSession || !("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = null;
      navigator.mediaSession.playbackState = "none";
    } catch {
      // Ignore if not supported
    }
  }, []);

  useEffect(() => {
    if (usesNativeMediaSession || !("mediaSession" in navigator)) return;

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
  }, [state.currentTrack, state.status]);

  useEffect(() => {
    if (
      usesNativeMediaSession
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

    updatePosition();
    const intervalId = window.setInterval(updatePosition, 1000);
    return () => window.clearInterval(intervalId);
  }, [controller, state.currentTrack, state.status]);
}
