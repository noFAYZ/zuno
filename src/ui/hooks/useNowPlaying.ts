import type { PlaybackOrderMode } from "../../player/PlayerController";
import { shallowEqual, usePlayerSelector } from "../../player/playerStore";

export interface NowPlaying {
  /** Id of the track the player is on, or null when idle. */
  currentTrackId: string | null;
  /** Whether that track is actually advancing, as opposed to paused. */
  isPlaying: boolean;
  /** A track is being resolved and buffered; nothing is audible yet. */
  isLoading: boolean;
  /** In-order, shuffle, repeat-one or repeat-all. */
  playbackOrderMode: PlaybackOrderMode;
}

/**
 * The few facts a collection page needs to mark its rows and its header actions.
 *
 * Narrowing to primitives here is deliberate: the pages never touch the player state object,
 * so `TrackRow`'s memo comparison stays cheap and a row only re-renders when its own
 * highlight actually changes.
 *
 * Playback *position* is intentionally absent. It lives in SeekBar's local state, so a
 * 500-row playlist is not re-rendered several times a second just to move a progress bar.
 */
export function useNowPlaying(): NowPlaying {
  const state = usePlayerSelector(
    (player) => ({
      currentTrack: player.currentTrack,
      status: player.status,
      playbackOrderMode: player.playbackOrderMode,
    }),
    shallowEqual,
  );
  return {
    currentTrackId: state.currentTrack?.id ?? null,
    isPlaying: state.status === "playing",
    isLoading: state.status === "loading",
    playbackOrderMode: state.playbackOrderMode,
  };
}
