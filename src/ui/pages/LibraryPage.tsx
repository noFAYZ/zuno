import { useMemo, useState, type MouseEvent } from "react";
import { cn } from "@/lib/utils";
import { SearchIcon } from "@/ui/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/motion/select";
import type { Album, Artist, Playlist, Track } from "../../datasource/types";
import type { LibraryState } from "../../player/LibraryController";
import type { PlayerControllerActions } from "../../player/playerStore";
import { queueDownloads } from "../../player/offlineStore";
import { getLocalPlaylistItems } from "../../player/localPlaylists";
import { AlbumCard } from "../components/AlbumCard";
import { SelectionBar } from "../components/SelectionBar";
import { TrackArtwork } from "../components/TrackArtwork";
import { TrackRow } from "../components/TrackRow";
import { useTrackContextMenu } from "../components/TrackContextMenu";
import { usePlaylistContextMenu } from "../components/PlaylistContextMenu";
import { useNowPlaying } from "../hooks/useNowPlaying";
import { useTrackSelection } from "../hooks/useTrackSelection";
import { isLikedSongsId, likedSongsCover } from "../likedSongsArtwork";

type LibraryTab = "songs" | "albums" | "artists" | "playlists";

const TABS: Array<{ value: LibraryTab; label: string }> = [
  { value: "songs", label: "Songs" },
  { value: "albums", label: "Albums" },
  { value: "artists", label: "Artists" },
  { value: "playlists", label: "Playlists" },
];

const GRID = "grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(9rem,1fr))]";

/** "recent" is YouTube's own order, which is newest-first — so it sorts by doing nothing. */
type LibrarySort = "recent" | "title" | "artist";

function matches(query: string, ...fields: Array<string | undefined>): boolean {
  if (!query) return true;
  return fields.some((field) => field?.toLocaleLowerCase().includes(query));
}

function sortItems<T>(
  items: T[],
  sort: LibrarySort,
  title: (item: T) => string,
  artist: (item: T) => string,
): T[] {
  if (sort === "recent") return items;
  const key = sort === "artist" ? artist : title;
  return [...items].sort((left, right) => key(left).localeCompare(key(right)));
}

/**
 * Your library, browsable as a whole.
 *
 * The sidebar only ever led to one playlist or album at a time; there was no way to see
 * everything you have. Artists are derived rather than fetched — the library snapshot has no
 * artist list, but every saved album and liked song names one, and that union is the set of
 * artists you actually own something by.
 */
export function LibraryPage({
  libraryState,
  playerController,
  onOpenAlbum,
  onOpenArtist,
  onOpenPlaylist,
}: {
  libraryState: LibraryState;
  playerController: PlayerControllerActions;
  onOpenAlbum: (album: Album) => void;
  onOpenArtist: (artist: Artist) => void;
  onOpenPlaylist: (playlist: Playlist) => void;
}) {
  const [tab, setTab] = useState<LibraryTab>("songs");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<LibrarySort>("recent");
  const { currentTrackId, isPlaying } = useNowPlaying();
  const { openTrackMenu, openPlaylistPicker } = useTrackContextMenu();
  const { openPlaylistMenu, openAlbumMenu } = usePlaylistContextMenu();

  const library = libraryState.library;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  // Artists have no second field to sort on, so that option is hidden there rather than
  // silently doing nothing when the tab changes under a chosen sort.
  const activeSort: LibrarySort = tab === "artists" && sort === "artist" ? "title" : sort;

  // Liked Songs first, then everything else saved to the library — two lists on YouTube's
  // side, one "Songs" tab here.
  const songs = useMemo(
    () => sortItems(
      [...(library?.likedSongs ?? []), ...(library?.librarySongs ?? [])].filter((track) =>
        matches(normalizedQuery, track.title, track.artist, track.album)),
      activeSort,
      (track) => track.title,
      (track) => track.artist,
    ),
    [activeSort, library?.likedSongs, library?.librarySongs, normalizedQuery],
  );

  const albums = useMemo(
    () => sortItems(
      (library?.albums ?? []).filter((album) =>
        matches(normalizedQuery, album.title, album.artist)),
      activeSort,
      (album) => album.title,
      (album) => album.artist,
    ),
    [activeSort, library?.albums, normalizedQuery],
  );

  const playlists = useMemo(() => {
    const all = [...(library?.playlists ?? []), ...getLocalPlaylistItems()];
    return sortItems(
      all.filter((playlist) => matches(normalizedQuery, playlist.title, playlist.owner)),
      activeSort,
      (playlist) => playlist.title,
      (playlist) => playlist.owner,
    );
  }, [activeSort, library?.playlists, normalizedQuery]);

  const artists = useMemo(() => {
    const byId = new Map<string, Artist>();
    /*
     * The artist references carried by albums and tracks are a name and a channel id — no
     * photo. The library's own artists section is the only place those come from, so it is
     * consulted by id and by name for anything derived below.
     */
    const artworkByName = new Map(
      (library?.artists ?? [])
        .filter((artist) => artist.artworkUrl)
        .map((artist) => [artist.name.trim().toLocaleLowerCase(), artist.artworkUrl] as const),
    );
    const remember = (reference: { id?: string; name?: string; artworkUrl?: string }) => {
      const name = reference.name?.trim();
      if (!name) return;
      // Matching on name is for references that have no channel id at all. Applying it to one
      // that does would hand an artist the photo of whoever shares their name.
      const artworkUrl = reference.artworkUrl
        ?? (reference.id ? undefined : artworkByName.get(name.toLocaleLowerCase()));
      // Keyed by id where there is one, by name otherwise: an artist without an id still
      // deserves a single row rather than one per track that mentions them.
      const key = reference.id ?? `name:${name.toLocaleLowerCase()}`;
      const existing = byId.get(key);
      if (existing) {
        if (!existing.artworkUrl && artworkUrl) existing.artworkUrl = artworkUrl;
        return;
      }
      byId.set(key, { id: reference.id ?? key, name, artworkUrl });
    };

    for (const artist of library?.artists ?? []) remember(artist);
    for (const album of library?.albums ?? []) {
      if (album.artists?.length) album.artists.forEach((item) => remember(item));
      // No album cover as a stand-in: it is a picture of a record, not of the artist, and one
      // arbitrary sleeve in a round frame reads as the wrong person entirely.
      else remember({ name: album.artist });
    }
    for (const track of [...(library?.likedSongs ?? []), ...(library?.librarySongs ?? [])]) {
      if (track.artists?.length) track.artists.forEach((item) => remember(item));
      else remember({ name: track.artist });
    }

    return sortItems(
      [...byId.values()].filter((artist) => matches(normalizedQuery, artist.name)),
      activeSort,
      (artist) => artist.name,
      (artist) => artist.name,
    );
  }, [
    activeSort,
    library?.albums,
    library?.artists,
    library?.likedSongs,
    library?.librarySongs,
    normalizedQuery,
  ]);

  const selection = useTrackSelection(songs);

  const playSong = (track: Track, index: number, event: MouseEvent<HTMLElement>) => {
    if (selection.handleRowClick(event, index)) return;
    void playerController.playTrackById(track.id, songs);
  };

  const counts: Record<LibraryTab, number> = {
    songs: songs.length,
    albums: albums.length,
    artists: artists.length,
    playlists: playlists.length,
  };

  if (!library) {
    return (
      <p className="px-2 py-16 text-center text-sm text-muted-foreground">
        {libraryState.status === "signed-out"
          ? "Sign in to see your library."
          : "Loading your library..."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-3">
        <h1 className="text-3xl font-bold tracking-[-0.02em] text-foreground">Library</h1>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Library section">
            {TABS.map((item) => (
              <button
                key={item.value}
                type="button"
                role="tab"
                aria-selected={tab === item.value}
                onClick={() => {
                  setTab(item.value);
                  selection.clear();
                }}
                className={cn(
                  "rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  tab === item.value
                    ? "bg-primary text-primary-foreground"
                    : "bg-card text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
                <span className="ml-1.5 tabular-nums opacity-60">{counts[item.value]}</span>
              </button>
            ))}
          </div>

          <label className="ml-auto flex min-w-0 items-center gap-2 rounded-full bg-card px-3 py-1.5 text-muted-foreground focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring">
            <SearchIcon size={16} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter library"
              aria-label="Filter library"
              className="w-36 min-w-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>

          <Select
            className="w-44"
            value={activeSort}
            onValueChange={(value) => setSort(value as LibrarySort)}
          >
            <SelectTrigger aria-label="Sort library">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recent">Recently added</SelectItem>
              <SelectItem value="title">{tab === "artists" ? "Name" : "Title"}</SelectItem>
              {tab !== "artists" && (
                <SelectItem value="artist">{tab === "playlists" ? "Owner" : "Artist"}</SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>
      </header>

      {tab === "songs" && (
        songs.length === 0 ? (
          <p className="px-2 py-10 text-center text-sm text-muted-foreground">No songs found.</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {songs.map((track, index) => (
              <TrackRow
                key={`${track.id}:${index}`}
                track={track}
                index={index}
                showAlbum
                isCurrent={currentTrackId === track.id}
                isPlaying={isPlaying && currentTrackId === track.id}
                isSelected={selection.isSelected(track.id)}
                isSelectionActive={selection.isActive}
                onToggleSelected={() => selection.toggle(track.id, index)}
                onSelect={(event) => playSong(track, index, event)}
                onContextMenu={(event) => openTrackMenu(event, track)}
                onQuickAdd={() => openPlaylistPicker(track)}
                onQuickAddToQueue={() => playerController.addToQueue(track)}
                showDownload

                showRating
              />
            ))}
          </div>
        )
      )}

      {tab === "albums" && (
        albums.length === 0 ? (
          <p className="px-2 py-10 text-center text-sm text-muted-foreground">No albums found.</p>
        ) : (
          <div className={GRID}>
            {albums.map((album) => (
              <AlbumCard
                key={album.id}
                artworkUrl={isLikedSongsId(album.id) ? likedSongsCover : album.artworkUrl}
                title={album.title}
                subtitle={album.artist}
                onClick={() => onOpenAlbum(album)}
                onContextMenu={(event) => openAlbumMenu(event, album)}
              />
            ))}
          </div>
        )
      )}

      {tab === "artists" && (
        artists.length === 0 ? (
          <p className="px-2 py-10 text-center text-sm text-muted-foreground">No artists found.</p>
        ) : (
          <div className={GRID}>
            {artists.map((artist) => (
              <button
                key={artist.id}
                type="button"
                onClick={() => onOpenArtist(artist)}
                className="flex flex-col items-center gap-2 rounded-xl p-2 text-center transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <TrackArtwork
                  className="size-28 rounded-full"
                  size={112}
                  artworkUrl={artist.artworkUrl}
                  iconSize={30}
                  variant="artist"
                />
                <span className="line-clamp-2 text-sm font-medium text-foreground">
                  {artist.name}
                </span>
              </button>
            ))}
          </div>
        )
      )}

      {tab === "playlists" && (
        playlists.length === 0 ? (
          <p className="px-2 py-10 text-center text-sm text-muted-foreground">No playlists found.</p>
        ) : (
          <div className={GRID}>
            {playlists.map((playlist) => (
              <AlbumCard
                key={playlist.id}
                artworkUrl={
                  isLikedSongsId(playlist.id, playlist.kind)
                    ? likedSongsCover
                    : playlist.artworkUrl
                }
                title={playlist.title}
                subtitle={playlist.owner}
                onClick={() => onOpenPlaylist(playlist)}
                onContextMenu={(event) => openPlaylistMenu(event, playlist)}
              />
            ))}
          </div>
        )
      )}

      <SelectionBar
        selection={selection}
        onAddToQueue={(tracks) => {
          playerController.addTracksToQueue(tracks);
          selection.clear();
        }}
        onAddToPlaylist={(tracks) => {
          // One picker for the whole selection, rather than one per track.
          openPlaylistPicker(tracks[0], tracks);
          selection.clear();
        }}
        onDownload={(tracks) => {
          queueDownloads(tracks);
          selection.clear();
        }}
      />
    </div>
  );
}
