import type {
  AccountOption,
  ArtistNotificationLevel,
  BrowsePage,
  BrowseShelf,
  BrowseTarget,
  Album,
  ArtistPage,
  AuthPrompt,
  FeedNotification,
  LibrarySnapshot,
  Lyrics,
  Playlist,
  ResolvedLink,
  SearchCategory,
  SearchResults,
  AuthStage,
  TrackPage,
  Track,
  TrackRating,
} from "./types";

/**
 * The stored session is no longer accepted and only a fresh sign-in will fix it.
 *
 * Distinct from an ordinary failure because the answer is different: a network error is worth
 * retrying, an expired session is not. Sources throw this so the controller can say so instead
 * of leaving a stale cached library on screen looking signed in.
 */
export class AuthExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthExpiredError";
  }
}

export type StreamData = {
  bytes?: ArrayBuffer;
  mimeType?: string;
  sourceUrl?: string;
};

export abstract class DataSource {
  abstract getTrack(id: string): Promise<Track>;
  abstract getStreamUrl(track: Track): Promise<string>;
  search?(query: string, onUpdate?: (results: SearchResults) => void): Promise<SearchResults>;
  /** One filtered search. Narrower and deeper than `search`, which samples every category. */
  searchCategory?(query: string, category: SearchCategory): Promise<SearchResults>;
  /** Resolves a pasted YouTube link. Null when it points at something Zuno cannot open. */
  resolveLink?(url: string): Promise<ResolvedLink | null>;
  searchTracks?(query: string, onUpdate?: (tracks: Track[]) => void): Promise<Track[]>;
  getSearchSuggestions?(query: string, onUpdate?: (suggestions: string[]) => void): Promise<string[]>;
  getStreamData?(track: Track): Promise<StreamData>;
  /**
   * Reports plays to the provider's own listening history.
   *
   * Optional and best-effort on both sides: a source that has no such concept simply omits
   * them, and a failure to report must never affect playback.
   */
  beginPlayReport?(track: Track): Promise<void>;
  updatePlayReport?(track: Track, positionSec: number, final: boolean): Promise<void>;
  restoreSession?(): Promise<boolean>;
  /**
   * Renews an expired session without involving the user. False means it genuinely lapsed and
   * only a sign-in will do. Must not discard caches — the point is to avoid a full resync.
   */
  refreshSession?(): Promise<boolean>;
  /** Registers a listener for the source discovering its stored session is no longer accepted. */
  onAuthExpired?(handler: () => void): void;
  /** Registers a listener for the source being answered *as* the signed-in user. */
  onAuthConfirmed?(handler: (at: number) => void): void;
  signIn?(
    onPrompt: (prompt: AuthPrompt) => void,
    onStage?: (stage: AuthStage) => void,
  ): Promise<void>;
  /** Abandons a sign-in still waiting on the user. No-op once it has moved past that. */
  cancelSignIn?(): Promise<void>;
  signOut?(): Promise<void>;
  /** Channels available on the signed-in account. Absent when the source has no such notion. */
  listAccounts?(): Promise<AccountOption[]>;
  selectAccount?(id: string): Promise<void>;
  getCachedLibrary?(): Promise<LibrarySnapshot | null>;
  /**
   * `onError` reports a *background* refresh failure — the one case the return value cannot
   * cover, because a cached library resolves the promise before the network is consulted.
   */
  getLibrary?(
    onUpdate?: (library: LibrarySnapshot) => void,
    onError?: (error: unknown) => void,
  ): Promise<LibrarySnapshot>;
  getAlbumTracks?(album: Album, onUpdate?: (tracks: Track[]) => void): Promise<Track[]>;
  setAlbumSaved?(album: Album, saved: boolean): Promise<void>;
  getArtist?(artistId: string, onUpdate?: (artist: ArtistPage) => void): Promise<ArtistPage>;
  setArtistSubscribed?(artistId: string, subscribed: boolean): Promise<void>;
  setArtistNotificationLevel?(artistId: string, level: ArtistNotificationLevel): Promise<void>;
  /** The account's notification inbox, newest first. */
  getNotifications?(): Promise<FeedNotification[]>;
  getUnseenNotificationCount?(): Promise<number>;
  getPlaylistTracks?(playlist: Playlist, onUpdate?: (tracks: Track[]) => void): Promise<Track[]>;
  getPlaylistTrackPage?(
    playlist: Playlist,
    pageKey?: string,
    onUpdate?: (page: TrackPage) => void,
  ): Promise<TrackPage>;
  setPlaylistSaved?(playlist: Playlist, saved: boolean): Promise<void>;
  createPlaylist?(title: string, trackIds?: string[]): Promise<Playlist>;
  renamePlaylist?(playlist: Playlist, title: string): Promise<void>;
  getPlaylistDescription?(playlist: Playlist): Promise<string | null>;
  setPlaylistDescription?(playlist: Playlist, description: string): Promise<void>;
  deletePlaylist?(playlist: Playlist): Promise<void>;
  /** Moves `movedTrack` to sit after `predecessorTrack`, or to the front when it is null. */
  reorderPlaylistTracks?(
    playlist: Playlist,
    movedTrack: Track,
    predecessorTrack: Track | null,
  ): Promise<void>;
  addTrackToPlaylist?(
    track: Track,
    playlist: Playlist,
  ): Promise<"added" | "already-present">;
  /**
   * Ids of the playlists that already contain this track.
   *
   * One question the source can answer directly; the alternative is fetching every playlist in
   * full just to draw a tick. Ids come back unprefixed.
   */
  getPlaylistIdsContainingTrack?(track: Track): Promise<string[]>;
  removeTrackFromPlaylist?(track: Track, playlist: Playlist): Promise<void>;
  setTrackLiked?(track: Track, liked: boolean): Promise<void>;
  /** Three-valued rating. Sources that only support liking may implement setTrackLiked alone. */
  setTrackRating?(track: Track, rating: TrackRating): Promise<void>;
  getRecommendations?(seed: Track, onUpdate?: (tracks: Track[]) => void): Promise<Track[]>;
  /** Discovery shelves for a track: similar artists, related playlists, more from the album. */
  getRelated?(track: Track): Promise<BrowseShelf[]>;
  getBrowsePage?(target: BrowseTarget): Promise<BrowsePage>;
  getLyrics?(track: Track): Promise<Lyrics | null>;
}
