import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";
import { CloseIcon, VolumeLoudActiveIcon } from "@/ui/icons";
import { Tab } from "../types/tab";
import { isLinux } from "../platform";
import { AddSquareIcon } from "@solar-icons/react/linear";
import { Button } from "@/components/motion/button";

const MAX_TAB_TITLE_LENGTH = 32;

function getTabTitle(tab: Tab): string {
  if (tab.view === "settings") return "Settings";
  if (tab.view === "search" && tab.searchQuery) return tab.searchQuery;
  if (!tab.title) return "New Tab";
  if (tab.title.length <= MAX_TAB_TITLE_LENGTH) return tab.title;
  return `${tab.title.slice(0, MAX_TAB_TITLE_LENGTH - 3)}...`;
}

interface MusicTabsProps {
  tabs: Tab[];
  activeTabId: string;
  playingTabId: string | null;
  onCreateTab: () => void;
  onCloseTab: (tabId: string) => void;
  onSwitchTab: (tabId: string) => void;
  onReorderTab: (draggedTabId: string, targetTabId: string, insertAfter: boolean) => void;
  onboardingFirstTabId?: string;
}

export function MusicTabs({
  tabs,
  activeTabId,
  playingTabId,
  onCreateTab,
  onCloseTab,
  onSwitchTab,
  onReorderTab,
  onboardingFirstTabId,
}: MusicTabsProps) {
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    tabId: string;
    insertAfter: boolean;
  } | null>(null);
  const pointerDragRef = useRef<{
    pointerId: number;
    tabId: string;
    startX: number;
    startY: number;
    isDragging: boolean;
  } | null>(null);
  const dropTargetRef = useRef(dropTarget);
  const suppressClickRef = useRef(false);

  const clearDragState = () => {
    pointerDragRef.current = null;
    setDraggedTabId(null);
    setDropTarget(null);
  };

  useEffect(() => {
    dropTargetRef.current = dropTarget;
  }, [dropTarget]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

      if (!drag.isDragging) {
        const distance = Math.hypot(
          event.clientX - drag.startX,
          event.clientY - drag.startY,
        );
        if (distance < 5) return;
        drag.isDragging = true;
        setDraggedTabId(drag.tabId);
      }

      event.preventDefault();
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>("[data-music-tab-id]");
      const targetTabId = target?.dataset.musicTabId;
      if (!target || !targetTabId || targetTabId === drag.tabId) {
        dropTargetRef.current = null;
        setDropTarget(null);
        return;
      }

      const bounds = target.getBoundingClientRect();
      const nextDropTarget = {
        tabId: targetTabId,
        insertAfter: event.clientX >= bounds.left + bounds.width / 2,
      };
      dropTargetRef.current = nextDropTarget;
      setDropTarget(nextDropTarget);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;

      if (drag.isDragging) {
        const target = dropTargetRef.current;
        if (target) {
          onReorderTab(drag.tabId, target.tabId, target.insertAfter);
        }
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
      clearDragState();
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [onReorderTab]);

  const canCloseTabs = tabs.length > 1;

  return (
    <div className="flex min-w-0 items-center overflow-hidden">
      <div
        className={cn("flex min-w-0 items-center gap-1  overflow-x-auto px-1", isLinux && "pt-0")}
        data-tauri-drag-region={isLinux ? undefined : ""}
      >
        {tabs.map((tab) => {
          const title = getTabTitle(tab);
          const isActive = activeTabId === tab.id;
          const isDropBefore = dropTarget?.tabId === tab.id && !dropTarget.insertAfter;
          const isDropAfter = dropTarget?.tabId === tab.id && dropTarget.insertAfter;

          return (
            <div
              key={tab.id}
              className={cn(
                "group relative flex h-8 min-w-0 max-w-52 shrink-0 cursor-default items-center gap-1.5 rounded-md px-3 text-sm transition-colors select-none cursor-pointer",
                isActive
                  ? "text-foreground rounded-md"
                  : "text-muted-foreground hover:bg-card/60 hover:text-foreground rounded-md",
                draggedTabId === tab.id && "opacity-40",
                // Drop indicator: a hairline on the side the tab will land.
                isDropBefore &&
                  "before:absolute before:-left-0.5 before:top-1 before:bottom-1 before:w-0.5 before:rounded-md before:bg-primary",
                isDropAfter &&
                  "after:absolute after:-right-0.5 after:top-1 after:bottom-1 after:w-0.5 after:rounded-md after:bg-primary",
              )}
              data-music-tab-id={tab.id}
              data-onboarding={tab.id === onboardingFirstTabId ? "first-tab" : undefined}
              onClick={() => {
                if (suppressClickRef.current) {
                  suppressClickRef.current = false;
                  return;
                }
                onSwitchTab(tab.id);
              }}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onCloseTab(tab.id);
                }
              }}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                if ((event.target as Element).closest("button")) return;
                pointerDragRef.current = {
                  pointerId: event.pointerId,
                  tabId: tab.id,
                  startX: event.clientX,
                  startY: event.clientY,
                  isDragging: false,
                };
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSwitchTab(tab.id);
                }
              }}
            >
              {/* Shared-layout pill glides between tabs instead of each tab fading. */}
              {isActive && (
                <motion.span
                  layoutId="music-tab-active"
                  transition={{ type: "spring", stiffness: 520, damping: 42 }}
                  className="absolute inset-0 -z-10 rounded-md bg-card"
                />
              )}

              <div className="flex min-w-0 items-center gap-1.5">
                <AnimatePresence initial={false}>
                  {playingTabId === tab.id && (
                    <motion.span
                      key="playing"
                      initial={{ opacity: 0, scale: 0.6, width: 0 }}
                      animate={{ opacity: 1, scale: 1, width: "auto" }}
                      exit={{ opacity: 0, scale: 0.6, width: 0 }}
                      className="flex shrink-0 items-center text-primary"
                    >
                      <VolumeLoudActiveIcon size={15} aria-label="Currently playing" />
                    </motion.span>
                  )}
                </AnimatePresence>
                <span className="truncate" title={tab.title}>
                  {title}
                </span>
              </div>

              {canCloseTabs && (
                <button
                  type="button"
                  className="-mr-1 shrink-0 rounded-full p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  aria-label={`Close ${title}`}
                >
                  <CloseIcon size={16} />
                </button>
              )}
            </div>
          );
        })}

        <Button
      variant='ghost'
          size='icon'
          className="flex size-7 shrink-0 items-center justify-center rounded-none  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onCreateTab}
          aria-label="Add new tab"
          data-onboarding="new-tab"
        >
          <AddSquareIcon size={18} />
        </Button>
      </div>
    </div>
  );
}
