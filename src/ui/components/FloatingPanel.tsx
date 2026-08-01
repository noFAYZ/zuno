import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";

/** Distance between the trigger and the panel. */
const GAP = 10;
/** Keeps the panel off the window edges. */
const VIEWPORT_MARGIN = 12;

type PanelSide = "right" | "top" | "bottom";

interface FloatingPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The control that owns the panel. Rendered in place, in normal flow. */
  trigger: ReactNode;
  children: ReactNode;
  /** Which edge of the trigger the panel sits on. */
  side?: PanelSide;
  className?: string;
  /** Wrapper classes for the trigger box — use to stop it stretching in a flex row. */
  triggerClassName?: string;
  /**
   * Open on hover as well as on the caller's own click handling. The panel stays open while
   * the pointer is over either the trigger or the panel, with a grace period covering the
   * gap between them — without it the panel would close the moment the pointer left the
   * trigger, and its contents would be unreachable.
   */
  openOnHover?: boolean;
  /** Delay before a hover opens the panel. */
  hoverOpenDelayMs?: number;
  /** Grace period before a hover-out closes it. */
  hoverCloseDelayMs?: number;
}

/**
 * A popover for the collapsed sidebar rail, opening to its right.
 *
 * The panel is portalled to `document.body` and positioned `fixed` from the trigger's
 * measured rect. That is the whole point of this component: the rail is 72px wide and sits
 * inside two nested `overflow-hidden` shells (the window root, which cuts the rounded
 * corners, and the layout row). Any panel positioned *within* the rail is therefore either
 * clipped by those shells or painted over by the content column, which is a later sibling
 * with its own opaque background. Portalling side-steps both by construction, rather than
 * by finding a z-index that happens to win today.
 *
 * Position is recomputed on scroll and resize because `fixed` coordinates are frozen at
 * paint time — without it the panel would detach from its trigger.
 */
export function FloatingPanel({
  open,
  onOpenChange,
  trigger,
  children,
  side = "right",
  className,
  triggerClassName,
  openOnHover = false,
  hoverOpenDelayMs = 320,
  hoverCloseDelayMs = 180,
}: FloatingPanelProps) {
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const hoverTimerRef = useRef<number | null>(null);

  const clearHoverTimer = () => {
    if (hoverTimerRef.current === null) return;
    window.clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
  };

  const scheduleHover = (next: boolean) => {
    if (!openOnHover) return;
    clearHoverTimer();
    hoverTimerRef.current = window.setTimeout(
      () => {
        hoverTimerRef.current = null;
        onOpenChange(next);
      },
      next ? hoverOpenDelayMs : hoverCloseDelayMs,
    );
  };

  useEffect(() => clearHoverTimer, []);

  const hoverProps = openOnHover
    ? {
        onPointerEnter: () => scheduleHover(true),
        onPointerLeave: () => scheduleHover(false),
      }
    : {};

  useLayoutEffect(() => {
    if (!open) return;

    const place = () => {
      const anchor = triggerRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const panelHeight = panelRef.current?.offsetHeight ?? 0;
      const panelWidth = panelRef.current?.offsetWidth ?? 0;

      if (side === "top" || side === "bottom") {
        // Centred on the trigger, then pulled inside the viewport on both axes.
        const maxLeft = window.innerWidth - panelWidth - VIEWPORT_MARGIN;
        const left = Math.max(
          VIEWPORT_MARGIN,
          Math.min(anchor.left + anchor.width / 2 - panelWidth / 2, maxLeft),
        );
        if (side === "top") {
          setPosition({ left, top: Math.max(VIEWPORT_MARGIN, anchor.top - panelHeight - GAP) });
          return;
        }
        const maxTop = window.innerHeight - panelHeight - VIEWPORT_MARGIN;
        setPosition({ left, top: Math.min(anchor.bottom + GAP, Math.max(VIEWPORT_MARGIN, maxTop)) });
        return;
      }

      const maxTop = window.innerHeight - panelHeight - VIEWPORT_MARGIN;
      setPosition({
        left: anchor.right + GAP,
        top: Math.max(VIEWPORT_MARGIN, Math.min(anchor.top, maxTop)),
      });
    };

    place();

    /*
     * The panel has no measured height on the first pass — it mounts in the same commit —
     * so a top-side panel would be placed as if it were zero-tall and land under the window
     * edge. Observing it re-places once it has real dimensions, and again whenever its
     * content resizes.
     */
    const panel = panelRef.current;
    const observer = panel ? new ResizeObserver(place) : null;
    if (panel && observer) observer.observe(panel);

    // `capture` so it also fires for the app's inner scroll containers, which do not bubble.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, side]);

  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      onOpenChange(false);
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, onOpenChange]);

  return (
    <>
      {/*
        A real layout box, not `display: contents`: contents elements generate no box, so
        getBoundingClientRect() returns zeros and the panel would anchor to the window corner
        instead of the button. `flex flex-col` keeps it transparent to the rail's own layout.
      */}
      <div
        ref={triggerRef}
        className={cn("flex flex-col", triggerClassName)}
        {...hoverProps}
      >
        {trigger}
      </div>

      {createPortal(
        <AnimatePresence>
          {open ? (
            <motion.div
              ref={panelRef}
              role="dialog"
              aria-modal="false"
              initial={
                side === "top"
                  ? { opacity: 0, scale: 0.94, y: 6 }
                  : side === "bottom"
                    ? { opacity: 0, scale: 0.94, y: -6 }
                    : { opacity: 0, scale: 0.94, x: -6 }
              }
              animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
              exit={
                side === "top"
                  ? { opacity: 0, scale: 0.96, y: 4, transition: { duration: 0.12 } }
                  : side === "bottom"
                    ? { opacity: 0, scale: 0.96, y: -4, transition: { duration: 0.12 } }
                    : { opacity: 0, scale: 0.96, x: -4, transition: { duration: 0.12 } }
              }
              transition={{ type: "spring", stiffness: 460, damping: 34, mass: 0.6 }}
              {...hoverProps}
              style={{ position: "fixed", left: position.left, top: position.top }}
              className={cn(
                side === "top" ? "origin-bottom" : side === "bottom" ? "origin-top" : "origin-left",
                "z-[100] rounded-lg  bg-popover p-2 text-popover-foreground",
                "shadow-2xl ring-1 ring-border",
                className,
              )}
            >
              {children}
            </motion.div>
          ) : null}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
