import { useEffect, useRef, useState, type MouseEvent, type WheelEvent } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  getMiniPlayerSkinInfo,
  saveMiniPlayerPosition,
  type MiniPlayerSkinId,
} from "../../settings/miniPlayer";
import { useReduceMotion } from "../../settings/renderEffects";
import { isLinux } from "../../platform";
import { restoreMainWindow, showMiniPlayerCloseMenu, useMiniPlayerBridge } from "./useMiniPlayerBridge";
import { SKIN_COMPONENTS } from "./skins";

const win = getCurrentWindow();
const INTERACTIVE_SELECTOR = "button, input, a, [role='button']";
const SEEK_STEP_SEC = 5;
const VOLUME_STEP = 0.05;
const VOLUME_READOUT_MS = 1000;

/**
 * Runs a fixed-size skin in the mini window: sizes and drags the window, and wires the skin
 * to playback. Skins themselves only draw, which is what lets Settings preview them.
 */
export function SkinnedMiniPlayer({ skin }: { skin: Exclude<MiniPlayerSkinId, "classic"> }) {
  const { playerState, timeState, volumeState, artworkUrl } = useMiniPlayerBridge();
  const reduceMotion = useReduceMotion();
  const Skin = SKIN_COMPONENTS[skin];
  // The volume just asked for, shown until the main window's sync catches up.
  const [pendingVolume, setPendingVolume] = useState<number | null>(null);
  const readoutTimerRef = useRef<number | undefined>(undefined);
  const volume = pendingVolume ?? (volumeState.muted ? 0 : volumeState.volume);
  // Read by the keyboard and wheel handlers, which must not rebind on every time tick.
  const latestRef = useRef({ time: 0, duration: 0, volume: 1 });
  latestRef.current = { time: timeState.currentTime, duration: timeState.duration, volume };

  const setVolume = (value: number) => {
    const next = Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
    latestRef.current.volume = next;
    setPendingVolume(next);
    void emit("mini-player:volume", { volume: next });
    window.clearTimeout(readoutTimerRef.current);
    readoutTimerRef.current = window.setTimeout(() => setPendingVolume(null), VOLUME_READOUT_MS);
  };

  const nudgeVolume = (delta: number) => setVolume(latestRef.current.volume + delta);

  const seekBy = (delta: number) => {
    const { time, duration } = latestRef.current;
    if (duration <= 0) return;
    void emit("mini-player:seek", { time: Math.min(duration, Math.max(0, time + delta)) });
  };

  /*
   * Space, ←/→ and ↑/↓ work on any skin without each one wiring them up. A focused button or
   * slider keeps its own keys, so Space on the play key never toggles twice.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest("input, button")) return;
      const action = {
        " ": () => void emit("mini-player:toggle-play-pause"),
        ArrowLeft: () => seekBy(-SEEK_STEP_SEC),
        ArrowRight: () => seekBy(SEEK_STEP_SEC),
        ArrowUp: () => nudgeVolume(VOLUME_STEP),
        ArrowDown: () => nudgeVolume(-VOLUME_STEP),
      }[event.key];
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.clearTimeout(readoutTimerRef.current);
    };
  }, []);

  // Proportional, so a trackpad's small deltas fine-tune and a wheel notch moves ~5%.
  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    nudgeVolume(Math.max(-0.1, Math.min(0.1, -event.deltaY / 2000)));
  };

  useEffect(() => {
    const { width, height } = getMiniPlayerSkinInfo(skin);
    void win.setSize(new LogicalSize(width, height)).catch(() => {});
    // Classic leaves the window click-through between hovers; a skin is solid throughout.
    if (!isLinux) void win.setIgnoreCursorEvents(false).catch(() => {});
  }, [skin]);

  useEffect(() => {
    const unlisten = win.onMoved(({ payload }) => {
      const position = { x: payload.x, y: payload.y };
      saveMiniPlayerPosition(position);
      void emit("mini-player:position-changed", position);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  const handleMouseDown = (event: MouseEvent<HTMLDivElement>) => {
    // A skin claims a press (the vinyl's rim seek) by preventing it.
    if (event.button !== 0 || event.defaultPrevented) return;
    if (event.target instanceof Element && event.target.closest(INTERACTIVE_SELECTOR)) return;
    event.preventDefault();
    void win.startDragging().catch(() => {});
  };

  return (
    <div
      className="grid h-full w-full cursor-grab place-items-center bg-transparent active:cursor-grabbing"
      onMouseDown={handleMouseDown}
      onWheel={handleWheel}
      onContextMenu={(event) => {
        event.preventDefault();
        void showMiniPlayerCloseMenu();
      }}
    >
      <Skin
        title={playerState.title}
        artist={playerState.artist}
        artworkUrl={artworkUrl}
        isPlaying={playerState.status === "playing"}
        isLoading={playerState.status === "loading"}
        isError={playerState.status === "error"}
        currentTime={timeState.currentTime}
        duration={timeState.duration}
        volume={volume}
        volumeVisible={pendingVolume !== null}
        reduceMotion={reduceMotion}
        onTogglePlay={() => void emit("mini-player:toggle-play-pause")}
        onNext={() => void emit("mini-player:skip-next")}
        onPrevious={() => void emit("mini-player:skip-previous")}
        onSeek={(time) => void emit("mini-player:seek", { time })}
        onVolume={setVolume}
        onRestore={() => void restoreMainWindow()}
        onClose={() => void win.destroy()}
      />
    </div>
  );
}
