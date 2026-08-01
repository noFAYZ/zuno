import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { Loader } from "@/components/motion/loader";
import { BookmarkActiveIcon, BookmarkIcon, CheckIcon, CopyIcon, DownloadIcon, PencilIcon, TrashIcon } from "@/ui/icons";
import type { Album, Playlist } from "../../datasource/types";
import type { LibraryController } from "../../player/LibraryController";
import { isLocalPlaylist } from "../../player/localPlaylists";
import { exportPlaylist } from "../../player/playlistTransfer";
import {
  PlaylistContext,
  type PlaylistContextMenuValue,
} from "./playlistContextMenuContext";

/* Re-exported so existing `from "./PlaylistContextMenu"` imports keep working; the context
   itself has to live outside this file. See playlistContextMenuContext.ts. */
export { usePlaylistContextMenu } from "./playlistContextMenuContext";

export function PlaylistContextMenuProvider({
  children,
  libraryController,
}: {
  children: ReactNode;
  libraryController: LibraryController;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const toastTimerRef = useRef<number | null>(null);
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [album, setAlbum] = useState<Album | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  /*
   * Renaming happens inside the menu rather than in a separate dialog. The menu is already
   * anchored to the playlist you right-clicked, so swapping its body for a field keeps the
   * subject of the edit on screen — a centred modal loses that.
   */
  const [renameDraft, setRenameDraft] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  /*
   * Selects the existing name once, when the field opens — never again.
   *
   * Keying this on `renameDraft` re-ran it on every keystroke: 40ms after each character the
   * whole value was selected again, so the next character replaced everything typed so far and
   * the field could never hold more than one letter. Keying it on *whether* a draft exists
   * means the effect fires on the null → string transition only.
   */
  const isRenaming = renameDraft !== null;
  useEffect(() => {
    if (!isRenaming) return;
    const timer = window.setTimeout(() => renameInputRef.current?.select(), 40);
    return () => window.clearTimeout(timer);
  }, [isRenaming]);

  useEffect(() => {
    if (!position) return;
    const close = () => {
      setPosition(null);
      setRenameDraft(null);
      setConfirmDelete(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("blur", close);
    };
  }, [position]);

  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
  }, []);

  useLayoutEffect(() => {
    if (!position) return;

    const keepMenuInViewport = () => {
      const menu = menuRef.current;
      if (!menu) return;

      const viewportMargin = 8;
      const bounds = menu.getBoundingClientRect();
      const x = Math.max(
        viewportMargin,
        Math.min(position.x, window.innerWidth - bounds.width - viewportMargin),
      );
      const y = Math.max(
        viewportMargin,
        Math.min(position.y, window.innerHeight - bounds.height - viewportMargin),
      );

      if (x !== position.x || y !== position.y) {
        setPosition({ x, y });
      }
    };

    keepMenuInViewport();
    window.addEventListener("resize", keepMenuInViewport);
    return () => window.removeEventListener("resize", keepMenuInViewport);
  }, [album, playlist, position]);

  const showToast = (message: string) => {
    setToast(message);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3000);
  };

  const showPersistentToast = (message: string) => {
    setToast(message);
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
  };

  const openPlaylistMenu = (event: ReactMouseEvent, selected: Playlist) => {
    event.preventDefault();
    event.stopPropagation();
    setPlaylist(selected);
    setAlbum(null);
    // A menu reopened on a different playlist must not inherit the last one's rename draft
    // or an armed delete confirmation.
    setRenameDraft(null);
    setConfirmDelete(false);
    setPosition({ x: event.clientX, y: event.clientY });
  };

  const openAlbumMenu = (event: ReactMouseEvent, selected: Album) => {
    event.preventDefault();
    event.stopPropagation();
    setRenameDraft(null);
    setConfirmDelete(false);
    setAlbum(selected);
    setPlaylist(null);
    setPosition({ x: event.clientX, y: event.clientY });
  };

  const isSaved = album
    ? libraryController.isAlbumSaved(album.id) || Boolean(album.playlistId && libraryController.isAlbumSaved(album.playlistId))
    : false;

  const isLocalPlaylistMenu = playlist ? isLocalPlaylist(playlist) : false;
  // Liked Songs is a system list: it has no name of its own and cannot be removed.
  const canEditPlaylist = Boolean(
    playlist
      && playlist.isEditable !== false
      && playlist.kind !== "liked-songs"
      && playlist.id !== "LM",
  );
  const canCopyPlaylistUrl = Boolean(
    playlist
      && !isLocalPlaylistMenu
      && playlist.kind !== "liked-songs"
      && playlist.id !== "LM",
  );

  const getAlbumUrl = (album: Album): string => {
    if (album.id.startsWith("UC")) {
      return `https://music.youtube.com/channel/${encodeURIComponent(album.id)}`;
    }
    if (album.id) {
      return `https://music.youtube.com/browse/${encodeURIComponent(album.id)}`;
    }
    return `https://music.youtube.com/search?q=${encodeURIComponent(album.title)}`;
  };

  const getPlaylistUrl = (playlist: Playlist): string => {
    const playlistId = playlist.id.replace(/^VL/, "");
    return `https://music.youtube.com/playlist?list=${encodeURIComponent(playlistId)}`;
  };

  const toggleAlbumSaved = async () => {
    if (!album || isSaving) return;
    const saved = libraryController.isAlbumSaved(album.id)
      || Boolean(album.playlistId && libraryController.isAlbumSaved(album.playlistId));
    setPosition(null);
    setIsSaving(true);
    showPersistentToast(saved ? "Removing..." : "Saving...");
    try {
      await libraryController.setAlbumSaved(album, !saved);
      showToast(saved ? "Removed from library" : "Saved to library");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Unable to update this album.");
    } finally {
      setIsSaving(false);
    }
  };

  const copyAlbumUrl = async () => {
    if (!album || isSaving) return;
    setPosition(null);
    try {
      await navigator.clipboard.writeText(getAlbumUrl(album));
      showToast("Url copied to clipboard");
    } catch {
      showToast("Unable to copy the link.");
    }
  };

  const copyPlaylistUrl = async () => {
    if (!playlist || isSaving) return;
    setPosition(null);
    try {
      await navigator.clipboard.writeText(getPlaylistUrl(playlist));
      showToast("Url copied to clipboard");
    } catch {
      showToast("Unable to copy the link.");
    }
  };

  /**
   * Exports the playlist's *full* contents, not the page that happens to be loaded.
   *
   * A playlist page loads incrementally, so exporting what is on screen would silently
   * truncate a long playlist — the one thing a backup must never do.
   */
  const exportSelectedPlaylist = async () => {
    if (!playlist || isSaving) return;
    const target = playlist;
    setPosition(null);
    setIsSaving(true);
    showPersistentToast("Preparing export...");

    try {
      const tracks = await libraryController.getPlaylistTracks(target);
      const result = await exportPlaylist(target, tracks);
      if (!result) {
        setToast(null);
        return;
      }
      showToast(
        result.format === "m3u" && result.written < tracks.length
          ? `Exported ${result.written} of ${tracks.length} — M3U only holds local files`
          : `Exported ${result.written} songs`,
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Unable to export this playlist.");
    } finally {
      setIsSaving(false);
    }
  };

  const submitRename = async () => {
    if (!playlist || renameDraft === null) return;
    const trimmed = renameDraft.trim();
    if (!trimmed || trimmed === playlist.title) {
      setRenameDraft(null);
      setPosition(null);
      return;
    }

    setRenameDraft(null);
    setPosition(null);
    try {
      await libraryController.renamePlaylist(playlist, trimmed);
      showToast(`Renamed to ${trimmed}`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Unable to rename this playlist.");
    }
  };

  const deleteSelectedPlaylist = async () => {
    if (!playlist) return;
    const target = playlist;
    setConfirmDelete(false);
    setPosition(null);
    try {
      await libraryController.deletePlaylist(target);
      showToast(`Deleted ${target.title}`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Unable to delete this playlist.");
    }
  };

  /* Same reasoning as TrackContextMenuProvider: this wraps the app, so a fresh value object
     would re-render every consumer each time the menu's own state moved. */
  const handlersRef = useRef({ openPlaylistMenu, openAlbumMenu });
  handlersRef.current = { openPlaylistMenu, openAlbumMenu };

  const contextValue = useMemo<PlaylistContextMenuValue>(
    () => ({
      openPlaylistMenu: (event, playlist) => handlersRef.current.openPlaylistMenu(event, playlist),
      openAlbumMenu: (event, album) => handlersRef.current.openAlbumMenu(event, album),
    }),
    [],
  );

  return (
    <PlaylistContext.Provider value={contextValue}>
      {children}
      {position && (album || playlist) && (
        <div
          ref={menuRef}
          className="fixed z-50 flex min-w-56 flex-col gap-0.5 rounded-xl bg-popover/95 p-1.5 shadow-2xl backdrop-blur"
          style={{ left: position.x, top: position.y }}
          role="menu"
          onMouseDown={(event) => event.stopPropagation()}
        >
          {renameDraft !== null ? (
            <div className="flex flex-col gap-2 p-1">
              <span className="text-xs font-medium text-muted-foreground">Rename playlist</span>
              <input
                ref={renameInputRef}
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitRename();
                  if (event.key === "Escape") setRenameDraft(null);
                }}
                aria-label="Playlist name"
                className="w-full min-w-0 rounded-lg bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-inset focus:ring-border"
              />
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  className="rounded-full px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setRenameDraft(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-transform hover:scale-[1.02] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => void submitRename()}
                >
                  Save
                </button>
              </div>
            </div>
          ) : (
          <>
          {album && (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-card disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => void copyAlbumUrl()}
            >
              <CopyIcon size={18} />
              <span>Copy album URL</span>
            </button>
          )}
          {canCopyPlaylistUrl && (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-card disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => void copyPlaylistUrl()}
            >
              <CopyIcon size={18} />
              <span>Copy playlist URL</span>
            </button>
          )}
          {canEditPlaylist && (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-card disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => setRenameDraft(playlist?.title ?? "")}
            >
              <PencilIcon size={18} />
              <span>Rename</span>
            </button>
          )}
          {playlist && (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-card disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => void exportSelectedPlaylist()}
            >
              <DownloadIcon size={18} />
              <span>Export playlist</span>
            </button>
          )}
          {canEditPlaylist && (
            /* Two-step, in place: the second press is the confirmation, so a destructive
               action never happens on one click and never costs a modal either. */
            <button
              type="button"
              role="menuitem"
              className={cn(
                "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                confirmDelete
                  ? "bg-destructive/10 text-destructive"
                  : "text-foreground hover:bg-card",
              )}
              onClick={() => {
                if (confirmDelete) {
                  void deleteSelectedPlaylist();
                  return;
                }
                setConfirmDelete(true);
              }}
            >
              <TrashIcon size={18} />
              <span>
                {confirmDelete
                  ? "Tap again to delete"
                  : isLocalPlaylistMenu
                    ? "Delete local playlist"
                    : "Delete playlist"}
              </span>
            </button>
          )}
          {album && (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-foreground transition-colors hover:bg-card disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() => void toggleAlbumSaved()}
            >
              {isSaved ? <BookmarkActiveIcon size={18} /> : <BookmarkIcon size={18} />}
              <span>{isSaved ? "Remove from library" : "Save to library"}</span>
            </button>
          )}
          </>
          )}
        </div>
      )}
      {toast && (
        <div className="fixed bottom-28 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-full bg-popover/95 px-4 py-2 text-sm text-foreground shadow-2xl backdrop-blur" role="status">
          {isSaving ? (
            <Loader variant="spinner" size={18} />
          ) : (toast.startsWith("Saved ") || toast.startsWith("Removed ") || toast === "Url copied to clipboard" || toast === "Local playlist deleted") && (
            <CheckIcon size={18} aria-hidden="true" />
          )}
          <span>{toast}</span>
        </div>
      )}
    </PlaylistContext.Provider>
  );
}
