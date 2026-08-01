import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";
import { SearchBar } from "./SearchBar";
import { TrackArtwork } from "./TrackArtwork";
import { useAmbientArtwork } from "../stores/ambientArtworkStore";
import { Sidebar } from "./Sidebar";
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
  showTransientScrollbar?: boolean;
  rightPanel?: ReactNode;
  rightPanelWidth?: number;
  onRightPanelWidthChange?: (width: number) => void;
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
  showTransientScrollbar = false,
  rightPanel,
  rightPanelWidth = 340,
}: LayoutProps) {
  const ambientArtwork = useAmbientArtwork();
  const pageContentRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);
  const scrollHideTimerRef = useRef<number | null>(null);
  const scrollDragOffsetRef = useRef<number | null>(null);
  const isScrollbarHoveredRef = useRef(false);
  const isDraggingScrollbarRef = useRef(false);
  const [scrollbarState, setScrollbarState] = useState({
    isVisible: false,
    canScroll: false,
    thumbTop: 0,
    thumbHeight: 0,
  });
  const [isDraggingScrollbar, setIsDraggingScrollbar] = useState(false);

  const clearScrollHideTimer = useCallback(() => {
    if (scrollHideTimerRef.current === null) return;
    window.clearTimeout(scrollHideTimerRef.current);
    scrollHideTimerRef.current = null;
  }, []);

  const updateScrollbarMetrics = useCallback((forceVisible = false) => {
    const scrollRoot = pageContentRef.current;
    if (!scrollRoot) return;

    const { clientHeight, scrollHeight, scrollTop } = scrollRoot;
    const canScroll = scrollHeight > clientHeight + 1;
    if (!showTransientScrollbar || !canScroll) {
      setScrollbarState((current) => ({
        ...current,
        isVisible: false,
        canScroll,
        thumbTop: 0,
        thumbHeight: 0,
      }));
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

    setScrollbarState({
      isVisible: forceVisible ? true : isScrollbarHoveredRef.current || isDraggingScrollbarRef.current,
      canScroll,
      thumbTop,
      thumbHeight,
    });
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
    const travel = Math.max(1, rect.height - scrollbarState.thumbHeight);
    const thumbTop = Math.max(
      0,
      Math.min(travel, clientY - rect.top - pointerOffset),
    );
    const maxScrollTop = Math.max(1, scrollRoot.scrollHeight - scrollRoot.clientHeight);
    scrollRoot.scrollTop = (thumbTop / travel) * maxScrollTop;
  }, [scrollbarState.canScroll, scrollbarState.thumbHeight]);

  useEffect(() => {
    const scrollRoot = pageContentRef.current;
    if (!scrollRoot || !showTransientScrollbar) {
      setScrollbarState((current) => ({ ...current, isVisible: false, canScroll: false }));
      return;
    }

    const handleScroll = () => revealScrollbar();
    const handleResize = () => updateScrollbarMetrics(
      isScrollbarHoveredRef.current || isDraggingScrollbarRef.current,
    );

    updateScrollbarMetrics(false);
    scrollRoot.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleResize);
    return () => {
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
        <Sidebar
          width={sidebarWidth}
          onWidthChange={onSidebarWidthChange}
          onNavigateAlbum={onNavigateAlbum}
          onNavigatePlaylist={onNavigatePlaylist}
        />
        {/* No backdrop-blur: `bg-background` is fully opaque, so a backdrop filter here costs a
            composited layer and a blur pass to render something nothing can see through. */}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-3 px-4 pt-3 bg-background rounded-tl-lg">
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
                  fullBleedContent ? "p-0" : "p-4",
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
                      : scrollbarState.thumbHeight / 2;

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
                      data-scrollbar-thumb
                      style={{
                        height: `${scrollbarState.thumbHeight}px`,
                        transform: `translateY(${scrollbarState.thumbTop}px)`,
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

          </div>
        </div>

 <AnimatePresence initial={false}>
              {rightPanel && (
                <motion.div
                  ref={rightPanelRef}
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: rightPanelWidth, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{ type: "spring", stiffness: 420, damping: 40 }}
                  className="relative min-h-0 shrink-0 overflow-hidden bg-card"
                >
                  {rightPanel}
                </motion.div>
              )}
            </AnimatePresence>

      </div>
    </div>
  );
}
