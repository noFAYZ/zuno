import { ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";
import { SearchBar } from "./SearchBar";
import { TrackArtwork } from "./TrackArtwork";
import { useAmbientArtwork } from "../stores/ambientArtworkStore";
import { Sidebar } from "./Sidebar";
import { useCompactViewport } from "../hooks/useCompactViewport";
import type { Album, Playlist } from "../../datasource/types";

interface LayoutProps {
  children: ReactNode;
  sidebarWidth: number;
  onSidebarWidthChange: (width: number) => void;
  onNavigateAlbum: (album: Album) => void;
  onNavigatePlaylist: (playlist: Playlist) => void;
  showSearchBar: boolean;
  onOpenSearch: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  fullBleedContent?: boolean;
  hideSidebar?: boolean;
  showTransientScrollbar?: boolean;
  rightPanel?: ReactNode;
  rightPanelWidth?: number;
  onRightPanelWidthChange?: (width: number) => void;
  /**
   * Identifies which page is currently in the scroll root — the same string `App` keys the page
   * content on. `children` swap out under one persistent scroll container (see `pageContentRef`
   * below), so without this the container's native `scrollTop` just carries over verbatim from
   * whatever page was there before: switching tabs looked like they shared a scroll position,
   * because they were, briefly, the same DOM node's position.
   */
  scrollKey?: string;
}

const SCROLLBAR_HIDE_DELAY_MS = 760;
const MIN_SCROLLBAR_THUMB_HEIGHT = 34;
const MAX_SCROLLBAR_THUMB_HEIGHT = 86;

export function Layout({ 
  children, 
  sidebarWidth,
  onSidebarWidthChange,
  onNavigateAlbum,
  onNavigatePlaylist,
  showSearchBar,
  onOpenSearch,
  canGoBack,
  canGoForward,
  onNavigateBack,
  onNavigateForward,
  fullBleedContent = false,
  hideSidebar = false,
  showTransientScrollbar = false,
  rightPanel,
  rightPanelWidth = 340,
  scrollKey,
}: LayoutProps) {
  const ambientArtwork = useAmbientArtwork();
  const isPhone = useCompactViewport();
  const pageContentRef = useRef<HTMLDivElement>(null);
  /** One entry per `scrollKey` ever visited this session. Ephemeral on purpose — a browser tab
   *  does not persist scroll across a reload either, and it would go stale against content that
   *  changed since. */
  const scrollPositionsRef = useRef(new Map<string, number>());

  /*
   * Restores the incoming page's own position, and — in the same effect, via its cleanup —
   * banks the outgoing page's position before its content is replaced.
   *
   * `useLayoutEffect`, not `useEffect`: it runs after the new `children` have committed to the
   * DOM but before the browser paints, so the restored offset is what the user sees first
   * rather than a visible snap from 0 up to it.
   */
  useLayoutEffect(() => {
    const node = pageContentRef.current;
    if (!node || !scrollKey) return;

    node.scrollTop = scrollPositionsRef.current.get(scrollKey) ?? 0;

    return () => {
      scrollPositionsRef.current.set(scrollKey, node.scrollTop);
    };
  }, [scrollKey]);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const scrollHideTimerRef = useRef<number | null>(null);
  const scrollDragOffsetRef = useRef<number | null>(null);
  const isScrollbarHoveredRef = useRef(false);
  const isDraggingScrollbarRef = useRef(false);
  /*
   * Two halves on purpose.
   *
   * `isVisible` and `canScroll` change a handful of times per scroll gesture and decide what
   * renders, so they are state. The thumb's position and height change on every scroll event,
   * and they were state too — which made scrolling any long page re-render `Layout` and every
   * page inside it, sixty-plus times a second, to move one div a few pixels. They are written
   * straight to the node now. Nothing else reads them during render.
   */
  const [scrollbarState, setScrollbarState] = useState({
    isVisible: false,
    canScroll: false,
  });
  const scrollbarThumbRef = useRef<HTMLDivElement>(null);
  const thumbGeometryRef = useRef({ top: 0, height: 0 });
  const [isDraggingScrollbar, setIsDraggingScrollbar] = useState(false);

  const clearScrollHideTimer = useCallback(() => {
    if (scrollHideTimerRef.current === null) return;
    window.clearTimeout(scrollHideTimerRef.current);
    scrollHideTimerRef.current = null;
  }, []);

  /** Writes the thumb geometry to the DOM, and only touches state when state actually moved. */
  const updateScrollbarMetrics = useCallback((forceVisible = false) => {
    const scrollRoot = pageContentRef.current;
    if (!scrollRoot) return;

    const { clientHeight, scrollHeight, scrollTop } = scrollRoot;
    const canScroll = scrollHeight > clientHeight + 1;
    if (!showTransientScrollbar || !canScroll) {
      thumbGeometryRef.current = { top: 0, height: 0 };
      setScrollbarState((current) =>
        current.isVisible === false && current.canScroll === canScroll
          ? current
          : { isVisible: false, canScroll });
      return;
    }

    const thumbHeight = Math.min(
      MAX_SCROLLBAR_THUMB_HEIGHT,
      Math.max(
        MIN_SCROLLBAR_THUMB_HEIGHT,
        Math.round((clientHeight / scrollHeight) * clientHeight),
      ),
    );
    const travel = Math.max(1, clientHeight - thumbHeight);
    const maxScrollTop = Math.max(1, scrollHeight - clientHeight);
    const thumbTop = Math.round((scrollTop / maxScrollTop) * travel);

    thumbGeometryRef.current = { top: thumbTop, height: thumbHeight };
    const thumb = scrollbarThumbRef.current;
    if (thumb) {
      thumb.style.height = `${thumbHeight}px`;
      thumb.style.transform = `translateY(${thumbTop}px)`;
    }

    const isVisible = forceVisible
      ? true
      : isScrollbarHoveredRef.current || isDraggingScrollbarRef.current;
    // Returning `current` unchanged is what makes a scroll that only moves the thumb cost
    // nothing in React: `useState` bails out of the re-render when the value is identical.
    setScrollbarState((current) =>
      current.isVisible === isVisible && current.canScroll === canScroll
        ? current
        : { isVisible, canScroll });
  }, [showTransientScrollbar]);

  const revealScrollbar = useCallback((persist = false) => {
    updateScrollbarMetrics(true);
    clearScrollHideTimer();
    if (persist) return;
    scrollHideTimerRef.current = window.setTimeout(() => {
      if (isScrollbarHoveredRef.current || isDraggingScrollbarRef.current) return;
      setScrollbarState((current) => ({ ...current, isVisible: false }));
    }, SCROLLBAR_HIDE_DELAY_MS);
  }, [clearScrollHideTimer, updateScrollbarMetrics]);

  const hideScrollbar = useCallback(() => {
    clearScrollHideTimer();
    setScrollbarState((current) => ({ ...current, isVisible: false }));
  }, [clearScrollHideTimer]);

  const scrollToThumbPosition = useCallback((clientY: number, pointerOffset: number) => {
    const scrollRoot = pageContentRef.current;
    if (!scrollRoot || !scrollbarState.canScroll) return;

    const rect = scrollRoot.getBoundingClientRect();
    const travel = Math.max(1, rect.height - thumbGeometryRef.current.height);
    const thumbTop = Math.max(
      0,
      Math.min(travel, clientY - rect.top - pointerOffset),
    );
    const maxScrollTop = Math.max(1, scrollRoot.scrollHeight - scrollRoot.clientHeight);
    scrollRoot.scrollTop = (thumbTop / travel) * maxScrollTop;
    // The thumb height is read from a ref now, so it is no longer a dependency — which also
    // means this callback keeps its identity across a scroll instead of being rebuilt.
  }, [scrollbarState.canScroll]);

  useEffect(() => {
    const scrollRoot = pageContentRef.current;
    if (!scrollRoot || !showTransientScrollbar) {
      setScrollbarState((current) => ({ ...current, isVisible: false, canScroll: false }));
      return;
    }

    /*
     * One update per frame. Scroll events are not frame-aligned — a trackpad or a smooth-scroll
     * animation can deliver several between paints — and each one reads `scrollHeight`, which
     * forces the browser to flush layout before it can answer.
     */
    let scrollFrame = 0;
    const handleScroll = () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        revealScrollbar();
      });
    };
    const handleResize = () => updateScrollbarMetrics(
      isScrollbarHoveredRef.current || isDraggingScrollbarRef.current,
    );

    updateScrollbarMetrics(false);
    scrollRoot.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleResize);
    return () => {
      if (scrollFrame) cancelAnimationFrame(scrollFrame);
      scrollRoot.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleResize);
    };
  }, [
    revealScrollbar,
    showTransientScrollbar,
    updateScrollbarMetrics,
  ]);

  useEffect(() => () => clearScrollHideTimer(), [clearScrollHideTimer]);

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-background ">
     

      <div className="relative flex min-h-0 min-w-0 flex-1">
        {!hideSidebar && !isPhone && (
          <Sidebar
            width={sidebarWidth}
            onWidthChange={onSidebarWidthChange}
            onNavigateAlbum={onNavigateAlbum}
            onNavigatePlaylist={onNavigatePlaylist}
          />
        )}
        {/* No backdrop-blur: `bg-background` is fully opaque, so a backdrop filter here costs a
            composited layer and a blur pass to render something nothing can see through. */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-3 px-4 pt-3 max-md:px-3 max-md:pt-2 bg-background rounded-tl-lg">
          {/*
            Ambient wash for the page beneath. Rendered here rather than inside the page so
            it can start at the very top of the column — behind the search bar — instead of
            being clipped at the scroll container's edge.

            Everything after this is positioned, so DOM order alone puts the chrome above it;
            no z-index juggling, and no stacking context that would trap the blur.
          */}
          {ambientArtwork ? (
            <span
              key={ambientArtwork}
              className="pointer-events-none absolute inset-x-0 top-0 h-[22rem] overflow-hidden [mask-image:linear-gradient(to_bottom,background_25%,transparent)] rounded-tl-lg"
              aria-hidden="true"
              data-fx="ambient"
            >
              {/*
                The blur radius drives the intermediate textures the compositor allocates, and
                this is one of the largest surfaces in the window. 32px is enough here because
                the source is a 120px image stretched across the full width — a ~20x upscale is
                already most of the softness, and the filter only finishes the job.

                `scale-125` is gone for the same reason: the negative insets already extend this
                well past the clipped box on three sides, so the scale was adding composited
                area to hide edges that were never reachable.
              */}
              <span className="absolute -inset-x-1/4 -top-1/2 bottom-0 opacity-40 blur-[32px] saturate-[2]">
                {/*
                  Deliberately the smallest variant: this is blurred and dropped to 40% opacity,
                  so nothing above 120px survives to be seen — it only costs texture.
                */}
                <TrackArtwork
                  className="size-full"
                  size={120}
                  artworkUrl={ambientArtwork}
                  iconSize={0}
                />
              </span>
            </span>
          ) : null}

          {showSearchBar && (
            <div className="relative">
              <SearchBar
                onOpen={onOpenSearch}
                canGoBack={canGoBack}
                canGoForward={canGoForward}
                onBack={onNavigateBack}
                onForward={onNavigateForward}
              />
            </div>
          )}

          <div className="relative flex min-h-0 min-w-0 flex-1 gap-3 pb-3 ">
            <div className="relative min-h-0 min-w-0 flex-1">
              <div
                ref={pageContentRef}
                className={cn(
                  "h-full overflow-y-auto overscroll-contain rounded-xl ",
                  fullBleedContent ? "p-0" : "p-4 max-md:p-2",
                )}
                data-page-scroll-root
              >
                {children}
              </div>
              {showTransientScrollbar && scrollbarState.canScroll && (
                <div
                  className={cn(
                    "absolute inset-y-0 right-0 z-10 w-3.5 transition-opacity duration-200",
                    scrollbarState.isVisible ? "opacity-100" : "opacity-0",
                  )}
                  onPointerEnter={() => {
                    isScrollbarHoveredRef.current = true;
                    revealScrollbar(true);
                  }}
                  onPointerLeave={() => {
                    isScrollbarHoveredRef.current = false;
                    if (!isDraggingScrollbarRef.current) hideScrollbar();
                  }}
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    const target = event.target;
                    const thumb = event.currentTarget.querySelector("[data-scrollbar-thumb]");
                    const thumbRect = thumb instanceof HTMLElement
                      ? thumb.getBoundingClientRect()
                      : null;
                    const offset = target === thumb && thumbRect
                      ? event.clientY - thumbRect.top
                      : thumbGeometryRef.current.height / 2;

                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    scrollDragOffsetRef.current = offset;
                    isDraggingScrollbarRef.current = true;
                    setIsDraggingScrollbar(true);
                    revealScrollbar(true);
                    scrollToThumbPosition(event.clientY, offset);
                  }}
                  onPointerMove={(event) => {
                    if (!isDraggingScrollbar || scrollDragOffsetRef.current === null) return;
                    scrollToThumbPosition(event.clientY, scrollDragOffsetRef.current);
                  }}
                  onPointerUp={(event) => {
                    scrollDragOffsetRef.current = null;
                    isDraggingScrollbarRef.current = false;
                    setIsDraggingScrollbar(false);
                    event.currentTarget.releasePointerCapture(event.pointerId);
                    if (isScrollbarHoveredRef.current) {
                      revealScrollbar(true);
                    } else {
                      hideScrollbar();
                    }
                  }}
                  onPointerCancel={(event) => {
                    scrollDragOffsetRef.current = null;
                    isDraggingScrollbarRef.current = false;
                    setIsDraggingScrollbar(false);
                    event.currentTarget.releasePointerCapture(event.pointerId);
                    hideScrollbar();
                  }}
                  aria-hidden="true"
                >
                  <div className="relative mx-auto h-full w-1.5 rounded-full">
                    <div
                      className={cn(
                        "w-full rounded-full transition-colors",
                        isDraggingScrollbar
                          ? "bg-foreground/50"
                          : "bg-foreground/25 hover:bg-foreground/40",
                      )}
                      ref={scrollbarThumbRef}
                      data-scrollbar-thumb
                      /* Only the first paint after the thumb mounts; every move after that is
                         written straight to this node by updateScrollbarMetrics. */
                      style={{
                        height: `${thumbGeometryRef.current.height}px`,
                        transform: `translateY(${thumbGeometryRef.current.top}px)`,
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

          </div>
        </div>

 {/* Phone: the queue is its own screen, not a 340px column squeezed beside the page. */}
            {isPhone && rightPanel && (
              <div
                className="fixed inset-0 z-40 flex flex-col bg-card pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
              >
                <div className="min-h-0 flex-1">{rightPanel}</div>
              </div>
            )}
 <AnimatePresence initial={false}>
              {!isPhone && rightPanel && (
                <motion.div
                  ref={rightPanelRef}
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: rightPanelWidth, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  /*
                   * A tween, not a spring, and `width` gets its own shorter one than `opacity`.
                   *
                   * `width` is a layout property — every frame Framer emits for it costs a real
                   * synchronous browser layout, not a compositor-only step like `x` or
                   * `opacity` would. A spring has no fixed end time; it keeps emitting
                   * low-amplitude correction frames well past the point it looks finished,
                   * which was still paying for a layout pass on each one. A tween has a hard
                   * stop at `duration`, so the frame count — and the reflow cost — is bounded
                   * and known. Opacity gets a hair longer so the fade reads as settling into
                   * the now-correctly-sized box rather than racing to beat it there.
                   */
                  transition={{
                    width: { duration: 0.22, ease: [0.16, 1, 0.3, 1] },
                    opacity: { duration: 0.16, ease: "easeOut" },
                  }}
                  className="relative min-h-0 shrink-0 overflow-hidden bg-card"
                >
                  {/*
                    Pinned to the target width, not 100%: this box's *wrapper* is what's
                    animating. If the queue list tracked that width instead, every row's flex
                    layout and text truncation would recompute on every animation frame — for a
                    25+ row queue that's the actual cost behind a "laggy" close. Fixed width
                    means the wrapper's shrinking `overflow-hidden` clip is the only thing that
                    changes per frame; the panel's own layout is computed once.
                  */}
                  <div className="h-full" style={{ width: rightPanelWidth }}>
                    {rightPanel}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

      </div>
    </div>
  );
}
