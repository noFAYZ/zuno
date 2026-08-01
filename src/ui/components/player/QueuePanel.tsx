import { memo, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Tooltip } from "@/components/motion/tooltip";
import {
  CheckIcon,
  ClockIcon,
  DiceIcon,
  PauseIcon,
  PlaylistAddIcon,
  ShuffleIcon,
  TrashIcon,
} from "@/ui/icons";
import { Loader, MusicVisualizer } from "@/components/motion/loader";
import { libraryController } from "../../../player/playerStore";
import { logInternalError } from "../../../internal/logging";
import type { Track } from "../../../datasource/types";
import {
  playerController,
  shallowEqual,
  usePlayerSelector,
  usePlayerSession,
} from "../../../player/playerStore";
import {
  toggleQueuePanelCollapsed,
  useQueuePanelCollapsed,
} from "../../settings/queuePanel";
import { ArtistLinks } from "../ArtistLinks";
import { TrackArtwork } from "../TrackArtwork";
import { SquareAltArrowLeftIcon, SquareAltArrowRightIcon } from "@solar-icons/react/linear";

interface QueuePanelProps {
  /** Open/close animation now lives in Layout's AnimatePresence wrapper. */
  isOpen?: boolean;
  onClose: () => void;
}

/** Pointer travel before a press becomes a drag rather than a click. */
const DRAG_SLOP_PX = 6;

const ICON_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

type QueueSection = "manual" | "automatic";

/** A queue entry paired with the absolute index the controller needs to act on it. */
interface QueueEntry {
  track: Track;
  /** Index into the whole queue — what removeFromQueueAt / moveQueueTrack expect. */
  absoluteIndex: number;
  /** 1-based position among upcoming tracks, for display. */
  position: number;
  section: QueueSection;
}

/** Sums across the sections in place; spreading them into one array copied every upcoming track. */
function formatRemaining(...sections: QueueEntry[][]): string | null {
  let seconds = 0;
  for (const section of sections) {
    for (const { track } of section) {
      // One missing duration makes the total a lie, so don't show one at all.
      if (!track.durationSec) return null;
      seconds += track.durationSec;
    }
  }
  if (seconds === 0) return null;

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  return hours > 0 ? `${hours} hr ${minutes} min` : `${minutes} min`;
}

/**
 * One row of the queue.
 *
 * Memoised because an auto-queue is routinely 25+ tracks and the panel re-renders on every
 * player emit — including once per track change. Every prop here is a primitive or a stable
 * reference, so the comparison actually holds.
 */
const QueueRow = memo(function QueueRow({
  entry,
  collapsed,
  isDragged,
  isStopAfter,
  isGenerating,
  dropEdge,
  onPlay,
  onRemove,
  onStopAfter,
  onGenerateAfter,
  onPointerDown,
}: {
  entry: QueueEntry;
  collapsed: boolean;
  isDragged: boolean;
  /** Playback stops once this entry finishes. */
  isStopAfter: boolean;
  isGenerating: boolean;
  dropEdge: "before" | "after" | null;
  onPlay: (absoluteIndex: number) => void;
  onRemove: (absoluteIndex: number) => void;
  onStopAfter: (absoluteIndex: number) => void;
  onGenerateAfter: (absoluteIndex: number) => void;
  onPointerDown: (
    event: React.PointerEvent<HTMLButtonElement>,
    absoluteIndex: number,
    section: QueueSection,
  ) => void;
}) {
  const { track, absoluteIndex, position, section } = entry;

  const row = (
    <div
      data-queue-index={absoluteIndex}
      data-queue-section={section}
      className={cn(
        "group/queue-item relative flex items-center rounded transition-colors hover:bg-card",
        // The pointer handler writes --drag-translation; this is what renders the lift.
        "[transform:translateY(var(--drag-translation,0px))]",
        collapsed ? "justify-center" : "gap-1",
        isDragged && "opacity-40",
        // The stop marker has to read without hovering, so it draws a rule under the row —
        // the queue visibly ends here.
        isStopAfter && "after:absolute after:inset-x-2 after:-bottom-px after:h-px after:bg-primary/70",
        dropEdge === "before" &&
          "before:absolute before:inset-x-2 before:-top-px before:h-0.5 before:rounded-full before:bg-primary",
        dropEdge === "after" &&
          "after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-primary",
      )}
    >
      <button
        type="button"
        className={cn(
          "flex min-w-0 items-center rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          collapsed ? "p-1.5" : "flex-1 gap-2.5 p-1.5",
        )}
        onPointerDown={(event) => onPointerDown(event, absoluteIndex, section)}
        onClick={() => onPlay(absoluteIndex)}
        aria-label={collapsed ? `Play ${track.title}` : undefined}
      >
        {/* The cover carries the position and the play affordance so the row needs no
            separate number column — that is what buys back the width when collapsed. */}
        <span className="relative shrink-0">
          <TrackArtwork
            className={cn("rounded", collapsed ? "size-11" : "size-10")}
            size={collapsed ? 44 : 40}
            artworkUrl={track.artworkUrl}
            iconSize={collapsed ? 20 : 18}
          />
          <span
            className={cn(
              "absolute inset-0 grid place-items-center rounded-lg bg-background/70 text-[11px] font-semibold tabular-nums text-foreground backdrop-blur-[2px]",
              "opacity-0 transition-opacity group-hover/queue-item:opacity-100",
            )}
            aria-hidden="true"
          >
            {position}
          </span>
        </span>

        {!collapsed && (
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm text-foreground">{track.title}</span>
            <ArtistLinks
              className="truncate text-xs text-muted-foreground"
              artists={track.artists}
              fallback={track.artist}
            />
          </span>
        )}
      </button>

      {!collapsed && (
        <span
          className={cn(
            "mr-1 flex shrink-0 items-center transition-opacity",
            // The stop marker stays visible unhovered — it is state, not an affordance.
            isStopAfter
              ? "opacity-100"
              : "opacity-0 focus-within:opacity-100 group-hover/queue-item:opacity-100",
          )}
        >
          <Tooltip content={isStopAfter ? "Don't end queue here" : "End queue after this"}>
            <button
              type="button"
              className={cn(ICON_BUTTON, isStopAfter && "text-primary")}
              onClick={() => onStopAfter(absoluteIndex)}
              aria-pressed={isStopAfter}
            >
              <PauseIcon size={15} aria-hidden="true" />
              <span className="sr-only">
                {isStopAfter ? "Don't end queue here" : "End queue after this"}
              </span>
            </button>
          </Tooltip>
          <Tooltip content="Generate a new queue from here">
            <button
              type="button"
              className={cn(ICON_BUTTON, isGenerating && "text-primary")}
              disabled={isGenerating}
              onClick={() => onGenerateAfter(absoluteIndex)}
            >
              <DiceIcon
                size={15}
                aria-hidden="true"
                className={isGenerating ? "motion-safe:animate-spin" : undefined}
              />
              <span className="sr-only">Generate a new queue from here</span>
            </button>
          </Tooltip>
          <Tooltip content="Remove from queue">
            <button
              type="button"
              className={cn(ICON_BUTTON, "hover:text-primary")}
              onClick={() => onRemove(absoluteIndex)}
            >
              <TrashIcon size={15} aria-hidden="true" />
              <span className="sr-only">{`Remove ${track.title} from queue`}</span>
            </button>
          </Tooltip>
        </span>
      )}
    </div>
  );

  // Collapsed hides the title, so the tooltip is the only way to read the row. Expanded
  // already shows everything, and a tooltip on every row would be noise.
  if (!collapsed) return row;
  return (
    <Tooltip
      side="left"
      content={
        <span className="flex flex-col">
          <span className="font-medium">{track.title}</span>
          <span className="text-muted-foreground">{track.artist}</span>
        </span>
      }
    >
      {row}
    </Tooltip>
  );
});

export function QueuePanel({ onClose }: QueuePanelProps) {
  const panelRef = useRef<HTMLElement>(null);
  const draggedElementRef = useRef<HTMLElement | null>(null);
  const captureElementRef = useRef<HTMLElement | null>(null);
  const pointerDragRef = useRef<{
    pointerId: number;
    sourceIndex: number;
    section: QueueSection;
    startX: number;
    startY: number;
    isDragging: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    index: number;
    insertAfter: boolean;
  } | null>(null);
  /*
   * The drop target is read inside a window listener that must not be torn down and rebuilt
   * on every pointermove — that is what the previous version did, since dropTarget was in the
   * effect's dependency list. The ref carries the value; the state only drives the paint.
   */
  const dropTargetRef = useRef(dropTarget);
  dropTargetRef.current = dropTarget;

  const collapsed = useQueuePanelCollapsed();
  const playerSession = usePlayerSession();
  const playerState = usePlayerSelector(
    (player) => ({ currentTrack: player.currentTrack, status: player.status }),
    shallowEqual,
  );
  const currentTrack = playerState.currentTrack;
  const isPlaying = playerState.status === "playing";

  const queue = playerSession?.queue ?? [];
  const queueIndex = playerSession?.queueIndex ?? -1;
  const manualQueueLength = playerSession?.manualQueueLength ?? 0;
  const stopAfterQueueIndex = playerSession?.stopAfterQueueIndex ?? null;
  // Generating hits the network, so the row it was started from shows it is working.
  const [generatingIndex, setGeneratingIndex] = useState<number | null>(null);
  /* null = idle, string = the draft name being edited. */
  const [saveDraft, setSaveDraft] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");

  /*
   * One flat pass over the upcoming tracks, tagged with everything a row needs. The old panel
   * sliced the queue three times and then recomputed the same absolute index inline at four
   * different call sites, each with its own `upcomingStartIndex + manualQueueLength + index`
   * arithmetic — which is exactly the sort of thing that drifts out of sync.
   */
  const { manual, automatic } = useMemo(() => {
    const start = Math.max(queueIndex + 1, 0);
    const manualEntries: QueueEntry[] = [];
    const automaticEntries: QueueEntry[] = [];

    for (let offset = 0; start + offset < queue.length; offset += 1) {
      const entry: QueueEntry = {
        track: queue[start + offset],
        absoluteIndex: start + offset,
        position: offset + 1,
        section: offset < manualQueueLength ? "manual" : "automatic",
      };
      (entry.section === "manual" ? manualEntries : automaticEntries).push(entry);
    }

    return { manual: manualEntries, automatic: automaticEntries };
  }, [manualQueueLength, queue, queueIndex]);

  const upcomingCount = manual.length + automatic.length;
  /*
   * Summed over the two lists in place rather than by spreading them into a third.
   *
   * `manual` and `automatic` are rebuilt whenever the queue array identity changes — which is
   * on every session export, not only when the queue actually changes — so this ran a full
   * copy plus a pass over every upcoming track far more often than the contents moved.
   */
  const remaining = useMemo(
    () => formatRemaining(manual, automatic),
    [automatic, manual],
  );

  const handleRemove = (absoluteIndex: number) => {
    playerController.removeFromQueueAt(absoluteIndex);
  };

  /*
   * Saves what is *upcoming* plus the track playing now — the queue as you see it. Tracks
   * already behind the playhead are history, and silently including them would produce a
   * playlist that does not match the panel it was made from.
   */
  const handleSaveQueue = async () => {
    if (saveDraft === null || saveState === "saving") return;
    const title = saveDraft.trim();
    if (!title) return;

    const trackIds = [
      ...(currentTrack ? [currentTrack.id] : []),
      ...manual.map((entry) => entry.track.id),
      ...automatic.map((entry) => entry.track.id),
    ].filter((id) => !id.startsWith("local:"));

    setSaveState("saving");
    try {
      await libraryController.createPlaylist(title, { trackIds });
      setSaveDraft(null);
      setSaveState("saved");
      window.setTimeout(() => setSaveState("idle"), 2000);
    } catch (error) {
      logInternalError("QueuePanel.saveQueueAsPlaylist failed", error);
      setSaveState("idle");
    }
  };

  const handleStopAfter = (absoluteIndex: number) => {
    playerController.setStopAfterQueueIndex(absoluteIndex);
  };

  const handleGenerateAfter = async (absoluteIndex: number) => {
    setGeneratingIndex(absoluteIndex);
    try {
      await playerController.generateQueueAfter(absoluteIndex);
    } finally {
      setGeneratingIndex(null);
    }
  };

  const handlePlay = (absoluteIndex: number) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    void playerController.playQueueTrackAt(absoluteIndex);
  };

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

      if (!drag.isDragging) {
        const distance = Math.hypot(
          event.clientX - drag.startX,
          event.clientY - drag.startY,
        );
        if (distance < DRAG_SLOP_PX) return;
        drag.isDragging = true;
        setDraggedIndex(drag.sourceIndex);
      }

      event.preventDefault();
      const translationY = event.clientY - drag.startY;
      draggedElementRef.current?.style.setProperty(
        "--drag-translation",
        `${translationY}px`,
      );

      // Reordering across the manual/automatic boundary is rejected by Queue.move, so the
      // drop indicator must never suggest it is possible.
      const items = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>("[data-queue-index]") ?? [],
      ).filter((item) =>
        Number(item.dataset.queueIndex) !== drag.sourceIndex
        && item.dataset.queueSection === drag.section,
      );

      if (items.length === 0) {
        setDropTarget(null);
        return;
      }

      let targetElement = document
        .elementsFromPoint(event.clientX, event.clientY)
        .map((element) => element.closest<HTMLElement>("[data-queue-index]"))
        .find((item) =>
          Boolean(item)
          && Number(item?.dataset.queueIndex) !== drag.sourceIndex
          && item?.dataset.queueSection === drag.section,
        ) ?? null;

      const panelBounds = panelRef.current?.getBoundingClientRect();
      if (panelBounds && event.clientY < panelBounds.top) {
        targetElement = items[0];
      } else if (panelBounds && event.clientY > panelBounds.bottom) {
        targetElement = items[items.length - 1];
      } else if (!targetElement) {
        targetElement = items.reduce<HTMLElement | null>((closest, item) => {
          if (!closest) return item;
          const itemBounds = item.getBoundingClientRect();
          const closestBounds = closest.getBoundingClientRect();
          const itemCenter = itemBounds.top + itemBounds.height / 2;
          const closestCenter = closestBounds.top + closestBounds.height / 2;
          return Math.abs(itemCenter - event.clientY)
            < Math.abs(closestCenter - event.clientY)
            ? item
            : closest;
        }, null);
      }

      if (!targetElement) {
        setDropTarget(null);
        return;
      }

      const targetIndex = Number(targetElement.dataset.queueIndex);
      const bounds = targetElement.getBoundingClientRect();
      const insertAfter = event.clientY >= bounds.top + bounds.height / 2;
      const current = dropTargetRef.current;
      if (current?.index === targetIndex && current.insertAfter === insertAfter) return;
      setDropTarget({ index: targetIndex, insertAfter });
    };

    const handlePointerUp = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

      const drop = dropTargetRef.current;
      if (drag.isDragging && drop && drop.index !== drag.sourceIndex) {
        playerController.moveQueueTrack(drag.sourceIndex, drop.index, drop.insertAfter);
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }

      pointerDragRef.current = null;
      draggedElementRef.current?.style.removeProperty("--drag-translation");
      draggedElementRef.current?.style.removeProperty("will-change");
      captureElementRef.current?.releasePointerCapture?.(event.pointerId);
      draggedElementRef.current = null;
      captureElementRef.current = null;
      setDraggedIndex(null);
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
  }, []);

  const handleTrackPointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
    absoluteIndex: number,
    section: QueueSection,
  ) => {
    if (event.button !== 0) return;
    const trackItem = event.currentTarget.closest<HTMLElement>("[data-queue-index]");
    if (!trackItem) return;

    pointerDragRef.current = {
      pointerId: event.pointerId,
      sourceIndex: absoluteIndex,
      section,
      startX: event.clientX,
      startY: event.clientY,
      isDragging: false,
    };
    draggedElementRef.current = trackItem;
    captureElementRef.current = event.currentTarget;
    event.currentTarget.setPointerCapture(event.pointerId);
    trackItem.style.willChange = "transform";
  };

  const renderRows = (entries: QueueEntry[]) =>
    entries.map((entry) => (
      <QueueRow
        key={`${entry.track.id}:${entry.absoluteIndex}`}
        entry={entry}
        collapsed={collapsed}
        isDragged={draggedIndex === entry.absoluteIndex}
        isStopAfter={stopAfterQueueIndex === entry.absoluteIndex}
        isGenerating={generatingIndex === entry.absoluteIndex}
        dropEdge={
          dropTarget?.index === entry.absoluteIndex
            ? (dropTarget.insertAfter ? "after" : "before")
            : null
        }
        onPlay={handlePlay}
        onRemove={handleRemove}
        onStopAfter={handleStopAfter}
        onGenerateAfter={(index) => void handleGenerateAfter(index)}
        onPointerDown={handleTrackPointerDown}
      />
    ));

  const sectionLabel = (label: string, count: number) =>
    collapsed ? (
      // A hairline instead of a heading: at 76px a word would either truncate or wrap.
      <span
        className="mx-auto my-1.5 h-px w-6 rounded-full bg-border"
        role="separator"
        aria-label={label}
      />
    ) : (
      <div className="flex items-baseline justify-between gap-2 px-2 pb-1.5 pt-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground">{count}</span>
      </div>
    );

  return (
    <aside
      ref={panelRef}
      className={cn(
        "flex h-full flex-col overflow-y-auto overscroll-contain",
        // Dragging over rows must not select their text.
        draggedIndex !== null && "select-none",
      )}
      aria-label="Queue"
    >
      <header
        className={cn(
          "sticky top-0 z-10 flex shrink-0 items-center gap-1 bg-card",
          collapsed ? "flex-col px-2 py-2" : "px-3 py-2.5",
        )}
      >
        <Tooltip
          side={collapsed ? "left" : "bottom"}
          content={collapsed ? "Expand queue" : "Collapse queue"}
        >
          <button type="button" className={ICON_BUTTON} onClick={toggleQueuePanelCollapsed}>
            {collapsed ? (
              <SquareAltArrowLeftIcon size={22} aria-hidden="true" />
            ) : (
              <SquareAltArrowRightIcon size={22} aria-hidden="true" />
            )}
            <span className="sr-only">{collapsed ? "Expand queue" : "Collapse queue"}</span>
          </button>
        </Tooltip>

        {!collapsed && (
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 className="text-sm font-semibold text-foreground">Up next</h2>
            <p className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
              <span>{upcomingCount === 0 ? "Nothing queued" : `${upcomingCount} songs`}</span>
              {remaining && (
                <>
                  <ClockIcon size={11} aria-hidden="true" />
                  <span>{remaining}</span>
                </>
              )}
            </p>
          </div>
        )}

        {!collapsed && upcomingCount > 0 && (
          <>
            <Tooltip content="Shuffle what's next">
              <button
                type="button"
                className={ICON_BUTTON}
                onClick={() => playerController.shuffleUpcomingQueue()}
              >
                <ShuffleIcon size={16} aria-hidden="true" />
                <span className="sr-only">Shuffle what's next</span>
              </button>
            </Tooltip>
            <Tooltip content="Save the queue as a playlist">
              <button
                type="button"
                className={cn(ICON_BUTTON, saveState === "saved" && "text-primary")}
                onClick={() => setSaveDraft((draft) => (draft === null ? "My queue" : null))}
                aria-expanded={saveDraft !== null}
              >
                {saveState === "saving" ? (
                  <Loader variant="spinner" size={15} />
                ) : saveState === "saved" ? (
                  <CheckIcon size={16} aria-hidden="true" />
                ) : (
                  <PlaylistAddIcon size={16} aria-hidden="true" />
                )}
                <span className="sr-only">Save the queue as a playlist</span>
              </button>
            </Tooltip>
            <Tooltip content="Clear the queue">
              <button
                type="button"
                className={cn(ICON_BUTTON, "hover:text-primary")}
                onClick={() => playerController.clearUpcomingQueue()}
              >
                <TrashIcon size={16} aria-hidden="true" />
                <span className="sr-only">Clear the queue</span>
              </button>
            </Tooltip>
          </>
        )}
      </header>

      {/* Opens under the header so the queue it is about stays in view. */}
      {!collapsed && saveDraft !== null && (
        <div className="mx-2 mb-1 flex shrink-0 flex-col gap-2 rounded-xl bg-card p-2">
          <input
            autoFocus
            value={saveDraft}
            onChange={(event) => setSaveDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void handleSaveQueue();
              if (event.key === "Escape") setSaveDraft(null);
            }}
            aria-label="New playlist name"
            className="w-full min-w-0 rounded-lg bg-background px-2.5 py-1.5 text-sm text-foreground outline-none focus:ring-1 focus:ring-inset focus:ring-border"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">
              {upcomingCount + (currentTrack ? 1 : 0)} songs
            </span>
            <div className="flex gap-1.5">
              <button
                type="button"
                className="rounded-full px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setSaveDraft(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={saveState === "saving" || !saveDraft.trim()}
                className="rounded-full bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-transform hover:scale-[1.02] active:scale-95 disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => void handleSaveQueue()}
              >
                {saveState === "saving" ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* The track playing right now, pinned above the list. Without it the panel opens on a
          list of songs with no anchor — you can see what is next but not what it follows. */}
      {currentTrack && (
        <div
          className={cn(
            "flex shrink-0 items-center rounded bg-primary/5",
            collapsed ? "mx-2 mb-1 justify-center p-1.5" : "mx-2 mb-1 gap-2.5 p-2",
          )}
        >
          <span className="relative shrink-0">
            <TrackArtwork
              className={cn(
                "rounded ring-1 ring-primary/60",
                collapsed ? "size-11" : "size-10",
              )}
              size={collapsed ? 44 : 40}
              artworkUrl={currentTrack.artworkUrl}
              iconSize={collapsed ? 20 : 18}
            />
            {/*
              The same meter the track rows use — one now-playing indicator across the app,
              rather than two hand-rolled ones that drift apart.

              On a scrim covering the whole cover, not floated over the bottom edge: these are
              accent-tinted bars a few pixels tall, and against a busy album cover they were
              effectively invisible. Same treatment as the hover position badge below.
            */}
            {isPlaying && (
              <span
                className="absolute inset-0 grid place-items-center rounded bg-background/60 backdrop-blur-[2px]"
                aria-hidden="true"
              >
                <MusicVisualizer
                  bars={4}
                  className="[--music-gap:2px] [--music-height:16px] [--music-width:20px]"
                />
              </span>
            )}
          </span>

          {!collapsed && (
            <span className="flex min-w-0 flex-col">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">
                {isPlaying ? "Now playing" : "Paused"}
              </span>
              <span className="truncate text-sm font-medium text-foreground">
                {currentTrack.title}
              </span>
              <ArtistLinks
                className="truncate text-xs text-muted-foreground"
                artists={currentTrack.artists}
                fallback={currentTrack.artist}
              />
            </span>
          )}
        </div>
      )}

      {upcomingCount === 0 ? (
        collapsed ? null : (
          <p className="px-3 py-8 text-center text-sm text-muted-foreground">
            Nothing queued. Songs you add with "Play next" land here.
          </p>
        )
      ) : (
        <div className={cn("flex flex-col gap-0.5 pb-2", collapsed ? "px-1.5" : "px-2")}>
          {manual.length > 0 && (
            <>
              {sectionLabel("Added by you", manual.length)}
              {renderRows(manual)}
            </>
          )}
          {automatic.length > 0 && (
            <>
              {manual.length > 0 && sectionLabel("Up next", automatic.length)}
              {renderRows(automatic)}
            </>
          )}
        </div>
      )}

      {/* Collapsed has no room for a close button in the header, and the player bar's queue
          button already closes the panel, so this only exists when expanded. */}
      {!collapsed && (
        <button
          type="button"
          className="mx-2 mb-2 mt-auto shrink-0 rounded py-1.5 text-xs text-muted-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onClose}
        >
          Hide queue
        </button>
      )}
    </aside>
  );
}
