import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { ClockIcon, TrashIcon } from "@/ui/icons";
import type { Track } from "../../datasource/types";
import type { PlayerControllerActions } from "../../player/playerStore";
import {
  clearPlayHistory,
  removePlayHistoryEntry,
  usePlayHistory,
  type PlayHistoryEntry,
} from "../../player/playHistory";
import { TrackRow } from "../components/TrackRow";
import { useTrackContextMenu } from "../components/TrackContextMenu";
import { useNowPlaying } from "../hooks/useNowPlaying";

const DAY_MS = 86_400_000;

/** "Today" / "Yesterday" / a written date, so the list reads as a diary rather than a dump. */
function formatDayLabel(timestamp: number): string {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfDay = startOfToday.getTime();

  if (timestamp >= startOfDay) return "Today";
  if (timestamp >= startOfDay - DAY_MS) return "Yesterday";

  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === startOfToday.getFullYear();
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

interface HistoryDay {
  label: string;
  entries: PlayHistoryEntry[];
}

/**
 * Everything you have played, newest first, grouped by day.
 *
 * This is deliberately not the same thing as Home's "Recently played", which shows a handful
 * of distinct albums. Here every play is its own row with the time it happened, because the
 * question this page answers is "what was that song I had on last night?".
 */
export function HistoryPage({
  playerController,
}: {
  playerController: PlayerControllerActions;
}) {
  const entries = usePlayHistory();
  const { currentTrackId, isPlaying } = useNowPlaying();
  const { openTrackMenu, openPlaylistPicker } = useTrackContextMenu();
  const [confirmClear, setConfirmClear] = useState(false);

  const days = useMemo<HistoryDay[]>(() => {
    const grouped: HistoryDay[] = [];
    for (const entry of entries) {
      const label = formatDayLabel(entry.playedAt);
      const last = grouped[grouped.length - 1];
      if (last?.label === label) last.entries.push(entry);
      else grouped.push({ label, entries: [entry] });
    }
    return grouped;
  }, [entries]);

  // Playing from history queues the rest of that day, so it keeps going the way it did then.
  const playFrom = (day: HistoryDay, track: Track) => {
    const queue = day.entries.map((entry) => entry.track);
    void playerController.playTrackById(track.id, queue);
  };

  if (entries.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <span className="grid size-12 place-items-center rounded-full bg-card text-muted-foreground">
          <ClockIcon size={24} aria-hidden="true" />
        </span>
        <p className="text-sm font-medium text-foreground">No listening history yet</p>
        <p className="max-w-xs text-sm text-muted-foreground">
          Songs you play appear here with the time you played them.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <h1 className="text-3xl font-bold tracking-[-0.02em] text-foreground">History</h1>
          <p className="text-sm text-muted-foreground">
            {entries.length} {entries.length === 1 ? "play" : "plays"} across {days.length}{" "}
            {days.length === 1 ? "day" : "days"}
          </p>
        </div>

        {/* Two-step in place, like the playlist delete: destructive, but not worth a modal. */}
        <button
          type="button"
          onClick={() => {
            if (confirmClear) {
              clearPlayHistory();
              setConfirmClear(false);
              return;
            }
            setConfirmClear(true);
          }}
          onBlur={() => setConfirmClear(false)}
          className={cn(
            "flex shrink-0 items-center gap-2 rounded-full px-3.5 py-2 text-sm font-medium transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            confirmClear
              ? "bg-destructive/10 text-destructive"
              : "bg-card text-muted-foreground hover:text-foreground",
          )}
        >
          <TrashIcon size={16} aria-hidden="true" />
          {confirmClear ? "Click again to clear" : "Clear history"}
        </button>
      </header>

      {days.map((day) => (
        <section key={day.label} className="flex flex-col gap-2">
          {/* Sticky so the day you are scrolling through stays named. */}
          <h2 className="sticky top-0 z-10 -mx-2 bg-background/85 px-2 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground backdrop-blur">
            {day.label}
          </h2>

          <div className="flex flex-col gap-0.5">
            {day.entries.map((entry, index) => (
              <TrackRow
                key={`${entry.playedAt}:${entry.track.id}`}
                track={entry.track}
                index={index}
                showAlbum
                isCurrent={currentTrackId === entry.track.id}
                isPlaying={isPlaying && currentTrackId === entry.track.id}
                onSelect={() => playFrom(day, entry.track)}
                onContextMenu={(event) => openTrackMenu(event, entry.track)}
                onQuickAdd={() => openPlaylistPicker(entry.track)}
                showDownload

                showRating
                onQuickAddToQueue={() => playerController.addToQueue(entry.track)}
                trailing={
                  <span className="flex shrink-0 items-center gap-1">
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {formatTime(entry.playedAt)}
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`Remove ${entry.track.title} from history`}
                      className="grid size-7 place-items-center rounded-full text-muted-foreground opacity-0 transition hover:bg-background hover:text-foreground group-hover/row:opacity-100 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={(event) => {
                        event.stopPropagation();
                        removePlayHistoryEntry(entry.playedAt);
                      }}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        event.stopPropagation();
                        removePlayHistoryEntry(entry.playedAt);
                      }}
                    >
                      <TrashIcon size={14} aria-hidden="true" />
                    </span>
                  </span>
                }
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
