import { logInternalError, logInternalInfo, logInternalWarn } from "../internal/logging";
import {
  AUDIO_ENGINE_MODE_CHANGE_EVENT,
  usesNativeAudioEngine,
  usesRustAudioEngine,
} from "../ui/settings/audioEngine";
import type { RustAudioSource } from "../datasource/types";
import * as rustAudio from "./rustAudio";

type YouTubePlayerEvent = {
  data: number;
};

type YouTubePlayer = {
  /** Optional: present on the IFrame API, absent in older embeds. */
  setPlaybackRate?(rate: number): void;
  cueVideoById(videoId: string): void;
  loadVideoById(videoId: string): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  setVolume(volume: number): void;
  getVolume(): number;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getVideoData(): { video_id?: string };
  destroy(): void;
};

type YouTubePlayerConstructor = new (
  element: HTMLElement,
  options: {
    width: number;
    height: number;
    videoId?: string;
    playerVars: Record<string, number | string>;
    events: {
      onReady: () => void;
      onStateChange: (event: YouTubePlayerEvent) => void;
      onError: (event: YouTubePlayerEvent) => void;
    };
  },
) => YouTubePlayer;

declare global {
  interface Window {
    YT?: {
      Player: YouTubePlayerConstructor;
      PlayerState: {
        UNSTARTED: number;
        ENDED: number;
        PLAYING: number;
        PAUSED: number;
        CUED: number;
      };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

/**
 * How long playback has to stay stopped before the standby deck is freed.
 *
 * Long enough that pausing to answer the door does not cost the next gapless transition, short
 * enough that an app left paused in the background is not holding a spare video pipeline.
 */
const STANDBY_IDLE_TEARDOWN_MS = 60_000;

let iframeApiPromise: Promise<void> | null = null;
const audioEngines = new Set<AudioEngine>();
let playbackClaimId = 0;
let playbackOwner: AudioEngine | null = null;

/*
 * Switching to native has to *free* the decks, not merely stop routing to them.
 *
 * Changing the setting only changes which branch `loadTrack` takes. Any player already built
 * keeps its `youtube.com` subframe process alive — the whole ~90 MB the setting exists to give
 * back — so without this the memory only drops once every tab happens to load another track.
 *
 * The engine currently making sound is spared: flipping a setting should not cut off the song
 * that is playing. It releases at its next track, where `loadTrack`'s native branch does the
 * same thing.
 */
if (typeof window !== "undefined") {
  window.addEventListener(AUDIO_ENGINE_MODE_CHANGE_EVENT, () => {
    if (!usesNativeAudioEngine()) return;
    for (const engine of audioEngines) {
      if (engine === playbackOwner) continue;
      engine.releaseIframePlayer();
    }
  });
}

/*
 * Follows the user's setting, read fresh rather than captured at construction.
 *
 * This was hardcoded `false` from v1.2.65: the backend download path answered 403 for remote
 * streams, so every platform was reverted to the iframe player. What fixed it was PO tokens —
 * the *download* feature has used this exact resolve-and-fetch path successfully ever since,
 * which is what makes it safe to offer again. It stays opt-in because a signed URL is resolved
 * and fetched before the first sample plays, so a track starts a little slower.
 *
 * Read per call so switching the setting takes effect on the next track rather than at the next
 * launch. Mid-track it changes nothing: every branch that matters is `useNativeAudio || audio`,
 * so a live `<audio>` element keeps being driven as one until it is released.
 */
function shouldUseNativeAudio(): boolean {
  return usesNativeAudioEngine();
}

/*
 * One `ended` subscription for the whole process, dispatched to whichever engine owns playback.
 *
 * Rust has a single engine but there is an `AudioEngine` per tab, so a per-engine subscription
 * would have every tab handle the same event and advance its own queue — one track end skipping
 * three. Installed on the first Rust load rather than at import so a listener on the IFrame
 * engine never registers one.
 */
let rustEndedRouted = false;

/*
 * The media server is released once per switch to the Rust engine, not once per track.
 *
 * Cleared again by `loadNativeAudio`, because that path is what refills the server — switching
 * back and forth has to release each time, and a flag that only ever latched would leak the
 * bodies of every track played after the first return trip.
 */
let mediaServerReleased = false;

function routeRustEnded(): void {
  if (rustEndedRouted) return;
  rustEndedRouted = true;
  rustAudio.setEndedListener(() => {
    playbackOwner?.handleRustEnded();
  });
}

function isPlayerStateTimeout(error: unknown): boolean {
  return error instanceof Error
    && /^Timed out waiting for YouTube player state: /.test(error.message);
}

function detectAudioMimeType(bytes: Uint8Array): string {
  if (
    bytes.length >= 4
    && bytes[0] === 0x1a
    && bytes[1] === 0x45
    && bytes[2] === 0xdf
    && bytes[3] === 0xa3
  ) {
    return "audio/webm";
  }
  if (
    bytes.length >= 12
    && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp"
  ) {
    return "audio/mp4";
  }
  return "audio/mp4";
}

function allowYouTubeIframePlayback(host: HTMLElement): void {
  const iframe = host.querySelector("iframe");
  if (!iframe) return;
  iframe.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture");
}

function loadYouTubeIframeApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  if (iframeApiPromise) return iframeApiPromise;

  iframeApiPromise = new Promise((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previousReady?.();
      resolve();
    };

    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    script.onerror = () => reject(new Error("Unable to load the YouTube player API."));
    document.head.appendChild(script);
  });

  return iframeApiPromise;
}

export class AudioEngine {
  /*
   * A getter, not a field captured in the constructor: engines are built once per tab and live
   * for the whole session, so a captured value would keep the old pipeline until relaunch.
   */
  private get useNativeAudio(): boolean {
    return shouldUseNativeAudio();
  }

  /** Rust decodes and plays; nothing in this class touches a media element or an IFrame. */
  private get useRustAudio(): boolean {
    return usesRustAudioEngine();
  }

  /** What Rust has loaded on the active deck for this engine, or null. */
  private rustTrackId: string | null = null;
  /** What Rust has decoded on the standby deck, mirrored so `hasPreloaded` stays synchronous. */
  private rustStandbyTrackId: string | null = null;
  private rustDurationSec = 0;
  private rustStandbyDurationSec = 0;
  /**
   * This track is on the IFrame deck even though the selected engine is not `iframe`.
   *
   * Every other branch here asks *what is loaded* — `rustTrackId`, `audio` — rather than what
   * the setting says, and falls through to the player when neither is. The exception is the
   * `<audio>` branch, which also fires on the setting alone so that native mode reports "no
   * track loaded" rather than silently doing nothing; this flag is what stops that branch from
   * claiming a track the IFrame deck is holding.
   */
  private iframeFallbackActive = false;
  private player: YouTubePlayer | null = null;
  private playerHost: HTMLElement | null = null;
  private playerPromise: Promise<YouTubePlayer> | null = null;
  /*
   * A second, idle IFrame player holding the *next* track, already cued.
   *
   * One player cannot hold two videos, and cueing is where the gap between tracks comes from:
   * loading a video takes a network round-trip that only starts once the previous one has
   * ended. With the next track cued in a player of its own, the transition is a volume ramp
   * between two live players rather than a stop followed by a load.
   */
  private standbyPlayer: YouTubePlayer | null = null;
  private standbyHost: HTMLElement | null = null;
  private standbyVideoId: string | null = null;
  private standbyPromise: Promise<void> | null = null;
  private standbyIdleTimerId: number | null = null;
  private audio: HTMLAudioElement | null = null;
  private audioObjectUrl: string | null = null;
  private currentVideoId: string | null = null;
  private volume = 1;
  /*
   * The crossfade ramp. Held so a stop mid-transition can cancel it — a ramp that kept running
   * would set volumes on a deck that had already been torn down.
   */
  private fadeFrameId: number | null = null;
  private muted = false;
  private playbackRate = 1;
  private onEnded: (() => void) | null = null;
  private loadRequestId = 0;
  private stateWaiters = new Set<{
    states: Set<number>;
    videoId: string | null;
    resolve: () => void;
    reject: (error: Error) => void;
    timeoutId: number;
  }>();

  constructor() {
    audioEngines.add(this);
  }

  usesNativeAudio(): boolean {
    return this.useNativeAudio;
  }

  usesRustAudio(): boolean {
    return this.useRustAudio;
  }

  async loadTrack(
    videoId: string,
    audioData?: ArrayBuffer,
    mimeType?: string,
    sourceUrl?: string,
    rustSource?: RustAudioSource,
    durationSec?: number,
  ): Promise<void> {
    if (this.useRustAudio) {
      if (!rustSource) {
        throw new Error("Rust playback requires a resolved audio source.");
      }
      this.releaseIframePlayer();
      // `loadRustAudio` releases the `<audio>` element itself, so both entry points get it.
      await this.loadRustAudio(videoId, rustSource, durationSec ?? 0);
      return;
    }

    if (this.useNativeAudio) {
      if (!audioData && !sourceUrl) {
        throw new Error("Native playback requires downloaded audio data.");
      }
      /*
       * The mirror of `releaseNativeAudio()` on the iframe branch below: whichever pipeline is
       * not in use gives its resources back. This is also the point where the engine that was
       * still sounding when the setting changed finally lets go of its subframe.
       */
      this.releaseIframePlayer();
      await this.loadNativeAudio(videoId, audioData, mimeType, sourceUrl);
      return;
    }

    await this.loadIframeTrack(videoId);
  }

  /**
   * Plays a track on the IFrame deck regardless of which engine is selected.
   *
   * The Rust engine resolves a signed googlevideo URL and can be refused; the IFrame player is
   * Google's own embed resolving its own URLs, so it is the one path that cannot 403. That is
   * why it was the only engine between v1.2.65 and PO tokens landing, and it is what keeps a
   * refusal from becoming a dead track now that Rust is the default.
   *
   * Costs the `youtube.com` subframe for this track only — the next one tries Rust again.
   */
  async loadIframeFallback(videoId: string): Promise<void> {
    this.releaseRustAudio();
    this.releaseNativeAudio();
    this.iframeFallbackActive = true;
    await this.loadIframeTrack(videoId);
    logInternalWarn("AudioEngine fell back to the YouTube player", { videoId });
  }

  private async loadIframeTrack(videoId: string): Promise<void> {
    const requestId = ++this.loadRequestId;
    this.releaseNativeAudio();
    const player = await this.ensurePlayer();
    if (requestId !== this.loadRequestId) return;
    if (this.currentVideoId === videoId) return;

    this.currentVideoId = videoId;
    // A previous track may already have left the player in CUED. Wait for the
    // state event from this cue request instead of accepting that stale state.
    const cued = this.waitForPlayerState(
      [window.YT!.PlayerState.CUED],
      15_000,
      false,
      videoId,
    );
    player.cueVideoById(videoId);
    try {
      await cued;
    } catch (error) {
      if (requestId === this.loadRequestId && this.currentVideoId === videoId) {
        this.currentVideoId = null;
      }
      throw error;
    }
    if (requestId !== this.loadRequestId || this.currentVideoId !== videoId) return;
    logInternalInfo("AudioEngine.loadTrack cued", { videoId });
  }

  async loadNativeFallback(
    videoId: string,
    audioData?: ArrayBuffer,
    mimeType?: string,
    sourceUrl?: string,
    rustSource?: RustAudioSource,
    durationSec?: number,
  ): Promise<void> {
    this.player?.stopVideo();
    if (this.useRustAudio && rustSource) {
      await this.loadRustAudio(videoId, rustSource, durationSec ?? 0);
      return;
    }
    await this.loadNativeAudio(videoId, audioData, mimeType, sourceUrl);
  }

  setOnEnded(listener: (() => void) | null): void {
    this.onEnded = listener;
  }

  /** Called by the process-wide Rust `ended` router, on the engine that owns playback. */
  handleRustEnded(): void {
    this.rustTrackId = null;
    this.onEnded?.();
  }

  async play(): Promise<boolean> {
    const claimId = this.claimPlayback();
    if (this.rustTrackId) {
      await rustAudio.setVolume(this.volume, this.muted);
      await rustAudio.play();
      return claimId === playbackClaimId && playbackOwner === this;
    }
    if (this.audio || (this.useNativeAudio && !this.iframeFallbackActive)) {
      if (!this.audio || !this.currentVideoId) {
        throw new Error("No audio track is loaded.");
      }
      this.applyNativeAudioSettings();
      await this.audio.play();
      return claimId === playbackClaimId && playbackOwner === this;
    }

    const player = await this.ensurePlayer();
    if (claimId !== playbackClaimId || playbackOwner !== this) {
      player.pauseVideo();
      return false;
    }
    if (!this.currentVideoId) {
      throw new Error("No YouTube track is loaded.");
    }

    /*
     * A crossfade has already started this track on what is now the active deck. Reloading it
     * here would restart the song a second or two after the transition made it audible, so
     * the claim is all that is left to do.
     */
    if (
      player.getPlayerState() === window.YT!.PlayerState.PLAYING
      && player.getVideoData().video_id === this.currentVideoId
    ) {
      return claimId === playbackClaimId && playbackOwner === this;
    }

    if (this.muted) {
      player.mute();
    } else {
      player.unMute();
    }
    player.setVolume(this.getOutputVolumePercent());
    const videoId = this.currentVideoId;
    const playing = this.waitForPlayerState(
      [window.YT!.PlayerState.PLAYING],
      15_000,
      true,
      videoId,
    );
    const playerState = player.getPlayerState();
    if (
      playerState === window.YT!.PlayerState.CUED
      || playerState === window.YT!.PlayerState.UNSTARTED
    ) {
      logInternalInfo("AudioEngine.play starting cued YouTube video", {
        videoId,
        playerState,
        method: "loadVideoById",
      });
      player.loadVideoById(videoId);
    } else {
      logInternalInfo("AudioEngine.play starting YouTube video", {
        videoId,
        playerState,
        method: "playVideo",
      });
      player.playVideo();
    }
    try {
      await playing;
    } catch (error) {
      if (
        !isPlayerStateTimeout(error)
        || claimId !== playbackClaimId
        || playbackOwner !== this
      ) {
        throw error;
      }

      logInternalWarn("AudioEngine.play continuing after slow YouTube start", {
        videoId: this.currentVideoId,
        playerState: player.getPlayerState(),
        playerVideoId: player.getVideoData().video_id ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (claimId !== playbackClaimId || playbackOwner !== this) {
      player.pauseVideo();
      return false;
    }
    logInternalInfo("AudioEngine.play requested", {
      videoId: this.currentVideoId,
      muted: this.muted,
      volume: this.volume,
    });
    return true;
  }

  pause(): void {
    if (this.rustTrackId) void rustAudio.pause().catch(() => {});
    this.audio?.pause();
    this.player?.pauseVideo();
    this.scheduleStandbyTeardown();
  }

  suspend(): void {
    this.pause();
  }

  async resume(): Promise<boolean> {
    if (this.currentVideoId) {
      return this.play();
    }
    return false;
  }

  stop(): void {
    this.loadRequestId += 1;
    if (playbackOwner === this) {
      playbackOwner = null;
      playbackClaimId += 1;
    }
    this.cancelFade();
    this.iframeFallbackActive = false;
    this.releaseRustAudio();
    this.releaseNativeAudio();
    this.player?.stopVideo();
    this.discardStandby();
    this.currentVideoId = null;
    this.applyOutputVolume();
    this.rejectStateWaiters(new Error("Playback was stopped."));
  }

  silenceCompetingPlayback(): void {
    this.claimPlayback();
  }

  dispose(): void {
    this.stop();
    this.player?.destroy();
    this.playerHost?.remove();
    this.player = null;
    this.playerHost = null;
    // `stop()` above armed the idle timer; a disposed engine must not be woken by it.
    this.cancelStandbyTeardown();
    this.destroyStandby();
    audioEngines.delete(this);
  }

  /**
   * Frees the IFrame decks without disturbing the engine or any `<audio>` it is driving.
   *
   * Distinct from `dispose()`, which also stops playback and unregisters the engine. This
   * leaves a working engine behind that simply builds a new player if the iframe path is asked
   * for again — which is what switching the audio engine setting back and forth needs.
   *
   * The thing being reclaimed is not a DOM element. Each IFrame player holds a `youtube.com`
   * subframe *process*; merely routing playback elsewhere leaves that ~90 MB resident, which is
   * exactly the memory the native setting exists to give back.
   */
  releaseIframePlayer(): void {
    if (!this.player && !this.playerPromise && !this.standbyHost) return;

    this.cancelStandbyTeardown();
    this.destroyStandby();

    // Invalidates any cue or play still awaiting the deck being torn down, so a late resolve
    // cannot write state for a player that no longer exists.
    this.loadRequestId += 1;
    this.player?.destroy();
    this.playerHost?.remove();
    this.player = null;
    this.playerHost = null;
    this.playerPromise = null;
    /*
     * Cleared so a later iframe load actually cues into the fresh player instead of
     * short-circuiting on `currentVideoId === videoId`. Left alone when an `<audio>` element
     * owns it — that is the native path's bookkeeping, not the deck's.
     */
    if (!this.audio) this.currentVideoId = null;
    logInternalInfo("AudioEngine.releaseIframePlayer", {});
  }

  seekTo(seconds: number): void {
    if (!Number.isFinite(seconds)) return;
    if (this.rustTrackId) {
      void rustAudio.seek(Math.max(0, seconds)).catch((error: unknown) => {
        rustAudio.warn("AudioEngine rust seek failed", error);
      });
      return;
    }
    if (this.audio) {
      this.audio.currentTime = Math.min(
        Math.max(0, seconds),
        Number.isFinite(this.audio.duration) ? this.audio.duration : seconds,
      );
    }
    this.player?.seekTo(Math.max(0, seconds), true);
  }

  setVolume(level: number): void {
    const nextVolume = Math.min(1, Math.max(0, level));
    const beforePlayerVolume = this.player ? this.player.getVolume() : null;
    const beforeAudioVolume = this.audio?.volume ?? null;
    this.volume = nextVolume;
    this.applyOutputVolume();
    logInternalInfo("AudioEngine.setVolume", {
      requestedLevel: level,
      volume: this.volume,
      hasNativeAudio: Boolean(this.audio),
      hasYouTubePlayer: Boolean(this.player),
      beforeAudioVolume,
      afterAudioVolume: this.audio?.volume ?? null,
      beforePlayerVolume,
      afterPlayerVolume: this.player ? this.player.getVolume() : null,
      muted: this.muted,
      playerMuted: this.player?.isMuted() ?? null,
      currentVideoId: this.currentVideoId,
    });
  }

  getVolume(): number {
    return this.volume;
  }

  setMuted(isMuted: boolean): void {
    const beforeAudioMuted = this.audio?.muted ?? null;
    const beforePlayerMuted = this.player?.isMuted() ?? null;
    this.muted = isMuted;
    if (this.audio) this.audio.muted = isMuted;
    if (isMuted) {
      this.player?.mute();
    } else {
      this.player?.unMute();
    }
    this.applyOutputVolume();
    logInternalInfo("AudioEngine.setMuted", {
      muted: this.muted,
      hasNativeAudio: Boolean(this.audio),
      hasYouTubePlayer: Boolean(this.player),
      beforeAudioMuted,
      afterAudioMuted: this.audio?.muted ?? null,
      beforePlayerMuted,
      afterPlayerMuted: this.player?.isMuted() ?? null,
      currentVideoId: this.currentVideoId,
    });
  }

  isMuted(): boolean {
    return this.muted;
  }

  getCurrentTime(): number {
    /*
     * Rust reports one position for one engine, so an engine that is not the one it loaded
     * would otherwise read another tab's playhead. The track id is the discriminator: the
     * events carry it, and only the engine that loaded it matches.
     */
    if (this.rustTrackId) {
      return rustAudio.getPositionTrackId() === this.rustTrackId ? rustAudio.getCurrentTime() : 0;
    }
    if (this.audio) return this.audio.currentTime;
    return this.player?.getCurrentTime() ?? 0;
  }

  getDuration(): number {
    if (this.rustTrackId) return this.rustDurationSec;
    if (this.audio) return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
    return this.player?.getDuration() ?? 0;
  }

  /**
   * Cues a track on the standby deck so the next transition has nothing to load.
   *
   * Idempotent and fire-and-forget: called repeatedly from the playback ticker, and a failure
   * only means the transition falls back to the ordinary load path. Not available on the
   * native-audio path, which serves offline files that have no load latency to hide.
   */
  preloadNext(videoId: string): void {
    if (this.useRustAudio) return;
    if (this.useNativeAudio || this.audio) return;
    if (!videoId || videoId === this.currentVideoId) return;
    if (this.standbyVideoId === videoId || this.standbyPromise) return;

    this.standbyPromise = this.cueStandby(videoId)
      .catch((error: unknown) => {
        logInternalWarn("AudioEngine.preloadNext failed", {
          videoId,
          error: error instanceof Error ? error.message : String(error),
        });
        this.discardStandby();
      })
      .finally(() => {
        this.standbyPromise = null;
      });
  }

  /**
   * Decodes a track onto the Rust standby deck.
   *
   * The IFrame path preloads from a video id alone, because the embed resolves its own stream.
   * Rust needs the bytes, so this is driven from `PlayerController.warmNextTrack` — which was
   * already resolving the next track's `StreamData` ahead of time for the native engine. The
   * only new work is handing what it found to a second deck instead of holding it in a slot.
   */
  async preloadRustTrack(
    trackId: string,
    source: RustAudioSource,
    durationSec: number,
  ): Promise<void> {
    if (!this.useRustAudio || !trackId || trackId === this.rustTrackId) return;
    if (this.rustStandbyTrackId === trackId) return;

    routeRustEnded();
    this.rustStandbyDurationSec = await rustAudio.load(trackId, source, durationSec, true);
    this.rustStandbyTrackId = trackId;
    logInternalInfo("AudioEngine rust preloaded", { trackId });
  }

  /** Whether a transition to `videoId` can skip loading entirely. */
  hasPreloaded(videoId: string): boolean {
    if (this.useRustAudio) return this.rustStandbyTrackId === videoId;
    return this.standbyPlayer !== null && this.standbyVideoId === videoId;
  }

  /**
   * Hands playback to the preloaded deck, optionally over a crossfade.
   *
   * With `fadeMs` at 0 this is the gapless case: the standby is already cued, so starting it
   * and stopping the outgoing deck happen in the same tick. Above 0 both decks play at once
   * and their volumes are ramped past each other, which is a real crossfade rather than a
   * fade-out followed by a fade-in.
   *
   * Returns false when there is nothing preloaded, leaving the caller to load normally.
   */
  async transitionToPreloaded(videoId: string, fadeMs: number): Promise<boolean> {
    if (!this.hasPreloaded(videoId)) return false;

    if (this.useRustAudio) {
      /*
       * The whole transition happens in Rust: the standby deck is already decoded, so a zero
       * fade starts it and stops the outgoing one in the same tick, and a non-zero fade ramps
       * their volumes past each other on the audio thread. This is the case the `<audio>` path
       * could never serve — one element, one body, nothing to fade against.
       */
      const swapped = await rustAudio.transition(videoId, Math.max(0, Math.round(fadeMs)));
      if (!swapped) {
        this.rustStandbyTrackId = null;
        return false;
      }
      this.rustStandbyTrackId = null;
      this.rustTrackId = videoId;
      this.rustDurationSec = this.rustStandbyDurationSec;
      this.rustStandbyDurationSec = 0;
      this.currentVideoId = videoId;
      this.loadRequestId += 1;
      rustAudio.adoptTransitioned(videoId, this.rustDurationSec);
      logInternalInfo("AudioEngine.transitionToPreloaded rust", { videoId, fadeMs });
      return true;
    }

    const outgoing = this.player;
    const outgoingHost = this.playerHost;
    const incoming = this.standbyPlayer!;
    const targetPercent = this.muted ? 0 : Math.round(this.volume * 100);

    this.cancelFade();
    incoming.setVolume(fadeMs > 0 ? 0 : targetPercent);
    if (this.muted) {
      incoming.mute();
    } else {
      incoming.unMute();
    }
    incoming.setPlaybackRate?.(this.playbackRate);
    incoming.playVideo();

    // Swap the decks first: everything else on the engine addresses `this.player`, and the
    // state events from the incoming deck must be recognised as this engine's playback the
    // moment it starts making sound.
    this.player = incoming;
    this.playerHost = this.standbyHost;
    this.standbyPlayer = outgoing;
    this.standbyHost = outgoingHost;
    this.standbyVideoId = null;
    this.currentVideoId = videoId;
    this.loadRequestId += 1;

    if (fadeMs > 0) {
      await this.rampAcross(outgoing, incoming, targetPercent, fadeMs);
    }

    outgoing?.stopVideo();
    logInternalInfo("AudioEngine.transitionToPreloaded", { videoId, fadeMs });
    return true;
  }

  /** Ramps the outgoing deck down and the incoming deck up over the same window. */
  private rampAcross(
    outgoing: YouTubePlayer | null,
    incoming: YouTubePlayer,
    targetPercent: number,
    fadeMs: number,
  ): Promise<void> {
    return new Promise((resolve) => {
      const startedAt = performance.now();
      const step = () => {
        const progress = Math.min(1, (performance.now() - startedAt) / fadeMs);
        /*
         * Equal-power rather than linear. Two linear ramps crossing at half volume sum to a
         * noticeable dip in the middle, because loudness is not proportional to amplitude;
         * the sine/cosine pair holds perceived level constant across the transition.
         */
        outgoing?.setVolume(Math.round(targetPercent * Math.cos((progress * Math.PI) / 2)));
        incoming.setVolume(Math.round(targetPercent * Math.sin((progress * Math.PI) / 2)));

        if (progress >= 1) {
          this.fadeFrameId = null;
          resolve();
          return;
        }
        this.fadeFrameId = window.requestAnimationFrame(step);
      };
      this.fadeFrameId = window.requestAnimationFrame(step);
    });
  }

  private async cueStandby(videoId: string): Promise<void> {
    // There is a next transition again, so the deck must survive to serve it.
    this.cancelStandbyTeardown();
    if (!this.standbyPlayer) {
      const created = await this.createPlayer();
      this.standbyPlayer = created.player;
      this.standbyHost = created.host;
      // Silent until a transition ramps it up: a standby that inherited the output volume
      // would be audible the instant YouTube decided to start it on its own.
      this.standbyPlayer.setVolume(0);
      this.standbyPlayer.mute();
    }

    this.standbyPlayer.cueVideoById(videoId);
    this.standbyVideoId = videoId;
    logInternalInfo("AudioEngine.preloadNext cued", { videoId });
  }

  private discardStandby(): void {
    this.standbyVideoId = null;
    this.standbyPlayer?.stopVideo();
    this.scheduleStandbyTeardown();
  }

  /**
   * Frees the standby deck after a spell of not playing.
   *
   * The standby is a second YouTube IFrame — a whole video pipeline — kept alive purely so the
   * *next* transition is gapless. While paused there is no next transition to be gapless about,
   * and stopping its video does not release the frame; only destroying it does.
   *
   * Deferred rather than immediate because pause/play within a track is common and rebuilding
   * the deck costs a network round-trip. The cost of getting this wrong is one audible gap
   * after a long pause, not a failure: `cueStandby` recreates the deck on demand.
   */
  private scheduleStandbyTeardown(): void {
    if (!this.standbyPlayer || this.standbyIdleTimerId !== null) return;

    this.standbyIdleTimerId = window.setTimeout(() => {
      this.standbyIdleTimerId = null;
      // Playback resumed while the timer was pending; the deck is in use again.
      if (playbackOwner === this && this.player?.getPlayerState() === window.YT?.PlayerState.PLAYING) {
        return;
      }
      this.destroyStandby();
    }, STANDBY_IDLE_TEARDOWN_MS);
  }

  private cancelStandbyTeardown(): void {
    if (this.standbyIdleTimerId === null) return;
    window.clearTimeout(this.standbyIdleTimerId);
    this.standbyIdleTimerId = null;
  }

  private destroyStandby(): void {
    if (!this.standbyPlayer && !this.standbyHost) return;
    this.standbyVideoId = null;
    this.standbyPlayer?.destroy();
    this.standbyHost?.remove();
    this.standbyPlayer = null;
    this.standbyHost = null;
    logInternalInfo("AudioEngine.destroyStandby", {});
  }

  private cancelFade(): void {
    if (this.fadeFrameId !== null) {
      window.cancelAnimationFrame(this.fadeFrameId);
      this.fadeFrameId = null;
    }
  }

  /**
   * Decodes a track onto the active Rust deck.
   *
   * The `await` here is over the decoder reading the container header, not over the download:
   * a stream is published to Rust as an empty buffer sized from the URL's own `clen` and filled
   * behind this call, so what a click waits for is the first 128 KiB rather than the whole song.
   * That is the defect this engine exists to fix — the `<audio>` path could not be pointed at a
   * body until enough of it had been published to decode.
   */
  private async loadRustAudio(
    videoId: string,
    source: RustAudioSource,
    durationSec: number,
  ): Promise<void> {
    const requestId = ++this.loadRequestId;
    this.iframeFallbackActive = false;
    routeRustEnded();
    /*
     * Both entry points come through here, and this one has to run before the media server is
     * released: the element it tears down is the only thing that could still be reading from
     * the server, and clearing the bodies underneath a live range request would 404 the song
     * that is playing.
     */
    this.releaseNativeAudio();
    if (!mediaServerReleased) {
      mediaServerReleased = true;
      void rustAudio.releaseMediaServer()
        .then((released) => {
          if (released > 0) logInternalInfo("AudioEngine media server released", { released });
        })
        .catch((error: unknown) => {
          // Nothing depends on this landing — it reclaims memory, it does not enable playback.
          mediaServerReleased = false;
          rustAudio.warn("AudioEngine media server release failed", error);
        });
    }

    // Dropping the standby first: it holds a decoded song, and a load that is not a transition
    // means whatever was queued behind the old track is no longer next.
    if (this.rustStandbyTrackId) {
      this.rustStandbyTrackId = null;
      this.rustStandbyDurationSec = 0;
      await rustAudio.dropStandby().catch(() => {});
    }

    const duration = await rustAudio.load(videoId, source, durationSec);
    if (requestId !== this.loadRequestId) return;

    this.rustTrackId = videoId;
    this.rustDurationSec = duration;
    this.currentVideoId = videoId;
    await rustAudio.setVolume(this.volume, this.muted);
    await rustAudio.setRate(this.playbackRate);
    logInternalInfo("AudioEngine rust audio loaded", {
      videoId,
      kind: source.kind,
      durationSec: duration,
    });
  }

  private releaseRustAudio(): void {
    if (!this.rustTrackId && !this.rustStandbyTrackId) return;
    /*
     * There is one Rust engine behind every tab's `AudioEngine`, so `stop` is not this object's
     * to call unless it is the one making sound. Closing a background tab disposes its engine,
     * and without this that would cut off the tab that is actually playing. Its own bookkeeping
     * is cleared either way — those decks belong to somebody else now.
     */
    const ownsRustPlayback = playbackOwner === null || playbackOwner === this;
    this.rustTrackId = null;
    this.rustStandbyTrackId = null;
    this.rustDurationSec = 0;
    this.rustStandbyDurationSec = 0;
    if (!ownsRustPlayback) return;
    void rustAudio.stop().catch((error: unknown) => {
      rustAudio.warn("AudioEngine rust stop failed", error);
    });
  }

  private async loadNativeAudio(
    videoId: string,
    audioData?: ArrayBuffer,
    mimeType?: string,
    sourceUrl?: string,
  ): Promise<void> {
    const requestId = ++this.loadRequestId;
    this.iframeFallbackActive = false;
    // This is the path that publishes bodies to the media server, so a later switch back to the
    // Rust engine has something to release again.
    mediaServerReleased = false;
    this.releaseNativeAudio();

    const bytes = audioData ? new Uint8Array(audioData) : null;
    const detectedMimeType = mimeType || (bytes ? detectAudioMimeType(bytes) : "audio/mp4");
    const objectUrl = sourceUrl ?? URL.createObjectURL(new Blob([bytes ?? new Uint8Array()], {
      type: detectedMimeType,
    }));
    const audio = new Audio();
    audio.preload = "auto";
    audio.src = objectUrl;
    audio.addEventListener("ended", () => this.onEnded?.());
    audio.addEventListener("error", () => {
      logInternalError(
        "AudioEngine native audio error",
        new Error(`Native audio failed with media error ${audio.error?.code ?? "unknown"}.`),
        { videoId },
      );
    });
    this.audio = audio;
    this.audioObjectUrl = sourceUrl ? null : objectUrl;
    this.currentVideoId = videoId;
    this.applyNativeAudioSettings();

    await new Promise<void>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        cleanup();
        reject(new Error("Timed out while loading native audio."));
      }, 30_000);
      const cleanup = () => {
        window.clearTimeout(timeoutId);
        audio.removeEventListener("canplay", handleReady);
        audio.removeEventListener("error", handleError);
      };
      const handleReady = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error(`Unable to decode native audio (${audio.error?.code ?? "unknown"}).`));
      };
      audio.addEventListener("canplay", handleReady, { once: true });
      audio.addEventListener("error", handleError, { once: true });
      audio.load();
    });

    if (requestId !== this.loadRequestId) return;
    logInternalInfo("AudioEngine native audio loaded", {
      videoId,
      byteLength: audioData?.byteLength ?? null,
      mimeType: detectedMimeType,
      hasSourceUrl: Boolean(sourceUrl),
    });
  }

  private applyNativeAudioSettings(): void {
    if (!this.audio) return;
    this.audio.volume = this.muted ? 0 : this.volume;
    this.audio.muted = this.muted;
    this.audio.playbackRate = this.playbackRate;
    /*
     * Pitch correction on. Without it a speed change transposes the music, which is fine for
     * a podcast and unacceptable for a song. The property is prefixed on WebKit and absent in
     * older engines, so it is set defensively rather than assumed.
     */
    const pitchPreserving = this.audio as HTMLAudioElement & {
      preservesPitch?: boolean;
      webkitPreservesPitch?: boolean;
    };
    if ("preservesPitch" in pitchPreserving) pitchPreserving.preservesPitch = true;
    if ("webkitPreservesPitch" in pitchPreserving) pitchPreserving.webkitPreservesPitch = true;
  }

  /** 1 is normal speed. Applies to whichever backend is currently playing. */
  setPlaybackRate(rate: number): void {
    this.playbackRate = Math.min(4, Math.max(0.25, rate));
    if (this.useRustAudio && !this.iframeFallbackActive) {
      void rustAudio.setRate(this.playbackRate).catch((error: unknown) => {
        rustAudio.warn("AudioEngine rust rate failed", error);
      });
    }
    this.applyNativeAudioSettings();
    this.player?.setPlaybackRate?.(this.playbackRate);
  }

  getPlaybackRate(): number {
    return this.playbackRate;
  }

  private applyOutputVolume(): void {
    if (this.rustTrackId) {
      void rustAudio.setVolume(this.volume, this.muted).catch((error: unknown) => {
        rustAudio.warn("AudioEngine rust volume failed", error);
      });
    }
    if (this.audio) {
      this.audio.volume = this.muted ? 0 : this.volume;
    }
    this.player?.setVolume(this.getOutputVolumePercent());
  }

  private getOutputVolumePercent(): number {
    return this.muted ? 0 : Math.round(this.volume * 100);
  }

  private releaseNativeAudio(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
      this.audio = null;
    }
    if (this.audioObjectUrl) {
      URL.revokeObjectURL(this.audioObjectUrl);
      this.audioObjectUrl = null;
    }
  }

  private async ensurePlayer(): Promise<YouTubePlayer> {
    if (this.player) return this.player;
    if (this.playerPromise) return this.playerPromise;

    this.playerPromise = this.createPlayer().then((created) => {
      this.playerHost = created.host;
      return created.player;
    });
    try {
      this.player = await this.playerPromise;
      return this.player;
    } finally {
      this.playerPromise = null;
    }
  }

  private claimPlayback(): number {
    const claimId = ++playbackClaimId;
    playbackOwner = this;

    for (const engine of audioEngines) {
      if (engine !== this) engine.pauseForPlaybackClaim();
    }
    for (const media of document.querySelectorAll<HTMLMediaElement>("audio, video")) {
      media.pause();
    }

    return claimId;
  }

  private pauseForPlaybackClaim(): void {
    if (this.rustTrackId) void rustAudio.pause().catch(() => {});
    this.audio?.pause();
    this.player?.pauseVideo();
    // The standby is cued rather than playing, but a mid-crossfade claim would otherwise
    // leave the outgoing deck — now the standby — running under the new owner's audio.
    this.standbyPlayer?.pauseVideo();
  }

  private async createPlayer(): Promise<{ player: YouTubePlayer; host: HTMLElement }> {
    await loadYouTubeIframeApi();
    if (!window.YT?.Player) {
      throw new Error("YouTube player API loaded without a Player constructor.");
    }

    /*
     * The IFrame player has to exist, at a real size, on screen.
     *
     * YouTube refuses to start playback in a player that is display:none, visibility:hidden or
     * effectively zero-sized, so it cannot simply be hidden — which is why this is a 200px box
     * held at 1% opacity rather than removed. That opacity is not enough on its own: a bright
     * video thumbnail is still legible over a flat background, and it showed as a faded square
     * in the bottom-right corner from the moment the first song played.
     *
     * A negative z-index puts it behind the app's own opaque background instead. The element
     * keeps its position, its size and its opacity, so none of the heuristics YouTube uses to
     * detect a hidden player change — it is simply painted underneath something.
     */
    const host = document.createElement("div");
    host.style.position = "fixed";
    /*
     * Inset rather than flush to the corner: html/body/#root are transparent so the window's
     * rounded corners cut out, which leaves a notch where a corner-pinned box would show
     * through from behind the app rather than being covered by it.
     */
    host.style.right = "24px";
    host.style.bottom = "24px";
    host.style.width = "200px";
    host.style.height = "200px";
    host.style.opacity = "0.01";
    host.style.pointerEvents = "none";
    host.style.zIndex = "-1";
    const target = document.createElement("div");
    host.appendChild(target);
    document.body.appendChild(host);

    return new Promise((resolve, reject) => {
      let player: YouTubePlayer;
      const timeoutId = window.setTimeout(() => {
        player?.destroy();
        host.remove();
        reject(new Error("Timed out while creating the YouTube player."));
      }, 15_000);

      player = new window.YT!.Player(target, {
        width: 200,
        height: 200,
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          enablejsapi: 1,
          origin: window.location.origin,
          playsinline: 1,
          widget_referrer: "https://music.youtube.com/",
        },
        events: {
          onReady: () => {
            window.clearTimeout(timeoutId);
            allowYouTubeIframePlayback(host);
            player.setVolume(this.getOutputVolumePercent());
            if (this.muted) {
              player.mute();
            } else {
              player.unMute();
            }
            logInternalInfo("AudioEngine YouTube player ready");
            resolve({ player, host });
          },
          onStateChange: (event) => {
            /*
             * Events from the standby deck are not this engine's playback.
             *
             * Without this check a cue on the standby resolves a waiter meant for the deck
             * that is actually playing, and stopping the outgoing deck after a crossfade
             * reports ENDED — which would advance the queue a second time, skipping a track
             * on every transition.
             */
            const isActiveDeck = player === this.player;
            logInternalInfo("AudioEngine YouTube player state", {
              state: event.data,
              videoId: this.currentVideoId,
              playerVideoId: player.getVideoData().video_id ?? null,
              deck: isActiveDeck ? "active" : "standby",
            });
            if (!isActiveDeck) return;

            this.resolveStateWaiters(event.data, player.getVideoData().video_id ?? null);
            if (event.data === window.YT!.PlayerState.ENDED) {
              this.onEnded?.();
            }
          },
          onError: (event) => {
            const error = new Error(`YouTube player error ${event.data}`);
            if (player !== this.player) {
              // A standby that fails to cue is not an error the user can see: the transition
              // simply falls back to loading the track the ordinary way.
              logInternalWarn("AudioEngine standby deck error", {
                videoId: this.standbyVideoId,
                code: event.data,
              });
              this.discardStandby();
              return;
            }
            this.rejectStateWaiters(error);
            logInternalError("AudioEngine YouTube player error", error, {
              videoId: this.currentVideoId,
            });
          },
        },
      });
    });
  }

  private waitForPlayerState(
    states: number[],
    timeoutMs: number,
    acceptCurrentState = true,
    videoId: string | null = null,
  ): Promise<void> {
    if (acceptCurrentState) {
      const currentState = this.player?.getPlayerState();
      const currentVideoId = this.player?.getVideoData().video_id ?? null;
      if (
        currentState !== undefined
        && states.includes(currentState)
        && (!videoId || currentVideoId === videoId)
      ) {
        return Promise.resolve();
      }
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        states: new Set(states),
        videoId,
        resolve,
        reject,
        timeoutId: 0,
      };

      waiter.timeoutId = window.setTimeout(() => {
        this.stateWaiters.delete(waiter);
        reject(new Error(`Timed out waiting for YouTube player state: ${states.join(", ")}.`));
      }, timeoutMs);

      this.stateWaiters.add(waiter);
    });
  }

  private resolveStateWaiters(state: number, videoId: string | null): void {
    for (const waiter of this.stateWaiters) {
      if (
        !waiter.states.has(state)
        || (waiter.videoId !== null && waiter.videoId !== videoId)
      ) {
        continue;
      }
      window.clearTimeout(waiter.timeoutId);
      this.stateWaiters.delete(waiter);
      waiter.resolve();
    }
  }

  private rejectStateWaiters(error: Error): void {
    for (const waiter of this.stateWaiters) {
      window.clearTimeout(waiter.timeoutId);
      waiter.reject(error);
    }
    this.stateWaiters.clear();
  }
}
