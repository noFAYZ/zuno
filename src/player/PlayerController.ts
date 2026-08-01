import type { DataSource, StreamData } from "../datasource/DataSource";
import type { Lyrics, Track } from "../datasource/types";
import { logInternalDebug, logInternalError, logInternalInfo, logInternalWarn } from "../internal/logging";
import { AudioEngine } from "./AudioEngine";
import { Queue } from "./Queue";
import { recordPlay } from "./playHistory";
import { getOfflineTrack, isTrackDownloaded } from "./offlineStore";
import { DiscordRpcService } from "./DiscordRPC";
import {
  MAX_CROSSFADE_SEC,
  readPlaybackSettings,
  savePlaybackSettings,
  type PlaybackSettings,
} from "./playbackSettings";

/**
 * How the queue advances. Repeat only — shuffle is a separate, independent flag.
 *
 * They used to share one enum, which made them mutually exclusive: turning on repeat-all
 * silently restored the queue to its original order, so "shuffle this playlist on loop" — the
 * single most common combination — was unreachable.
 */
export type PlaybackOrderMode = "in-order" | "repeat-one" | "repeat-all";

/** How often playback position is checked for an upcoming transition. */
const TRANSITION_TICK_MS = 250;

/**
 * How early the next track is cued.
 *
 * Long enough to absorb a slow cue on a bad connection, short enough that skipping around does
 * not preload a string of tracks nobody reaches.
 */
const PRELOAD_LEAD_SEC = 20;

/**
 * How often a play in progress is reported to the provider's history.
 *
 * Matches what YouTube's own player does. The interval is the point, not the value: reported
 * watch time has to grow with real elapsed time or it is discarded — a single ping claiming a
 * whole track was heard is accepted and counted as nothing.
 */
const SCROBBLE_TICK_MS = 30_000;

export type PlayerStatus = "idle" | "loading" | "playing" | "paused" | "error";

export interface PlayerState {
  status: PlayerStatus;
  currentTrack: Track | null;
  history: Track[];
  error: string | null;
  playbackOrderMode: PlaybackOrderMode;
  /** Independent of playbackOrderMode: shuffle and repeat compose freely. */
  shuffleEnabled: boolean;
  volume: number;
  muted: boolean;
}

export interface PlayerSession {
  currentTrack: Track | null;
  history: Track[];
  queue: Track[];
  queueIndex: number;
  manualQueueLength?: number;
  /** Index into `queue` after which playback stops, or null. Deliberately not persisted. */
  stopAfterQueueIndex?: number | null;
  status: "playing" | "paused" | "idle";
  positionSec: number;
  volume: number;
  muted: boolean;
  autoplayEnabled: boolean;
  playbackOrderMode: PlaybackOrderMode;
  shuffleEnabled?: boolean;
  isPlaylistMode?: boolean;
}

type Listener = () => void;
const DISCORD_ASSET_URL_LIMIT = 256;
/** How long the sleep timer spends fading out before it pauses. */
const SLEEP_FADE_MS = 20_000;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return String(error);
}

/** A session saved before shuffle split out stored it as the order mode. */
function wasLegacyShuffleMode(mode: unknown): boolean {
  return mode === "shuffle";
}

function normalizePlaybackOrderMode(mode: unknown): PlaybackOrderMode {
  if (mode === "repeat-one") return "repeat-one";
  if (mode === "repeat-all") return "repeat-all";
  return "in-order";
}

function getYouTubeMusicTrackUrl(track: Track): string | undefined {
  if (track.source !== "youtube" || !track.id) return undefined;
  return `https://music.youtube.com/watch?v=${encodeURIComponent(track.id)}`;
}

function getYouTubeMusicArtistUrl(track: Track): string | undefined {
  if (track.source !== "youtube") return undefined;

  const artistId = track.artists?.find((artist) => artist.id)?.id;
  if (!artistId) return undefined;

  const encodedId = encodeURIComponent(artistId);
  return artistId.startsWith("UC")
    ? `https://music.youtube.com/channel/${encodedId}`
    : `https://music.youtube.com/browse/${encodedId}`;
}

function getYouTubeMusicAlbumUrl(track: Track): string | undefined {
  if (track.source !== "youtube" || !track.album) return undefined;

  const query = `${track.album} ${track.artist}`.trim();
  if (!query) return undefined;

  return `https://music.youtube.com/search?q=${encodeURIComponent(query)}`;
}

function getDiscordArtworkUrl(track: Track): string | undefined {
  // For YouTube tracks, always prefer the i.ytimg.com thumbnail URL since
  // Google CDN URLs (lh3.googleusercontent.com, yt3.ggpht.com) are frequently
  // blocked by Discord's image fetcher due to hotlink protection.
  if (track.source === "youtube" && /^[A-Za-z0-9_-]{11}$/.test(track.id)) {
    return `https://i.ytimg.com/vi/${track.id}/hqdefault.jpg`;
  }

  // For non-YouTube tracks, use the artwork URL directly if available and within limits
  if (track.artworkUrl && track.artworkUrl.length <= DISCORD_ASSET_URL_LIMIT) {
    return track.artworkUrl;
  }

  return track.artworkUrl;
}

/**
 * How many played tracks stay in memory, per tab.
 *
 * Everything past this was retained for nothing: `exportSession` persists the last 100, and the
 * deepest read is the last 20 (recommendation filtering). Uncapped it also meant copying the
 * whole array on every track change, so a long session got slower as well as larger. Double the
 * persisted count, so a restored session is never truncated by this.
 */
const MAX_PLAYBACK_HISTORY = 200;

export class PlayerController {
  private readonly audioEngine = new AudioEngine();
  private readonly queue = new Queue();
  private readonly listeners = new Set<Listener>();
  private readonly recommendationHistory = new Map<string, string[]>();
  private loadedTrackId: string | null = null;
  private isTabActive = false;
  private playTrackRequestId = 0;
  private autoplayEnabled = false;
  private handlingTrackEnd = false;
  private pendingSeekTime: number | null = null;
  private radioQueueRequestId = 0;
  /*
   * "End queue on this song": the queue entry after which playback stops.
   *
   * Held by reference, not by index or id. Indices shift on every removal and reorder, and an
   * id is ambiguous when the same song sits in the queue twice — but Queue splices the very
   * objects it was handed, so the reference stays pinned to the entry the user actually
   * clicked. It is dropped on restore, since JSON round-tripping breaks identity.
   */
  private stopAfterTrack: Track | null = null;
  /** Wall-clock ms at which the sleep timer fires, or null when it is off. */
  private sleepTimerDeadline: number | null = null;
  private sleepTimerId: number | null = null;
  /** Fade the last few seconds, so sleep does not end on an abrupt cut. */
  private sleepFadeId: number | null = null;
  private navigationRequest: Promise<void> = Promise.resolve();
  private playbackOrderMode: PlaybackOrderMode = "in-order";
  private shuffleEnabled = false;
  private isPlaylistMode = false;
  /** Audio resolved ahead of time for the next track, claimed by `ensureTrackLoaded`. */
  private warmedStream: { trackId: string; data: StreamData } | null = null;
  private warmingStream = false;
  private crossfadeSec = 0;
  private gaplessEnabled = true;
  private transitionTimerId: number | null = null;
  private scrobbleTimerId: number | null = null;
  private transitioning = false;

  private state: PlayerState = {
    status: "idle",
    currentTrack: null,
    history: [],
    error: null,
    playbackOrderMode: "in-order",
    shuffleEnabled: false,
    volume: 1,
    muted: false,
  };

  constructor(private readonly dataSource: DataSource) {
    this.applyPlaybackSettings(readPlaybackSettings(), false);
    this.audioEngine.setOnEnded(() => {
      void this.handleTrackEnded();
    });
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): PlayerState {
    return this.state;
  }

  exportSession(): PlayerSession {
    return {
      currentTrack: this.state.currentTrack,
      history: this.state.history.slice(-100),
      queue: [...this.queue.all],
      queueIndex: this.queue.currentIndex,
      manualQueueLength: this.queue.queuedManually,
      stopAfterQueueIndex: this.stopAfterTrack
        ? this.queue.all.indexOf(this.stopAfterTrack)
        : null,
      status: this.state.currentTrack
        ? (this.state.status === "playing" ? "playing" : "paused")
        : "idle",
      positionSec: this.loadedTrackId
        ? this.audioEngine.getCurrentTime()
        : (this.pendingSeekTime ?? 0),
      volume: this.audioEngine.getVolume(),
      muted: this.audioEngine.isMuted(),
      autoplayEnabled: this.autoplayEnabled,
      playbackOrderMode: this.playbackOrderMode,
      shuffleEnabled: this.shuffleEnabled,
      isPlaylistMode: this.isPlaylistMode,
    };
  }

  restoreSession(session: PlayerSession): void {
    this.playTrackRequestId += 1;
    const restoreRequestId = this.playTrackRequestId;
    this.audioEngine.stop();
    this.loadedTrackId = null;
    this.queue.set(
      [...session.queue],
      session.queueIndex,
      session.manualQueueLength ?? 0,
    );
    this.stopAfterTrack = null;
    this.autoplayEnabled = session.autoplayEnabled;
    this.pendingSeekTime = Math.max(0, session.positionSec);
    this.audioEngine.setVolume(session.volume);
    this.audioEngine.setMuted(session.muted);
    this.playbackOrderMode = normalizePlaybackOrderMode(session.playbackOrderMode);
    /*
     * A session written before the split stored shuffle as the order mode. Reading it back as
     * the flag keeps the setting the user chose instead of silently turning shuffle off on the
     * first launch after an update.
     */
    this.shuffleEnabled =
      session.shuffleEnabled ?? wasLegacyShuffleMode(session.playbackOrderMode);
    this.isPlaylistMode = session.isPlaylistMode ?? false;
    this.state = {
      status: session.currentTrack ? session.status : "idle",
      currentTrack: session.currentTrack,
      history: session.history,
      error: null,
      playbackOrderMode: this.playbackOrderMode,
      shuffleEnabled: this.shuffleEnabled,
      volume: this.audioEngine.getVolume(),
      muted: this.audioEngine.isMuted(),
    };
    this.emit();
    if (session.currentTrack) {
      void this.refreshRestoredTrackMetadata(session.currentTrack, restoreRequestId);
    }
  }

  applyPlaybackSettings(settings: PlaybackSettings, persist = true): void {
    this.audioEngine.setVolume(settings.volume);
    this.audioEngine.setMuted(settings.muted);
    if (settings.playbackRate !== undefined) {
      this.audioEngine.setPlaybackRate(settings.playbackRate);
    }
    /*
     * Absent means "leave alone", not "reset".
     *
     * Callers pass partial settings — the volume slider sends only volume and mute — so
     * defaulting the missing fields here would silently turn crossfading off every time
     * somebody touched the volume.
     */
    if (settings.crossfadeSec !== undefined) {
      this.crossfadeSec = Math.min(MAX_CROSSFADE_SEC, Math.max(0, settings.crossfadeSec));
    }
    if (settings.gaplessEnabled !== undefined) {
      this.gaplessEnabled = settings.gaplessEnabled;
    }
    this.state = {
      ...this.state,
      volume: this.audioEngine.getVolume(),
      muted: this.audioEngine.isMuted(),
    };
    if (persist) {
      savePlaybackSettings({
        volume: this.state.volume,
        muted: this.state.muted,
        // Read back off the engine rather than off `settings`: a partial apply would otherwise
        // persist a default over a value the user had chosen.
        playbackRate: this.audioEngine.getPlaybackRate(),
        crossfadeSec: this.crossfadeSec,
        gaplessEnabled: this.gaplessEnabled,
      });
    }
    this.syncTransitionTicker();
  }

  async loadTrack(track: Track): Promise<void> {
    logInternalInfo("PlayerController.loadTrack start", { trackId: track.id });
    this.pendingSeekTime = null;
    this.setState({ status: "loading", error: null });
    try {
      this.loadedTrackId = null;
      this.setState({
        currentTrack: track,
        history: this.appendHistory(track),
        status: "paused",
        error: null,
      });
      logInternalInfo("PlayerController.loadTrack success", {
        trackId: track.id,
        title: track.title,
      });
    } catch (error) {
      this.setError(error);
    }
  }

  async playTrackById(
    videoId: string,
    playbackQueue?: readonly Track[],
    autoplayWhenQueueEnds = false,
  ): Promise<boolean> {
    // Close out whatever was playing first: this is the funnel every track change goes
    // through, so it catches a natural end and a skip with the same one call.
    this.finishPlayReport();
    const requestId = ++this.playTrackRequestId;
    logInternalInfo("PlayerController.playTrackById start", { videoId });
    /*
     * Stopping tears down the standby deck along with everything else, which would throw away
     * the very thing that makes the next track start instantly. When the track being asked for
     * is the one already cued, the transition in ensureTrackLoaded takes over the handover.
     */
    if (!this.audioEngine.hasPreloaded(videoId)) {
      this.audioEngine.stop();
      this.audioEngine.silenceCompetingPlayback();
    }
    this.loadedTrackId = null;
    this.pendingSeekTime = null;
    this.setState({ status: "loading", error: null });
    try {
      if (playbackQueue?.length) {
        const startIndex = playbackQueue.findIndex((track) => track.id === videoId);
        this.queue.set([...playbackQueue], startIndex >= 0 ? startIndex : 0);
        this.autoplayEnabled = autoplayWhenQueueEnds;
        this.isPlaylistMode = !autoplayWhenQueueEnds && playbackQueue.length > 1;
        if (this.isPlaylistMode) {
          this.queue.setSourceTracks([...playbackQueue]);
        }
      }

      const queuedTrack = playbackQueue?.find((item) => item.id === videoId)
        ?? this.queue.all.find((item) => item.id === videoId);
      /*
       * Metadata is a refresh, not a prerequisite.
       *
       * This used to await getTrack unconditionally for anything non-local, so with no
       * network every play failed here — including downloaded songs whose audio was sitting
       * on disk and whose title and artist were already in the offline manifest. Whenever a
       * track is already known, a failed lookup falls back to what we have instead of
       * abandoning playback.
       */
      const knownTrack = queuedTrack ?? getOfflineTrack(videoId);
      let fetchedTrack: Track;
      if (queuedTrack?.source === "local") {
        fetchedTrack = queuedTrack;
      } else {
        try {
          fetchedTrack = await this.dataSource.getTrack(videoId);
        } catch (error) {
          if (!knownTrack) throw error;
          logInternalWarn("PlayerController.playTrackById metadata unavailable", {
            videoId,
            error: error instanceof Error ? error.message : String(error),
          });
          fetchedTrack = knownTrack;
        }
      }
      if (requestId !== this.playTrackRequestId) return false;
      const track = queuedTrack
        ? {
            ...fetchedTrack,
            ...queuedTrack,
            durationSec: fetchedTrack.durationSec ?? queuedTrack.durationSec,
            artworkUrl: queuedTrack.artworkUrl ?? fetchedTrack.artworkUrl,
            artists: queuedTrack.artists ?? fetchedTrack.artists,
          }
        : fetchedTrack;

      this.loadedTrackId = null;
      this.setState({
        currentTrack: track,
        history: this.appendHistory(track),
        status: "loading",
        error: null,
        playbackOrderMode: this.playbackOrderMode,
        shuffleEnabled: this.shuffleEnabled,
      });
      if (autoplayWhenQueueEnds && playbackQueue?.length === 1) {
        void this.primeRadioQueue(track, requestId);
      }
      await this.ensureTrackLoaded(track);
      if (requestId !== this.playTrackRequestId) return false;

      if (this.isTabActive) {
        const playbackStarted = await this.playLoadedTrack();
        if (!playbackStarted) return false;
      }
      if (requestId !== this.playTrackRequestId) return false;

      this.setState({ status: "playing", error: null });
      logInternalInfo("PlayerController.playTrackById success", {
        trackId: track.id,
        title: track.title,
      });
      return true;
    } catch (error) {
      if (requestId !== this.playTrackRequestId) return false;
      this.setError(error);
      return false;
    }
  }

  async play(): Promise<void> {
    logInternalInfo("PlayerController.play start", {
      currentStatus: this.state.status,
      currentTrackId: this.state.currentTrack?.id ?? null,
    });
    try {
      let track = this.state.currentTrack;
      if (!track) {
        logInternalWarn("PlayerController.play no current track, loading fallback");

        if (this.loadedTrackId && this.loadedTrackId) {
          // Try to reload the last played track
          track = await this.dataSource.getTrack(this.loadedTrackId);
          this.setState({ currentTrack: track, status: "paused", error: null });
        }
      }

      if (!track) {
        throw new Error("No track available to play.");
      }

      const isResumingLoadedTrack = this.loadedTrackId === track.id;
      if (!isResumingLoadedTrack || this.state.status === "error") {
        this.setState({ status: "loading", error: null });
      }

      await this.ensureTrackLoaded(track);
      if (this.isTabActive) {
        const playbackStarted = this.playLoadedTrack();
        if (isResumingLoadedTrack) {
          this.setState({ status: "playing", error: null });
        }
        if (!await playbackStarted) {
          this.setState({ status: "paused", error: null });
          return;
        }
        if (!isResumingLoadedTrack) {
          this.setState({ status: "playing", error: null });
        }
      } else {
        this.setState({ status: "paused", error: null });
      }

      logInternalInfo("PlayerController.play success", { trackId: track.id });
    } catch (error) {
      this.setError(error);
    }
  }

  async pause(): Promise<void> {
    logInternalInfo("PlayerController.pause start", {
      currentStatus: this.state.status,
      currentTrackId: this.state.currentTrack?.id ?? null,
    });
    try {
      this.audioEngine.pause();
      this.setState({ status: "paused", error: null });
      logInternalInfo("PlayerController.pause success");
    } catch (error) {
      this.setError(error);
    }
  }

  async togglePlayPause(): Promise<void> {
    logInternalDebug("PlayerController.togglePlayPause", { currentStatus: this.state.status });
    if (this.state.status === "playing") {
      await this.pause();
      return;
    }

    await this.play();
  }

  async skipToNext(): Promise<void> {
    this.cancelLoadingPlayback();
    return this.queueNavigation(() => this.skipToNextNow());
  }

  getPlaybackOrderMode(): PlaybackOrderMode {
    return this.playbackOrderMode;
  }

  setPlaybackOrderMode(mode: PlaybackOrderMode): void {
    this.playbackOrderMode = mode;
    this.setState({ playbackOrderMode: mode });
  }

  isShuffleEnabled(): boolean {
    return this.shuffleEnabled;
  }

  /**
   * Turns shuffle on or off, reordering what has not played yet.
   *
   * Only the *remaining* queue is touched — history stays as it happened, and hand-queued
   * tracks keep their position, because someone who explicitly said "play this next" did not
   * ask for it to be moved. Turning shuffle off restores the collection's original order rather
   * than leaving the shuffled arrangement frozen in place.
   */
  setShuffleEnabled(enabled: boolean): void {
    if (this.shuffleEnabled === enabled) return;
    this.shuffleEnabled = enabled;

    if (this.isPlaylistMode) {
      if (enabled) this.queue.shuffleRemaining(this.queue.queuedManually);
      else this.queue.restoreOriginalOrder(this.queue.queuedManually);
    }

    logInternalInfo("PlayerController.setShuffleEnabled", {
      enabled,
      isPlaylistMode: this.isPlaylistMode,
    });
    this.setState({ shuffleEnabled: enabled });
  }

  toggleShuffle(): void {
    this.setShuffleEnabled(!this.shuffleEnabled);
  }

  /**
   * Walks the repeat states: off → all → one → off.
   *
   * Three states in a fixed cycle, the convention every player shares, and short enough that
   * you can get back to where you were without wondering how many presses are left. Shuffle is
   * no longer in this loop — it has its own button and composes with any of these.
   */
  cyclePlaybackOrderMode(): void {
    const nextMode: PlaybackOrderMode = this.playbackOrderMode === "in-order"
      ? "repeat-all"
      : this.playbackOrderMode === "repeat-all"
        ? "repeat-one"
        : "in-order";
    this.setPlaybackOrderMode(nextMode);
  }

  addToQueue(track: Track): void {
    this.queue.add(track);
    this.emit();
    logInternalInfo("PlayerController.addToQueue", {
      trackId: track.id,
      title: track.title,
    });
  }

  playNext(track: Track): void {
    this.queue.playNext(track);
    this.emit();
    logInternalInfo("PlayerController.playNext", {
      trackId: track.id,
      title: track.title,
    });
  }

  removeFromQueueAt(index: number): void {
    this.queue.removeAt(index);
    this.emit();
    logInternalInfo("PlayerController.removeFromQueueAt", { index });
  }

  async playQueueTrackAt(index: number): Promise<boolean> {
    const track = this.queue.select(index);
    if (!track) return false;
    this.emit();
    return this.playTrackById(track.id);
  }

  setPlaybackRate(rate: number): void {
    this.audioEngine.setPlaybackRate(rate);
    savePlaybackSettings({
      volume: this.state.volume,
      muted: this.state.muted,
      playbackRate: this.audioEngine.getPlaybackRate(),
    });
    this.emit();
  }

  getPlaybackRate(): number {
    return this.audioEngine.getPlaybackRate();
  }

  /**
   * Pauses playback after `minutes`, or cancels a running timer when passed null.
   *
   * The last stretch fades the volume down rather than cutting out mid-bar, and the volume is
   * restored afterwards so the next session does not start silent — the usual way a naive
   * sleep timer ruins the following morning.
   */
  setSleepTimer(minutes: number | null): void {
    this.clearSleepTimer();
    if (minutes === null || minutes <= 0) {
      this.emit();
      return;
    }

    const durationMs = minutes * 60_000;
    this.sleepTimerDeadline = Date.now() + durationMs;
    const restoreVolume = this.audioEngine.getVolume();

    if (durationMs > SLEEP_FADE_MS) {
      this.sleepFadeId = globalThis.setTimeout(() => {
        const startedAt = Date.now();
        const step = () => {
          const progress = Math.min(1, (Date.now() - startedAt) / SLEEP_FADE_MS);
          this.audioEngine.setVolume(restoreVolume * (1 - progress));
          if (progress < 1) this.sleepFadeId = globalThis.setTimeout(step, 250);
        };
        step();
      }, durationMs - SLEEP_FADE_MS) as unknown as number;
    }

    this.sleepTimerId = globalThis.setTimeout(() => {
      this.pause();
      this.audioEngine.setVolume(restoreVolume);
      this.clearSleepTimer();
      logInternalInfo("PlayerController.sleepTimer fired");
      this.emit();
    }, durationMs) as unknown as number;

    logInternalInfo("PlayerController.setSleepTimer", { minutes });
    this.emit();
  }

  /** Remaining milliseconds, or null when no timer is running. */
  getSleepTimerRemainingMs(): number | null {
    if (this.sleepTimerDeadline === null) return null;
    return Math.max(0, this.sleepTimerDeadline - Date.now());
  }

  private clearSleepTimer(): void {
    if (this.sleepTimerId !== null) globalThis.clearTimeout(this.sleepTimerId);
    if (this.sleepFadeId !== null) globalThis.clearTimeout(this.sleepFadeId);
    this.sleepTimerId = null;
    this.sleepFadeId = null;
    this.sleepTimerDeadline = null;
  }

  /** Queues a whole album or playlist behind whatever is already hand-picked. */
  addTracksToQueue(tracks: Track[]): void {
    if (tracks.length === 0) return;
    this.queue.addMany(tracks);
    this.emit();
    logInternalInfo("PlayerController.addTracksToQueue", { count: tracks.length });
  }

  /** Pass null to clear. Playback stops once the track at `index` finishes. */
  setStopAfterQueueIndex(index: number | null): void {
    const next = index === null ? null : this.queue.all[index] ?? null;
    // Clicking the marked song again clears it, so one control both sets and unsets.
    this.stopAfterTrack = next === this.stopAfterTrack ? null : next;
    this.emit();
    logInternalInfo("PlayerController.setStopAfterQueueIndex", {
      index,
      armed: Boolean(this.stopAfterTrack),
    });
  }

  /** Replaces everything after this queue entry with a station seeded from it. */
  async generateQueueAfter(index: number): Promise<boolean> {
    const seed = this.queue.all[index];
    if (!seed || !this.dataSource.getRecommendations) return false;

    const recommendations = await this.getVariedRecommendations(seed);
    if (recommendations.length === 0) return false;

    this.queue.replaceAfter(index, recommendations);
    // The queue is no longer "this playlist, in order", so the end-of-playlist handoff to
    // recommendations no longer applies — this *is* that handoff.
    this.isPlaylistMode = false;
    this.autoplayEnabled = true;
    this.emit();
    logInternalInfo("PlayerController.generateQueueAfter", {
      seedTrackId: seed.id,
      count: recommendations.length,
    });
    return true;
  }

  /** Shuffles only the automatic tail; hand-picked "play next" entries keep their order. */
  shuffleUpcomingQueue(): void {
    this.queue.shuffleRemaining(this.queue.queuedManually);
    this.emit();
    logInternalInfo("PlayerController.shuffleUpcomingQueue");
  }

  clearUpcomingQueue(): void {
    this.queue.clearUpcoming();
    this.emit();
    logInternalInfo("PlayerController.clearUpcomingQueue");
  }

  moveQueueTrack(sourceIndex: number, targetIndex: number, insertAfter: boolean): void {
    this.queue.move(sourceIndex, targetIndex, insertAfter);
    this.emit();
    logInternalInfo("PlayerController.moveQueueTrack", {
      sourceIndex,
      targetIndex,
      insertAfter,
    });
  }

  private async skipToNextNow(): Promise<void> {
    const shouldResume = this.shouldResumeAfterNavigation();
    const nextTrack = this.queue.next(false);
    if (
      (!nextTrack || nextTrack.id === this.state.currentTrack?.id)
      && this.state.currentTrack
    ) {
      const queueEndTrack = await this.loadQueueEndRecommendations(this.state.currentTrack);
      if (queueEndTrack) {
        if (shouldResume) {
          await this.playTrackById(queueEndTrack.id);
        } else {
          await this.loadTrack(queueEndTrack);
        }
      }
      if (queueEndTrack || !this.autoplayEnabled) return;
    }
    if (
      (!nextTrack || nextTrack.id === this.state.currentTrack?.id)
      && this.autoplayEnabled
      && this.state.currentTrack
    ) {
      const radioTrack = await this.loadRadioQueue(this.state.currentTrack);
      if (radioTrack) {
        if (shouldResume) {
          await this.playTrackById(radioTrack.id);
        } else {
          await this.loadTrack(radioTrack);
        }
      }
      return;
    }
    logInternalInfo("PlayerController.skipToNext", {
      currentTrackId: this.state.currentTrack?.id ?? null,
      nextTrackId: nextTrack?.id ?? null,
    });
    if (!nextTrack || nextTrack.id === this.state.currentTrack?.id) return;
    this.refillAutomaticQueue();
    if (shouldResume) {
      await this.playTrackById(nextTrack.id);
    } else {
      await this.loadTrack(nextTrack);
    }
  }

  private async handleTrackEnded(): Promise<void> {
    if (this.handlingTrackEnd || !this.isTabActive) return;
    this.handlingTrackEnd = true;

    try {
      if (this.playbackOrderMode === "repeat-one" && this.state.currentTrack) {
        await this.playTrackById(this.state.currentTrack.id);
        return;
      }

      // Checked before the queue advances, so `current` is still the track that just ended.
      // The marker is one-shot: stopping is what it was for, and leaving it armed would stop
      // playback again the next time this entry came round.
      if (this.stopAfterTrack && this.queue.current === this.stopAfterTrack) {
        logInternalInfo("PlayerController.stopAfterTrack reached", {
          trackId: this.stopAfterTrack.id,
        });
        this.stopAfterTrack = null;
        this.setState({ status: "paused" });
        return;
      }

      const nextTrack = this.queue.next(false);

      if (nextTrack && nextTrack.id !== this.state.currentTrack?.id) {
        this.refillAutomaticQueue();
        await this.playTrackById(nextTrack.id);
        return;
      }

      /*
       * Looping is decided here rather than by passing `wrap` to Queue.next, because it only
       * applies at the *end* of the collection — everywhere else next() already advances
       * normally. Without this the queue falls through to recommendations and the album
       * quietly turns into a radio station.
       */
      if (this.playbackOrderMode === "repeat-all" && this.queue.all.length > 0) {
        /*
         * Reshuffled on each lap when shuffle is on. Looping a shuffled queue back to index 0
         * would otherwise replay the same "random" order forever, which is the one thing a
         * listener notices immediately and reads as shuffle being broken.
         */
        if (this.shuffleEnabled && this.isPlaylistMode) {
          this.queue.select(0);
          this.queue.shuffleRemaining(this.queue.queuedManually);
        }

        const firstTrack = this.queue.select(0);
        if (firstTrack) {
          logInternalInfo("PlayerController.handleTrackEnded looping queue", {
            trackCount: this.queue.all.length,
            reshuffled: this.shuffleEnabled && this.isPlaylistMode,
          });
          await this.playTrackById(firstTrack.id);
          return;
        }
      }

      const seed = this.state.currentTrack;
      if (seed) {
        const queueEndTrack = await this.loadQueueEndRecommendations(seed);
        if (queueEndTrack) {
          await this.playTrackById(queueEndTrack.id);
          return;
        }
      }

      if (!this.autoplayEnabled || !seed || !this.dataSource.getRecommendations) {
        this.setState({ status: "paused" });
        return;
      }

      const recommendations = await this.getVariedRecommendations(seed);
      if (recommendations.length === 0) {
        this.setState({ status: "paused" });
        return;
      }

      this.queue.set(recommendations, 0);
      await this.playTrackById(recommendations[0].id);
    } catch (error) {
      this.setError(error);
    } finally {
      this.handlingTrackEnd = false;
    }
  }

  private refillAutomaticQueue(): void {
    if (this.queue.remainingAutomatic >= 10) return;

    if (this.isPlaylistMode) {
      return;
    }

    if (this.autoplayEnabled && this.state.currentTrack) {
      void this.primeRadioQueue(this.state.currentTrack, this.playTrackRequestId);
    }
  }

  private async loadQueueEndRecommendations(seed: Track): Promise<Track | null> {
    if (!this.isPlaylistMode || !this.dataSource.getRecommendations) return null;

    let recommendations: Track[];
    try {
      recommendations = await this.getVariedRecommendations(seed);
    } catch (error) {
      logInternalWarn("PlayerController.loadQueueEndRecommendations failed", {
        seedTrackId: seed.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    if (recommendations.length === 0) return null;

    this.isPlaylistMode = false;
    this.autoplayEnabled = true;
    this.queue.set(recommendations, 0);
    logInternalInfo("PlayerController.loadQueueEndRecommendations", {
      seedTrackId: seed.id,
      nextTrackId: recommendations[0].id,
      recommendationCount: recommendations.length,
    });
    return recommendations[0];
  }

  private async getVariedRecommendations(seed: Track): Promise<Track[]> {
    const recommendations = await this.dataSource.getRecommendations?.(seed) ?? [];
    const recentlySuggested = new Set(this.recommendationHistory.get(seed.id) ?? []);
    const recentlyPlayed = new Set(this.state.history.slice(-20).map((track) => track.id));
    const fresh = recommendations.filter(
      (track) => !recentlySuggested.has(track.id) && !recentlyPlayed.has(track.id),
    );
    const candidates = fresh.length >= 3
      ? fresh
      : recommendations.filter((track) => !recentlyPlayed.has(track.id));
    const shuffled = this.shuffle(candidates);
    const selected = shuffled.slice(0, 25);

    this.recommendationHistory.set(
      seed.id,
      [...selected.map((track) => track.id), ...recentlySuggested].slice(0, 50),
    );
    return selected;
  }

  private async primeRadioQueue(seed: Track, playRequestId: number): Promise<void> {
    const requestId = ++this.radioQueueRequestId;
    let recommendations: Track[];
    try {
      recommendations = await this.getVariedRecommendations(seed);
    } catch (error) {
      logInternalWarn("PlayerController.primeRadioQueue failed", {
        seedTrackId: seed.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (
      requestId !== this.radioQueueRequestId
      || playRequestId !== this.playTrackRequestId
      || this.state.currentTrack?.id !== seed.id
      || recommendations.length === 0
    ) {
      return;
    }

    this.queue.replaceAutomaticUpcoming(recommendations);
  }

  private async refreshRestoredTrackMetadata(track: Track, restoreRequestId: number): Promise<void> {
    let freshTrack: Track;
    try {
      freshTrack = await this.dataSource.getTrack(track.id);
    } catch (error) {
      logInternalWarn("PlayerController.refreshRestoredTrackMetadata failed", {
        trackId: track.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (
      restoreRequestId !== this.playTrackRequestId
      || this.state.currentTrack?.id !== track.id
    ) {
      return;
    }

    const currentTrack = this.state.currentTrack;
    const refreshedTrack: Track = {
      ...freshTrack,
      ...currentTrack,
      durationSec: freshTrack.durationSec ?? currentTrack.durationSec,
      artworkUrl: freshTrack.artworkUrl ?? currentTrack.artworkUrl,
      artists: freshTrack.artists ?? currentTrack.artists,
    };

    if (
      refreshedTrack.artworkUrl === currentTrack.artworkUrl
      && refreshedTrack.durationSec === currentTrack.durationSec
      && refreshedTrack.artists === currentTrack.artists
    ) {
      return;
    }

    this.setState({ currentTrack: refreshedTrack });
  }

  private async loadRadioQueue(seed: Track): Promise<Track | null> {
    const requestId = ++this.radioQueueRequestId;
    let recommendations: Track[];
    try {
      recommendations = await this.getVariedRecommendations(seed);
    } catch (error) {
      logInternalWarn("PlayerController.loadRadioQueue failed", {
        seedTrackId: seed.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    if (
      requestId !== this.radioQueueRequestId
      || this.state.currentTrack?.id !== seed.id
      || recommendations.length === 0
    ) {
      return null;
    }

    this.queue.set([seed, ...recommendations], 0);
    return this.queue.next(false);
  }

  private shuffle(tracks: Track[]): Track[] {
    const shuffled = [...tracks];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
    }
    return shuffled;
  }

  private async ensureTrackLoaded(track: Track): Promise<void> {
    logInternalDebug("PlayerController.ensureTrackLoaded start", {
      trackId: track.id,
      loadedTrackId: this.loadedTrackId,
    });
    
    if (this.loadedTrackId === track.id) {
      logInternalDebug("PlayerController.ensureTrackLoaded already loaded", {
        trackId: track.id,
      });
      return;
    }

    try {
      const startedAt = performance.now();
      /*
       * The next track was cued on the standby deck while this one was still playing, so the
       * handover is a volume ramp between two live players — no load, and no silence between
       * them. A zero-length fade is the gapless case and swaps in the same tick.
       */
      if (this.usesIframePlayback(track) && this.audioEngine.hasPreloaded(track.id)) {
        const swapped = await this.audioEngine.transitionToPreloaded(
          track.id,
          this.crossfadeSec * 1000,
        );
        if (swapped) {
          this.loadedTrackId = track.id;
          this.pendingSeekTime = null;
          logInternalInfo("PlayerController.ensureTrackLoaded preloaded deck", {
            trackId: track.id,
            crossfadeSec: this.crossfadeSec,
            durationMs: Math.round(performance.now() - startedAt),
          });
          return;
        }
      }

      if (track.source === "local") {
        const audioData = await this.dataSource.getStreamData?.(track);
        if (!audioData) {
          throw new Error("The data source does not support local audio playback.");
        }
        await this.audioEngine.loadNativeFallback(
          track.id,
          audioData.bytes,
          audioData.mimeType,
          audioData.sourceUrl,
        );
        this.loadedTrackId = track.id;
        if (this.pendingSeekTime !== null) {
          this.audioEngine.seekTo(this.pendingSeekTime);
          this.pendingSeekTime = null;
        }
        logInternalInfo("PlayerController.ensureTrackLoaded local success", {
          trackId: track.id,
          durationMs: Math.round(performance.now() - startedAt),
        });
        return;
      }
      /*
       * A downloaded track always takes the native path.
       *
       * shouldUseNativeAudio() is false everywhere because the *download* path can answer 403
       * for remote streams — but a file already on disk has no download and no 403 to hit.
       * Without this the iframe player is used for every YouTube track, which needs the
       * network, so downloads were unplayable offline and getStreamData's offline branch was
       * never reached at all.
       */
      const isDownloaded = isTrackDownloaded(track.id);
      const useNativeAudio = this.audioEngine.usesNativeAudio() || isDownloaded;
      /*
       * A warmed track skips the whole resolve-and-download round trip, which is the entire
       * wait a listener feels when they press next. Claimed rather than read: it is one slot,
       * and holding it after use would keep a stale URL alive for a track already playing.
       */
      const warmed = this.claimWarmedStream(track.id);
      const audioData = useNativeAudio
        ? warmed ?? await this.dataSource.getStreamData?.(track)
        : undefined;
      if (useNativeAudio && !audioData) {
        throw new Error("The data source does not support native audio playback.");
      }

      if (isDownloaded && audioData) {
        await this.audioEngine.loadNativeFallback(
          track.id,
          audioData.bytes,
          audioData.mimeType,
          audioData.sourceUrl,
        );
      } else {
        await this.audioEngine.loadTrack(
          track.id,
          audioData?.bytes,
          audioData?.mimeType,
          audioData?.sourceUrl,
        );
      }

      this.loadedTrackId = track.id;
      if (this.pendingSeekTime !== null) {
        this.audioEngine.seekTo(this.pendingSeekTime);
        this.pendingSeekTime = null;
      }
      logInternalInfo("PlayerController.ensureTrackLoaded success", {
        trackId: track.id,
        durationMs: Math.round(performance.now() - startedAt),
        warmed: Boolean(warmed),
      });
      // Start on the next one immediately rather than near the end of this track: a skip lands
      // whenever the listener decides it does, not only in the last few seconds.
      this.warmNextTrack();
      this.beginPlayReport(track);
    } catch (error) {
      logInternalError("PlayerController.ensureTrackLoaded failed", error, {
        trackId: track.id,
      });
      const detail = getErrorMessage(error);
      if (track.source === "local" || this.audioEngine.usesNativeAudio()) {
        throw new Error(`Unable to load audio data for playback. ${detail}`);
      }
      throw new Error(`Unable to load YouTube player for playback. ${detail}`);
    }
  }

  private async playLoadedTrack(): Promise<boolean> {
    return this.audioEngine.play();
  }

  private setState(partial: Partial<PlayerState>) {
    logInternalDebug("PlayerController.setState", {
      previousStatus: this.state.status,
      nextStatus: partial.status ?? this.state.status,
      hasError: Boolean(partial.error),
      trackId: partial.currentTrack?.id ?? this.state.currentTrack?.id ?? null,
    });
    this.state = { ...this.state, ...partial };
    this.syncTransitionTicker();
    this.syncScrobbleTicker();
    this.emit();
  }

  /**
   * The next track, only when it is knowable without asking the network.
   *
   * Radio continuations and queue-end recommendations are deliberately excluded: they are
   * fetched at the moment the queue runs out, so there is nothing to preload and nothing to
   * crossfade into. Repeat-one is excluded because the "next" track is the current one, and
   * handing the deck to itself is not a transition.
   */
  private peekNextTrack(): Track | null {
    if (this.playbackOrderMode === "repeat-one") return null;

    const next = this.queue.all[this.queue.currentIndex + 1] ?? null;
    if (!next || next.id === this.state.currentTrack?.id) return null;
    return next;
  }

  /**
   * Warms whatever the next track will need: its metadata always, its audio on the native engine.
   *
   * The native engine has no standby deck, so without this every skip pays for a PO token, an
   * InnerTube `player` call and a whole-file download before the first sample — seconds of
   * silence after a button press. One slot is enough: it is only ever the track after the one
   * playing, and the media server holds three.
   *
   * Failures are swallowed on purpose. This is an optimisation; if it does not land,
   * `ensureTrackLoaded` fetches normally and the listener waits exactly as long as before.
   */
  private warmNextTrack(): void {
    const next = this.peekNextTrack();
    if (!next) return;

    /*
     * Metadata first, and for both engines.
     *
     * `playTrackById` awaits `getTrack` before it reaches the audio at all, so a cache miss
     * there is a wait no amount of warmed audio can hide — it was 775ms of a 918ms skip, with
     * the bytes already sitting ready. `getTrack` is stale-while-revalidate, so this only ever
     * costs the one request the skip would have made anyway, moved earlier.
     */
    if (next.source === "youtube") {
      void this.dataSource.getTrack(next.id).catch(() => {
        // Best effort. `playTrackById` still fetches it for real, and reports its own failure.
      });
    }

    if (!this.audioEngine.usesNativeAudio()) return;
    if (!this.dataSource.getStreamData) return;
    if (this.warmingStream) return;
    // Local files and downloads are read from disk; there is no network wait to hide.
    if (next.source === "local" || isTrackDownloaded(next.id)) return;
    if (this.warmedStream?.trackId === next.id) return;

    const getStreamData = this.dataSource.getStreamData.bind(this.dataSource);
    this.warmingStream = true;
    void getStreamData(next)
      .then((data) => {
        this.warmedStream = { trackId: next.id, data };
        logInternalDebug("PlayerController.warmNextTrack audio ready", { trackId: next.id });
      })
      .catch((error) => {
        logInternalWarn("PlayerController.warmNextTrack audio failed", {
          trackId: next.id,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.warmingStream = false;
      });
  }

  /** Takes the warmed stream if it is for this track, and empties the slot either way. */
  private claimWarmedStream(trackId: string): StreamData | undefined {
    const warmed = this.warmedStream;
    this.warmedStream = null;
    return warmed?.trackId === trackId ? warmed.data : undefined;
  }

  /**
   * Whether a track plays through the IFrame deck rather than an audio element.
   *
   * Only the IFrame path has a deck to preload. Offline and local files are read from disk
   * with no load gap worth hiding, and handing one of those to the standby deck would play the
   * streamed version of a track the user downloaded on purpose.
   */
  private usesIframePlayback(track: Track): boolean {
    return track.source !== "local"
      && !isTrackDownloaded(track.id)
      && !this.audioEngine.usesNativeAudio();
  }

  /**
   * Starts reporting a play, when the provider and the engine both allow it.
   *
   * Gated on native playback because the IFrame embed reports its own plays — pinging as well
   * would count every track twice. Local files have no provider history to report to.
   */
  private beginPlayReport(track: Track): void {
    if (!this.audioEngine.usesNativeAudio() || track.source === "local") return;
    void this.dataSource.beginPlayReport?.(track);
  }

  /** Reports the final position of the outgoing play, if one is open. */
  private finishPlayReport(): void {
    const track = this.state.currentTrack;
    if (!track) return;
    void this.dataSource.updatePlayReport?.(track, this.audioEngine.getCurrentTime(), true);
  }

  private syncScrobbleTicker(): void {
    const wanted = this.state.status === "playing"
      && this.isTabActive
      && this.audioEngine.usesNativeAudio();

    if (wanted === (this.scrobbleTimerId !== null)) return;

    if (!wanted) {
      if (this.scrobbleTimerId !== null) globalThis.clearInterval(this.scrobbleTimerId);
      this.scrobbleTimerId = null;
      return;
    }

    this.scrobbleTimerId = globalThis.setInterval(() => {
      const track = this.state.currentTrack;
      if (!track || this.state.status !== "playing") return;
      void this.dataSource.updatePlayReport?.(track, this.audioEngine.getCurrentTime(), false);
    }, SCROBBLE_TICK_MS);
  }

  private syncTransitionTicker(): void {
    const wanted = this.state.status === "playing"
      && this.isTabActive
      && (this.gaplessEnabled || this.crossfadeSec > 0);

    if (wanted === (this.transitionTimerId !== null)) return;

    if (!wanted) {
      if (this.transitionTimerId !== null) globalThis.clearInterval(this.transitionTimerId);
      this.transitionTimerId = null;
      return;
    }
    this.transitionTimerId = globalThis.setInterval(
      () => this.onTransitionTick(),
      TRANSITION_TICK_MS,
    );
  }

  /**
   * Preloads the next track, and starts the crossfade when one is configured.
   *
   * Gapless needs no trigger of its own: the track is allowed to end normally and
   * ensureTrackLoaded finds the deck already cued, so nothing of the outro is lost. Crossfade
   * is the only case that has to interrupt, because overlapping two tracks means starting the
   * second one before the first has finished.
   */
  private onTransitionTick(): void {
    if (this.transitioning || this.state.status !== "playing" || !this.isTabActive) return;

    const duration = this.audioEngine.getDuration();
    const remaining = duration - this.audioEngine.getCurrentTime();
    if (!(duration > 0) || !Number.isFinite(remaining) || remaining <= 0) return;

    const next = this.peekNextTrack();
    if (!next || !this.usesIframePlayback(next)) return;

    if (remaining <= PRELOAD_LEAD_SEC) this.audioEngine.preloadNext(next.id);

    if (this.crossfadeSec <= 0 || remaining > this.crossfadeSec) return;
    if (!this.audioEngine.hasPreloaded(next.id)) return;

    logInternalInfo("PlayerController.crossfade starting", {
      fromTrackId: this.state.currentTrack?.id ?? null,
      toTrackId: next.id,
      crossfadeSec: this.crossfadeSec,
    });
    this.transitioning = true;
    void this.handleTrackEnded().finally(() => {
      this.transitioning = false;
    });
  }

  private appendHistory(track: Track): Track[] {
    // The timestamped log is what the History page reads; this array stays untouched because
    // skip-back and recommendation filtering both walk it.
    recordPlay(track);

    if (this.state.history[this.state.history.length - 1]?.id === track.id) {
      return this.state.history;
    }
    return [...this.state.history, track].slice(-MAX_PLAYBACK_HISTORY);
  }

  private setError(error: unknown) {
    logInternalError("PlayerController operation failed", error, {
      status: this.state.status,
      trackId: this.state.currentTrack?.id,
    });
    const detail = getErrorMessage(error);

    this.setState({
      status: "error",
      error: detail && detail !== "[object Object]"
        ? `Playback failed. ${detail}`
        : "Playback failed. Check internal logs for details.",
      // Preserve currentTrack to prevent reversion to hardcoded track
      currentTrack: this.state.currentTrack,
    });
  }

  private emit() {
    for (const listener of this.listeners) {
      listener();
    }
    
    // Update Discord RPC presence
    this.updateDiscordPresence();
  }

  private updateDiscordPresence() {
    const currentTrack = this.state.currentTrack;
    logInternalDebug("updateDiscordPresence", { status: this.state.status, hasTrack: !!currentTrack });
    
    // Clear presence if idle or error
    if (this.state.status === "idle" || this.state.status === "error" || !currentTrack) {
      logInternalDebug("Discord.clearPresence", {});
      void DiscordRpcService.clearPresence();
      return;
    }

    // Update presence with current track info
    if (this.state.status === "playing" || this.state.status === "paused") {
      const currentTime = this.loadedTrackId === currentTrack.id 
        ? this.audioEngine.getCurrentTime() 
        : (this.pendingSeekTime ?? 0);

      logInternalDebug("Discord.updatePresence", {
        title: currentTrack.title,
        artist: currentTrack.artist,
        status: this.state.status,
      });

      void DiscordRpcService.updatePresence({
        title: currentTrack.title,
        artist: currentTrack.artist,
        album: currentTrack.album ?? "",
        artworkUrl: getDiscordArtworkUrl(currentTrack),
        songUrl: getYouTubeMusicTrackUrl(currentTrack),
        artistUrl: getYouTubeMusicArtistUrl(currentTrack),
        albumUrl: getYouTubeMusicAlbumUrl(currentTrack),
        duration: Math.floor(currentTrack.durationSec ?? 0),
        currentTime: Math.floor(Math.max(0, currentTime)),
        isPlaying: this.state.status === "playing",
      });
    }
  }

  async seekTo(time: number): Promise<void> {
    const seekTime = Math.max(0, time);
    logInternalInfo("PlayerController.seekTo", { time: seekTime, loadedTrackId: this.loadedTrackId, currentTrackId: this.state.currentTrack?.id });

    const currentTrack = this.state.currentTrack;
    if (!currentTrack) {
      logInternalWarn("PlayerController.seekTo no current track");
      return;
    }

    if (this.loadedTrackId !== currentTrack.id) {
      logInternalInfo("PlayerController.seekTo track not loaded, loading...", { trackId: currentTrack.id });
      this.pendingSeekTime = seekTime;
      try {
        await this.ensureTrackLoaded(currentTrack);
      } catch (error) {
        this.setError(error);
      }
      this.emit();
      return;
    }

    logInternalInfo("PlayerController.seekTo track already loaded, seeking...");
    this.audioEngine.seekTo(seekTime);
    this.emit();
  }

  async setVolume(level: number, muted = level <= 0): Promise<void> {
    logInternalInfo("PlayerController.setVolume", { level, muted });
    this.audioEngine.setVolume(level);
    this.audioEngine.setMuted(muted);
    this.setState({
      volume: this.audioEngine.getVolume(),
      muted: this.audioEngine.isMuted(),
    });
    savePlaybackSettings({
      volume: this.state.volume,
      muted: this.state.muted,
    });
  }

  async skipToPrevious(): Promise<void> {
    this.cancelLoadingPlayback();
    return this.queueNavigation(() => this.skipToPreviousNow());
  }

  private async skipToPreviousNow(): Promise<void> {
    const shouldResume = this.shouldResumeAfterNavigation();
    let previousTrack = this.queue.prev(false);
    if (!previousTrack || previousTrack.id === this.state.currentTrack?.id) {
      let currentHistoryIndex = -1;
      for (let index = this.state.history.length - 1; index >= 0; index -= 1) {
        if (this.state.history[index].id === this.state.currentTrack?.id) {
          currentHistoryIndex = index;
          break;
        }
      }
      previousTrack = currentHistoryIndex > 0
        ? this.state.history[currentHistoryIndex - 1]
        : null;
    }
    logInternalInfo("PlayerController.skipToPrevious", {
      currentTrackId: this.state.currentTrack?.id ?? null,
      previousTrackId: previousTrack?.id ?? null,
    });
    if (!previousTrack || previousTrack.id === this.state.currentTrack?.id) return;
    if (shouldResume) {
      await this.playTrackById(previousTrack.id);
    } else {
      await this.loadTrack(previousTrack);
    }
  }

  private queueNavigation(operation: () => Promise<void>): Promise<void> {
    const request = this.navigationRequest.then(operation, operation);
    this.navigationRequest = request.catch(() => undefined);
    return request;
  }

  private shouldResumeAfterNavigation(): boolean {
    return this.state.status === "playing" || this.state.status === "loading";
  }

  private cancelLoadingPlayback(): void {
    if (this.state.status !== "loading") return;

    this.playTrackRequestId += 1;
    this.audioEngine.stop();
    this.loadedTrackId = null;
    this.pendingSeekTime = null;
  }

  suspendForTabSwitch(): void {
    this.isTabActive = false;
    this.syncTransitionTicker();
    if (this.state.status === "playing") {
      this.audioEngine.suspend();
    }
  }

  async resumeFromTabSwitch(): Promise<void> {
    this.isTabActive = true;
    this.syncTransitionTicker();
    if (this.state.status !== "playing" || !this.state.currentTrack) return;

    try {
      await this.ensureTrackLoaded(this.state.currentTrack);
      if (!this.isTabActive) return;
      const playbackStarted = await this.playLoadedTrack();
      if (!playbackStarted) return;
    } catch (error) {
      this.setError(error);
    }
  }

  dispose(): void {
    this.isTabActive = false;
    this.syncTransitionTicker();
    this.audioEngine.setOnEnded(null);
    this.audioEngine.dispose();
    this.listeners.clear();
  }

  getCurrentTime(): number {
    return this.audioEngine.getCurrentTime();
  }

  getPlayerSession(): PlayerSession {
    return this.exportSession();
  }

  getDuration(): number {
    return this.audioEngine.getDuration();
  }

  getVolume(): number {
    return this.audioEngine.getVolume();
  }

  isMuted(): boolean {
    return this.audioEngine.isMuted();
  }

  async toggleMute(): Promise<void> {
    const nextMuted = !this.audioEngine.isMuted();
    logInternalInfo("PlayerController.toggleMute", { muted: nextMuted });
    this.audioEngine.setMuted(nextMuted);
    this.setState({ muted: this.audioEngine.isMuted() });
    savePlaybackSettings({
      volume: this.state.volume,
      muted: this.state.muted,
    });
  }

  async getLyrics(track: Track): Promise<Lyrics | null> {
    return this.dataSource.getLyrics?.(track) ?? null;
  }
}
