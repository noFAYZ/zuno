import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { cn } from "@/lib/utils";
import { emit, listen } from "@tauri-apps/api/event";
import { cursorPosition, getCurrentWindow, LogicalSize, PhysicalPosition } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { SpinnerSteps } from "@/components/motion/loader";
import {
  ArrowUpIcon,
  CloseIcon,
  PauseActiveIcon,
  PlayActiveIcon,
  SkipNextIcon,
  SkipPreviousIcon,
} from "@/ui/icons";
import { saveMiniPlayerPosition, useMiniPlayerHoverAction } from "../../settings/miniPlayer";
import { isLinux, isMacOS, isWindows } from "../../platform";
import { Marquee } from "@/components/motion/marquee";
import { TrackArtwork } from "../TrackArtwork";

interface PlayerSync {
  status: string;
  artworkUrl: string | null;
  title: string | null;
  artist: string | null;
}

interface TimeSync {
  currentTime: number;
  duration: number;
}

interface VolumeSync {
  muted: boolean;
  volume: number;
}

const win = getCurrentWindow();

/*
 * One capsule that morphs, rather than two stacked pills.
 *
 * The capsule shrink-wraps its content (`w-max`), and the window is sized from the
 * capsule's *measured* width — no chrome arithmetic to drift out of sync with the markup.
 * Collapsed it is capped small (COLLAPSED_MAX_WIDTH); hovering lets it grow to fit the
 * transport row, and the ResizeObserver below resizes the window to match either state.
 */
const COLLAPSED_HEIGHT = 44;
/** Combined height of the two rows. The expanded capsule adds its padding on top. */
const EXPANDED_HEIGHT = 84;
/** Corner radius = half the collapsed height: a true stadium collapsed, a squircle-ish
 *  rounded rect expanded. Same corner throughout, which is what makes the morph read. */
const CAPSULE_RADIUS = COLLAPSED_HEIGHT / 2;
/** Inset applied on hover. One spacing unit (`p-1`) on this app's 0.34rem scale; kept as a
 *  number because the expanded height and the window height are derived from it. */
const EXPANDED_PADDING = 6;
const EXPANDED_CAPSULE_HEIGHT = EXPANDED_HEIGHT + EXPANDED_PADDING * 2;
/** Slack around the capsule for the hover margin and the press/scale transform. */
const WINDOW_PADDING = 8;
/*
 * The capsule is given an explicit width instead of shrink-wrapping, and the title column
 * takes whatever is left over (`flex-1 min-w-0`). That is the entire layout contract:
 * chrome can be added, removed or resized without anyone recomputing a text-column
 * constant, and no combination of values can overflow the capsule and be quietly clipped
 * by `overflow-hidden`. Width is also animatable this way, so the morph is continuous.
 */
const COLLAPSED_WIDTH = 160;
const EXPANDED_WIDTH = 260;
/** Thickness of the progress ring around the artwork. */
const PROGRESS_RING_WIDTH = 2;
const HOVER_MARGIN_X = 0;
const HOVER_MARGIN_Y = 8;
/*
 * Hysteresis: while expanded, the capsule is only released once the cursor clears a
 * *larger* box than the one that opened it. Expanding also re-centres the window, which can
 * shift the edge out from under a stationary cursor — without this the pill can oscillate,
 * and no grace period fixes that because the cursor genuinely leaves the region.
 */
const HOVER_RELEASE_SLACK = 6;
const COLLAPSE_GRACE_MS = 0;
/** How often the cached window rect is re-read as a safety net (poll ticks). */
const WINDOW_RECT_REFRESH_TICKS = 20;
const RIGHT_MOUSE_BUTTON = 2;
const LEFT_MOUSE_BUTTON = 0;
const INTERACTIVE_SELECTOR = "button, input, a, [role='button']";

const MINI_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-full text-neutral-300 transition-all hover:bg-white/10 hover:text-white active:scale-90 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50";

export default function MiniPlayer() {
  const [playerState, setPlayerState] = useState<PlayerSync>({
    status: "idle",
    artworkUrl: null,
    title: null,
    artist: null,
  });
  const [expanded, setExpanded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [timeState, setTimeState] = useState<TimeSync>({ currentTime: 0, duration: 0 });
  const [volumeState, setVolumeState] = useState<VolumeSync>({ muted: false, volume: 1 });
  const [seekPreviewTime, setSeekPreviewTime] = useState<number | null>(null);
  const [volumePreview, setVolumePreview] = useState<number | null>(null);
  const [cachedArtwork, setCachedArtwork] = useState<string | null>(null);
  const hoverAction = useMiniPlayerHoverAction();
  const expandedRef = useRef(false);
  const dragTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const seekPreviewClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const volumePreviewClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSeekScrubbingRef = useRef(false);
  const isSliderActiveRef = useRef(false);
  const lastSliderInputTimeStampRef = useRef<number | null>(null);
  const seekTargetRef = useRef(0);
  const pendingSeekTargetRef = useRef<number | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const capsuleRef = useRef<HTMLDivElement | null>(null);
  const titleViewportRef = useRef<HTMLDivElement | null>(null);
  const titleTextRef = useRef<HTMLSpanElement | null>(null);
  const [isTitleOverflowing, setIsTitleOverflowing] = useState(false);
  const capsuleWidthRef = useRef(0);
  const appliedWidthRef = useRef(0);
  const windowRectRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);
  const macAlbumDragActiveRef = useRef(false);
  const macAlbumDragMovedRef = useRef(false);
  const suppressNextAlbumArtClickRef = useRef(false);

  const setIgnoreCursorEventsWhenReady = async (ignore: boolean) => {
    if (isLinux) return;

    await win.setIgnoreCursorEvents(ignore);
  };

  const setExpandedBoth = (value: boolean) => {
    expandedRef.current = value;
    setExpanded(value);
  };

  /*
   * The hover poll used to ask the backend for position *and* size on every 50ms tick —
   * 60 IPC round-trips a second, forever, for values that only change when the window is
   * moved or resized. Both of those are events we already observe, so the rect is cached
   * and merely re-validated periodically in case something moves it behind our back.
   */
  const refreshWindowRect = async () => {
    const [position, size] = await Promise.all([win.outerPosition(), win.outerSize()]);
    const rect = { x: position.x, y: position.y, width: size.width, height: size.height };
    windowRectRef.current = rect;
    return rect;
  };

  const saveCurrentPosition = async () => {
    const position = await win.outerPosition();
    const nextPosition = { x: position.x, y: position.y };
    saveMiniPlayerPosition(nextPosition);
    await emit("mini-player:position-changed", nextPosition);
  };

  const saveCurrentPositionSoon = () => {
    window.setTimeout(() => {
      void saveCurrentPosition();
    }, 120);
    window.setTimeout(() => {
      void saveCurrentPosition();
    }, 500);
  };

  // Only scroll a title that actually overflows the column — a permanent marquee is noise.
  useEffect(() => {
    const viewport = titleViewportRef.current;
    const text = titleTextRef.current;
    if (!viewport || !text) return;

    const update = () => setIsTitleOverflowing(text.scrollWidth - viewport.clientWidth > 1);
    update();

    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    observer.observe(text);
    return () => observer.disconnect();
  }, [playerState.title]);

  /*
   * Keep the window exactly as wide as the capsule actually renders.
   *
   * A ResizeObserver on the real element beats computing width from constants: it can't
   * drift when the markup changes, and it accounts for fonts loading late. Only width is
   * tracked — the capsule's height changes on hover, and the window is already tall
   * enough for the expanded state, so height must stay put or hovering would jitter.
   */
  useEffect(() => {
    const capsule = capsuleRef.current;
    if (!capsule) return;

    let cancelled = false;
    let frame = 0;

    const applyWidth = async (cssWidth: number) => {
      const targetWidth = Math.min(
        EXPANDED_WIDTH + WINDOW_PADDING * 2,
        Math.ceil(cssWidth) + WINDOW_PADDING * 2,
      );
      if (targetWidth <= 0 || targetWidth === appliedWidthRef.current) return;
      appliedWidthRef.current = targetWidth;

      try {
        const previousPosition = await win.outerPosition();
        const previousSize = await win.outerSize();
        const centerX = previousPosition.x + previousSize.width / 2;
        const scale = window.devicePixelRatio || 1;

        await win.setSize(new LogicalSize(targetWidth, previousSize.height / scale));
        if (cancelled) return;

        // Re-read: the applied physical size depends on the monitor's scale factor.
        const nextSize = await win.outerSize();
        const nextPosition = new PhysicalPosition(
          Math.round(centerX - nextSize.width / 2),
          previousPosition.y,
        );
        await win.setPosition(nextPosition);
        if (cancelled) return;

        // We just moved and resized ourselves; the hover poll reads this cache.
        windowRectRef.current = {
          x: nextPosition.x,
          y: nextPosition.y,
          width: nextSize.width,
          height: nextSize.height,
        };

        const savedPosition = { x: nextPosition.x, y: nextPosition.y };
        saveMiniPlayerPosition(savedPosition);
        void emit("mini-player:position-changed", savedPosition);
      } catch (_) {
        // A failed resize just keeps the previous width; never worth interrupting playback.
      }
    };

    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const width = capsule.getBoundingClientRect().width;
        capsuleWidthRef.current = width;
        void applyWidth(width);
      });
    };

    const observer = new ResizeObserver(sync);
    observer.observe(capsule);
    sync();

    return () => {
      cancelled = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  useEffect(() => {
    const setup = async () => {
      const unlisten = await listen<PlayerSync>("player-state-sync", (event) => {
        setPlayerState((previous) => {
          if (event.payload.artworkUrl && event.payload.artworkUrl !== previous.artworkUrl) {
            setCachedArtwork(event.payload.artworkUrl);
          }

          return event.payload;
        });
      });

      /*
       * Asked for only once the listener above is live.
       *
       * `player-state-sync` is emitted on change, not on a timer, so a window created after
       * playback started never hears about the track already playing and sits on "Nothing
       * playing" until the next track change. Requesting after subscribing, rather than before,
       * is what keeps the reply from arriving before anything is listening for it.
       */
      void emit("mini-player:request-sync");

      return unlisten;
    };

    const cleanup = setup();
    return () => { cleanup.then((unlisten) => unlisten()); };
  }, []);

  useEffect(() => {
    return () => {
      if (dragTimerRef.current) {
        clearInterval(dragTimerRef.current);
      }
      if (seekPreviewClearTimerRef.current) {
        clearTimeout(seekPreviewClearTimerRef.current);
      }
      if (volumePreviewClearTimerRef.current) {
        clearTimeout(volumePreviewClearTimerRef.current);
      }
      setIsDragging(false);
    };
  }, []);

  useEffect(() => {
    const setup = async () => {
      const unlisten = await listen<TimeSync>("player-time-sync", (event) => {
        setTimeState(event.payload);
      });

      return unlisten;
    };

    const cleanup = setup();
    return () => { cleanup.then((unlisten) => unlisten()); };
  }, []);

  useEffect(() => {
    const pendingSeekTarget = pendingSeekTargetRef.current;
    if (pendingSeekTarget === null) return;

    if (Math.abs(timeState.currentTime - pendingSeekTarget) <= 0.75) {
      pendingSeekTargetRef.current = null;
      setSeekPreviewTime(null);
      if (seekPreviewClearTimerRef.current) {
        clearTimeout(seekPreviewClearTimerRef.current);
        seekPreviewClearTimerRef.current = null;
      }
    }
  }, [timeState.currentTime]);

  useEffect(() => {
    isSeekScrubbingRef.current = false;
    pendingSeekTargetRef.current = null;
    setSeekPreviewTime(null);
    setVolumePreview(null);
    if (seekPreviewClearTimerRef.current) {
      clearTimeout(seekPreviewClearTimerRef.current);
      seekPreviewClearTimerRef.current = null;
    }
    if (volumePreviewClearTimerRef.current) {
      clearTimeout(volumePreviewClearTimerRef.current);
      volumePreviewClearTimerRef.current = null;
    }
  }, [hoverAction]);

  useEffect(() => {
    const setup = async () => {
      const unlisten = await listen<VolumeSync>("player-volume-sync", (event) => {
        setVolumeState(event.payload);
      });

      return unlisten;
    };

    const cleanup = setup();
    return () => { cleanup.then((unlisten) => unlisten()); };
  }, []);

  useEffect(() => {
    const setup = async () => {
      const unlisten = await win.onMoved(({ payload }) => {
        const nextPosition = { x: payload.x, y: payload.y };
        if (windowRectRef.current) {
          windowRectRef.current = { ...windowRectRef.current, ...nextPosition };
        }
        saveMiniPlayerPosition(nextPosition);
        void emit("mini-player:position-changed", nextPosition);
      });

      return unlisten;
    };

    const cleanup = setup();
    return () => { cleanup.then((unlisten) => unlisten()); };
  }, []);

  useEffect(() => {
    if (isMacOS || isLinux) return;

    let isOver = false;
    let lastOverAt = 0;
    let hasEnabledPassThrough = false;
    let running = true;
    let ticks = 0;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (!running) return;

      try {
        if (!hasEnabledPassThrough) {
          await setIgnoreCursorEventsWhenReady(true);
          hasEnabledPassThrough = true;
        }

        const staleRect = ticks % WINDOW_RECT_REFRESH_TICKS === 0;
        ticks += 1;

        const [cursor, rect] = await Promise.all([
          cursorPosition(),
          staleRect || !windowRectRef.current
            ? refreshWindowRect()
            : Promise.resolve(windowRectRef.current),
        ]);
        const scale = window.devicePixelRatio || 1;

        /*
         * Hit-test the capsule, not the window. The window carries slack on every side
         * (WINDOW_PADDING), so treating the whole window as hoverable would expand the pill
         * from transparent dead space.
         * Measured width is in CSS px; window geometry is physical, hence the scale.
         */
        const capsuleHeight =
          (expandedRef.current ? EXPANDED_CAPSULE_HEIGHT : COLLAPSED_HEIGHT) * scale;
        const capsuleWidth = capsuleWidthRef.current * scale;
        const capsuleCenterX = rect.x + rect.width / 2;
        const capsuleBottom = rect.y + rect.height - WINDOW_PADDING * scale;

        // Once open, the region the cursor must leave is deliberately bigger than the one
        // it had to enter. See HOVER_RELEASE_SLACK.
        const slack = (expandedRef.current ? HOVER_RELEASE_SLACK : 0) * scale;
        const pillLeft = capsuleCenterX - capsuleWidth / 2 - HOVER_MARGIN_X - slack;
        const pillRight = capsuleCenterX + capsuleWidth / 2 + HOVER_MARGIN_X + slack;
        const pillBottom = capsuleBottom;
        const pillTop = capsuleBottom - capsuleHeight - HOVER_MARGIN_Y - slack;
        const hoverBottom = pillBottom + HOVER_MARGIN_Y + slack;
        const over = cursor.x >= pillLeft
          && cursor.x <= pillRight
          && cursor.y >= pillTop
          && cursor.y <= hoverBottom;

        if (over) {
          lastOverAt = Date.now();
        }

        const shouldStayOpen = isSliderActiveRef.current
          || over
          || (isOver && Date.now() - lastOverAt < COLLAPSE_GRACE_MS);

        if (shouldStayOpen && !isOver) {
          isOver = true;
          await setIgnoreCursorEventsWhenReady(false);
          setExpandedBoth(true);
        } else if (!shouldStayOpen && isOver) {
          isOver = false;
          await setIgnoreCursorEventsWhenReady(true);
          setExpandedBoth(false);
        }
      } catch (_) {}

      timer = setTimeout(poll, 50);
    };

    poll();
    return () => {
      running = false;
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!isMacOS && !isLinux) return;

    const collapse = () => setExpandedBoth(false);

    window.addEventListener("blur", collapse);
    document.addEventListener("visibilitychange", collapse);

    const setup = async () => {
      const unlistenFocus = await win.onFocusChanged(({ payload: focused }) => {
        if (!focused) collapse();
      });
      return () => {
        unlistenFocus();
      };
    };

    const cleanup = setup();
    return () => {
      window.removeEventListener("blur", collapse);
      document.removeEventListener("visibilitychange", collapse);
      void cleanup.then((unlisten) => unlisten());
    };
  }, []);

  const handleRestore = async () => {
    await emit("mini-player:restore-main");

    /*
     * Best-effort, and deliberately not awaited into the restore below.
     *
     * The main window answers that event by *destroying* this window rather than hiding it,
     * so a hide issued here can land after the window is already gone and reject. Awaited,
     * that rejection aborts the rest of this function and leaves the main window in the
     * background — the click appears to do nothing. Kept only for the instant visual
     * feedback while the destroy makes its way across.
     */
    void win.hide().catch(() => {});

    const mainWin = await WebviewWindow.getByLabel("main");
    if (mainWin) {
      await mainWin.show();
      await mainWin.unminimize();
      await mainWin.setFocus();
    }
  };

  const stopAlbumArtDrag = async (restoreIfClick: boolean) => {
    if (!macAlbumDragActiveRef.current) return;

    macAlbumDragActiveRef.current = false;
    if (dragTimerRef.current) {
      clearInterval(dragTimerRef.current);
      dragTimerRef.current = null;
    }

    setIsDragging(false);
    try {
      await saveCurrentPosition();
    } catch (_) {}
    try {
      await win.setCursorIcon("grab");
    } catch (_) {}

    const shouldRestore = restoreIfClick && !macAlbumDragMovedRef.current;
    macAlbumDragMovedRef.current = false;
    if (shouldRestore) {
      await handleRestore();
    }
  };

  const handleAlbumArtMouseDown = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.currentTarget.blur();

    if (isLinux && event.button === LEFT_MOUSE_BUTTON) {
      event.stopPropagation();
      suppressNextAlbumArtClickRef.current = true;
      setIsDragging(true);

      const stopNativeDrag = () => {
        setIsDragging(false);
        saveCurrentPositionSoon();
      };
      document.addEventListener("mouseup", stopNativeDrag, { once: true });
      window.addEventListener("blur", stopNativeDrag, { once: true });

      try {
        await win.startDragging();
        saveCurrentPositionSoon();
      } catch (_) {}
      return;
    }

    if (!isMacOS || event.button !== LEFT_MOUSE_BUTTON) return;

    event.stopPropagation();
    suppressNextAlbumArtClickRef.current = true;

    if (dragTimerRef.current) {
      clearInterval(dragTimerRef.current);
      dragTimerRef.current = null;
    }

    const startCursor = await cursorPosition();
    const startPosition = await win.outerPosition();
    macAlbumDragActiveRef.current = true;
    macAlbumDragMovedRef.current = false;
    setIsDragging(true);
    try {
      await win.setCursorIcon("grabbing");
    } catch (_) {}

    const stopDragFromDocument = (upEvent: globalThis.MouseEvent) => {
      if (upEvent.button === LEFT_MOUSE_BUTTON) void stopAlbumArtDrag(true);
    };
    const stopDragOnBlur = () => {
      void stopAlbumArtDrag(false);
    };

    document.addEventListener("mouseup", stopDragFromDocument, { once: true });
    window.addEventListener("blur", stopDragOnBlur, { once: true });

    dragTimerRef.current = setInterval(() => {
      void (async () => {
        if (!macAlbumDragActiveRef.current) return;

        const cursor = await cursorPosition();
        const deltaX = cursor.x - startCursor.x;
        const deltaY = cursor.y - startCursor.y;
        if (Math.hypot(deltaX, deltaY) > 3) {
          macAlbumDragMovedRef.current = true;
        }

        await win.setPosition(new PhysicalPosition(
          startPosition.x + deltaX,
          startPosition.y + deltaY,
        ));
      })();
    }, 16);
  };

  const handleAlbumArtClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (suppressNextAlbumArtClickRef.current) {
      suppressNextAlbumArtClickRef.current = false;
      event.preventDefault();
      return;
    }

    void handleRestore();
  };

  /*
   * Destroys rather than hides. Dismissing the pill is a request for it to stop being there,
   * and a hidden webview keeps its entire renderer process — the thing this window is created
   * on demand to avoid. The main window creates a fresh one next time it is backgrounded.
   */
  const handleClose = async () => {
    await win.destroy();
  };

  const stopManualWindowDrag = async () => {
    if (dragTimerRef.current) {
      clearInterval(dragTimerRef.current);
      dragTimerRef.current = null;
    }

    setIsDragging(false);
    try {
      await saveCurrentPosition();
    } catch (_) {}
    try {
      await win.setCursorIcon("grab");
    } catch (_) {}
    await setIgnoreCursorEventsWhenReady(false);
  };

  const startManualWindowDrag = async (button: number) => {
    if (dragTimerRef.current) {
      clearInterval(dragTimerRef.current);
      dragTimerRef.current = null;
    }

    const startCursor = await cursorPosition();
    const startPosition = await win.outerPosition();

    setIsDragging(true);
    try {
      await win.setCursorIcon("grabbing");
    } catch (_) {}
    await setIgnoreCursorEventsWhenReady(false);

    const stopDragFromDocument = (upEvent: globalThis.MouseEvent) => {
      if (upEvent.button === button) void stopManualWindowDrag();
    };
    const stopDragOnBlur = () => {
      void stopManualWindowDrag();
    };

    document.addEventListener("mouseup", stopDragFromDocument, { once: true });
    window.addEventListener("blur", stopDragOnBlur, { once: true });

    dragTimerRef.current = setInterval(() => {
      void (async () => {
        const cursor = await cursorPosition();
        const nextX = startPosition.x + cursor.x - startCursor.x;
        const nextY = startPosition.y + cursor.y - startCursor.y;

        await win.setPosition(new PhysicalPosition(nextX, nextY));
      })();
    }, 16);
  };

  const startNativeWindowDrag = async () => {
    setIsDragging(true);
    const stopNativeDrag = () => {
      setIsDragging(false);
      saveCurrentPositionSoon();
    };
    document.addEventListener("mouseup", stopNativeDrag, { once: true });
    window.addEventListener("blur", stopNativeDrag, { once: true });

    try {
      await win.startDragging();
      saveCurrentPositionSoon();
    } catch (_) {
      setIsDragging(false);
    }
  };

  const handleContainerMouseDown = async (event: MouseEvent<HTMLDivElement>) => {
    const isInteractiveTarget = event.target instanceof Element
      && Boolean(event.target.closest(INTERACTIVE_SELECTOR));

    if (event.button === RIGHT_MOUSE_BUTTON) {
      event.preventDefault();
      event.stopPropagation();
      await startManualWindowDrag(RIGHT_MOUSE_BUTTON);
      return;
    }

    if (event.button === LEFT_MOUSE_BUTTON && !isInteractiveTarget) {
      event.preventDefault();
      if (isWindows) {
        await startManualWindowDrag(LEFT_MOUSE_BUTTON);
        return;
      }

      await startNativeWindowDrag();
    }
  };

  const handleMacPointerEnter = () => {
    if (isMacOS || isLinux) setExpandedBoth(true);
  };

  const handleMacPointerLeave = (event: MouseEvent<HTMLElement>) => {
    if (!isMacOS && !isLinux) return;
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && wrapperRef.current?.contains(nextTarget)) return;
    if (isSliderActiveRef.current) return;
    setExpandedBoth(false);
  };

  const handleMacFocusOut = (event: FocusEvent<HTMLDivElement>) => {
    if (!isMacOS && !isLinux) return;
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && wrapperRef.current?.contains(nextTarget)) return;
    if (isSliderActiveRef.current) return;
    setExpandedBoth(false);
  };

  const keepSeekPreviewUntilSync = (target: number) => {
    pendingSeekTargetRef.current = target;
    if (seekPreviewClearTimerRef.current) {
      clearTimeout(seekPreviewClearTimerRef.current);
    }
    seekPreviewClearTimerRef.current = setTimeout(() => {
      pendingSeekTargetRef.current = null;
      setSeekPreviewTime(null);
      seekPreviewClearTimerRef.current = null;
    }, 1200);
  };

  const keepVolumePreviewUntilSync = () => {
    if (volumePreviewClearTimerRef.current) {
      clearTimeout(volumePreviewClearTimerRef.current);
    }
    volumePreviewClearTimerRef.current = setTimeout(() => {
      setVolumePreview(null);
      volumePreviewClearTimerRef.current = null;
    }, 500);
  };

  const finishSliderInteraction = () => {
    isSliderActiveRef.current = false;
    if (isMacOS || isLinux) {
      setExpandedBoth(false);
    }
  };

  const handleSliderPointerDown = (event: PointerEvent<HTMLInputElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    isSliderActiveRef.current = true;
    setExpandedBoth(true);
    if (hoverAction !== "seek") return;

    isSeekScrubbingRef.current = true;
    const target = Number(event.currentTarget.value);
    seekTargetRef.current = target;
    setSeekPreviewTime(target);
  };

  const handleSliderPointerEnd = () => {
    if (hoverAction !== "seek") {
      keepVolumePreviewUntilSync();
      finishSliderInteraction();
      return;
    }

    if (!isSeekScrubbingRef.current) {
      finishSliderInteraction();
      return;
    }

    isSeekScrubbingRef.current = false;
    const target = seekTargetRef.current;
    setSeekPreviewTime(target);
    keepSeekPreviewUntilSync(target);
    void emit("mini-player:seek", { time: target });
    finishSliderInteraction();
  };

  const handleSliderPointerCancel = () => {
    isSeekScrubbingRef.current = false;
    isSliderActiveRef.current = false;
    pendingSeekTargetRef.current = null;
    setSeekPreviewTime(null);
    setVolumePreview(null);
  };

  const handleSliderInput = (event: FormEvent<HTMLInputElement>) => {
    if (event.timeStamp === lastSliderInputTimeStampRef.current) return;
    lastSliderInputTimeStampRef.current = event.timeStamp;

    const value = parseFloat(event.currentTarget.value);
    if (hoverAction === "volume") {
      setVolumePreview(value);
      void emit("mini-player:volume", { volume: value });
      return;
    }

    seekTargetRef.current = value;
    setSeekPreviewTime(value);
    if (!isSeekScrubbingRef.current) {
      keepSeekPreviewUntilSync(value);
      void emit("mini-player:seek", { time: value });
    }
  };

  const handleSliderKeyUp = (event: KeyboardEvent<HTMLInputElement>) => {
    if (
      hoverAction !== "seek"
      || !["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)
    ) {
      return;
    }

    const target = seekTargetRef.current;
    keepSeekPreviewUntilSync(target);
    void emit("mini-player:seek", { time: target });
  };

  const isPlaying = playerState.status === "playing";
  const isLoading = playerState.status === "loading";
  const artworkUrl = playerState.artworkUrl ?? cachedArtwork;
  const displayedVolume = volumePreview ?? (volumeState.muted ? 0 : volumeState.volume);
  const displayedTime = seekPreviewTime ?? timeState.currentTime;
  const sliderValue = hoverAction === "volume" ? displayedVolume : displayedTime;
  const sliderMax = hoverAction === "volume" ? 1 : timeState.duration || 100;
  const sliderStep = hoverAction === "volume" ? 0.01 : "any";
  const sliderProgress = hoverAction === "volume"
    ? displayedVolume * 100
    : timeState.duration > 0
      ? (displayedTime / timeState.duration) * 100
      : 0;

  // Playback progress is drawn as a ring around the artwork, so the collapsed pill
  // communicates position without spending any of its 100px budget on a progress bar.
  const trackProgress = timeState.duration > 0
    ? Math.min(100, Math.max(0, (displayedTime / timeState.duration) * 100))
    : 0;

  return (
    <div
      ref={wrapperRef}
      className="flex h-full w-full items-end justify-center bg-transparent"
      style={{ paddingBottom: WINDOW_PADDING }}
      onBlur={handleMacFocusOut}
    >
      {/*
        A single capsule that morphs between states instead of two floating pills.
        `w-max` shrink-wraps it to its content; the window is then measured from this
        element, so there is exactly zero dead space around the design.
      */}
      <div
        ref={capsuleRef}
        className={cn(
          "relative flex flex-col overflow-hidden",
          "bg-neutral-900/80 backdrop-blur-xl",
          "ring-1 ring-white/10 transition-[height,width,padding,background-color] duration-100",
          "[transition-timing-function:cubic-bezier(0.32,0.72,0,1)]",
          expanded ? "bg-neutral-900/95 ring-white/15" : "",
          isDragging ? "cursor-grabbing" : "cursor-grab",
        )}
        style={{
          height: expanded ? EXPANDED_CAPSULE_HEIGHT : COLLAPSED_HEIGHT,
          width: expanded ? EXPANDED_WIDTH : COLLAPSED_WIDTH,
          borderRadius: CAPSULE_RADIUS,
          padding: expanded ? EXPANDED_PADDING : 0,
        }}
        onMouseEnter={handleMacPointerEnter}
        onMouseLeave={handleMacPointerLeave}
        onMouseDown={(event) => void handleContainerMouseDown(event)}
        onMouseUp={(event) => {
          if (event.button === RIGHT_MOUSE_BUTTON) void stopManualWindowDrag();
        }}
        onContextMenu={(event) => event.preventDefault()}
      >
        {/*
          Album-reactive backdrop: the artwork itself, blown up and blurred past recognition,
          tints the glass with the record's own palette. It costs no extra network request
          (the same URL the artwork element loads) and no colour extraction, yet the capsule
          takes on a different mood per track — which is the thing a flat neutral pill can
          never do. Deliberately weak so white text keeps its contrast.
        */}
        {artworkUrl ? (
          <span
            key={artworkUrl}
            className="pointer-events-none absolute inset-0 -z-10 scale-150 bg-cover bg-center opacity-30 blur-2xl"
            style={{ backgroundImage: `url("${artworkUrl}")` }}
            aria-hidden="true"
          />
        ) : null}

        {/* Specular top edge — the highlight a real glass material catches. */}
        <span
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-linear-to-r from-transparent via-white/25 to-transparent"
          aria-hidden="true"
        />

        {/* ── Identity row: always visible ─────────────────────────────── */}
        <div
          className={cn(
            "flex shrink-0 items-center gap-2 pl-1.5 transition-[padding] duration-300",
            expanded ? "pr-3" : "pr-2",
          )}
          style={{ height: COLLAPSED_HEIGHT }}
        >
          <button
            className="group/art relative grid size-11 shrink-0 place-items-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            onMouseDown={(event) => void handleAlbumArtMouseDown(event)}
            onClick={handleAlbumArtClick}
            aria-label="Restore main window"
            title="Restore"
          >
            {/*
              Progress drawn as a ring around the art: position without spending width.
              The conic gradient fills the whole disc, so a radial mask cuts the centre out
              to leave a hairline ring — thickness is one constant rather than the gap
              between the button and the artwork.
            */}
            <span
              className="absolute inset-0 rounded-full"
              style={{
                background: `conic-gradient(rgba(255,255,255,0.92) ${trackProgress}%, rgba(255,255,255,0.16) 0)`,
                maskImage: `radial-gradient(closest-side, transparent calc(100% - ${PROGRESS_RING_WIDTH}px), #000 calc(100% - ${PROGRESS_RING_WIDTH}px))`,
                WebkitMaskImage: `radial-gradient(closest-side, transparent calc(100% - ${PROGRESS_RING_WIDTH}px), #000 calc(100% - ${PROGRESS_RING_WIDTH}px))`,
              }}
              aria-hidden="true"
            />
            <TrackArtwork
              artworkUrl={artworkUrl ?? undefined}
              className={cn(
                "relative size-[34px] shrink-0 rounded-full bg-neutral-800 transition-transform duration-300",
                isPlaying && "motion-safe:animate-[spin_12s_linear_infinite]",
                "group-hover/art:scale-90",
              )}
              iconSize={15}
              loading="eager"
            />
            <span
              className="pointer-events-none absolute inset-0 grid place-items-center rounded-full bg-black/60 opacity-0 transition-opacity duration-200 group-hover/art:opacity-100"
              aria-hidden="true"
            >
              <ArrowUpIcon size={13} />
            </span>
          </button>

          {/* Takes whatever the chrome leaves. `min-w-0` is what lets it actually shrink —
              a flex item's default `min-width:auto` would let the title push the row wider
              than the capsule and get clipped instead of scrolling. */}
          <div
            className="min-w-0 flex-1 overflow-hidden"
            aria-live="polite"
            aria-atomic="true"
          >
            <div ref={titleViewportRef} className="relative overflow-hidden">
              <span
                ref={titleTextRef}
                aria-hidden={isTitleOverflowing}
                className={cn(
                  "block whitespace-nowrap text-[12px] font-semibold leading-tight tracking-[-0.01em] text-white",
                  isTitleOverflowing && "invisible absolute",
                )}
              >
                {playerState.title ?? "Nothing playing"}
              </span>
              {isTitleOverflowing && (
                <Marquee
                  speed={18}
                  gap="2rem"
                  className="text-[12px] font-semibold leading-tight tracking-[-0.01em] text-white"
                >
                  <span className="whitespace-nowrap" title={playerState.title ?? undefined}>
                    {playerState.title}
                  </span>
                </Marquee>
              )}
            </div>
            {playerState.artist ? (
              <p className="truncate text-[10px] leading-tight text-white/55">
                {playerState.artist}
              </p>
            ) : null}
          </div>

          <button
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-full text-white/50 transition-all duration-200",
              "hover:bg-white/15 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60",
              expanded ? "ml-1 scale-100 opacity-100" : "pointer-events-none w-0 scale-75 opacity-0",
            )}
            type="button"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => void handleClose()}
            aria-label="Close mini player"
            title="Close"
          >
            <CloseIcon size={13} aria-hidden="true" />
          </button>
        </div>

        {/* ── Control row ───────────────────────────────────────────────
            Collapsed it is clamped to zero width so it cannot hold the capsule open past
            the collapsed cap; expanding releases it and the capsule grows to fit. */}
        <div
          className={cn(
            "flex items-center gap-2 transition-[opacity,width,padding] duration-300",
            expanded
              ? "px-3 opacity-100 delay-75"
              : "pointer-events-none w-0 overflow-hidden px-0 opacity-0",
          )}
          style={{ height: EXPANDED_HEIGHT - COLLAPSED_HEIGHT }}
          aria-hidden={!expanded}
        >
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              className={MINI_BUTTON}
              onClick={() => emit("mini-player:skip-previous")}
              aria-label="Previous"
              tabIndex={expanded ? 0 : -1}
            >
              <SkipPreviousIcon size={15} aria-hidden="true" />
            </button>
            <button
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white text-neutral-900 transition-transform duration-150 hover:scale-105 active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
              onClick={() => emit("mini-player:toggle-play-pause")}
              aria-label={isLoading ? "Loading song" : isPlaying ? "Pause" : "Play"}
              tabIndex={expanded ? 0 : -1}
            >
              <span className="relative grid size-4 place-items-center" aria-hidden="true">
                <span className={cn("absolute transition-opacity duration-150", isLoading || isPlaying ? "opacity-0" : "opacity-100")}>
                  <PlayActiveIcon size={15} />
                </span>
                <span className={cn("absolute transition-opacity duration-150", !isLoading && isPlaying ? "opacity-100" : "opacity-0")}>
                  <PauseActiveIcon size={15} />
                </span>
                <span className={cn("absolute transition-opacity duration-150", isLoading ? "opacity-100" : "opacity-0")}>
                  <SpinnerSteps size={13} color="currentColor" />
                </span>
              </span>
            </button>
            <button
              className={MINI_BUTTON}
              onClick={() => emit("mini-player:skip-next")}
              aria-label="Next"
              tabIndex={expanded ? 0 : -1}
            >
              <SkipNextIcon size={15} aria-hidden="true" />
            </button>
          </div>

          <input
            type="range"
            min={0}
            max={sliderMax}
            step={sliderStep}
            value={sliderValue}
            onInput={handleSliderInput}
            onChange={handleSliderInput}
            onKeyUp={handleSliderKeyUp}
            onPointerDown={handleSliderPointerDown}
            onPointerUp={handleSliderPointerEnd}
            onPointerCancel={handleSliderPointerCancel}
            tabIndex={expanded ? 0 : -1}
            className="h-1 min-w-24 flex-1 cursor-pointer appearance-none rounded-full bg-transparent [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,#fff_var(--slider-progress),rgba(255,255,255,0.18)_var(--slider-progress))] [&::-webkit-slider-thumb]:size-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:-mt-[3px] [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:transition-transform hover:[&::-webkit-slider-thumb]:scale-125"
            aria-label={hoverAction === "volume" ? "Volume" : "Song position"}
            style={{ "--slider-progress": `${sliderProgress}%` } as CSSProperties}
          />
        </div>
      </div>
    </div>
  );
}
