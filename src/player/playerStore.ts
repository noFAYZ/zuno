import { useCallback, useRef, useSyncExternalStore } from "react";
import { YouTubeMusicDataSource } from "../datasource/youtube/YouTubeMusicDataSource";
import { LibraryController } from "./LibraryController";
import { PlayerController, type PlayerSession, type PlayerState } from "./PlayerController";
import { SearchController } from "./SearchController";
import { TabManager } from "./TabManager";
import { loadAppSession } from "./appSession";
import { readSessionRestoreEnabled } from "../ui/settings/sessionRestore";
import {
  hydrateOfflineStore,
  setOfflineStreamResolver,
  startOfflineProgressFeed,
} from "./offlineStore";

const dataSource = new YouTubeMusicDataSource();

export const libraryController = new LibraryController(dataSource);
export const searchController = new SearchController(dataSource);
/*
 * The offline queue needs a stream URL but must not depend on any particular data source, so
 * the source is injected here where both are already in scope.
 */
setOfflineStreamResolver((track, quality) => {
  /*
   * `resolveDownloadUrl`, never `resolveStreamUrl`. The two differ only in client order, but
   * the download one never reads the authenticated-streaming preference — binding it here is
   * what keeps that guarantee at the wiring site rather than inside a shared function.
   */
  const resolver = (dataSource as {
    resolveDownloadUrl?: (
      t: typeof track,
      q: typeof quality,
    ) => Promise<{ url: string; mimeType: string; cookie?: string }>;
  }).resolveDownloadUrl;
  if (!resolver) throw new Error("Downloads are unavailable for this source.");
  return resolver.call(dataSource, track, quality);
});
void hydrateOfflineStore();
startOfflineProgressFeed();

export const tabManager = new TabManager(dataSource);
/*
 * Read once, at module scope, before anything can toggle it. Restoring is all-or-nothing for a
 * given launch — half a session is worse than none.
 */
const restoredSession = readSessionRestoreEnabled() ? loadAppSession() : null;
if (restoredSession) {
  tabManager.restoreSession(restoredSession.player);
}
if (!tabManager.getActiveId()) {
  tabManager.createTab("1");
}

type PlayerControllerMethod =
  | "loadTrack"
  | "playTrackById"
  | "play"
  | "pause"
  | "togglePlayPause"
  | "addToQueue"
  | "playNext"
  | "skipToNext"
  | "seekTo"
  | "setVolume"
  | "skipToPrevious"
  | "getCurrentTime"
  | "getDuration"
  | "getVolume"
  | "isMuted"
  | "toggleMute"
  | "getPlaybackOrderMode"
  | "cyclePlaybackOrderMode"
  | "toggleShuffle"
  | "setShuffleEnabled"
  | "setPlaybackOrderMode"
  | "setPlaybackRate"
  | "getPlaybackRate"
  | "setSleepTimer"
  | "getSleepTimerRemainingMs"
  | "getLyrics"
  | "getPlayerSession"
  | "removeFromQueueAt"
  | "playQueueTrackAt"
  | "moveQueueTrack"
  | "shuffleUpcomingQueue"
  | "shuffleEntirePlaylist"
  | "clearUpcomingQueue"
  | "addTracksToQueue"
  | "setStopAfterQueueIndex"
  | "generateQueueAfter";

export type PlayerControllerActions = Pick<PlayerController, PlayerControllerMethod>;

class ActivePlayerController implements PlayerControllerActions {
  loadTrack = async (track: Parameters<PlayerController["loadTrack"]>[0]) =>
    (await tabManager.claimFocusedPlayer()).loadTrack(track);
  playTrackById = async (
    videoId: string,
    playbackQueue?: Parameters<PlayerController["playTrackById"]>[1],
    autoplayWhenQueueEnds?: Parameters<PlayerController["playTrackById"]>[2],
    shufflePlaylist?: Parameters<PlayerController["playTrackById"]>[3],
  ) => (await tabManager.claimFocusedPlayer()).playTrackById(
    videoId,
    playbackQueue,
    autoplayWhenQueueEnds,
    shufflePlaylist,
  );
  play = () => tabManager.getActivePlayer().play();
  pause = () => tabManager.getActivePlayer().pause();
  togglePlayPause = () => tabManager.getActivePlayer().togglePlayPause();
  addToQueue = (track: Parameters<PlayerController["addToQueue"]>[0]) =>
    tabManager.getActivePlayer().addToQueue(track);
  playNext = (track: Parameters<PlayerController["playNext"]>[0]) =>
    tabManager.getActivePlayer().playNext(track);
  skipToNext = () => tabManager.getActivePlayer().skipToNext();
  seekTo = (time: number) => tabManager.getActivePlayer().seekTo(time);
  /*
   * No logging here either — see AudioEngine.setVolume. This ran two full log writes per
   * pointer move of the slider, each one reading the player state twice to build its payload.
   */
  setVolume = async (level: number) => {
    const player = tabManager.getActivePlayer();
    const volume = Math.min(1, Math.max(0, level));
    await player.setVolume(volume, volume === 0);
    tabManager.applyPlaybackSettings({
      volume: player.getVolume(),
      muted: player.isMuted(),
    });
  };
  skipToPrevious = () => tabManager.getActivePlayer().skipToPrevious();
  getCurrentTime = () => tabManager.getActivePlayer().getCurrentTime();
  getDuration = () => tabManager.getActivePlayer().getDuration();
  getVolume = () => tabManager.getActivePlayer().getVolume();
  isMuted = () => tabManager.getActivePlayer().isMuted();
  toggleMute = async () => {
    const player = tabManager.getActivePlayer();
    await player.toggleMute();
    tabManager.applyPlaybackSettings({
      volume: player.getVolume(),
      muted: player.isMuted(),
    });
  };
  getPlaybackOrderMode = () => tabManager.getActivePlayer().getPlaybackOrderMode();
  cyclePlaybackOrderMode = () => tabManager.getActivePlayer().cyclePlaybackOrderMode();
  toggleShuffle = () => tabManager.getActivePlayer().toggleShuffle();
  setShuffleEnabled = (enabled: boolean) =>
    tabManager.getActivePlayer().setShuffleEnabled(enabled);
  setPlaybackOrderMode = (mode: Parameters<PlayerController["setPlaybackOrderMode"]>[0]) =>
    tabManager.getActivePlayer().setPlaybackOrderMode(mode);
  setPlaybackRate = (rate: number) => tabManager.getActivePlayer().setPlaybackRate(rate);
  getPlaybackRate = () => tabManager.getActivePlayer().getPlaybackRate();
  setSleepTimer = (minutes: number | null) =>
    tabManager.getActivePlayer().setSleepTimer(minutes);
  getSleepTimerRemainingMs = () =>
    tabManager.getActivePlayer().getSleepTimerRemainingMs();
  getLyrics = (track: Parameters<PlayerController["getLyrics"]>[0]) =>
    tabManager.getActivePlayer().getLyrics(track);
  getPlayerSession = () => tabManager.getActivePlayer().exportSession();
  removeFromQueueAt = (index: number) => tabManager.getActivePlayer().removeFromQueueAt(index);
  playQueueTrackAt = (index: number) => tabManager.getActivePlayer().playQueueTrackAt(index);
  moveQueueTrack = (
    sourceIndex: number,
    targetIndex: number,
    insertAfter: boolean,
  ) => tabManager.getActivePlayer().moveQueueTrack(sourceIndex, targetIndex, insertAfter);
  shuffleUpcomingQueue = () => tabManager.getActivePlayer().shuffleUpcomingQueue();
  shuffleEntirePlaylist = () => tabManager.getActivePlayer().shuffleEntirePlaylist();
  clearUpcomingQueue = () => tabManager.getActivePlayer().clearUpcomingQueue();
  addTracksToQueue = (tracks: Parameters<PlayerController["addTracksToQueue"]>[0]) =>
    tabManager.getActivePlayer().addTracksToQueue(tracks);
  setStopAfterQueueIndex = (index: number | null) =>
    tabManager.getActivePlayer().setStopAfterQueueIndex(index);
  generateQueueAfter = (index: number) =>
    tabManager.getActivePlayer().generateQueueAfter(index);
}

export const playerController: PlayerControllerActions = new ActivePlayerController();

/*
 * Hoisted, not inline.
 *
 * `useSyncExternalStore` treats a new `subscribe` identity as a new subscription: it tears
 * the old one down and re-establishes it in a layout effect. Written inline these were a
 * fresh closure on every render, so every consumer re-subscribed on every render for the
 * life of the app.
 */
const subscribeToPlayer = (listener: () => void) => tabManager.subscribe(listener);
const subscribeToLibrary = (listener: () => void) => libraryController.subscribe(listener);
const getPlayerState = () => tabManager.getActiveState();
const getPlayerSession = () => tabManager.getActiveSession();
const getLibraryState = () => libraryController.getState();

/** Re-exported so selector call sites need one import, not two. */
export { shallowEqual } from "../internal/shallowEqual";

/**
 * Subscribes to a slice of a store instead of the whole thing.
 *
 * The player state is one object, so subscribing to the whole thing re-renders on any change
 * to any field — dragging the volume slider used to re-render the entire application,
 * because the root subscribed to the same object as the volume control did.
 *
 * The cache is what makes an object-returning selector legal here: `useSyncExternalStore`
 * compares snapshots with `Object.is` and calls `getSnapshot` more than once per render, so
 * a selector building a fresh object every call would loop forever and warn. Holding the
 * previous value when the comparison says nothing changed is what keeps it stable.
 */
function useStoreSelector<S, T>(
  subscribe: (listener: () => void) => () => void,
  getState: () => S,
  select: (state: S) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  /* Both are read through refs because callers pass inline arrows: as dependencies they
     would change identity every render and defeat the memoisation they exist to provide. */
  const selectRef = useRef(select);
  selectRef.current = select;
  const isEqualRef = useRef(isEqual);
  isEqualRef.current = isEqual;
  const cacheRef = useRef<{ state: S; value: T } | null>(null);

  const getSnapshot = useCallback(() => {
    const state = getState();
    const cached = cacheRef.current;
    if (cached && Object.is(cached.state, state)) return cached.value;

    const next = selectRef.current(state);
    if (cached && isEqualRef.current(cached.value, next)) {
      // Same selection, new state object: keep the old reference so React sees no change.
      cacheRef.current = { state, value: cached.value };
      return cached.value;
    }
    cacheRef.current = { state, value: next };
    return next;
  }, [getState]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Prefer this over subscribing to the whole player state in anything that reads one or two
 * fields.
 *
 * Pass `shallowEqual` when the selector returns an object; the default `Object.is` is right
 * for the common case of selecting a single field or a derived boolean.
 */
export function usePlayerSelector<T>(
  select: (state: PlayerState) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  return useStoreSelector(subscribeToPlayer, getPlayerState, select, isEqual);
}

export function usePlayerSession() {
  return useSyncExternalStore(subscribeToPlayer, getPlayerSession, getPlayerSession);
}

/**
 * A slice of the session, cached the same way `usePlayerSelector` caches player state.
 *
 * `exportSession()` rebuilds the queue window with `.slice()` on every export — a fresh array
 * even when the tracks in it have not changed — and every player emit triggers one, including
 * ones with nothing to do with the queue (a volume drag fires dozens per gesture). Plain
 * `usePlayerSession` has no caching, so a component reading `.queue` off it recomputes and
 * re-renders on all of those. Route queue-only reads through here instead.
 */
export function usePlayerSessionSelector<T>(
  select: (session: PlayerSession | null) => T,
  isEqual?: (a: T, b: T) => boolean,
): T {
  return useStoreSelector(subscribeToPlayer, getPlayerSession, select, isEqual);
}

export function useLibraryState() {
  return useSyncExternalStore(subscribeToLibrary, getLibraryState, getLibraryState);
}
