"use client";
// beui.dev/components/motion/cylinder-carousel

import {
  animate,
  type AnimationPlaybackControls,
  motion,
  type MotionValue,
  useMotionValue,
  useReducedMotion,
  useTransform,
} from "motion/react";
import {
  Children,
  type FocusEvent as ReactFocusEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { cn } from "@/lib/utils";

// Carousel-specific: a soft spring that receives the release velocity, so a
// flick keeps rolling freely, drifts past the snap point and eases back.
const GLIDE_SPRING = { stiffness: 40, damping: 20, mass: 3 };

// How far a flick keeps rolling: projected items = release velocity * momentum.
const FLICK_MOMENTUM = 0.45;
const MAX_FLICK_ITEMS = 6;

export interface CylinderCarouselProps {
  children: ReactNode;
  /** Max item box size in px (square) at full size, i.e. at the container
   * edge. Balls shrink below this automatically so the row keeps breathing
   * room in narrow containers. */
  itemSize?: number;
  /** How many item slots span the container width. */
  visibleItems?: number;
  /**
   * Width/height of what the child actually renders inside its square slot, used only by the
   * fit calculation below. The default of 1 assumes the child fills the slot; a portrait
   * card (say 3:4) is narrower, so the resting row takes up less width than the fit rule
   * would otherwise assume and the items get shrunk for no reason.
   */
  itemAspect?: number;
  /** "concave" (default): inside of the cylinder — center ball smallest and
   * dipped, growing toward the edges. "convex": outside of the cylinder —
   * center ball biggest and raised, shrinking toward the edges. */
  variant?: "concave" | "convex";
  /** Scale of the smallest ball (center for concave, edges for convex);
   * the biggest reaches 1. */
  minScale?: number;
  /** Items rolled per item-width dragged — above 1 the wall outruns the
   * pointer, which reads as a lighter, freer roll. */
  dragSpeed?: number;
  /** Curve depth in px: for concave, how far the edge balls ride above the
   * center one (valley); for convex, how far below (arch). 0 = flat line.
   * Defaults to 35% of the item size. */
  arc?: number;
  /** Snap to the nearest item when the roll settles. */
  snap?: boolean;
  /** Roll on its own until interacted with. */
  autoRotate?: boolean;
  /** Auto-roll speed in items per second. */
  autoRotateSpeed?: number;
  defaultIndex?: number;
  onIndexChange?: (index: number) => void;
  /**
   * Maximum stage height in px. The stage takes the lesser of this and what the row actually
   * needs, so a narrow container does not leave a band of dead space under smaller cards.
   * Defaults to the row's own height.
   */
  height?: number;
  className?: string;
}

// The frame edge sits at this wall angle; how far the wall curves in frame.
const THETA_EDGE = (72 * Math.PI) / 180;
// Wall angle past which a ball is parked far off-stage (always hidden there).
const THETA_CLAMP = (95 * Math.PI) / 180;

/**
 * One ball on the inside wall of the cylinder, rendered through a single
 * perspective projection: the ball sits at wall angle θ, the camera slightly
 * above the ball line, so horizontal position, size and height all share one
 * 1/(cosθ + k) depth term. Center = far wall: smallest, highest, moving
 * slowest; edges = nearest: full size, level, moving fastest, sliding off to
 * be clipped. Nothing overlaps, fades or reorders — the edge is the exit.
 */
function CarouselBall({
  scroll,
  index,
  count,
  alpha,
  k,
  projection,
  gap,
  edgeOffset,
  minScale,
  convex,
  arc,
  halfWidth,
  itemSize,
  children,
}: {
  scroll: MotionValue<number>;
  index: number;
  count: number;
  /** Wall angle per item step, in radians. */
  alpha: number;
  /** Camera distance term for the horizontal projection. */
  k: number;
  /** Projection strength: maps sinθ/(cosθ+k) to px so θE lands on the edge. */
  projection: number;
  /** Uniform slot width in px — convex spacing. */
  gap: number;
  /** Offset at which a ball's center sits on the container edge. */
  edgeOffset: number;
  minScale: number;
  convex: boolean;
  /** Curve depth in px between the center ball and the edge balls. */
  arc: number;
  halfWidth: number;
  itemSize: number;
  children: ReactNode;
}) {
  // Nearest wrapped offset so items loop around continuously.
  const offset = useTransform(scroll, (s) => {
    let o = index - s;
    o -= Math.round(o / count) * count;
    return o;
  });
  // Concave spacing follows the interior perspective (slow, tight center);
  // convex pairs its big center balls with uniform spacing — the interior
  // projection would collapse them into each other.
  const x = useTransform(offset, (o) => {
    if (convex) return o * gap;
    const th = Math.max(-THETA_CLAMP, Math.min(THETA_CLAMP, o * alpha));
    return (projection * Math.sin(th)) / (Math.cos(th) + k);
  });
  // Linear in wall angle, not in depth (the depth curve is near-flat around
  // the center, which made the middle three read as equal): every step is
  // visibly bigger than the last — growing outward (concave) or inward
  // (convex).
  const scale = useTransform(offset, (o) => {
    const t = Math.min(Math.abs(o) / edgeOffset, THETA_CLAMP / THETA_EDGE);
    return convex
      ? 1 - (1 - minScale) * t
      : minScale + (1 - minScale) * t;
  });
  // Parabola centered on the stage — valley for concave (center ball dips
  // arc/2 below the midline, edges rise arc/2 above), arch for convex — and
  // deliberately unclamped: a ball keeps following the same curve as it
  // crosses the edge, so entries never pop.
  const y = useTransform(x, (px) => {
    const t = px / halfWidth;
    const valley = arc * (0.5 - t * t);
    return convex ? -valley : valley;
  });
  // Fully off-stage balls stop painting (matters for canvas/shader children).
  const visibility = useTransform(x, (px) =>
    Math.abs(px) > halfWidth + itemSize ? "hidden" : "visible",
  );

  return (
    <motion.div
      data-ball-index={index}
      className="absolute top-1/2 left-1/2 overflow-y-visible"
      style={{
        x,
        y,
        scale,
        visibility,
        width: itemSize,
        height: itemSize,
        marginLeft: -itemSize / 2,
        marginTop: -itemSize / 2,
      }}
    >
      {children}
    </motion.div>
  );
}

export function CylinderCarousel({
  children,
  itemSize = 200,
  visibleItems = 8,
  itemAspect = 2,
  variant = "concave",
  minScale = 0.55,
  dragSpeed = 1.5,
  arc: arcProp,
  snap = true,
  autoRotate = false,
  autoRotateSpeed = 0.4,
  defaultIndex = 0,
  onIndexChange,
  height,
  className,
}: CylinderCarouselProps) {
  const reduce = useReducedMotion() ?? false;
  const items = Children.toArray(children);
  const count = items.length;

  const stageRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // Layout effect, not effect: an effect measures after paint, so the first frame laid out at
  // the 800px fallback below and then visibly jumped to the real width.
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const stageWidth = width || 800;
  const halfWidth = stageWidth / 2;

  /*
   * `visibleItems` is a ceiling, not a fixed count.
   *
   * Held fixed, a narrow stage divides the same number of slots into a smaller width and the
   * fit rule shrinks every card to keep them apart — so the window that has least room shows
   * the most cards, at a size where the title is unreadable. Dropping slots instead keeps the
   * cards legible and lets the row show fewer of them, which is the trade a shelf wants.
   */
  const minSlotPx = itemSize * itemAspect * 0.62;
  const slots = Math.max(3, Math.min(visibleItems, Math.floor(stageWidth / minSlotPx) || 3));
  // Sized so `slots` balls sit fully in frame and the next one out on
  // each side straddles the container edge, half visible.
  const edgeOffset = (slots + 1) / 2;

  // Fit: the resting row's diameters may take at most ~66% of the stage — the
  // rest is air between balls plus the half-visible ball on each edge.
  // `itemSize` only caps the result.
  const convex = variant === "convex";
  let scaleSum = 0;
  for (let i = 0; i < slots; i++) {
    const t = Math.abs(i - (slots - 1) / 2) / edgeOffset;
    scaleSum += convex
      ? 1 - (1 - minScale) * t
      : minScale + (1 - minScale) * t;
  }
  // `itemAspect` divides out the width the children do not actually use, so a portrait row
  // is allowed to grow until *it* fills the budget rather than until a square row would.
  const size = Math.min(itemSize, (stageWidth * 1) / (scaleSum * itemAspect));

  const gap = stageWidth / (slots + 1);
  const arc = arcProp ?? size * 0.35;

  // Perspective constants. The ball one slot past the frame edge sits at wall
  // angle THETA_EDGE with its center right on the container edge — scale 1,
  // half of it in view; k falls out of the requested minScale (clamped so the
  // projection stays monotonic up to THETA_CLAMP).
  const alpha = THETA_EDGE / edgeOffset;
  const k = Math.max(0.2, (minScale - Math.cos(THETA_EDGE)) / (1 - minScale));
  const projection =
    (halfWidth * (Math.cos(THETA_EDGE) + k)) / Math.sin(THETA_EDGE);

  // scroll is in item units (continuous); item i sits at x = (i - scroll) * gap.
  // Drags write it 1:1 so the wall sticks to the pointer; releases hand the
  // pointer velocity to a soft spring so the roll glides on and settles free.
  const scroll = useMotionValue(defaultIndex);
  const indexRef = useRef(defaultIndex);
  const glideRef = useRef<AnimationPlaybackControls | null>(null);
  const draggingRef = useRef(false);
  const hoverRef = useRef(false);

  useEffect(() => {
    if (count === 0) return;
    const unsub = scroll.on("change", (v) => {
      const idx = ((Math.round(v) % count) + count) % count;
      /*
       * No state here. This used to also set an `activeIndex` nothing read, so every card the
       * row passed re-rendered the carousel and rebuilt all N balls' props — mid-drag, for a
       * value with no consumer. Everything on screen is driven by motion values, which write
       * to the DOM without React.
       */
      if (idx !== indexRef.current) {
        indexRef.current = idx;
        onIndexChange?.(idx);
      }
    });
    return unsub;
  }, [scroll, count, onIndexChange]);

  const stopGlide = useCallback(() => {
    glideRef.current?.stop();
    glideRef.current = null;
  }, []);

  // Spring toward `to`, carrying `velocity` (items/s) through so motion never
  // steps — the roll leaves the finger at finger speed.
  const glideTo = useCallback(
    (to: number, velocity: number) => {
      stopGlide();
      if (reduce) {
        scroll.set(to);
        return;
      }
      glideRef.current = animate(scroll, to, {
        type: "spring",
        ...GLIDE_SPRING,
        velocity,
        restDelta: 0.001,
        restSpeed: 0.005,
      });
    },
    [scroll, stopGlide, reduce],
  );

  const settle = useCallback(
    (velocity: number) => {
      const projected =
        scroll.get() +
        Math.max(
          -MAX_FLICK_ITEMS,
          Math.min(MAX_FLICK_ITEMS, velocity * FLICK_MOMENTUM),
        );
      glideTo(snap ? Math.round(projected) : projected, velocity);
    },
    [scroll, snap, glideTo],
  );

  const drag = useRef({
    startX: 0,
    startScroll: 0,
    lastX: 0,
    lastT: 0,
    prevX: 0,
    prevT: 0,
  });

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      // Primary button only: a right-click would otherwise capture the pointer and leave the
      // carousel stuck mid-drag, because the press that opens a context menu never releases here.
      if (e.button !== 0) return;
      e.preventDefault();
      stopGlide();
      draggingRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      const now = performance.now();
      drag.current = {
        startX: e.clientX,
        startScroll: scroll.get(),
        lastX: e.clientX,
        lastT: now,
        prevX: e.clientX,
        prevT: now,
      };
    },
    [scroll, stopGlide],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      if (!draggingRef.current) return;
      const d = drag.current;
      scroll.set(d.startScroll - ((e.clientX - d.startX) * dragSpeed) / gap);
      d.prevX = d.lastX;
      d.prevT = d.lastT;
      d.lastX = e.clientX;
      d.lastT = performance.now();
    },
    [scroll, gap, dragSpeed],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      const d = drag.current;
      const dt = d.lastT - d.prevT;
      const vpx = dt > 0 ? (d.lastX - d.prevX) / dt : 0; // px per ms
      settle((-vpx * dragSpeed * 1000) / gap); // items per second
    },
    [settle, gap, dragSpeed],
  );

  const rollBy = useCallback(
    (dir: number) => {
      glideTo(Math.round(scroll.get()) + dir, scroll.getVelocity());
    },
    [scroll, glideTo],
  );

  /** Rolls to `index` the short way round, since the row wraps in both directions. */
  const rollToIndex = useCallback(
    (index: number) => {
      if (count === 0) return;
      const current = scroll.get();
      let offset = index - current;
      offset -= Math.round(offset / count) * count;
      if (Math.abs(offset) < 0.01) return;
      glideTo(current + offset, 0);
    },
    [count, scroll, glideTo],
  );

  /*
   * Tab lands on cards that are off-stage — they are positioned by transform, so they are
   * still in the tab order wherever the roll has left them. Without this the focus ring goes
   * somewhere invisible and the keyboard user is navigating a row they cannot see.
   */
  const onFocusCapture = useCallback(
    (e: ReactFocusEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement | null;
      /*
       * Keyboard focus only. Chromium focuses a card on pointer press — including the right
       * button — so without this a right-click rolled the row out from under the cursor and
       * left the context menu pointing at nothing. `:focus-visible` is exactly the "focus that
       * arrived by keyboard" distinction, so the browser makes the call rather than a guess.
       */
      if (!target?.matches?.(":focus-visible")) return;
      const ball = target.closest("[data-ball-index]");
      if (!ball) return;
      const index = Number(ball.getAttribute("data-ball-index"));
      if (Number.isFinite(index)) rollToIndex(index);
    },
    [rollToIndex],
  );

  const wheelSettleRef = useRef<number | undefined>(undefined);
  const onWheel = useCallback(
    (e: ReactWheelEvent) => {
      /*
       * Horizontal intent only. This used to fall back to `deltaY`, so a plain mouse wheel
       * over the shelf rolled the shelf instead of scrolling the page — and since the row sits
       * mid-page, the wheel could not get past it. A trackpad swipe and shift+wheel are the
       * two gestures that actually mean "sideways"; everything else belongs to the page.
       */
      const horizontal = e.shiftKey ? e.deltaY : e.deltaX;
      if (Math.abs(horizontal) <= Math.abs(e.deltaY) && !e.shiftKey) return;

      stopGlide();
      scroll.set(scroll.get() + horizontal / gap);
      if (wheelSettleRef.current) window.clearTimeout(wheelSettleRef.current);
      wheelSettleRef.current = window.setTimeout(
        () => settle(scroll.getVelocity()),
        140,
      );
    },
    [scroll, gap, settle, stopGlide],
  );

  // A settle scheduled by the last wheel tick would otherwise fire into an unmounted carousel.
  useEffect(() => () => window.clearTimeout(wheelSettleRef.current), []);

  useEffect(() => {
    if (!autoRotate || reduce || count === 0) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      if (!draggingRef.current && !hoverRef.current && !glideRef.current) {
        scroll.set(scroll.get() + autoRotateSpeed * dt);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [autoRotate, autoRotateSpeed, reduce, count, scroll]);

  // `size + arc` is what the row occupies: the tallest card plus the curve it rides on.
  const stageHeight = Math.min(height ?? Number.POSITIVE_INFINITY, size + arc);

  return (
      <div
        ref={stageRef}
        role="application"
        aria-roledescription="carousel"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focusable custom carousel widget
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") {
            e.preventDefault();
            rollBy(1);
          } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            rollBy(-1);
          }
        }}
        onFocusCapture={onFocusCapture}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onPointerEnter={() => {
          hoverRef.current = true;
        }}
        onPointerLeave={() => {
          hoverRef.current = false;
        }}
        className={cn(
          // clip-path, not overflow: it also clips the GPU-composited balls
          "relative w-full touch-none select-none outline-none overflow-x-clip [clip-path:inset(0)]",
          "cursor-grab active:cursor-grabbing",
          "focus-visible:ring-2 focus-visible:ring-foreground/20 overflow-y-visible",
          className,
        )}
        style={{ height: stageHeight }}
      >
        {items.map((item, i) => (
          <CarouselBall
            // biome-ignore lint/suspicious/noArrayIndexKey: slides are positional and stable
            key={i}
            scroll={scroll}
            index={i}
            count={count}
            alpha={alpha}
            k={k}
            projection={projection}
            gap={gap}
            edgeOffset={edgeOffset}
            minScale={minScale}
            convex={convex}
            arc={arc}
            halfWidth={halfWidth}
            itemSize={size}
          >
            {item}
          </CarouselBall>
        ))}
      </div>
  );
}
