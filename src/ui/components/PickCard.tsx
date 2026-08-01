import { useEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { PlayActiveIcon } from "@/ui/icons";
import { TrackArtwork } from "./TrackArtwork";

/** Movement past this many px means the gesture was a carousel drag, not a tap. */
const TAP_SLOP_PX = 5;

/**
 * Resting card width — `PICKS_ITEM_SIZE` (250) × `PICKS_ASPECT` (3/4) in HomePage, rounded up
 * for the centre card's scale-up. Only the size bucket it lands in matters.
 */
const CARD_WIDTH_PX = 200;

interface PickCardProps {
  artworkUrl?: string;
  title: string;
  subtitle?: string;
  /** Replaces the play affordance — used by the surprise tile for its shuffle badge. */
  accessory?: ReactNode;
  disabled?: boolean;
  onSelect?: () => void;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
}

/**
 * A pick in the home carousel.
 *
 * Two things drive the design:
 *
 * 1. **Everything lives inside the square.** The old cards hung their title and artist
 *    *below* the artwork, which meant the carousel stage had to reserve guessed-at extra
 *    height for captions — and that guess broke the moment the type scale grew. Putting the
 *    caption on the art over a scrim makes the card exactly the box the carousel gives it,
 *    so the layout cannot drift out of sync with the type.
 *
 * 2. **The carousel scales its items**, so a caption inside the card inherits that scale for
 *    free: the centre pick reads at full size and the outer ones recede into thumbnails.
 *    The hierarchy comes from the geometry rather than from styling each position.
 */
export function PickCard({
  artworkUrl,
  title,
  subtitle,
  accessory,
  disabled = false,
  onSelect,
  onContextMenu,
}: PickCardProps) {
  const tapRef = useRef<{ x: number; y: number } | null>(null);

  /*
   * The carousel captures the pointer on its stage and preventDefault()s every pointerdown,
   * so a normal `click` on a card never fires — it is retargeted to the stage. Tap detection
   * therefore happens here: record where the press started, then decide on the pointerup
   * (listened for on window, since the captured pointer no longer reports to this element)
   * whether the gesture was a tap or a drag.
   */
  useEffect(() => {
    if (disabled) return;

    const handleUp = (event: PointerEvent) => {
      const start = tapRef.current;
      tapRef.current = null;
      if (!start) return;

      const travelled = Math.hypot(event.clientX - start.x, event.clientY - start.y);
      if (travelled <= TAP_SLOP_PX) onSelect?.();
    };
    const handleCancel = () => {
      tapRef.current = null;
    };

    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleCancel);
    return () => {
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleCancel);
    };
  }, [disabled, onSelect]);

  return (
    <div
      role="button"
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      aria-label={subtitle ? `${title} — ${subtitle}` : title}
      className={cn(
        // Portrait, centred in the square slot the carousel hands each item. The hit area is
        // the card itself rather than the slot, so the gaps between cards stay dead space.
        "group/pick relative mx-auto block aspect-[3/4] h-full select-none rounded-2xl text-left",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        disabled ? "cursor-default opacity-60" : "cursor-pointer",
      )}
      onPointerDown={(event) => {
        if (disabled) return;
        tapRef.current = { x: event.clientX, y: event.clientY };
      }}
      // Keyboard-generated clicks report detail 0; mouse taps are handled above, so this
      // stays the Enter/Space path only and cannot double-fire.
      onClick={(event) => {
        if (!disabled && event.detail === 0) onSelect?.();
      }}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect?.();
        }
      }}
      onContextMenu={onContextMenu}
    >
      {/*
        Hover is deliberately quick and physical: a short lift with the shadow deepening
        underneath it, the art easing in a few percent, and the play button dropping into the
        corner. Everything lands inside 200ms — long dissolves on a card you are skimming
        past read as lag, not polish.
      */}
      <span
        className={cn(
          "relative block size-full overflow-hidden rounded-2xl bg-card shadow-md",
          "ring-1 ring-white/10 transition-all duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)]",
          !disabled && "group-hover/pick:-translate-y-1.5 group-hover/pick:shadow-xl group-hover/pick:ring-white/25",
        )}
      >
        <TrackArtwork
          className="size-full transition-transform duration-200 ease-out group-hover/pick:scale-[1.04]"
          artworkUrl={artworkUrl}
          iconSize={44}
          /*
           * The carousel's own hover/centre scaling peaks a little above 1, so the slot is
           * requested slightly larger than its resting width rather than at exactly it.
           */
          size={CARD_WIDTH_PX}
          variant="album"
        />

        {/* Scrim only under the text, so the artwork stays the loudest thing on the card.
            The caption gets the card's full width: a portrait tile is narrow, and reserving
            a gutter for the play button left almost nothing for the title. */}
        <span
          className="pointer-events-none absolute inset-x-0 bottom-0 bg-linear-to-t from-black/90 via-black/55 to-transparent px-3 pb-2.5 pt-8"
          aria-hidden="true"
        >
          <span className="block truncate text-sm font-semibold text-white">{title}</span>
          {subtitle ? (
            <span className="mt-0.5 block truncate text-xs text-white/70">{subtitle}</span>
          ) : null}
        </span>

        {/* Specular top edge — the same glass cue the mini player uses. */}
        <span
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-white/30 to-transparent"
          aria-hidden="true"
        />

        {/*
          Centred on the artwork rather than tucked in a corner. A portrait tile is narrow:
          a corner button either gets clipped by the rounded corner or steals the width the
          title needs. The centre is the one spot on the card that is always free, and it is
          where the pointer already is. Only scale and opacity animate — the translate is
          load-bearing for the centring and must not be part of the transition.
        */}
        <span
          className={cn(
            "pointer-events-none absolute left-1/2 top-1/2 grid size-12 -translate-x-1/2 -translate-y-1/2",
            "place-items-center rounded-full bg-primary text-primary-foreground shadow-lg",
            "transition-[transform,opacity] duration-150 ease-[cubic-bezier(0.2,0.8,0.2,1)]",
            accessory
              ? "scale-100 opacity-100"
              : "scale-75 opacity-0 group-hover/pick:scale-100 group-hover/pick:opacity-100",
          )}
          aria-hidden="true"
        >
          {accessory ?? <PlayActiveIcon size={22} />}
        </span>
      </span>
    </div>
  );
}
