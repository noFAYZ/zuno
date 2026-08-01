import { useState, useRef, useEffect, useMemo, useSyncExternalStore, type ReactElement,
} from "react";
import { motion } from "motion/react";
import {
  LIBRARY_SORTS,
  canReorderLibrary,
  filterLibraryEntries,
  reorderBlockedReason,
  sortLibraryEntries,
  type LibrarySort,
} from "./sidebarLibrary";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/motion/tooltip";
import { FloatingPanel } from "./FloatingPanel";
import { GoogleSignInButton } from "./GoogleSignInButton";
import { importPlaylistFile } from "../../player/playlistTransfer";
import { isLikedSongsId, likedSongsCover } from "../likedSongsArtwork";
import {
  AlbumIcon,
  CheckIcon,
  CloseIcon,
  FolderIcon,
  PlaylistIcon,
  RefreshIcon,
  SearchIcon,
  SortIcon,
} from "@/ui/icons";
import type { Album, Playlist } from "../../datasource/types";
import { libraryController, useLibraryState } from "../../player/playerStore";
import {
  getRecentPlaylistTimestamp,
  subscribeToRecentPlaylists,
} from "../../player/recentPlaylists";
import {
  addLocalPlaylistPath,
  getLocalPlaylistItems,
  subscribeToLocalPlaylists,
} from "../../player/localPlaylists";
import { getAppSetting, setAppSetting } from "../../internal/appSettings";
import { resolveSidebarWidth, useSidebarMode } from "../settings/sidebarMode";
import { ArtistLinks } from "./ArtistLinks";
import { TrackArtwork } from "./TrackArtwork";
import { usePlaylistContextMenu } from "./PlaylistContextMenu";
import { Button } from "@/components/motion/button";
import { AddCircleIcon } from "@solar-icons/react/bold-duotone";
 
const PLAYLIST_ORDER_KEY = "ytc-sidebar-playlist-order";
const ALBUM_ORDER_KEY = "ytc-sidebar-album-order";
const PLAYLIST_LIKED_ORDER_MIGRATION_KEY = "ytc-sidebar-playlist-liked-order-v1";
const ALBUM_LIKED_ORDER_MIGRATION_KEY = "ytc-sidebar-album-liked-order-v1";
const LIBRARY_SORT_KEY = "zuno:sidebar-library-sort";

function loadOrderFromStorage(key: string, migrationKey: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const order = Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
    if (order.includes("LM") && localStorage.getItem(migrationKey) !== "true") {
      const migratedOrder = ["LM", ...order.filter((id) => id !== "LM")];
      localStorage.setItem(key, JSON.stringify(migratedOrder));
      localStorage.setItem(migrationKey, "true");
      return migratedOrder;
    }
    return order;
  } catch {
    return [];
  }
}

function saveOrderToStorage(key: string, order: string[], migrationKey?: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, JSON.stringify(order));
    if (migrationKey) localStorage.setItem(migrationKey, "true");
  } catch {
    // ignore storage failures
  }
  void setAppSetting(key, order);
  if (migrationKey) void setAppSetting(migrationKey, true);
}

function isStoredOrder(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function reorderIds(ids: string[], draggedId: string, targetId: string, insertAfter: boolean) {
  const nextIds = ids.filter((id) => id !== draggedId);
  const targetIndex = nextIds.indexOf(targetId);
  if (targetIndex < 0) return ids;
  const insertIndex = targetIndex + (insertAfter ? 1 : 0);
  nextIds.splice(insertIndex, 0, draggedId);
  return nextIds;
}

function mergeVisibleOrderWithStoredOrder(storedOrder: string[], visibleOrder: string[]) {
  if (!storedOrder.length) return visibleOrder;

  const visibleIds = new Set(visibleOrder);
  const hiddenIds = storedOrder.filter((id) => !visibleIds.has(id));
  const nextOrder = [...storedOrder];
  let visibleIndex = 0;

  for (let index = 0; index < nextOrder.length && visibleIndex < visibleOrder.length; index += 1) {
    if (hiddenIds.includes(nextOrder[index])) continue;
    nextOrder[index] = visibleOrder[visibleIndex];
    visibleIndex += 1;
  }

  return [
    ...nextOrder,
    ...visibleOrder.slice(visibleIndex),
  ].filter((id, index, ids) => ids.indexOf(id) === index);
}

interface SidebarProps {
  width: number;
  /** Retained for the callers' benefit; the rail no longer resizes, so it is unused. */
  onWidthChange: (width: number) => void;
  onNavigateAlbum: (album: Album) => void;
  onNavigatePlaylist: (playlist: Playlist) => void;
}

/**
 * Hover label for a collapsed sidebar row.
 *
 * The rail shows artwork only, so the name has to come from somewhere; a native `title`
 * attribute was doing that job, but it is slow to appear, unstyled, and cannot show the
 * owner on a second line. Renders its child untouched when the rail is wide enough to
 * display the text itself, so the wrapper costs nothing in that case.
 */
function SidebarItemTooltip({
  enabled,
  title,
  subtitle,
  children,
}: {
  enabled: boolean;
  title: string;
  subtitle?: string;
  children: ReactElement;
}) {
  if (!enabled) return children;

  return (
    <Tooltip
      side="right"
      delay={20}
      wrapperClassName="block"
      className="bg-muted   border border-border"
      content={
        <span className="flex max-w-56 flex-col gap-0.5 text-left  ">
          <span className="truncate font-medium text-foreground text-sm ">{title}</span>
          {subtitle ? (
            <span className="truncate text-xs   text-muted-foreground">{subtitle}</span>
          ) : null}
        </span>
      }
    >
      {children}
    </Tooltip>
  );
}

const COLLAPSED_WIDTH = 100;
const TEXT_HIDE_THRESHOLD = 120;

type LibraryView = "albums" | "playlists";
const EMPTY_STATE =
  "flex flex-col items-center gap-2 px-3 py-8 text-center text-sm text-muted-foreground";
const RETRY_BUTTON =
  "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** Square 40px artwork tile shared by both sidebar lists. */
/**
 * Creates a local playlist from the sidebar rail.
 *
 * Local playlists could previously only be made from Settings, which is a strange place to
 * look for "new playlist" — this puts it where the playlists are. Opens to the right because
 * the rail is 72px wide and a panel below would be clipped by the window edge.
 */
function CreatePlaylistButton({
  collapsed,
  canCreateRemote,
  onCreated,
  onOpenChange,
}: {
  collapsed: boolean;
  /** Signed in, so a YouTube Music playlist is a real option. */
  canCreateRemote: boolean;
  onCreated: (playlist: Playlist) => void;
  /**
   * Reported upward so the rail can stay expanded while this is open.
   *
   * The panel is portalled outside the sidebar, so moving the pointer into it counts as leaving
   * the rail — which would collapse it mid-typing and, since the panel is only rendered when
   * expanded, take the form away with it.
   */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * Defaults to YouTube Music whenever that is possible. A local playlist is the narrower
   * choice — it cannot hold anything you have not downloaded — so it should be the one you
   * opt into, not the one you get by default.
   */
  const [destination, setDestination] = useState<"youtube" | "local">(
    canCreateRemote ? "youtube" : "local",
  );
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!canCreateRemote) setDestination("local");
  }, [canCreateRemote]);

  // Focus the field once the panel has finished unfolding, not while it animates.
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 160);
    return () => window.clearTimeout(timer);
  }, [open]);

  /**
   * Creates a playlist from a file and fills it.
   *
   * The name comes from the file, so import is one step rather than "choose a file, then name
   * the thing you just chose". Local imports go to a local playlist because their tracks are
   * paths — sending those to YouTube would create an empty playlist.
   */
  const importFromFile = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const imported = await importPlaylistFile();
      if (!imported) return;

      const isLocalImport = imported.tracks.every((track) => Boolean(track.localPath));
      const created = await libraryController.createPlaylist(imported.title, {
        local: isLocalImport || !canCreateRemote,
      });

      if (isLocalImport) {
        for (const track of imported.tracks) {
          if (track.localPath) addLocalPlaylistPath(created.id, track.localPath);
        }
      } else {
        await libraryController.addTracksToPlaylist(imported.tracks, created);
      }

      setOpen(false);
      onCreated(created);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not import that playlist.");
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Give the playlist a name.");
      inputRef.current?.focus();
      return;
    }
    if (busy) return;

    setBusy(true);
    try {
      const created = await libraryController.createPlaylist(trimmed, {
        local: destination === "local",
      });
      setName("");
      setError(null);
      setOpen(false);
      onCreated(created);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the playlist.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <FloatingPanel
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
        if (!next) setError(null);
      }}
      className="w-64"
      trigger={
        <Button
          type="button"
          aria-label="New playlist"
          size="icon"
          variant="ghost"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className={cn(
            /*
             * Dashed outline rather than a filled pill. It is an *affordance to create*, not a
             * destination, and as a solid block it was the loudest element in a rail whose
             * whole job is to show your playlists. The dashed edge is the long-standing
             * convention for "add one of these" and reads that way at 36px with no label.
             */
            "my-2 flex shrink-0 items-center justify-center gap-2 rounded-xl border border-dashed transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            /*
             * `w-auto` is load-bearing when expanded: size="icon" pins the button to `h-8 w-8`,
             * and without releasing the width it stays a square regardless of the flex parent's
             * stretch. Released, it fills the rail minus its own margins.
             */
            collapsed ? "mx-auto size-9" : "mx-2 h-9 w-auto px-3 text-sm font-medium",
            open
              ? "border-primary bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:border-muted-foreground hover:text-foreground",
          )}
        >
          <AddCircleIcon size={18} aria-hidden="true" />
          {!collapsed && <span>New playlist</span>}
        </Button>
      }
    >
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-foreground">New playlist</span>

        {/* Segmented control rather than a checkbox: these are two destinations, not a
            modifier, and the description below changes with the choice so the consequence is
            visible before you commit. */}
        {canCreateRemote ? (
          <div
            className="mt-0.5 flex rounded-lg bg-card p-0.5"
            role="radiogroup"
            aria-label="Where to create the playlist"
          >
            {(["youtube", "local"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={destination === value}
                onClick={() => setDestination(value)}
                className={cn(
                  "flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  destination === value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {value === "youtube" ? "YouTube Music" : "This computer"}
              </button>
            ))}
          </div>
        ) : null}

        <span className="text-xs text-muted-foreground">
          {destination === "youtube"
            ? "Saved to your account, so it syncs everywhere."
            : "Built from folders on this computer."}
        </span>
        <input
          ref={inputRef}
          className="mt-1 w-full min-w-0 rounded-lg bg-background px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-inset focus:ring-border"
          value={name}
          placeholder="Playlist name"
          aria-label="Playlist name"
          onChange={(event) => {
            setName(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") void submit();
            if (event.key === "Escape") setOpen(false);
          }}
        />
        {error ? <span className="text-xs text-destructive">{error}</span> : null}
        <button
          type="button"
          className="mt-1 rounded-full bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-transform hover:scale-[1.02] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? "Creating..." : "Create playlist"}
        </button>

        <button
          type="button"
          disabled={busy}
          className="rounded-full px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => void importFromFile()}
        >
          Import from file...
        </button>
      </div>
    </FloatingPanel>
  );
}

/** The list filter's options. One place to add a third without touching the markup. */
const LIBRARY_VIEWS: Array<{
  value: "playlists" | "albums";
  label: string;
  hint: string;
  icon: typeof PlaylistIcon;
}> = [
  { value: "playlists", label: "Playlists", hint: "Your playlists", icon: PlaylistIcon },
  { value: "albums", label: "Albums", hint: "Saved albums", icon: AlbumIcon },
];

const ARTWORK_TILE = "size-10 shrink-0 rounded object-cover";
const ARTWORK_TILE_PX = 40;
const ARTWORK_FALLBACK =
  "flex size-10 shrink-0 items-center justify-center rounded bg-card text-muted-foreground";

function SidebarAlbumArtwork({ album }: { album: Album }) {
  if (isLikedSongsId(album.id)) {
    return <img className={ARTWORK_TILE} src={likedSongsCover} alt="" />;
  }

  return (
    <TrackArtwork
      className={ARTWORK_TILE}
      size={ARTWORK_TILE_PX}
      artworkUrl={album.artworkUrl}
      iconSize={24}
      variant="album"
    />
  );
}


function SidebarPlaylistArtwork({ playlist }: { playlist: Playlist }) {
  if (isLikedSongsId(playlist.id, playlist.kind)) {
    return <img className={ARTWORK_TILE} src={likedSongsCover} alt="" />;
  }

  if (playlist.kind === "local") {
    return (
      <div className={ARTWORK_FALLBACK}>
        <FolderIcon size={22} aria-hidden="true" />
      </div>
    );
  }

  return (
    <TrackArtwork
      className={ARTWORK_TILE}
      size={ARTWORK_TILE_PX}
      artworkUrl={playlist.artworkUrl}
      iconSize={24}
      retryOnError
      variant="playlist"
    />
  );
}

export function Sidebar({
  width,
  onWidthChange,
  onNavigateAlbum,
  onNavigatePlaylist,
}: SidebarProps) {
  const libraryState = useLibraryState();
  const { openPlaylistMenu, openAlbumMenu } = usePlaylistContextMenu();
  const [libraryView, setLibraryView] = useState<LibraryView>("playlists");
  const [recentPlaylistsRevision, setRecentPlaylistsRevision] = useState(0);
  const [playlistOrder, setPlaylistOrder] = useState<string[]>(() =>
    loadOrderFromStorage(PLAYLIST_ORDER_KEY, PLAYLIST_LIKED_ORDER_MIGRATION_KEY)
  );
  const [albumOrder, setAlbumOrder] = useState<string[]>(() =>
    loadOrderFromStorage(ALBUM_ORDER_KEY, ALBUM_LIKED_ORDER_MIGRATION_KEY)
  );
  const [libraryFilter, setLibraryFilter] = useState("");
  const [librarySort, setLibrarySort] = useState<LibrarySort>(() => {
    try {
      const stored = localStorage.getItem(LIBRARY_SORT_KEY);
      return stored === "recent" || stored === "name" ? stored : "custom";
    } catch {
      return "custom";
    }
  });
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false);
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  const [draggedItem, setDraggedItem] = useState<{ id: string; type: LibraryView } | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; type: LibraryView; insertAfter: boolean } | null>(null);
  const localPlaylists = useSyncExternalStore(
    subscribeToLocalPlaylists,
    getLocalPlaylistItems,
    getLocalPlaylistItems,
  );
  const sidebarRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const draggedElementRef = useRef<HTMLElement | null>(null);
  const dragTranslationRef = useRef(0);
  const pointerDragRef = useRef<{
    pointerId: number;
    itemId: string;
    itemType: LibraryView;
    startX: number;
    startY: number;
    isDragging: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);


  /*
   * The rail owns its own width now, derived from the mode rather than read from the `width`
   * prop. The prop stays the source of truth for everyone else — the title bar sizes its home
   * button to match — so the resolved width is reported upward rather than taken from there.
   */
  const sidebarMode = useSidebarMode();
  const [isSidebarHovered, setIsSidebarHovered] = useState(false);
  const [isCreatePanelOpen, setIsCreatePanelOpen] = useState(false);
  /*
   * An open popover holds the rail open regardless of the pointer.
   *
   * Both panels are portalled out of the sidebar, so moving into one reads as leaving the rail.
   * Tracking the pointer alone would collapse it while the user is typing a playlist name — and
   * because these controls only render when expanded, collapsing unmounts the thing being used.
   */
  const isExpansionHeld = isSidebarHovered || isCreatePanelOpen || isSortMenuOpen;
  const effectiveWidth = resolveSidebarWidth(sidebarMode, isExpansionHeld);

  useEffect(() => {
    if (width !== effectiveWidth) onWidthChange(effectiveWidth);
  }, [effectiveWidth, onWidthChange, width]);

  const isCollapsed = effectiveWidth <= COLLAPSED_WIDTH;
  const shouldHideText = effectiveWidth <= TEXT_HIDE_THRESHOLD;
  const hasUserCreatedPlaylists = (libraryState.library?.playlists.length ?? 0) + localPlaylists.length > 0;
  const hasLoadedLibrary = Boolean(libraryState.library);
  const showPlaylistRetry =
    libraryView === "playlists" &&
    libraryState.status !== "signed-out" &&
    (hasLoadedLibrary || libraryState.status === "error") &&
    !hasUserCreatedPlaylists;
  const isRetryingPlaylists = libraryState.status === "loading";

  useEffect(() => {
    let active = true;

    const hydrateOrder = async (
      key: string,
      apply: (order: string[]) => void,
    ) => {
      const stored = await getAppSetting<unknown>(key);
      if (!active || !isStoredOrder(stored)) return;

      try {
        localStorage.setItem(key, JSON.stringify(stored));
      } catch {
        // The React state below still restores the order for this session.
      }
      apply(stored);
    };

    void hydrateOrder(PLAYLIST_ORDER_KEY, setPlaylistOrder);
    void hydrateOrder(ALBUM_ORDER_KEY, setAlbumOrder);

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (localStorage.getItem(PLAYLIST_LIKED_ORDER_MIGRATION_KEY) !== "true") {
      setPlaylistOrder((current) => {
        if (!current.includes("LM")) return current;
        const migrated = ["LM", ...current.filter((id) => id !== "LM")];
        saveOrderToStorage(
          PLAYLIST_ORDER_KEY,
          migrated,
          PLAYLIST_LIKED_ORDER_MIGRATION_KEY,
        );
        return migrated;
      });
    }

    if (localStorage.getItem(ALBUM_LIKED_ORDER_MIGRATION_KEY) !== "true") {
      setAlbumOrder((current) => {
        if (!current.includes("LM")) return current;
        const migrated = ["LM", ...current.filter((id) => id !== "LM")];
        saveOrderToStorage(
          ALBUM_ORDER_KEY,
          migrated,
          ALBUM_LIKED_ORDER_MIGRATION_KEY,
        );
        return migrated;
      });
    }
  }, []);

  const playlists = useMemo(() => {
    const likedSongsPlaylist = libraryState.library?.likedSongsPlaylist;
    const remotePlaylists = libraryState.library?.playlists ?? [];
    const libraryPlaylists = likedSongsPlaylist
      ? [likedSongsPlaylist, ...localPlaylists, ...remotePlaylists]
      : [...localPlaylists, ...remotePlaylists];
    if (!libraryPlaylists.length) return [];

    const playlistById = new Map(libraryPlaylists.map((playlist) => [playlist.id, playlist]));
    const availableIds = new Set(libraryPlaylists.map((playlist) => playlist.id));
    const savedIds = playlistOrder.filter((id) => availableIds.has(id));

    if (savedIds.length) {
      const missingIds = libraryPlaylists
        .map((playlist) => playlist.id)
        .filter((id) => !savedIds.includes(id));
      const orderedIds = likedSongsPlaylist && !savedIds.includes(likedSongsPlaylist.id)
        ? [likedSongsPlaylist.id, ...savedIds, ...missingIds.filter((id) => id !== likedSongsPlaylist.id)]
        : [...savedIds, ...missingIds];
      return orderedIds
        .map((id) => playlistById.get(id))
        .filter((playlist): playlist is Playlist => Boolean(playlist));
    }

    const defaultPlaylists = libraryPlaylists
      .filter((playlist) => playlist.id !== likedSongsPlaylist?.id && playlist.kind !== "local")
      .map((playlist, libraryIndex) => ({
        playlist,
        libraryIndex,
        playedAt: getRecentPlaylistTimestamp(playlist.id),
      }))
      .sort((left, right) =>
        right.playedAt - left.playedAt || left.libraryIndex - right.libraryIndex
      )
      .map(({ playlist }) => playlist);
    return likedSongsPlaylist
      ? [likedSongsPlaylist, ...localPlaylists, ...defaultPlaylists]
      : [...localPlaylists, ...defaultPlaylists];
  }, [
    libraryState.library?.likedSongsPlaylist,
    libraryState.library?.playlists,
    localPlaylists,
    playlistOrder,
    recentPlaylistsRevision,
  ]);

  /*
   * Filter and sort are applied *after* the saved custom order has been resolved above, never
   * instead of it — `custom` is the identity sort, so switching back to it restores exactly the
   * arrangement the user dragged into place rather than an approximation of it.
   */
  const visiblePlaylists = useMemo(
    () =>
      sortLibraryEntries(
        filterLibraryEntries(
          playlists.map((playlist) => ({ ...playlist, subtitle: playlist.owner })),
          libraryFilter,
        ),
        librarySort,
        {
          recencyOf: getRecentPlaylistTimestamp,
          pinnedId: libraryState.library?.likedSongsPlaylist?.id,
        },
      ),
    [
      playlists,
      libraryFilter,
      librarySort,
      recentPlaylistsRevision,
      libraryState.library?.likedSongsPlaylist?.id,
    ],
  );

  const albums = useMemo(() => {
    const likedSongsPlaylist = libraryState.library?.likedSongsPlaylist;
    const likedSongsAlbum: Album | null = likedSongsPlaylist
      ? {
          id: likedSongsPlaylist.id,
          title: "Liked Songs",
          artist: likedSongsPlaylist.owner,
          artworkUrl: likedSongsPlaylist.artworkUrl,
        }
      : null;
    const libraryAlbums = likedSongsAlbum
      ? [likedSongsAlbum, ...(libraryState.library?.albums ?? [])]
      : libraryState.library?.albums ?? [];
    if (!libraryAlbums.length) return [];

    const albumById = new Map(libraryAlbums.map((album) => [album.id, album]));
    const availableIds = new Set(libraryAlbums.map((album) => album.id));
    const savedIds = albumOrder.filter((id) => availableIds.has(id));

    if (savedIds.length) {
      const missingIds = libraryAlbums
        .map((album) => album.id)
        .filter((id) => !savedIds.includes(id));
      const orderedIds = likedSongsAlbum && !savedIds.includes(likedSongsAlbum.id)
        ? [likedSongsAlbum.id, ...savedIds, ...missingIds.filter((id) => id !== likedSongsAlbum.id)]
        : [...savedIds, ...missingIds];
      return orderedIds
        .map((id) => albumById.get(id))
        .filter((album): album is Album => Boolean(album));
    }

    return libraryAlbums;
  }, [
    libraryState.library?.likedSongsPlaylist,
    libraryState.library?.albums,
    albumOrder,
  ]);

  useEffect(
    () => subscribeToRecentPlaylists(
      () => setRecentPlaylistsRevision((revision) => revision + 1),
    ),
    [],
  );

  useEffect(() => {
    if (!libraryState.library && !localPlaylists.length) return;
    if (!libraryState.library) {
      if (playlistOrder.length === 0) return;

      const localPlaylistIds = localPlaylists.map((playlist) => playlist.id);
      const normalized = [
        ...playlistOrder,
        ...localPlaylistIds.filter((id) => !playlistOrder.includes(id)),
      ].filter((id, index, ids) => ids.indexOf(id) === index);

      if (
        normalized.length !== playlistOrder.length ||
        normalized.some((id, index) => id !== playlistOrder[index])
      ) {
        setPlaylistOrder(normalized);
        saveOrderToStorage(
          PLAYLIST_ORDER_KEY,
          normalized,
          PLAYLIST_LIKED_ORDER_MIGRATION_KEY,
        );
      }
      return;
    }

    const playlistIds = [
      libraryState.library.likedSongsPlaylist.id,
      ...localPlaylists.map((playlist) => playlist.id),
      ...libraryState.library.playlists.map((playlist) => playlist.id),
    ];
    if (playlistOrder.length > 0) {
      const normalized = [
        ...(playlistOrder.includes("LM") ? [] : ["LM"]),
        ...playlistOrder.filter((id) => playlistIds.includes(id)),
        ...playlistIds.filter((id) => !playlistOrder.includes(id)),
      ].filter((id, index, ids) => ids.indexOf(id) === index);
      if (
        normalized.length !== playlistOrder.length ||
        normalized.some((id, index) => id !== playlistOrder[index])
      ) {
        setPlaylistOrder(normalized);
        saveOrderToStorage(
          PLAYLIST_ORDER_KEY,
          normalized,
          PLAYLIST_LIKED_ORDER_MIGRATION_KEY,
        );
      }
    }
  }, [
    libraryState.library?.likedSongsPlaylist,
    libraryState.library?.playlists,
    localPlaylists,
    playlistOrder,
  ]);

  useEffect(() => {
    if (!libraryState.library) return;
    const albumIds = [
      libraryState.library.likedSongsPlaylist.id,
      ...libraryState.library.albums.map((album) => album.id),
    ];
    if (albumOrder.length > 0) {
      const normalized = [
        ...(albumOrder.includes("LM") ? [] : ["LM"]),
        ...albumOrder.filter((id) => albumIds.includes(id)),
        ...albumIds.filter((id) => !albumOrder.includes(id)),
      ].filter((id, index, ids) => ids.indexOf(id) === index);
      if (
        normalized.length !== albumOrder.length ||
        normalized.some((id, index) => id !== albumOrder[index])
      ) {
        setAlbumOrder(normalized);
        saveOrderToStorage(
          ALBUM_ORDER_KEY,
          normalized,
          ALBUM_LIKED_ORDER_MIGRATION_KEY,
        );
      }
    }
  }, [
    libraryState.library?.likedSongsPlaylist,
    libraryState.library?.albums,
    albumOrder,
  ]);

  const visibleAlbums = useMemo(
    () =>
      sortLibraryEntries(
        filterLibraryEntries(
          albums.map((album) => ({ ...album, subtitle: album.artist })),
          libraryFilter,
        ),
        librarySort,
        { pinnedId: libraryState.library?.likedSongsPlaylist?.id },
      ),
    [albums, libraryFilter, librarySort, libraryState.library?.likedSongsPlaylist?.id],
  );

  useEffect(() => {
    try {
      localStorage.setItem(LIBRARY_SORT_KEY, librarySort);
    } catch {
      // Sort preference is a convenience; losing it is not worth failing a render over.
    }
  }, [librarySort]);

  /*
   * The filter is scoped to the list you are looking at, so switching views clears it. Carrying
   * "daft" across to Albums and showing an empty rail reads as a bug, not as a filter.
   */
  useEffect(() => {
    setLibraryFilter("");
  }, [libraryView]);

  const playlistsRef = useRef<string[]>([]);
  const albumsRef = useRef<string[]>([]);

  /*
   * The *rendered* lists, not the raw ones. A drop is expressed as "after the row I dropped
   * onto", so it can only be resolved against the order actually on screen — reading the
   * unfiltered list here would place the row relative to something the user cannot see.
   * Dragging is confined to the unfiltered custom order anyway, so in practice these agree;
   * taking them from the rendered list is what keeps that true if the guard ever changes.
   */
  useEffect(() => {
    playlistsRef.current = visiblePlaylists.map((playlist) => playlist.id);
  }, [visiblePlaylists]);

  useEffect(() => {
    albumsRef.current = visibleAlbums.map((album) => album.id);
  }, [visibleAlbums]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

      if (!drag.isDragging) {
        const distance = Math.hypot(
          event.clientX - drag.startX,
          event.clientY - drag.startY,
        );
        if (distance < 6) return;

        drag.isDragging = true;
        setDraggedItem({ id: drag.itemId, type: drag.itemType });
      }

      const translationY = event.clientY - drag.startY;
      dragTranslationRef.current = translationY;
      if (draggedElementRef.current) {
        draggedElementRef.current.style.setProperty("--drag-translation", `${translationY}px`);
      }
      event.preventDefault();
      const pointerCandidates = document
        .elementsFromPoint(event.clientX, event.clientY)
        .map((element) => element.closest<HTMLElement>("[data-sidebar-item-id]"))
        .filter((candidate): candidate is HTMLElement => Boolean(candidate))
        .filter((candidate) =>
          candidate.dataset.sidebarItemId !== drag.itemId &&
          candidate.dataset.sidebarItemType === drag.itemType,
        );

      const uniqueCandidates = Array.from(
        new Map(pointerCandidates.map((item) => [item.dataset.sidebarItemId, item])).values(),
      );

      let targetElement = uniqueCandidates.length
        ? uniqueCandidates.reduce<HTMLElement | null>((closestSoFar, item) => {
            const itemRect = item.getBoundingClientRect();
            const centerY = itemRect.top + itemRect.height / 2;
            if (!closestSoFar) return item;
            const closestRect = closestSoFar.getBoundingClientRect();
            const closestCenterY = closestRect.top + closestRect.height / 2;
            return Math.abs(centerY - event.clientY) < Math.abs(closestCenterY - event.clientY)
              ? item
              : closestSoFar;
          }, null)
        : null;

      if (listRef.current) {
        const listRect = listRef.current.getBoundingClientRect();
        const items = Array.from(
          listRef.current.querySelectorAll<HTMLElement>("[data-sidebar-item-id]")
        ).filter((item) =>
          item.dataset.sidebarItemId !== drag.itemId &&
          item.dataset.sidebarItemType === drag.itemType,
        );

        if (event.clientY < listRect.top && items.length) {
          targetElement = items[0];
        } else if (event.clientY > listRect.bottom && items.length) {
          targetElement = items[items.length - 1];
        } else if (!targetElement && event.clientY >= listRect.top && event.clientY <= listRect.bottom && items.length) {
          targetElement = items.reduce<HTMLElement | null>((closestSoFar, item) => {
            const itemRect = item.getBoundingClientRect();
            const centerY = itemRect.top + itemRect.height / 2;
            if (!closestSoFar) return item;
            const closestRect = closestSoFar.getBoundingClientRect();
            const closestCenterY = closestRect.top + closestRect.height / 2;
            return Math.abs(centerY - event.clientY) < Math.abs(closestCenterY - event.clientY)
              ? item
              : closestSoFar;
          }, null);
        }
      }

      if (!targetElement) {
        setDropTarget(null);
        return;
      }

      const targetId = targetElement.dataset.sidebarItemId;
      const targetType = targetElement.dataset.sidebarItemType as LibraryView | undefined;
      if (!targetId || !targetType || targetId === drag.itemId || targetType !== drag.itemType) {
        setDropTarget(null);
        return;
      }

      const bounds = targetElement.getBoundingClientRect();
      setDropTarget({
        id: targetId,
        type: targetType,
        insertAfter: event.clientY >= bounds.top + bounds.height / 2,
      });
    };

    const handlePointerUp = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

      if (drag.isDragging && dropTarget && dropTarget.type === drag.itemType && dropTarget.id !== drag.itemId) {
        const currentIds =
          drag.itemType === "playlists" ? playlistsRef.current : albumsRef.current;
        const nextOrder = reorderIds(
          currentIds,
          drag.itemId,
          dropTarget.id,
          dropTarget.insertAfter,
        );

        if (drag.itemType === "playlists") {
          const nextPlaylistOrder = mergeVisibleOrderWithStoredOrder(
            playlistOrder,
            nextOrder,
          );
          setPlaylistOrder(nextPlaylistOrder);
          saveOrderToStorage(
            PLAYLIST_ORDER_KEY,
            nextPlaylistOrder,
            PLAYLIST_LIKED_ORDER_MIGRATION_KEY,
          );
        } else {
          setAlbumOrder(nextOrder);
          saveOrderToStorage(
            ALBUM_ORDER_KEY,
            nextOrder,
            ALBUM_LIKED_ORDER_MIGRATION_KEY,
          );
        }

        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }

      pointerDragRef.current = null;
      if (draggedElementRef.current) {
        draggedElementRef.current.style.removeProperty("--drag-translation");
        draggedElementRef.current.releasePointerCapture?.(event.pointerId);
        draggedElementRef.current.style.removeProperty("will-change");
      }
      draggedElementRef.current = null;
      setDraggedItem(null);
      setDropTarget(null);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);

    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [dropTarget, playlistOrder]);

  const totalLibraryCount = libraryView === "albums" ? albums.length : playlists.length;
  const activeSortLabel =
    LIBRARY_SORTS.find((option) => option.value === librarySort)?.label ?? "Custom";
  const canReorder = canReorderLibrary(librarySort, libraryFilter);
  const reorderBlocked = reorderBlockedReason(librarySort, libraryFilter);

  const handleSidebarItemPointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
    itemId: string,
    itemType: LibraryView,
  ) => {
    if (event.button !== 0) return;
    /*
     * Reordering only means anything against the full list in its saved order. Starting a drag
     * from a filtered or alphabetised list would persist positions derived from a list that is
     * not the one being stored, quietly scrambling the sidebar later.
     */
    if (!canReorder) return;
    pointerDragRef.current = {
      pointerId: event.pointerId,
      itemId,
      itemType,
      startX: event.clientX,
      startY: event.clientY,
      isDragging: false,
    };
    draggedElementRef.current = event.currentTarget;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.style.willChange = "transform";
  };

  const handleSidebarItemClick = (callback: () => void) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    callback();
  };

  const handlePlaylistRetry = () => {
    if (isRetryingPlaylists) return;
    void libraryController.refresh();
  };

  const isDragActive = Boolean(draggedItem);

  const listClasses = cn(
    "flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-3",
    // Narrow sidebar tightens spacing before it drops labels entirely.
    isCollapsed ? "gap-0 px-1" : "gap-0.5 px-2",
    isDragActive && "select-none",
  );

  /** Row styling shared by album and playlist entries, including drop indicators. */
  const itemClasses = (
    id: string,
    type: "albums" | "playlists",
  ) => cn(
    "group relative flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
    "hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    shouldHideText && "justify-center px-0",
    draggedItem?.id === id && draggedItem.type === type && "opacity-40",
    dropTarget?.id === id && dropTarget.type === type && !dropTarget.insertAfter &&
      "before:absolute before:inset-x-2 before:-top-px before:h-0.5 before:rounded-full before:bg-primary",
    dropTarget?.id === id && dropTarget.type === type && dropTarget.insertAfter &&
      "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary",
  );

  return (
    <div
      ref={sidebarRef}
      className="relative flex min-h-0 shrink-0 flex-col bg-background transition-[width] duration-200 ease-out"
      style={{ width: `${effectiveWidth}px` }}
      onPointerEnter={(event) => {
        // Pointer only. A drag passing over the rail is not a request to expand it, and a
        // touch "hover" never ends, which would leave the rail stuck open.
        if (event.pointerType === "mouse") setIsSidebarHovered(true);
      }}
      onPointerLeave={() => setIsSidebarHovered(false)}
      // Keyboard users never fire pointerenter, so tabbing into the list widens it too —
      // otherwise the rail is permanently unreadable without a mouse.
      onFocusCapture={() => setIsSidebarHovered(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsSidebarHovered(false);
        }
      }}
    >
      {/*
        The resize grip is deliberately not rendered: the rail is a fixed icon strip and
        hovering an item explains it, so there is nothing to widen it for. `handleMouseDown`
        and the width plumbing are left intact so restoring it is a one-line change.
      */}

      <div className="flex min-h-0 flex-1 flex-col">
        {/*
          The list filter. Deliberately quieter than the destinations above: it does not
          change the page, only what the list below shows, and styling it identically was
          what made "Albums the destination" and "Albums the filter" indistinguishable.
        */}
        <div
          className={cn(
            "flex shrink-0 items-center gap-0.5 rounded-full bg-card/40 p-0.5 border border-border",
            shouldHideText ? "mx-auto flex-col" : "mx-2",
          )}
          role="group"
          aria-label="Library view"
        >
          {LIBRARY_VIEWS.map((view) => {
            const isActive = libraryView === view.value;
            return (
              <SidebarItemTooltip
                key={view.value}
                enabled={shouldHideText}
                title={view.label}
                subtitle={view.hint}
              >
                <button
                  type="button"
                  className={cn(
                    "relative flex items-center justify-center gap-1.5 rounded-full transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    shouldHideText ? "size-9" : "flex-1 px-2.5 py-1.5 text-xs font-medium",
                    isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                  aria-pressed={isActive}
                  aria-label={view.label}
                  onClick={() => setLibraryView(view.value)}
                >
                  {isActive && (
                    <motion.span
                      layoutId="sidebar-library-view"
                      transition={{ type: "spring", stiffness: 520, damping: 42 }}
                      /* `bg-card`, not `bg-background`: card is the lighter token in dark
                         mode and the darker one in light, so the active pill reads as raised
                         in both. Against `bg-background` it went *darker* than its own track
                         in dark mode, which reads as disabled rather than selected. */
                      className="absolute inset-0 -z-10 rounded-full bg-primary/10 shadow-sm ring-1 ring-inset ring-border/60"
                    />
                  )}
                  <view.icon size={16} aria-hidden="true" />
                  {!shouldHideText && <span>{view.label}</span>}
                </button>
              </SidebarItemTooltip>
            );
          })}
        </div>

        <CreatePlaylistButton
          canCreateRemote={libraryState.status === "ready"}
          collapsed={shouldHideText}
          onOpenChange={setIsCreatePanelOpen}
          onCreated={(playlist) => {
            setLibraryView("playlists");
            onNavigatePlaylist(playlist);
          }}
        />

        {/*
          Filter and sort. Hidden on the collapsed rail, where there is no room for a field and
          no labels to read anyway — the rail is for jumping between a handful of pinned
          favourites, not for searching.

          Worth having at all because the list is unbounded: a library with sixty playlists is
          ordinary, and scrolling a rail to find one by its artwork is not.
        */}
        {!shouldHideText && (totalLibraryCount > 0 || libraryFilter) && (
          <div className="flex shrink-0 items-center gap-1 px-2 pb-2">
            <div className="group/filter flex min-w-0 flex-1 items-center gap-1.5 rounded-full bg-white/[0.04] px-2.5 py-1 text-muted-foreground transition-colors focus-within:bg-white/[0.08] focus-within:text-foreground">
              <SearchIcon size={14} aria-hidden="true" />
              <input
                ref={filterInputRef}
                className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
                value={libraryFilter}
                onChange={(event) => setLibraryFilter(event.target.value)}
                onKeyDown={(event) => {
                  // Escape clears rather than blurs: an empty box you are still typing in is
                  // the state people expect, and blurring loses the caret for no reason.
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  event.stopPropagation();
                  setLibraryFilter("");
                }}
                placeholder={libraryView === "albums" ? "Filter albums" : "Filter playlists"}
                aria-label={libraryView === "albums" ? "Filter albums" : "Filter playlists"}
                type="text"
              />
              {libraryFilter && (
                <button
                  type="button"
                  className="shrink-0 rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    setLibraryFilter("");
                    filterInputRef.current?.focus();
                  }}
                  aria-label="Clear filter"
                >
                  <CloseIcon size={14} aria-hidden="true" />
                </button>
              )}
            </div>

            {/*
              The blocked reason rides on this tooltip because this is where someone goes to fix
              it — rows silently ceasing to be draggable, with no explanation anywhere, is the
              thing that would read as broken.
            */}
            <FloatingPanel
              open={isSortMenuOpen}
              onOpenChange={setIsSortMenuOpen}
              side="bottom"
              className="w-48 p-1"
              trigger={
                <Tooltip
                  side="bottom"
                  content={
                    reorderBlocked
                      ? `Sort: ${activeSortLabel} — ${reorderBlocked}`
                      : `Sort: ${activeSortLabel}`
                  }
                >
                  <button
                    type="button"
                    className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Sort order: ${activeSortLabel}`}
                    aria-haspopup="menu"
                  >
                    <SortIcon size={15} aria-hidden="true" />
                  </button>
                </Tooltip>
              }
            >
              <div role="menu" aria-label="Sort order">
                {LIBRARY_SORTS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={librarySort === option.value}
                    className={cn(
                      "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                      "hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      librarySort === option.value ? "text-foreground" : "text-muted-foreground",
                    )}
                    onClick={() => {
                      setLibrarySort(option.value);
                      setIsSortMenuOpen(false);
                    }}
                  >
                    <span className="mt-0.5 w-4 shrink-0">
                      {librarySort === option.value && (
                        <CheckIcon size={14} className="text-primary" aria-hidden="true" />
                      )}
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm">{option.label}</span>
                      <span className="text-xs text-muted-foreground">{option.hint}</span>
                    </span>
                  </button>
                ))}
              </div>
            </FloatingPanel>
          </div>
        )}


        <div ref={listRef} className={listClasses}>
          {libraryView === "albums" ? (
            visibleAlbums.map((album) => (
              <SidebarItemTooltip
                key={album.id}
                enabled={shouldHideText}
                title={album.title}
                subtitle={album.artist}
              >
              <button
                type="button"
                data-sidebar-item-id={album.id}
                data-sidebar-item-type="albums"
                className={itemClasses(album.id, "albums")}
                onPointerDown={(event) => handleSidebarItemPointerDown(event, album.id, "albums")}
                onClick={() => handleSidebarItemClick(() => {
                  if (album.id === "LM" && libraryState.library?.likedSongsPlaylist) {
                    onNavigatePlaylist(libraryState.library.likedSongsPlaylist);
                  } else {
                    onNavigateAlbum(album);
                  }
                })}
                onContextMenu={(event) => {
                  if (album.id === "LM" && libraryState.library?.likedSongsPlaylist) {
                    openPlaylistMenu(event, libraryState.library.likedSongsPlaylist);
                    return;
                  }
                  openAlbumMenu(event, album);
                }}
              >
                <SidebarAlbumArtwork album={album} />
                {!shouldHideText && (
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm text-foreground">{album.title}</span>
                    <ArtistLinks
                      className="truncate text-xs text-muted-foreground"
                      artists={album.artists}
                      fallback={album.artist}
                    />
                  </div>
                )}
              </button>
              </SidebarItemTooltip>
            ))
          ) : (
            visiblePlaylists.length ? (
              <>
                {visiblePlaylists.map((playlist) => (
                  <SidebarItemTooltip
                    key={playlist.id}
                    enabled={shouldHideText}
                    title={playlist.title}
                    subtitle={playlist.owner}
                  >
                  <button
                    type="button"
                    data-sidebar-item-id={playlist.id}
                    data-sidebar-item-type="playlists"
                    className={itemClasses(playlist.id, "playlists")}
                    onPointerDown={(event) => handleSidebarItemPointerDown(event, playlist.id, "playlists")}
                    onClick={() => handleSidebarItemClick(() => onNavigatePlaylist(playlist))}
                    onContextMenu={(event) => openPlaylistMenu(event, playlist)}
                  >
                    <SidebarPlaylistArtwork playlist={playlist} />
                    {!shouldHideText && (
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm text-foreground">{playlist.title}</span>
                        <span className="truncate text-xs text-muted-foreground">{playlist.owner}</span>
                      </div>
                    )}
                  </button>
                  </SidebarItemTooltip>
                ))}
                {showPlaylistRetry && (
                  <div className={EMPTY_STATE}>
                    <PlaylistIcon size={28} aria-hidden="true" />
                    {!shouldHideText && (
                      <span>No user-created playlists were found.</span>
                    )}
                    <button
                      type="button"
                      className={RETRY_BUTTON}
                      onClick={handlePlaylistRetry}
                      disabled={isRetryingPlaylists}
                      title="Retry playlist sync"
                      aria-label="Retry playlist sync"
                    >
                      <RefreshIcon size={15} aria-hidden="true" />
                      {!shouldHideText && (
                        <span>{isRetryingPlaylists ? "Retrying..." : "Retry"}</span>
                      )}
                    </button>
                  </div>
                )}
              </>
            ) : libraryFilter.trim() ? (
              /*
                A filter that matches nothing is a different situation from an empty library, and
                saying "no playlists were found" here would read as though they had vanished.
              */
              <div className={EMPTY_STATE}>
                <SearchIcon size={26} aria-hidden="true" />
                {!shouldHideText && (
                  <span>
                    Nothing matches “{libraryFilter.trim()}”.
                  </span>
                )}
                <button
                  type="button"
                  className={RETRY_BUTTON}
                  onClick={() => {
                    setLibraryFilter("");
                    filterInputRef.current?.focus();
                  }}
                >
                  <CloseIcon size={15} aria-hidden="true" />
                  {!shouldHideText && <span>Clear filter</span>}
                </button>
              </div>
            ) : (
              <div className={EMPTY_STATE}>
                <PlaylistIcon size={28} aria-hidden="true" />
                {!shouldHideText && (
                  <span>
                    {libraryState.status === "signed-out"
                      ? "Sign in to see your playlists."
                      : "No user-created playlists were found."}
                  </span>
                )}
                {libraryState.status === "signed-out" && (
                  <GoogleSignInButton
                    size="sm"
                    iconOnly={shouldHideText}
                    onClick={() => void libraryController.signIn()}
                  />
                )}
                {showPlaylistRetry && (
                  <button
                    type="button"
                    className={RETRY_BUTTON}
                    onClick={handlePlaylistRetry}
                    disabled={isRetryingPlaylists}
                    title="Retry playlist sync"
                    aria-label="Retry playlist sync"
                  >
                    <RefreshIcon size={15} aria-hidden="true" />
                    {!shouldHideText && (
                      <span>{isRetryingPlaylists ? "Retrying..." : "Retry"}</span>
                    )}
                  </button>
                )}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
