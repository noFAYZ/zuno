import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AlbumIcon, CheckIcon, CloseIcon, CompassIcon, DownloadIcon, HeartActiveIcon, HeartIcon, LinkIcon, ListIcon, PencilIcon, PlaylistAddIcon, PlaylistIcon, SearchIcon, SkipNextIcon, TrashIcon } from "@/ui/icons";
import type { Playlist, Track, TrackRating } from "../../datasource/types";
import {
  TrackContextMenuContext,
  type TrackContextMenuValue,
} from "./trackContextMenuContext";
import type { LibraryController } from "../../player/LibraryController";
import { logInternalError } from "../../internal/logging";
import {
  cancelDownload,
  getOfflineStatus,
  queueDownload,
  removeDownload,
  useOfflineState,
} from "../../player/offlineStore";
import {
  playerController,
  shallowEqual,
  useLibraryState,
  usePlayerSelector,
} from "../../player/playerStore";
import { TrackArtwork } from "./TrackArtwork";
import { cn } from "@/lib/utils";
import { Loader } from "@/components/motion/loader";

/** Stable identity so useSyncExternalStore's server snapshot never loops. */
const NO_PLAYLISTS: Playlist[] = [];
const getNoPlaylists = () => NO_PLAYLISTS;

const NO_MEMBERSHIP: ReadonlySet<string> = new Set();

/** Playlist ids travel with and without a `VL` browse prefix; membership compares bare ids. */
function barePlaylistId(playlistId: string): string {
  return playlistId.replace(/^VL/, "");
}

const PICKER_ROW =
  "flex w-full items-center gap-2.5 rounded-lg p-1.5 transition-colors hover:bg-card disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
import {
  getLocalPlaylistItems,
  isLocalPlaylist,
  subscribeToLocalPlaylists,
} from "../../player/localPlaylists";
import { isTrackKnownInPlaylist } from "../../player/playlistMembership";
import { ArtistLinks } from "./ArtistLinks";
import { TagEditor } from "./TagEditor";

interface MenuPosition {
  x: number;
  y: number;
}

interface TrackContextMenuProviderProps {
  children: ReactNode;
  libraryController: LibraryController;
  /** Absent hides the "Show related" item, for surfaces with nowhere to navigate to. */
  onOpenRelated?: (track: Track) => void;
  /** Resolving a track to its album needs a lookup, so the page owns it. */
  onOpenAlbum?: (track: Track) => void;
}

/* Re-exported so the dozen existing `from "./TrackContextMenu"` imports keep working — the
   context itself has to live outside this file, see trackContextMenuContext.ts. */
export { useTrackContextMenu } from "./trackContextMenuContext";

export function TrackContextMenuProvider({
  children,
  libraryController,
  onOpenRelated,
  onOpenAlbum,
}: TrackContextMenuProviderProps) {
  const libraryState = useLibraryState();
  const playerState = usePlayerSelector((player) => ({ currentTrack: player.currentTrack }), shallowEqual);
  const menuRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const playlistRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const toastTimerRef = useRef<number | null>(null);
  const [track, setTrack] = useState<Track | null>(null);
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null);
  const [menuContext, setMenuContext] = useState<{
    playlist?: Playlist;
    onRemove?: (track: Track) => void;
  } | null>(null);
  const [isPickerOpen, setIsPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedPlaylistIndex, setSelectedPlaylistIndex] = useState<number | null>(null);
  const [addingPlaylistId, setAddingPlaylistId] = useState<string | null>(null);
  const [isRemovingTrack, setIsRemovingTrack] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [editingTagsFor, setEditingTagsFor] = useState<Track | null>(null);
  /** Non-null when the picker is acting on a multi-selection rather than one song. */
  const [batchTracks, setBatchTracks] = useState<Track[] | null>(null);
  /** Playlists YouTube says already hold this song, as answered for the open picker. */
  const [remoteMembership, setRemoteMembership] = useState<ReadonlySet<string>>(NO_MEMBERSHIP);

  const localPlaylists = useSyncExternalStore(
    subscribeToLocalPlaylists,
    getLocalPlaylistItems,
    getNoPlaylists,
  );

  /*
   * Every playlist this song could be added to, each tagged with whether it is already there.
   *
   * Local playlists were missing entirely — they never appear in `library.playlists`, so the
   * picker only ever offered YouTube ones. They are only a valid target for a song that has a
   * file on disk, since a local playlist is a list of paths.
   */
  const playlists = useMemo(() => {
    const seen = new Set<string>();
    const candidates: Playlist[] = [];
    for (const playlist of [...(libraryState.library?.playlists ?? []), ...localPlaylists]) {
      if (playlist.isEditable === false || seen.has(playlist.id)) continue;
      if (isLocalPlaylist(playlist) && track?.source !== "local") continue;
      seen.add(playlist.id);
      candidates.push(playlist);
    }

    const normalizedQuery = query.trim().toLocaleLowerCase();
    const matching = normalizedQuery
      ? candidates.filter((playlist) =>
          playlist.title.toLocaleLowerCase().includes(normalizedQuery)
        )
      : candidates;

    return matching.map((playlist) => ({
      playlist,
      isMember: track
        ? isTrackKnownInPlaylist(track, playlist)
          || remoteMembership.has(barePlaylistId(playlist.id))
        : false,
    }));
  }, [libraryState.library?.playlists, localPlaylists, query, remoteMembership, track]);

  /*
   * The local record only knows about adds made here — anything added on the web, on a phone,
   * or before this app existed had no tick. Asking YouTube when the picker opens is one
   * request and covers all of it; the local record still draws the ticks in the meantime, and
   * remains the whole answer for local playlists and for a source that cannot be asked.
   */
  useEffect(() => {
    if (!isPickerOpen || !track || track.source === "local") {
      setRemoteMembership(NO_MEMBERSHIP);
      return;
    }

    let active = true;
    void libraryController.getPlaylistIdsContainingTrack(track)
      .then((ids) => {
        if (active) setRemoteMembership(new Set(ids.map(barePlaylistId)));
      })
      .catch((error: unknown) => {
        logInternalError("TrackContextMenu.playlistMembership failed", error);
      });
    return () => {
      active = false;
    };
  }, [isPickerOpen, libraryController, track]);

  useEffect(() => {
    if (!menuPosition) return;
    const closeMenu = () => setMenuPosition(null);
    window.addEventListener("mousedown", closeMenu);
    window.addEventListener("blur", closeMenu);
    return () => {
      window.removeEventListener("mousedown", closeMenu);
      window.removeEventListener("blur", closeMenu);
    };
  }, [menuPosition]);

  useLayoutEffect(() => {
    if (!menuPosition) return;

    const keepMenuInViewport = () => {
      const menu = menuRef.current;
      if (!menu) return;

      const viewportMargin = 8;
      const bounds = menu.getBoundingClientRect();
      const x = Math.max(
        viewportMargin,
        Math.min(menuPosition.x, window.innerWidth - bounds.width - viewportMargin),
      );
      const y = Math.max(
        viewportMargin,
        Math.min(menuPosition.y, window.innerHeight - bounds.height - viewportMargin),
      );

      if (x !== menuPosition.x || y !== menuPosition.y) {
        setMenuPosition({ x, y });
      }
    };

    keepMenuInViewport();
    window.addEventListener("resize", keepMenuInViewport);
    return () => window.removeEventListener("resize", keepMenuInViewport);
  }, [menuContext, menuPosition, track]);

  useEffect(() => {
    if (isPickerOpen) {
      requestAnimationFrame(() => searchRef.current?.focus());
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || (!isPickerOpen && !menuPosition)) return;
      event.preventDefault();
      setMenuPosition(null);
      if (!addingPlaylistId) setIsPickerOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [addingPlaylistId, isPickerOpen, menuPosition]);

  useEffect(() => {
    if (selectedPlaylistIndex === null) return;
    playlistRefs.current[selectedPlaylistIndex]?.scrollIntoView({
      block: "nearest",
    });
  }, [selectedPlaylistIndex]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const ctrlOnly = event.ctrlKey
        && !event.altKey
        && !event.metaKey
        && !event.shiftKey;
      if (!ctrlOnly || event.code !== "KeyS") return;

      event.preventDefault();
      if (!playerState.currentTrack || addingPlaylistId) return;

      setTrack(playerState.currentTrack);
      setMenuPosition(null);
      setError(null);
      setQuery("");
      setSelectedPlaylistIndex(null);
      setIsPickerOpen(true);
    };

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [addingPlaylistId, playerState.currentTrack]);

  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
  }, []);

  const openTrackMenu = (
    event: ReactMouseEvent,
    selectedTrack: Track,
    context?: { playlist?: Playlist; onRemove?: (track: Track) => void },
  ) => {
    event.preventDefault();
    event.stopPropagation();
    setTrack(selectedTrack);
    setBatchTracks(null);
    setMenuContext(context ?? null);
    setIsPickerOpen(false);
    setError(null);
    setQuery("");
    setSelectedPlaylistIndex(null);
    setMenuPosition({
      x: event.clientX,
      y: event.clientY,
    });
  };

  const showToast = (message: string, duration = 3000) => {
    setToast(message);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), duration);
  };

  const showPersistentToast = (message: string) => {
    setToast(message);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
  };

  const addToQueue = () => {
    if (!track) return;
    playerController.addToQueue(track);
    setMenuPosition(null);
    showToast(`Added "${track.title}" to queue`);
  };

  const playNext = () => {
    if (!track) return;
    playerController.playNext(track);
    setMenuPosition(null);
    showToast(`"${track.title}" will play next`);
  };

  const copyLink = async () => {
    if (!track) return;
    const selectedTrack = track;
    setMenuPosition(null);
    try {
      await navigator.clipboard.writeText(
        `https://music.youtube.com/watch?v=${encodeURIComponent(selectedTrack.id)}`,
      );
      showToast("Link copied");
    } catch {
      showToast("Unable to copy the link.", 4000);
    }
  };

  /** Opens the picker straight away, for callers with no context menu in between. */
  const openPlaylistPicker = (selectedTrack: Track, batch?: Track[]) => {
    if (addingPlaylistId) return;
    setTrack(selectedTrack);
    setBatchTracks(batch && batch.length > 1 ? batch : null);
    setMenuContext(null);
    openPicker();
  };

  const openPicker = () => {
    setMenuPosition(null);
    setError(null);
    setQuery("");
    setSelectedPlaylistIndex(null);
    setIsPickerOpen(true);
  };

  const removeFromPlaylist = async () => {
    if (!track || !menuContext?.playlist || addingPlaylistId || isRemovingTrack) return;

    const selectedTrack = track;
    const playlist = menuContext.playlist;

    setIsRemovingTrack(true);
    setError(null);
    setMenuPosition(null);
    showPersistentToast("Removing...");

    try {
      if (playlist.kind === "liked-songs" || playlist.id === "LM") {
        await libraryController.setTrackLiked(selectedTrack, false);
      } else {
        await libraryController.removeTrackFromPlaylist(selectedTrack, playlist);
      }
      menuContext.onRemove?.(selectedTrack);
      showToast(
        playlist.kind === "liked-songs" || playlist.id === "LM"
          ? "Removed from Liked Songs"
          : `Removed from ${playlist.title}`,
      );
    } catch (removeError) {
      logInternalError("TrackContextMenu.removeFromPlaylist failed", removeError, {
        trackId: selectedTrack.id,
        playlistId: playlist.id,
        playlistTitle: playlist.title,
      });
      showToast(
        removeError instanceof Error ? removeError.message : "Unable to remove this song.",
        4000,
      );
    } finally {
      setIsRemovingTrack(false);
    }
  };

  const handlePickerKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (addingPlaylistId || playlists.length === 0) return;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setSelectedPlaylistIndex((current) => {
        if (current === null) return direction === 1 ? 0 : playlists.length - 1;
        return (current + direction + playlists.length) % playlists.length;
      });
      return;
    }

    if (event.key === "Enter" && selectedPlaylistIndex !== null) {
      event.preventDefault();
      const entry = playlists[selectedPlaylistIndex];
      if (entry) void addToPlaylist(entry.playlist);
    }
  };

  const addToPlaylist = async (playlist: Playlist) => {
    if (!track || addingPlaylistId) return;
    const selectedTrack = track;
    const batch = batchTracks;
    setAddingPlaylistId(playlist.id);
    setError(null);
    setIsPickerOpen(false);

    try {
      if (batch) {
        showPersistentToast(`Adding 0 of ${batch.length}...`);
        const result = await libraryController.addTracksToPlaylist(
          batch,
          playlist,
          (done, total) => {
            showPersistentToast(`Adding ${done} of ${total}...`);
          },
        );
        // Reports what actually happened rather than a flat "done": with a batch, some
        // already being present or failing is normal and worth knowing about.
        const parts = [`Added ${result.added} to ${playlist.title}`];
        if (result.alreadyPresent > 0) parts.push(`${result.alreadyPresent} already there`);
        if (result.failed > 0) parts.push(`${result.failed} failed`);
        showToast(parts.join(" · "), 5000);
      } else {
        showPersistentToast("Adding...");
        const result = await libraryController.addTrackToPlaylist(selectedTrack, playlist);
        // Ticked straight away, so reopening the picker does not have to wait on another round
        // trip to show what just happened.
        setRemoteMembership((current) => new Set(current).add(barePlaylistId(playlist.id)));
        showToast(
          result === "already-present" ? "Already in playlist" : `Added to ${playlist.title}`,
        );
      }
    } catch (addError) {
      showToast(
        addError instanceof Error ? addError.message : "Unable to add this song.",
        4000,
      );
    } finally {
      setAddingPlaylistId(null);
      setBatchTracks(null);
    }
  };

  /** Like-only shorthand, kept for callers that never deal in dislikes. */
  const toggleTrackLike = async (selectedTrack: Track) => {
    await rateTrack(
      selectedTrack,
      libraryController.isTrackLiked(selectedTrack.id) ? "none" : "like",
    );
  };

  const rateTrack = async (selectedTrack: Track, rating: TrackRating) => {
    if (selectedTrack.source === "local") return;
    if (libraryState.status === "signed-out" || !libraryState.library) {
      showToast("Sign in to like");
      return;
    }
    if (libraryState.pendingLikeTrackIds.has(selectedTrack.id)) return;

    const pendingLabel =
      rating === "like" ? "Liking..." : rating === "dislike" ? "Disliking..." : "Clearing...";
    const doneLabel =
      rating === "like"
        ? "Added to Liked Songs"
        : rating === "dislike"
          ? "Disliked"
          : "Rating cleared";

    showPersistentToast(pendingLabel);
    try {
      await libraryController.setTrackRating(selectedTrack, rating);
      showToast(doneLabel);
    } catch (ratingError) {
      showToast(
        ratingError instanceof Error ? ratingError.message : "Unable to update this rating.",
        4000,
      );
    }
  };

  const selectedTrackIsLiked = track && track.source !== "local"
    ? libraryState.library?.likedSongs.some((item) => item.id === track.id) ?? false
    : false;
  const isLikeMutationPending = track && track.source !== "local"
    ? libraryState.pendingLikeTrackIds.has(track.id)
    : false;
  const canLikeSelectedTrack = track?.source !== "local";
  const canCopySelectedTrackLink = track?.source !== "local";
  /*
   * Subscribed rather than read once: a download finishing while the menu is open should change
   * the item from "Cancel download" to "Remove download" under the cursor, not go stale.
   */
  const offlineState = useOfflineState();
  const selectedTrackOfflineStatus = track
    ? offlineState.entries[track.id]
      ? "ready"
      : offlineState.downloadingId === track.id
        ? "downloading"
        : offlineState.queued.includes(track.id)
          ? "queued"
          : "absent"
    : "absent";
  const canRemoveSelectedTrackFromPlaylist = Boolean(
    menuContext?.playlist
      && menuContext.playlist.isEditable !== false
      && menuContext.playlist.kind !== "liked-songs"
      && menuContext.playlist.id !== "LM"
      && !isLocalPlaylist(menuContext.playlist),
  );

  /*
   * A context value whose identity never changes.
   *
   * This provider wraps the entire application and re-renders on all of its own state — a
   * menu opening, the playlist picker filtering, any library update. A fresh object literal
   * here pushed a new context value on every one of those, and every consumer re-rendered:
   * that includes TrackRow, so a 500-row playlist re-rendered in full each time, and the
   * `memo` on it could never help because the value it depends on was always new.
   *
   * The handlers are read through a ref rather than wrapped in `useCallback`, because they
   * close over a dozen pieces of state. Dependency lists that long are wrong eventually, and
   * being wrong here means a menu acting on the previous track. The ref is always current.
   */
  const handlersRef = useRef({ openTrackMenu, openPlaylistPicker, toggleTrackLike, rateTrack, onOpenAlbum });
  handlersRef.current = { openTrackMenu, openPlaylistPicker, toggleTrackLike, rateTrack, onOpenAlbum };

  const contextValue = useMemo<TrackContextMenuValue>(
    () => ({
      openTrackMenu: (event, selectedTrack, context) =>
        handlersRef.current.openTrackMenu(event, selectedTrack, context),
      openPlaylistPicker: (selectedTrack, batch) =>
        handlersRef.current.openPlaylistPicker(selectedTrack, batch),
      toggleTrackLike: (selectedTrack) => handlersRef.current.toggleTrackLike(selectedTrack),
      rateTrack: (selectedTrack, rating) => handlersRef.current.rateTrack(selectedTrack, rating),
      /* Read through the ref so the identity stays stable — this context wraps every row. */
      openAlbumForTrack: onOpenAlbum
        ? (selectedTrack) => handlersRef.current.onOpenAlbum?.(selectedTrack)
        : null,
    }),
    [Boolean(onOpenAlbum)],
  );

  return (
    <TrackContextMenuContext.Provider value={contextValue}>
      {children}

      {menuPosition && track && (
        <div
          ref={menuRef}
          className="fixed z-50 flex min-w-56 flex-col gap-0.5 rounded-xl bg-popover/95 p-1.5 shadow-2xl backdrop-blur"
          style={{ left: menuPosition.x, top: menuPosition.y }}
          role="menu"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <button type="button" role="menuitem" className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-card disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" onClick={playNext}>
            <SkipNextIcon size={18} aria-hidden="true" />
            <span className="flex-1">Play next</span>
          </button>
          <button type="button" role="menuitem" className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-card disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" onClick={addToQueue}>
            <ListIcon size={18} aria-hidden="true" />
            <span className="flex-1">Add to queue</span>
          </button>
          <button type="button" role="menuitem" className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-card disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" onClick={openPicker}>
            <PlaylistAddIcon size={18} aria-hidden="true" />
            <span className="flex-1">Add to playlist</span>
            <kbd>Ctrl S</kbd>
          </button>
          {canLikeSelectedTrack && (
            <button
              type="button"
              role="menuitem" className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-card disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => {
                if (!track) return;
                setMenuPosition(null);
                void toggleTrackLike(track);
              }}
            >
              {selectedTrackIsLiked ? (
                <HeartActiveIcon size={18} aria-hidden="true" />
              ) : (
                <HeartIcon size={18} aria-hidden="true" />
              )}
              <span className="flex-1">
                {selectedTrackIsLiked ? "Remove like" : "Like song"}
              </span>
            </button>
          )}
          {/*
            Hidden for local files: they are already on disk, so "download for offline" would be
            a no-op that implies otherwise. The label follows the track's real state so one item
            covers download, cancel and remove rather than three that are mostly disabled.
          */}
          {track && track.source !== "local" && (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-card disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => {
                const selected = track;
                const status = getOfflineStatus(selected.id);
                setMenuPosition(null);
                if (status === "ready") void removeDownload(selected.id);
                else if (status === "queued" || status === "downloading") cancelDownload(selected.id);
                else queueDownload(selected);
              }}
            >
              {selectedTrackOfflineStatus === "ready" ? (
                <CheckIcon size={18} aria-hidden="true" className="text-primary" />
              ) : (
                <DownloadIcon size={18} aria-hidden="true" />
              )}
              <span className="flex-1">
                {selectedTrackOfflineStatus === "ready"
                  ? "Remove download"
                  : selectedTrackOfflineStatus === "downloading"
                    ? "Cancel download"
                    : selectedTrackOfflineStatus === "queued"
                      ? "Remove from download queue"
                      : "Download"}
              </span>
            </button>
          )}

          {/* Only for files we can actually write to — a YouTube track has no tags to edit. */}
          {track?.source === "local" && track.localPath && (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-card disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => {
                const selected = track;
                setMenuPosition(null);
                setEditingTagsFor(selected);
              }}
            >
              <PencilIcon size={18} aria-hidden="true" />
              <span className="flex-1">Edit tags</span>
            </button>
          )}
          {/* Streamed tracks only: a local file has no YouTube page to be related to. */}
          {onOpenAlbum && track?.album && track.source !== "local" && (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-card disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => {
                const selected = track;
                setMenuPosition(null);
                onOpenAlbum(selected);
              }}
            >
              <AlbumIcon size={18} aria-hidden="true" />
              <span className="flex-1 truncate">Go to album</span>
            </button>
          )}
          {onOpenRelated && track && track.source !== "local" && (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-card disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => {
                const selected = track;
                setMenuPosition(null);
                onOpenRelated(selected);
              }}
            >
              <CompassIcon size={18} aria-hidden="true" />
              <span className="flex-1">Show related</span>
            </button>
          )}
          {canCopySelectedTrackLink && (
            <button type="button" role="menuitem" className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-card disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" onClick={() => void copyLink()}>
              <LinkIcon size={18} aria-hidden="true" />
              <span className="flex-1">Copy link</span>
            </button>
          )}
          {canRemoveSelectedTrackFromPlaylist && (
            <button
              type="button"
              role="menuitem" className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-card disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => void removeFromPlaylist()}
              disabled={Boolean(addingPlaylistId || isRemovingTrack)}
            >
              <TrashIcon size={18} aria-hidden="true" />
              <span className="flex-1">Remove from playlist</span>
            </button>
          )}
        </div>
      )}

      {isPickerOpen && track && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-background/70 backdrop-blur-sm"
          onMouseDown={() => {
            if (!addingPlaylistId) setIsPickerOpen(false);
          }}
        >
          <section
            className="flex max-h-[70vh] w-[min(28rem,90vw)] flex-col gap-3 rounded-2xl bg-popover p-4 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label={`Add ${track.title} to playlist`}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="flex items-center gap-3">
              <TrackArtwork
                className="size-11 shrink-0 rounded-lg object-cover"
                size={44}
                artworkUrl={track.artworkUrl}
                iconSize={24}
                loading="eager"
              />
              <div className="flex min-w-0 flex-1 flex-col text-sm [&_small]:truncate [&_small]:text-xs [&_small]:text-muted-foreground [&_strong]:truncate [&_strong]:font-medium">
                <strong>{track.title}</strong>
                <small>
                  <ArtistLinks artists={track.artists} fallback={track.artist} />
                </small>
              </div>
              <button
                type="button"
                className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                disabled={Boolean(addingPlaylistId)}
                onClick={() => setIsPickerOpen(false)}
                aria-label="Close playlist picker"
              >
                <CloseIcon size={19} />
              </button>
            </header>

            <label className="flex items-center gap-2 rounded-lg bg-card px-2.5 py-2 text-muted-foreground [&_input]:min-w-0 [&_input]:flex-1 [&_input]:bg-transparent [&_input]:text-sm [&_input]:text-foreground [&_input]:outline-none">
              <SearchIcon size={18} aria-hidden="true" />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSelectedPlaylistIndex(null);
                }}
                onKeyDown={handlePickerKeyDown}
                placeholder="Find a playlist"
                aria-label="Find a playlist"
              />
            </label>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
              {playlists.length === 0 ? (
                <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                  {query
                    ? "No matching playlists."
                    : libraryState.status === "signed-out"
                      ? "Sign in to YouTube Music to add songs, or create a local playlist."
                      : "No editable playlists were found."}
                </p>
              ) : (
                playlists.map(({ playlist, isMember }, index) => (
                  <button
                    key={playlist.id}
                    ref={(element) => {
                      playlistRefs.current[index] = element;
                    }}
                    type="button"
                    className={cn(PICKER_ROW, selectedPlaylistIndex === index && "bg-primary/15 text-foreground")}
                    disabled={Boolean(addingPlaylistId)}
                    onMouseMove={() => setSelectedPlaylistIndex(null)}
                    onClick={() => void addToPlaylist(playlist)}
                  >
                    <span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-md bg-card text-muted-foreground [&_img]:size-full [&_img]:object-cover">
                      {playlist.artworkUrl ? (
                        <img src={playlist.artworkUrl} alt="" />
                      ) : (
                        <PlaylistIcon size={24} aria-hidden="true" />
                      )}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col text-left [&_span]:truncate [&_span]:text-xs [&_span]:text-muted-foreground [&_strong]:truncate [&_strong]:text-sm [&_strong]:font-medium">
                      <strong>{playlist.title}</strong>
                      <span>{isMember ? "Already added" : playlist.owner}</span>
                    </span>
                    {addingPlaylistId === playlist.id ? (
                      <span className="shrink-0 text-xs text-muted-foreground">Adding...</span>
                    ) : isMember ? (
                      /* Still clickable: this only means we *know* it is in there. Adding again
                         is harmless and answers "Already in playlist". */
                      <span
                        className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
                        title="Already in this playlist"
                      >
                        <CheckIcon size={13} aria-hidden="true" />
                        <span className="sr-only">Already in this playlist</span>
                      </span>
                    ) : null}
                  </button>
                ))
              )}
            </div>
          </section>
        </div>
      )}

      {editingTagsFor && (
        <TagEditor
          track={editingTagsFor}
          onClose={() => setEditingTagsFor(null)}
          onSaved={() => showToast("Tags saved")}
        />
      )}

      {toast && (
        <div className="fixed bottom-28 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-full bg-popover/95 px-4 py-2 text-sm text-foreground shadow-2xl backdrop-blur" role="status">
          {addingPlaylistId || isRemovingTrack || isLikeMutationPending ? (
            <Loader variant="spinner" size={18} />
          ) : toast === "Already in playlist" ? (
            <CloseIcon size={16} aria-hidden="true" />
          ) : (toast.startsWith("Added ") || toast.includes("will play next") || toast === "Link copied" || toast.startsWith("Removed from ")) && (
            <CheckIcon size={18} aria-hidden="true" />
          )}
          <span>{toast}</span>
        </div>
      )}
    </TrackContextMenuContext.Provider>
  );
}
