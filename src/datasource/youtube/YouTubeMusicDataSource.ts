import { invoke } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
/*
 * Statically imported, deliberately.
 *
 * 1.2.0 loaded this lazily to keep ~650 kB of InnerTube client out of the startup parse. It
 * shipped, and sign-in failed on every updated install with "cannot access 'X' before
 * initialization" — a temporal-dead-zone error out of the split chunk. Reverted in 1.2.1:
 * the startup win is real but it is not worth a client nobody can sign in to, and the split
 * needs to be reproduced and tested against a live session before it goes back.
 */
import { ClientType, Innertube, Platform, Types, YTNodes } from "youtubei.js";
import { getAppSetting, removeAppSetting, setAppSetting } from "../../internal/appSettings";
import { clearCache, getCachedJson, setCachedJson } from "../../internal/cache";
import { logInternalDebug, logInternalError, logInternalInfo, logInternalWarn } from "../../internal/logging";
import { mintPoToken } from "./poToken";
import { AuthExpiredError, DataSource, type StreamData } from "../DataSource";
import type {
  AccountOption,
  ArtistNotificationLevel,
  BrowseLink,
  BrowsePage,
  BrowseShelf,
  BrowseSurface,
  BrowseTarget,
  Album,
  Artist,
  ArtistPage,
  ArtistReference,
  AuthPrompt,
  FeedNotification,
  LibrarySnapshot,
  Lyrics,
  LyricsSourceAttempt,
  Playlist,
  ResolvedLink,
  SearchCategory,
  SearchResults,
  AuthStage,
  TrackPage,
  Track,
  TrackRating,
} from "../types";
import { collectArtworkCandidates, getVideoArtworkFallback, selectArtworkUrl } from "./artwork";
import {
  LYRICS_SOURCES,
  type LyricsSource,
  pickBestLyrics,
  planLyricsWaves,
  skippedAttempt,
  sortAttempts,
  unmetPrecondition,
} from "./lyricsSources";
import { getPreferredLyricsSourceId } from "../../internal/lyricsSourcePreference";
import { isVideoId, looksLikeYouTubeLink, parseYouTubeLink } from "./links";
import { isTrackDownloaded } from "../../player/offlineStore";
import {
  getDownloadQuality,
  getStreamingQuality,
  selectFormatForQuality,
  type AudioQuality,
} from "../../internal/audioQuality";
import {
  usesAuthenticatedStreaming,
  usesYouTubeScrobbling,
} from "../../ui/settings/youtubeAccount";
import { usesRustAudioEngine } from "../../ui/settings/audioEngine";
import {
  getLiveCookie,
  notifyAuthRejected,
  setAuthConfirmedHandler,
  setAuthRejectedHandler,
  setLiveCookie,
  tauriFetch,
} from "./tauriFetch";

type ClientLabel = "music" | "web" | "download";
type NativeAudioPayload = {
  bodyBase64: string;
  mimeType: string;
};

type NativeAudioSourcePayload = {
  url: string;
  mimeType: string;
  byteLength: number;
};

type MusicColumn = {
  title?: {
    toString(): string;
    runs?: Array<{
      text?: string;
      endpoint?: unknown;
      navigationEndpoint?: unknown;
    }>;
  };
};

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

type MusicItem = {
  id?: string;
  title?: string | { toString(): string };
  /** Artist rows carry their label here instead of `title`. */
  name?: string;
  item_type?: string;
  menu?: unknown;
  artists?: Array<{ name?: string; channel_id?: string; endpoint?: { payload?: { browseId?: string } } }>;
  authors?: Array<{ name?: string; channel_id?: string; endpoint?: { payload?: { browseId?: string } } }>;
  author?: { name?: string; channel_id?: string; endpoint?: { payload?: { browseId?: string } } };
  subtitle?: {
    toString(): string;
    runs?: Array<{ text?: string; endpoint?: { payload?: { browseId?: string } } }>;
  };
  thumbnail?: Array<{ url?: string; width?: number; height?: number }>
    | { contents?: Array<{ url?: string; width?: number; height?: number }> }
    | null;
  thumbnails?: Array<{ url?: string; width?: number; height?: number }>;
  endpoint?: {
    payload?: {
      browseId?: string;
      videoId?: string;
    };
  };
  on_tap?: unknown;
  views?: string;
  subscribers?: string;
  year?: string;
  header?: {
    title?: { toString(): string };
  };
  subtitle_badges?: Array<{ label?: string }>;
  end_icon_type?: string;
  fixed_columns?: MusicColumn[];
  flex_columns?: MusicColumn[];
};

type ParsedMusicResponse = {
  contents_memo?: {
    getType(...types: unknown[]): MusicItem[];
    entries(): IterableIterator<[string, unknown[]]>;
  };
  continuation_contents_memo?: {
    getType(...types: unknown[]): MusicItem[];
    entries(): IterableIterator<[string, unknown[]]>;
  };
};

type MusicContinuation = {
  key: string;
  load(): Promise<unknown>;
};

type YouTubeMusicPlaylistPage = {
  items?: MusicItem[];
  contents?: MusicItem[];
  has_continuation?: boolean;
  description?: string | { toString(): string };
  getContinuation(): Promise<YouTubeMusicPlaylistPage>;
};

type PlaylistPageSession = {
  playlistId: string;
  playlistPage: YouTubeMusicPlaylistPage;
  seenTrackIds: Set<string>;
  expiresAt: number;
};

type UpNextItem = {
  video_id?: string;
  title?: { toString(): string };
  author?: string;
  artists?: Array<{ name?: string; channel_id?: string; endpoint?: unknown; navigationEndpoint?: unknown }>;
  thumbnail?: Array<{ url?: string; width?: number; height?: number }>;
  duration?: { seconds?: number };
  primary?: UpNextItem | null;
};

type LrcLibTrack = {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  syncedLyrics?: string | null;
};

type BetterLyricsResponse = {
  ttml?: string | null;
};

/* Rank used to live on the result as a `priority` number that nothing ever read — the winner
   was really decided by the order of an array literal. It is now the LYRICS_SOURCES table. */
type LyricsProviderResult = Lyrics;

type RawLikeEndpoint = {
  status?: string;
  target?: string | {
    playlistId?: string;
    videoId?: string;
  };
  params?: string;
  likeParams?: string;
  dislikeParams?: string;
  removeLikeParams?: string;
};

type CallableEndpoint = {
  call(actions: Innertube["actions"], args?: Record<string, unknown>): Promise<{
    success?: boolean;
    status_code?: number;
  }>;
  payload?: unknown;
};

type AttestationCommand = {
  engagementType?: string;
  ids?: Array<Record<string, unknown>>;
};

type LibraryToggleEndpoint = {
  isToggled?: boolean;
  endpoint?: CallableEndpoint;
  toggledEndpoint?: CallableEndpoint;
  iconType?: string;
  tooltip?: string;
  toggledTooltip?: string;
};

type RawServiceEndpoint = {
  commandExecutorCommand?: {
    commands?: RawServiceEndpoint[];
  };
  feedbackEndpoint?: {
    feedbackToken?: string;
    cpn?: string;
    isFeedbackTokenUnencrypted?: boolean;
    shouldMerge?: boolean;
  };
  likeEndpoint?: RawLikeEndpoint;
};

type RawToggleButtonRenderer = {
  isToggled?: boolean;
  defaultIcon?: { iconType?: string };
  defaultTooltip?: string;
  toggledTooltip?: string;
  defaultServiceEndpoint?: RawServiceEndpoint;
  toggledServiceEndpoint?: RawServiceEndpoint;
};

type RawToggleMenuServiceItemRenderer = {
  isToggled?: boolean;
  defaultIcon?: { iconType?: string };
  toggledIcon?: { iconType?: string };
  defaultText?: unknown;
  toggledText?: unknown;
  defaultServiceEndpoint?: RawServiceEndpoint;
  toggledServiceEndpoint?: RawServiceEndpoint;
};

type AccountCandidate = {
  accountIndex: number;
  name?: string;
  artworkUrl?: string;
  onBehalfOfUser?: string;
  serializedDelegationContext?: string;
  selected?: boolean;
};

/**
 * Stable identity for an account across reloads.
 *
 * The three fields below are exactly what `useAccountCandidate` applies to the session, so two
 * candidates with the same key are the same account as far as YouTube is concerned. This was
 * already being built inline at four call sites; it is one function now so a switch and a
 * comparison cannot disagree about what "the same account" means.
 */
function accountCandidateKey(candidate: {
  accountIndex: number;
  onBehalfOfUser?: string | null;
  serializedDelegationContext?: string | null;
}): string {
  return [
    candidate.accountIndex,
    candidate.onBehalfOfUser ?? "",
    candidate.serializedDelegationContext ?? "",
  ].join(":");
}

type LibraryResponses = {
  client: Innertube;
  account: AccountCandidate;
  libraryLanding: unknown;
  historyResponse: unknown;
};

const LIKED_SONGS_PLAYLIST_ID = "LM";
/** Everything a browse shelf can meaningfully hold. */
/** Must match YOUTUBE_LOGIN_WINDOW in src-tauri/src/lib.rs; cancelling closes this window. */
const YOUTUBE_LOGIN_WINDOW_LABEL = "youtube-music-login";

/** Mirrors `SignInResult` in src-tauri/src/lib.rs. */
interface SignInResult {
  cookie: string;
  /** False when this is the same Google account recovering a lapsed session. */
  accountChanged: boolean;
}

const BROWSE_ITEM_TYPES = new Set(["song", "video", "album", "playlist", "artist"]);
/*
 * v6: v5 snapshots were capped at the first page of each section, so they are discarded rather
 * than shown as a complete library until the background refresh replaces them.
 * v7: artist photos in v6 could be the page banner, and they are carried forward between syncs,
 * so the stored ones have to go with it.
 * v8: same again — v7 could hold another artist's photo entirely.
 * v9: and v8 could hold a cropped one; artist pictures are carried between syncs, so they only
 * change when the key does.
 */
// v10: album names are no longer guessed from whatever column was left over, so entries
// parsed under the old rule carry release years and play counts where an album should be.
// v11: tracks now carry `albumId`, so entries parsed before it have no album to open.
const LIBRARY_CACHE_KEY = "youtube-music:library:v11";
/** The account the user picked by hand, which outranks the automatic probe. */
/**
 * Content playback nonce — 16 characters from the alphabet YouTube's own player draws on.
 *
 * One per play. It is what ties the "a play started" ping to the watchtime pings that follow;
 * reusing one across tracks would report them as the same play.
 */
function createPlaybackNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte & 63]).join("");
}

const SELECTED_ACCOUNT_STORAGE_KEY = "youtube-music:selected-account";
// v7: artist pictures come from named header fields now — foreground, then thumbnail, then the
// channel avatar — so anything cached under the older shape-and-crop rules has to go.
const ARTIST_CACHE_VERSION = "v9";
const ARTIST_SUBSCRIPTION_OVERRIDE_MS = 60_000;
const PLAYLIST_PAGE_SESSION_TTL_MS = 10 * 60_000;
const PLAYLIST_TRACK_CACHE_VERSION = "v6";
const PLAYLIST_EMPTY_RETRY_DELAYS_MS = [0, 600, 1_500];

class YouTubeMusicAuthError extends AuthExpiredError {}

export class YouTubeMusicDataSource extends DataSource {
  private musicClientPromise: Promise<Innertube> | null = null;
  private webClientPromise: Promise<Innertube> | null = null;
  private downloadClientPromise: Promise<Innertube> | null = null;
  /*
   * An accessor rather than a field, so the ~30 readers of `this.musicCookie` observe the
   * rotations the proxy folds in instead of the value captured at sign-in. Both sides of the
   * process now agree on one cookie: Rust stamps it onto requests, this reads it back.
   */
  private get musicCookie(): string | null {
    return getLiveCookie();
  }

  private set musicCookie(cookie: string | null) {
    setLiveCookie(cookie);
  }

  private musicAccountIndex = 0;
  private musicOnBehalfOfUser: string | null = null;
  /** The play currently being reported to YouTube history, or null when none is. */
  private playReport: {
    trackId: string;
    cpn: string;
    playbackUrl: string;
    watchtimeUrl: string;
    startedAt: number;
  } | null = null;
  private musicSerializedDelegationContext: string | null = null;
  private musicAccountName = "YouTube Music";
  private musicAccountArtworkUrl: string | null = null;
  /** Candidates from the last discovery pass, so the switcher does not refetch on every open. */
  private accountCandidateCache: AccountCandidate[] | null = null;
  /*
   * Mirrors the durable copy of `SELECTED_ACCOUNT_STORAGE_KEY` so a library refresh — which
   * reads this every time — pays a Tauri round trip once per process, not once per refresh.
   * `undefined` means "not read yet"; `null` is a real, resolved "no preference".
   */
  private preferredAccountKeyCache: string | null | undefined;
  private libraryRefreshPromise: Promise<LibrarySnapshot> | null = null;
  private readonly albumRefreshPromises = new Map<string, Promise<Track[]>>();
  private readonly playlistRefreshPromises = new Map<string, Promise<Track[]>>();
  private readonly playlistPageSessions = new Map<string, PlaylistPageSession>();
  private readonly trackRefreshPromises = new Map<string, Promise<Track>>();
  private readonly searchRefreshPromises = new Map<string, Promise<Track[]>>();
  private readonly mixedSearchRefreshPromises = new Map<string, Promise<SearchResults>>();
  private readonly artistRefreshPromises = new Map<string, Promise<ArtistPage>>();
  private readonly suggestionRefreshPromises = new Map<string, Promise<string[]>>();
  private readonly recommendationRefreshPromises = new Map<string, Promise<Track[]>>();
  private readonly lyricsRefreshPromises = new Map<string, Promise<Lyrics>>();
  private readonly artistSubscriptionOverrides = new Map<string, { subscribed: boolean; expiresAt: number }>();

  constructor() {
    super();
    this.setupJavaScriptEvaluator();
  }

  private setupJavaScriptEvaluator() {
    Platform.shim.eval = async (data: Types.BuildScriptResult, env: Record<string, Types.VMPrimative>) => {
      logInternalDebug("YouTubeMusicDataSource.javascriptEvaluator", {
        envKeys: Object.keys(env),
        outputLength: data.output?.length ?? 0,
      });

      return new Function(data.output)();
    };
  }

  private getSessionOptions(retrievePlayer = true) {
    return {
      fetch: tauriFetch,
      user_agent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
      cookie: this.musicCookie ?? (typeof document !== "undefined" ? document.cookie : undefined),
      account_index: this.musicAccountIndex,
      on_behalf_of_user: this.musicOnBehalfOfUser ?? undefined,
      retrieve_player: retrievePlayer,
      generate_session_locally: true,
      /*
       * This app never reads the cold-config/experiment-flag data this fetches — proven by
       * `refreshMusicClientMetadata` deleting it outright right after client creation — and the
       * request 401s unconditionally for every client type here regardless. Retrieving it was
       * a POST that always failed, on every client, on every session.
       */
      retrieve_innertube_config: false,
    } as const;
  }

  /**
   * Rewrites `cver` to the client version this session actually used.
   *
   * youtubei.js stamps `cver` from its own bundled constant whenever it deciphers a URL, while
   * refreshMusicClientMetadata replaces the live session's version with the one scraped off
   * music.youtube.com. The two disagree by however stale the installed youtubei.js is — a
   * February 2025 constant against a current session — so the /player call signs the URL as one
   * client and the media request then claims to be another. googlevideo answers that with a bare
   * 403 and no body, which is indistinguishable from every other rejection it issues.
   *
   * Safe to rewrite: `cver` is not covered by the signature. youtubei.js sets it *after*
   * deciphering, which it could not do if `sig` depended on it.
   */
  private withSessionClientVersion(streamUrl: string, client: Innertube): string {
    const sessionVersion = client.session.context.client.clientVersion;
    if (!sessionVersion) return streamUrl;

    /*
     * String surgery rather than URL/URLSearchParams: re-serialising the query re-encodes values
     * that are already percent-exact — `xpc=EgVo2aDSNQ==` would come back as `%3D%3D` — and a
     * signed URL does not survive being normalised.
     */
    const rewritten = streamUrl.replace(
      /([?&]cver=)[^&]*/,
      `$1${encodeURIComponent(sessionVersion)}`,
    );
    if (rewritten === streamUrl) return streamUrl;

    logInternalInfo("YouTubeMusicDataSource.cver rewritten", {
      from: streamUrl.match(/[?&]cver=([^&]*)/)?.[1] ?? null,
      to: sessionVersion,
    });
    return rewritten;
  }

  private async createMusicClient(retrievePlayer = true): Promise<Innertube> {
    const client = await Innertube.create({
      ...this.getSessionOptions(retrievePlayer),
      client_type: ClientType.MUSIC,
    });
    await this.refreshMusicClientMetadata(client);
    this.applyDelegationContext(client);
    return client;
  }

  private getMusicClient(): Promise<Innertube> {
    if (!this.musicClientPromise) {
      logInternalInfo("YouTubeMusicDataSource.getMusicClient creating client");
      this.musicClientPromise = this.createMusicClient(true);
    }

    return this.musicClientPromise;
  }

  private getWebClient(): Promise<Innertube> {
    if (!this.webClientPromise) {
      logInternalInfo("YouTubeMusicDataSource.getWebClient creating client");
      // No player needed: this client only enumerates accounts and resolves like endpoints,
      // neither of which touches stream URLs, and retrieving it downloads the player script.
      this.webClientPromise = Innertube.create({
        ...this.getSessionOptions(false),
        client_type: ClientType.WEB,
      });
    }

    return this.webClientPromise;
  }

  /**
   * The client used to mint download URLs.
   *
   * googlevideo serves the first 1 MiB of an unattested session's URL and refuses every byte
   * past it with a bare 403 — measured directly: `range=0-1048575` returns 200 while
   * `range=2000000-3000000` and `range=0-3000000` both return 403 on the same fresh URL. No
   * chunking, ranging or header change reaches byte 1,048,576, and swapping clients does not
   * help either: IOS, MWEB and WEB_REMIX are all gated identically, while ANDROID, WEB and
   * TVHTML5 return SABR-only data with no direct URL at all. Only a PO token YouTube accepts
   * lifts the gate.
   *
   * So this session is built to be exactly what a token can be bound to, and nothing more:
   *
   * - **Anonymous.** Cookies change nothing here — an authenticated session is gated just the
   *   same — and a download needs the user's bytes, not their identity.
   * - **A real visitor ID.** `generate_session_locally` fabricates one, which describes a
   *   session Google never issued, and nothing about it validates.
   *
   * The token itself is *not* set here, because it is bound per track: see attestForTrack.
   */
  private getDownloadClient(): Promise<Innertube> {
    if (!this.downloadClientPromise) {
      logInternalInfo("YouTubeMusicDataSource.getDownloadClient creating client");
      this.downloadClientPromise = (async () => {
        const bootstrap = await Innertube.create({
          fetch: tauriFetch,
          retrieve_player: false,
          generate_session_locally: false,
          retrieve_innertube_config: false,
        });

        return Innertube.create({
          fetch: tauriFetch,
          retrieve_player: true,
          generate_session_locally: false,
          retrieve_innertube_config: false,
          visitor_data: bootstrap.session.context.client.visitorData,
          client_type: ClientType.MUSIC,
        });
      })();
    }

    return this.downloadClientPromise;
  }

  /**
   * Binds a fresh PO token to one track and arms the client with it.
   *
   * The binding is the **video ID**, which is the only one of the four plausible candidates that
   * actually works. Measured, because reasoning got it wrong three times: with the same session
   * and the same track, a token bound to the visitor ID, to the account's Data Sync ID, or to
   * the visitor ID of an authenticated session all left the URL refusing every byte past 1 MiB,
   * while a video-bound token served the whole file.
   *
   * Set in two places for two different reasons — `session.po_token` is what the /player call
   * carries, and `player.po_token` is what gets stamped onto the URL as `pot`. The URL is only
   * ungated when the call that minted it was attested, so the first is the one that matters and
   * the second keeps the URL self-consistent.
   *
   * Cheap per track: minting is local arithmetic against an integrity token that is fetched once
   * and cached for its full twelve hours.
   */
  private async attestForTrack(client: Innertube, trackId: string): Promise<string | undefined> {
    const poToken = await mintPoToken(trackId);
    if (!poToken) return undefined;

    client.session.po_token = poToken;
    if (client.session.player) client.session.player.po_token = poToken;
    return poToken;
  }

  private async getClient(label: ClientLabel): Promise<Innertube> {
    if (label === "download") return this.getDownloadClient();
    return label === "music" ? this.getMusicClient() : this.getWebClient();
  }

  private async refreshMusicClientMetadata(client: Innertube): Promise<void> {
    try {
      const response = await tauriFetch("https://music.youtube.com/", {
        headers: {
          Accept: "text/html",
        },
      });
      if (!response.ok) {
        throw new Error(`YouTube Music bootstrap returned HTTP ${response.status}.`);
      }

      const html = await response.text();
      const clientVersion = html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/)?.[1];
      const apiKey = html.match(/"INNERTUBE_API_KEY":"([^"]+)"/)?.[1];

      if (!clientVersion) {
        throw new Error("YouTube Music bootstrap did not contain a client version.");
      }

      client.session.context.client.clientVersion = clientVersion;
      client.session.context.client.originalUrl = "https://music.youtube.com";
      if (client.session.context.client.mainAppWebInfo) {
        client.session.context.client.mainAppWebInfo.graftUrl = "https://music.youtube.com";
      }
      if (apiKey) client.session.api_key = apiKey;

      logInternalInfo("YouTubeMusicDataSource.refreshMusicClientMetadata success", {
        clientVersion,
      });
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.refreshMusicClientMetadata failed", {
        error: error instanceof Error ? error.message : String(error),
        fallbackVersion: client.session.context.client.clientVersion,
      });
    }
  }

  private applyDelegationContext(client: Innertube): void {
    if (!this.musicSerializedDelegationContext) return;
    const session = client.session as {
      context: {
        user: {
          serializedDelegationContext?: string;
        };
      };
    };
    session.context.user.serializedDelegationContext = this.musicSerializedDelegationContext;
  }

  /**
   * Drops the clients built around a cookie that is no longer current, and nothing else.
   *
   * youtubei.js bakes the credential into a client when it is constructed, so a renewed session
   * only takes effect once these are rebuilt. The account selection is deliberately untouched —
   * a renewal is the same person on the same channel.
   */
  private resetMusicClients(): void {
    this.accountCandidateCache = null;
    this.musicClientPromise = null;
    this.webClientPromise = null;
  }

  private resetMusicSessionSelection(): void {
    // Signing out and back in may land on a different Google account entirely, where the old
    // preference would point at a channel that no longer exists.
    this.writePreferredAccountKey(null);
    this.musicAccountIndex = 0;
    this.musicOnBehalfOfUser = null;
    this.musicSerializedDelegationContext = null;
    this.musicAccountName = "YouTube Music";
    this.musicAccountArtworkUrl = null;
    this.resetMusicClients();
  }

  private getArtwork(item: MusicItem): string | undefined {
    return selectArtworkUrl(collectArtworkCandidates(item.thumbnail, item.thumbnails));
  }

  private normalizeSearchKey(value: string): string {
    return value
      .trim()
      .toLocaleLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]/g, "");
  }

  private getArtistName(item: MusicItem): string {
    return item.artists?.map((artist) => artist.name).filter(Boolean).join(", ")
      || item.authors?.map((author) => author.name).filter(Boolean).join(", ")
      || item.author?.name
      || item.subtitle?.runs
        ?.filter((run) => run.endpoint?.payload?.browseId?.startsWith("UC"))
        .map((run) => run.text)
        .filter(Boolean)
        .join(", ")
      || item.subtitle?.toString()
      || "Unknown artist";
  }

  private getArtists(item: MusicItem): ArtistReference[] | undefined {
    const toArtistReference = (value: unknown) => {
      const candidate = value as {
        name?: string;
        text?: string;
        channel_id?: string;
        endpoint?: unknown;
        navigationEndpoint?: unknown;
      };
      return {
        id: candidate.channel_id
          ?? this.findBrowseId(candidate.endpoint)
          ?? this.findBrowseId(candidate.navigationEndpoint)
          ?? "",
        name: candidate.name ?? candidate.text ?? "",
      };
    };
    const candidates = item.artists?.length
      ? item.artists
      : item.authors?.length
        ? item.authors
        : item.author
          ? [item.author]
          : [];
    const artists = candidates
      .map(toArtistReference)
      .filter((artist) => artist.id.startsWith("UC") && artist.name);

    if (artists.length > 0) return artists;

    const unlinkedArtists = candidates
      .map(toArtistReference)
      .filter((artist) => artist.name);

    if (unlinkedArtists.length > 0) return unlinkedArtists;

    const runs = item.subtitle?.runs ?? [];
    const fromRuns = runs
      .map(toArtistReference)
      .filter((artist) => artist.id.startsWith("UC") && artist.name);
    return fromRuns.length > 0 ? fromRuns : undefined;
  }

  private findBrowseId(root: unknown): string | undefined {
    const seen = new WeakSet<object>();

    const visit = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object") return undefined;
      if (seen.has(value)) return undefined;
      seen.add(value);

      const candidate = value as {
        browseId?: unknown;
        payload?: unknown;
      };
      if (typeof candidate.browseId === "string") return candidate.browseId;
      const payloadBrowseId = visit(candidate.payload);
      if (payloadBrowseId) return payloadBrowseId;

      for (const child of Object.values(value)) {
        const result = visit(child);
        if (result) return result;
      }
      return undefined;
    };

    return visit(root);
  }

  /**
   * The `params` blob that rides alongside a browse id.
   *
   * Read from the same endpoint object as the id and kept with it: for moods and genres the
   * id is a constant and this is the only thing that says which mood.
   */
  private findBrowseParams(root: unknown): string | undefined {
    const seen = new WeakSet<object>();

    const visit = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object") return undefined;
      if (seen.has(value)) return undefined;
      seen.add(value);

      const candidate = value as { browseId?: unknown; params?: unknown; payload?: unknown };
      // Only the params sitting on the same node as a browseId: an endpoint can carry other
      // params (search, continuations) that mean something entirely different.
      if (typeof candidate.browseId === "string" && typeof candidate.params === "string") {
        return candidate.params;
      }
      const fromPayload = visit(candidate.payload);
      if (fromPayload) return fromPayload;

      for (const child of Object.values(value)) {
        const result = visit(child);
        if (result) return result;
      }
      return undefined;
    };

    return visit(root);
  }

  private findAlbumPlaylistId(root: unknown): string | undefined {
    const seen = new WeakSet<object>();

    const visit = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object") return undefined;
      if (seen.has(value)) return undefined;
      seen.add(value);

      const candidate = value as {
        playlistId?: unknown;
        watchPlaylistEndpoint?: { playlistId?: unknown };
        watchEndpoint?: { playlistId?: unknown };
        payload?: { playlistId?: unknown };
      };
      const playlistId = candidate.watchPlaylistEndpoint?.playlistId
        ?? candidate.watchEndpoint?.playlistId
        ?? candidate.payload?.playlistId
        ?? candidate.playlistId;
      if (typeof playlistId === "string" && playlistId.length > 0) {
        if (playlistId.startsWith("OLAK5uy_")) return playlistId;
      }

      for (const child of Object.values(value)) {
        const result = visit(child);
        if (result) return result;
      }
      return undefined;
    };

    return visit(root);
  }

  private findStringByKey(root: unknown, keys: Set<string>): string | undefined {
    const seen = new WeakSet<object>();

    const visit = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object") return undefined;
      if (seen.has(value)) return undefined;
      seen.add(value);

      for (const [key, child] of Object.entries(value)) {
        if (keys.has(key) && typeof child === "string" && child.length > 0) {
          return child;
        }
        const result = visit(child);
        if (result) return result;
      }
      return undefined;
    };

    return visit(root);
  }

  private findYoutubeChannelId(root: unknown): string | undefined {
    const seen = new WeakSet<object>();

    const visit = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object") return undefined;
      if (seen.has(value)) return undefined;
      seen.add(value);

      for (const child of Object.values(value)) {
        if (typeof child === "string" && /^UC[\w-]{20,}$/.test(child)) {
          return child;
        }
        const result = visit(child);
        if (result) return result;
      }
      return undefined;
    };

    return visit(root);
  }

  private parseViewCount(value?: string): number | undefined {
    if (!value) return undefined;
    const match = value.replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i);
    if (!match) return undefined;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return undefined;
    const multiplier = match[2]?.toUpperCase() === "B"
      ? 1_000_000_000
      : match[2]?.toUpperCase() === "M"
        ? 1_000_000
        : match[2]?.toUpperCase() === "K"
          ? 1_000
          : 1;
    return Math.round(amount * multiplier);
  }

  private getViewCountText(item: MusicItem): string | undefined {
    if (item.views) return item.views;
    const texts = [
      ...(item.fixed_columns ?? []).flatMap((column) => [
        column.title?.toString(),
        ...(column.title?.runs?.map((run) => run.text) ?? []),
      ]),
      ...(item.flex_columns ?? []).flatMap((column) => [
        column.title?.toString(),
        ...(column.title?.runs?.map((run) => run.text) ?? []),
      ]),
      item.subtitle?.toString(),
      ...(item.subtitle?.runs?.map((run) => run.text) ?? []),
    ].filter((value): value is string => Boolean(value));
    return texts.find((value) => /\bviews?\b|\bplays?\b/i.test(value))
      ?? texts.find((value) => /^\s*\d+(?:[.,]\d+)?\s*[KMB]\s*$/i.test(value));
  }

  private getColumnText(column: MusicColumn): string | undefined {
    return column.title?.toString()
      || column.title?.runs?.map((run) => run.text).filter(Boolean).join("");
  }

  /**
   * Whether a column links to an album, as opposed to anything else that happens to be linked.
   *
   * "Not a channel" was too loose: a playlist link (`VL`/`PL`/`OLAK`) passed it just as easily,
   * so a row whose second column pointed at a playlist reported that playlist as its album.
   * Album browse ids are `MPRE`-prefixed, and that is the only thing worth trusting here.
   */
  private isAlbumColumn(column: MusicColumn): boolean {
    return column.title?.runs?.some((run) => {
      const browseId = this.findBrowseId(run.endpoint) ?? this.findBrowseId(run.navigationEndpoint);
      return Boolean(browseId?.startsWith("MPRE"));
    }) ?? false;
  }

  /**
   * The album a row belongs to, or nothing.
   *
   * Only a genuinely linked album column counts. There used to be a fallback that scanned the
   * remaining columns and returned the first string that was not the title, an artist, a
   * duration or a view count — which meant release years, "Song"/"Video" type labels, plain
   * play counts and playlist names all got reported as albums. A blank cell is right far more
   * often than a guess: a single, a video or a user upload genuinely has no album, and the
   * linked column is present whenever one does.
   */
  /**
   * The album a row belongs to: its name *and* the id behind the link.
   *
   * The id is the point. `isAlbumColumn` already has to find a browse id to decide the column
   * is an album at all, and throwing it away meant opening an album from a row had to search
   * for `"<album> <artist>"` and hope the first hit was right — which lands on compilations,
   * remasters and same-named singles often enough to be wrong in normal use.
   */
  private getTrackAlbum(item: MusicItem): { name?: string; id?: string } {
    const linkedAlbum = (item.flex_columns ?? [])
      .slice(1)
      .find((column) => this.isAlbumColumn(column));
    if (!linkedAlbum) return {};

    const id = linkedAlbum.title?.runs
      ?.map((run) => this.findBrowseId(run.endpoint) ?? this.findBrowseId(run.navigationEndpoint))
      .find((browseId) => browseId?.startsWith("MPRE"));

    return { name: this.getColumnText(linkedAlbum)?.trim() || undefined, id: id ?? undefined };
  }

  private getTitle(item: MusicItem): string | null {
    if (typeof item.title === "string") return item.title;
    const title = item.title?.toString();
    // Artist rows are parsed into `name` and leave `title` unset, and every collector here
    // discards an item without a title — which is why they never reached the library.
    return title || item.name || null;
  }

  private getPlaylistItemId(item: MusicItem): string | undefined {
    const seen = new WeakSet<object>();

    const visit = (value: unknown): string | undefined => {
      if (!value || typeof value !== "object" || seen.has(value)) return undefined;
      seen.add(value);

      const candidate = value as {
        action?: unknown;
        setVideoId?: unknown;
      };
      if (
        candidate.action === "ACTION_REMOVE_VIDEO"
        && typeof candidate.setVideoId === "string"
      ) {
        return candidate.setVideoId;
      }

      for (const child of Object.values(value)) {
        const result = visit(child);
        if (result) return result;
      }
      return undefined;
    };

    return visit(item.menu);
  }

  private toAlbum(item: MusicItem): Album | null {
    const id = item.id ?? this.findBrowseId(item.endpoint);
    const title = this.getTitle(item);
    if (!id || !title) return null;

    return {
      id,
      playlistId: this.findAlbumPlaylistId(item),
      title,
      artist: this.getArtistName(item),
      artists: this.getArtists(item),
      artworkUrl: this.getArtwork(item),
    };
  }

  private toPlaylist(item: MusicItem): Playlist | null {
    const id = item.id ?? this.findBrowseId(item.endpoint);
    const title = this.getTitle(item);
    if (!id || !title) return null;

    const owner = this.getArtistName(item);
    return {
      id,
      title,
      owner: owner === "Unknown artist" ? "YouTube Music playlist" : owner,
      artworkUrl: this.getArtwork(item),
      isSaved: false,
    };
  }

  private toTrack(item: MusicItem): Track | null {
    /*
     * The endpoint wins over `item.id`.
     *
     * `item.id` is whatever the renderer happened to be keyed on — a video id for a song, a
     * *browse* id for a show — while `endpoint.payload.videoId` only ever names the thing that
     * plays. For an ordinary song the two hold the same value, so this changes nothing there;
     * it changes the rows that were never playable in the first place.
     */
    const id = item.endpoint?.payload?.videoId ?? item.id;
    const title = this.getTitle(item);
    /*
     * A shape check as well as a presence check. An artist page's popular-songs shelf mixes in
     * podcast shows whose id is `MPSPPL…`; those became tracks, and clicking one walked all
     * three Innertube clients only to be told "This video is unavailable" by each. Dropping
     * them here means they never reach a queue — `toTrack` already returns null for unusable
     * items and every caller filters.
     */
    if (!isVideoId(id) || !title) return null;
    const viewCountText = this.getViewCountText(item);
    const album = this.getTrackAlbum(item);

    return {
      id,
      source: "youtube",
      title,
      artist: this.getArtistName(item),
      artists: this.getArtists(item),
      album: album.name,
      albumId: album.id,
      artworkUrl: this.getArtwork(item) ?? getVideoArtworkFallback(id),
      playlistItemId: this.getPlaylistItemId(item),
      viewCount: this.parseViewCount(viewCountText),
      viewCountText,
      isExplicit: this.isExplicitItem(item),
    };
  }

  /**
   * Whether YouTube tagged this item explicit.
   *
   * Read from the inline badges by icon type rather than by the badge's label, which is
   * localised — matching on "Explicit" would quietly stop working for anyone not using the
   * app in English.
   */
  private isExplicitItem(item: MusicItem): boolean | undefined {
    const badges = (item as { badges?: Array<{ icon_type?: string }> }).badges;
    if (!Array.isArray(badges)) return undefined;
    return badges.some((badge) => badge?.icon_type === "MUSIC_EXPLICIT_BADGE");
  }

  private toAlbumTrack(item: MusicItem, album: Album): Track | null {
    const track = this.toTrack(item);
    if (!track) return null;
    if (track.artist && track.artist !== "Unknown artist") return track;

    const fallbackArtist = album.artist && album.artist !== "Unknown artist"
      ? album.artist
      : undefined;
    if (!fallbackArtist) return track;

    return {
      ...track,
      artist: fallbackArtist,
      artists: track.artists?.length
        ? track.artists
        : album.artists?.length === 1
          ? album.artists
          : undefined,
    };
  }

  /**
   * Library rows address an artist as MPLA + their channel id; everywhere else in the app —
   * and every artist reference on a track — is the bare channel id, so they must match.
   */
  private normalizeArtistId(id?: string): string | undefined {
    return id?.startsWith("MPLA") ? id.slice(4) : id;
  }

  private toArtist(item: MusicItem): Artist | null {
    const id = this.normalizeArtistId(
      item.id
        ?? this.findBrowseId(item.endpoint)
        ?? this.findBrowseId(item.on_tap)
        ?? this.findYoutubeChannelId(item),
    );
    const name = this.getTitle(item) ?? item.author?.name ?? item.artists?.[0]?.name;
    if (!id?.startsWith("UC") || !name) return null;
    return {
      id,
      name,
      artworkUrl: this.getArtwork(item),
      subscriberCount: item.subscribers,
    };
  }

  private artistsFromReferences(
    items: Array<Track | Album>,
    query: string,
  ): Artist[] {
    const normalizedQuery = query.toLocaleLowerCase();
    const normalizedQueryKey = this.normalizeSearchKey(query);
    return items.flatMap((item) =>
      (item.artists ?? [])
        .filter((artist) => {
          const artistKey = this.normalizeSearchKey(artist.name);
          return artist.id.startsWith("UC")
          && artist.name
          && (
            artist.name.toLocaleLowerCase() === normalizedQuery
            || artist.name.toLocaleLowerCase().includes(normalizedQuery)
            || normalizedQuery.includes(artist.name.toLocaleLowerCase())
            || (artistKey && normalizedQueryKey && artistKey === normalizedQueryKey)
            || (artistKey && normalizedQueryKey && artistKey.includes(normalizedQueryKey))
            || (artistKey && normalizedQueryKey && normalizedQueryKey.includes(artistKey))
          );
        })
        .map((artist) => ({
          id: artist.id,
          name: artist.name,
      }))
    );
  }

  private collectArtistCardItems(root: unknown): MusicItem[] {
    const results: MusicItem[] = [];
    const seen = new WeakSet<object>();

    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (seen.has(value)) return;
      seen.add(value);

      const item = value as MusicItem;
      const id = this.findBrowseId(item.on_tap);
      const title = this.getTitle(item);
      const subtitle = item.subtitle?.toString() ?? "";
      const header = item.header?.title?.toString() ?? "";
      const badgeLabels = item.subtitle_badges
        ?.map((badge) => badge.label)
        .filter(Boolean)
        .join(" ") ?? "";
      const typeText = `${header} ${subtitle} ${badgeLabels} ${item.end_icon_type ?? ""}`;
      if (
        id?.startsWith("UC")
        && title
        && this.getArtwork(item)
        && /\bartist\b|\bsubscribers?\b|MUSIC_EXPLICIT_BADGE/i.test(typeText)
      ) {
        results.push({
          ...item,
          id,
          item_type: "artist",
          subscribers: item.subscribers
            ?? subtitle.match(/[\d,.]+\s*[KMB]?\s+subscribers?/i)?.[0],
        });
      }

      for (const child of Object.values(value)) {
        if (Array.isArray(child) || (child && typeof child === "object")) {
          visit(child);
        }
      }
    };

    visit(root);
    return results;
  }

  private collectMusicItems(root: unknown, acceptedTypes: Set<string>): MusicItem[] {
    const results: MusicItem[] = [];
    const seen = new WeakSet<object>();
    const response = root as ParsedMusicResponse;
    const nodeTypes = [YTNodes.MusicResponsiveListItem, YTNodes.MusicTwoRowItem];

    for (const memo of [response.contents_memo, response.continuation_contents_memo]) {
      if (!memo) continue;
      for (const item of memo.getType(...nodeTypes)) {
        if (item.item_type && acceptedTypes.has(item.item_type) && this.getTitle(item)) {
          results.push(item);
        }
      }
    }

    const visit = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (seen.has(value)) return;
      seen.add(value);

      const item = value as MusicItem;
      if (item.item_type && acceptedTypes.has(item.item_type) && this.getTitle(item)) {
        results.push(item);
      }

      for (const child of Object.values(value)) {
        visit(child);
      }
    };

    visit(root);
    return results;
  }

  private normalizePlaylistId(playlistId: string): string {
    return playlistId.replace(/^VL/, "");
  }

  private getPlaylistBrowseIds(playlistId: string): string[] {
    const normalizedId = this.normalizePlaylistId(playlistId);
    return [...new Set([playlistId, normalizedId, `VL${normalizedId}`])];
  }

  private findEditablePlaylistId(root: unknown): string | undefined {
    const response = root as ParsedMusicResponse;
    const editableHeader = response.contents_memo
      ?.getType(YTNodes.MusicEditablePlaylistDetailHeader)?.[0] as {
        playlist_id?: string;
      } | undefined;
    if (editableHeader?.playlist_id) return editableHeader.playlist_id;

    return this.findStringByKey(root, new Set(["playlist_id", "playlistId"]));
  }

  private uniqueById<T extends { id: string }>(items: T[]): T[] {
    const byId = new Map<string, T>();
    for (const item of items) {
      const existing = byId.get(item.id);
      if (!existing) {
        byId.set(item.id, item);
        continue;
      }
      byId.set(item.id, {
        ...item,
        ...Object.fromEntries(
          Object.entries(existing).filter(([, value]) => value !== undefined && value !== ""),
        ),
      } as T);
    }
    return [...byId.values()];
  }

  private findLikeEndpoint(
    root: unknown,
    status: "LIKE" | "DISLIKE" | "INDIFFERENT",
  ): RawLikeEndpoint | null {
    const seen = new WeakSet<object>();
    let match: RawLikeEndpoint | null = null;

    const visit = (value: unknown) => {
      if (!value || typeof value !== "object" || match || seen.has(value)) return;
      seen.add(value);

      const candidate = value as { likeEndpoint?: RawLikeEndpoint };
      if (candidate.likeEndpoint?.status === status) {
        match = candidate.likeEndpoint;
        return;
      }

      for (const child of Object.values(value)) visit(child);
    };

    visit(root);
    return match;
  }

  private findLibraryToggleEndpoint(root: unknown): LibraryToggleEndpoint | null {
    const seen = new WeakSet<object>();
    let fallback: LibraryToggleEndpoint | null = null;
    let match: LibraryToggleEndpoint | null = null;

    const visit = (value: unknown) => {
      if (!value || typeof value !== "object" || match || seen.has(value)) return;
      seen.add(value);

      const candidate = value as {
        type?: string;
        is_toggled?: boolean;
        endpoint?: CallableEndpoint;
        toggled_endpoint?: CallableEndpoint;
        icon_type?: string;
        tooltip?: string;
        toggled_tooltip?: string;
      };
      if (
        candidate.type === "ToggleButton"
        && candidate.endpoint
        && candidate.toggled_endpoint
        && candidate.icon_type !== "LIKE"
        && candidate.icon_type !== "DISLIKE"
      ) {
        const toggle = {
          isToggled: candidate.is_toggled,
          endpoint: candidate.endpoint,
          toggledEndpoint: candidate.toggled_endpoint,
          iconType: candidate.icon_type,
          tooltip: candidate.tooltip,
          toggledTooltip: candidate.toggled_tooltip,
        };
        const text = `${candidate.tooltip ?? ""} ${candidate.toggled_tooltip ?? ""}`.toLocaleLowerCase();
        if (text.includes("library") || text.includes("save")) {
          match = toggle;
          return;
        }
        fallback ??= toggle;
      }

      for (const child of Object.values(value)) visit(child);
    };

    visit(root);
    return match ?? fallback;
  }

  private rawText(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (typeof value !== "object") return "";

    const text = value as {
      text?: string;
      simpleText?: string;
      runs?: Array<{ text?: string }>;
      accessibility?: {
        accessibilityData?: {
          label?: string;
        };
      };
    };
    return text.simpleText
      ?? text.text
      ?? text.runs?.map((run) => run.text).filter(Boolean).join("")
      ?? text.accessibility?.accessibilityData?.label
      ?? "";
  }

  private findRawLibraryToggle(root: unknown): RawToggleButtonRenderer | null {
    const seen = new WeakSet<object>();
    let fallback: RawToggleButtonRenderer | null = null;
    let match: RawToggleButtonRenderer | null = null;

    const visit = (value: unknown) => {
      if (!value || typeof value !== "object" || match || seen.has(value)) return;
      seen.add(value);

      const candidate = value as { toggleButtonRenderer?: RawToggleButtonRenderer };
      const toggle = candidate.toggleButtonRenderer;
      if (toggle) {
        const iconType = toggle.defaultIcon?.iconType;
        if (iconType !== "LIKE" && iconType !== "DISLIKE") {
          const hasDefaultEndpoint = Boolean(toggle.defaultServiceEndpoint);
          const hasToggledEndpoint = Boolean(toggle.toggledServiceEndpoint);
          const hasEndpoints = hasDefaultEndpoint || hasToggledEndpoint;

          if (hasEndpoints) {
            const text = `${toggle.defaultTooltip ?? ""} ${toggle.toggledTooltip ?? ""}`.toLocaleLowerCase();
            if (text.includes("library") || text.includes("save")) {
              match = toggle;
              return;
            }
            fallback ??= toggle;
          }
        }
      }

      for (const child of Object.values(value)) visit(child);
    };

    visit(root);
    const result = (match ?? fallback) as RawToggleButtonRenderer | null;
    if (result) {
      logInternalInfo("YouTubeMusicDataSource.findRawLibraryToggle found toggle", {
        source: match ? "tooltip" : "fallback",
        iconType: result.defaultIcon?.iconType,
        defaultTooltip: result.defaultTooltip,
        toggledTooltip: result.toggledTooltip,
      });
    } else {
      logInternalWarn("YouTubeMusicDataSource.findRawLibraryToggle no toggle found");
    }
    return result;
  }

  private findRawLibraryMenuToggle(root: unknown): RawToggleMenuServiceItemRenderer | null {
    const seen = new WeakSet<object>();
    let fallback: RawToggleMenuServiceItemRenderer | null = null;
    let match: RawToggleMenuServiceItemRenderer | null = null;

    const visit = (value: unknown) => {
      if (!value || typeof value !== "object" || match || seen.has(value)) return;
      seen.add(value);

      const candidate = value as { toggleMenuServiceItemRenderer?: RawToggleMenuServiceItemRenderer };
      const toggle = candidate.toggleMenuServiceItemRenderer;
      if (toggle) {
        const iconType = toggle.defaultIcon?.iconType;
        const toggledIconType = toggle.toggledIcon?.iconType;
        if (
          iconType !== "LIKE"
          && iconType !== "DISLIKE"
          && toggledIconType !== "LIKE"
          && toggledIconType !== "DISLIKE"
        ) {
          const hasDefaultEndpoint = Boolean(toggle.defaultServiceEndpoint);
          const hasToggledEndpoint = Boolean(toggle.toggledServiceEndpoint);
          const hasEndpoints = hasDefaultEndpoint || hasToggledEndpoint;

          if (hasEndpoints) {
            const text = `${this.rawText(toggle.defaultText)} ${this.rawText(toggle.toggledText)}`.toLocaleLowerCase();
            if (text.includes("library") || text.includes("save")) {
              match = toggle;
              return;
            }
            fallback ??= toggle;
          }
        }
      }

      for (const child of Object.values(value)) visit(child);
    };

    visit(root);
    const result = (match ?? fallback) as RawToggleMenuServiceItemRenderer | null;
    if (result) {
      const toggle = result as RawToggleMenuServiceItemRenderer;
      logInternalInfo("YouTubeMusicDataSource.findRawLibraryMenuToggle found toggle", {
        source: match ? "text" : "fallback",
        iconType: toggle.defaultIcon?.iconType,
        toggledIconType: toggle.toggledIcon?.iconType,
        defaultText: this.rawText(toggle.defaultText),
        toggledText: this.rawText(toggle.toggledText),
      });
    } else {
      logInternalWarn("YouTubeMusicDataSource.findRawLibraryMenuToggle no toggle found");
    }
    return result;
  }

  private findArtistSubscriptionToggle(root: unknown): { subscribed: boolean } | null {
    const seen = new WeakSet<object>();

    const visit = (value: unknown): { subscribed: boolean } | null => {
      if (!value || typeof value !== "object") return null;
      if (seen.has(value)) return null;
      seen.add(value);

      const candidate = value as {
        subscribeButtonRenderer?: {
          subscribed?: boolean;
          channelId?: string;
          notificationPreferenceButton?: unknown;
          targetId?: string;
        };
      };
      const renderer = candidate.subscribeButtonRenderer;
      if (renderer) {
        return { subscribed: Boolean(renderer.subscribed) };
      }

      for (const child of Object.values(value)) {
        const result = visit(child);
        if (result) return result;
      }
      return null;
    };

    return visit(root);
  }

  private findSubscribeButtonUpdate(root: unknown, artistId: string): { subscribed: boolean } | null {
    const seen = new WeakSet<object>();

    const visit = (value: unknown): { subscribed: boolean } | null => {
      if (!value || typeof value !== "object") return null;
      if (seen.has(value)) return null;
      seen.add(value);

      const candidate = value as {
        updateSubscribeButtonAction?: {
          subscribed?: boolean;
          channelId?: string;
        };
      };
      const action = candidate.updateSubscribeButtonAction;
      if (action && (!action.channelId || action.channelId === artistId)) {
        return { subscribed: Boolean(action.subscribed) };
      }

      for (const child of Object.values(value)) {
        const result = visit(child);
        if (result) return result;
      }
      return null;
    };

    return visit(root);
  }

  private findRunAttestationCommand(root: unknown): AttestationCommand | null {
    const seen = new WeakSet<object>();

    const visit = (value: unknown): AttestationCommand | null => {
      if (!value || typeof value !== "object") return null;
      if (seen.has(value)) return null;
      seen.add(value);

      const command = (value as { runAttestationCommand?: AttestationCommand }).runAttestationCommand;
      if (command) return command;

      for (const child of Object.values(value)) {
        const result = visit(child);
        if (result) return result;
      }
      return null;
    };

    return visit(root);
  }

  private getArtistCacheKey(artistId: string): string {
    return `youtube-music:artist:${ARTIST_CACHE_VERSION}:${artistId}`;
  }

  private getArtistSubscriptionOverride(artistId: string): boolean | undefined {
    const override = this.artistSubscriptionOverrides.get(artistId);
    if (!override) return undefined;
    if (override.expiresAt <= Date.now()) {
      this.artistSubscriptionOverrides.delete(artistId);
      return undefined;
    }
    return override.subscribed;
  }

  private rememberArtistSubscription(artistId: string, subscribed: boolean): void {
    this.artistSubscriptionOverrides.set(artistId, {
      subscribed,
      expiresAt: Date.now() + ARTIST_SUBSCRIPTION_OVERRIDE_MS,
    });
  }

  private async updateCachedArtistSubscription(artistId: string, subscribed: boolean): Promise<void> {
    const cacheKey = this.getArtistCacheKey(artistId);
    const cached = await getCachedJson<ArtistPage>(cacheKey);
    if (!cached) return;
    await setCachedJson(cacheKey, {
      ...cached,
      subscribed,
    });
  }

  private async updateCachedAlbumSaved(album: Album, saved: boolean): Promise<void> {
    const cachedLibrary = await getCachedJson<LibrarySnapshot>(LIBRARY_CACHE_KEY);
    if (!cachedLibrary) return;

    const sameAlbum = (item: Album) =>
      item.id === album.id
      || Boolean(album.playlistId && item.playlistId === album.playlistId)
      || Boolean(album.playlistId && item.id === album.playlistId)
      || Boolean(item.playlistId && item.playlistId === album.id);
    const albums = saved
      ? [album, ...cachedLibrary.albums.filter((item) => !sameAlbum(item))]
      : cachedLibrary.albums.filter((item) => !sameAlbum(item));

    await setCachedJson(LIBRARY_CACHE_KEY, {
      ...cachedLibrary,
      albums,
    });
  }

  private getActionableServiceEndpoint(endpoint: RawServiceEndpoint): RawServiceEndpoint {
    const commands = endpoint.commandExecutorCommand?.commands;
    if (!commands?.length) return endpoint;
    return commands.find((command) => command.feedbackEndpoint || command.likeEndpoint)
      ?? commands[commands.length - 1]
      ?? endpoint;
  }

  private async executeRawServiceEndpoint(
    client: Innertube,
    endpoint: RawServiceEndpoint,
  ): Promise<{ success?: boolean; status_code?: number }> {
    const command = this.getActionableServiceEndpoint(endpoint);
    if (command.feedbackEndpoint?.feedbackToken) {
      const feedback = command.feedbackEndpoint;
      return client.actions.execute("/feedback", {
        feedbackTokens: [feedback.feedbackToken],
        ...(feedback.cpn ? { feedbackContext: { cpn: feedback.cpn } } : {}),
        isFeedbackTokenUnencrypted: Boolean(feedback.isFeedbackTokenUnencrypted),
        shouldMerge: Boolean(feedback.shouldMerge),
      });
    }
    if (command.likeEndpoint) {
      const like = command.likeEndpoint;
      const params = like.status === "LIKE"
        ? like.likeParams ?? like.params
        : like.removeLikeParams ?? like.params;
      return client.actions.execute(
        like.status === "LIKE" ? "/like/like" : "/like/removelike",
        {
          client: "YTMUSIC",
          target: this.normalizeLikeTarget(like.target),
          ...(params ? { params } : {}),
        },
      );
    }
    throw new Error("YouTube Music returned an unsupported album library command.");
  }

  private normalizeLikeTarget(target: RawLikeEndpoint["target"]): RawLikeEndpoint["target"] {
    if (!target || typeof target !== "string") return target;
    if (target.startsWith("PL") || target.startsWith("OLAK5uy_")) {
      return { playlistId: target };
    }
    return { videoId: target };
  }

  private async executePlaylistLibraryLikeCommand(
    client: Innertube,
    playlistId: string,
    saved: boolean,
  ): Promise<{ success?: boolean; status_code?: number }> {
    return client.actions.execute(saved ? "/like/like" : "/like/removelike", {
      client: "YTMUSIC",
      target: {
        playlistId,
      },
    });
  }

  /**
   * Sends one of YouTube's three ratings for a track.
   *
   * The status doubles as the lookup key: /next carries a `likeEndpoint` per rating, and the
   * one whose `status` matches is the command to run. That is why dislike needed no new
   * discovery — only a third branch for which endpoint, params and path to use.
   */
  private async executeTrackRatingCommand(
    musicClient: Innertube,
    trackId: string,
    rating: TrackRating,
  ) {
    const musicNextResponse = await musicClient.actions.execute("/next", {
      videoId: trackId,
      client: "YTMUSIC",
    });
    const status: "LIKE" | "DISLIKE" | "INDIFFERENT" =
      rating === "like" ? "LIKE" : rating === "dislike" ? "DISLIKE" : "INDIFFERENT";
    let endpoint = this.findLikeEndpoint(musicNextResponse.data, status);
    let endpointSource = "music";

    if (!endpoint?.target) {
      const webClient = await this.getWebClient();
      const webNextResponse = await webClient.actions.execute("/next", {
        videoId: trackId,
      });
      endpoint = this.findLikeEndpoint(webNextResponse.data, status);
      endpointSource = "web";
    }

    if (!endpoint?.target) {
      logInternalError("YouTubeMusicDataSource.executeTrackRatingCommand missing endpoint", {
        trackId,
        status,
      });
      throw new Error(`YouTube did not return a ${status} command for this song.`);
    }

    const params =
      rating === "like"
        ? endpoint.likeParams ?? endpoint.params
        : rating === "dislike"
          ? endpoint.dislikeParams ?? endpoint.params
          : endpoint.removeLikeParams ?? endpoint.params;
    /*
     * `removelike` clears a dislike as well as a like — the endpoint is named for the like it
     * was built around, but YouTube treats it as "set rating to indifferent".
     */
    const path =
      rating === "like"
        ? "/like/like"
        : rating === "dislike"
          ? "/like/dislike"
          : "/like/removelike";

    logInternalInfo("YouTubeMusicDataSource.executeTrackRatingCommand", {
      trackId,
      status,
      hasParams: Boolean(params),
      endpointSource,
    });

    return musicClient.actions.execute(path, {
      client: "YTMUSIC",
      target: this.normalizeLikeTarget(endpoint.target),
      ...(params ? { params } : {}),
    });
  }

  private getMusicContinuation(client: Innertube, root: unknown): MusicContinuation | null {
    const parsed = root as ParsedMusicResponse;
    /*
     * Where a "there is more" token lives depends on the surface: playlists use a
     * MusicPlaylistShelf, library grids a Grid or MusicShelf, and every continuation response
     * puts the next token on `continuation_contents` instead. Reading all of them explicitly
     * beats the tree walk below, which finds whichever shelf DFS reaches first.
     */
    const shelfTypes = [YTNodes.MusicPlaylistShelf, YTNodes.MusicShelf, YTNodes.Grid] as const;
    const shelves: Array<{ continuation?: unknown }> = [];
    for (const memo of [parsed.contents_memo, parsed.continuation_contents_memo]) {
      shelves.push(...(memo?.getType(...shelfTypes) ?? []) as Array<{ continuation?: unknown }>);
    }
    shelves.push((parsed as { continuation_contents?: { continuation?: unknown } }).continuation_contents ?? {});
    const shelfContinuation = shelves
      .map((shelf) => shelf.continuation)
      .find((value) => typeof value === "string" && value.length > 0);
    if (typeof shelfContinuation === "string" && shelfContinuation.length > 0) {
      return {
        key: shelfContinuation,
        load: () => this.executeMusicBrowse(client, {
          continuation: shelfContinuation,
        }),
      };
    }

    const seen = new WeakSet<object>();
    const found: {
      endpoint: {
        payload?: { continuation?: string };
        call(actions: Innertube["actions"], args: { parse: true }): Promise<unknown>;
      } | null;
    } = {
      endpoint: null,
    };
    let tokenContinuation: string | null = null;

    const visit = (value: unknown) => {
      if (!value || typeof value !== "object" || found.endpoint) return;
      if (seen.has(value)) return;
      seen.add(value);

      if (value instanceof YTNodes.ContinuationItem) {
        found.endpoint = value.endpoint as {
          payload?: { continuation?: string };
          call(actions: Innertube["actions"], args: { parse: true }): Promise<unknown>;
        };
        return;
      }

      const candidate = value as {
        continuation?: unknown;
        contents?: unknown;
      };
      if (
        !tokenContinuation
        && typeof candidate.continuation === "string"
        && candidate.continuation
        && candidate.contents
      ) {
        tokenContinuation = candidate.continuation;
      }

      for (const child of Object.values(value)) {
        visit(child);
      }
    };

    visit(root);

    if (found.endpoint) {
      const endpoint = found.endpoint;
      const key = endpoint.payload?.continuation || `endpoint:${JSON.stringify(endpoint.payload ?? {})}`;
      return {
        key,
        load: () => endpoint.call(client.actions, { parse: true }),
      };
    }

    if (tokenContinuation) {
      const continuation = tokenContinuation;
      return {
        key: continuation,
        load: () => this.executeMusicBrowse(client, {
          continuation,
        }),
      };
    }

    return null;
  }

  /**
   * Library grids come back one page at a time — roughly 25 albums or playlists — with the rest
   * behind a continuation token. Reading only the first page silently truncates the library, so
   * walk every page. A failed continuation keeps what was already collected: a partial library
   * beats an empty one, and the next refresh tries again.
   */
  private async collectAllMusicItems(
    client: Innertube,
    initialResponse: unknown,
    acceptedTypes: Set<string>,
    label: string,
    maxPages = 200,
  ): Promise<MusicItem[]> {
    const items: MusicItem[] = [];
    const seenContinuations = new Set<string>();
    let response = initialResponse;
    let pageCount = 0;

    while (pageCount < maxPages) {
      items.push(...this.collectMusicItems(response, acceptedTypes));
      pageCount += 1;

      const continuation = this.getMusicContinuation(client, response);
      if (!continuation) break;
      if (seenContinuations.has(continuation.key)) {
        logInternalWarn("YouTubeMusicDataSource.collectAllMusicItems repeated continuation", {
          label,
          pageCount,
          continuationKey: continuation.key,
        });
        break;
      }

      seenContinuations.add(continuation.key);
      try {
        response = await continuation.load();
      } catch (error) {
        logInternalWarn("YouTubeMusicDataSource.collectAllMusicItems continuation failed", {
          label,
          pageCount,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }

    logInternalInfo("YouTubeMusicDataSource.collectAllMusicItems complete", {
      label,
      pageCount,
      itemCount: items.length,
      truncated: pageCount >= maxPages,
    });
    return items;
  }

  private async collectAllTracks(client: Innertube, initialResponse: unknown): Promise<Track[]> {
    const items: MusicItem[] = [];
    const seenContinuations = new Set<string>();
    let response = initialResponse;
    let pageCount = 0;

    while (true) {
      items.push(...this.collectMusicItems(response, new Set(["song", "video"])));
      pageCount += 1;

      const continuation = this.getMusicContinuation(client, response);
      if (!continuation) break;
      if (seenContinuations.has(continuation.key)) {
        logInternalWarn("YouTubeMusicDataSource.collectAllTracks repeated continuation", {
          pageCount,
          continuationKey: continuation.key,
        });
        break;
      }

      seenContinuations.add(continuation.key);
      response = await continuation.load();
    }

    const tracks = this.uniqueById(
      items.map((item) => this.toTrack(item)).filter((item): item is Track => Boolean(item)),
    );
    logInternalInfo("YouTubeMusicDataSource.collectAllTracks complete", {
      pageCount,
      trackCount: tracks.length,
    });
    return tracks;
  }

  private async collectAllAlbumTracks(client: Innertube, initialResponse: unknown, album: Album): Promise<Track[]> {
    const items: MusicItem[] = [];
    const seenContinuations = new Set<string>();
    let response = initialResponse;
    let pageCount = 0;

    while (true) {
      items.push(...this.collectMusicItems(response, new Set(["song", "video"])));
      pageCount += 1;

      const continuation = this.getMusicContinuation(client, response);
      if (!continuation) break;
      if (seenContinuations.has(continuation.key)) {
        logInternalWarn("YouTubeMusicDataSource.collectAllAlbumTracks repeated continuation", {
          albumId: album.id,
          pageCount,
          continuationKey: continuation.key,
        });
        break;
      }

      seenContinuations.add(continuation.key);
      response = await continuation.load();
    }

    const tracks = this.uniqueById(
      items.map((item) => this.toAlbumTrack(item, album)).filter((item): item is Track => Boolean(item)),
    );
    logInternalInfo("YouTubeMusicDataSource.collectAllAlbumTracks complete", {
      albumId: album.id,
      pageCount,
      trackCount: tracks.length,
    });
    return tracks;
  }

  private async collectPlaylistTracks(client: Innertube, playlistId: string): Promise<Track[]> {
    const browseId = playlistId.startsWith("VL") ? playlistId : `VL${playlistId}`;
    let page = await this.executeMusicBrowse(client, { browseId });
    let pageCount = 0;
    const items: MusicItem[] = [];
    const seenContinuations = new Set<string>();

    while (true) {
      const pageItems = this.collectMusicItems(page, new Set(["song", "video"]));
      items.push(...pageItems);
      pageCount += 1;

      const continuation = this.getMusicContinuation(client, page);
      if (!continuation) break;
      if (seenContinuations.has(continuation.key)) {
        logInternalWarn("YouTubeMusicDataSource.collectPlaylistTracks repeated page", {
          playlistId,
          pageCount,
          continuationKey: continuation.key,
        });
        break;
      }

      seenContinuations.add(continuation.key);
      try {
        page = await continuation.load();
      } catch (error) {
        // Keep the pages already read: a long playlist that loses one request mid-walk is
        // still mostly here, and throwing would fail the whole library sync over it.
        logInternalWarn("YouTubeMusicDataSource.collectPlaylistTracks continuation failed", {
          playlistId,
          pageCount,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }

    const tracks = this.uniqueById(
      items.map((item) => this.toTrack(item)).filter((item): item is Track => Boolean(item)),
    );
    logInternalInfo("YouTubeMusicDataSource.collectPlaylistTracks complete", {
      playlistId,
      browseId,
      pageCount,
      trackCount: tracks.length,
    });
    return tracks;
  }

  private async waitForPlaylistEmptyRetry(attempt: number): Promise<void> {
    const delayMs = PLAYLIST_EMPTY_RETRY_DELAYS_MS[attempt] ?? 0;
    if (delayMs <= 0) return;
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));
  }

  private async collectPlaylistTracksWithEmptyRetries(
    client: Innertube,
    playlistId: string,
    source: string,
  ): Promise<Track[]> {
    for (let attempt = 0; attempt < PLAYLIST_EMPTY_RETRY_DELAYS_MS.length; attempt += 1) {
      await this.waitForPlaylistEmptyRetry(attempt);

      const tracks = await this.collectPlaylistTracks(client, playlistId);
      if (tracks.length > 0) return tracks;

      const browseId = playlistId.startsWith("VL") ? playlistId : `VL${playlistId}`;
      logInternalWarn("YouTubeMusicDataSource.collectPlaylistTracksWithEmptyRetries retrying empty response", {
        playlistId,
        browseId,
        source,
        attempt: attempt + 1,
      });

      const response = await this.executeMusicBrowse(client, { browseId });
      const fallbackTracks = await this.collectAllTracks(client, response);
      if (fallbackTracks.length > 0) return fallbackTracks;
    }

    return [];
  }

  private createPlaylistPageKey(playlistId: string): string {
    return `${playlistId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  }

  private pruneExpiredPlaylistPageSessions() {
    const now = Date.now();
    for (const [key, session] of this.playlistPageSessions) {
      if (session.expiresAt <= now) {
        this.playlistPageSessions.delete(key);
      }
    }
  }

  private collectParsedPlaylistPageTracks(page: YouTubeMusicPlaylistPage, seenTrackIds: Set<string>): Track[] {
    const items = page.items ?? page.contents ?? [];
    const tracks: Track[] = [];

    for (const item of items) {
      const track = this.toTrack(item);
      if (!track || seenTrackIds.has(track.id)) continue;
      seenTrackIds.add(track.id);
      tracks.push(track);
    }

    return tracks;
  }

  private getPlaylistTrackCacheKey(playlistId: string): string {
    return `youtube-music:playlist-tracks:${PLAYLIST_TRACK_CACHE_VERSION}:${playlistId}`;
  }

  private async cachePlaylistTracks(playlistId: string, tracks: Track[]): Promise<Track[]> {
    if (tracks.length === 0) return tracks;
    const cacheKey = this.getPlaylistTrackCacheKey(playlistId);
    const cached = await getCachedJson<Track[]>(cacheKey);
    const merged = this.uniqueById([...(cached ?? []), ...tracks]);
    await setCachedJson(cacheKey, merged);
    return merged;
  }

  private getAlbumHeaderArtwork(response: unknown): string | undefined {
    const parsed = response as ParsedMusicResponse;
    const detailHeader = parsed.contents_memo?.getType(YTNodes.MusicDetailHeader)?.[0] as {
      thumbnails?: Array<{ url?: string; width?: number; height?: number }>;
      thumbnail?: {
        contents?: Array<{ url?: string; width?: number; height?: number }>;
      };
    } | undefined;
    const responsiveHeader = parsed.contents_memo?.getType(YTNodes.MusicResponsiveHeader)?.[0] as {
      thumbnails?: Array<{ url?: string; width?: number; height?: number }>;
      thumbnail?: {
        contents?: Array<{ url?: string; width?: number; height?: number }>;
      };
    } | undefined;

    return selectArtworkUrl(
      detailHeader?.thumbnails,
      detailHeader?.thumbnail?.contents,
      responsiveHeader?.thumbnails,
      responsiveHeader?.thumbnail?.contents,
    );
  }

  private async enrichMissingAlbumArtwork(client: Innertube, albums: Album[]): Promise<Album[]> {
    const missingAlbums = albums.filter((album) => !album.artworkUrl);
    if (missingAlbums.length === 0) return albums;

    logInternalInfo("YouTubeMusicDataSource.enrichMissingAlbumArtwork start", {
      missingCount: missingAlbums.length,
      albumIds: missingAlbums.map((album) => album.id),
    });

    const artworkByAlbumId = new Map<string, string>();
    const queue = [...missingAlbums];
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length > 0) {
        const album = queue.shift();
        if (!album) return;

        try {
          const response = await this.executeMusicBrowse(client, { browseId: album.id });
          const artworkUrl = this.getAlbumHeaderArtwork(response);
          if (artworkUrl) artworkByAlbumId.set(album.id, artworkUrl);
        } catch (error) {
          logInternalWarn("YouTubeMusicDataSource.enrichMissingAlbumArtwork album failed", {
            albumId: album.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    });

    await Promise.all(workers);
    logInternalInfo("YouTubeMusicDataSource.enrichMissingAlbumArtwork complete", {
      missingCount: missingAlbums.length,
      resolvedCount: artworkByAlbumId.size,
    });

    return albums.map((album) => {
      const artworkUrl = artworkByAlbumId.get(album.id);
      return artworkUrl ? { ...album, artworkUrl } : album;
    });
  }

  private async getCreatedPlaylists(client: Innertube, playlistItems: MusicItem[]): Promise<Playlist[]> {
    const playlists = this.uniqueById(
      playlistItems
        .map((item) => this.toPlaylist(item))
        .filter((item): item is Playlist => Boolean(item))
        .filter((item) => {
          const normalizedId = item.id.replace(/^VL/, "").toUpperCase();
          if (normalizedId === "LM") return false;
          const lowerTitle = item.title.toLocaleLowerCase();
          if (lowerTitle === "liked songs" || lowerTitle === "likes" || lowerTitle.includes("new releases") || lowerTitle.includes("new episodes")) return false;
          return true;
        }),
    );
    /*
     * Deciding "did I create this playlist?" costs one browse request each, and a full library
     * can be hundreds of playlists. Ownership never changes, so anything already classified in
     * the cached snapshot is reused and only new playlists are probed.
     */
    const cachedLibrary = await getCachedJson<LibrarySnapshot>(LIBRARY_CACHE_KEY);
    const cachedById = new Map((cachedLibrary?.playlists ?? []).map((playlist) => [playlist.id, playlist]));
    const createdPlaylistIds = new Set<string>();
    const queue = playlists.filter((playlist) => {
      const cached = cachedById.get(playlist.id);
      if (!cached || cached.isEditable === undefined) return true;
      if (cached.isEditable) createdPlaylistIds.add(playlist.id);
      // The probe is also where a missing cover came from, so carry that over rather than
      // paying for the request again.
      if (!playlist.artworkUrl) playlist.artworkUrl = cached.artworkUrl;
      return false;
    });
    const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
      while (queue.length > 0) {
        const playlist = queue.shift();
        if (!playlist) return;

        for (const browseId of this.getPlaylistBrowseIds(playlist.id)) {
          try {
            const response = await this.executeMusicBrowse(client, { browseId });
            const editablePlaylistId = this.findEditablePlaylistId(response);
            if (!editablePlaylistId) continue;

            const normalizedEditableId = this.normalizePlaylistId(editablePlaylistId);
            const normalizedPlaylistId = this.normalizePlaylistId(playlist.id);
            if (normalizedEditableId !== normalizedPlaylistId) continue;

            createdPlaylistIds.add(playlist.id);
            if (!playlist.artworkUrl) {
              playlist.artworkUrl = this.getAlbumHeaderArtwork(response);
            }
            break;
          } catch (error) {
            logInternalWarn("YouTubeMusicDataSource.getCreatedPlaylists playlist failed", {
              playlistId: playlist.id,
              browseId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    });

    await Promise.all(workers);
    return playlists.map((playlist) => ({
      ...playlist,
      isSaved: true,
      isEditable: createdPlaylistIds.has(playlist.id),
    }));
  }

  /**
   * The library's artists, each with a photo where one exists.
   *
   * The library's artists section covers only some of them, and everyone else arrives as a
   * reference on an album or a song: a name and a channel id, no picture. The only place a
   * picture exists is that artist's own page, which is one request each — so the results are
   * the artist-page cache the artist view already fills and reads, and a sync only pays for
   * artists nobody has resolved yet.
   */
  private async completeLibraryArtists(
    artists: Artist[],
    references: ArtistReference[],
  ): Promise<Artist[]> {
    const byId = new Map(artists.map((artist) => [artist.id, artist]));
    for (const reference of references) {
      if (!reference.id.startsWith("UC") || !reference.name || byId.has(reference.id)) continue;
      byId.set(reference.id, { id: reference.id, name: reference.name });
    }

    // Photos resolved by an earlier sync, so the budget below always goes to artists nobody
    // has looked up yet rather than re-spending itself on the same first sixty.
    const cachedLibrary = await getCachedJson<LibrarySnapshot>(LIBRARY_CACHE_KEY);
    for (const cached of cachedLibrary?.artists ?? []) {
      const artist = byId.get(cached.id);
      if (artist && !artist.artworkUrl && cached.artworkUrl) {
        byId.set(cached.id, { ...artist, artworkUrl: cached.artworkUrl });
      }
    }

    /*
     * ponytail: a first sync of a large library would otherwise fire hundreds of requests at
     * once. Resolved artists keep their photo in the snapshot and never come back here, so a
     * per-sync budget fills the rest in over the next few refreshes rather than all at once.
     */
    const queue = [...byId.values()].filter((artist) => !artist.artworkUrl).slice(0, 60);
    const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
      while (queue.length > 0) {
        const artist = queue.shift();
        if (!artist) return;
        const resolved = await this.getArtistArtworkFromPage(artist.id);
        if (resolved?.artworkUrl) {
          byId.set(artist.id, { ...artist, artworkUrl: resolved.artworkUrl });
        }
      }
    });
    await Promise.all(workers);

    const completed = [...byId.values()];
    logInternalInfo("YouTubeMusicDataSource.completeLibraryArtists complete", {
      artistCount: completed.length,
      withArtwork: completed.filter((artist) => artist.artworkUrl).length,
      // Non-zero here means the budget above ran out — the next sync picks up where this
      // one stopped, so it shrinks each time rather than staying put.
      stillMissing: completed.filter((artist) => !artist.artworkUrl).length,
    });
    return completed;
  }

  private async getLikedSongs(client: Innertube): Promise<{
    playlist: Playlist;
    tracks: Track[];
  }> {
    const tracks = await this.collectPlaylistTracks(client, LIKED_SONGS_PLAYLIST_ID);

    return {
      playlist: {
        id: LIKED_SONGS_PLAYLIST_ID,
        title: "Liked Songs",
        owner: "YouTube Music",
        kind: "liked-songs",
      },
      tracks,
    };
  }

  /**
   * One library section, in full.
   *
   * The dedicated browse id is the reliable source — it returns the whole section, paginated.
   * The chip on the library landing page is the fallback, because it depends on YouTube still
   * shipping a chip with that exact English label, and when it doesn't the landing page hands
   * back a short "recent activity" grid that looks like a complete library but isn't.
   */
  private async loadLibrarySection(
    client: Innertube,
    browseId: string,
    libraryLanding: unknown,
    filterName: string,
    itemTypes: string[],
  ): Promise<MusicItem[]> {
    const acceptedTypes = new Set(itemTypes);
    try {
      const response = await this.executeMusicBrowse(client, { browseId });
      const items = await this.collectAllMusicItems(client, response, acceptedTypes, browseId);
      if (items.length > 0) return items;
      logInternalWarn("YouTubeMusicDataSource.loadLibrarySection empty, falling back to filter", {
        browseId,
        filterName,
      });
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.loadLibrarySection failed, falling back to filter", {
        browseId,
        filterName,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const filtered = await this.applyLibraryFilter(client, libraryLanding, filterName);
    return this.collectAllMusicItems(client, filtered, acceptedTypes, filterName);
  }

  private async applyLibraryFilter(
    client: Innertube,
    response: unknown,
    filterName: string,
  ): Promise<unknown> {
    const parsed = response as ParsedMusicResponse;
    const chipCloud = parsed.contents_memo?.getType(YTNodes.ChipCloud)?.[0] as {
      chips?: Array<{
        text?: string;
        endpoint?: {
          call(actions: Innertube["actions"], args: { parse: true }): Promise<unknown>;
        };
      }>;
    } | undefined;
    const filter = chipCloud?.chips?.find((chip) => chip.text === filterName);
    if (!filter?.endpoint) {
      logInternalWarn("YouTubeMusicDataSource.applyLibraryFilter missing filter", {
        filterName,
        availableFilters: chipCloud?.chips?.map((chip) => chip.text).filter(Boolean) ?? [],
      });
      return response;
    }

    return filter.endpoint.call(client.actions, { parse: true });
  }

  private getRendererCounts(response: unknown): Record<string, number> {
    const parsed = response as ParsedMusicResponse;
    const counts: Record<string, number> = {};
    for (const memo of [parsed.contents_memo, parsed.continuation_contents_memo]) {
      if (!memo) continue;
      for (const [renderer, items] of memo.entries()) {
        counts[renderer] = (counts[renderer] ?? 0) + items.length;
      }
    }
    return counts;
  }

  private getResponseMessages(response: unknown): string[] {
    const parsed = response as ParsedMusicResponse;
    const messages: string[] = [];
    for (const memo of [parsed.contents_memo, parsed.continuation_contents_memo]) {
      if (!memo) continue;
      for (const message of memo.getType(YTNodes.Message) as Array<{ text?: { toString(): string } }>) {
        const text = message.text?.toString();
        if (text) messages.push(text);
      }
    }
    return messages;
  }

  private async executeMusicBrowse(client: Innertube, args: Record<string, unknown>): Promise<unknown> {
    return client.actions.execute("/browse", {
      ...args,
      parse: true,
    });
  }

  private async loadLibraryResponses(client: Innertube) {
    logInternalInfo("YouTubeMusicDataSource.loadLibraryResponses start", {
      accountIndex: this.musicAccountIndex,
      onBehalfOfUser: this.musicOnBehalfOfUser,
    });
    const [libraryLanding, historyResponse] = await Promise.all([
      this.executeMusicBrowse(client, { browseId: "FEmusic_library_landing" }),
      this.executeMusicBrowse(client, { browseId: "FEmusic_history" }),
    ]);
    logInternalInfo("YouTubeMusicDataSource.loadLibraryResponses complete", {
      accountIndex: this.musicAccountIndex,
      onBehalfOfUser: this.musicOnBehalfOfUser,
      libraryRenderers: this.getRendererCounts(libraryLanding),
      historyRenderers: this.getRendererCounts(historyResponse),
      libraryMessages: this.getResponseMessages(libraryLanding),
      historyMessages: this.getResponseMessages(historyResponse),
    });
    return { libraryLanding, historyResponse };
  }

  private getLibrarySignal(libraryLanding: unknown, historyResponse: unknown): number {
    const albumCount = this.collectMusicItems(libraryLanding, new Set(["album"])).length;
    const playlistCount = this.collectMusicItems(libraryLanding, new Set(["playlist"])).length;
    const recentCount = this.collectMusicItems(historyResponse, new Set(["song", "video"])).length;
    const messages = this.getResponseMessages(libraryLanding).length
      + this.getResponseMessages(historyResponse).length;
    return albumCount + playlistCount + recentCount - messages * 10;
  }

  private getLibraryAuthFailureMessage(libraryLanding: unknown, historyResponse: unknown): string | null {
    const libraryMessages = this.getResponseMessages(libraryLanding);
    const historyMessages = this.getResponseMessages(historyResponse);
    const allMessages = [...libraryMessages, ...historyMessages];
    const signedOutMessages = allMessages.filter((message) =>
      /sign in|explore your favorites|looking for what/i.test(message)
    );
    if (signedOutMessages.length === 0) return null;

    return [
      "YouTube Music did not accept the saved sign-in session for library sync.",
      `Account tried: ${this.musicAccountName} (authuser ${this.musicAccountIndex}).`,
      `YouTube response: ${signedOutMessages.join(" / ")}.`,
      "Please sign out, sign in again, and make sure the login window lands on music.youtube.com before it closes.",
    ].join(" ");
  }

  /**
   * The page id InnerTube expects in `onBehalfOfUser` for a brand channel.
   *
   * Not the UC… channel id: those look like the obvious answer and are what the endpoint
   * advertises most visibly, but sending one makes /browse answer 500. The value InnerTube
   * wants is the obfuscated page id, which is the first segment of the datasync token
   * ("<pageId>||<userId>"). The channel id is kept only as a last resort for items whose
   * endpoint carries no token at all.
   */
  private findDelegatedPageId(endpoint: unknown): string | undefined {
    const datasync = this.findStringByKey(endpoint, new Set(["datasyncIdToken"]));
    const pageId = datasync?.split("||")[0]?.trim();
    if (pageId) return pageId;

    return this.findStringByKey(endpoint, new Set(["channelIdentifier", "externalChannelId"]))
      ?? this.findYoutubeChannelId(endpoint)
      ?? this.findBrowseId(endpoint);
  }

  /**
   * The channel the listener actually chose, read durably.
   *
   * This used to be `localStorage` only, which does not reliably survive a restart in this
   * app — every other cross-restart preference already went through `appSettings`'s
   * Tauri-backed store for exactly that reason, and this was the one place that never got
   * migrated. That gap is what "switch to my second channel" not sticking across a restart
   * looked like: `findBestLibraryResponses` asks this on every refresh, got back a preference
   * that never actually reached disk, found no match, and fell through to the "most library
   * content wins" probe — which is a different channel by definition, since the listener
   * deliberately switched away from it.
   *
   * A pre-migration install may still have a real choice sitting in `localStorage` with
   * nothing durable behind it yet; that is read back once and persisted durably so this is
   * the last time the fallback is needed.
   */
  private async readPreferredAccountKey(): Promise<string | null> {
    if (this.preferredAccountKeyCache !== undefined) return this.preferredAccountKeyCache;

    const durable = await getAppSetting<string>(SELECTED_ACCOUNT_STORAGE_KEY);
    if (typeof durable === "string") {
      this.preferredAccountKeyCache = durable;
      return durable;
    }

    let migrated: string | null = null;
    try {
      migrated = localStorage.getItem(SELECTED_ACCOUNT_STORAGE_KEY);
    } catch {
      migrated = null;
    }
    this.preferredAccountKeyCache = migrated;
    if (migrated !== null) void setAppSetting(SELECTED_ACCOUNT_STORAGE_KEY, migrated);
    return migrated;
  }

  /** Durable set/clear for the preferred channel, keeping the in-memory mirror in step. */
  private writePreferredAccountKey(id: string | null): void {
    this.preferredAccountKeyCache = id;
    try {
      if (id === null) localStorage.removeItem(SELECTED_ACCOUNT_STORAGE_KEY);
      else localStorage.setItem(SELECTED_ACCOUNT_STORAGE_KEY, id);
    } catch {
      // Durable write below still applies even when the mirror fails.
    }
    void (id === null
      ? removeAppSetting(SELECTED_ACCOUNT_STORAGE_KEY)
      : setAppSetting(SELECTED_ACCOUNT_STORAGE_KEY, id));
  }

  /** Every channel on the signed-in Google account, with the active one flagged. */
  async listAccounts(): Promise<AccountOption[]> {
    if (!this.musicCookie) return [];

    let candidates = this.accountCandidateCache;
    if (!candidates) {
      candidates = await this.getAccountCandidates();
    }

    const activeKey = accountCandidateKey({
      accountIndex: this.musicAccountIndex,
      onBehalfOfUser: this.musicOnBehalfOfUser,
      serializedDelegationContext: this.musicSerializedDelegationContext,
    });
    return candidates.map((candidate) => {
      const id = accountCandidateKey(candidate);
      return {
        id,
        name: candidate.name ?? "YouTube Music",
        artworkUrl: candidate.artworkUrl,
        isActive: id === activeKey,
      };
    });
  }

  /**
   * Switches the session to another channel and drops everything scoped to the old one.
   *
   * The library cache is keyed by nothing but a version string, so leaving it in place would
   * show the previous channel's playlists under the new one's name until the refresh landed.
   */
  async selectAccount(id: string): Promise<void> {
    const candidates = this.accountCandidateCache
      ?? await this.getAccountCandidates();
    const candidate = candidates.find((item) => accountCandidateKey(item) === id);
    if (!candidate) throw new Error("That account is no longer available.");

    /*
     * Remember how to get back before changing anything.
     *
     * A rejected delegation makes every later request 500, and since the preference is
     * persisted and outranks the automatic probe, a failed switch would otherwise leave the
     * library broken across restarts with no way back except signing out.
     */
    const previous: AccountCandidate = {
      accountIndex: this.musicAccountIndex,
      name: this.musicAccountName,
      artworkUrl: this.musicAccountArtworkUrl ?? undefined,
      onBehalfOfUser: this.musicOnBehalfOfUser ?? undefined,
      serializedDelegationContext: this.musicSerializedDelegationContext ?? undefined,
    };
    const previousPreference = await this.readPreferredAccountKey();

    this.writePreferredAccountKey(id);

    await this.useAccountCandidate(candidate);

    // Prove the new identity actually works before throwing away the cached library for it.
    try {
      await this.loadLibraryResponses(await this.getMusicClient());
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.selectAccount rejected, reverting", {
        name: candidate.name,
        error: error instanceof Error ? error.message : String(error),
      });
      this.writePreferredAccountKey(previousPreference);
      await this.useAccountCandidate(previous);
      throw new Error(`YouTube Music rejected the switch to ${candidate.name ?? "that channel"}.`);
    }

    // Playlists, albums and artist pages are all scoped to the old channel, not just the
    // library snapshot, so the whole cache goes — the same thing sign-in and sign-out do.
    try {
      await clearCache();
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.selectAccount cache clear failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.libraryRefreshPromise = null;
    logInternalInfo("YouTubeMusicDataSource.selectAccount", { name: candidate.name });
  }

  /**
   * Every channel on the signed-in Google account.
   *
   * Deliberately uses the *web* client. `AccountManager.getInfo(true)` asks for
   * `{ client: 'WEB' }` because the channel switcher is a www.youtube.com endpoint, but that
   * override only picks the context — the base URL and client name still come from the
   * Innertube instance. Handed the music client, the request went to
   * music.youtube.com/youtubei/v1/account/accounts_list as WEB_REMIX (client name 67), which
   * answers 200 with a stub that parses to zero AccountItem nodes. That is why only the
   * synthesised fallback ever came back.
   */
  private async getAccountCandidates(): Promise<AccountCandidate[]> {
    const fallback: AccountCandidate = { accountIndex: 0, name: "YouTube Music", selected: true };
    try {
      const client = await this.getWebClient();
      const accountItems = await client.account.getInfo(true) as Array<{
        account_name?: { toString(): string };
        account_byline?: { toString(): string };
        channel_handle?: { toString(): string };
        account_photo?: unknown;
        endpoint?: unknown;
        has_channel?: boolean;
        is_disabled?: boolean;
        is_selected?: boolean;
      }>;
      /*
       * Zero accounts on a session that has a cookie is not an account without channels — the
       * switcher endpoint answers 200 with an empty stub when it does not recognise you. This
       * was the visible symptom of the expired session: an empty channel list and no error.
       */
      if (accountItems.length === 0 && this.musicCookie) {
        logInternalWarn("YouTubeMusicDataSource.getAccountCandidates signed-out stub");
        notifyAuthRejected();
      }

      const candidates = accountItems
        .filter((item) => !item.is_disabled)
        .flatMap((item, index): AccountCandidate[] => {
          const endpoint = item.endpoint;
          /*
           * The WEB channel switcher identifies a channel through
           * selectActiveIdentityEndpoint.supportedTokens, not through the delegation context
           * the YouTube Music account menu uses. Those tokens carry a channelIdentifier
           * (UC...) and a datasyncIdToken; neither is a browseId and neither lives under a
           * key named *serializedDelegationContext, so the original two lookups came back
           * empty for every brand channel and dropped them all on the floor.
           */
          const onBehalfOfUser = this.findDelegatedPageId(endpoint);
          const serializedDelegationContext = this.findStringByKey(
            endpoint,
            new Set(["selectedSerializedDelegationContext", "serializedDelegationContext"]),
          );
          const name = item.account_name?.toString()
            || item.channel_handle?.toString()
            || item.account_byline?.toString()
            || undefined;
          const artworkUrl = selectArtworkUrl(collectArtworkCandidates(item.account_photo));
          /*
           * accounts_list puts the owner's own channel first, and that is exactly what the
           * plain cookie session already resolves to — so it is emitted without delegation.
           * The condition used to also require that no identifier was found, which was fine
           * while none ever was; now that they are extracted, delegating to your own channel
           * would change its identity key and disturb the default path for no gain.
           */
          if (index === 0) {
            return [{ ...fallback, name, artworkUrl, selected: item.is_selected }];
          }
          if (!onBehalfOfUser && !serializedDelegationContext) return [];
          return [{
            accountIndex: 0,
            name,
            artworkUrl,
            onBehalfOfUser,
            serializedDelegationContext,
            selected: item.is_selected,
          }];
        });

      /*
       * Discovered candidates first, fallback last. uniqueById merges collisions by letting
       * the *earlier* entry's non-empty values win — so with the fallback in front, its
       * placeholder name "YouTube Music" overwrote the real profile name on every account
       * whose key matches it, which is every personal (non-brand) account. That is why the
       * header read "YouTube Music" with no picture no matter what the API returned. Ordered
       * this way the fallback only fills in gaps, which is all it was ever meant to do.
       */
      const unique = this.uniqueById(
        [...candidates, fallback].map((candidate) => ({
          ...candidate,
          id: accountCandidateKey(candidate),
        })),
      ).map(({ id: _id, ...candidate }) => candidate);
      this.accountCandidateCache = unique;

      logInternalInfo("YouTubeMusicDataSource.getAccountCandidates success", {
        rawItemCount: accountItems.length,
        rawEndpoints: accountItems.map((item) => {
          const endpoint = item.endpoint as { name?: string; payload?: unknown } | undefined;
          const tokens = (endpoint?.payload as { supportedTokens?: unknown[] } | undefined)
            ?.supportedTokens;
          return {
            endpointName: endpoint?.name,
            // Named to avoid the logger's sensitive-key filter, which strips anything
            // matching /token/ and redacted this field on the previous pass.
            identityFields: Array.isArray(tokens)
              ? tokens.flatMap((entry) =>
                  entry && typeof entry === "object" ? Object.keys(entry) : [])
              : undefined,
            payloadKeys: endpoint?.payload && typeof endpoint.payload === "object"
              ? Object.keys(endpoint.payload)
              : undefined,
          };
        }),
        derivedIds: accountItems.map((item) => {
          const id = this.findDelegatedPageId(item.endpoint);
          // Shape only, never the value: enough to tell a page id from a channel id.
          return id
            ? { length: id.length, looksLikeChannel: id.startsWith("UC"), digitsOnly: /^\d+$/.test(id) }
            : null;
        }),
        rawItemNames: accountItems.map((item) => ({
          name: item.account_name?.toString(),
          handle: item.channel_handle?.toString(),
          hasPhoto: Boolean(item.account_photo),
          hasChannel: item.has_channel,
          disabled: item.is_disabled,
          selected: item.is_selected,
        })),
        candidateCount: unique.length,
        selectedCount: unique.filter((candidate) => candidate.selected).length,
        candidates: unique.map((candidate) => ({
          accountIndex: candidate.accountIndex,
          hasOnBehalfOfUser: Boolean(candidate.onBehalfOfUser),
          hasSerializedDelegationContext: Boolean(candidate.serializedDelegationContext),
          selected: candidate.selected,
          name: candidate.name,
        })),
      });
      return unique;
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.getAccountCandidates failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [fallback];
    }
  }

  private async useAccountCandidate(
    candidate: AccountCandidate,
    options: { cacheClient?: boolean; retrievePlayer?: boolean } = {},
  ): Promise<Innertube> {
    const cacheClient = options.cacheClient ?? true;
    const retrievePlayer = options.retrievePlayer ?? true;
    const changed = this.musicAccountIndex !== candidate.accountIndex
      || this.musicOnBehalfOfUser !== (candidate.onBehalfOfUser ?? null)
      || this.musicSerializedDelegationContext !== (candidate.serializedDelegationContext ?? null);
    this.musicAccountIndex = candidate.accountIndex;
    this.musicOnBehalfOfUser = candidate.onBehalfOfUser ?? null;
    this.musicSerializedDelegationContext = candidate.serializedDelegationContext ?? null;
    this.musicAccountName = candidate.name ?? "YouTube Music";
    this.musicAccountArtworkUrl = candidate.artworkUrl ?? null;
    if (changed) {
      this.musicClientPromise = null;
      this.webClientPromise = null;
    }
    if (!cacheClient) {
      return this.createMusicClient(retrievePlayer);
    }
    return this.getMusicClient();
  }

  private async findBestLibraryResponses(initialClient: Innertube): Promise<LibraryResponses> {
    const fallback: AccountCandidate = {
      accountIndex: this.musicAccountIndex,
      name: this.musicAccountName,
      onBehalfOfUser: this.musicOnBehalfOfUser ?? undefined,
      serializedDelegationContext: this.musicSerializedDelegationContext ?? undefined,
      selected: true,
    };
    const initialResponses = await this.loadLibraryResponses(initialClient);
    let best: LibraryResponses = {
      client: initialClient,
      account: fallback,
      ...initialResponses,
    };
    let bestSignal = this.getLibrarySignal(best.libraryLanding, best.historyResponse);
    const profileCandidates = await this.getAccountCandidates();

    /*
     * An explicit choice ends the search. The probe below picks whichever account returns the
     * most library content, which is the right default but the wrong answer for someone who
     * deliberately switched to a channel that happens to have less in it — without this the
     * switch would silently undo itself on the next refresh.
     */
    const preferredKey = await this.readPreferredAccountKey();
    const preferred = preferredKey
      ? profileCandidates.find((candidate) => accountCandidateKey(candidate) === preferredKey)
      : undefined;
    if (preferred) {
      const client = await this.useAccountCandidate(preferred);
      const responses = await this.loadLibraryResponses(client);
      logInternalInfo("YouTubeMusicDataSource.findBestLibraryResponses using saved account", {
        name: preferred.name,
      });
      return { client, account: preferred, ...responses };
    }

    /*
     * Adopt the profile's own name and photo for the account already in use.
     *
     * This is why the header used to read "YouTube Music" with no picture: the starting
     * `best.account` is synthesised from session fields whose defaults are exactly that, and
     * the loop below skips any candidate matching the current key — so the real profile, which
     * matches by definition on a single-channel account, was never allowed to fill them in.
     */
    const activeProfile = profileCandidates.find(
      (candidate) => accountCandidateKey(candidate) === accountCandidateKey(best.account),
    );
    if (activeProfile) {
      best = { ...best, account: { ...best.account, ...activeProfile } };
      this.musicAccountName = activeProfile.name ?? this.musicAccountName;
      this.musicAccountArtworkUrl = activeProfile.artworkUrl ?? this.musicAccountArtworkUrl;
    }

    const authUserCandidates: AccountCandidate[] = bestSignal <= 0
      ? [1, 2, 3, 4, 5].map((accountIndex) => ({
          accountIndex,
          name: `YouTube Music account ${accountIndex + 1}`,
        }))
      : [];
    const candidates = this.uniqueById(
      [...profileCandidates, ...authUserCandidates].map((candidate) => ({
        ...candidate,
        id: accountCandidateKey(candidate),
      })),
    ).map(({ id: _id, ...candidate }) => candidate);

    for (const candidate of candidates) {
      if (accountCandidateKey(candidate) === accountCandidateKey(best.account)) continue;

      try {
        const client = await this.useAccountCandidate(candidate, {
          cacheClient: false,
          retrievePlayer: false,
        });
        const { libraryLanding, historyResponse } = await this.loadLibraryResponses(client);
        const signal = this.getLibrarySignal(libraryLanding, historyResponse);
        if (signal > bestSignal || (signal === bestSignal && candidate.selected && !best.account.selected)) {
          best = { client, account: candidate, libraryLanding, historyResponse };
          bestSignal = signal;
        }
      } catch (error) {
        logInternalWarn("YouTubeMusicDataSource.findBestLibraryResponses candidate failed", {
          accountIndex: candidate.accountIndex,
          hasOnBehalfOfUser: Boolean(candidate.onBehalfOfUser),
          hasSerializedDelegationContext: Boolean(candidate.serializedDelegationContext),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await this.useAccountCandidate(best.account);
    logInternalInfo("YouTubeMusicDataSource.findBestLibraryResponses selected", {
      accountIndex: best.account.accountIndex,
      hasOnBehalfOfUser: Boolean(best.account.onBehalfOfUser),
      hasSerializedDelegationContext: Boolean(best.account.serializedDelegationContext),
      selected: best.account.selected,
      signal: bestSignal,
      name: best.account.name,
    });
    return best;
  }

  onAuthExpired(handler: () => void): void {
    setAuthRejectedHandler(handler);
  }

  onAuthConfirmed(handler: (at: number) => void): void {
    setAuthConfirmedHandler(handler);
  }

  async restoreSession(): Promise<boolean> {
    logInternalInfo("YouTubeMusicDataSource.restoreSession start");
    try {
      this.musicCookie = await invoke<string | null>("load_youtube_music_cookie");
      if (!this.musicCookie) {
        logInternalInfo("YouTubeMusicDataSource.restoreSession no stored session");
        return false;
      }
      logInternalInfo("YouTubeMusicDataSource.restoreSession credential loaded", {
        credentialBytes: this.musicCookie.length,
      });
      /*
       * Clients only — the same reasoning `refreshSession` documents: reading back a stored
       * credential is the same person on the same channel.
       *
       * This used to call `resetMusicSessionSelection()`, which deletes the saved channel. It
       * runs on every launch, so a brand account chosen in Settings survived exactly as long as
       * the process did: on the next start the preference was gone before
       * `findBestLibraryResponses` could read it, and the automatic probe put the user back on
       * whichever channel holds the most library content. Wiping the selection belongs to
       * sign-out and to a sign-in that lands on a different Google account, which both still do it.
       *
       * The in-memory half of that reset was a no-op here anyway: on a fresh process the account
       * fields are already the values it assigns.
       */
      this.resetMusicClients();
      await this.getMusicClient();
      logInternalInfo("YouTubeMusicDataSource.restoreSession success");
      return true;
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.restoreSession failed", error);
      return false;
    }
  }

  /**
   * Renews the session from the sign-in webview's own Google session, invisibly.
   *
   * Deliberately does not clear the cache the way signIn does. The account has not changed, so
   * everything cached is still correct — dropping it would turn a silent renewal into the full
   * library resync this exists to avoid.
   */
  async refreshSession(): Promise<boolean> {
    logInternalInfo("YouTubeMusicDataSource.refreshSession start");
    const cookie = await invoke<string | null>("refresh_youtube_music_cookie");
    if (!cookie) {
      logInternalInfo("YouTubeMusicDataSource.refreshSession no session to renew");
      return false;
    }

    this.musicCookie = cookie;
    // Only the clients are rebuilt: this is the same person on the same channel.
    this.resetMusicClients();
    logInternalInfo("YouTubeMusicDataSource.refreshSession success", {
      credentialBytes: cookie.length,
    });
    return true;
  }

  async signIn(
    onPrompt: (prompt: AuthPrompt) => void,
    onStage?: (stage: AuthStage) => void,
  ): Promise<void> {
    logInternalInfo("YouTubeMusicDataSource.signIn start");
    onPrompt({
      verificationUrl: "https://music.youtube.com/",
      userCode: "Browser sign-in",
      expiresInSec: 300,
    });
    // Unbounded: this resolves when the person finishes signing in, not on a timer.
    onStage?.("browser");
    const { cookie, accountChanged } = await invoke<SignInResult>("sign_in_youtube_music");
    this.musicCookie = cookie;
    onStage?.("session");
    logInternalInfo("YouTubeMusicDataSource.signIn command completed", {
      credentialBytes: cookie.length,
      accountChanged,
    });

    /*
     * The same account signing in again is a renewal, not a new session, so it is treated as
     * one: the cached library stays, the chosen channel stays, and only the clients holding the
     * old cookie are rebuilt. Clearing regardless is what turned every lapsed session into a
     * full resync behind the sign-in overlay — for an account whose cache was still correct.
     */
    if (!accountChanged) {
      this.resetMusicClients();
      await this.getMusicClient();
      logInternalInfo("YouTubeMusicDataSource.signIn success (session renewed)");
      return;
    }

    try {
      await clearCache();
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.signIn cache clear failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.resetMusicSessionSelection();
    await this.getMusicClient();
    logInternalInfo("YouTubeMusicDataSource.signIn success");
  }

  /**
   * Closes the sign-in window, which is what the backend's poll loop treats as a cancellation.
   *
   * Silent when the window is already gone: that is the ordinary case of cancelling just as the
   * sign-in completed, and it is not worth an error.
   */
  async cancelSignIn(): Promise<void> {
    const loginWindow = await WebviewWindow.getByLabel(YOUTUBE_LOGIN_WINDOW_LABEL);
    if (!loginWindow) return;
    try {
      await loginWindow.close();
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.cancelSignIn close failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async signOut(): Promise<void> {
    logInternalInfo("YouTubeMusicDataSource.signOut start");
    await invoke("delete_youtube_music_cookie");
    try {
      await clearCache();
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.signOut cache clear failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.musicCookie = null;
    this.resetMusicSessionSelection();
    logInternalInfo("YouTubeMusicDataSource.signOut success");
  }

  getCachedLibrary(): Promise<LibrarySnapshot | null> {
    return getCachedJson<LibrarySnapshot>(LIBRARY_CACHE_KEY);
  }

  async getLibrary(
    onUpdate?: (library: LibrarySnapshot) => void,
    onError?: (error: unknown) => void,
  ): Promise<LibrarySnapshot> {
    const cacheKey = LIBRARY_CACHE_KEY;
    const cached = await getCachedJson<LibrarySnapshot>(cacheKey);

    if (cached && this.hasLibraryContent(cached)) {
      globalThis.setTimeout(() => {
        void this.refreshLibrary(cacheKey)
          // Delivered whether or not the cache write reported a change: a failed write also
          // reports "unchanged", and that used to throw away a perfectly good refresh.
          .then(({ value }) => onUpdate?.(value))
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.getLibrary background refresh failed", {
              error: error instanceof Error ? error.message : String(error),
            });
            /*
             * Reported rather than only logged. A cached library resolves this call before the
             * network is touched, so an expired session used to end here as a warning while the
             * app went on showing yesterday's library under a signed-in header.
             */
            onError?.(error);
          });
      }, 0);
      return cached;
    }

    if (cached) {
      logInternalWarn("YouTubeMusicDataSource.getLibrary ignoring empty cache entry");
    }

    return (await this.refreshLibrary(cacheKey)).value;
  }

  private hasLibraryContent(library: LibrarySnapshot): boolean {
    return library.albums.length > 0
      || library.playlists.length > 0
      || library.likedSongs.length > 0
      || library.recentlyPlayed.length > 0;
  }

  private async refreshLibrary(cacheKey: string): Promise<{ changed: boolean; value: LibrarySnapshot }> {
    if (!this.libraryRefreshPromise) {
      this.libraryRefreshPromise = this.fetchLibraryFresh().finally(() => {
        this.libraryRefreshPromise = null;
      });
    }

    const value = await this.libraryRefreshPromise;
    const changed = await setCachedJson(cacheKey, value);
    return { changed, value };
  }

  private async fetchLibraryFresh(): Promise<LibrarySnapshot> {
    logInternalInfo("YouTubeMusicDataSource.getLibrary start", {
      hasCookie: Boolean(this.musicCookie),
      accountIndex: this.musicAccountIndex,
    });
    if (!this.musicCookie) {
      throw new Error("Sign in is required to load the YouTube Music library.");
    }

    let client = await this.getMusicClient();
    const bestLibrary = await this.findBestLibraryResponses(client);
    client = bestLibrary.client;
    const { libraryLanding, historyResponse } = bestLibrary;
    const libraryMessages = this.getResponseMessages(libraryLanding);
    const authFailureMessage = this.getLibraryAuthFailureMessage(libraryLanding, historyResponse);
    if (authFailureMessage) {
      /*
       * Reported whatever the signal says. Throwing still waits for the library to come back
       * empty — a partial answer is worth keeping — but "YouTube told us to sign in" is a fact
       * about the session, not about how much content happened to survive it, and hiding it
       * behind the threshold is what let a half-working session look healthy.
       */
      notifyAuthRejected();
      if (this.getLibrarySignal(libraryLanding, historyResponse) <= 0) {
        throw new YouTubeMusicAuthError(authFailureMessage);
      }
    }

    const [albumItems, playlistItems, artistItems, songItems, recentItems] = await Promise.all([
      this.loadLibrarySection(client, "FEmusic_liked_albums", libraryLanding, "Albums", ["album"]),
      this.loadLibrarySection(client, "FEmusic_liked_playlists", libraryLanding, "Playlists", ["playlist"]),
      /*
       * Artists are derivable from albums and liked songs, but only this section carries their
       * photos — an artist reference on a track is a name and a channel id, nothing else.
       * Rows here are typed `library_artist`, not `artist`: same artist, different page type.
       */
      this.loadLibrarySection(client, "FEmusic_library_corpus_track_artists", libraryLanding, "Artists", ["artist", "library_artist"]),
      // The library's own Songs section. It overlaps Liked Songs but is not the same list —
      // anything saved from an album lives here and in no playlist.
      this.loadLibrarySection(client, "FEmusic_liked_videos", libraryLanding, "Songs", ["song", "video"]),
      // ponytail: history is unbounded and only feeds a "recently played" strip — a few pages is
      // already more than the UI shows. Raise if a full history view ever needs it.
      this.collectAllMusicItems(client, historyResponse, new Set(["song", "video"]), "history", 3),
    ]);

    const parsedAlbums = this.uniqueById(albumItems.map((item) => this.toAlbum(item)).filter((item): item is Album => Boolean(item)));
    const sectionArtists = this.uniqueById(
      artistItems.map((item) => this.toArtist(item)).filter((item): item is Artist => Boolean(item)),
    );
    const [albums, playlists, likedSongsResult] = await Promise.all([
      this.enrichMissingAlbumArtwork(client, parsedAlbums),
      this.getCreatedPlaylists(client, playlistItems),
      this.getLikedSongs(client),
    ]);
    const recentlyPlayed = this.uniqueById(recentItems.map((item) => this.toTrack(item)).filter((item): item is Track => Boolean(item)));
    const likedSongIds = new Set(likedSongsResult.tracks.map((track) => track.id));
    const librarySongs = this.uniqueById(
      songItems.map((item) => this.toTrack(item)).filter((item): item is Track => Boolean(item)),
    ).filter((track) => !likedSongIds.has(track.id));
    /*
     * Every artist the library page can show, from the same three lists it builds its Artists
     * tab out of. Leaving songs out of this left the artists you only have liked tracks by
     * with no photo at all — nothing else in the sync ever looks them up.
     */
    const artists = await this.completeLibraryArtists(sectionArtists, [
      ...albums.flatMap((album) => album.artists ?? []),
      ...likedSongsResult.tracks.flatMap((track) => track.artists ?? []),
      ...librarySongs.flatMap((track) => track.artists ?? []),
    ]);
    const historyMessages = this.getResponseMessages(historyResponse);
    await this.cachePlaylistTracks(LIKED_SONGS_PLAYLIST_ID, likedSongsResult.tracks);

    if (libraryMessages.length > 0 && albums.length === 0) {
      throw new YouTubeMusicAuthError(
        authFailureMessage ?? `YouTube Music returned an account message: ${libraryMessages.join(" ")}`,
      );
    }

    logInternalInfo("YouTubeMusicDataSource.getLibrary success", {
      albumCount: albums.length,
      playlistCount: playlists.length,
      likedSongCount: likedSongsResult.tracks.length,
      librarySongCount: librarySongs.length,
      recentTrackCount: recentlyPlayed.length,
      albumItemCount: albumItems.length,
      playlistItemCount: playlistItems.length,
      artistCount: artists.length,
      historyRenderers: this.getRendererCounts(historyResponse),
      libraryMessages,
      historyMessages,
      accountIndex: this.musicAccountIndex,
      onBehalfOfUser: this.musicOnBehalfOfUser,
      accountName: this.musicAccountName,
    });

    return {
      account: {
        name: this.musicAccountName,
        artworkUrl: this.musicAccountArtworkUrl ?? undefined,
      },
      albums,
      artists,
      playlists,
      likedSongsPlaylist: likedSongsResult.playlist,
      likedSongs: likedSongsResult.tracks,
      librarySongs,
      recentlyPlayed,
    };
  }

  async getAlbumTracks(album: Album, onUpdate?: (tracks: Track[]) => void): Promise<Track[]> {
    const cacheKey = `youtube-music:album-tracks:v4:${album.id}`;
    const cached = await getCachedJson<Track[]>(cacheKey);

    if (cached?.length) {
      globalThis.setTimeout(() => {
        void this.refreshAlbumTracks(album, cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.getAlbumTracks background refresh failed", {
              albumId: album.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }

    if (cached) {
      logInternalWarn("YouTubeMusicDataSource.getAlbumTracks ignoring empty cache entry", {
        albumId: album.id,
      });
    }

    return (await this.refreshAlbumTracks(album, cacheKey)).value;
  }

  async setAlbumSaved(album: Album, saved: boolean): Promise<void> {
    if (!this.musicCookie) {
      throw new Error("Sign in to YouTube Music to update your library.");
    }
    try {
      const client = await this.getMusicClient();
      const albumResponse = await this.executeMusicBrowse(client, { browseId: album.id });
      const albumPlaylistId = album.playlistId ?? this.findAlbumPlaylistId(albumResponse);
      if (albumPlaylistId) {
        try {
          const directResponse = await this.executePlaylistLibraryLikeCommand(client, albumPlaylistId, saved);
          if (directResponse.success === false) {
            throw new Error(`Album library update returned HTTP ${directResponse.status_code}.`);
          }
          logInternalInfo("YouTubeMusicDataSource.setAlbumSaved direct like command", {
            albumId: album.id,
            albumPlaylistId,
            saved,
          });
          await this.updateCachedAlbumSaved(album, saved);
          return;
        } catch (directError) {
          logInternalWarn("YouTubeMusicDataSource.setAlbumSaved direct like command failed", {
            albumId: album.id,
            albumPlaylistId,
            saved,
            error: directError instanceof Error ? directError.message : String(directError),
          });
        }
      }

      const rawToggle = this.findRawLibraryToggle(albumResponse);

      if (rawToggle) {
        if (rawToggle.isToggled === saved) {
          await this.updateCachedAlbumSaved(album, saved);
          return;
        }
        const endpoint = saved
          ? rawToggle.defaultServiceEndpoint
          : rawToggle.toggledServiceEndpoint;
        if (!endpoint) {
          throw new Error("YouTube Music returned an incomplete library command for this album.");
        }

        logInternalInfo("YouTubeMusicDataSource.setAlbumSaved raw command", {
          albumId: album.id,
          saved,
          iconType: rawToggle.defaultIcon?.iconType,
          defaultTooltip: rawToggle.defaultTooltip,
          toggledTooltip: rawToggle.toggledTooltip,
        });

        const response = await this.executeRawServiceEndpoint(client, endpoint);
        if (response.success === false) {
          throw new Error(`Album library update returned HTTP ${response.status_code}.`);
        }
        await this.updateCachedAlbumSaved(album, saved);
        return;
      }

      const rawMenuToggle = this.findRawLibraryMenuToggle(albumResponse);
      if (rawMenuToggle) {
        if (rawMenuToggle.isToggled === saved) {
          await this.updateCachedAlbumSaved(album, saved);
          return;
        }
        const endpoint = saved
          ? rawMenuToggle.defaultServiceEndpoint
          : rawMenuToggle.toggledServiceEndpoint;
        if (!endpoint) {
          throw new Error("YouTube Music returned an incomplete library menu command for this album.");
        }

        logInternalInfo("YouTubeMusicDataSource.setAlbumSaved raw menu command", {
          albumId: album.id,
          saved,
          iconType: rawMenuToggle.defaultIcon?.iconType,
          toggledIconType: rawMenuToggle.toggledIcon?.iconType,
          defaultText: this.rawText(rawMenuToggle.defaultText),
          toggledText: this.rawText(rawMenuToggle.toggledText),
        });

        const response = await this.executeRawServiceEndpoint(client, endpoint);
        if (response.success === false) {
          throw new Error(`Album library menu update returned HTTP ${response.status_code}.`);
        }
        await this.updateCachedAlbumSaved(album, saved);
        return;
      }

      const albumPage = await client.music.getAlbum(album.id);
      const toggle = this.findLibraryToggleEndpoint(albumPage.page);
      if (!toggle) {
        throw new Error("YouTube Music did not return a library command for this album.");
      }
      if (toggle.isToggled === saved) {
        await this.updateCachedAlbumSaved(album, saved);
        return;
      }

      const endpoint = saved ? toggle.endpoint : toggle.toggledEndpoint;
      if (!endpoint) {
        throw new Error("YouTube Music returned an incomplete library command for this album.");
      }

      logInternalInfo("YouTubeMusicDataSource.setAlbumSaved command", {
        albumId: album.id,
        saved,
        iconType: toggle.iconType,
        tooltip: toggle.tooltip,
        toggledTooltip: toggle.toggledTooltip,
      });

      const response = await endpoint.call(client.actions, { client: "YTMUSIC" });
      if (response.success === false) {
        throw new Error(`Album library update returned HTTP ${response.status_code}.`);
      }
      await this.updateCachedAlbumSaved(album, saved);
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.setAlbumSaved failed", error, {
        albumId: album.id,
        saved,
      });
      throw new Error(
        saved
          ? "YouTube Music could not save this album."
          : "YouTube Music could not remove this album.",
      );
    }
  }

  private async refreshAlbumTracks(
    album: Album,
    cacheKey: string,
  ): Promise<{ changed: boolean; value: Track[] }> {
    let refresh = this.albumRefreshPromises.get(album.id);
    if (!refresh) {
      refresh = this.fetchAlbumTracksFresh(album).finally(() => {
        this.albumRefreshPromises.delete(album.id);
      });
      this.albumRefreshPromises.set(album.id, refresh);
    }

    const value = await refresh;
    const changed = value.length > 0
      ? await setCachedJson(cacheKey, value)
      : false;
    return { changed, value };
  }

  private async fetchAlbumTracksFresh(album: Album): Promise<Track[]> {
    const client = await this.getMusicClient();
    const albumPage = await client.music.getAlbum(album.id);
    const initialItems = albumPage.contents
      .filter((item) => item.item_type === "song" || item.item_type === "video") as unknown as MusicItem[];
    const continuedTracks = await this.collectAllAlbumTracks(client, albumPage.page, album);
    const tracks = this.uniqueById([
      ...initialItems
        .map((item) => this.toAlbumTrack(item, album))
        .filter((item): item is Track => Boolean(item)),
      ...continuedTracks,
    ]);
    if (tracks.length === 0) {
      throw new Error(`YouTube Music returned no tracks for album ${album.id}.`);
    }
    return tracks;
  }

  async getArtist(
    artistId: string,
    onUpdate?: (artist: ArtistPage) => void,
  ): Promise<ArtistPage> {
    const cacheKey = this.getArtistCacheKey(artistId);
    const cached = await getCachedJson<ArtistPage>(cacheKey);
    if (cached) {
      globalThis.setTimeout(() => {
        void this.refreshArtist(artistId, cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.getArtist background refresh failed", {
              artistId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }
    return (await this.refreshArtist(artistId, cacheKey)).value;
  }

  async setArtistSubscribed(artistId: string, subscribed: boolean): Promise<void> {
    if (!this.musicCookie) {
      throw new Error("Sign in to YouTube Music to update subscriptions.");
    }
    try {
      const musicClient = await this.getMusicClient();
      const context = musicClient.session.context as {
        client?: {
          clientName?: string;
          clientVersion?: string;
          visitorData?: string;
        };
      };
      const endpoint = subscribed ? "subscribe" : "unsubscribe";
      const response = await tauriFetch(
        `https://music.youtube.com/youtubei/v1/subscription/${endpoint}?prettyPrint=false`,
        {
          method: "POST",
          headers: {
            Accept: "*/*",
            "Accept-Language": "*",
            "Content-Type": "application/json",
            Cookie: this.musicCookie,
            "X-Goog-AuthUser": this.musicAccountIndex.toString(),
            ...(context.client?.visitorData
              ? { "X-Goog-Visitor-Id": context.client.visitorData }
              : {}),
            "X-Youtube-Client-Name": "67",
            "X-Youtube-Client-Version": context.client?.clientVersion ?? "1.20260609.07.00",
          },
          body: JSON.stringify({
            channelIds: [artistId],
            params: subscribed ? "EgIIAhgA" : "CgIIAhgA",
            context,
          }),
        },
      );
      if (!response.ok) {
        throw new Error(`Artist subscription update returned HTTP ${response.status}.`);
      }
      const responseData = await response.json() as unknown;
      const buttonUpdate = this.findSubscribeButtonUpdate(responseData, artistId);
      const attestationCommand = this.findRunAttestationCommand(responseData);
      logInternalInfo("YouTubeMusicDataSource.setArtistSubscribed response", {
        artistId,
        subscribed,
        requestMode: "tauriFetch",
        hasButtonUpdate: Boolean(buttonUpdate),
        returnedSubscribed: buttonUpdate?.subscribed,
        hasAttestationCommand: Boolean(attestationCommand),
        attestationEngagementType: attestationCommand?.engagementType,
      });
      if (buttonUpdate && buttonUpdate.subscribed !== subscribed) {
        throw new Error("YouTube Music returned a different subscription state.");
      }
      this.rememberArtistSubscription(artistId, subscribed);
      await this.updateCachedArtistSubscription(artistId, subscribed);
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.setArtistSubscribed failed", error, {
        artistId,
        subscribed,
      });
      throw new Error(
        subscribed
          ? "YouTube Music could not subscribe to this artist."
          : "YouTube Music could not unsubscribe from this artist.",
      );
    }
  }

  private async refreshArtist(
    artistId: string,
    cacheKey: string,
  ): Promise<{ changed: boolean; value: ArtistPage }> {
    let refresh = this.artistRefreshPromises.get(artistId);
    if (!refresh) {
      refresh = this.fetchArtistFresh(artistId).finally(() => {
        this.artistRefreshPromises.delete(artistId);
      });
      this.artistRefreshPromises.set(artistId, refresh);
    }
    const value = await refresh;
    return { changed: await setCachedJson(cacheKey, value), value };
  }

  private async getArtistArtworkFromPage(artistId: string): Promise<Artist | null> {
    const cacheKey = this.getArtistCacheKey(artistId);
    const cached = await getCachedJson<ArtistPage>(cacheKey);
    if (cached?.artist.artworkUrl) return cached.artist;

    try {
      return (await this.refreshArtist(artistId, cacheKey)).value.artist;
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.getArtistArtworkFromPage failed", {
        artistId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async hydrateArtistArtwork(artists: Artist[]): Promise<Artist[]> {
    const priorityArtists = artists.slice(0, 4);
    const hydrated = await Promise.all(
      priorityArtists.map(async (artist) => {
        const pageArtist = await this.getArtistArtworkFromPage(artist.id);
        if (!pageArtist?.artworkUrl) return artist;
        return {
          ...artist,
          name: artist.name || pageArtist.name,
          artworkUrl: pageArtist.artworkUrl,
          subscriberCount: artist.subscriberCount || pageArtist.subscriberCount,
        };
      }),
    );

    return [...hydrated, ...artists.slice(priorityArtists.length)];
  }

  /**
   * The artist's YouTube channel avatar.
   *
   * Only reached when the music page carries no image at all, and the result is stored in that
   * artist's cached page, so it costs one request per artist ever rather than per view. The
   * `metadata.avatar` field only — a channel's header image is a banner of its own.
   */
  private async getChannelAvatar(channelId: string): Promise<string | undefined> {
    if (!channelId.startsWith("UC")) return undefined;
    try {
      const client = await this.getWebClient();
      const channel = await client.getChannel(channelId);
      const metadata = channel.metadata as {
        avatar?: Array<{ url?: string; width?: number; height?: number }>;
      } | undefined;
      return selectArtworkUrl(collectArtworkCandidates(metadata?.avatar));
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.getChannelAvatar failed", {
        channelId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * The picture for an artist, in strict order of preference:
   *
   *  1. `foreground_thumbnail` — the portrait, when the music page has one,
   *  2. `thumbnail` — the page's own image, used as-is even where it is a wide banner,
   *  3. the YouTube channel avatar, when the music page carries neither,
   *  4. nothing, and the UI draws its placeholder.
   *
   * By field, not by shape: the music page's own image is preferred to the channel's whatever
   * proportions it comes back in, and it is passed through uncropped.
   */
  private async resolveArtistArtwork(
    artistId: string,
    foregroundThumbnail: unknown,
    thumbnail: unknown,
  ): Promise<string | undefined> {
    const portrait = selectArtworkUrl(collectArtworkCandidates(foregroundThumbnail));
    const pageImage = selectArtworkUrl(collectArtworkCandidates(thumbnail));
    const channelAvatar = portrait || pageImage ? undefined : await this.getChannelAvatar(artistId);
    const artworkUrl = portrait ?? pageImage ?? channelAvatar;

    logInternalInfo("YouTubeMusicDataSource.resolveArtistArtwork", {
      artistId,
      source: portrait ? "portrait" : pageImage ? "page-image" : channelAvatar ? "channel" : "none",
      artworkUrl,
    });
    return artworkUrl;
  }

  private async fetchArtistFresh(artistId: string): Promise<ArtistPage> {
    const client = await this.getMusicClient();
    const artistPage = await client.music.getArtist(artistId);
    const header = artistPage.header as unknown as {
      title?: { toString(): string };
      subtitle?: { toString(): string };
      description?: { toString(): string; runs?: Array<{ text?: string }> };
      thumbnail?: {
        contents?: Array<{ url?: string; width?: number; height?: number }>;
      } | Array<{ url?: string; width?: number; height?: number }>;
      foreground_thumbnail?: Array<{ url?: string; width?: number; height?: number }>;
    } | undefined;
    const responseItems = this.collectMusicItems(
      artistPage.page,
      new Set(["artist", "song", "video", "album", "playlist"]),
    );
    const headerText = [
      header?.subtitle?.toString(),
      header?.description?.toString(),
      ...(header?.description?.runs?.map((run) => run.text) ?? []),
    ].filter(Boolean).join(" ");
    /*
     * The artist card for *this* artist, if the page even has one — not merely the first one
     * on it. An artist page ends with "Fans might also like", so the first artist-typed item
     * is usually somebody else, and taking their photo and subscriber count put a stranger's
     * face on the page whenever this artist's own header carried no portrait.
     */
    const artistItem = responseItems.find((item) =>
      item.item_type === "artist"
      && this.normalizeArtistId(item.id ?? this.findBrowseId(item.endpoint)) === artistId);
    const subscriberCount = headerText.match(/[\d,.]+\s*[KMB]?\s+subscribers?/i)?.[0]
      ?? artistItem?.subscribers;
    // A visual header hands back a plain array, an immersive one a node with `contents`.
    const headerThumbnail = Array.isArray(header?.thumbnail)
      ? header.thumbnail
      : header?.thumbnail?.contents;
    const artworkUrl = await this.resolveArtistArtwork(
      artistId,
      header?.foreground_thumbnail,
      headerThumbnail,
    );
    const artist: Artist = {
      id: artistId,
      name: header?.title?.toString()
        || artistItem?.title?.toString()
        || "Artist",
      artworkUrl,
      subscriberCount,
    };

    const popularSongs: Track[] = [];
    const releases: Album[] = [];
    const playlists: Playlist[] = [];
    for (const section of artistPage.sections as unknown as Array<{
      title?: { toString(): string };
      header?: { title?: { toString(): string } };
      contents?: MusicItem[];
    }>) {
      const sectionTitle = (
        section.title?.toString()
        || section.header?.title?.toString()
        || ""
      ).toLocaleLowerCase();
      const contents = section.contents ?? [];
      if (sectionTitle.includes("song")) {
        popularSongs.push(
          ...contents
            .map((item) => this.toTrack(item))
            .filter((item): item is Track => Boolean(item)),
        );
      }
      if (
        sectionTitle.includes("album")
        || sectionTitle.includes("single")
        || sectionTitle.includes("ep")
        || sectionTitle.includes("release")
      ) {
        releases.push(
          ...contents
            .flatMap((item): Album[] => {
              const album = this.toAlbum(item);
              if (!album) return [];
              const itemMetadata = (item.subtitle?.toString() ?? "").toLocaleLowerCase();
              const combinedSection = sectionTitle.includes("single")
                && sectionTitle.includes("ep");
              const metadata = itemMetadata || (combinedSection ? "" : sectionTitle);
              const releaseType: Album["releaseType"] = metadata.includes("ep")
                ? "ep"
                : metadata.includes("single")
                  ? "single"
                  : sectionTitle.includes("single")
                    ? "single"
                    : "album";
              return [{ ...album, releaseType }];
            }),
        );
      }
      if (sectionTitle.includes("playlist")) {
        playlists.push(
          ...contents
            .map((item) => this.toPlaylist(item))
            .filter((item): item is Playlist => Boolean(item)),
        );
      }
    }

    if (popularSongs.length === 0) {
      popularSongs.push(
        ...responseItems
          .filter((item) => item.item_type === "song" || item.item_type === "video")
          .map((item) => this.toTrack(item))
          .filter((item): item is Track => Boolean(item)),
      );
    }
    if (releases.length === 0) {
      releases.push(
        ...responseItems
          .filter((item) => item.item_type === "album")
          .map((item) => this.toAlbum(item))
          .filter((item): item is Album => Boolean(item))
          .map((album) => ({ ...album, releaseType: "album" as const })),
      );
    }
    if (playlists.length === 0) {
      playlists.push(
        ...responseItems
          .filter((item) => item.item_type === "playlist")
          .map((item) => this.toPlaylist(item))
          .filter((item): item is Playlist => Boolean(item)),
      );
    }

    let allSongShelf: Awaited<ReturnType<typeof artistPage.getAllSongs>>;
    try {
      allSongShelf = await artistPage.getAllSongs();
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.fetchArtistFresh all songs unavailable", {
        artistId,
        error: error instanceof Error ? error.message : String(error),
      });
      allSongShelf = undefined;
    }
    const allSongs = allSongShelf
      ? (allSongShelf.contents as unknown as MusicItem[])
        .map((item) => this.toTrack(item))
        .filter((item): item is Track => Boolean(item))
      : popularSongs;

    const enrichedPopularSongs = await Promise.all(
      this.uniqueById(popularSongs).slice(0, 6).map(async (track) => {
        if (track.viewCount) return track;
        try {
          const info = await client.getBasicInfo(track.id);
          const basic = (info as {
            basic_info?: {
              view_count?: number;
            };
          }).basic_info;
          return basic?.view_count
            ? {
                ...track,
                viewCount: basic.view_count,
                viewCountText: `${basic.view_count} views`,
              }
            : track;
        } catch (error) {
          logInternalWarn("YouTubeMusicDataSource.fetchArtistFresh view count unavailable", {
            artistId,
            trackId: track.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return track;
        }
      }),
    );

    const subscriptionToggle = this.findArtistSubscriptionToggle(artistPage.page);
    const subscribed = this.getArtistSubscriptionOverride(artistId) ?? subscriptionToggle?.subscribed;

    return {
      artist,
      subscribed,
      popularSongs: enrichedPopularSongs,
      allSongs: this.uniqueById(allSongs),
      releases: this.uniqueById(releases),
      playlists: this.uniqueById(playlists),
    };
  }

  async getPlaylistTracks(playlist: Playlist, onUpdate?: (tracks: Track[]) => void): Promise<Track[]> {
    const cacheKey = this.getPlaylistTrackCacheKey(playlist.id);
    const cached = await getCachedJson<Track[]>(cacheKey);

    if (cached?.length) {
      globalThis.setTimeout(() => {
        void this.refreshPlaylistTracks(playlist, cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.getPlaylistTracks background refresh failed", {
              playlistId: playlist.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }

    if (cached) {
      logInternalWarn("YouTubeMusicDataSource.getPlaylistTracks ignoring empty cache entry", {
        playlistId: playlist.id,
      });
    }

    return (await this.refreshPlaylistTracks(playlist, cacheKey)).value;
  }

  async getPlaylistTrackPage(
    playlist: Playlist,
    pageKey?: string,
    onUpdate?: (page: TrackPage) => void,
  ): Promise<TrackPage> {
    this.pruneExpiredPlaylistPageSessions();

    const cachedTracks = pageKey
      ? null
      : await getCachedJson<Track[]>(this.getPlaylistTrackCacheKey(playlist.id));
    if (cachedTracks?.length) {
      onUpdate?.({ tracks: cachedTracks, hasMore: false });
    }
    const client = await this.getMusicClient();
    let page: YouTubeMusicPlaylistPage;
    let sessionKey = pageKey;
    let seenTrackIds = new Set<string>();
    let tracks: Track[] = [];

    if (pageKey) {
      const session = this.playlistPageSessions.get(pageKey);
      if (!session || session.playlistId !== playlist.id) {
        logInternalWarn("YouTubeMusicDataSource.getPlaylistTrackPage missing session", {
          playlistId: playlist.id,
          pageKey,
        });
        return { tracks: [], hasMore: false };
      }

      if (!session.playlistPage.has_continuation) {
        this.playlistPageSessions.delete(pageKey);
        return { tracks: [], hasMore: false };
      }

      seenTrackIds = session.seenTrackIds;
      page = session.playlistPage;

      for (let attempts = 0; attempts < 100 && page.has_continuation && tracks.length === 0; attempts += 1) {
        try {
          page = await page.getContinuation();
        } catch (error) {
          this.playlistPageSessions.delete(pageKey);
          logInternalWarn("YouTubeMusicDataSource.getPlaylistTrackPage continuation failed", {
            playlistId: playlist.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return { tracks: [], hasMore: false };
        }
        tracks = this.collectParsedPlaylistPageTracks(page, seenTrackIds);
      }
    } else {
      page = await client.music.getPlaylist(playlist.id) as YouTubeMusicPlaylistPage;
      if (cachedTracks?.length) {
        seenTrackIds = new Set(cachedTracks.map((track) => track.id));
        const freshTracks = this.collectParsedPlaylistPageTracks(page, seenTrackIds);
        tracks = freshTracks.length > 0
          ? await this.cachePlaylistTracks(playlist.id, freshTracks)
          : cachedTracks;
        seenTrackIds = new Set(tracks.map((track) => track.id));
      } else {
        tracks = this.collectParsedPlaylistPageTracks(page, seenTrackIds);
      }

      if (!cachedTracks?.length && tracks.length === 0 && !page.has_continuation) {
        logInternalWarn("YouTubeMusicDataSource.getPlaylistTrackPage verifying empty first page", {
          playlistId: playlist.id,
        });
        const fallbackTracks = await this.collectPlaylistTracksWithEmptyRetries(
          client,
          playlist.id,
          "paged-first-load",
        );
        if (fallbackTracks.length > 0) {
          const cachedFallbackTracks = await this.cachePlaylistTracks(playlist.id, fallbackTracks);
          return { tracks: cachedFallbackTracks, hasMore: false };
        }
      }
    }

    if (tracks.length > 0) {
      await this.cachePlaylistTracks(playlist.id, tracks);
    }

    if (!page.has_continuation) {
      if (sessionKey) this.playlistPageSessions.delete(sessionKey);
      logInternalInfo("YouTubeMusicDataSource.getPlaylistTrackPage complete", {
        playlistId: playlist.id,
        trackCount: tracks.length,
        hasMore: false,
      });
      return { tracks, hasMore: false };
    }

    sessionKey ??= this.createPlaylistPageKey(playlist.id);
    this.playlistPageSessions.set(sessionKey, {
      playlistId: playlist.id,
      playlistPage: page,
      seenTrackIds,
      expiresAt: Date.now() + PLAYLIST_PAGE_SESSION_TTL_MS,
    });

    logInternalInfo("YouTubeMusicDataSource.getPlaylistTrackPage loaded", {
      playlistId: playlist.id,
      trackCount: tracks.length,
      hasMore: true,
    });
    return { tracks, hasMore: true, nextPageKey: sessionKey };
  }

  private async refreshPlaylistTracks(
    playlist: Playlist,
    cacheKey: string,
  ): Promise<{ changed: boolean; value: Track[] }> {
    let refresh = this.playlistRefreshPromises.get(playlist.id);
    if (!refresh) {
      refresh = this.fetchPlaylistTracksFresh(playlist).finally(() => {
        this.playlistRefreshPromises.delete(playlist.id);
      });
      this.playlistRefreshPromises.set(playlist.id, refresh);
    }

    const value = await refresh;
    const changed = value.length > 0
      ? await setCachedJson(cacheKey, value)
      : false;
    return { changed, value };
  }

  private async fetchPlaylistTracksFresh(playlist: Playlist): Promise<Track[]> {
    const client = await this.getMusicClient();
    return this.collectPlaylistTracksWithEmptyRetries(client, playlist.id, "fresh-load");
  }

  /**
   * The id the write APIs accept.
   *
   * Browse ids are prefixed "VL" and the mutation endpoints reject them, so every write has to
   * strip it. This was already being done inline at the one call site that needed it; with
   * five writers it belongs in one place.
   */
  private editablePlaylistId(playlistId: string): string {
    return playlistId.startsWith("VL") ? playlistId.slice(2) : playlistId;
  }

  async createPlaylist(title: string, trackIds: string[] = []): Promise<Playlist> {
    if (!this.musicCookie) {
      throw new Error("Sign in to YouTube Music before creating playlists.");
    }

    const client = await this.getMusicClient();
    const result = await client.playlist.create(title, trackIds);
    if (!result.success || !result.playlist_id) {
      throw new Error("YouTube Music would not create that playlist.");
    }

    logInternalInfo("YouTubeMusicDataSource.createPlaylist", {
      playlistId: result.playlist_id,
      trackCount: trackIds.length,
    });

    return {
      id: result.playlist_id,
      title,
      owner: this.musicAccountName,
      isEditable: true,
      isSaved: true,
    };
  }

  async renamePlaylist(playlist: Playlist, title: string): Promise<void> {
    if (!this.musicCookie) {
      throw new Error("Sign in to YouTube Music before renaming playlists.");
    }

    const client = await this.getMusicClient();
    await client.playlist.setName(this.editablePlaylistId(playlist.id), title);
    logInternalInfo("YouTubeMusicDataSource.renamePlaylist", { playlistId: playlist.id });
  }

  async deletePlaylist(playlist: Playlist): Promise<void> {
    if (!this.musicCookie) {
      throw new Error("Sign in to YouTube Music before deleting playlists.");
    }

    const client = await this.getMusicClient();
    const playlistId = this.editablePlaylistId(playlist.id);
    // youtubei.js 17.0.1's playlist.delete() loses this endpoint's API path and throws
    // "Expected an api_url" before sending a request, so execute the same mutation directly.
    const response = await client.actions.execute("playlist/delete", { playlistId });
    if (!response.success) {
      throw new Error(`Playlist deletion returned HTTP ${response.status_code}.`);
    }
    await setCachedJson(this.getPlaylistTrackCacheKey(playlist.id), []);
    logInternalInfo("YouTubeMusicDataSource.deletePlaylist", { playlistId });
  }

  /**
   * Moves a track to sit directly after `predecessorTrack`, or to the front when it is null.
   *
   * YouTube addresses playlist entries by *set video id* — the id of the row, not of the song —
   * because the same song can appear twice. `playlistItemId` is where that is kept, so a
   * reorder that used the track id would move the wrong row in a playlist with duplicates.
   */
  async reorderPlaylistTracks(
    playlist: Playlist,
    movedTrack: Track,
    predecessorTrack: Track | null,
  ): Promise<void> {
    if (!this.musicCookie) {
      throw new Error("Sign in to YouTube Music before reordering playlists.");
    }
    const movedId = movedTrack.playlistItemId;
    if (!movedId) {
      throw new Error("This song cannot be moved in the playlist.");
    }

    const client = await this.getMusicClient();
    await client.playlist.moveVideo(
      this.editablePlaylistId(playlist.id),
      movedId,
      predecessorTrack?.playlistItemId ?? "",
    );
    logInternalInfo("YouTubeMusicDataSource.reorderPlaylistTracks", {
      playlistId: playlist.id,
      movedTrackId: movedTrack.id,
      toFront: !predecessorTrack,
    });
  }

  /**
   * The playlists that already hold this song, straight from YouTube.
   *
   * This is the same call the web player's "Save to playlist" dialog makes: one request that
   * comes back with every playlist and a flag for whether the song is in it. Reading it beats
   * the alternative — fetching every playlist's contents — by an order of magnitude, and
   * unlike the local record it also knows about songs added anywhere other than here.
   */
  async getPlaylistIdsContainingTrack(track: Track): Promise<string[]> {
    if (!this.musicCookie || track.source === "local") return [];

    const client = await this.getMusicClient();
    const response = await client.actions.execute("/playlist/get_add_to_playlist", {
      videoIds: [track.id],
      excludeWatchLater: true,
    }) as { data?: unknown };

    const ids: string[] = [];
    const seen = new WeakSet<object>();
    const visit = (value: unknown) => {
      if (!value || typeof value !== "object" || seen.has(value)) return;
      seen.add(value);

      const option = (value as { playlistAddToOptionRenderer?: unknown }).playlistAddToOptionRenderer;
      if (option && typeof option === "object") {
        const { playlistId, containsSelectedVideos } = option as {
          playlistId?: string;
          containsSelectedVideos?: string;
        };
        // "ALL" for a single song means it is in there; "SOME" only arises for a selection.
        if (playlistId && containsSelectedVideos && containsSelectedVideos !== "NONE") {
          ids.push(this.normalizePlaylistId(playlistId));
        }
      }

      for (const child of Object.values(value)) visit(child);
    };
    visit(response.data);

    logInternalInfo("YouTubeMusicDataSource.getPlaylistIdsContainingTrack", {
      trackId: track.id,
      playlistCount: ids.length,
    });
    return ids;
  }

  async addTrackToPlaylist(
    track: Track,
    playlist: Playlist,
  ): Promise<"added" | "already-present"> {
    if (!this.musicCookie) {
      throw new Error("Sign in to YouTube Music before adding songs to playlists.");
    }

    logInternalInfo("YouTubeMusicDataSource.addTrackToPlaylist start", {
      trackId: track.id,
      playlistId: playlist.id,
    });

    try {
      const client = await this.getMusicClient();
      const cacheKey = this.getPlaylistTrackCacheKey(playlist.id);
      const cachedTracks = await getCachedJson<Track[]>(cacheKey);
      const existingTracks = cachedTracks
        ?? await this.collectPlaylistTracks(client, playlist.id);
      if (existingTracks.some((item) => item.id === track.id)) {
        if (!cachedTracks) await setCachedJson(cacheKey, existingTracks);
        logInternalInfo("YouTubeMusicDataSource.addTrackToPlaylist already present", {
          trackId: track.id,
          playlistId: playlist.id,
          source: cachedTracks ? "cache" : "network",
        });
        return "already-present";
      }

      await client.playlist.addVideos(this.editablePlaylistId(playlist.id), [track.id]);

      let confirmedTracks: Track[] | null = null;
      for (const delayMs of [0, 500, 1500]) {
        if (delayMs > 0) {
          await new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs));
        }

        const tracks = await this.collectPlaylistTracks(client, playlist.id);
        if (tracks.some((item) => item.id === track.id)) {
          confirmedTracks = tracks;
          break;
        }
      }

      if (!confirmedTracks) {
        throw new Error("YouTube Music did not confirm the playlist update.");
      }

      await setCachedJson(cacheKey, confirmedTracks);

      logInternalInfo("YouTubeMusicDataSource.addTrackToPlaylist success", {
        trackId: track.id,
        playlistId: playlist.id,
      });
      return "added";
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.addTrackToPlaylist failed", error, {
        trackId: track.id,
        playlistId: playlist.id,
      });
      throw new Error("YouTube Music could not add this song to the playlist.");
    }
  }

  async setPlaylistSaved(playlist: Playlist, saved: boolean): Promise<void> {
    if (!this.musicCookie) {
      throw new Error("Sign in to YouTube Music to update your library.");
    }
    const client = await this.getMusicClient();
    const playlistId = playlist.id.startsWith("VL") ? playlist.id.slice(2) : playlist.id;
    try {
      const directResponse = await this.executePlaylistLibraryLikeCommand(client, playlistId, saved);
      if (directResponse.success === false) {
        throw new Error(`Playlist library update returned HTTP ${directResponse.status_code}.`);
      }
      logInternalInfo("YouTubeMusicDataSource.setPlaylistSaved direct like command", {
        playlistId,
        saved,
      });
      return;
    } catch (directError) {
      logInternalWarn("YouTubeMusicDataSource.setPlaylistSaved direct like command failed", {
        playlistId,
        saved,
        error: directError instanceof Error ? directError.message : String(directError),
      });
    }

    try {
      const browseIds = [...new Set([playlist.id, playlistId, `VL${playlistId}`])];

      for (const browseId of browseIds) {
        let response: unknown;
        try {
          response = await this.executeMusicBrowse(client, { browseId });
        } catch (error) {
          logInternalWarn("YouTubeMusicDataSource.setPlaylistSaved browse failed", {
            playlistId,
            browseId,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }

        const rawToggle = this.findRawLibraryToggle(response);
        if (!rawToggle) continue;

        if (rawToggle.isToggled === saved) return;
        const endpoint = saved
          ? rawToggle.defaultServiceEndpoint
          : rawToggle.toggledServiceEndpoint;
        if (!endpoint) {
          throw new Error("YouTube Music returned an incomplete library command for this playlist.");
        }

        logInternalInfo("YouTubeMusicDataSource.setPlaylistSaved raw command", {
          playlistId,
          browseId,
          saved,
          iconType: rawToggle.defaultIcon?.iconType,
          defaultTooltip: rawToggle.defaultTooltip,
          toggledTooltip: rawToggle.toggledTooltip,
        });

        const updateResponse = await this.executeRawServiceEndpoint(client, endpoint);
        if (updateResponse.success === false) {
          throw new Error(`Playlist library update returned HTTP ${updateResponse.status_code}.`);
        }
        return;
      }

      const playlistPage = await client.music.getPlaylist(playlistId);
      const toggle = this.findLibraryToggleEndpoint(playlistPage.page);
      if (!toggle) {
        throw new Error("YouTube Music did not return a library command for this playlist.");
      }
      if (toggle.isToggled === saved) return;

      const endpoint = saved ? toggle.endpoint : toggle.toggledEndpoint;
      if (!endpoint) {
        throw new Error("YouTube Music returned an incomplete library command for this playlist.");
      }

      logInternalInfo("YouTubeMusicDataSource.setPlaylistSaved command", {
        playlistId,
        saved,
        iconType: toggle.iconType,
        tooltip: toggle.tooltip,
        toggledTooltip: toggle.toggledTooltip,
      });

      const response = await endpoint.call(client.actions, { client: "YTMUSIC" });
      if (response.success === false) {
        throw new Error(`Playlist library update returned HTTP ${response.status_code}.`);
      }
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.setPlaylistSaved failed", error, {
        playlistId,
        saved,
      });
      throw new Error(
        saved
          ? "YouTube Music could not save this playlist."
          : "YouTube Music could not remove this playlist.",
      );
    }
  }

  async removeTrackFromPlaylist(track: Track, playlist: Playlist): Promise<void> {
    if (!this.musicCookie) {
      throw new Error("Sign in to YouTube Music before removing songs from playlists.");
    }
    if (!track.playlistItemId) {
      throw new Error("Reload the playlist before removing this song.");
    }

    logInternalInfo("YouTubeMusicDataSource.removeTrackFromPlaylist start", {
      trackId: track.id,
      playlistItemId: track.playlistItemId,
      playlistId: playlist.id,
    });

    try {
      const client = await this.getMusicClient();
      const cacheKey = this.getPlaylistTrackCacheKey(playlist.id);
      const editablePlaylistId = playlist.id.startsWith("VL")
        ? playlist.id.slice(2)
        : playlist.id;

      const response = await client.actions.execute("browse/edit_playlist", {
        playlistId: editablePlaylistId,
        actions: [
          {
            action: "ACTION_REMOVE_VIDEO",
            setVideoId: track.playlistItemId,
          },
        ],
      });
      if (!response.success) {
        throw new Error(`Playlist edit returned HTTP ${response.status_code}.`);
      }

      const cachedTracks = await getCachedJson<Track[]>(cacheKey);
      if (cachedTracks) {
        await setCachedJson(
          cacheKey,
          cachedTracks.filter((item) => item.playlistItemId !== track.playlistItemId),
        );
      }

      logInternalInfo("YouTubeMusicDataSource.removeTrackFromPlaylist success", {
        trackId: track.id,
        playlistItemId: track.playlistItemId,
        playlistId: playlist.id,
      });
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.removeTrackFromPlaylist failed", error, {
        trackId: track.id,
        playlistId: playlist.id,
      });
      throw new Error("YouTube Music could not remove this song from the playlist.");
    }
  }

  /** Kept for callers that only deal in likes; the rating path is the single implementation. */
  async setTrackLiked(track: Track, liked: boolean): Promise<void> {
    await this.setTrackRating(track, liked ? "like" : "none");
  }

  async setTrackRating(track: Track, rating: TrackRating): Promise<void> {
    if (!this.musicCookie) {
      throw new Error("Sign in to rate songs.");
    }

    logInternalInfo("YouTubeMusicDataSource.setTrackRating start", {
      trackId: track.id,
      rating,
    });

    try {
      const client = await this.getMusicClient();
      const response = await this.executeTrackRatingCommand(client, track.id, rating);

      if (!response.success) {
        // A rejected identity is not a rejected rating: saying "could not like this song" for
        // it sends the user looking for a problem with the song.
        if (response.status_code === 401 || response.status_code === 403) {
          throw new YouTubeMusicAuthError(
            "YouTube Music no longer accepts the saved sign-in. Sign in again to rate songs.",
          );
        }
        throw new Error(`YouTube returned HTTP ${response.status_code}.`);
      }

      /*
       * Liked Songs mirrors the rating locally so the library does not need a refetch. Only a
       * like adds; both "dislike" and "none" remove, because a disliked song is not liked —
       * leaving it in the list would show it as liked until the next full sync.
       */
      const liked = rating === "like";
      const cachedLibrary = await getCachedJson<LibrarySnapshot>(LIBRARY_CACHE_KEY);
      if (cachedLibrary) {
        const likedSongs = liked
          ? this.uniqueById([track, ...cachedLibrary.likedSongs])
          : cachedLibrary.likedSongs.filter((item) => item.id !== track.id);
        await setCachedJson(LIBRARY_CACHE_KEY, {
          ...cachedLibrary,
          likedSongs,
        });
      }
      const likedSongsCacheKey = this.getPlaylistTrackCacheKey(LIKED_SONGS_PLAYLIST_ID);
      const cachedLikedSongs = await getCachedJson<Track[]>(likedSongsCacheKey);
      if (liked) {
        await this.cachePlaylistTracks(LIKED_SONGS_PLAYLIST_ID, [track]);
      } else if (cachedLikedSongs) {
        await setCachedJson(
          likedSongsCacheKey,
          cachedLikedSongs.filter((item) => item.id !== track.id),
        );
      }

      logInternalInfo("YouTubeMusicDataSource.setTrackRating success", {
        trackId: track.id,
        rating,
      });
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.setTrackRating failed", error, {
        trackId: track.id,
        rating,
      });
      if (error instanceof AuthExpiredError) throw error;
      throw new Error(
        rating === "like"
          ? "YouTube Music could not like this song."
          : rating === "dislike"
            ? "YouTube Music could not dislike this song."
            : "YouTube Music could not clear this rating.",
      );
    }
  }

  async getTrack(id: string): Promise<Track> {
    const trackId = id;
    if (!trackId) throw new Error("A track id is required.");
    const cacheKey = `youtube-music:track:v1:${trackId}`;
    const cached = await getCachedJson<Track>(cacheKey);

    if (cached?.artworkUrl) {
      globalThis.setTimeout(() => {
        void this.refreshTrack(trackId, cacheKey).catch((error) => {
          logInternalWarn("YouTubeMusicDataSource.getTrack background refresh failed", {
            trackId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }, 0);
      return cached;
    }

    if (cached) {
      try {
        return await this.refreshTrack(trackId, cacheKey);
      } catch (error) {
        logInternalWarn("YouTubeMusicDataSource.getTrack missing-artwork refresh failed", {
          trackId,
          error: error instanceof Error ? error.message : String(error),
        });
        return cached;
      }
    }

    try {
      return await this.refreshTrack(trackId, cacheKey);
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.getTrack failed", error, { trackId });
      return {
        id: trackId,
        source: "youtube",
        title: `Track (${trackId})`,
        artist: "Unknown artist",
      };
    }
  }

  async getLyrics(track: Track): Promise<Lyrics> {
    /*
     * v3: the cached shape now carries the per-source attempt log, and a v2 entry would
     * leave the lyrics screen unable to say where its words came from.
     *
     * The preferred source is part of the key because it changes which source wins. Sharing
     * one key would mean changing the setting appears to do nothing until the cache expires.
     */
    const cacheKey = `lyrics:synced:v3:${getPreferredLyricsSourceId()}:${track.id}`;
    const cached = await getCachedJson<Lyrics>(cacheKey);
    if (cached?.timing === "synced" && cached.lines.length > 0) return cached;

    let refresh = this.lyricsRefreshPromises.get(track.id);
    if (!refresh) {
      refresh = this.fetchSyncedLyrics(track).finally(() => {
        this.lyricsRefreshPromises.delete(track.id);
      });
      this.lyricsRefreshPromises.set(track.id, refresh);
    }

    const lyrics = await refresh;
    /*
     * Only a synced hit is worth keeping. Caching an unsynced fallback — or a total miss —
     * would freeze this song on its worst available source forever, when the usual reason a
     * track has no synced lyrics today is that nobody has contributed them *yet*.
     */
    if (lyrics.timing === "synced" && lyrics.lines.length > 0) {
      await setCachedJson(cacheKey, lyrics);
    }
    return lyrics;
  }

  /**
   * Runs the source table and reports what every source did.
   *
   * Always resolves to a Lyrics object, empty when nothing was found, so the caller can show
   * the attempt log rather than a bare "not available" that explains nothing.
   */
  private async fetchSyncedLyrics(track: Track): Promise<Lyrics> {
    logInternalInfo("YouTubeMusicDataSource.getLyrics start", { trackId: track.id });

    const runners: Record<string, () => Promise<Lyrics | null>> = {
      "lrclib-exact": () => this.fetchLrcLibExactLyrics(track),
      betterlyrics: () => this.fetchBetterLyrics(track),
      "lrclib-search": () => this.fetchLrcLibSearchLyrics(track),
      "youtube-transcript": () => this.fetchYouTubeTranscriptLyrics(track),
      "youtube-music": () => this.fetchYouTubeMusicLyrics(track),
    };

    const preferredId = getPreferredLyricsSourceId();
    const attempts: LyricsSourceAttempt[] = [];
    let winner: { source: LyricsSource; lyrics: Lyrics | null } | undefined;

    for (const sources of planLyricsWaves(preferredId)) {
      const results = await Promise.all(
        sources.map((source) => {
          const blocked = unmetPrecondition(source, track);
          if (blocked) {
            return Promise.resolve({
              source,
              lyrics: null,
              attempt: skippedAttempt(source, blocked),
            });
          }
          return this.runLyricsSource(source, track.id, runners[source.id]);
        }),
      );
      for (const result of results) attempts.push(result.attempt);

      winner = pickBestLyrics(results, preferredId);
      if (winner) break;
    }

    // Wave 2 never ran when wave 1 hit. Listing it as skipped shows the priority as a fact
    // rather than leaving a gap that reads like a failure.
    for (const source of LYRICS_SOURCES) {
      if (!attempts.some((attempt) => attempt.id === source.id)) {
        attempts.push(skippedAttempt(source));
      }
    }
    const orderedAttempts = sortAttempts(attempts, preferredId);

    if (!winner?.lyrics) {
      logInternalWarn("YouTubeMusicDataSource.getLyrics exhausted every source", {
        trackId: track.id,
        attempts: orderedAttempts.map((attempt) => `${attempt.id}:${attempt.status}`).join(","),
      });
      return { lines: [], timing: "none", attempts: orderedAttempts };
    }

    return {
      ...winner.lyrics,
      sourceId: winner.source.id,
      sourceLabel: winner.lyrics.sourceLabel || winner.source.label,
      attempts: orderedAttempts,
    };
  }

  /** One source, bounded by its own timeout, reduced to a result plus a status line. */
  private async runLyricsSource(
    source: LyricsSource,
    trackId: string,
    run: (() => Promise<Lyrics | null>) | undefined,
  ): Promise<{ source: LyricsSource; lyrics: Lyrics | null; attempt: LyricsSourceAttempt }> {
    const base = { id: source.id, label: source.label, durationMs: 0 };
    if (!run) {
      return { source, lyrics: null, attempt: { ...base, status: "skipped", detail: "Unavailable" } };
    }

    const startedAt = Date.now();
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutId = globalThis.setTimeout(() => resolve("timeout"), source.timeoutMs);
    });

    try {
      const outcome = await Promise.race([run(), timeout]);
      const durationMs = Date.now() - startedAt;

      if (outcome === "timeout") {
        logInternalWarn("YouTubeMusicDataSource.getLyrics source timed out", {
          trackId,
          source: source.id,
          timeoutMs: source.timeoutMs,
        });
        return {
          source,
          lyrics: null,
          attempt: {
            ...base,
            status: "timeout",
            durationMs,
            detail: `No answer in ${(source.timeoutMs / 1000).toFixed(1)}s`,
          },
        };
      }

      const lineCount = outcome?.lines.length ?? 0;
      return {
        source,
        lyrics: lineCount > 0 ? outcome : null,
        attempt: {
          ...base,
          status: lineCount > 0 ? "hit" : "miss",
          durationMs,
          detail: lineCount > 0 ? `${lineCount} lines` : "No match",
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logInternalWarn("YouTubeMusicDataSource.getLyrics source failed", {
        trackId,
        source: source.id,
        error: message,
      });
      return {
        source,
        lyrics: null,
        attempt: {
          ...base,
          status: "error",
          durationMs: Date.now() - startedAt,
          detail: message.slice(0, 120),
        },
      };
    } finally {
      if (timeoutId) globalThis.clearTimeout(timeoutId);
    }
  }

  private async fetchYouTubeTranscriptLyrics(track: Track): Promise<Lyrics | null> {
    const webClient = await this.getWebClient();
    const info = await webClient.getInfo(track.id);
    const transcript = await info.getTranscript();
    const segments = transcript.transcript.content?.body?.initial_segments ?? [];
    const timedLines = segments.flatMap((segment) => {
      const item = segment as unknown as {
        start_ms?: string;
        end_ms?: string;
        snippet?: { toString(): string };
      };
      const text = item.snippet?.toString().trim();
      const startTimeMs = Number(item.start_ms);
      const endTimeMs = Number(item.end_ms);
      if (!text || !Number.isFinite(startTimeMs)) return [];

      return [{
        text,
        startTimeSec: startTimeMs / 1000,
        endTimeSec: Number.isFinite(endTimeMs) ? endTimeMs / 1000 : undefined,
      }];
    });

    if (timedLines.length === 0) return null;
    return { lines: timedLines, timing: "synced", sourceLabel: "YouTube" };
  }

  private async fetchLrcLibExactLyrics(track: Track): Promise<LyricsProviderResult | null> {
    const durationSec = this.getRoundedDurationSec(track);
    if (!durationSec) return null;

    for (const query of this.getLyricsQueries(track)) {
      const params = new URLSearchParams({
        track_name: query.title,
        artist_name: query.artist,
        duration: String(durationSec),
      });
      if (query.album) params.set("album_name", query.album);

      try {
        const response = await tauriFetch(`https://lrclib.net/api/get?${params}`, {
          headers: this.getLyricsRequestHeaders(),
          timeoutMs: 2_500,
        });
        if (!response.ok) continue;

        const match = await response.json() as LrcLibTrack;
        const result = this.toLrcLibLyrics(track, match, "LRCLIB");
        if (result) return result;
      } catch (error) {
        logInternalWarn("YouTubeMusicDataSource.getLyrics LRCLIB exact unavailable", {
          trackId: track.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return null;
  }

  private async fetchLrcLibSearchLyrics(track: Track): Promise<LyricsProviderResult | null> {
    const durationSec = track.durationSec;
    if (!durationSec || durationSec <= 0) return null;

    for (const query of this.getLyricsQueries(track)) {
      try {
        const params = new URLSearchParams({
          track_name: query.title,
          artist_name: query.artist,
        });
        if (query.album) params.set("album_name", query.album);

        const response = await tauriFetch(`https://lrclib.net/api/search?${params}`, {
          headers: this.getLyricsRequestHeaders(),
          timeoutMs: 4_500,
        });
        if (!response.ok) continue;

        const matches = await response.json() as LrcLibTrack[];
        const candidates = matches
          .map((match) => ({
            match,
            durationDelta: this.getLyricsDurationDelta(track, match.duration),
          }))
          .filter(({ match, durationDelta }) => Boolean(match.syncedLyrics) && durationDelta <= 2)
          .sort((left, right) => left.durationDelta - right.durationDelta);

        for (const candidate of candidates) {
          const result = this.toLrcLibLyrics(track, candidate.match, "LRCLIB search");
          if (result) return result;
        }
      } catch (error) {
        logInternalWarn("YouTubeMusicDataSource.getLyrics LRCLIB search unavailable", {
          trackId: track.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return null;
  }

  private async fetchBetterLyrics(track: Track): Promise<LyricsProviderResult | null> {
    const durationSec = this.getRoundedDurationSec(track);

    for (const query of this.getLyricsQueries(track)) {
      const params = new URLSearchParams({
        s: query.title,
        a: query.artist,
      });
      if (durationSec) params.set("d", String(durationSec));
      if (query.album) params.set("al", query.album);

      try {
        const response = await tauriFetch(`https://lyrics-api.boidu.dev/getLyrics?${params}`, {
          headers: this.getLyricsRequestHeaders(),
          timeoutMs: 3_500,
        });
        if (!response.ok) continue;

        const body = await response.json() as BetterLyricsResponse;
        if (!body.ttml) continue;

        const lines = this.parseTtmlLyrics(body.ttml);
        if (lines.length === 0) continue;

        logInternalInfo("YouTubeMusicDataSource.getLyrics BetterLyrics success", {
          trackId: track.id,
          lineCount: lines.length,
        });
        return {
          lines,
          timing: "synced",
          sourceLabel: "BetterLyrics",
        };
      } catch (error) {
        logInternalWarn("YouTubeMusicDataSource.getLyrics BetterLyrics unavailable", {
          trackId: track.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return null;
  }

  private toLrcLibLyrics(
    track: Track,
    match: LrcLibTrack,
    sourceLabel: string,
  ): LyricsProviderResult | null {
    if (!match.syncedLyrics) return null;
    const durationDelta = this.getLyricsDurationDelta(track, match.duration);
    if (durationDelta > 2) return null;

    const lines = this.parseSyncedLyrics(match.syncedLyrics);
    if (lines.length === 0) return null;

    logInternalInfo("YouTubeMusicDataSource.getLyrics LRCLIB success", {
      trackId: track.id,
      lineCount: lines.length,
      durationDelta,
      sourceLabel,
    });
    return {
      lines,
      timing: "synced",
      sourceLabel,
    };
  }

  private getLyricsRequestHeaders(): Record<string, string> {
    return {
      Accept: "application/json",
      "User-Agent": "Zuno/1.0",
    };
  }

  private getRoundedDurationSec(track: Track): number | null {
    const durationSec = track.durationSec;
    if (!durationSec || durationSec <= 0) return null;
    return Math.round(durationSec);
  }

  private getLyricsDurationDelta(track: Track, providerDuration: number | undefined): number {
    if (typeof providerDuration !== "number") return Number.POSITIVE_INFINITY;
    const durationSec = track.durationSec;
    if (!durationSec || durationSec <= 0) return Number.POSITIVE_INFINITY;
    return Math.abs(providerDuration - durationSec);
  }

  private getLyricsQueries(track: Track): Array<{ title: string; artist: string; album?: string }> {
    const artists = [
      track.artist,
      ...(track.artists?.map((artist) => artist.name) ?? []),
    ];
    const titles = [
      track.title,
      this.cleanLyricsLookupText(track.title),
    ];
    const albums = [
      track.album,
      track.album ? this.cleanLyricsLookupText(track.album) : undefined,
    ];
    const queries: Array<{ title: string; artist: string; album?: string }> = [];
    const seen = new Set<string>();

    for (const title of titles) {
      if (!title) continue;
      for (const artist of artists) {
        if (!artist || artist === "Unknown artist") continue;
        const cleanedArtist = this.cleanLyricsLookupText(artist);
        for (const artistName of [artist, cleanedArtist]) {
          if (!artistName) continue;
          const album = albums.find((value) => value && value !== "Unknown album");
          const key = `${title}\n${artistName}\n${album ?? ""}`;
          if (seen.has(key)) continue;
          seen.add(key);
          queries.push({ title, artist: artistName, album });
        }
      }
    }

    return queries.length > 0
      ? queries.slice(0, 6)
      : [{ title: track.title, artist: track.artist, album: track.album }];
  }

  private cleanLyricsLookupText(value: string): string {
    return value
      .replace(/\s*[\[(](?:official\s*)?(?:music\s*)?(?:video|visualizer|audio|lyrics?|lyric\s*video|remaster(?:ed)?|radio edit|single version|album version|live|feat\.?|ft\.?)[^\])]*[\])]\s*/gi, " ")
      .replace(/\s+-\s+(?:official\s*)?(?:music\s*)?(?:video|visualizer|audio|lyrics?|lyric\s*video).*$/i, "")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  private parseSyncedLyrics(lrc: string): Lyrics["lines"] {
    const lines: Lyrics["lines"] = [];
    const timestampPattern = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

    for (const rawLine of lrc.split(/\r?\n/)) {
      const text = rawLine.replace(timestampPattern, "").trim();
      if (!text) continue;

      const timestamps = [...rawLine.matchAll(timestampPattern)];
      for (const timestamp of timestamps) {
        const minutes = Number(timestamp[1]);
        const seconds = Number(timestamp[2]);
        const fraction = timestamp[3] ?? "0";
        const fractionSec = Number(fraction.padEnd(3, "0").slice(0, 3)) / 1000;
        lines.push({
          text,
          startTimeSec: minutes * 60 + seconds + fractionSec,
        });
      }
    }

    lines.sort((left, right) => (left.startTimeSec ?? 0) - (right.startTimeSec ?? 0));
    return lines.map((line, index) => ({
      ...line,
      endTimeSec: lines[index + 1]?.startTimeSec,
    }));
  }

  private parseTtmlLyrics(ttml: string): Lyrics["lines"] {
    const parser = new DOMParser();
    const document = parser.parseFromString(ttml, "application/xml");
    if (document.querySelector("parsererror")) return [];

    const lines = [...document.getElementsByTagName("p")].flatMap((node) => {
      const startTimeSec = this.parseTtmlTime(node.getAttribute("begin") ?? node.getAttribute("start"));
      if (startTimeSec === undefined) return [];

      const endTimeSec = this.parseTtmlTime(node.getAttribute("end"));
      const text = (node.textContent ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) return [];

      return [{
        text,
        startTimeSec,
        endTimeSec,
      }];
    });

    lines.sort((left, right) => (left.startTimeSec ?? 0) - (right.startTimeSec ?? 0));
    return lines.map((line, index) => ({
      ...line,
      endTimeSec: line.endTimeSec ?? lines[index + 1]?.startTimeSec,
    }));
  }

  private parseTtmlTime(value: string | null): number | undefined {
    if (!value) return undefined;

    const clockTime = value.match(/^(\d+):(\d{2}):(\d{2})(?:[.:](\d{1,3}))?$/);
    if (clockTime) {
      const hours = Number(clockTime[1]);
      const minutes = Number(clockTime[2]);
      const seconds = Number(clockTime[3]);
      const fraction = clockTime[4] ?? "0";
      return hours * 3600 + minutes * 60 + seconds + Number(fraction.padEnd(3, "0").slice(0, 3)) / 1000;
    }

    const minuteTime = value.match(/^(\d+):(\d{2})(?:[.:](\d{1,3}))?$/);
    if (minuteTime) {
      const minutes = Number(minuteTime[1]);
      const seconds = Number(minuteTime[2]);
      const fraction = minuteTime[3] ?? "0";
      return minutes * 60 + seconds + Number(fraction.padEnd(3, "0").slice(0, 3)) / 1000;
    }

    const offsetTime = value.match(/^([\d.]+)(h|m|s|ms)$/);
    if (offsetTime) {
      const amount = Number(offsetTime[1]);
      if (!Number.isFinite(amount)) return undefined;
      if (offsetTime[2] === "h") return amount * 3600;
      if (offsetTime[2] === "m") return amount * 60;
      if (offsetTime[2] === "s") return amount;
      return amount / 1000;
    }

    return undefined;
  }

  private async refreshTrack(trackId: string, cacheKey: string): Promise<Track> {
    let refresh = this.trackRefreshPromises.get(trackId);
    if (!refresh) {
      refresh = this.fetchTrackFresh(trackId).finally(() => {
        this.trackRefreshPromises.delete(trackId);
      });
      this.trackRefreshPromises.set(trackId, refresh);
    }

    const track = await refresh;
    await setCachedJson(cacheKey, track);
    return track;
  }

  private async fetchTrackFresh(trackId: string): Promise<Track> {
    logInternalInfo("YouTubeMusicDataSource.getTrack start", { trackId });
    const yt = await this.getMusicClient();
    const info = await yt.getBasicInfo(trackId);
    const basic = (info as any).basic_info;
    const artwork = selectArtworkUrl(basic?.thumbnail);
    const track: Track = {
      id: basic?.id ?? trackId,
      source: "youtube",
      title: basic?.title ?? `Track (${trackId})`,
      artist: basic?.author ?? "Unknown artist",
      artists: basic?.channel_id && basic?.author
        ? [{ id: basic.channel_id, name: basic.author }]
        : undefined,
      durationSec: basic?.duration,
      artworkUrl: artwork,
    };

    logInternalInfo("YouTubeMusicDataSource.getTrack success", {
      trackId: track.id,
      title: track.title,
    });
    return track;
  }

  async search(
    query: string,
    onUpdate?: (results: SearchResults) => void,
  ): Promise<SearchResults> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      return { artists: [], tracks: [], albums: [], playlists: [] };
    }
    const cacheId = normalizedQuery.toLocaleLowerCase();
    const cacheKey = `youtube-music:mixed-search:v5:${cacheId}`;
    const cached = await getCachedJson<SearchResults>(cacheKey);
    if (cached && this.hasSearchResults(cached)) {
      globalThis.setTimeout(() => {
        void this.refreshMixedSearch(normalizedQuery, cacheId, cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.search background refresh failed", {
              query: normalizedQuery,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }
    return (await this.refreshMixedSearch(normalizedQuery, cacheId, cacheKey)).value;
  }

  private async refreshMixedSearch(
    query: string,
    cacheId: string,
    cacheKey: string,
  ): Promise<{ changed: boolean; value: SearchResults }> {
    let refresh = this.mixedSearchRefreshPromises.get(cacheId);
    if (!refresh) {
      refresh = this.fetchMixedSearchFresh(query).finally(() => {
        this.mixedSearchRefreshPromises.delete(cacheId);
      });
      this.mixedSearchRefreshPromises.set(cacheId, refresh);
    }
    const value = await refresh;
    return { changed: await setCachedJson(cacheKey, value), value };
  }

  private async fetchMixedSearchFresh(query: string): Promise<SearchResults> {
    const client = await this.getMusicClient();
    const [response, artistResponse] = await Promise.all([
      client.music.search(query),
      client.music.search(query, { type: "artist" }).catch(() => null),
    ]);
    const fromShelf = <T>(
      shelf: { contents?: unknown[] } | undefined,
      mapper: (item: MusicItem) => T | null,
    ): T[] => (shelf?.contents ?? [])
      .map((item) => mapper(item as MusicItem))
      .filter((item): item is T => Boolean(item));

    const libraryPlaylistIds = new Set(
      this.libraryRefreshPromise
        ? []
        : (await getCachedJson<LibrarySnapshot>(LIBRARY_CACHE_KEY))?.playlists.map(
          (playlist) => playlist.id.replace(/^VL/, ""),
        ) ?? [],
    );
    const fallbackItems = this.collectMusicItems(
      response.page,
      new Set(["artist", "song", "video", "album", "playlist"]),
    );
    const artistFallbackItems = artistResponse
      ? this.collectMusicItems(artistResponse.page, new Set(["artist"]))
      : [];
    const artistCardItems = [
      ...this.collectArtistCardItems(response.page),
      ...(artistResponse ? this.collectArtistCardItems(artistResponse.page) : []),
    ];
    const shelfArtists = fromShelf(response.artists, (item) => this.toArtist(item));
    const shelfTracks = fromShelf(response.songs, (item) => this.toTrack(item));
    const shelfAlbums = fromShelf(response.albums, (item) => this.toAlbum(item));
    const shelfPlaylists = fromShelf(response.playlists, (item) => this.toPlaylist(item));
    const playlists = [
      ...shelfPlaylists,
      ...fallbackItems
        .filter((item) => item.item_type === "playlist")
        .map((item) => this.toPlaylist(item))
        .filter((item): item is Playlist => Boolean(item)),
    ]
      .map((playlist) => ({
        ...playlist,
        isSaved: libraryPlaylistIds.has(playlist.id.replace(/^VL/, "")),
      }));

    const tracks = this.uniqueById([
      ...shelfTracks,
      ...fallbackItems
        .filter((item) => item.item_type === "song" || item.item_type === "video")
        .map((item) => this.toTrack(item))
        .filter((item): item is Track => Boolean(item)),
    ]);
    const albums = this.uniqueById([
      ...shelfAlbums,
      ...fallbackItems
        .filter((item) => item.item_type === "album")
        .map((item) => this.toAlbum(item))
        .filter((item): item is Album => Boolean(item)),
    ]);

    const artists = await this.hydrateArtistArtwork(this.uniqueById([
      ...shelfArtists,
      ...fromShelf(artistResponse?.artists, (item) => this.toArtist(item)),
      ...fallbackItems
        .filter((item) => item.item_type === "artist")
        .map((item) => this.toArtist(item))
        .filter((item): item is Artist => Boolean(item)),
      ...artistFallbackItems
        .map((item) => this.toArtist(item))
        .filter((item): item is Artist => Boolean(item)),
      ...artistCardItems
        .map((item) => this.toArtist(item))
        .filter((item): item is Artist => Boolean(item)),
      ...this.artistsFromReferences([...tracks, ...albums], query),
    ]));

    const results = {
      artists,
      tracks,
      albums,
      playlists: this.uniqueById(playlists),
    };
    if (this.hasSearchResults(results)) return results;

    const fallbackTracks = await this.fetchSearchTracksFresh(query);
    return { artists: [], tracks: fallbackTracks, albums: [], playlists: [] };
  }

  private hasSearchResults(results: SearchResults): boolean {
    return results.artists.length > 0
      || results.tracks.length > 0
      || results.albums.length > 0
      || results.playlists.length > 0;
  }

  async searchTracks(query: string, onUpdate?: (tracks: Track[]) => void): Promise<Track[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];
    const cacheId = normalizedQuery.toLowerCase();
    const cacheKey = `youtube-music:search:v1:${cacheId}`;
    const cached = await getCachedJson<Track[]>(cacheKey);

    if (cached) {
      globalThis.setTimeout(() => {
        void this.refreshSearchTracks(normalizedQuery, cacheId, cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.searchTracks background refresh failed", {
              query: normalizedQuery,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }

    return (await this.refreshSearchTracks(normalizedQuery, cacheId, cacheKey)).value;
  }

  private async refreshSearchTracks(
    query: string,
    cacheId: string,
    cacheKey: string,
  ): Promise<{ changed: boolean; value: Track[] }> {
    let refresh = this.searchRefreshPromises.get(cacheId);
    if (!refresh) {
      refresh = this.fetchSearchTracksFresh(query).finally(() => {
        this.searchRefreshPromises.delete(cacheId);
      });
      this.searchRefreshPromises.set(cacheId, refresh);
    }

    const value = await refresh;
    const changed = await setCachedJson(cacheKey, value);
    return { changed, value };
  }

  private async fetchSearchTracksFresh(normalizedQuery: string): Promise<Track[]> {
    logInternalInfo("YouTubeMusicDataSource.searchTracks start", {
      query: normalizedQuery,
    });

    try {
      const client = await this.getMusicClient();
      const response = await client.music.search(normalizedQuery, { type: "song" });
      const tracks = this.uniqueById(
        (response.songs?.contents ?? [])
        .map((item) => this.toTrack(item as unknown as MusicItem))
          .filter((item): item is Track => Boolean(item)),
      );

      logInternalInfo("YouTubeMusicDataSource.searchTracks success", {
        query: normalizedQuery,
        trackCount: tracks.length,
      });
      return tracks;
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.searchTracks failed", error, {
        query: normalizedQuery,
      });
      throw new Error("Unable to search for songs.");
    }
  }

  async getSearchSuggestions(
    query: string,
    onUpdate?: (suggestions: string[]) => void,
  ): Promise<string[]> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];
    const cacheId = normalizedQuery.toLowerCase();
    const cacheKey = `youtube-music:search-suggestions:v1:${cacheId}`;
    const cached = await getCachedJson<string[]>(cacheKey);

    if (cached) {
      globalThis.setTimeout(() => {
        void this.refreshSearchSuggestions(normalizedQuery, cacheId, cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.getSearchSuggestions background refresh failed", {
              query: normalizedQuery,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }

    try {
      return (await this.refreshSearchSuggestions(normalizedQuery, cacheId, cacheKey)).value;
    } catch {
      return [];
    }
  }

  private async refreshSearchSuggestions(
    query: string,
    cacheId: string,
    cacheKey: string,
  ): Promise<{ changed: boolean; value: string[] }> {
    let refresh = this.suggestionRefreshPromises.get(cacheId);
    if (!refresh) {
      refresh = this.fetchSearchSuggestionsFresh(query).finally(() => {
        this.suggestionRefreshPromises.delete(cacheId);
      });
      this.suggestionRefreshPromises.set(cacheId, refresh);
    }

    const value = await refresh;
    const changed = await setCachedJson(cacheKey, value);
    return { changed, value };
  }

  private async fetchSearchSuggestionsFresh(normalizedQuery: string): Promise<string[]> {
    try {
      const client = await this.getMusicClient();
      const sections = await client.music.getSearchSuggestions(normalizedQuery);
      const suggestions = sections.flatMap((section) =>
        section.contents
          .map((item) => {
            const suggestion = item as {
              suggestion?: { toString(): string };
            };
            return suggestion.suggestion?.toString() ?? "";
          })
          .filter(Boolean)
      );

      return [...new Set(suggestions)].slice(0, 3);
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.getSearchSuggestions failed", {
        query: normalizedQuery,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error("Unable to load search suggestions.");
    }
  }

  async getRecommendations(
    seed: Track,
    onUpdate?: (tracks: Track[]) => void,
  ): Promise<Track[]> {
    const cacheKey = `youtube-music:recommendations:v1:${seed.id}`;
    const cached = await getCachedJson<Track[]>(cacheKey);

    if (cached) {
      globalThis.setTimeout(() => {
        void this.refreshRecommendations(seed, cacheKey)
          .then(({ changed, value }) => {
            if (changed) onUpdate?.(value);
          })
          .catch((error) => {
            logInternalWarn("YouTubeMusicDataSource.getRecommendations background refresh failed", {
              seedTrackId: seed.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 0);
      return cached;
    }

    try {
      return (await this.refreshRecommendations(seed, cacheKey)).value;
    } catch {
      return [];
    }
  }

  private async refreshRecommendations(
    seed: Track,
    cacheKey: string,
  ): Promise<{ changed: boolean; value: Track[] }> {
    let refresh = this.recommendationRefreshPromises.get(seed.id);
    if (!refresh) {
      refresh = this.fetchRecommendationsFresh(seed).finally(() => {
        this.recommendationRefreshPromises.delete(seed.id);
      });
      this.recommendationRefreshPromises.set(seed.id, refresh);
    }

    const value = await refresh;
    const changed = await setCachedJson(cacheKey, value);
    return { changed, value };
  }

  private async fetchRecommendationsFresh(seed: Track): Promise<Track[]> {
    logInternalInfo("YouTubeMusicDataSource.getRecommendations start", {
      seedTrackId: seed.id,
    });

    try {
      const client = await this.getMusicClient();
      const panel = await client.music.getUpNext(seed.id, true);
      const recommendationTracks: Track[] = [];
      for (const entry of panel.contents) {
        const item = entry as unknown as UpNextItem;
        const video = item.primary ?? item;
        const id = video.video_id;
        const title = video.title?.toString();
        if (!id || !title || id === seed.id) continue;

        recommendationTracks.push({
          id,
          source: "youtube",
          title,
          artist: video.artists?.map((artist) => artist.name).filter(Boolean).join(", ")
            || video.author
            || "Unknown artist",
          artists: video.artists
            ?.map((artist) => ({
              id: artist.channel_id
                ?? this.findBrowseId(artist.endpoint)
                ?? this.findBrowseId(artist.navigationEndpoint)
                ?? "",
              name: artist.name ?? "",
            }))
            .filter((artist) => artist.name),
          durationSec: video.duration?.seconds,
          artworkUrl: selectArtworkUrl(video.thumbnail) ?? getVideoArtworkFallback(id),
        });
      }
      const tracks = this.uniqueById(recommendationTracks);

      logInternalInfo("YouTubeMusicDataSource.getRecommendations success", {
        seedTrackId: seed.id,
        trackCount: tracks.length,
      });
      return tracks;
    } catch (error) {
      logInternalError("YouTubeMusicDataSource.getRecommendations failed", error, {
        seedTrackId: seed.id,
      });
      throw new Error("Unable to load recommendations.");
    }
  }

  async getStreamUrl(track: Track): Promise<string> {
    logInternalInfo("YouTubeMusicDataSource.getStreamUrl start", { trackId: track.id });

    for (const label of ["music", "web"] as ClientLabel[]) {
      try {
        const yt = await this.getClient(label);
        const format = await yt.getStreamingData(track.id, { type: "audio", quality: "best" });
        // Already deciphered — getStreamingData runs decipher internally and assigns the result
        // to format.url, so `pot` and the transformed `n` are on it. Deciphering again would
        // re-transform an already-transformed `n` and earn a 403.
        const url = this.withSessionClientVersion((format as any).url as string, yt);

        if (!url) {
          throw new Error("YouTube.js returned an empty stream URL.");
        }

        logInternalInfo("YouTubeMusicDataSource.getStreamUrl success", {
          trackId: track.id,
          client: label,
          itag: (format as any).itag ?? null,
          mimeType: (format as any).mime_type ?? null,
          urlLength: url.length,
        });

        return url;
      } catch (error) {
        logInternalWarn("YouTubeMusicDataSource.getStreamUrl client failed", {
          trackId: track.id,
          client: label,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logInternalError(
      "YouTubeMusicDataSource.getStreamUrl failed",
      new Error("No YouTube client returned a playable audio URL."),
      { trackId: track.id },
    );
    throw new Error("Unable to resolve a playable YouTube audio stream.");
  }

  /**
   * Finds a playable MP4 audio URL without downloading it.
   *
   * Split out of getStreamData so the offline download queue can reuse exactly the same
   * client walk and format ranking — a download that picked a different format from playback
   * would produce offline copies that sound different from the stream they replace.
   */
  private async resolveStream(
    track: Track,
    quality: AudioQuality,
    clientOrder: readonly ClientLabel[],
  ): Promise<{ url: string; mimeType: string; cookie?: string }> {
    let streamUrl: string | null = null;
    let streamMimeType = "audio/mp4";

    /*
     * The walk itself holds no policy — the order is handed in. Whichever client comes first is
     * tried first and the rest are fallbacks for tracks it cannot see, which is real for
     * Music-exclusive content.
     */
    for (const label of clientOrder) {
      try {
        const yt = await this.getClient(label);
        // Only the download client is attested; music and web are fallbacks whose URLs are
        // gated at 1 MiB regardless, and minting for them would just be wasted work.
        const poToken =
          label === "download" ? await this.attestForTrack(yt, track.id) : undefined;
        const info = await yt.getBasicInfo(track.id, poToken ? { po_token: poToken } : undefined);
        /*
         * MP4 preferred, any audio accepted.
         *
         * Filtering to audio/mp4 alone is why some songs refused to download while playing
         * perfectly: YouTube serves Opus-in-WebM as the *only* audio for a large share of
         * tracks, and playback never noticed because it goes through the iframe player rather
         * than this resolver. The offline store serves files back with their recorded mime
         * type and the webview decodes WebM natively, so there is nothing to gain by
         * insisting on MP4 — only tracks to lose.
         */
        const audioFormats = (info.streaming_data?.adaptive_formats ?? []).filter(
          (candidate: any) => typeof candidate.mime_type === "string"
            && candidate.mime_type.startsWith("audio/"),
        );
        const mp4Formats = audioFormats.filter(
          (candidate: any) => candidate.mime_type.includes("audio/mp4"),
        );
        /*
         * "Best available" has to mean it. The MP4 preference used to be applied before the
         * quality ranking, so `high` never saw the Opus tier — on a typical track that pinned
         * it to itag 140 at ~128 kbps while itag 251 sat there at ~160, higher bitrate *and*
         * better per bit. `low` and `normal` keep preferring MP4: they are picking a small file
         * and AAC is the safer container to hand a media element.
         */
        const candidates = quality === "high" || mp4Formats.length === 0
          ? audioFormats
          : mp4Formats;
        const format = selectFormatForQuality(candidates as Array<{ bitrate?: number }>, quality) as
          | (typeof candidates)[number]
          | undefined;
        if (!format) {
          // Names what was actually on offer, so a future failure is diagnosable from the log
          // instead of needing another round trip.
          const offered = (info.streaming_data?.adaptive_formats ?? [])
            .map((candidate: any) => candidate.mime_type)
            .filter(Boolean)
            .slice(0, 8);
          throw new Error(
            `YouTube returned no playable audio format. Offered: ${offered.join(", ") || "none"}`,
          );
        }

        /*
         * Unconditionally deciphered, unlike the getStreamingData path above. These formats come
         * raw off getBasicInfo and nothing has touched them yet, so a plain `format.url` here
         * still carries an untransformed throttling `n` and no `pot`. Taking it as-is is why
         * downloads 403'd while playback — which goes through getStreamingData — worked.
         */
        streamUrl = this.withSessionClientVersion(await format.decipher(yt.session.player), yt);
        if (!streamUrl) {
          throw new Error("YouTube returned an empty MP4 audio URL.");
        }

        streamMimeType = (format as any).mime_type ?? "audio/mp4";
        logInternalInfo("YouTubeMusicDataSource.getStreamData format selected", {
          trackId: track.id,
          client: label,
          quality,
          itag: (format as any).itag ?? null,
          mimeType: streamMimeType,
          bitrate: (format as any).bitrate ?? null,
        });
        break;
      } catch (error) {
        logInternalWarn("YouTubeMusicDataSource.getStreamData client failed", {
          trackId: track.id,
          client: label,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!streamUrl) {
      throw new Error("Unable to resolve a playable audio stream.");
    }

    return {
      url: streamUrl,
      mimeType: streamMimeType,
      cookie: this.musicCookie ?? undefined,
    };
  }

  /**
   * Resolves a URL for *playback*.
   *
   * The only place the authenticated-streaming preference is read. On, the signed-in music
   * client goes first — the one a Premium entitlement could be read from, and the one proven to
   * serve whole files without a PO token. Off keeps the anonymous attested client in front,
   * which is the long-standing behaviour.
   */
  async resolveStreamUrl(
    track: Track,
    quality: AudioQuality = getStreamingQuality(),
  ): Promise<{ url: string; mimeType: string; cookie?: string }> {
    const order: ClientLabel[] = usesAuthenticatedStreaming()
      ? ["music", "download", "web"]
      : ["download", "music", "web"];
    return this.resolveStream(track, quality, order);
  }

  /**
   * Resolves a URL for the *offline download queue*.
   *
   * Deliberately a separate method rather than a flag on the one above: this body does not
   * reference the streaming preference at all, so downloads cannot inherit it by a mis-edited
   * condition. The anonymous attested client stays in front because that is the path proven to
   * survive being pulled from Rust and written to disk.
   */
  async resolveDownloadUrl(
    track: Track,
    quality: AudioQuality = getDownloadQuality(),
  ): Promise<{ url: string; mimeType: string; cookie?: string }> {
    return this.resolveStream(track, quality, ["download", "music", "web"]);
  }

  /**
   * Reports the start of a play to YouTube Music's own history.
   *
   * Two pings make a play count, and both matter. This one says "a play began"; the watchtime
   * pings from `updatePlayReport` say how long it actually ran. A playback ping on its own is
   * accepted and recorded as nothing.
   *
   * The tracking URLs are not exposed by youtubei.js — `playback_tracking` is a private field
   * with no getter — so the raw `/player` response is fetched through the authenticated music
   * client rather than reconstructed.
   *
   * Best effort throughout: a failure here must never interrupt playback, so nothing rethrows.
   */
  async beginPlayReport(track: Track): Promise<void> {
    this.playReport = null;
    if (!usesYouTubeScrobbling() || track.source !== "youtube" || !this.musicCookie) return;

    try {
      const yt = await this.getMusicClient();
      /*
       * The same body `getBasicInfo` sends, not just `{ videoId, context }`.
       *
       * A bare videoId is answered with a ~5 KB stub that carries no streaming data and no
       * `playbackTracking` at all — which is why every scrobble logged "no tracking urls"
       * against a 200. `playbackContext.signatureTimestamp` is what makes YouTube treat this
       * as a real playback request; the two check flags keep age- and content-gated tracks
       * from degrading to the same stub.
       */
      const raw = await yt.actions.execute("/player", {
        videoId: track.id,
        racyCheckOk: true,
        contentCheckOk: true,
        playbackContext: {
          contentPlaybackContext: {
            vis: 0,
            splay: false,
            lactMilliseconds: "-1",
            signatureTimestamp: (yt.session as { player?: { signature_timestamp?: number } })
              .player?.signature_timestamp,
          },
        },
        parse: false,
      });
      const tracking = (raw as any)?.data?.playbackTracking ?? (raw as any)?.playbackTracking;
      const playbackUrl = tracking?.videostatsPlaybackUrl?.baseUrl;
      const watchtimeUrl = tracking?.videostatsWatchtimeUrl?.baseUrl;
      if (!playbackUrl || !watchtimeUrl) {
        logInternalWarn("YouTubeMusicDataSource.beginPlayReport no tracking urls", {
          trackId: track.id,
        });
        return;
      }

      const cpn = createPlaybackNonce();
      this.playReport = { trackId: track.id, cpn, playbackUrl, watchtimeUrl, startedAt: Date.now() };
      await this.pingPlaybackStats(playbackUrl, { cpn, rtn: "0" });
      logInternalInfo("YouTubeMusicDataSource.beginPlayReport started", { trackId: track.id });
    } catch (error) {
      this.playReport = null;
      logInternalWarn("YouTubeMusicDataSource.beginPlayReport failed", {
        trackId: track.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Reports how far the current play has actually got.
   *
   * `et` is clamped to real elapsed wall time, never to the position alone. Reporting a whole
   * track's worth of listening seconds after the play began is silently ignored — that is what
   * made the first working experiment differ from the two that returned 204 and did nothing.
   */
  async updatePlayReport(track: Track, positionSec: number, final: boolean): Promise<void> {
    const report = this.playReport;
    if (!report || report.trackId !== track.id) return;
    if (final) this.playReport = null;

    const wallElapsed = Math.floor((Date.now() - report.startedAt) / 1000);
    const watched = Math.max(0, Math.min(Math.floor(positionSec), wallElapsed));
    if (watched <= 0) return;

    try {
      await this.pingPlaybackStats(report.watchtimeUrl, {
        cpn: report.cpn,
        st: "0",
        et: String(watched),
        cmt: String(watched),
        state: final ? "paused" : "playing",
        ...(final ? { final: "1" } : {}),
      });
      logInternalDebug("YouTubeMusicDataSource.updatePlayReport", {
        trackId: track.id,
        watched,
        final,
      });
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.updatePlayReport failed", {
        trackId: track.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Shared query shape for both stats endpoints. tauriFetch signs `/api/stats/` for us. */
  private async pingPlaybackStats(
    baseUrl: string,
    params: Record<string, string>,
  ): Promise<void> {
    // Taken from the live session so a client-version bump does not leave the pings claiming
    // to be a build that no longer exists.
    const client = await this.getMusicClient();
    const clientVersion = client.session.context.client.clientVersion;
    const query = new URLSearchParams({
      ver: "2",
      fmt: "251",
      rt: "0",
      c: "WEB_REMIX",
      cver: clientVersion,
      ...params,
    });
    const url = `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}${query}`;
    await tauriFetch(url, {
      headers: {
        cookie: this.musicCookie ?? "",
        "x-youtube-client-name": "67",
      },
    });
  }

  /**
   * Browse ids for the surfaces Zuno exposes.
   *
   * These are stable YouTube Music feed ids rather than anything we construct, which is why
   * they are literals: there is no endpoint that enumerates them.
   */
  private static readonly BROWSE_IDS: Record<BrowseSurface, { ids: string[]; title: string }> = {
    explore: { ids: ["FEmusic_explore"], title: "Explore" },
    charts: { ids: ["FEmusic_charts"], title: "Charts" },
    moods: { ids: ["FEmusic_moods_and_genres"], title: "Moods & genres" },
    // Podcast feeds have moved around and some accounts get none of them; each is tried in
    // turn rather than assuming one, because a wrong id answers 404 rather than empty.
    podcasts: {
      ids: [
        "FEmusic_non_music_audio",
        "FEmusic_podcasts",
        "FEmusic_library_non_music_audio_list",
      ],
      title: "Podcasts",
    },
  };

  /**
   * Reads a browse feed into titled shelves.
   *
   * Shelf contents are deliberately untyped up front — a YouTube Music feed mixes albums,
   * playlists, videos and artists inside one row, and which appears where changes without
   * notice. Rather than model each surface separately, every shelf is walked with the same
   * collector the library uses and sorted into buckets by what came back.
   */
  async getBrowsePage(target: BrowseTarget): Promise<BrowsePage> {
    const surface = target;
    /* `params` is part of the key: mood categories all share one browseId, so keying on the
       id alone would serve the first mood opened for every mood thereafter. */
    const cacheKey = typeof surface === "string"
      ? `youtube-music:browse:v2:${surface}`
      : `youtube-music:browse:v2:id:${surface.browseId}:${surface.params ?? ""}`;
    const cached = await getCachedJson<BrowsePage>(cacheKey);
    if (cached?.shelves.length) {
      void this.refreshBrowsePage(surface, cacheKey).catch(() => {});
      return cached;
    }
    return this.refreshBrowsePage(surface, cacheKey);
  }

  private async refreshBrowsePage(
    surface: BrowseTarget,
    cacheKey: string,
  ): Promise<BrowsePage> {
    const target = typeof surface === "string"
      ? { ...YouTubeMusicDataSource.BROWSE_IDS[surface], params: undefined as string | undefined }
      : { ids: [surface.browseId], title: surface.title, params: surface.params };
    const client = await this.getMusicClient();
    let response: unknown = null;
    let usedBrowseId: string | null = null;
    let lastError: unknown = null;

    for (const browseId of target.ids) {
      try {
        /* `params` is only sent when the chip carried one. A browse that does not expect it
           rejects the request rather than ignoring it. */
        response = await this.executeMusicBrowse(client, {
          browseId,
          ...(target.params ? { params: target.params } : {}),
        });
        usedBrowseId = browseId;
        break;
      } catch (error) {
        lastError = error;
        logInternalWarn("YouTubeMusicDataSource.refreshBrowsePage candidate failed", {
          surface,
          browseId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!response) {
      throw lastError instanceof Error
        ? lastError
        : new Error("YouTube Music did not return this feed.");
    }

    const sections = this.collectBrowseSections(response);
    logInternalInfo("YouTubeMusicDataSource.refreshBrowsePage response", {
      surface,
      browseId: usedBrowseId,
      responseKeys: response && typeof response === "object"
        ? Object.keys(response).slice(0, 25)
        : typeof response,
      sectionCount: sections.length,
      sectionTitles: sections.slice(0, 25).map((section) => section.title),
      totalItemsSeen: this.collectMusicItems(response, BROWSE_ITEM_TYPES).length,
    });

    const shelves: BrowseShelf[] = [];
    const seenTitles = new Set<string>();

    for (const [index, section] of sections.entries()) {
      const title = section.title?.trim() || `More ${index + 1}`;
      if (seenTitles.has(title)) continue;

      const shelf = this.toBrowseShelf(
        title,
        section.node,
        this.collectBrowseLinks(section.node),
      );

      const total = shelf.tracks.length + shelf.albums.length
        + shelf.playlists.length + shelf.artists.length + shelf.links.length;
      if (total === 0) continue;

      seenTitles.add(title);
      shelves.push(shelf);
    }

    /*
     * The shelf walk depends on a response shape that YouTube changes freely. When it finds
     * nothing but the response demonstrably contains music, everything is collected into a
     * single shelf — a flat list is a far better answer than an empty page.
     */
    if (shelves.length === 0) {
      const loose = this.collectMusicItems(response, BROWSE_ITEM_TYPES);
      if (loose.length > 0) {
        const shelf: BrowseShelf = {
          title: target.title,
          tracks: [],
          albums: [],
          playlists: [],
          artists: [],
          links: [],
        };
        for (const item of loose) {
          const track = item.item_type === "song" || item.item_type === "video"
            ? this.toTrack(item)
            : null;
          if (track) {
            shelf.tracks.push(track);
            continue;
          }
          const album = item.item_type === "album" ? this.toAlbum(item) : null;
          if (album) {
            shelf.albums.push(album);
            continue;
          }
          const playlist = item.item_type === "playlist" ? this.toPlaylist(item) : null;
          if (playlist) {
            shelf.playlists.push(playlist);
            continue;
          }
          const artist = item.item_type === "artist" ? this.toArtist(item) : null;
          if (artist) shelf.artists.push(artist);
        }
        shelves.push(shelf);
        logInternalWarn("YouTubeMusicDataSource.refreshBrowsePage using flat fallback", {
          surface,
          itemCount: loose.length,
        });
      }
    }

    /*
     * Still nothing, on a page whose whole content is navigation chips. Moods & genres is
     * exactly this, so the flat fallback above — which only knows how to collect songs,
     * albums, playlists and artists — cannot rescue it.
     */
    if (shelves.length === 0) {
      const links = this.collectBrowseLinksFromMemo(response);
      if (links.length > 0) {
        shelves.push({
          title: target.title,
          tracks: [],
          albums: [],
          playlists: [],
          artists: [],
          links,
        });
        logInternalWarn("YouTubeMusicDataSource.refreshBrowsePage using link fallback", {
          surface,
          linkCount: links.length,
        });
      }
    }

    const page: BrowsePage = { title: target.title, shelves };
    if (shelves.length > 0) await setCachedJson(cacheKey, page);

    logInternalInfo("YouTubeMusicDataSource.getBrowsePage", {
      surface,
      shelfCount: shelves.length,
    });
    return page;
  }

  /**
   * Mood and genre chips inside a shelf.
   *
   * These are navigation, not content: a shelf made entirely of them yields no tracks and was
   * therefore being dropped, which left the whole Moods & genres surface blank.
   */
  private collectBrowseLinks(node: unknown): BrowseLink[] {
    if (!Array.isArray(node)) return [];
    const links: BrowseLink[] = [];

    for (const entry of node) {
      const candidate = entry as {
        type?: string;
        button_text?: unknown;
        endpoint?: unknown;
      };
      if (candidate?.type !== "MusicNavigationButton") continue;

      const title = String(candidate.button_text ?? "").trim();
      const browseId = this.findBrowseId(candidate.endpoint);
      if (title && browseId) {
        links.push({ title, browseId, params: this.findBrowseParams(candidate.endpoint) });
      }
    }

    return links;
  }

  /**
   * Finds the shelves in a browse response.
   *
   * Goes through the parser's memo rather than walking the tree. youtubei.js exposes parsed
   * contents behind accessors rather than plain fields, so `Object.entries` sees nothing —
   * a tree walk found zero containers on a response that demonstrably held 24 items. The
   * memo is a flat index of every parsed node and is the only reliable way in; it is what
   * collectMusicItems already uses for the same reason.
   */
  private collectBrowseSections(root: unknown): Array<{ title?: string; node: unknown }> {
    const response = root as ParsedMusicResponse;
    const sections: Array<{ title?: string; node: unknown }> = [];

    const readTitle = (value: unknown): string | undefined => {
      if (!value) return undefined;
      if (typeof value === "string") return value.trim() || undefined;
      const text = (value as { toString?: () => string }).toString?.();
      return text && text !== "[object Object]" ? text.trim() || undefined : undefined;
    };

    for (const memo of [response.contents_memo, response.continuation_contents_memo]) {
      if (!memo) continue;

      // Carousels are the horizontal rows; MusicShelf is the vertical list form. Both carry
      // a title and their own contents.
      // The memo is typed loosely here (it indexes every node kind), so the two shelf shapes
      // are narrowed locally rather than widening MusicItem for nodes that are not items.
      type ShelfNode = {
        title?: unknown;
        header?: { title?: unknown } | null;
        contents?: unknown;
      };

      for (const shelf of memo.getType(YTNodes.MusicCarouselShelf) as unknown as ShelfNode[]) {
        sections.push({ title: readTitle(shelf.header?.title), node: shelf.contents });
      }
      for (const shelf of memo.getType(YTNodes.MusicShelf) as unknown as ShelfNode[]) {
        sections.push({ title: readTitle(shelf.title), node: shelf.contents });
      }
      /*
       * Grids are the third shelf shape, and the only one Moods & genres and Podcasts use —
       * their pages are grids of navigation chips, not carousels of music. Reading only the
       * two music shelf types found no sections on those surfaces at all, and the flat
       * fallback below could not save them either because it collects songs and albums, and
       * a mood chip is neither. Both surfaces rendered completely empty.
       *
       * `contents` is Grid's own alias for `items`, so it needs no special handling here.
       */
      for (const grid of memo.getType(YTNodes.Grid) as unknown as ShelfNode[]) {
        sections.push({ title: readTitle(grid.header?.title), node: grid.contents });
      }
      // Drilling into a mood returns its playlists in this shelf rather than a carousel.
      for (const shelf of memo.getType(YTNodes.MusicPlaylistShelf) as unknown as ShelfNode[]) {
        sections.push({ title: readTitle(shelf.title), node: shelf.contents });
      }
    }

    return sections;
  }

  /**
   * Every navigation chip in a response, straight from the parser memo.
   *
   * The last line of defence for a chip-only surface. `collectBrowseLinks` reads the chips
   * out of a section it was handed, so it can only find what section detection already
   * found — and section detection is the part that breaks when YouTube reshapes a feed. This
   * goes at the memo directly, which is a flat index of every parsed node and does not care
   * how the page is nested.
   */
  private collectBrowseLinksFromMemo(root: unknown): BrowseLink[] {
    const response = root as ParsedMusicResponse;
    const links: BrowseLink[] = [];
    const seen = new Set<string>();

    for (const memo of [response.contents_memo, response.continuation_contents_memo]) {
      if (!memo) continue;

      const buttons = memo.getType(
        YTNodes.MusicNavigationButton,
      ) as unknown as Array<{ button_text?: unknown; endpoint?: unknown }>;

      for (const button of buttons) {
        const title = String(button.button_text ?? "").trim();
        const browseId = this.findBrowseId(button.endpoint);
        if (!title || !browseId) continue;

        const params = this.findBrowseParams(button.endpoint);
        /* Keyed on both, because every mood chip shares one browseId — deduping on the id
           alone would collapse the entire Moods & genres page to a single chip. */
        const key = `${browseId}:${params ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({ title, browseId, params });
      }
    }

    return links;
  }

  async getStreamData(track: Track): Promise<StreamData> {
    if (usesRustAudioEngine()) {
      return this.getRustStreamData(track);
    }

    if (track.source === "local") {
      if (!track.localPath) {
        throw new Error("Local track path is missing.");
      }
      const payload = await invoke<NativeAudioPayload>("local_audio_read", {
        path: track.localPath,
      });
      const audioBytes = decodeBase64(payload.bodyBase64);
      if (audioBytes.byteLength === 0) {
        throw new Error("Local audio file returned no data.");
      }
      return {
        bytes: audioBytes.buffer.slice(
          audioBytes.byteOffset,
          audioBytes.byteOffset + audioBytes.byteLength,
        ) as ArrayBuffer,
        mimeType: payload.mimeType,
      };
    }

    /*
     * A downloaded copy short-circuits everything below — no stream resolution, no network.
     * Checked here rather than in the player so every caller of getStreamData benefits, and
     * so an offline track behaves identically to an online one from the engine's point of
     * view: both end up as a URL served by the local media server.
     */
    if (isTrackDownloaded(track.id)) {
      try {
        const payload = await invoke<NativeAudioSourcePayload>("offline_audio_source", {
          trackId: track.id,
          mimeType: track.mimeType ?? "audio/mp4",
        });
        logInternalInfo("YouTubeMusicDataSource.getStreamData offline hit", {
          trackId: track.id,
          byteLength: payload.byteLength,
        });
        return { mimeType: payload.mimeType, sourceUrl: payload.url };
      } catch (error) {
        // The manifest and disk have drifted. Fall through to the network rather than fail.
        logInternalWarn("YouTubeMusicDataSource.getStreamData offline miss", {
          trackId: track.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const { url: streamUrl, mimeType: streamMimeType } = await this.resolveStreamUrl(track);

    logInternalInfo("YouTubeMusicDataSource.getStreamData download start", {
      trackId: track.id,
    });

    const payload = await invoke<NativeAudioSourcePayload>("fetch_audio_source", {
      url: streamUrl,
      trackId: track.id,
      mimeType: streamMimeType,
      // The signed URL belongs to this authenticated session; without the cookie the media
      // request is anonymous and googlevideo refuses it.
      cookie: this.musicCookie,
    });
    if (payload.byteLength === 0) {
      throw new Error("Audio download returned no data.");
    }

    logInternalInfo("YouTubeMusicDataSource.getStreamData download success", {
      trackId: track.id,
      byteLength: payload.byteLength,
      mimeType: payload.mimeType,
      sourceUrl: payload.url,
    });

    return {
      mimeType: payload.mimeType,
      sourceUrl: payload.url,
    };
  }

  /**
   * The same three cases as `getStreamData`, resolved to a *reference* rather than to bytes.
   *
   * This is what the Rust engine buys before a single sample is decoded. A local file is a path
   * instead of the whole song base64-encoded across IPC; a download is a track id instead of a
   * copy loaded into the media server; a stream is the signed URL itself instead of a
   * `fetch_audio_source` round trip that publishes the body and hands back a loopback URL. In
   * every case Rust already has, or can get, the bytes — asking the webview to carry them first
   * was only ever in service of an `<audio>` element that no longer exists on this path.
   */
  private async getRustStreamData(track: Track): Promise<StreamData> {
    if (track.source === "local") {
      if (!track.localPath) {
        throw new Error("Local track path is missing.");
      }
      return {
        mimeType: track.mimeType ?? "audio/mp4",
        rustSource: { kind: "file", path: track.localPath },
      };
    }

    if (isTrackDownloaded(track.id)) {
      const mimeType = track.mimeType ?? "audio/mp4";
      /*
       * The mime type travels with the id because it is what picks the decoder: a downloaded
       * body is raw bytes on disk with no extension to read, and Opus needs libopus while
       * everything else goes to rodio.
       */
      return { mimeType, rustSource: { kind: "offline", trackId: track.id, mimeType } };
    }

    const { url, mimeType, cookie } = await this.resolveStreamUrl(track);
    logInternalInfo("YouTubeMusicDataSource.getRustStreamData resolved", {
      trackId: track.id,
      mimeType,
      authenticated: Boolean(cookie),
    });
    return {
      mimeType,
      rustSource: { kind: "stream", url, mimeType, cookie },
    };
  }

  /**
   * Sorts every music item under `node` into one shelf.
   *
   * Shared by the browse surfaces and by getRelated, which receive the same carousel shapes
   * from different endpoints. The classification is the whole job — item_type is the only
   * thing distinguishing a song from an album inside a response.
   */
  private toBrowseShelf(title: string, node: unknown, links: BrowseLink[]): BrowseShelf {
    const shelf: BrowseShelf = {
      title,
      tracks: [],
      albums: [],
      playlists: [],
      artists: [],
      links,
    };

    for (const item of this.collectMusicItems(node, BROWSE_ITEM_TYPES)) {
      switch (item.item_type) {
        case "song":
        case "video": {
          const track = this.toTrack(item);
          if (track) shelf.tracks.push(track);
          break;
        }
        case "album": {
          const album = this.toAlbum(item);
          if (album) shelf.albums.push(album);
          break;
        }
        case "playlist": {
          const playlist = this.toPlaylist(item);
          if (playlist) shelf.playlists.push(playlist);
          break;
        }
        case "artist": {
          const artist = this.toArtist(item);
          if (artist) shelf.artists.push(artist);
          break;
        }
        default:
          break;
      }
    }

    return shelf;
  }

  /**
   * Turns a pasted YouTube link into something Zuno can open.
   *
   * Nearly every link names its target in the URL itself, so parseYouTubeLink answers offline
   * and the API is only consulted for the shapes it cannot: `@handles`, `/c/` vanity paths and
   * anything else that needs YouTube to say what it points at.
   */
  async resolveLink(url: string): Promise<ResolvedLink | null> {
    const local = parseYouTubeLink(url);
    if (local) {
      logInternalInfo("YouTubeMusicDataSource.resolveLink parsed locally", { kind: local.kind });
      return local;
    }
    if (!looksLikeYouTubeLink(url)) return null;

    try {
      const client = await this.getWebClient();
      const endpoint = await client.resolveURL(url);
      const payload = endpoint.payload as {
        videoId?: string;
        playlistId?: string;
        browseId?: string;
      };

      const resolved = this.toResolvedLink(payload);
      logInternalInfo("YouTubeMusicDataSource.resolveLink resolved remotely", {
        kind: resolved?.kind ?? null,
      });
      return resolved;
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.resolveLink failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private toResolvedLink(payload: {
    videoId?: string;
    playlistId?: string;
    browseId?: string;
  }): ResolvedLink | null {
    if (payload.videoId) return { kind: "track", id: payload.videoId };

    const browseId = payload.browseId;
    if (browseId?.startsWith("MPRE")) return { kind: "album", id: browseId };
    if (browseId?.startsWith("UC")) return { kind: "artist", id: browseId };

    const playlistId = payload.playlistId
      ?? (browseId?.startsWith("VL") ? browseId.slice(2) : undefined);
    if (playlistId) {
      return playlistId.startsWith("OLAK5uy_")
        ? { kind: "album", id: playlistId }
        : { kind: "playlist", id: playlistId };
    }

    return null;
  }

  /**
   * Discovery shelves for a track — similar artists, related playlists, more from the album.
   *
   * This is a different endpoint from getUpNext, which the player already uses: up-next is the
   * autoplay queue, while this is the "Related" tab of the YouTube Music track page. Cached
   * because it never changes for a given track within a session and costs a watchNext call
   * plus a browse call to fetch.
   */
  async getRelated(track: Track): Promise<BrowseShelf[]> {
    const cacheKey = `youtube-music:related:v1:${track.id}`;
    const cached = await getCachedJson<BrowseShelf[]>(cacheKey);
    if (cached?.length) return cached;

    try {
      const client = await this.getMusicClient();
      const page = await client.music.getRelated(track.id);
      const sections = this.collectBrowseSections(page);

      const shelves: BrowseShelf[] = [];
      const seenTitles = new Set<string>();
      for (const [index, section] of sections.entries()) {
        const title = section.title?.trim() || `Related ${index + 1}`;
        if (seenTitles.has(title)) continue;

        const shelf = this.toBrowseShelf(
          title,
          section.node,
          this.collectBrowseLinks(section.node),
        );
        const total = shelf.tracks.length + shelf.albums.length
          + shelf.playlists.length + shelf.artists.length;
        if (total === 0) continue;

        seenTitles.add(title);
        shelves.push(shelf);
      }

      // A track with no related tab answers Message rather than a section list. That is a
      // real answer, not a failure, so it is cached like any other.
      if (shelves.length > 0) await setCachedJson(cacheKey, shelves);
      logInternalInfo("YouTubeMusicDataSource.getRelated", {
        trackId: track.id,
        shelfCount: shelves.length,
      });
      return shelves;
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.getRelated unavailable", {
        trackId: track.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * One filtered search.
   *
   * `search` samples every category at once and is what the results page opens with; this goes
   * deep on one of them, which is how the category tabs get more than the handful of rows a
   * mixed search returns.
   */
  async searchCategory(query: string, category: SearchCategory): Promise<SearchResults> {
    const normalizedQuery = query.trim();
    const empty: SearchResults = { artists: [], tracks: [], albums: [], playlists: [] };
    if (!normalizedQuery) return empty;

    const cacheKey = `youtube-music:search:${category}:v1:${normalizedQuery.toLocaleLowerCase()}`;
    const cached = await getCachedJson<SearchResults>(cacheKey);
    if (cached) return cached;

    try {
      const client = await this.getMusicClient();
      const response = await client.music.search(normalizedQuery, { type: category });
      const items = this.collectMusicItems(response.page, BROWSE_ITEM_TYPES);

      const results: SearchResults = {
        artists: this.uniqueById(
          items
            .filter((item) => item.item_type === "artist")
            .map((item) => this.toArtist(item))
            .filter((item): item is Artist => Boolean(item)),
        ),
        tracks: this.uniqueById(
          items
            .filter((item) => item.item_type === "song" || item.item_type === "video")
            .map((item) => this.toTrack(item))
            .filter((item): item is Track => Boolean(item)),
        ),
        albums: this.uniqueById(
          items
            .filter((item) => item.item_type === "album")
            .map((item) => this.toAlbum(item))
            .filter((item): item is Album => Boolean(item)),
        ),
        playlists: this.uniqueById(
          items
            .filter((item) => item.item_type === "playlist")
            .map((item) => this.toPlaylist(item))
            .filter((item): item is Playlist => Boolean(item)),
        ),
      };

      await setCachedJson(cacheKey, results);
      logInternalInfo("YouTubeMusicDataSource.searchCategory", {
        category,
        artistCount: results.artists.length,
        trackCount: results.tracks.length,
        albumCount: results.albums.length,
        playlistCount: results.playlists.length,
      });
      return results;
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.searchCategory failed", {
        category,
        error: error instanceof Error ? error.message : String(error),
      });
      return empty;
    }
  }

  /**
   * How often YouTube may notify about an artist's uploads.
   *
   * Only meaningful while subscribed — YouTube stores the preference against the subscription
   * and silently resets it when that goes away.
   */
  async setArtistNotificationLevel(
    artistId: string,
    level: ArtistNotificationLevel,
  ): Promise<void> {
    if (!this.musicCookie) {
      throw new Error("Sign in to YouTube Music to change notifications.");
    }

    const client = await this.getWebClient();
    const preference = level === "all"
      ? "ALL"
      : (level === "none" ? "NONE" : "PERSONALIZED");
    await client.interact.setNotificationPreferences(artistId, preference);
    logInternalInfo("YouTubeMusicDataSource.setArtistNotificationLevel", { artistId, level });
  }

  /** The account's notification inbox, newest first. Empty when signed out. */
  async getNotifications(): Promise<FeedNotification[]> {
    if (!this.musicCookie) return [];

    try {
      const client = await this.getWebClient();
      const menu = await client.getNotifications();
      const notifications = (menu.contents ?? []).map((item) => {
        const payload = item.endpoint?.payload as { videoId?: string } | undefined;
        return {
          id: item.notification_id,
          text: item.short_message?.toString() ?? "",
          sentAtText: item.sent_time?.toString() || undefined,
          thumbnailUrl: selectArtworkUrl(
            collectArtworkCandidates(item.video_thumbnails ?? item.thumbnails ?? []),
          ),
          videoId: payload?.videoId,
          read: Boolean(item.read),
        } satisfies FeedNotification;
      }).filter((item) => item.text.length > 0);

      logInternalInfo("YouTubeMusicDataSource.getNotifications", {
        count: notifications.length,
      });
      return notifications;
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.getNotifications unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  async getUnseenNotificationCount(): Promise<number> {
    if (!this.musicCookie) return 0;

    try {
      const client = await this.getWebClient();
      const count = await client.getUnseenNotificationsCount();
      return Number.isFinite(count) ? count : 0;
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.getUnseenNotificationCount unavailable", {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * A playlist's description text.
   *
   * Fetched on its own rather than carried on the Playlist object, because the library shelves
   * that produce those objects do not include it — only the playlist's own page does. Cached,
   * so opening a playlist twice costs one request.
   */
  async getPlaylistDescription(playlist: Playlist): Promise<string | null> {
    const cacheKey = `youtube-music:playlist-description:v1:${playlist.id}`;
    const cached = await getCachedJson<{ description: string }>(cacheKey);
    if (cached) return cached.description || null;

    try {
      const client = await this.getMusicClient();
      const page = await client.music.getPlaylist(playlist.id) as YouTubeMusicPlaylistPage;
      const description = page.description?.toString().trim() ?? "";
      await setCachedJson(cacheKey, { description });
      return description || null;
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.getPlaylistDescription unavailable", {
        playlistId: playlist.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async setPlaylistDescription(playlist: Playlist, description: string): Promise<void> {
    if (!this.musicCookie) {
      throw new Error("Sign in to YouTube Music before editing playlists.");
    }

    const client = await this.getMusicClient();
    await client.playlist.setDescription(this.editablePlaylistId(playlist.id), description);
    // Overwrite the read cache rather than clearing it, so reopening the playlist shows the
    // text that was just saved instead of refetching a page YouTube may not have updated yet.
    await setCachedJson(`youtube-music:playlist-description:v1:${playlist.id}`, { description });
    logInternalInfo("YouTubeMusicDataSource.setPlaylistDescription", {
      playlistId: playlist.id,
      length: description.length,
    });
  }

  /**
   * YouTube Music's own lyrics, as the last thing tried.
   *
   * Plain text with no timings, which is why it sits below every synced provider and below the
   * caption transcript: those can highlight the current line and this cannot. It is still worth
   * having because it is matched by video id rather than by title and artist, so it lands on
   * exactly the tracks where text matching fails.
   */
  private async fetchYouTubeMusicLyrics(track: Track): Promise<Lyrics | null> {
    try {
      const client = await this.getMusicClient();
      const shelf = await client.music.getLyrics(track.id);
      const text = shelf?.description?.toString().trim();
      if (!text) return null;

      const lines = text
        .split(/\r?\n/)
        .map((line) => ({ text: line.trim() }))
        .filter((line) => line.text.length > 0);
      if (lines.length === 0) return null;

      logInternalInfo("YouTubeMusicDataSource.getLyrics YouTube Music success", {
        trackId: track.id,
        lineCount: lines.length,
      });
      return {
        lines,
        timing: "none",
        sourceLabel: shelf?.footer?.toString().trim() || "YouTube Music",
      };
    } catch (error) {
      logInternalWarn("YouTubeMusicDataSource.getLyrics YouTube Music unavailable", {
        trackId: track.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
