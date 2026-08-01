import {
  memo,
  useCallback,
  useRef,
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { propsEqualIgnoringHandlers } from "../../internal/propsEqual";
import { Tooltip } from "@/components/motion/tooltip";
import { CheckActiveIcon, CheckIcon, DislikeActiveIcon, DislikeIcon, DownloadIcon, HeartActiveIcon, HeartIcon, ListIcon, PlaylistAddIcon, PlayActiveIcon } from "@/ui/icons";
import { Loader, MusicVisualizer } from "@/components/motion/loader";
import {
  getOfflineStatus,
  queueDownload,
  removeDownload,
  useOfflineState,
} from "../../player/offlineStore";
import type { Track, TrackRating } from "../../datasource/types";
import { libraryController, useLibraryState } from "../../player/playerStore";
import { useTrackContextMenu } from "./TrackContextMenu";
import { ArtistLinks } from "./ArtistLinks";
import { TrackArtwork } from "./TrackArtwork";

/**
 * Anything else a caller needs on the underlying button — the playlist page attaches
 * pointer handlers and a data attribute here for drag-reorder. `onClick` and `onContextMenu`
 * are owned by this component, so they are excluded to keep one source of truth.
 */
type PassthroughButtonProps = Omit<
  ComponentPropsWithoutRef<"button">,
  "onClick" | "onContextMenu" | "onSelect" | "children" | "className" | "type"
>;

interface TrackRowProps extends PassthroughButtonProps {
  track: Track;
  /** Zero-based; rendered as the 1-based position. */
  index: number;
  /** This is the track the player is on, whether or not it is currently advancing. */
  isCurrent: boolean;
  /** Current *and* actually playing — drives the level meter over the static glyph. */
  isPlaying: boolean;
  onSelect: (event: MouseEvent<HTMLElement>) => void;
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void;
  /** Shows a quick "add to playlist" affordance on hover. Omit to hide it. */
  onQuickAdd?: () => void;
  /** Shows a quick "add to queue" affordance on hover. Omit to hide it. */
  onQuickAddToQueue?: () => void;
  /** Shows a download-for-offline toggle. Omit on rows where it makes no sense. */
  showDownload?: boolean;
  /** Shows like/dislike. Omit where a rating makes no sense, e.g. local-only lists. */
  showRating?: boolean;
  /** Part of a multi-selection. Swaps the index column for a checkbox. */
  isSelected?: boolean;
  /** True while any row in the list is selected, so every row shows its checkbox. */
  isSelectionActive?: boolean;
  onToggleSelected?: () => void;
  /** Album pages repeat one cover on every row, so they opt out. */
  showArtwork?: boolean;
  /** Hides the artist whose page we are already on. */
  suppressArtistId?: string;
  /** Right-aligned extras — play counts, durations, remove buttons. */
  trailing?: ReactNode;
  className?: string;
  /** Rendered inside the row: drag indicators and the like. */
  children?: ReactNode;
}

/**
 * Download-for-offline toggle.
 *
 * Unlike the other hover actions this one stays visible once a track is downloaded — that is
 * state you need to see without hovering, the same reasoning as the queue's stop marker.
 */
function DownloadAction({ track }: { track: Track }) {
  // Subscribing here rather than in TrackRow keeps download churn from re-rendering the
  // whole row, which matters on a 500-row playlist while a queue is draining.
  const offline = useOfflineState();
  const status = getOfflineStatus(track.id);
  const isDownloading = status === "downloading";

  if (track.source === "local") return null;

  const label = status === "ready"
    ? `Remove ${track.title} from downloads`
    : `Download ${track.title}`;

  return (
    <Tooltip content={status === "ready" ? "Downloaded — click to remove" : "Download"}>
      <span
        role="button"
        tabIndex={0}
        aria-label={label}
        aria-pressed={status === "ready"}
        className={cn(
          "grid shrink-0 place-items-center rounded-full transition",
          // The percent readout needs more room than a glyph, so the slot widens only while
          // it is showing rather than reserving the space on every row forever.
          isDownloading ? "h-8 w-12" : "size-8",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          status === "ready"
            ? "text-primary opacity-100"
            : "text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover/row:opacity-100 focus:opacity-100",
          (status === "queued" || status === "downloading") && "opacity-100",
          status === "failed" && "text-destructive opacity-100",
        )}
        onClick={(event) => {
          event.stopPropagation();
          if (status === "ready") void removeDownload(track.id);
          else queueDownload(track);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          if (status === "ready") void removeDownload(track.id);
          else queueDownload(track);
        }}
      >
        {isDownloading ? (
          /* Fed by the real byte count streamed from Rust. When the response has no
             Content-Length the store reports null and this falls back to the sweeping
             animation, which is honest about not knowing. */
          <Loader
            variant="percent"
            size={18}
            value={offline.progress ?? undefined}
            label={`Downloading ${track.title}`}
          />
        ) : status === "queued" ? (
          <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
        ) : status === "ready" ? (
          <CheckActiveIcon size={16} aria-hidden="true" />
        ) : (
          <DownloadIcon size={16} aria-hidden="true" />
        )}
      </span>
    </Tooltip>
  );
}

/**
 * A hover action inside the row.
 *
 * A span with role="button" rather than a <button>: the row itself is a button, and nesting
 * one inside another is invalid and gets flattened by the parser. The click must not fall
 * through either, or "add to queue" would also start the song playing.
 */
function QuickAction({
  label,
  tooltip,
  onActivate,
  children,
}: {
  label: string;
  tooltip: string;
  onActivate: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip content={tooltip}>
      <span
        role="button"
        tabIndex={0}
        aria-label={label}
        className={cn(
          "grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground",
          "opacity-0 transition hover:bg-background hover:text-foreground",
          "group-hover/row:opacity-100 focus:opacity-100",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
        onClick={(event) => {
          event.stopPropagation();
          onActivate();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          event.stopPropagation();
          onActivate();
        }}
      >
        {children}
      </span>
    </Tooltip>
  );
}

/**
 * Like and dislike, as a pair.
 *
 * Shown together rather than as one cycling control: a rating has three states, and a single
 * button that walks like → dislike → none makes the user guess where they are in the cycle.
 * Two buttons say what they will do and which one is active.
 *
 * The active one stays visible when set — hiding a rating until hover would mean you cannot see
 * what you rated without hunting for it — while the inactive one appears on hover like the
 * other row actions.
 */
function RatingActions({ track }: { track: Track }) {
  const { rateTrack } = useTrackContextMenu();
  const libraryState = useLibraryState();

  // Local files have no YouTube rating to set, and a signed-out session has nowhere to put one.
  if (track.source === "local") return null;

  const rating = libraryController.getTrackRating(track.id);
  const isPending = libraryState.pendingLikeTrackIds.has(track.id);

  const button = (target: Exclude<TrackRating, "none">, icon: ReactNode, label: string) => {
    const isActive = rating === target;
    return (
      <Tooltip content={isActive ? `Undo ${label.toLowerCase()}` : label}>
        <span
          role="button"
          tabIndex={0}
          aria-label={isActive ? `Undo ${label.toLowerCase()} for ${track.title}` : `${label} ${track.title}`}
          aria-pressed={isActive}
          aria-busy={isPending}
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-full transition",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isPending && "pointer-events-none opacity-50",
            isActive
              ? "text-primary opacity-100"
              : "text-muted-foreground opacity-0 hover:bg-background hover:text-foreground group-hover/row:opacity-100 focus:opacity-100",
          )}
          onClick={(event) => {
            event.stopPropagation();
            // Pressing the active rating clears it, which is the only way back to neutral.
            void rateTrack(track, isActive ? "none" : target);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            void rateTrack(track, isActive ? "none" : target);
          }}
        >
          {icon}
        </span>
      </Tooltip>
    );
  };

  return (
    <span className="flex shrink-0 items-center">
      {button(
        "like",
        rating === "like" ? <HeartActiveIcon size={17} /> : <HeartIcon size={17} />,
        "Like",
      )}
      {button(
        "dislike",
        rating === "dislike" ? <DislikeActiveIcon size={17} /> : <DislikeIcon size={17} />,
        "Dislike",
      )}
    </span>
  );
}

/**
 * One track in a list, shared by the playlist, album and artist pages.
 *
 * Those three had drifted into three different rows — only one showed artwork, only one
 * showed what was playing, and each styled its title differently. Sharing them means the
 * now-playing treatment is defined once and cannot fall out of sync again.
 *
 * Memoised on purpose. The lists subscribe to player state so they can mark the current
 * track, which re-renders the list on every track change; without this, a 500-row playlist
 * would rebuild every row to repaint two of them.
 *
 * The memo only started working when the handlers stopped being compared. Every call site
 * passes inline arrows — `onSelect={(e) => playSong(track, index, e)}` and four more — so all
 * five differed on every render and the default comparison never once returned true. The
 * handlers are now invoked through a ref refreshed on each render, which makes their identity
 * irrelevant: they only ever fire from events, long after the render that supplied them.
 *
 * `trailing` and `children` are still compared, and a call site passing fresh JSX for either
 * will still re-render its rows. That is honest — those are content, not callbacks.
 */
/**
 * The explicit-content stamp.
 *
 * A muted square rather than the brand accent: it is a content warning, not a feature, and
 * in red it would read as the app drawing attention to the song rather than labelling it.
 * The letter is decorative — the accessible name is the full word, since "E" read aloud on
 * its own means nothing.
 */
function ExplicitBadge() {
  return (
    <span
      title="Explicit"
      aria-label="Explicit"
      role="img"
      className="grid size-[15px] shrink-0 place-items-center rounded-[3px] bg-muted-foreground/85 text-[10px] font-bold leading-none text-background"
    >
      <span aria-hidden="true">E</span>
    </span>
  );
}

/** Shared by the always-on slot and the hover affordance, so the two cannot drift apart. */
function SelectionCheckbox({
  title,
  isSelected,
  onToggle,
}: {
  title: string;
  isSelected: boolean;
  onToggle: () => void;
}) {
  return (
    <span
      role="checkbox"
      aria-checked={isSelected}
      tabIndex={0}
      aria-label={`Select ${title}`}
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-md border transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        isSelected
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border text-transparent hover:border-muted-foreground",
      )}
      onClick={(event) => {
        // Without this the row's own click handler also fires and starts playback.
        event.stopPropagation();
        onToggle();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
    >
      <CheckIcon size={14} aria-hidden="true" />
    </span>
  );
}

export const TrackRow = memo(function TrackRow({
  track,
  index,
  isCurrent,
  isPlaying,
  onSelect,
  onContextMenu,
  onQuickAdd,
  onQuickAddToQueue,
  showDownload = false,
  showRating = false,
  isSelected = false,
  isSelectionActive = false,
  onToggleSelected,
  showArtwork = true,
  suppressArtistId,
  trailing,
  className,
  children,
  ...buttonProps
}: TrackRowProps) {
  /*
   * The handlers, read at call time instead of captured at render time.
   *
   * This is what lets `trackRowPropsEqual` ignore their identity: the wrappers below never
   * change, but always reach the newest closure, so a row that skipped a render still acts on
   * current state when you click it.
   */
  const handlersRef = useRef({
    onSelect,
    onContextMenu,
    onQuickAdd,
    onQuickAddToQueue,
    onToggleSelected,
  });
  handlersRef.current = {
    onSelect,
    onContextMenu,
    onQuickAdd,
    onQuickAddToQueue,
    onToggleSelected,
  };

  const handleSelect = useCallback(
    (event: MouseEvent<HTMLElement>) => handlersRef.current.onSelect(event),
    [],
  );
  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLElement>) => handlersRef.current.onContextMenu?.(event),
    [],
  );
  const handleQuickAdd = useCallback(() => handlersRef.current.onQuickAdd?.(), []);
  const handleQuickAddToQueue = useCallback(
    () => handlersRef.current.onQuickAddToQueue?.(),
    [],
  );
  const handleToggleSelected = useCallback(() => handlersRef.current.onToggleSelected?.(), []);

  /* Whether this list does multi-select at all. Browse and search rows do not pass a handler,
     and must keep their play-on-hover glyph rather than gain a checkbox that does nothing. */
  const canSelect = Boolean(onToggleSelected);

  return (
    <button
      {...buttonProps}
      type="button"
      onClick={handleSelect}
      /* Kept conditional: whether the prop was supplied still decides whether a handler is
         attached at all, only its identity is ignored. */
      onContextMenu={onContextMenu ? handleContextMenu : undefined}
      aria-current={isCurrent ? "true" : undefined}
      className={cn(
        "group/row relative flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left",
        "transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2",
        "focus-visible:ring-inset focus-visible:ring-ring",
        /*
         * Off-screen rows skip layout, paint and compositing.
         *
         * These lists are not windowed — a 500-track playlist really does build 500 rows of
         * ~20 elements each — and windowing them properly fights both the drag-reorder and the
         * shift-range selection, which need the full index space. This is the platform doing
         * the same job for one line: the nodes stay, the rendering work does not.
         *
         * `auto 52px` is the row's height (40px artwork + `py-1.5`); the `auto` keyword means
         * the browser prefers the size it last actually measured, so the guess only matters for
         * rows that have never been on screen. Width is untouched by the containment because
         * `w-full` states it outright rather than deriving it from content.
         */
        "[content-visibility:auto] [contain-intrinsic-size:auto_52px]",
        isCurrent && "bg-primary/5",
        isSelected && "bg-primary/10",
        className,
      )}
    >
      {children}

      {/* While a selection is open the index column becomes a checkbox. It replaces the
          number rather than sitting beside it so the row width never changes — a list that
          reflows the moment you select something is unusable for range-selecting. */}
      {isSelectionActive && canSelect ? (
        <SelectionCheckbox
          title={track.title}
          isSelected={isSelected}
          onToggle={handleToggleSelected}
        />
      ) : (
      /* The position number is only useful until you have decided to act on the row, so it
          gives way to a play glyph on hover — and to a level meter once this row is the one
          playing. All three share the slot, so the row never reflows between states. */
      <span className="relative w-6 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        <span
          className={cn(
            "transition-opacity",
            isCurrent ? "opacity-0" : "group-hover/row:opacity-0",
          )}
        >
          {index + 1}
        </span>

        {/*
          On a list that supports multi-select, hover offers the checkbox instead of the play
          glyph. Selection was previously unreachable without already having a selection: the
          box only appeared once `isSelectionActive`, and the only way in was a ctrl-click
          nothing advertised. The row itself still plays on click, so nothing is lost.
        */}
        {!isCurrent && canSelect && (
          <span className="absolute inset-0 grid place-items-center opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
            <SelectionCheckbox
              title={track.title}
              isSelected={isSelected}
              onToggle={handleToggleSelected}
            />
          </span>
        )}

        {!isCurrent && !canSelect && (
          <PlayActiveIcon
            size={14}
            className="absolute inset-0 m-auto opacity-0 transition-opacity group-hover/row:opacity-100"
            aria-hidden="true"
          />
        )}

        {isCurrent && (
          <span className="absolute inset-0 flex items-center justify-end" aria-hidden="true">
            {isPlaying ? (
              <MusicVisualizer
                bars={4}
                className="[--music-gap:2px] [--music-height:13px] [--music-width:17px]"
              />
            ) : (
              <PlayActiveIcon size={14} className="text-primary" />
            )}
          </span>
        )}
      </span>
      )}

      {showArtwork ? (
        <TrackArtwork
          className="size-10 shrink-0 rounded-md"
          size={40}
          artworkUrl={track.artworkUrl}
          iconSize={18}
        />
      ) : null}

      <span className="flex min-w-0 flex-1 flex-col">
        {/*
          The badge sits beside the title rather than inside it: as a sibling it keeps its
          own width while `truncate` eats the title, so a long name shortens instead of
          pushing the stamp out of the row.
        */}
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "truncate text-sm font-medium",
              isCurrent ? "text-primary" : "text-foreground",
            )}
          >
            {track.title}
          </span>
          {track.isExplicit && <ExplicitBadge />}
        </span>
        <ArtistLinks
          className="truncate text-xs text-muted-foreground"
          artists={track.artists}
          fallback={track.artist}
          suppressArtistId={suppressArtistId}
        />
      </span>

      {/* Hover actions. The row itself is a <button>, so these cannot be buttons — see
          QuickAction. They sit before `trailing` so durations stay hard against the edge. */}
      {showRating && <RatingActions track={track} />}
      {showDownload && <DownloadAction track={track} />}

      {(onQuickAddToQueue || onQuickAdd) && (
        <span className="flex shrink-0 items-center">
          {onQuickAddToQueue && (
            <QuickAction
              label={`Add ${track.title} to the queue`}
              tooltip="Add to queue"
              onActivate={handleQuickAddToQueue}
            >
              <ListIcon size={17} aria-hidden="true" />
            </QuickAction>
          )}
          {onQuickAdd && (
            <QuickAction
              label={`Add ${track.title} to a playlist`}
              tooltip="Add to playlist"
              onActivate={handleQuickAdd}
            >
              <PlaylistAddIcon size={17} aria-hidden="true" />
            </QuickAction>
          )}
        </span>
      )}

      {trailing}

      {/* Announced to screen readers only; the meter above is decorative. */}
      {isCurrent ? (
        <span className="sr-only">{isPlaying ? "Now playing" : "Paused"}</span>
      ) : null}
    </button>
  );
}, propsEqualIgnoringHandlers);
