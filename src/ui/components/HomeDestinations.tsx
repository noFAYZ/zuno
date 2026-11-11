import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { AlbumIcon, ClockIcon, CompassIcon, DownloadIcon } from "@/ui/icons";
import { useOfflineState } from "../../player/offlineStore";
import { usePlayHistory } from "../../player/playHistory";
import { useLibraryState } from "../../player/playerStore";

export interface HomeDestinationHandlers {
  onOpenLibrary: () => void;
  onOpenBrowse: () => void;
  onOpenHistory: () => void;
  onOpenDownloads: () => void;
}

/**
 * The app's four destinations, on the home page rather than in the rail.
 *
 * They moved here because a permanently collapsed 72px rail could only ever show them as
 * unlabelled glyphs — three icons you had to hover to identify, competing for attention with
 * the playlist artwork that is the rail's actual job. On the home page they can carry a name
 * and a live count, which is what makes them worth a click.
 */
export function HomeDestinations({
  onOpenLibrary,
  onOpenBrowse,
  onOpenHistory,
  onOpenDownloads,
}: HomeDestinationHandlers) {
  const libraryState = useLibraryState();
  const offline = useOfflineState();
  const history = usePlayHistory();

  const library = libraryState.library;
  const savedCount = (library?.playlists.length ?? 0) + (library?.albums.length ?? 0);
  const downloadCount = Object.keys(offline.entries).length;

  const cards: Array<{
    key: string;
    label: string;
    hint: string;
    icon: typeof AlbumIcon;
    onClick: () => void;
    /** Live state, so the card says something the label alone cannot. */
    badge?: string;
  }> = [
    {
      key: "library",
      label: "Library",
      hint: "Songs, albums, artists",
      icon: AlbumIcon,
      onClick: onOpenLibrary,
      badge: savedCount > 0 ? `${savedCount} saved` : undefined,
    },
    {
      key: "browse",
      label: "Browse",
      hint: "Charts, moods, podcasts",
      icon: CompassIcon,
      onClick: onOpenBrowse,
    },
    {
      key: "history",
      label: "History",
      hint: "Everything you played",
      icon: ClockIcon,
      onClick: onOpenHistory,
      badge: history.length > 0 ? `${history.length} plays` : undefined,
    },
    {
      key: "downloads",
      label: "Downloads",
      hint: "Saved for offline",
      icon: DownloadIcon,
      onClick: onOpenDownloads,
      // A download in flight outranks the total: it is the thing that is changing.
      badge: offline.downloadingId
        ? offline.progress !== null
          ? `${offline.progress}%`
          : "downloading"
        : downloadCount > 0
          ? `${downloadCount} songs`
          : undefined,
    },
  ];

  return (
    <section className="flex flex-col gap-3" aria-label="Go to">
      <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(12rem,1fr))]">
        {cards.map((card) => (
          <motion.button
            key={card.key}
            type="button"
            onClick={card.onClick}
            whileHover={{ y: -2 }}
            whileTap={{ scale: 0.98 }}
            transition={{ type: "spring", stiffness: 520, damping: 34 }}
            className={cn(
              // `pl-12` is the icon's gutter: it ends at 38px, so the text clears it by 10px.
              "group/dest relative flex items-center overflow-hidden rounded-xl bg-card/80 p-3 pl-12 text-left",
              "transition-colors hover:bg-card",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            {/* Whole, not cropped at the edge: a half-hidden icon read as a layout bug (#183). */}
            <card.icon
              size={24}
              className="pointer-events-none absolute left-3.5 top-1/2 shrink-0 -translate-y-1/2 text-muted-foreground transition-colors group-hover/dest:text-primary"
              aria-hidden="true"
            />

            {/* `relative` puts the text above the absolutely positioned stamp. */}
            <span className="relative flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-sm font-semibold leading-none text-foreground">
                {card.label}
              </span>
              {/*
                Live state and the static hint are different kinds of thing, so they are not
                styled the same. A count is a reading — foreground, tabular so it cannot jitter
                as it changes. The hint is a description of a place you have not been yet.
              */}
              {card.badge ? (
                <span className="truncate text-xs font-medium tabular-nums text-foreground/75">
                  {card.badge}
                </span>
              ) : (
                <span className="truncate text-xs text-muted-foreground">{card.hint}</span>
              )}
            </span>
          </motion.button>
        ))}
      </div>
    </section>
  );
}
