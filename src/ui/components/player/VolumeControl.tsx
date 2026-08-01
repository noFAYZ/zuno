import { useEffect, useState } from "react";
import { RangeSlider } from "@/components/motion/range-slider";
import { VolumeLoudIcon, VolumeMutedIcon, VolumeSmallIcon } from "@/ui/icons";
import { playerController, shallowEqual, usePlayerSelector } from "../../../player/playerStore";
import { FloatingPanel } from "../FloatingPanel";

/** Scroll step over the icon, matching the old inline slider's wheel behaviour. */
const WHEEL_STEP_PERCENT = 5;

/**
 * Volume as a single icon that opens a slider on hover.
 *
 * The bar previously carried a permanently visible 96px slider for a control most people
 * touch rarely. Collapsing it to the icon returns that width to the track title, and the
 * slider is one hover away rather than hidden behind a click.
 *
 * The panel is portalled (see FloatingPanel): the player bar sits inside the window's
 * `overflow-hidden` root, so a panel positioned within the bar would be clipped by it.
 */
export function VolumeControl() {
  /* This component writes volume on every pointer move of the slider, so it is the last one
     that should be subscribed to fields it does not read. */
  const playerState = usePlayerSelector(
    (state) => ({ volume: state.volume, muted: state.muted }),
    shallowEqual,
  );
  const [isOpen, setIsOpen] = useState(false);
  const [volume, setVolume] = useState(() => playerController.getVolume());
  const [isMuted, setIsMuted] = useState(() => playerController.isMuted());

  // The engine is the source of truth: the mini player and OS media keys change it too.
  useEffect(() => {
    setVolume(playerState.volume);
    setIsMuted(playerState.muted);
  }, [playerState.muted, playerState.volume]);

  const displayedVolume = isMuted ? 0 : volume;
  const percent = Math.round(displayedVolume * 100);

  const applyVolume = (nextPercent: number) => {
    const next = Math.min(1, Math.max(0, nextPercent / 100));
    setVolume(next);
    // Dragging to a level is itself an unmute; dragging to zero is a mute.
    setIsMuted(next === 0);
    void playerController.setVolume(next);
  };

  const toggleMute = () => {
    setIsMuted((muted) => !muted);
    void playerController.toggleMute();
  };

  const VolumeGlyph = isMuted
    ? VolumeMutedIcon
    : displayedVolume < 0.5
      ? VolumeSmallIcon
      : VolumeLoudIcon;

  return (
    <FloatingPanel
      open={isOpen}
      onOpenChange={setIsOpen}
      side="top"
      openOnHover
      triggerClassName="shrink-0"
      className="w-52"
      trigger={
        <button
          type="button"
          onClick={toggleMute}
          onWheel={(event) => {
            const delta = event.deltaY || event.deltaX;
            if (delta === 0) return;
            applyVolume(percent + (delta < 0 ? 1 : -1) * WHEEL_STEP_PERCENT);
          }}
          aria-label={isMuted ? `Unmute (volume ${percent}%)` : `Mute (volume ${percent}%)`}
          className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <VolumeGlyph size={18} aria-hidden="true" />
        </button>
      }
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-xs font-medium text-foreground">
            {isMuted ? "Muted" : "Volume"}
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">{percent}%</span>
        </div>
        <RangeSlider
          value={percent}
          onValueChange={applyVolume}
          min={0}
          max={100}
          step={1}
          showTicks={false}
          aria-label="Volume"
        />
      </div>
    </FloatingPanel>
  );
}
