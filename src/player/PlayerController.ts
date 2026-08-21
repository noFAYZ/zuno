import type { DataSource, StreamData } from "../datasource/DataSource";
import type { Lyrics, Track } from "../datasource/types";
import { logInternalDebug, logInternalError, logInternalInfo, logInternalWarn } from "../internal/logging";
import { isPrematureEnd } from "./prematureEnd";
import { AudioEngine } from "./AudioEngine";
import { Queue } from "./Queue";
import { NavigationCoalescer } from "./navigationCoalescer";
import { recordPlay } from "./playHistory";
import { computeQueueWindow } from "./queueWindow";
import { getOfflineTrack, isTrackDownloaded } from "./offlineStore";
import { hasPreloadDeck } from "./preloadDeck";
import { getAudioEngineMode } from "../ui/settings/audioEngine";
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
/** How long after the last volume change the settings are written. See setVolume. */
const PLAYBACK_SETTINGS_PERSIST_MS = 400;
/**
 * How much of a track may be left when it ends before that counts as a failure rather than a
 * finish. Generous, because the only thing on the other side of it is a needless reload.
 */
const PREMATURE_END_TOLERANCE_SEC = 5;

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
  /**
   * How far `queue` is offset from the live, unwindowed queue the controller's index-taking
   * methods (`playQueueTrackAt`, `removeFromQueueAt`, ...) operate on. Deliberately not
   * persisted-meaningful: after a restore the live queue *is* the persisted slice, so the
   * offset resets to 0.
   */
  queueWindowStart?: number;
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
  /** The track already reloaded once after ending early, so a second failure gives up. */
  private prematureEndTrackId: string | null = null;
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
  /** Coalesces a burst of skip forward/back clicks — see `NavigationCoalescer`. */
  private readonly navigationCoalescer = new NavigationCoalescer();
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
  private playbackSettingsTimerId: ReturnType<typeof setTimeout> | null = null;
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

  /** See `queueWindow.ts` — the slice, and the indices rebased onto it. */
  private exportQueueWindow(): Pick<
    PlayerSession,
    "queue" | "queueIndex" | "manualQueueLength" | "stopAfterQueueIndex" | "queueWindowStart"
  > {
    const all = this.queue.all;
    const window = computeQueueWindow(
      all.length,
      this.queue.currentIndex,
      this.stopAfterTrack ? all.indexOf(this.stopAfterTrack) : -1,
    );

    return {
      queue: all.slice(window.from, window.to),
      queueIndex: window.queueIndex,
      manualQueueLength: this.queue.queuedManually,
      stopAfterQueueIndex: window.stopAfterQueueIndex,
      queueWindowStart: window.from,
    };
  }

  exportSession(): PlayerSession {
    return {
      currentTrack: this.state.currentTrack,
      history: this.state.history.slice(-100),
      ...this.exportQueueWindow(),
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
      savePlaybackSettings(this.currentPlaybackSettings());
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
    shufflePlaylist = false,
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
    // Captured before the reset below: this is the only place that still knows whether a track
    // was already loaded, and `warmNextTrack` below needs that to tell a cold start apart from
    // an ordinary skip.
    const hadLoadedTrack = this.loadedTrackId !== null;
    this.loadedTrackId = null;
    this.pendingSeekTime = null;
    try {
      if (playbackQueue?.length) {
        const startIndex = playbackQueue.findIndex((track) => track.id === videoId);
        this.queue.set([...playbackQueue], startIndex >= 0 ? startIndex : 0);
        this.autoplayEnabled = autoplayWhenQueueEnds;
        this.isPlaylistMode = !autoplayWhenQueueEnds && playbackQueue.length > 1;
        if (shufflePlaylist && this.isPlaylistMode) {
          this.queue.shuffleAll(this.queue.queuedManually);
        }
      }
      this.setState({ status: "loading", error: null });

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
      const mergeWithQueued = (fetched: Track): Track => (queuedTrack
        ? {
            ...fetched,
            ...queuedTrack,
            durationSec: fetched.durationSec ?? queuedTrack.durationSec,
            artworkUrl: queuedTrack.artworkUrl ?? fetched.artworkUrl,
            artists: queuedTrack.artists ?? fetched.artists,
          }
        : fetched);

      /*
       * Metadata is fetched *alongside* the audio, not before it.
       *
       * A row that was clicked in a list already carries its title, artist, artwork and
       * duration — everything the player bar shows. Awaiting `getTrack` before touching the
       * audio spent a full round trip re-fetching what was already on screen, and it did so
       * before stream resolution could even begin, so two serial round trips stood between the
       * click and the first byte. Playing from what we have collapses that to one, and the
       * refresh lands a moment later with anything the row was missing.
       *
       * Only a track we know nothing about still has to wait.
       */
      let track: Track;
      if (queuedTrack?.source === "local") {
        track = queuedTrack;
      } else if (knownTrack) {
        track = mergeWithQueued(knownTrack);
        void this.dataSource.getTrack(videoId)
          .then((fetched) => {
            // A skip during the refresh makes this answer belong to a track nobody is on.
            if (requestId !== this.playTrackRequestId) return;
            this.setState({ currentTrack: mergeWithQueued(fetched) });
          })
          .catch((error) => {
            // Playback is already under way on the known copy; this is a missing refresh, not
            // a failure — offline is the ordinary case.
            logInternalWarn("PlayerController.playTrackById metadata refresh failed", {
              videoId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      } else {
        track = mergeWithQueued(await this.dataSource.getTrack(videoId));
      }
      if (requestId !== this.playTrackRequestId) return false;

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
      /*
       * Warm the next track *while* this one loads, not after — but only once something is
       * already loaded.
       *
       * Resolution costs the better part of a second, and starting only once this track had
       * finished meant a skip inside the first second always lost the race — which is exactly
       * how someone skips through a queue looking for something. Both are network-bound and
       * independent, so they overlap for free — *when* there is already a track holding the
       * deck. On a cold start there is nothing playing yet to hide the cost behind, so this
       * would instead double up on the same per-client resolve walk and JS evaluator that
       * `ensureTrackLoaded` below is about to use for this track, measured as roughly doubling
       * first-track latency. The call at the end of `ensureTrackLoaded` still fires once this
       * track actually lands, so a cold start is one warm behind rather than zero.
       */
      if (hadLoadedTrack) this.warmNextTrack();
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
    return this.runNavigation(() => this.skipToNextNow());
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
   *
   * Enabling shuffles whenever no un-shuffle snapshot exists, even if the flag already read
   * "on": a freshly loaded playlist behind a stale persisted flag used to skip the reorder
   * here, so "Shuffle" picked a random start track and left the rest in playlist order.
   */
  setShuffleEnabled(enabled: boolean): void {
    this.shuffleEnabled = enabled;

    if (this.isPlaylistMode) {
      if (!enabled) {
        this.queue.restoreOriginalOrder(this.queue.queuedManually);
      } else if (!this.queue.canRestoreOriginalOrder) {
        this.queue.shuffleRemaining(this.queue.queuedManually);
      }
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
    savePlaybackSettings(this.currentPlaybackSettings());
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

  /** Shuffles the whole source playlist around the current track, played songs included. */
  shuffleEntirePlaylist(): void {
    this.queue.shuffleAll(this.queue.queuedManually);
    this.emit();
    logInternalInfo("PlayerController.shuffleEntirePlaylist");
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

  /**
   * Tells a track that finished apart from a stream that died, and reloads the second kind.
   *
   * The engine reports "ended" for both, and the queue cannot see the difference — so a track
   * whose audio ran out after eight seconds looked exactly like a three-minute song finishing,
   * and playback advanced. That is the "plays for a few seconds then skips" symptom, and the
   * cause is upstream: googlevideo refuses individual byte ranges often enough that a deck
   * preloaded minutes earlier can end up holding only its first chunk (`fill_media_buffer` in
   * lib.rs logs `chunk N failed`, falls back to a whole-file fetch, and gives up if that is
   * refused too). Nothing invalidated the deck, so the gapless swap handed over to a few
   * seconds of audio.
   *
   * Reloading rather than skipping, because the track was never the problem — the signed URL
   * behind it was. Clearing `loadedTrackId` puts `ensureTrackLoaded` back through stream
   * resolution for a fresh one, and by this point the exhausted deck is no longer the standby,
   * so nothing hands the same bytes back.
   *
   * Deliberately not specific to a 403: it measures the outcome, so it also covers a dropped
   * connection, a truncated body, and whatever the next upstream change breaks.
   */
  private async recoverFromPrematureEnd(): Promise<boolean> {
    const track = this.state.currentTrack;
    if (!track) return false;

    /*
     * The snapshot, not the live getters. `ended` clears the engine's track id before the
     * callback runs, so by the time this is reached `getDuration()` answers 0 and every
     * premature end looked like a finish — which is why this guard was silent the first time.
     */
    const ended = this.audioEngine.takeEndedPlayback();
    const duration = ended?.durationSec ?? this.audioEngine.getDuration();
    const position = ended?.positionSec ?? this.audioEngine.getCurrentTime();

    if (!isPrematureEnd({
      durationSec: duration,
      positionSec: position,
      crossfadeSec: this.crossfadeSec,
      toleranceSec: PREMATURE_END_TOLERANCE_SEC,
    })) {
      // A track that reached its end clears the marker: the next failure gets its own retry.
      this.prematureEndTrackId = null;
      return false;
    }

    /*
     * One retry. If a freshly resolved URL dies in the same place the track itself is the
     * problem, and looping on it is worse for the listener than moving to the next one.
     */
    if (this.prematureEndTrackId === track.id) {
      logInternalWarn("PlayerController.prematureEnd retry failed, advancing", {
        trackId: track.id,
        positionSec: Math.round(position),
        durationSec: Math.round(duration),
      });
      this.prematureEndTrackId = null;
      return false;
    }

    this.prematureEndTrackId = track.id;
    logInternalWarn("PlayerController.prematureEnd reloading", {
      trackId: track.id,
      positionSec: Math.round(position),
      durationSec: Math.round(duration),
    });

    /*
     * `playTrackById` clears `loadedTrackId` and `pendingSeekTime` itself, so the resume
     * position has to be applied after it rather than staged before — staging it here is what
     * the seek path does for a restored session, and it would be wiped on the way in.
     *
     * It also skips its own `stop()` when the track is still preloaded; by this point the
     * exhausted deck has already been swapped in and is no longer the standby, so the engine
     * is torn down properly and the reload resolves a fresh stream URL.
     */
    // The warmed slot holds the same signed URL that just died; keeping it would have the
    // reload fetch the identical 403 and end early again.
    this.discardWarmedStream(track.id);

    await this.playTrackById(track.id);
    if (position > 0 && this.loadedTrackId === track.id) {
      await this.seekTo(position);
    }
    return true;
  }

  /** Forgets a pre-resolved stream whose URL has proven dead, so the next load re-resolves. */
  private discardWarmedStream(trackId: string): void {
    if (this.warmedStream?.trackId === trackId) this.warmedStream = null;
  }

  private async handleTrackEnded(): Promise<void> {
    if (this.handlingTrackEnd || !this.isTabActive) return;
    this.handlingTrackEnd = true;

    try {
      // Before every other branch: a stream that died is not an end, so it must not trigger
      // repeat-one, consume the stop-after marker, or advance the queue.
      if (await this.recoverFromPrematureEnd()) return;

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
          this.queue.shuffleForLoop();
        } else {
          this.queue.select(0);
        }

        const firstTrack = this.queue.current;
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
      if (this.usesPreloadDeck(track) && this.audioEngine.hasPreloaded(track.id)) {
        const swapped = await this.audioEngine.transitionToPreloaded(
          track.id,
          this.crossfadeSec * 1000,
        );
        if (swapped) {
          this.loadedTrackId = track.id;
          this.pendingSeekTime = null;
          // The deck already holds these bytes, so the slot is stale rather than useful.
          this.claimWarmedStream(track.id);
          logInternalInfo("PlayerController.ensureTrackLoaded preloaded deck", {
            trackId: track.id,
            crossfadeSec: this.crossfadeSec,
            durationMs: Math.round(performance.now() - startedAt),
          });
          /*
           * Warming has to continue from here too, or the chain stops after one transition:
           * this branch returns before the ordinary load path's call, so the deck that just
           * became active would have nothing queued behind it and the next track would load
           * from cold — the first gapless handover would also be the last.
           */
          this.warmNextTrack();
          this.beginPlayReport(track);
          return;
        }
        /*
         * The swap was refused, which means Rust found the deck's download dead. The warmed
         * slot was resolved in the same breath as that deck and holds the same signed URL, so
         * the load below has to re-resolve rather than replay the URL that just failed.
         */
        this.discardWarmedStream(track.id);
        logInternalWarn("PlayerController.preloadedDeck refused, re-resolving", {
          trackId: track.id,
        });
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
          audioData.rustSource,
          track.durationSec,
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
        /*
         * Warm from here too, or a local playlist never gets a second track onto the standby
         * deck and every gapless handover it should have had is a gap instead. This branch used
         * to return before the call below because nothing on the local path could be warmed —
         * the Rust decks changed that.
         */
        this.warmNextTrack();
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

      /*
       * A streamed track on the Rust engine gets the IFrame deck as a safety net.
       *
       * Both halves of this can be refused by Google and neither is the listener's fault:
       * resolving needs a PO token and an InnerTube `player` call, and fetching the signed URL
       * needs googlevideo to honour it. The IFrame player is the one path that cannot 403 — it
       * is Google's own embed resolving its own URLs — which is exactly why it was the only
       * engine between v1.2.65 and PO tokens landing.
       *
       * Only for streaming. Local files returned above and have no IFrame equivalent anyway,
       * and falling back for a *download* would stream the online copy of a track the user
       * saved on purpose.
       */
      const canFallBackToIframe = this.audioEngine.usesRustAudio() && !isDownloaded;

      try {
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
            audioData.rustSource,
            track.durationSec,
          );
        } else {
          await this.audioEngine.loadTrack(
            track.id,
            audioData?.bytes,
            audioData?.mimeType,
            audioData?.sourceUrl,
            audioData?.rustSource,
            track.durationSec,
          );
        }
      } catch (error) {
        if (!canFallBackToIframe) throw error;
        logInternalWarn("PlayerController.ensureTrackLoaded falling back to the YouTube player", {
          trackId: track.id,
          error: getErrorMessage(error),
        });
        await this.audioEngine.loadIframeFallback(track.id);
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
    /*
     * A track already on disk has no network wait to hide, which is all warming ever did on the
     * `<audio>` engine — so it stays excluded there.
     *
     * On the Rust engine warming is not about the network. It decodes the next track onto the
     * standby deck, and that is the whole mechanism behind gapless. Skipping it here is what
     * left a downloaded album with a gap between every track while a streamed one played
     * through seamlessly, which is exactly backwards.
     */
    if (
      (next.source === "local" || isTrackDownloaded(next.id))
      && !this.audioEngine.usesRustAudio()
    ) {
      return;
    }
    if (this.warmedStream?.trackId === next.id) return;

    const getStreamData = this.dataSource.getStreamData.bind(this.dataSource);
    this.warmingStream = true;
    void getStreamData(next)
      .then(async (data) => {
        this.warmedStream = { trackId: next.id, data };
        logInternalDebug("PlayerController.warmNextTrack audio ready", { trackId: next.id });
        /*
         * On the Rust engine the warmed stream goes one step further and is decoded onto the
         * standby deck, which is what `ensureTrackLoaded` then transitions to. Held in the slot
         * as well, so a transition that misses — a skip past this track and back, say — still
         * finds the resolved URL rather than paying for it twice.
         */
        if (!data.rustSource || !this.audioEngine.usesRustAudio()) return;
        await this.audioEngine.preloadRustTrack(next.id, data.rustSource, next.durationSec ?? 0);
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

  /**
   * Takes the warmed stream if it is for this track, and leaves it alone if it is not.
   *
   * It used to empty the slot either way, which was fine while warming only began after the
   * current track had loaded. Now that a warm starts *alongside* that load, the slot often
   * holds the next track while this one is still being claimed — and discarding it there threw
   * away the very thing the early start exists to produce.
   */
  private claimWarmedStream(trackId: string): StreamData | undefined {
    if (this.warmedStream?.trackId !== trackId) return undefined;
    const { data } = this.warmedStream;
    this.warmedStream = null;
    return data;
  }

  /** Whether a track can be handed to a standby deck rather than loaded on the spot. */
  private usesPreloadDeck(track: Track): boolean {
    return hasPreloadDeck(getAudioEngineMode(), {
      isLocal: track.source === "local",
      isDownloaded: isTrackDownloaded(track.id),
    });
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
    if (!next || !this.usesPreloadDeck(next)) return;

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

  /**
   * The one write path that is driven by a drag rather than a click.
   *
   * No log line and no synchronous persist: this is called once per pointer move of the volume
   * slider, and both of those were being paid a hundred times a second for a gesture whose only
   * meaningful moment is where it ends.
   */
  async setVolume(level: number, muted = level <= 0): Promise<void> {
    this.audioEngine.setVolume(level);
    this.audioEngine.setMuted(muted);
    this.setState({
      volume: this.audioEngine.getVolume(),
      muted: this.audioEngine.isMuted(),
    });
    this.persistPlaybackSettingsSoon();
  }

  /**
   * Every persisted playback setting, read from the live engine and controller.
   *
   * `savePlaybackSettings` fills an absent field with its *default* rather than leaving the
   * stored value alone, so a partial object is a silent reset. Three of the four call sites
   * passed `{ volume, muted }` and nothing else — which meant that nudging the volume wrote
   * playbackRate 1, crossfade 0 and gapless true over whatever the listener had chosen.
   */
  private currentPlaybackSettings(): PlaybackSettings {
    return {
      volume: this.state.volume,
      muted: this.state.muted,
      playbackRate: this.audioEngine.getPlaybackRate(),
      crossfadeSec: this.crossfadeSec,
      gaplessEnabled: this.gaplessEnabled,
    };
  }

  /**
   * Persist after the gesture settles.
   *
   * A save is a `JSON.stringify`, a `localStorage` write and a Tauri IPC hop to the durable
   * store. Trailing rather than leading, because the value that matters is the one the slider
   * is released on. `dispose` flushes, so a pending write cannot be lost to a tab closing.
   */
  private persistPlaybackSettingsSoon(): void {
    if (this.playbackSettingsTimerId !== null) {
      globalThis.clearTimeout(this.playbackSettingsTimerId);
    }
    this.playbackSettingsTimerId = globalThis.setTimeout(() => {
      this.playbackSettingsTimerId = null;
      savePlaybackSettings(this.currentPlaybackSettings());
    }, PLAYBACK_SETTINGS_PERSIST_MS);
  }

  private flushPlaybackSettings(): void {
    if (this.playbackSettingsTimerId === null) return;
    globalThis.clearTimeout(this.playbackSettingsTimerId);
    this.playbackSettingsTimerId = null;
    savePlaybackSettings(this.currentPlaybackSettings());
  }

  async skipToPrevious(): Promise<void> {
    this.cancelLoadingPlayback();
    return this.runNavigation(() => this.skipToPreviousNow());
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

  /**
   * Runs a navigation step through the coalescer.
   *
   * `skipToNextNow`/`skipToPreviousNow` call `queue.next`/`queue.prev` as their first step, so a
   * collapsed follow-up always lands on wherever a burst actually left the queue pointer rather
   * than replaying a stale target.
   */
  private runNavigation(operation: () => Promise<void>): Promise<void> {
    return this.navigationCoalescer.run(operation);
  }

  private shouldResumeAfterNavigation(): boolean {
    return this.state.status === "playing" || this.state.status === "loading";
  }

  private cancelLoadingPlayback(): void {
    if (this.state.status !== "loading") return;

    this.playTrackRequestId += 1;
    // Not `stop()`: that tears down the standby deck too, which is exactly what is not supposed
    // to happen here — see `abandonActiveLoad`.
    this.audioEngine.abandonActiveLoad();
    this.loadedTrackId = null;
    this.pendingSeekTime = null;
  }

  suspendForTabSwitch(): void {
    this.isTabActive = false;
    this.syncTransitionTicker();
    this.syncScrobbleTicker();
    if (this.state.status === "playing") {
      this.audioEngine.suspend();
    }
  }

  async resumeFromTabSwitch(): Promise<void> {
    this.isTabActive = true;
    this.syncTransitionTicker();
    this.syncScrobbleTicker();
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
    this.flushPlaybackSettings();
    this.isTabActive = false;
    this.syncTransitionTicker();
    this.syncScrobbleTicker();
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
    savePlaybackSettings(this.currentPlaybackSettings());
  }

  async getLyrics(track: Track): Promise<Lyrics | null> {
    return this.dataSource.getLyrics?.(track) ?? null;
  }
}
