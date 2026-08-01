import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { ShuffleActiveIcon } from "@/ui/icons";
import type { Track } from "../../datasource/types";
import { PickCard } from "./PickCard";

interface DiceCardProps {
  tracks: Track[];
  isSpinning?: boolean;
  onClick?: () => void;
}

export function DiceCard({ tracks, isSpinning = false, onClick }: DiceCardProps) {
  const [previewIndex, setPreviewIndex] = useState(0);

  useEffect(() => {
    if (!isSpinning || tracks.length === 0) return;
    const intervalId = window.setInterval(() => {
      setPreviewIndex((index) => (index + 1) % tracks.length);
    }, 90);
    return () => window.clearInterval(intervalId);
  }, [isSpinning, tracks.length]);

  const preview = tracks[previewIndex % Math.max(1, tracks.length)];

  /*
   * Shares PickCard's shell so the surprise tile is a peer of the picks rather than a
   * differently-shaped outlier in the same row. Only the badge differs: a shuffle mark that
   * is always visible (this card's whole purpose) and spins while it is choosing, where a
   * track card reveals a play button on hover.
   */
  return (
    <PickCard
      artworkUrl={preview?.artworkUrl}
      title="Surprise me"
      subtitle="Pick something for me"
      disabled={tracks.length === 0 || isSpinning}
      onSelect={onClick}
      accessory={
        <ShuffleActiveIcon
          size={22}
          className={cn(isSpinning && "motion-safe:animate-spin")}
        />
      }
    />
  );
}
