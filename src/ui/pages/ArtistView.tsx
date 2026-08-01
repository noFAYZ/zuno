import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SpinnerSteps } from "@/components/motion/loader";
import { CheckIcon, CopyIcon, UserPlusIcon } from "@/ui/icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/motion/select";
import type {
  Album,
  Artist,
  ArtistNotificationLevel,
  ArtistPage,
  Playlist,
  Track,
} from "../../datasource/types";
import type { LibraryController } from "../../player/LibraryController";
import type { PlayerControllerActions } from "../../player/playerStore";
import { shuffleTracks } from "../../player/shuffleTracks";
import { AlbumCard } from "../components/AlbumCard";
import { ArtistLinks } from "../components/ArtistLinks";
import { MediaHeader } from "../components/MediaHeader";
import { TrackArtwork } from "../components/TrackArtwork";
import { TrackRow } from "../components/TrackRow";
import { useNowPlaying } from "../hooks/useNowPlaying";
import { usePlaylistContextMenu } from "../components/PlaylistContextMenu";
import { useTrackContextMenu } from "../components/TrackContextMenu";

type ReleaseFilter = "all" | "album" | "single" | "ep";

function compactViews(track: Track): string {
  if (track.viewCount) {
    return new Intl.NumberFormat("en", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(track.viewCount);
  }
  return track.viewCountText
    ? track.viewCountText.replace(/\s*\b(?:views?|plays?)\b\.?/i, "").trim()
    : "";
}

function getArtistUrl(artist: Artist): string {
  if (artist.id.startsWith("UC")) {
    return `https://music.youtube.com/channel/${encodeURIComponent(artist.id)}`;
  }
  if (artist.id) {
    return `https://music.youtube.com/browse/${encodeURIComponent(artist.id)}`;
  }
  return `https://music.youtube.com/search?q=${encodeURIComponent(artist.name)}`;
}

export function ArtistView({
  artist,
  playerController,
  libraryController,
  onOpenAlbum,
  onOpenPlaylist,
}: {
  artist?: Artist;
  playerController: PlayerControllerActions;
  libraryController: LibraryController;
  onOpenAlbum: (album: Album) => void;
  onOpenPlaylist: (playlist: Playlist) => void;
}) {
  const { openPlaylistPicker, openTrackMenu } = useTrackContextMenu();
  const { openPlaylistMenu, openAlbumMenu } = usePlaylistContextMenu();
  const { currentTrackId, isPlaying, isLoading: isPlayerLoading } = useNowPlaying();
  const [page, setPage] = useState<ArtistPage | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ReleaseFilter>("all");
  const [isSubscribing, setIsSubscribing] = useState(false);
  const [isSubscribed, setIsSubscribed] = useState(false);
  /*
   * "personalized" is YouTube's default for a new subscription, and the artist page does not
   * report the stored level — so this starts at the default and tracks whatever the user
   * chooses here rather than claiming to know what the account already holds.
   */
  const [notificationLevel, setNotificationLevel] =
    useState<ArtistNotificationLevel>("personalized");
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!artist) return;
    let active = true;
    setPage(null);
    setIsLoading(true);
    setError(null);
    setFilter("all");
    void libraryController.getArtist(artist.id, (updated) => {
      if (active) setPage(updated);
    })
      .then((result) => {
        if (active) setPage(result);
      })
      .catch(() => {
        if (active) setError("Unable to load this artist.");
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [artist, libraryController]);

  const releaseTypes = useMemo(
    () => new Set(page?.releases.map((release) => release.releaseType) ?? []),
    [page?.releases],
  );
  const releaseFilters = useMemo(
    () => (["all", "album", "single", "ep"] as const)
      .filter((type) => type === "all" || releaseTypes.has(type)),
    [releaseTypes],
  );
  const activeFilterIndex = Math.max(0, releaseFilters.indexOf(filter));
  const visibleReleases = page?.releases.filter(
    (release) => filter === "all" || release.releaseType === filter,
  ) ?? [];

  const displayedArtist = page?.artist ?? artist;
  const popularSongs = page?.popularSongs.slice(0, 6) ?? [];

  useEffect(() => {
    setIsSubscribed(page?.subscribed ?? false);
  }, [page?.subscribed]);

  useEffect(() => () => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
  }, []);

  if (!artist || !displayedArtist) return null;

  const showToast = (message: string) => {
    setToast(message);
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3000);
  };

  const trackIds = useMemo(
    () => new Set((page?.allSongs ?? []).map((track) => track.id)),
    [page],
  );
  const isCurrentCollection = currentTrackId !== null && trackIds.has(currentTrackId);

  const togglePlayCollection = () => {
    if (isCurrentCollection) {
      playerController.togglePlayPause();
      return;
    }
    playInOrder();
  };

  const playInOrder = () => {
    const songs = page?.allSongs ?? [];
    if (songs[0]) void playerController.playTrackById(songs[0].id, songs);
  };

  /*
   * Queued in its listed order with shuffle switched on afterwards, not pre-shuffled — so the
   * player bar's toggle reflects reality, and turning shuffle off restores the original order.
   */
  const playShuffled = async () => {
    const songs = page?.allSongs ?? [];
    const firstTrack = shuffleTracks(songs)[0];
    if (!firstTrack) return;
    const started = await playerController.playTrackById(firstTrack.id, songs);
    if (started) playerController.setShuffleEnabled(true);
  };

  /**
   * Changes how often YouTube notifies about this artist.
   *
   * Optimistic, and deliberately so: YouTube does not report the current level on the artist
   * page, so local state is the only record of the choice within a session. A failure puts the
   * previous value back rather than leaving the control showing something that was refused.
   */
  const changeNotificationLevel = async (level: ArtistNotificationLevel) => {
    const previous = notificationLevel;
    setNotificationLevel(level);
    try {
      await libraryController.setArtistNotificationLevel(displayedArtist, level);
      showToast(
        level === "all"
          ? "Notifying you about every release"
          : level === "none" ? "Notifications off" : "Notifications set to personalized",
      );
    } catch (notificationError) {
      setNotificationLevel(previous);
      showToast(
        notificationError instanceof Error
          ? notificationError.message
          : "Unable to change notifications.",
      );
    }
  };

  const toggleArtistSubscription = async () => {
    if (isSubscribing) return;
    const nextSubscribed = !isSubscribed;
    setIsSubscribing(true);
    try {
      await libraryController.setArtistSubscribed(displayedArtist, nextSubscribed);
      setIsSubscribed(nextSubscribed);
      // Unsubscribing drops the preference server-side; showing the old level after
      // resubscribing would claim a setting that no longer exists.
      if (!nextSubscribed) setNotificationLevel("personalized");
    } catch (subscribeError) {
      showToast(
        subscribeError instanceof Error
          ? subscribeError.message
          : "Unable to update this subscription.",
      );
    } finally {
      setIsSubscribing(false);
    }
  };

  const copyArtistUrl = async () => {
    try {
      await navigator.clipboard.writeText(getArtistUrl(displayedArtist));
      showToast("Url copied to clipboard");
    } catch {
      showToast("Unable to copy the link.");
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <MediaHeader
        eyebrow="Artist"
        title={
          <button
            type="button"
            className="group/title flex items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => void copyArtistUrl()}
            aria-label={`Copy ${displayedArtist.name} URL`}
          >
            <span>{displayedArtist.name}</span>
            <CopyIcon
              className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/title:opacity-100"
              size={22}
              aria-hidden="true"
            />
          </button>
        }
        meta={displayedArtist.subscriberCount}
        circularArtwork
        /* Supplied even though artworkSlot draws the image: MediaHeader publishes this to
           the ambient store, which is what tints the chrome above the page. */
        artworkUrl={displayedArtist.artworkUrl}
        /*
         * The same component every other cover in the app uses. Its own ladder ends by
         * refetching the image through Tauri and painting the bytes, which is what rescues a
         * url the webview refuses to load directly — the hand-rolled <img> here had no such
         * step, and looped back to the first candidate forever once they had all failed.
         */
        artworkSlot={
          <TrackArtwork
            className="size-44 shrink-0 rounded-full bg-card shadow-2xl ring-1 ring-white/10"
            size={176}
            artworkUrl={displayedArtist.artworkUrl}
            iconSize={72}
            variant="artist"
            loading="eager"
          />
        }
        actionsDisabled={isLoading || Boolean(error) || !page?.allSongs.length}
        playback={{
          onToggle: togglePlayCollection,
          isPlaying: isCurrentCollection && isPlaying,
          isLoading: isCurrentCollection && isPlayerLoading,
        }}
        onShuffle={() => void playShuffled()}
        onAddToQueue={() => playerController.addTracksToQueue(page?.allSongs ?? [])}
        onAddToPlaylist={() => {
          const songs = page?.allSongs ?? [];
          if (songs.length > 0) openPlaylistPicker(songs[0], songs);
        }}
        actions={
          <div className="flex items-center gap-2">
            <button
              className="flex items-center gap-2 rounded-full bg-card px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              type="button"
              disabled={isLoading || Boolean(error) || isSubscribing}
              onClick={() => void toggleArtistSubscription()}
            >
              {isSubscribing ? (
                <SpinnerSteps size={18} color="currentColor" />
              ) : isSubscribed ? (
                <CheckIcon size={18} />
              ) : (
                <UserPlusIcon size={18} />
              )}
              <span>
                {isSubscribing
                  ? isSubscribed ? "Unsubscribing..." : "Subscribing..."
                  : isSubscribed ? "Subscribed" : "Subscribe"}
              </span>
            </button>

            {/*
              Only while subscribed: YouTube stores the preference against the subscription and
              discards it when that goes away, so offering the control otherwise would accept a
              choice it then silently drops.
            */}
            {isSubscribed && (
              <Select
                className="w-44"
                value={notificationLevel}
                onValueChange={(value) =>
                  void changeNotificationLevel(value as ArtistNotificationLevel)}
              >
                <SelectTrigger aria-label={`Notifications for ${displayedArtist.name}`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All new releases</SelectItem>
                  <SelectItem value="personalized">Personalized</SelectItem>
                  <SelectItem value="none">No notifications</SelectItem>
                </SelectContent>
              </Select>
            )}
          </div>
        }
      />

      {isLoading && <p className="px-2 py-10 text-center text-sm text-muted-foreground">Loading artist...</p>}
      {error && <p className="px-2 py-10 text-center text-sm text-muted-foreground">{error}</p>}

      {!isLoading && !error && page && (
        <>
          {popularSongs.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2>Popular</h2>
              <div className="flex flex-col gap-0.5">
                {popularSongs.map((track, index) => (
                  <TrackRow
                    key={track.id}
                    track={track}
                    index={index}
                    showAlbum
                    isCurrent={currentTrackId !== null && track.id === currentTrackId}
                    isPlaying={isPlaying && track.id === currentTrackId}
                    suppressArtistId={displayedArtist.id}
                    trailing={
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {compactViews(track)}
                      </span>
                    }
                    onSelect={() => void playerController.playTrackById(track.id, page.allSongs)}
                    showDownload

                    showRating
                    onQuickAddToQueue={() => playerController.addToQueue(track)}
                    onQuickAdd={() => openPlaylistPicker(track)}
                    onContextMenu={(event) => openTrackMenu(event, track)}
                  />
                ))}
              </div>
            </section>
          )}

          {page.releases.length > 0 && (
            <section className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <h2>Releases</h2>
                <div
                  className="flex flex-wrap items-center gap-1.5 self-start [&>button]:flex [&>button]:min-h-8 [&>button]:min-w-0 [&>button]:items-center [&>button]:justify-center [&>button]:gap-1.5 [&>button]:rounded-full [&>button]:bg-white/[0.04] [&>button]:px-3 [&>button]:text-sm [&>button]:font-medium [&>button]:text-muted-foreground [&>button]:transition-colors hover:[&>button]:bg-white/[0.08] hover:[&>button]:text-foreground focus-visible:[&>button]:outline-none focus-visible:[&>button]:ring-2 focus-visible:[&>button]:ring-ring"
                  role="group"
                  aria-label="Release type"
                  style={{
                    "--active-filter-offset": `${activeFilterIndex * 100}%`,
                    "--filter-count": releaseFilters.length,
                  } as CSSProperties}
                >
                  {releaseFilters
                    .map((type) => (
                      <button
                        key={type}
                        type="button"
                        className={filter === type ? "bg-primary/15 text-foreground" : ""}
                        aria-pressed={filter === type}
                        onClick={() => setFilter(type)}
                      >
                        {type === "all"
                          ? "All"
                          : type === "ep"
                            ? "EPs"
                            : `${type[0].toUpperCase()}${type.slice(1)}s`}
                      </button>
                    ))}
                </div>
              </div>
              <div key={filter} className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(9.5rem,1fr))] grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(9.5rem,1fr))]">
                {visibleReleases.map((release) => {
                  const hasLinkedArtists = Boolean(release.artists?.length);
                  return (
                    <div key={release.id} className="">
                      <AlbumCard
                        artworkUrl={release.artworkUrl}
                        title={release.title}
                        subtitle={hasLinkedArtists ? undefined : release.artist}
                        subtitleContent={hasLinkedArtists
                          ? (
                              <ArtistLinks
                                artists={release.artists}
                                fallback={release.artist}
                                suppressArtistId={displayedArtist.id}
                              />
                            )
                          : undefined}
                        onClick={() => onOpenAlbum(release)}
                        onContextMenu={(event) => openAlbumMenu(event, release)}
                      />
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {page.playlists.length > 0 && (
            <section className="flex flex-col gap-3">
              <h2>Playlists</h2>
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(9.5rem,1fr))]">
                {page.playlists.map((playlist) => (
                  <AlbumCard
                    key={playlist.id}
                    artworkUrl={playlist.artworkUrl}
                    title={playlist.title}
                    subtitle={playlist.owner}
                    onClick={() => onOpenPlaylist(playlist)}
                    onContextMenu={(event) => openPlaylistMenu(event, playlist)}
                  />
                ))}
              </div>
            </section>
          )}
        </>
      )}
      {toast && createPortal(
        <div className="fixed bottom-28 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-full bg-popover/95 px-4 py-2 text-sm text-foreground shadow-2xl backdrop-blur" role="status">
          {toast === "Url copied to clipboard" && (
            <CheckIcon size={18} aria-hidden="true" />
          )}
          <span>{toast}</span>
        </div>,
        document.body,
      )}
    </div>
  );
}
