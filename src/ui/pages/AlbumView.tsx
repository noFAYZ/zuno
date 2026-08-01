import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { SpinnerSteps } from "@/components/motion/loader";
import { CloseIcon, SearchIcon } from "@/ui/icons";
import { TrackRow } from "../components/TrackRow";
import { useNowPlaying } from "../hooks/useNowPlaying";
import type { Album, Track } from "../../datasource/types";
import type { LibraryController } from "../../player/LibraryController";
import type { PlayerControllerActions } from "../../player/playerStore";
import { shuffleTracks } from "../../player/shuffleTracks";
import { useTrackContextMenu } from "../components/TrackContextMenu";
import { SelectionBar } from "../components/SelectionBar";
import { useTrackSelection } from "../hooks/useTrackSelection";
import { queueDownloads, useOfflineState } from "../../player/offlineStore";
import { ArtistLinks } from "../components/ArtistLinks";
import { formatCollectionMeta, MediaHeader } from "../components/MediaHeader";
import { useKeyboardShortcuts } from "../settings/keyboardShortcuts";
import { shouldStartPageSearch } from "./pageSearchKeyboard";

/*
 * Collapsed search affordance that widens on hover/focus or while it holds a query —
 * the behaviour the original .playlistSearch width transition provided.
 */
const SEARCH_FIELD =
  "group/search flex min-h-8 items-center gap-1.5 overflow-hidden rounded-full bg-white/[0.04] px-2.5 " +
  "text-muted-foreground transition-[width,background-color] duration-200 cursor-text " +
  "hover:bg-white/[0.08] focus-within:bg-white/[0.08] focus-within:text-foreground " +
  "[&_input]:min-w-0 [&_input]:flex-1 [&_input]:bg-transparent [&_input]:text-sm " +
  "[&_input]:text-foreground [&_input]:outline-none [&_input]:placeholder:text-muted-foreground";
const SEARCH_FIELD_COLLAPSED = "w-9 hover:w-56 focus-within:w-56";

interface AlbumViewProps {
  album?: Album;
  playerController: PlayerControllerActions;
  libraryController: LibraryController;
}

function getTrackRenderKey(track: Track, index: number): string {
  return track.playlistItemId ?? `${track.id}:${index}`;
}

function AlbumLoadingSpinner({ label }: { label: string }) {
  return (
    <div className="grid place-items-center px-2 py-16 text-muted-foreground" role="status" aria-live="polite" aria-label={label}>
      <SpinnerSteps size={18} color="currentColor" />
    </div>
  );
}

export function AlbumView({ album, playerController, libraryController }: AlbumViewProps) {
  const { openPlaylistPicker, openTrackMenu } = useTrackContextMenu();
  const keyboardShortcuts = useKeyboardShortcuts();
  const {
    currentTrackId,
    isPlaying,
    isLoading: isPlayerLoading,
    playbackOrderMode,
  } = useNowPlaying();
  const [tracks, setTracks] = useState<Track[]>([]);
  /*
   * Derived from the offline store so the header button can say what pressing it would do.
   * Recomputed from entries rather than tracked separately: a count kept in parallel with the
   * store is a count that drifts the moment a download finishes elsewhere.
   */
  const offlineState = useOfflineState();
  const downloadCounts = useMemo(
    () => ({
      downloaded: tracks.filter((track) => Boolean(offlineState.entries[track.id])).length,
      total: tracks.length,
    }),
    [tracks, offlineState.entries],
  );

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [albumSearchQuery, setAlbumSearchQuery] = useState("");
  const albumSearchInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!album) return;
    let active = true;
    setTracks([]);
    setAlbumSearchQuery("");
    setIsLoading(true);
    setError(null);
    let showedTracks = false;
    void libraryController.getAlbumTracks(album, (updatedTracks) => {
      if (!active) return;
      showedTracks = updatedTracks.length > 0;
      setTracks(updatedTracks);
      if (updatedTracks.length > 0) setIsLoading(false);
    })
      .then((items) => {
        if (!active) return;
        showedTracks = true;
        setTracks(items);
      })
      .catch(() => {
        if (active && !showedTracks) setError("Unable to load this album.");
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [album, libraryController]);

  const visibleTracks = useMemo(() => {
    const query = albumSearchQuery.trim().toLocaleLowerCase();
    if (!query) return tracks;
    return tracks.filter((track) => [
      track.title,
      track.artist,
      track.album,
      ...(track.artists?.map((artist) => artist.name) ?? []),
    ].some((value) => value?.toLocaleLowerCase().includes(query)));
  }, [albumSearchQuery, tracks]);

  useEffect(() => {
    if (!album || isLoading || error || tracks.length === 0) return;

    const handlePageSearchKeyDown = (event: KeyboardEvent) => {
      if (!shouldStartPageSearch(event, keyboardShortcuts)) return;
      event.preventDefault();
      setAlbumSearchQuery((current) => `${current}${event.key}`);
      window.requestAnimationFrame(() => albumSearchInputRef.current?.focus());
    };

    window.addEventListener("keydown", handlePageSearchKeyDown);
    return () => window.removeEventListener("keydown", handlePageSearchKeyDown);
  }, [album, error, isLoading, keyboardShortcuts, tracks.length]);

  if (!album) return null;


  const trackIds = useMemo(() => new Set(tracks.map((track) => track.id)), [tracks]);
  const isCurrentCollection = currentTrackId !== null && trackIds.has(currentTrackId);

  const togglePlayCollection = () => {
    if (isCurrentCollection) {
      playerController.togglePlayPause();
      return;
    }
    playInOrder();
  };

  const playInOrder = () => {
    const firstTrack = tracks[0];
    if (firstTrack) void playerController.playTrackById(firstTrack.id, tracks);
  };

  /*
   * Order is set before playback starts, not after: playTrackById resolves asynchronously,
   * and a mode applied afterwards can lose a race with a track that ends almost immediately.
   */
  const selection = useTrackSelection(visibleTracks);

  const playInLoop = () => {
    const firstTrack = tracks[0];
    if (!firstTrack) return;
    playerController.setPlaybackOrderMode("repeat-all");
    void playerController.playTrackById(firstTrack.id, tracks);
  };

  /*
   * Queued in album order with shuffle switched on afterwards, not pre-shuffled — so the player
   * bar's toggle reflects reality, and turning shuffle off restores the album's real running
   * order rather than treating the shuffle as the original.
   */
  const playShuffled = async () => {
    const firstTrack = shuffleTracks(tracks)[0];
    if (!firstTrack) return;
    const started = await playerController.playTrackById(firstTrack.id, tracks);
    if (started) playerController.setShuffleEnabled(true);
  };

  const handleAlbumSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Backspace" || albumSearchQuery) return;
    event.preventDefault();
    event.currentTarget.blur();
  };

  return (
    <div className="flex flex-col gap-8">
      <MediaHeader
        eyebrow="Album"
        title={album.title}
        subtitle={<ArtistLinks artists={album.artists} fallback={album.artist} />}
        meta={formatCollectionMeta(tracks)}
        artworkUrl={album.artworkUrl}
        artworkVariant="album"
        actionsDisabled={isLoading || Boolean(error) || tracks.length === 0}
        playback={{
          onToggle: togglePlayCollection,
          isPlaying: isCurrentCollection && isPlaying,
          isLoading: isCurrentCollection && isPlayerLoading,
        }}
        onShuffle={() => void playShuffled()}
        loop={{
          onPlay: playInLoop,
          isActive: isCurrentCollection && playbackOrderMode === "repeat-all",
        }}
        onAddToQueue={() => playerController.addTracksToQueue(tracks)}
        onAddToPlaylist={() => openPlaylistPicker(tracks[0], tracks)}
        download={{ onStart: () => queueDownloads(tracks), counts: downloadCounts }}
      />
      {isLoading && <AlbumLoadingSpinner label="Loading songs" />}
      {error && <p className="px-2 py-10 text-center text-sm text-muted-foreground">{error}</p>}
      {!isLoading && !error && tracks.length > 0 && (
        <>
          <div
            className="flex flex-wrap items-center gap-1.5 self-start [&>button]:flex [&>button]:min-h-8 [&>button]:min-w-0 [&>button]:items-center [&>button]:justify-center [&>button]:gap-1.5 [&>button]:rounded-full [&>button]:bg-white/[0.04] [&>button]:px-3 [&>button]:text-sm [&>button]:font-medium [&>button]:text-muted-foreground [&>button]:transition-colors hover:[&>button]:bg-white/[0.08] hover:[&>button]:text-foreground focus-visible:[&>button]:outline-none focus-visible:[&>button]:ring-2 focus-visible:[&>button]:ring-ring"
            role="group"
            aria-label="Album song tools"
          >
            <div
              className={cn(SEARCH_FIELD, albumSearchQuery ? "w-56" : SEARCH_FIELD_COLLAPSED)}
              role="search"
              onClick={() => albumSearchInputRef.current?.focus()}
            >
              <span className="shrink-0">
                <SearchIcon size={16} aria-hidden="true" />
              </span>
              <input
                ref={albumSearchInputRef}
                type="text"
                value={albumSearchQuery}
                aria-label="Search songs in album"
                placeholder="Search album"
                onChange={(event) => setAlbumSearchQuery(event.target.value)}
                onKeyDown={handleAlbumSearchKeyDown}
              />
              {albumSearchQuery && (
                <button
                  className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  type="button"
                  aria-label="Clear album search"
                  onClick={() => setAlbumSearchQuery("")}
                >
                  <CloseIcon size={14} aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
          {visibleTracks.length === 0 && albumSearchQuery.trim() ? (
            <p className="px-2 py-10 text-center text-sm text-muted-foreground">No songs match this search.</p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {visibleTracks.map((track, index) => {
                /*
                 * Matched on track identity rather than row position: the queue can be
                 * shuffled or reordered independently of how this album is displayed.
                 */
                const isCurrent = currentTrackId !== null && track.id === currentTrackId;
                return (
                  <TrackRow
                    key={getTrackRenderKey(track, index)}
                    track={track}
                    index={index}
                    isCurrent={isCurrent}
                    isPlaying={isCurrent && isPlaying}
                    isSelected={selection.isSelected(track.id)}
                    isSelectionActive={selection.isActive}
                    onToggleSelected={() => selection.toggle(track.id, index)}
                    onSelect={(event) => {
                      if (selection.handleRowClick(event, index)) return;
                      void playerController.playTrackById(track.id, visibleTracks);
                    }}
                    showDownload

                    showRating
                    onQuickAddToQueue={() => playerController.addToQueue(track)}
                    onQuickAdd={() => openPlaylistPicker(track)}
                    onContextMenu={(event) => openTrackMenu(event, track)}
                  />
                );
              })}
            </div>
          )}
        </>
      )}
      <SelectionBar
        selection={selection}
        onAddToQueue={(selected) => {
          playerController.addTracksToQueue(selected);
          selection.clear();
        }}
        onAddToPlaylist={(selected) => {
          openPlaylistPicker(selected[0], selected);
          selection.clear();
        }}
        onDownload={(selected) => {
          queueDownloads(selected);
          selection.clear();
        }}
      />

    </div>
  );
}
