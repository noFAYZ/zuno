export type TrackSource = "youtube" | "local";

export interface ArtistReference {
  id: string;
  name: string;
}

export interface Track {
  /** Set once a track has been downloaded, so the offline copy is served with the right type. */
  mimeType?: string;
  id: string;
  source: TrackSource;
  title: string;
  artist: string;
  artists?: ArtistReference[];
  album?: string;
  /**
   * Browse id of `album`, when the row linked to one.
   *
   * Navigating by name means searching and taking the best guess, which lands on compilations
   * and remasters. With this the album opens directly.
   */
  albumId?: string;
  durationSec?: number;
  artworkUrl?: string;
  playlistItemId?: string;
  viewCount?: number;
  viewCountText?: string;
  /** Carries an explicit-content badge. Absent means unknown, not "clean". */
  isExplicit?: boolean;
  localPath?: string;
}

export interface LyricLine {
  text: string;
  startTimeSec?: number;
  endTimeSec?: number;
}

export type LyricsSourceStatus = "hit" | "miss" | "timeout" | "error" | "skipped";

/** What one source in the lyric table did on a single lookup. */
export interface LyricsSourceAttempt {
  id: string;
  label: string;
  status: LyricsSourceStatus;
  /** Wall time spent on this source; zero when it was never run. */
  durationMs: number;
  /** Line count on a hit, the reason otherwise. */
  detail?: string;
}

export interface Lyrics {
  lines: LyricLine[];
  timing: "synced" | "estimated" | "none";
  sourceLabel?: string;
  /** Which entry of the source table produced these lines. */
  sourceId?: string;
  /** What every source did on this lookup, in preference order. */
  attempts?: LyricsSourceAttempt[];
}

export interface Album {
  id: string;
  playlistId?: string;
  title: string;
  artist: string;
  artists?: ArtistReference[];
  artworkUrl?: string;
  releaseType?: "album" | "single" | "ep";
}

export interface Playlist {
  id: string;
  title: string;
  owner: string;
  description?: string;
  artworkUrl?: string;
  kind?: "playlist" | "liked-songs" | "local";
  isSaved?: boolean;
  isEditable?: boolean;
  localPaths?: string[];
}

/**
 * YouTube stores a per-track rating, not a like flag: liking a disliked song clears the
 * dislike, and both clear to "none". A boolean cannot express that middle state.
 */
export type TrackRating = "like" | "dislike" | "none";

export interface Artist {
  id: string;
  name: string;
  artworkUrl?: string;
  subscriberCount?: string;
}

export interface ArtistPage {
  artist: Artist;
  subscribed?: boolean;
  /** Only meaningful while subscribed; YouTube resets it to "personalized" on unsubscribe. */
  notificationLevel?: ArtistNotificationLevel;
  popularSongs: Track[];
  allSongs: Track[];
  releases: Album[];
  playlists: Playlist[];
}

/**
 * How much YouTube may notify about an artist's uploads.
 *
 * "personalized" is YouTube's default and means "whatever the algorithm thinks", which is why
 * it is a distinct value rather than a midpoint between all and none.
 */
export type ArtistNotificationLevel = "all" | "personalized" | "none";

/** One entry from the account's notification inbox. */
export interface FeedNotification {
  id: string;
  text: string;
  sentAtText?: string;
  thumbnailUrl?: string;
  /** Present when the notification points at a specific video. */
  videoId?: string;
  read: boolean;
}

/**
 * Where a pasted YouTube link points, once resolved.
 *
 * Deliberately narrow: these are the four things Zuno can open. A link to anything else
 * resolves to null so the caller can fall back to treating the text as a search.
 */
export type ResolvedLink =
  | { kind: "track"; id: string }
  | { kind: "album"; id: string }
  | { kind: "playlist"; id: string }
  | { kind: "artist"; id: string };

/**
 * A search filter YouTube Music can actually encode.
 *
 * These five are what the protobuf `musicSearchType` field accepts. Podcasts, episodes and
 * profiles exist as filters on the website but ride an opaque params blob rather than this
 * enum, so they are not offered here.
 */
export type SearchCategory = "song" | "video" | "album" | "artist" | "playlist";

/** A category chip that leads to another browse feed. */
export interface BrowseLink {
  title: string;
  browseId: string;
  /**
   * Opaque selector the feed needs alongside the id.
   *
   * Load-bearing for moods and genres: every chip on that page carries the *same*
   * `browseId` and is told apart only by this. Dropping it asks YouTube for a category page
   * without saying which category, and makes every chip look like the same destination.
   */
  params?: string;
}

/** One titled row on a browse page. Contents are whatever that row actually holds. */
export interface BrowseShelf {
  title: string;
  tracks: Track[];
  albums: Album[];
  playlists: Playlist[];
  artists: Artist[];
  /** Mood and genre chips, which lead to further feeds rather than to content. */
  links: BrowseLink[];
}

export interface BrowsePage {
  title: string;
  shelves: BrowseShelf[];
}

/** Either a named surface or an explicit feed reached by following a chip. */
export type BrowseTarget =
  | BrowseSurface
  | { browseId: string; title: string; params?: string };

/** The browse destinations Zuno knows how to open. */
export type BrowseSurface = "explore" | "charts" | "moods" | "podcasts";

export interface SearchResults {
  artists: Artist[];
  tracks: Track[];
  albums: Album[];
  playlists: Playlist[];
}

export interface TrackPage {
  tracks: Track[];
  nextPageKey?: string;
  hasMore: boolean;
}

export interface AuthPrompt {
  verificationUrl: string;
  userCode: string;
  expiresInSec: number;
}

/**
 * Which part of connecting an account is currently running.
 *
 * Reported rather than inferred from elapsed time: the browser step is unbounded — it waits on
 * a person — while the two after it take seconds. A progress bar guessing at that would spend
 * most of a sign-in lying, and would have no way to show the library retry at all.
 */
export type AuthStage = "browser" | "session" | "library";

/**
 * Signing in and switching channel share the last two stages and differ in the first, so they
 * share a progress shape and are told apart by `kind` — which decides both the wording and
 * whether backing out is possible.
 */
export type AuthFlow = "sign-in" | "account-switch";

export interface AuthProgress {
  flow: AuthFlow;
  stage: AuthStage;
  /** 1-based. The library fetch runs more than once when YouTube answers with a partial one. */
  attempt: number;
  attemptCount: number;
}

export interface AccountProfile {
  name: string;
  artworkUrl?: string;
}

/** One channel on the signed-in account, as offered by the account switcher. */
export interface AccountOption {
  /** Opaque and stable across reloads; pass back to selectAccount. */
  id: string;
  name: string;
  artworkUrl?: string;
  isActive: boolean;
}

export interface LibrarySnapshot {
  account: AccountProfile;
  albums: Album[];
  /** Optional: sources that cannot enumerate artists let the UI derive them from albums. */
  artists?: Artist[];
  playlists: Playlist[];
  likedSongsPlaylist: Playlist;
  likedSongs: Track[];
  /**
   * Songs saved to the library that are not in Liked Songs — kept apart from `likedSongs`
   * because that list is what decides whether a track shows as liked.
   */
  librarySongs?: Track[];
  recentlyPlayed: Track[];
}

/**
 * Where the Rust audio engine should read a track's bytes from.
 *
 * Lives here rather than in `player/` because `StreamData` carries it and nothing under
 * `datasource/` may import upward. Mirrors `NativeAudioSource` in `src-tauri/src/lib.rs`.
 */
export type RustAudioSource =
  | { kind: "stream"; url: string; mimeType: string; cookie?: string }
  | { kind: "offline"; trackId: string }
  | { kind: "file"; path: string };
