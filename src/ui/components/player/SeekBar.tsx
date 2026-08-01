import { useEffect, useRef, useState } from "react";
import { shallowEqual, usePlayerSelector } from "../../../player/playerStore";
import { playerController } from "../../../player/playerStore";
import { playerUIStore, usePlayerUIState } from "../../stores/playerUIStore";

/*
 * Deliberately NOT beUI's RangeSlider: that component snaps to discrete steps, while
 * seeking is continuous and commits asynchronously on release (see handleSeekEnd's
 * pending-seek reconciliation). The native input keeps that behaviour; only the skin changed.
 */
const SEEK_SLIDER = [
  "h-1 w-full cursor-pointer appearance-none rounded-full bg-transparent",
  "disabled:cursor-default disabled:opacity-50",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
  // Track: filled to --slider-progress, muted beyond it.
  "[&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full",
  "[&::-webkit-slider-runnable-track]:bg-[linear-gradient(to_right,var(--color-primary)_var(--slider-progress),var(--color-muted)_var(--slider-progress))]",
  "[&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-muted",
  "[&::-moz-range-progress]:h-1 [&::-moz-range-progress]:rounded-full [&::-moz-range-progress]:bg-primary",
  // Thumb: hidden until hover/drag, matching the old bar's minimal resting state.
  "[&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full",
  "[&::-webkit-slider-thumb]:-mt-1 [&::-webkit-slider-thumb]:bg-foreground [&::-webkit-slider-thumb]:opacity-0",
  "[&::-webkit-slider-thumb]:transition-opacity hover:[&::-webkit-slider-thumb]:opacity-100",
  "focus-visible:[&::-webkit-slider-thumb]:opacity-100",
  "[&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]: [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-foreground",
].join(" ");

/**
 * Smallest time delta worth a re-render. The readout is whole seconds and the bar advances
 * about one pixel per quarter-second at typical widths, so anything finer is invisible.
 * 0.2s caps the player bar at ~5 renders/second instead of 60.
 */
const TIME_COMMIT_THRESHOLD_S = 0.2;

function formatTime(seconds: number): string {
  if (isNaN(seconds) || !isFinite(seconds)) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function SeekBar() {
  const state = usePlayerSelector(
    (player) => ({ currentTrack: player.currentTrack, status: player.status }),
    shallowEqual,
  );
  const uiState = usePlayerUIState();
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const seekTargetRef = useRef(0);
  const seekAnimationRef = useRef<number | null>(null);
  const seekAnimationDoneRef = useRef<(() => void) | null>(null);
  const seekAnimationPromiseRef = useRef<Promise<void> | null>(null);
  const pendingSeekRef = useRef<{ target: number; startedAt: number } | null>(null);
  const displayedTimeRef = useRef(0);
  const durationRef = useRef(0);
  const pointerStartRef = useRef({ x: 0, y: 0 });
  const isPointerDownRef = useRef(false);
  const isDraggingRef = useRef(false);

  const setDisplayedTime = (time: number) => {
    displayedTimeRef.current = time;
    setCurrentTime(time);
  };

  const cancelSeekAnimation = () => {
    if (seekAnimationRef.current !== null) {
      cancelAnimationFrame(seekAnimationRef.current);
      seekAnimationRef.current = null;
    }
    seekAnimationDoneRef.current?.();
    seekAnimationDoneRef.current = null;
    seekAnimationPromiseRef.current = null;
  };

  const animateTo = (target: number) => {
    cancelSeekAnimation();

    const start = displayedTimeRef.current;
    const startedAt = performance.now();
    const done = new Promise<void>((resolve) => {
      seekAnimationDoneRef.current = resolve;
    });
    seekAnimationPromiseRef.current = done;
    const animate = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / 120);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayedTime(start + (target - start) * eased);

      if (progress < 1) {
        seekAnimationRef.current = requestAnimationFrame(animate);
      } else {
        seekAnimationRef.current = null;
        seekAnimationDoneRef.current?.();
        seekAnimationDoneRef.current = null;
        seekAnimationPromiseRef.current = null;
      }
    };

    seekAnimationRef.current = requestAnimationFrame(animate);
    return done;
  };

  useEffect(() => () => cancelSeekAnimation(), []);

  /*
   * Poll the engine on a frame loop, but only commit to state when the value moved enough to
   * be visible. This used to setState on every frame, re-rendering the whole player bar 60
   * times a second for a readout that shows whole seconds and a bar where one pixel is
   * roughly a quarter of a second — about 55 of those 60 renders painted an identical frame.
   *
   * The loop itself stays at rAF so a seek still lands on the very next frame; it is the
   * commit that is gated. Seeks and drags bypass this entirely — they call setDisplayedTime
   * directly, so they remain frame-accurate.
   */
  useEffect(() => {
    let animationFrameId = 0;
    const update = () => {
      if (!uiState.isSeeking) {
        const engineTime = playerController.getCurrentTime();
        const pendingSeek = pendingSeekRef.current;
        if (
          pendingSeek
          && performance.now() - pendingSeek.startedAt < 750
          && Math.abs(engineTime - pendingSeek.target) > 0.75
        ) {
          setDisplayedTime(pendingSeek.target);
        } else {
          pendingSeekRef.current = null;
          if (Math.abs(engineTime - displayedTimeRef.current) >= TIME_COMMIT_THRESHOLD_S) {
            setDisplayedTime(engineTime);
          }
        }

        // Duration changes once per track, not once per frame.
        const engineDuration = playerController.getDuration();
        if (engineDuration !== durationRef.current) {
          durationRef.current = engineDuration;
          setDuration(engineDuration);
        }
      }
      animationFrameId = requestAnimationFrame(update);
    };
    animationFrameId = requestAnimationFrame(update);

    return () => cancelAnimationFrame(animationFrameId);
  }, [uiState.isSeeking, state.status]);

  const handleSeekStart = (event: React.PointerEvent<HTMLInputElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerStartRef.current = { x: event.clientX, y: event.clientY };
    isPointerDownRef.current = true;
    isDraggingRef.current = false;
    seekTargetRef.current = displayedTimeRef.current;
    playerUIStore.setSeeking(true);
  };

  const handleSeekMove = (event: React.PointerEvent<HTMLInputElement>) => {
    if (!isPointerDownRef.current || isDraggingRef.current) return;

    const distance = Math.hypot(
      event.clientX - pointerStartRef.current.x,
      event.clientY - pointerStartRef.current.y,
    );
    if (distance < 3) return;

    isDraggingRef.current = true;
    cancelSeekAnimation();
    const target = Number(event.currentTarget.value);
    seekTargetRef.current = target;
    setDisplayedTime(target);
  };

  const handleSeekEnd = async (_event: React.PointerEvent<HTMLInputElement>) => {
    const wasDragging = isDraggingRef.current;
    isPointerDownRef.current = false;
    isDraggingRef.current = false;
    const seekTime = seekTargetRef.current;
    const animationDone = wasDragging
      ? Promise.resolve()
      : (seekAnimationPromiseRef.current ?? Promise.resolve());

    try {
      pendingSeekRef.current = { target: seekTime, startedAt: performance.now() };
      await Promise.all([playerController.seekTo(seekTime), animationDone]);
    } finally {
      playerUIStore.setSeeking(false);
    }
  };

  const handleSeekCancel = () => {
    isPointerDownRef.current = false;
    isDraggingRef.current = false;
    cancelSeekAnimation();
    playerUIStore.setSeeking(false);
  };

  const handleSeekChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const target = parseFloat(e.target.value);
    seekTargetRef.current = target;

    if (isDraggingRef.current || !isPointerDownRef.current) {
      cancelSeekAnimation();
      setDisplayedTime(target);
      return;
    }

    void animateTo(target);
  };

  const commitKeyboardSeek = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
      return;
    }
    const seekTime = seekTargetRef.current;
    pendingSeekRef.current = { target: seekTime, startedAt: performance.now() };
    void playerController.seekTo(seekTime);
  };

  const isDisabled = !state.currentTrack || state.status === "loading";

  return (
    <div className="group/seek flex w-full items-center gap-2.5">
      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {formatTime(currentTime)}
      </span>
      <input
        type="range"
        min="0"
        max={duration || 100}
        step="any"
        value={currentTime}
        onChange={handleSeekChange}
        onKeyUp={commitKeyboardSeek}
        onPointerDown={handleSeekStart}
        onPointerMove={handleSeekMove}
        onPointerUp={(event) => void handleSeekEnd(event)}
        onPointerCancel={handleSeekCancel}
        disabled={isDisabled}
        className={SEEK_SLIDER}
        style={{
          "--slider-progress": `${duration > 0 ? (currentTime / duration) * 100 : 0}%`,
        } as React.CSSProperties}
        aria-label="Seek"
      />
      <span className="w-10 shrink-0 text-xs tabular-nums text-muted-foreground">
        {formatTime(duration)}
      </span>
    </div>
  );
}
