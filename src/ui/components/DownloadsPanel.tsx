import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/motion/button";
import { Tooltip } from "@/components/motion/tooltip";
import { ArrowRightIcon, CheckIcon, CloseIcon, DownloadIcon, RefreshIcon } from "@/ui/icons";
import type { Track } from "../../datasource/types";
import { useOnline } from "../../internal/connectivity";
import {
  cancelDownload,
  getOfflineMaxBytes,
  retryDownload,
  selectDownloadList,
  useOfflineState,
  type DownloadList,
  type OfflineState,
} from "../../player/offlineStore";
import { useReduceMotion } from "../settings/renderEffects";
import { FloatingPanel } from "./FloatingPanel";
import { TrackArtwork } from "./TrackArtwork";

/** Newest first, and only a handful: the full list lives on the Downloads page. */
const RECENT_LIMIT = 4;
/** The rest of a long queue is a count, not rows; working through it is the Downloads page's job. */
const QUEUE_LIMIT = 4;
/** How long the toolbar icon reads "done" after the queue drains. */
const DONE_FLASH_MS = 1800;
const RING_RADIUS = 10;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function formatBytes(bytes: number): string {
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(bytes < 10 * 1024 ** 3 ? 2 : 1)} GB`;
}

const RELATIVE_TIME = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "narrow" });
const TIME_UNITS = [
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
] as const;

function formatAgo(timestamp: number): string {
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  for (const [unit, size] of TIME_UNITS) {
    if (Math.abs(seconds) >= size) return RELATIVE_TIME.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function describe(list: DownloadList, online: boolean, savedCount: number): string {
  const active = (list.active ? 1 : 0) + list.queued.length;
  if (active > 0 && !online) return `Paused · ${plural(active, "song")} waiting for a connection`;
  if (active > 0) return `Saving ${plural(active, "song")}`;
  if (list.failed.length > 0) return `${plural(list.failed.length, "song")} couldn't download`;
  if (savedCount > 0) return `All caught up · ${plural(savedCount, "song")} offline`;
  return "Nothing saved yet";
}

/** True for a moment after the queue empties cleanly: the only sign a closed panel gives that the work is done. */
function useDrainFlash(activeCount: number, failedCount: number): boolean {
  const [flash, setFlash] = useState(false);
  const previousActive = useRef(activeCount);

  useEffect(() => {
    if (previousActive.current > 0 && activeCount === 0 && failedCount === 0) setFlash(true);
    previousActive.current = activeCount;
  }, [activeCount, failedCount]);

  // Its own effect, so a count changing mid-flash cannot cancel the timer and leave it stuck on.
  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(false), DONE_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);

  return flash;
}

/**
 * Determinate where the size is known, a turning arc where it is not: a ring parked at 0% reads
 * as a stall rather than as "still measuring".
 */
function ProgressRing({
  progress,
  paused,
  still,
  className,
}: {
  progress: number | null;
  paused: boolean;
  still: boolean;
  className?: string;
}) {
  const fraction = progress === null ? 0.28 : progress / 100;
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={cn("-rotate-90", progress === null && !paused && !still && "animate-spin", className)}
    >
      <circle cx="12" cy="12" r={RING_RADIUS} fill="none" strokeWidth="2" className="stroke-muted" />
      <circle
        cx="12"
        cy="12"
        r={RING_RADIUS}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={RING_CIRCUMFERENCE * (1 - fraction)}
        className={cn(
          "transition-[stroke-dashoffset] duration-300",
          paused ? "stroke-muted-foreground" : "stroke-primary",
        )}
      />
    </svg>
  );
}

function IconAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip side="top" content={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="grid size-7 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {children}
      </button>
    </Tooltip>
  );
}

function Row({
  track,
  subtitle,
  subtitleTitle,
  animate,
  children,
}: {
  track: Track;
  subtitle: string;
  subtitleTitle?: string;
  animate: boolean;
  children?: ReactNode;
}) {
  return (
    <motion.li
      layout={animate ? "position" : false}
      initial={animate ? { opacity: 0, y: 4 } : false}
      animate={{ opacity: 1, y: 0 }}
      exit={animate ? { opacity: 0, transition: { duration: 0.12 } } : undefined}
      className={cn(
        "flex items-center gap-3 rounded-xl px-2 py-1.5",
        children && "transition-colors hover:bg-card focus-within:bg-card",
      )}
    >
      <TrackArtwork className="size-9 shrink-0 rounded-lg" size={36} artworkUrl={track.artworkUrl} iconSize={16} />
      {/* `min-w-0` is what lets both lines truncate instead of pushing the actions off the row. */}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm text-foreground">{track.title}</span>
        <span className="truncate text-xs text-muted-foreground" title={subtitleTitle}>
          {subtitle}
        </span>
      </span>
      {children && <span className="flex shrink-0 items-center">{children}</span>}
    </motion.li>
  );
}

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col">
      <div className="flex h-7 items-center justify-between gap-2 px-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {title}
          {count !== undefined && <span className="ml-1.5 tabular-nums text-muted-foreground/70">{count}</span>}
        </h3>
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className="rounded-md px-1.5 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {action.label}
          </button>
        )}
      </div>
      <ul className="flex flex-col">
        <AnimatePresence initial={false}>{children}</AnimatePresence>
      </ul>
    </section>
  );
}

function ActiveDownload({
  track,
  progress,
  still,
}: {
  track: Track;
  progress: number | null;
  still: boolean;
}) {
  return (
    <section aria-label="Downloading" className="rounded-2xl bg-card/50 p-3">
      <div className="flex items-center gap-3">
        <TrackArtwork className="size-11 shrink-0 rounded-xl" size={44} artworkUrl={track.artworkUrl} iconSize={18} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-foreground">{track.title}</span>
          <span className="truncate text-xs text-muted-foreground">{track.artist}</span>
        </span>
        <span className="w-9 shrink-0 text-right text-xs font-medium tabular-nums text-foreground">
          {progress === null ? "" : `${progress}%`}
        </span>
        <IconAction label={`Cancel download of ${track.title}`} onClick={() => cancelDownload(track.id)}>
          <CloseIcon size={15} aria-hidden="true" />
        </IconAction>
      </div>
      <div className="mt-3 h-1 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full bg-primary transition-[width] duration-300",
            progress === null && "w-1/3",
            progress === null && !still && "animate-pulse",
          )}
          style={progress === null ? undefined : { width: `${progress}%` }}
        />
      </div>
    </section>
  );
}

/** Mounted only while the panel is open, so the sorting and row work never runs for a closed one. */
function DownloadsContent({
  offline,
  online,
  reduceMotion,
  onOpenDownloads,
}: {
  offline: OfflineState;
  online: boolean;
  reduceMotion: boolean;
  onOpenDownloads?: () => void;
}) {
  const list = selectDownloadList(offline, RECENT_LIMIT);
  const { progress, usedBytes } = offline;
  const savedCount = Object.keys(offline.entries).length;
  const animate = !reduceMotion;
  const maxBytes = getOfflineMaxBytes();
  const used = maxBytes > 0 ? Math.min(1, usedBytes / maxBytes) : 0;
  const isEmpty = !list.active && list.queued.length === 0 && list.failed.length === 0 && list.recent.length === 0;
  const hiddenQueued = list.queued.length - QUEUE_LIMIT;

  return (
    <div className="flex flex-col gap-2">
      <header className="flex flex-col gap-2 px-2 pt-1">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-foreground">Downloads</h2>
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatBytes(usedBytes)} of {formatBytes(maxBytes)}
          </span>
        </div>
        <div
          role="meter"
          aria-label="Offline storage used"
          aria-valuemin={0}
          aria-valuemax={maxBytes}
          aria-valuenow={usedBytes}
          className="h-1 overflow-hidden rounded-full bg-muted"
        >
          <div
            className={cn(
              "h-full rounded-full transition-[width] duration-500",
              used > 0.9 ? "bg-destructive" : "bg-primary/70",
            )}
            style={{ width: `${used * 100}%` }}
          />
        </div>
        {/* Counts, never the percentage: a live region that re-announces every tick is noise. */}
        <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
          {describe(list, online, savedCount)}
        </p>
      </header>

      {isEmpty ? (
        <div className="flex flex-col items-center gap-3 px-6 py-8 text-center">
          <span className="grid size-12 place-items-center rounded-full bg-card/50 text-muted-foreground">
            <DownloadIcon size={20} aria-hidden="true" />
          </span>
          <span className="flex flex-col gap-1">
            <span className="text-sm font-medium text-foreground">No downloads yet</span>
            <span className="text-xs text-muted-foreground">
              Download a song, album or playlist to play it without a connection.
            </span>
          </span>
        </div>
      ) : (
        <div className="flex max-h-[min(28rem,65vh)] flex-col gap-2 overflow-y-auto">
          {list.active && <ActiveDownload track={list.active} progress={progress} still={reduceMotion} />}

          {list.queued.length > 0 && (
            <Section
              title={online ? "Up next" : "Waiting for connection"}
              count={list.queued.length}
              action={
                list.queued.length > 1
                  ? { label: "Cancel all", onClick: () => list.queued.forEach((track) => cancelDownload(track.id)) }
                  : undefined
              }
            >
              {list.queued.slice(0, QUEUE_LIMIT).map((track) => (
                <Row key={track.id} track={track} subtitle={track.artist} animate={animate}>
                  <IconAction label={`Remove ${track.title} from downloads`} onClick={() => cancelDownload(track.id)}>
                    <CloseIcon size={15} aria-hidden="true" />
                  </IconAction>
                </Row>
              ))}
              {hiddenQueued > 0 && (
                <li key="more" className="px-2 py-1 text-xs tabular-nums text-muted-foreground">
                  +{hiddenQueued} more
                </li>
              )}
            </Section>
          )}

          {list.failed.length > 0 && (
            <Section
              title="Couldn't download"
              count={list.failed.length}
              action={
                list.failed.length > 1
                  ? { label: "Retry all", onClick: () => list.failed.forEach(({ track }) => retryDownload(track.id)) }
                  : undefined
              }
            >
              {list.failed.map(({ track, message }) => (
                <Row key={track.id} track={track} subtitle={message} subtitleTitle={message} animate={animate}>
                  <IconAction label={`Retry ${track.title}`} onClick={() => retryDownload(track.id)}>
                    <RefreshIcon size={15} aria-hidden="true" />
                  </IconAction>
                  <IconAction label={`Dismiss ${track.title}`} onClick={() => cancelDownload(track.id)}>
                    <CloseIcon size={15} aria-hidden="true" />
                  </IconAction>
                </Row>
              ))}
            </Section>
          )}

          {list.recent.length > 0 && (
            <Section title="Recently saved">
              {list.recent.map((entry) => (
                <Row
                  key={entry.track.id}
                  track={entry.track}
                  subtitle={`${formatBytes(entry.byteLength)} · ${formatAgo(entry.downloadedAt)}`}
                  animate={animate}
                />
              ))}
            </Section>
          )}
        </div>
      )}

      {onOpenDownloads && (
        <button
          type="button"
          onClick={onOpenDownloads}
          className="flex items-center justify-between rounded-xl px-3 py-2 text-sm font-medium text-foreground transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {savedCount > 0 ? `Open downloads · ${savedCount}` : "Open downloads"}
          <ArrowRightIcon size={15} aria-hidden="true" className="text-muted-foreground" />
        </button>
      )}
    </div>
  );
}

/**
 * Downloads, as a toolbar button.
 *
 * Closed, the button carries the state on its own: a ring that fills with the current song, a
 * count of what is left, a dot when something failed, and a tick once the queue drains. The
 * badge counts what is *in flight*, not what is stored: a number that never goes back down is
 * a number nobody reads.
 */
export function DownloadsPanel({ onOpenDownloads }: { onOpenDownloads?: () => void }) {
  const [open, setOpen] = useState(false);
  const offline = useOfflineState();
  const online = useOnline();
  const reduceMotion = useReduceMotion();

  const transferring = Boolean(offline.downloadingId && offline.pending[offline.downloadingId]);
  const activeCount =
    (transferring ? 1 : 0) + offline.queued.filter((id) => id !== offline.downloadingId).length;
  const failedCount = Object.keys(offline.failed).length;
  const paused = activeCount > 0 && !online;
  const justFinished = useDrainFlash(activeCount, failedCount);

  const status = paused
    ? "Waiting for connection"
    : activeCount > 0
      ? `Downloading · ${activeCount} left`
      : failedCount > 0
        ? `${failedCount} couldn't download`
        : justFinished
          ? "All downloads saved"
          : null;

  return (
    <FloatingPanel
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      className="w-[22rem] max-w-[calc(100vw-2rem)] p-2"
      trigger={
        <Tooltip side="bottom" content={status ?? "Downloads"}>
          <Button
            variant="ghost"
            size="icon"
            className="relative"
            aria-label={status ? `Downloads: ${status}` : "Downloads"}
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {activeCount > 0 && (
              <ProgressRing
                className="absolute inset-1"
                progress={transferring ? offline.progress : 0}
                paused={paused}
                still={reduceMotion}
              />
            )}
            {justFinished && activeCount === 0 ? (
              <CheckIcon size={16} aria-hidden="true" className="text-primary" />
            ) : (
              <DownloadIcon
                size={activeCount > 0 ? 12 : 16}
                aria-hidden="true"
                className={cn(activeCount > 0 ? "text-foreground" : "opacity-40")}
              />
            )}
            {activeCount > 1 ? (
              <span
                aria-hidden="true"
                className="absolute -right-0.5 -top-0.5 min-w-3.5 rounded-full bg-primary px-1 text-[10px] font-semibold leading-3.5 tabular-nums text-primary-foreground"
              >
                {activeCount > 99 ? "99+" : activeCount}
              </span>
            ) : (
              failedCount > 0 &&
              activeCount === 0 && (
                <span aria-hidden="true" className="absolute right-1 top-1 size-2 rounded-full bg-destructive" />
              )
            )}
          </Button>
        </Tooltip>
      }
    >
      <DownloadsContent
        offline={offline}
        online={online}
        reduceMotion={reduceMotion}
        onOpenDownloads={
          onOpenDownloads &&
          (() => {
            setOpen(false);
            onOpenDownloads();
          })
        }
      />
    </FloatingPanel>
  );
}
