import { AuthExpiredError, type DataSource } from "../datasource/DataSource";
import type {
  AccountOption,
  GoogleAccountOption,
  Album,
  ArtistNotificationLevel,
  BrowsePage,
  BrowseShelf,
  BrowseTarget,
  Artist,
  ArtistPage,
  AuthPrompt,
  AuthFlow,
  AuthProgress,
  AuthStage,
  FeedNotification,
  LibrarySnapshot,
  Playlist,
  ResolvedLink,
  SearchCategory,
  SearchResults,
  TrackPage,
  Track,
  TrackRating,
} from "../datasource/types";
import { logInternalError, logInternalInfo } from "../internal/logging";
import { getInvokeErrorMessage } from "../internal/appSettings";
import { isOnline } from "../internal/connectivity";
import { getAppSetting, setAppSetting } from "../internal/appSettings";
import { forgetTrackInPlaylist, rememberTrackInPlaylist } from "./playlistMembership";
import {
  addLocalPlaylistPath,
  addLocalTrackToPlaylist,
  createLocalPlaylist,
  deleteLocalPlaylist,
  getLocalPlaylist,
  localPlaylistToPlaylist,
  renameLocalPlaylist,
  reorderLocalPlaylistTracks,
  getLocalPlaylistTrackPage,
  getLocalTracksForPlaylist,
  isLocalPlaylist,
  removeLocalPlaylistTrack,
  removeLocalTrackFromPlaylist,
} from "./localPlaylists";

export type LibraryStatus = "restoring" | "signed-out" | "authorizing" | "loading" | "ready" | "error";

export interface LibraryState {
  status: LibraryStatus;
  authPrompt: AuthPrompt | null;
  /**
   * What signing in or switching channel is doing right now, null when neither is running.
   *
   * Separate from `status`, which only says "authorizing" — the same value for the minutes
   * spent waiting on a browser window and the seconds spent fetching a library. The overlay
   * needs to tell those apart to say anything true.
   */
  authProgress: AuthProgress | null;
  library: LibrarySnapshot | null;
  pendingLikeTrackIds: ReadonlySet<string>;
  error: string | null;
  /**
   * When YouTube last answered as the signed-in user, or null if it has not this run.
   *
   * The only trustworthy basis for showing an account as connected. `library` cannot serve that
   * purpose: it is restored from a cache with no expiry, so it stays populated long after the
   * session behind it has died — which is exactly how the app came to claim a working
   * connection while every action against it silently failed.
   */
  sessionConfirmedAt: number | null;
}

type Listener = () => void;
/**
 * A first sync walks every page of every library section, so a large account legitimately takes
 * well past twenty seconds. This only bounds the *initial* fetch — a cached library returns at
 * once and refreshes in the background, where nothing is waiting on it.
 */
const LIBRARY_REFRESH_TIMEOUT_MS = 120_000;
const SIGN_IN_REFRESH_RETRY_DELAYS_MS = [0, 1_500, 5_000];
/**
 * Silent recovery opens a hidden webview, so it is rate-limited rather than reflexive. Long
 * enough that a genuinely dead session settles into the sign-in prompt instead of retrying at
 * it, short enough that a transient rejection heals itself within one sitting.
 */
const SESSION_RECOVERY_COOLDOWN_MS = 5 * 60_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * Whether a sign-in error is the user having backed out.
 *
 * Matched on the message because the backend reports cancellation as an ordinary command error
 * — there is no code to switch on. Kept next to the string it matches so the two move together.
 */
function isSignInCancellation(error: unknown): boolean {
  return /sign-in was cancelled/i.test(getInvokeErrorMessage(error));
}

/** Local mirror of dislikes: YouTube stores the rating but exposes no list to read it back. */
const DISLIKED_TRACKS_STORAGE_KEY = "zuno:disliked-tracks-v1";

function readDislikedTrackIds(): Set<string> {
  try {
    const raw = localStorage.getItem(DISLIKED_TRACKS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export class LibraryController {
  private readonly listeners = new Set<Listener>();
  private initializationPromise: Promise<void> | null = null;
  private state: LibraryState = {
    status: "restoring",
    authPrompt: null,
    authProgress: null,
    library: null,
    pendingLikeTrackIds: new Set(),
    error: null,
    sessionConfirmedAt: null,
  };

  /** Which flow `setAuthStage` is reporting for; the two share every stage but the first. */
  private activeAuthFlow: AuthFlow = "sign-in";
  private dislikedTrackIds: Set<string> = readDislikedTrackIds();
  private sessionRecoveryPromise: Promise<void> | null = null;
  private lastSessionRecoveryAt = 0;

  constructor(private readonly dataSource: DataSource) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): LibraryState {
    return this.state;
  }

  async initialize(): Promise<void> {
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.dataSource.onAuthExpired?.(() => this.markSessionExpired());
    this.dataSource.onAuthConfirmed?.((at) => this.setState({ sessionConfirmedAt: at }));
    this.initializationPromise = this.hydrateDislikedTrackIds().then(() => this.restoreSession());
    return this.initializationPromise;
  }

  /** Recovers dislikes from durable storage before the library is applied against them. */
  private async hydrateDislikedTrackIds(): Promise<void> {
    const stored = await getAppSetting<unknown>(DISLIKED_TRACKS_STORAGE_KEY);
    const ids = Array.isArray(stored)
      ? stored.filter((id): id is string => typeof id === "string")
      : null;

    if (ids && ids.length > 0) {
      this.dislikedTrackIds = new Set(ids);
      this.persistDislikedTrackIds();
      return;
    }
    if (this.dislikedTrackIds.size > 0) this.persistDislikedTrackIds();
  }

  /**
   * The session was rejected. Try to fix it without the user before admitting to it.
   *
   * Recovery is attempted at most once per cooldown and never twice at a time, so a burst of
   * rejected requests — which is the normal shape of this failure — cannot turn into a burst of
   * hidden webviews.
   */
  private markSessionExpired(): void {
    if (this.state.status === "signed-out" || this.state.status === "authorizing") return;
    if (this.sessionRecoveryPromise) return;

    const canRecover = this.dataSource.refreshSession
      && Date.now() - this.lastSessionRecoveryAt >= SESSION_RECOVERY_COOLDOWN_MS;
    if (!canRecover) {
      this.setSessionExpired();
      return;
    }

    this.lastSessionRecoveryAt = Date.now();
    this.sessionRecoveryPromise = this.recoverSessionSilently().finally(() => {
      this.sessionRecoveryPromise = null;
    });
  }

  private async recoverSessionSilently(): Promise<void> {
    logInternalInfo("LibraryController silent session recovery start");
    try {
      if (await this.dataSource.refreshSession?.()) {
        logInternalInfo("LibraryController silent session recovery succeeded");
        // A catch-up, not a resync: the cache survived, so this returns almost at once and
        // then quietly brings the library up to date behind it.
        await this.refresh({ suppressFailure: true });
        return;
      }
    } catch (error) {
      logInternalError("LibraryController silent session recovery failed", error);
      /*
       * A renewed cookie YouTube still refuses is an expired session; anything else is an
       * ordinary failure and says nothing about the sign-in. Both have to resolve the status,
       * because markSessionExpired suppresses itself while a recovery is in flight — which is
       * this one — and would otherwise leave the library stuck loading forever.
       */
      if (!(error instanceof AuthExpiredError)) {
        this.setFailure("Unable to load your YouTube Music library.", error);
        return;
      }
    }

    this.setSessionExpired();
  }

  /**
   * Say plainly that the session is gone, and stop pretending otherwise.
   *
   * The cached library is deliberately kept. It is still the user's library and still worth
   * looking at — what was wrong before was the *header* claiming a working connection while
   * every action against it failed.
   */
  private setSessionExpired(): void {
    logInternalInfo("LibraryController session expired");
    this.setState({
      status: "signed-out",
      authPrompt: null,
      error: "Your YouTube Music session expired. Sign in again to sync and to like songs.",
      sessionConfirmedAt: null,
    });
  }

  async recoverConnection(): Promise<void> {
    if (this.state.status === "authorizing") return;

    try {
      const restored = await this.dataSource.restoreSession?.();
      if (restored) {
        await this.refresh();
        return;
      }

      if (this.state.library) {
        await this.refresh();
      } else {
        this.setState({ status: "signed-out", authPrompt: null, error: null });
      }
    } catch (error) {
      this.setFailure("Unable to restore your YouTube Music session.", error);
    }
  }

  private async restoreSession(): Promise<void> {
    try {
      const cachedLibrary = await this.dataSource.getCachedLibrary?.();
      if (cachedLibrary) {
        this.setState({ library: cachedLibrary, error: null });
      }

      /*
       * A missing stored credential is not the same thing as a missing sign-in. The keyring
       * entry can fail to read, be half-written, or have been dropped by a migration, while the
       * sign-in webview's own Google session is still perfectly alive — so the durable record is
       * asked before the user is. Costs a hidden window on a path that was otherwise a prompt.
       */
      const restored = await this.dataSource.restoreSession?.()
        || await this.dataSource.refreshSession?.();
      if (!restored) {
        this.setState({ status: "signed-out", authPrompt: null, error: null });
        return;
      }
      await this.refresh();
    } catch (error) {
      this.setFailure("Unable to restore your YouTube Music session.", error);
    }
  }

  /** Resolves true only once an account is signed in and its library loaded. */
  async signIn(): Promise<boolean> {
    if (!this.dataSource.signIn) return false;
    logInternalInfo("LibraryController.signIn start");
    // Adding an account: a failed or cancelled attempt must not drop the session already here.
    const wasSignedIn = this.state.status === "ready";
    this.activeAuthFlow = "sign-in";
    this.setState({
      status: "authorizing",
      authPrompt: null,
      authProgress: { flow: "sign-in", stage: "browser", attempt: 1, attemptCount: 1 },
      error: null,
    });
    try {
      await this.dataSource.signIn(
        (authPrompt) => {
          logInternalInfo("LibraryController.signIn prompt received", {
            verificationUrl: authPrompt.verificationUrl,
            expiresInSec: authPrompt.expiresInSec,
          });
          this.setState({ status: "authorizing", authPrompt, error: null });
        },
        (stage) => this.setAuthStage(stage),
      );
      logInternalInfo("LibraryController.signIn authentication complete");
      await this.refreshAfterSignIn();
      logInternalInfo("LibraryController.signIn refresh complete");
      return true;
    } catch (error) {
      /*
       * Cancelling is not a failure. The backend reports it the same way as any other error,
       * so without this the user who pressed Cancel is told the sign-in "failed" and left on an
       * error screen they have to clear themselves.
       */
      if (isSignInCancellation(error)) {
        logInternalInfo("LibraryController.signIn cancelled by user");
        this.setState({ status: wasSignedIn ? "ready" : "signed-out", authPrompt: null, error: null });
      } else if (wasSignedIn) {
        // Re-read the backend's active account rather than assume which one survived the attempt.
        logInternalError("LibraryController.signIn failed", error);
        this.setState({ status: "loading", authPrompt: null });
        await this.recoverConnection();
        if (this.state.status === "ready") {
          this.setState({ error: `YouTube Music sign-in failed.\n\n${getInvokeErrorMessage(error)}` });
        }
      } else {
        this.setFailure("YouTube Music sign-in failed.", error);
      }
    } finally {
      // Cleared on every exit, success or failure: a stale stage would leave the overlay
      // describing work that is no longer running.
      this.setState({ authProgress: null });
    }
    return false;
  }

  /**
   * Backs out of a sign-in that is still waiting on the browser window.
   *
   * Closing that window is the whole mechanism: the backend polls for it and reports a
   * cancellation within a second of it disappearing, which unwinds `signIn` through the normal
   * path. Nothing here has to reach into that flow and unpick its state.
   */
  async cancelSignIn(): Promise<void> {
    logInternalInfo("LibraryController.cancelSignIn");
    await this.dataSource.cancelSignIn?.();
  }

  private setAuthStage(stage: AuthStage, attempt = 1, attemptCount = 1): void {
    this.setState({
      authProgress: { flow: this.activeAuthFlow, stage, attempt, attemptCount },
    });
  }

  /**
   * Signs out of the active account. With more than one Google account stored, this falls back
   * to another one automatically (the datasource reports whether it did) rather than dropping
   * to fully signed out — the same fallback `removeGoogleAccount` uses for a specific account.
   */
  async signOut(): Promise<void> {
    try {
      const fellBackToAnotherAccount = await this.dataSource.signOut?.() ?? false;
      if (fellBackToAnotherAccount) {
        this.setState({ status: "loading", library: null, authPrompt: null, error: null, sessionConfirmedAt: null });
        await this.refresh();
        return;
      }
      this.setState({
        status: "signed-out",
        authPrompt: null,
        library: null,
        pendingLikeTrackIds: new Set(),
        error: null,
        sessionConfirmedAt: null,
      });
    } catch (error) {
      this.setFailure("Unable to sign out.", error);
    }
  }

  getBrowsePage(target: BrowseTarget): Promise<BrowsePage> {
    if (!this.dataSource.getBrowsePage) {
      return Promise.resolve({ title: "", shelves: [] });
    }
    return this.dataSource.getBrowsePage(target);
  }

  listAccounts(): Promise<AccountOption[]> {
    return this.dataSource.listAccounts?.() ?? Promise.resolve([]);
  }

  /**
   * Switches channel and reloads the library.
   *
   * The old library is dropped before the refresh rather than after, so the UI never shows the
   * previous channel's playlists under the new channel's name while the fetch is in flight.
   */
  async selectAccount(id: string): Promise<void> {
    if (!this.dataSource.selectAccount) return;
    this.activeAuthFlow = "account-switch";
    this.setAuthStage("session");
    try {
      await this.dataSource.selectAccount(id);
      this.setState({ status: "loading", library: null, authPrompt: null, error: null });
      // One attempt, unlike sign-in: the session is already established, so a partial library
      // here is a real failure rather than YouTube still catching up with a new login.
      this.setAuthStage("library");
      await this.refresh();
    } catch (error) {
      this.setFailure("Unable to switch account.", error);
    } finally {
      this.setState({ authProgress: null });
    }
  }

  /** Every Google account with a stored session, for the account switcher. */
  listGoogleAccounts(): Promise<GoogleAccountOption[]> {
    return this.dataSource.listGoogleAccounts?.() ?? Promise.resolve([]);
  }

  /**
   * Switches to a stored Google account and reloads the library. Unlike `signIn`, never opens a
   * browser window — that is the entire point of storing more than one account.
   */
  async switchGoogleAccount(id: string): Promise<void> {
    if (!this.dataSource.switchGoogleAccount) return;
    this.activeAuthFlow = "google-account-switch";
    this.setAuthStage("session");
    try {
      await this.dataSource.switchGoogleAccount(id);
      this.setState({ status: "loading", library: null, authPrompt: null, error: null, sessionConfirmedAt: null });
      this.setAuthStage("library");
      await this.refresh();
    } catch (error) {
      this.setFailure("Unable to switch account.", error);
    } finally {
      this.setState({ authProgress: null });
    }
  }

  /**
   * Forgets one stored Google account. Removing a non-active account changes nothing on screen;
   * removing the active one behaves like `signOut` — falls back to another stored account when
   * one remains, or leaves the app signed out when it was the last one.
   */
  async removeGoogleAccount(id: string): Promise<void> {
    if (!this.dataSource.removeGoogleAccount) return;
    try {
      const outcome = await this.dataSource.removeGoogleAccount(id);
      if (outcome === "unchanged") return;
      if (outcome === "signed-out") {
        this.setState({
          status: "signed-out",
          authPrompt: null,
          library: null,
          pendingLikeTrackIds: new Set(),
          error: null,
          sessionConfirmedAt: null,
        });
        return;
      }
      this.setState({ status: "loading", library: null, authPrompt: null, error: null, sessionConfirmedAt: null });
      await this.refresh();
    } catch (error) {
      this.setFailure("Unable to remove that account.", error);
    }
  }

  async refresh(options: { suppressFailure?: boolean } = {}): Promise<void> {
    if (!this.dataSource.getLibrary) return;
    this.setState({ status: "loading", authPrompt: null, error: null });
    try {
      const library = await withTimeout(
        this.dataSource.getLibrary(
          (updatedLibrary) => {
            this.setState({ status: "ready", library: updatedLibrary, authPrompt: null, error: null });
          },
          (error) => {
            // A background refresh, so there is no caller to throw to — this is the only way an
            // expired session behind a cache hit ever becomes visible.
            if (error instanceof AuthExpiredError) this.markSessionExpired();
          },
        ),
        LIBRARY_REFRESH_TIMEOUT_MS,
        "YouTube Music library sync timed out.",
      );
      this.applyLibrary(library);
    } catch (error) {
      if (error instanceof AuthExpiredError) {
        this.markSessionExpired();
        if (options.suppressFailure) throw error;
        return;
      }
      if (options.suppressFailure) throw error;
      this.setFailure("Unable to load your YouTube Music library.", error);
    }
  }

  private applyLibrary(library: LibrarySnapshot): void {
    this.setState({ status: "ready", library, authPrompt: null, error: null });
    logInternalInfo("LibraryController.refresh success", {
      albumCount: library.albums.length,
      playlistCount: library.playlists.length,
      likedSongCount: library.likedSongs.length,
      recentTrackCount: library.recentlyPlayed.length,
    });
  }

  private hasCompleteEnoughLibrary(library: LibrarySnapshot | null): boolean {
    if (!library) return false;
    return library.playlists.length > 0
      || library.albums.length > 0
      || library.likedSongs.length > 0;
  }

  private async refreshAfterSignIn(): Promise<void> {
    let lastError: unknown = null;

    for (let index = 0; index < SIGN_IN_REFRESH_RETRY_DELAYS_MS.length; index += 1) {
      const delayMs = SIGN_IN_REFRESH_RETRY_DELAYS_MS[index];
      // Announced before the wait, so the overlay explains the pause rather than sitting idle.
      this.setAuthStage("library", index + 1, SIGN_IN_REFRESH_RETRY_DELAYS_MS.length);
      if (delayMs > 0) await delay(delayMs);

      try {
        await this.refresh({ suppressFailure: true });
        if (this.hasCompleteEnoughLibrary(this.state.library)) return;

        logInternalInfo("LibraryController.signIn retrying incomplete library", {
          attempt: index + 1,
          playlistCount: this.state.library?.playlists.length ?? 0,
          albumCount: this.state.library?.albums.length ?? 0,
          likedSongCount: this.state.library?.likedSongs.length ?? 0,
          recentTrackCount: this.state.library?.recentlyPlayed.length ?? 0,
        });
      } catch (error) {
        lastError = error;
        logInternalInfo("LibraryController.signIn library retry failed", {
          attempt: index + 1,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (this.state.library) return;
    throw lastError ?? new Error("YouTube Music library did not finish syncing after sign-in.");
  }

  async getAlbumTracks(album: Album, onUpdate?: (tracks: Track[]) => void): Promise<Track[]> {
    if (!this.dataSource.getAlbumTracks) return [];
    return this.dataSource.getAlbumTracks(album, onUpdate);
  }

  async getArtist(
    artistId: string,
    onUpdate?: (artist: ArtistPage) => void,
  ): Promise<ArtistPage> {
    if (!this.dataSource.getArtist) {
      throw new Error("Artist pages are unavailable.");
    }
    return this.dataSource.getArtist(artistId, onUpdate);
  }

  async setArtistSubscribed(artist: Artist, subscribed: boolean): Promise<void> {
    if (!this.dataSource.setArtistSubscribed) {
      throw new Error("Subscribing to artists is unavailable.");
    }
    if (this.state.status === "signed-out" || !this.state.library) {
      throw new Error("Sign in to YouTube Music to update subscriptions.");
    }
    if (!artist.id.startsWith("UC")) {
      throw new Error("This artist does not have a subscribable channel.");
    }
    return this.dataSource.setArtistSubscribed(artist.id, subscribed);
  }

  /**
   * How often YouTube may notify about this artist.
   *
   * Requires an active subscription — YouTube stores the preference against it, so setting a
   * level on an unsubscribed channel silently does nothing.
   */
  async setArtistNotificationLevel(
    artist: Artist,
    level: ArtistNotificationLevel,
  ): Promise<void> {
    if (!this.dataSource.setArtistNotificationLevel) {
      throw new Error("Artist notifications are unavailable.");
    }
    if (this.state.status === "signed-out" || !this.state.library) {
      throw new Error("Sign in to YouTube Music to change notifications.");
    }
    if (!artist.id.startsWith("UC")) {
      throw new Error("This artist does not have a subscribable channel.");
    }
    return this.dataSource.setArtistNotificationLevel(artist.id, level);
  }

  async getNotifications(): Promise<FeedNotification[]> {
    if (!this.dataSource.getNotifications) return [];
    if (this.state.status === "signed-out") return [];
    return this.dataSource.getNotifications();
  }

  async getUnseenNotificationCount(): Promise<number> {
    if (!this.dataSource.getUnseenNotificationCount) return 0;
    if (this.state.status === "signed-out") return 0;
    return this.dataSource.getUnseenNotificationCount();
  }

  /** Discovery shelves for a track. Empty rather than throwing — this is never the main event. */
  async getRelated(track: Track): Promise<BrowseShelf[]> {
    if (!this.dataSource.getRelated) return [];
    return this.dataSource.getRelated(track);
  }

  /** Resolves a pasted YouTube link. Null when it is not one, or points somewhere unopenable. */
  async resolveLink(url: string): Promise<ResolvedLink | null> {
    if (!this.dataSource.resolveLink) return null;
    return this.dataSource.resolveLink(url);
  }

  async searchCategory(query: string, category: SearchCategory): Promise<SearchResults> {
    if (!this.dataSource.searchCategory) {
      return { artists: [], tracks: [], albums: [], playlists: [] };
    }
    return this.dataSource.searchCategory(query, category);
  }

  isAlbumSaved(albumId: string): boolean {
    return this.state.library?.albums.some((album) =>
      album.id === albumId || album.playlistId === albumId
    ) ?? false;
  }

  async setAlbumSaved(album: Album, saved: boolean): Promise<void> {
    if (!this.dataSource.setAlbumSaved) {
      throw new Error("Saving albums is unavailable.");
    }
    if (this.state.status === "signed-out" || !this.state.library) {
      throw new Error("Sign in to YouTube Music to update your library.");
    }

    const previousLibrary = this.state.library;
    const sameAlbum = (item: Album) =>
      item.id === album.id
      || Boolean(album.playlistId && item.playlistId === album.playlistId)
      || Boolean(album.playlistId && item.id === album.playlistId)
      || Boolean(item.playlistId && item.playlistId === album.id);
    const albums = saved
      ? [album, ...previousLibrary.albums.filter((item) => !sameAlbum(item))]
      : previousLibrary.albums.filter((item) => !sameAlbum(item));
    this.setState({ library: { ...previousLibrary, albums } });

    try {
      await this.dataSource.setAlbumSaved(album, saved);
      void this.refresh();
    } catch (error) {
      this.setState({ library: previousLibrary });
      throw error;
    }
  }

  async getPlaylistTracks(playlist: Playlist, onUpdate?: (tracks: Track[]) => void): Promise<Track[]> {
    if (isLocalPlaylist(playlist)) {
      const page = await getLocalPlaylistTrackPage(playlist);
      if (page.tracks.length > 0) onUpdate?.(page.tracks);
      return page.tracks;
    }

    const localTracks = getLocalTracksForPlaylist(playlist);
    const mergeLocalTracks = (tracks: Track[]): Track[] => [...tracks, ...localTracks];
    if (!this.dataSource.getPlaylistTracks) return localTracks;
    const tracks = await this.dataSource.getPlaylistTracks(
      playlist,
      (updatedTracks) => onUpdate?.(mergeLocalTracks(updatedTracks)),
    );
    return mergeLocalTracks(tracks);
  }

  async getPlaylistTrackPage(
    playlist: Playlist,
    pageKey?: string,
    onUpdate?: (page: TrackPage) => void,
  ): Promise<TrackPage> {
    if (isLocalPlaylist(playlist)) {
      const page = pageKey ? { tracks: [], hasMore: false } : await getLocalPlaylistTrackPage(playlist);
      if (page.tracks.length > 0) onUpdate?.(page);
      return page;
    }

    const localTracks = pageKey ? [] : getLocalTracksForPlaylist(playlist);
    const mergeLocalTracks = (page: TrackPage): TrackPage => ({
      ...page,
      tracks: [...page.tracks, ...localTracks],
    });

    if (!this.dataSource.getPlaylistTrackPage) {
      const tracks = pageKey
        ? []
        : await this.dataSource.getPlaylistTracks?.(playlist) ?? [];
      const page = mergeLocalTracks({ tracks, hasMore: false });
      if (page.tracks.length > 0) onUpdate?.(page);
      return page;
    }
    const page = await this.dataSource.getPlaylistTrackPage(playlist, pageKey, (updatedPage) => {
      onUpdate?.(pageKey ? updatedPage : mergeLocalTracks(updatedPage));
    });
    return pageKey ? page : mergeLocalTracks(page);
  }

  async getRecommendations(seed: Track): Promise<Track[]> {
    return this.dataSource.getRecommendations?.(seed) ?? [];
  }

  /** Empty when the source cannot answer — the picker falls back to what it remembers. */
  async getPlaylistIdsContainingTrack(track: Track): Promise<string[]> {
    if (!this.dataSource.getPlaylistIdsContainingTrack) return [];
    if (this.state.status === "signed-out") return [];
    return this.dataSource.getPlaylistIdsContainingTrack(track);
  }

  async addTrackToPlaylist(
    track: Track,
    playlist: Playlist,
  ): Promise<"added" | "already-present"> {
    if (track.source === "local") {
      // A local playlist is a list of file paths, not of tracks, so a local song joins it by
      // path. (Local songs in a *YouTube* playlist can't be sent to YouTube at all, so those
      // are shadowed in local storage instead — that is what addLocalTrackToPlaylist does.)
      if (isLocalPlaylist(playlist)) {
        if (!track.localPath) {
          throw new Error("This song has no file on disk to add.");
        }
        const paths = getLocalPlaylist(playlist.id)?.paths ?? [];
        if (paths.includes(track.localPath)) return "already-present";
        addLocalPlaylistPath(playlist.id, track.localPath);
        return "added";
      }
      return addLocalTrackToPlaylist(track, playlist);
    }
    if (!this.dataSource.addTrackToPlaylist) {
      throw new Error("Adding songs to playlists is unavailable.");
    }
    if (this.state.status === "signed-out" || !this.state.library) {
      throw new Error("Sign in to YouTube Music before adding songs to playlists.");
    }
    const result = await this.dataSource.addTrackToPlaylist(track, playlist);
    rememberTrackInPlaylist(track, playlist);
    return result;
  }

  /**
   * Adds several tracks to a playlist, reporting progress as it goes.
   *
   * Sequential rather than parallel: YouTube rejects rapid bursts of playlist edits, and a
   * partially-applied batch is far more confusing than a slow one. Failures are collected
   * rather than thrown so one bad track cannot abandon the rest.
   */
  async addTracksToPlaylist(
    tracks: Track[],
    playlist: Playlist,
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ added: number; alreadyPresent: number; failed: number }> {
    let added = 0;
    let alreadyPresent = 0;
    let failed = 0;

    for (const [index, track] of tracks.entries()) {
      try {
        const result = await this.addTrackToPlaylist(track, playlist);
        if (result === "added") added += 1;
        else alreadyPresent += 1;
      } catch (error) {
        failed += 1;
        logInternalError("LibraryController.addTracksToPlaylist item failed", error, {
          trackId: track.id,
          playlistId: playlist.id,
        });
      }
      onProgress?.(index + 1, tracks.length);
    }

    logInternalInfo("LibraryController.addTracksToPlaylist", {
      playlistId: playlist.id,
      added,
      alreadyPresent,
      failed,
    });
    return { added, alreadyPresent, failed };
  }

  async removeTrackFromPlaylist(track: Track, playlist: Playlist): Promise<void> {
    forgetTrackInPlaylist(track, playlist);
    if (track.source === "local") {
      if (isLocalPlaylist(playlist)) {
        if (track.localPath) removeLocalPlaylistTrack(playlist.id, track.localPath);
        return;
      }
      removeLocalTrackFromPlaylist(track, playlist);
      return;
    }
    if (!this.dataSource.removeTrackFromPlaylist) {
      logInternalError("LibraryController.removeTrackFromPlaylist unavailable", {
        dataSource: this.dataSource.constructor.name,
        trackId: track.id,
        playlistId: playlist.id,
      });
      throw new Error("Removing songs from playlists is unavailable.");
    }
    if (this.state.status === "signed-out" || !this.state.library) {
      throw new Error("Sign in to YouTube Music before removing songs from playlists.");
    }
    return this.dataSource.removeTrackFromPlaylist(track, playlist);
  }

  isPlaylistSaved(playlistId: string): boolean {
    const normalizedId = playlistId.replace(/^VL/, "");
    return this.state.library?.playlists.some(
      (playlist) => playlist.id.replace(/^VL/, "") === normalizedId,
    ) ?? false;
  }

  /**
   * Creates a playlist on YouTube Music, or on disk when `local` is set.
   *
   * The two used to be the same button doing only the local half, which is why "Add to
   * playlist" could never target anything you had not already made on the web.
   */
  async createPlaylist(
    title: string,
    options: { local?: boolean; trackIds?: string[] } = {},
  ): Promise<Playlist> {
    const trimmed = title.trim();
    if (!trimmed) throw new Error("Give the playlist a name.");

    if (options.local) {
      return localPlaylistToPlaylist(createLocalPlaylist(trimmed));
    }
    if (!this.dataSource.createPlaylist) {
      throw new Error("Creating playlists is unavailable.");
    }
    if (this.state.status === "signed-out" || !this.state.library) {
      throw new Error("Sign in to YouTube Music to create playlists.");
    }

    const created = await this.dataSource.createPlaylist(trimmed, options.trackIds);
    // Shown immediately, then reconciled — a new playlist that takes a full library sync to
    // appear reads as a failure.
    const library = this.state.library;
    this.setState({ library: { ...library, playlists: [created, ...library.playlists] } });
    void this.refresh();
    return created;
  }

  async renamePlaylist(playlist: Playlist, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed || trimmed === playlist.title) return;

    if (isLocalPlaylist(playlist)) {
      renameLocalPlaylist(playlist.id, trimmed);
      return;
    }
    if (!this.dataSource.renamePlaylist) {
      throw new Error("Renaming playlists is unavailable.");
    }

    const previousLibrary = this.state.library;
    if (previousLibrary) {
      this.setState({
        library: {
          ...previousLibrary,
          playlists: previousLibrary.playlists.map((item) =>
            item.id === playlist.id ? { ...item, title: trimmed } : item,
          ),
        },
      });
    }

    try {
      await this.dataSource.renamePlaylist(playlist, trimmed);
    } catch (error) {
      if (previousLibrary) this.setState({ library: previousLibrary });
      throw error;
    }
  }

  /**
   * Sets a playlist's description.
   *
   * Local playlists have nowhere to keep one — they are a list of file paths — so this is a
   * no-op for them rather than an error the caller has to special-case.
   */
  async getPlaylistDescription(playlist: Playlist): Promise<string | null> {
    if (isLocalPlaylist(playlist) || !this.dataSource.getPlaylistDescription) return null;
    return this.dataSource.getPlaylistDescription(playlist);
  }

  async setPlaylistDescription(playlist: Playlist, description: string): Promise<void> {
    if (isLocalPlaylist(playlist)) return;
    if (!this.dataSource.setPlaylistDescription) {
      throw new Error("Playlist descriptions are unavailable.");
    }

    const trimmed = description.trim();
    const previousLibrary = this.state.library;
    if (previousLibrary) {
      this.setState({
        library: {
          ...previousLibrary,
          playlists: previousLibrary.playlists.map((item) =>
            item.id === playlist.id ? { ...item, description: trimmed } : item,
          ),
        },
      });
    }

    try {
      await this.dataSource.setPlaylistDescription(playlist, trimmed);
    } catch (error) {
      if (previousLibrary) this.setState({ library: previousLibrary });
      throw error;
    }
  }

  async deletePlaylist(playlist: Playlist): Promise<void> {
    if (isLocalPlaylist(playlist)) {
      deleteLocalPlaylist(playlist.id);
      return;
    }
    if (!this.dataSource.deletePlaylist) {
      throw new Error("Deleting playlists is unavailable.");
    }

    const previousLibrary = this.state.library;
    if (previousLibrary) {
      this.setState({
        library: {
          ...previousLibrary,
          playlists: previousLibrary.playlists.filter((item) => item.id !== playlist.id),
        },
      });
    }

    try {
      await this.dataSource.deletePlaylist(playlist);
    } catch (error) {
      if (previousLibrary) this.setState({ library: previousLibrary });
      throw error;
    }
  }

  /**
   * Persists a drag-reorder.
   *
   * Local playlists keep their order on disk; YouTube ones are addressed by the row the track
   * sits in, so the caller passes the track that should end up before it — null meaning the
   * top of the list.
   */
  async reorderPlaylistTracks(
    playlist: Playlist,
    movedTrack: Track,
    predecessorTrack: Track | null,
    localIndices?: { from: number; to: number },
  ): Promise<void> {
    if (isLocalPlaylist(playlist)) {
      if (localIndices) {
        reorderLocalPlaylistTracks(playlist.id, localIndices.from, localIndices.to);
      }
      return;
    }
    if (!this.dataSource.reorderPlaylistTracks) return;
    await this.dataSource.reorderPlaylistTracks(playlist, movedTrack, predecessorTrack);
  }

  async setPlaylistSaved(playlist: Playlist, saved: boolean): Promise<void> {
    if (!this.dataSource.setPlaylistSaved) {
      throw new Error("Saving playlists is unavailable.");
    }
    if (this.state.status === "signed-out" || !this.state.library) {
      throw new Error("Sign in to YouTube Music to update your library.");
    }

    const previousLibrary = this.state.library;
    const normalizedId = playlist.id.replace(/^VL/, "");
    const playlists = saved
      ? [
          { ...playlist, isSaved: true, isEditable: playlist.isEditable ?? false },
          ...previousLibrary.playlists.filter(
            (item) => item.id.replace(/^VL/, "") !== normalizedId,
          ),
        ]
      : previousLibrary.playlists.filter(
          (item) => item.id.replace(/^VL/, "") !== normalizedId,
        );
    this.setState({ library: { ...previousLibrary, playlists } });

    try {
      await this.dataSource.setPlaylistSaved(playlist, saved);
      void this.refresh();
    } catch (error) {
      this.setState({ library: previousLibrary });
      throw error;
    }
  }

  isTrackLiked(trackId: string): boolean {
    return this.state.library?.likedSongs.some((track) => track.id === trackId) ?? false;
  }

  async setTrackLiked(track: Track, liked: boolean): Promise<void> {
    await this.setTrackRating(track, liked ? "like" : "none");
  }

  /**
   * The rating a track currently has.
   *
   * Likes are read from the library snapshot, which YouTube gives us. Dislikes are read from a
   * local set, because there is no "disliked songs" list to fetch back — YouTube stores the
   * rating but never hands it to us in bulk. Mirroring it locally is what lets the button show
   * the right state after a restart instead of silently resetting to neutral.
   */
  getTrackRating(trackId: string): TrackRating {
    if (this.isTrackLiked(trackId)) return "like";
    return this.dislikedTrackIds.has(trackId) ? "dislike" : "none";
  }

  async setTrackRating(track: Track, rating: TrackRating): Promise<void> {
    const applyRating = this.dataSource.setTrackRating
      ? (value: TrackRating) => this.dataSource.setTrackRating!(track, value)
      : this.dataSource.setTrackLiked && rating !== "dislike"
        // A source with only setTrackLiked can still like and unlike; dislike is what it cannot do.
        ? (value: TrackRating) => this.dataSource.setTrackLiked!(track, value === "like")
        : null;

    if (!applyRating) {
      throw new Error(
        rating === "dislike" ? "Disliking songs is unavailable." : "Liking songs is unavailable.",
      );
    }
    if (this.state.status === "signed-out" || !this.state.library) {
      throw new Error("Sign in to like");
    }
    if (this.state.pendingLikeTrackIds.has(track.id)) return;

    const previousLibrary = this.state.library;
    const previousDisliked = new Set(this.dislikedTrackIds);
    const pendingLikeTrackIds = new Set(this.state.pendingLikeTrackIds);
    pendingLikeTrackIds.add(track.id);

    /*
     * Applied optimistically, and both lists move together: a rating is one value, so liking a
     * disliked song must clear the dislike rather than leave the track in both states.
     */
    const likedSongs = rating === "like"
      ? [track, ...previousLibrary.likedSongs.filter((item) => item.id !== track.id)]
      : previousLibrary.likedSongs.filter((item) => item.id !== track.id);

    if (rating === "dislike") this.dislikedTrackIds.add(track.id);
    else this.dislikedTrackIds.delete(track.id);
    this.persistDislikedTrackIds();

    this.setState({
      library: { ...previousLibrary, likedSongs },
      pendingLikeTrackIds,
    });

    try {
      await applyRating(rating);
    } catch (error) {
      this.setState({ library: previousLibrary });
      this.dislikedTrackIds = previousDisliked;
      this.persistDislikedTrackIds();
      throw error;
    } finally {
      const nextPending = new Set(this.state.pendingLikeTrackIds);
      nextPending.delete(track.id);
      this.setState({ pendingLikeTrackIds: nextPending });
    }
  }

  private persistDislikedTrackIds(): void {
    try {
      localStorage.setItem(
        DISLIKED_TRACKS_STORAGE_KEY,
        JSON.stringify([...this.dislikedTrackIds]),
      );
    } catch {
      // Quota or privacy mode: the rating still reached YouTube, only the local mirror is lost.
    }
    /*
     * And durably, outside webview storage. YouTube keeps the rating but exposes no way to read
     * dislikes back, so this list is the only record that exists anywhere — losing it is not
     * something a resync can undo.
     */
    void setAppSetting(DISLIKED_TRACKS_STORAGE_KEY, [...this.dislikedTrackIds]);
  }

  private setFailure(message: string, error: unknown) {
    logInternalError("LibraryController operation failed", error);
    const detail = getInvokeErrorMessage(error);
    this.setState({
      status: "error",
      // recoverConnection retries on reconnect, so offline this is a wait, not a failure.
      error: !isOnline()
        ? "You're offline. Zuno will retry when you reconnect."
        : detail && detail !== "[object Object]" ? `${message}\n\n${detail}` : message,
      authPrompt: null,
    });
  }

  private setState(partial: Partial<LibraryState>) {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }
}
