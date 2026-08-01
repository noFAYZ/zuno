import { useEffect, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/motion/tooltip";
import { CheckIcon, DownloadIcon, ListIcon, PauseActiveIcon, PlayActiveIcon, PlaylistAddIcon, RepeatActiveIcon, ShuffleActiveIcon } from "@/ui/icons";
import { SpinnerSteps } from "@/components/motion/loader";
import { TrackArtwork } from "./TrackArtwork";
import { setAmbientArtwork } from "../stores/ambientArtworkStore";

/**
 * "24 songs · 1 hr 32 min".
 *
 * The duration is dropped unless every counted track reported one and the list is fully
 * loaded. YouTube omits `durationSec` on most playlist entries, so summing what happens to
 * be present produced badly wrong totals — a 98-track playlist read "98 songs · 3 min".
 * A missing total is honest; a wrong one is not.
 */
export function formatCollectionMeta(
  tracks: readonly { durationSec?: number }[],
  hasMore = false,
): string {
  const trackCount = tracks.length;
  const countLabel = `${trackCount}${hasMore ? "+" : ""} ${trackCount === 1 ? "song" : "songs"}`;
  if (hasMore || trackCount === 0) return countLabel;

  let totalDurationSec = 0;
  for (const track of tracks) {
    if (!track.durationSec) return countLabel;
    totalDurationSec += track.durationSec;
  }

  const totalMinutes = Math.round(totalDurationSec / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const durationLabel = hours > 0 ? `${hours} hr ${minutes} min` : `${minutes} min`;
  return `${countLabel} · ${durationLabel}`;
}

interface MediaHeaderProps {
  /** Small uppercase kicker: PLAYLIST, ALBUM, ARTIST. */
  eyebrow: string;
  /** ReactNode so a page can make the title interactive — the artist page's copies its URL. */
  title: ReactNode;
  /** Owner, artist links — the line directly under the title. */
  subtitle?: ReactNode;
  /** Counts and durations; rendered quieter than the subtitle. */
  meta?: ReactNode;
  artworkUrl?: string;
  artworkVariant?: "track" | "album" | "artist" | "playlist";
  /** Replaces the artwork entirely — Liked Songs uses its own glyph. */
  artworkSlot?: ReactNode;
  /** Artists read as people, so their image is circular. */
  circularArtwork?: boolean;
  /**
   * The primary play/pause control. Omit to hide it.
   *
   * Grouped rather than three sibling props because the three are meaningless apart: an
   * `isPlaying` with no handler renders a button that does nothing, and a `isLoading` with no
   * handler renders a spinner that never resolves. As one optional object those states cannot
   * be expressed at all.
   */
  playback?: {
    /** Called for both play and pause — the page decides which, from `isPlaying`. */
    onToggle: () => void;
    /** True while a track from *this* collection is playing, so the button reads "Pause". */
    isPlaying?: boolean;
    /** This collection is starting playback; the button holds its width and shows a spinner. */
    isLoading?: boolean;
  };
  onShuffle?: () => void;
  /** Queues every track in this collection behind what is already hand-picked. */
  onAddToQueue?: () => void;
  /** Adds every track in this collection to a playlist, via the usual picker. */
  onAddToPlaylist?: () => void;
  /** Offline download for the whole collection. Omit to hide the control. */
  download?: {
    /** Queues every not-yet-downloaded track in this collection for offline use. */
    onStart: () => void;
    /**
     * The collection is still being paged in before the download can start.
     *
     * Worth showing: on a long playlist this takes several round trips, and a button that
     * looks idle after a click reads as broken and gets clicked again.
     */
    isBusy?: boolean;
    /**
     * How much of this collection is already offline, so the button can say what pressing it
     * would actually do — "all 12 downloaded" is a different message from "download 9 songs".
     */
    counts?: {
      downloaded: number;
      total: number;
      /** True while pages remain unfetched, so `total` is a floor rather than the real total. */
      isPartial?: boolean;
    };
  };
  /** Play-from-the-top-on-repeat. Omit to hide the control. */
  loop?: {
    /** Plays from the top with repeat-all on, so the collection restarts instead of ending. */
    onPlay: () => void;
    /** Reflects repeat-all being active for this collection. */
    isActive?: boolean;
  };
  actionsDisabled?: boolean;
  /** Extra controls beside play/shuffle, e.g. Subscribe. */
  actions?: ReactNode;
}

/**
 * Shared hero for the playlist, album and artist pages.
 *
 * All three previously hand-rolled the same artwork + title + shuffle arrangement, which is
 * how they ended up subtly different sizes and how only some of them offered a given action.
 *
 * Two deliberate design choices:
 *
 * - **Play is the primary action, shuffle is secondary.** These pages only offered Shuffle,
 *   so the obvious intent — play this, in order — had no button at all.
 * - **The artwork tints its own header.** The image is reused, blown up and blurred behind
 *   the text, so each collection carries its own colour without a palette extraction step or
 *   a second network request. Kept faint so it never competes with the title.
 */
export function MediaHeader({
  eyebrow,
  title,
  subtitle,
  meta,
  artworkUrl,
  artworkVariant = "playlist",
  artworkSlot,
  circularArtwork = false,
  playback,
  onShuffle,
  onAddToQueue,
  onAddToPlaylist,
  download,
  loop,
  actionsDisabled = false,
  actions,
}: MediaHeaderProps) {
  /* Destructured once, so the body below reads the same as it did when these were flat props
     rather than threading `playback?.` through every branch. */
  const isPlaying = playback?.isPlaying ?? false;
  const isLoading = playback?.isLoading ?? false;
  const downloadBusy = download?.isBusy ?? false;
  const downloadCounts = download?.counts;
  const isLooping = loop?.isActive ?? false;
  /*
   * The wash is painted by Layout, which sits above the scroll container this header lives
   * in — it has to start behind the search bar, and anything drawn here would be clipped at
   * the scroller's top edge. Cleared on unmount so the tint leaves with the page.
   */
  useEffect(() => {
    setAmbientArtwork(artworkUrl ?? null);
    return () => setAmbientArtwork(null);
  }, [artworkUrl]);

  return (
    <header className="relative flex flex-wrap items-end gap-6 px-1 pb-6 pt-2">
      {artworkSlot ?? (
        <TrackArtwork
          className={cn(
            "size-44 shrink-0 shadow-2xl ring-1 ring-white/10",
            circularArtwork ? "rounded-full" : "rounded-2xl",
          )}
          artworkUrl={artworkUrl}
          iconSize={72}
          loading="eager"
          variant={artworkVariant}
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {eyebrow}
        </span>
        {/* Long album titles otherwise push the actions off the row entirely. */}
        <h1 className="line-clamp-2 text-4xl font-bold tracking-[-0.03em] text-foreground">
          {title}
        </h1>
        {subtitle ? <div className="text-sm text-foreground/80">{subtitle}</div> : null}
        {meta ? <p className="text-xs text-muted-foreground">{meta}</p> : null}

        <div className="mt-2 flex flex-wrap items-center gap-2">
          {playback ? (
            /*
             * Reflects this collection's own state, not the player's: it only becomes a
             * Pause control while the track being played belongs here. Playing something
             * else leaves this reading "Play", which is what the button would then do.
             */
            <button
              type="button"
              disabled={actionsDisabled}
              onClick={playback.onToggle}
              aria-label={isPlaying ? "Pause" : "Play"}
              className="flex min-w-[7.5rem] items-center justify-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-transform hover:scale-[1.03] active:scale-95 disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {isLoading ? (
                <>
                  <SpinnerSteps size={18} color="currentColor" />
                  Loading
                </>
              ) : isPlaying ? (
                <>
                  <PauseActiveIcon size={18} aria-hidden="true" />
                  Pause
                </>
              ) : (
                <>
                  <PlayActiveIcon size={18} aria-hidden="true" />
                  Play
                </>
              )}
            </button>
          ) : null}

          {onShuffle ? (
            <button
              type="button"
              disabled={actionsDisabled}
              onClick={onShuffle}
              className="flex items-center gap-2 rounded-full bg-card px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ShuffleActiveIcon size={18} aria-hidden="true" />
              Shuffle
            </button>
          ) : null}

          {loop ? (
            <Tooltip content="Play from the top and start over when it ends">
              <button
                type="button"
                disabled={actionsDisabled}
                onClick={loop.onPlay}
                aria-pressed={isLooping}
                aria-label="Play in loop"
                className={cn(
                  "flex items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium transition-colors",
                  "disabled:pointer-events-none disabled:opacity-50",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isLooping
                    ? "bg-primary/15 text-primary"
                    : "bg-card text-foreground hover:bg-muted",
                )}
              >
                <RepeatActiveIcon size={18} aria-hidden="true" />
                Loop
              </button>
            </Tooltip>
          ) : null}

          {onAddToPlaylist ? (
            <Tooltip content="Add every song here to a playlist">
              <button
                type="button"
                disabled={actionsDisabled}
                onClick={onAddToPlaylist}
                aria-label="Add to playlist"
                className="flex size-11 items-center justify-center rounded-full bg-card text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <PlaylistAddIcon size={18} aria-hidden="true" />
              </button>
            </Tooltip>
          ) : null}

          {onAddToQueue ? (
            <Tooltip content="Add every song here to the queue">
              <button
                type="button"
                disabled={actionsDisabled}
                onClick={onAddToQueue}
                aria-label="Add to queue"
                className="flex size-11 items-center justify-center rounded-full bg-card text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ListIcon size={18} aria-hidden="true" />
              </button>
            </Tooltip>
          ) : null}

          {download ? (() => {
            /*
             * Disabled once everything here is already offline. Re-queueing downloaded tracks
             * would be a no-op the user cannot see, so the button says so instead of appearing
             * to do nothing.
             */
            const total = downloadCounts?.total ?? 0;
            const downloaded = downloadCounts?.downloaded ?? 0;
            const remaining = Math.max(0, total - downloaded);
            // Never "all downloaded" while pages remain unfetched — the unseen ones are not.
            const allDownloaded = total > 0 && remaining === 0 && !downloadCounts?.isPartial;

            return (
              <Tooltip
                content={
                  allDownloaded
                    ? "Every song here is downloaded"
                    : downloadCounts?.isPartial
                      ? "Download every song here for offline"
                      : remaining > 0
                        ? `Download ${remaining} song${remaining === 1 ? "" : "s"} for offline`
                        : "Download for offline"
                }
              >
                <button
                  type="button"
                  disabled={actionsDisabled || allDownloaded || downloadBusy}
                  onClick={download.onStart}
                  aria-busy={downloadBusy}
                  aria-label={allDownloaded ? "Already downloaded" : "Download for offline"}
                  className="relative flex size-11 items-center justify-center rounded-full bg-card text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {downloadBusy ? (
                    <SpinnerSteps size={18} color="currentColor" />
                  ) : allDownloaded ? (
                    <CheckIcon size={18} aria-hidden="true" className="text-primary" />
                  ) : (
                    <DownloadIcon size={18} aria-hidden="true" />
                  )}
                </button>
              </Tooltip>
            );
          })() : null}

          {actions}
        </div>
      </div>
    </header>
  );
}
