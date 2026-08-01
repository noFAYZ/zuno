import { type MouseEvent, type ReactNode } from "react";
import { TiltCard } from "@/components/motion/tilt-card";
import { PlayActiveIcon } from "@/ui/icons";
import { TrackArtwork } from "./TrackArtwork";

/**
 * Rendered card width in CSS pixels.
 *
 * The default covers the `minmax(9rem…9.5rem, 1fr)` grids these sit in. It only has to land in
 * the right size bucket, not be exact — a column stretched a little wider by `1fr` still
 * resolves to the same request.
 */
const DEFAULT_CARD_SIZE = 176;

interface AlbumCardProps {
  color?: string;
  artworkUrl?: string;
  title?: string;
  subtitle?: string;
  subtitleContent?: ReactNode;
  /** Override when the card is laid out at a materially different width. */
  size?: number;
  onClick?: () => void;
  onContextMenu?: (event: MouseEvent<HTMLDivElement>) => void;
}

export function AlbumCard({
  color = "#333333",
  artworkUrl,
  title,
  subtitle,
  subtitleContent,
  size = DEFAULT_CARD_SIZE,
  onClick,
  onContextMenu,
}: AlbumCardProps) {
  return (
    <div
      className="group/card flex w-full cursor-pointer flex-col gap-2 rounded-xl p-2 transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onClick?.();
      }}
      role="button"
      tabIndex={0}
    >
      <TiltCard max={9} className="aspect-square w-full overflow-hidden rounded-lg">
        <div className="relative size-full" style={{ backgroundColor: color }}>
          <TrackArtwork
            className="size-full object-cover"
            artworkUrl={artworkUrl}
            iconSize={48}
            size={size}
            variant="album"
          />
          {/* Play affordance fades in on hover rather than sitting permanently on the art. */}
          <div className="pointer-events-none absolute inset-0 grid place-items-center bg-background/50 opacity-0 transition-opacity group-hover/card:opacity-100">
            <span className="grid size-12 place-items-center rounded-full bg-primary text-primary-foreground shadow-lg">
              <PlayActiveIcon size={26} />
            </span>
          </div>
        </div>
      </TiltCard>

      {title && (
        <span className="line-clamp-2 text-sm font-medium text-foreground">{title}</span>
      )}
      {(subtitleContent || subtitle) && (
        <span className="line-clamp-1 text-xs text-muted-foreground">
          {subtitleContent ?? subtitle}
        </span>
      )}
    </div>
  );
}
