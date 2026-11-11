import { useCallback, useRef } from "react";
import { TrackArtwork } from "./TrackArtwork";

/** Canvas resolution. CSS stretches it ~40x, and bilinear upscaling is most of the softening. */
const WASH_SIZE = 64;

/**
 * A cover as a soft colour wash: blurred once into a tiny canvas, then stretched by CSS.
 *
 * A live `filter: blur()` on a window-sized layer is re-applied by the compositor every frame the
 * layer is drawn, and under a scrolling page or the lyrics drift that is every frame. Painting
 * once costs one 64px draw per cover. The hidden `TrackArtwork` keeps its full URL fallback
 * ladder; the canvas is display-only, so a cross-origin (tainted) image is fine.
 */
export function BlurredArtwork({
  artworkUrl,
  className,
  saturate = 1.7,
}: {
  artworkUrl: string;
  className?: string;
  saturate?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const paint = useCallback((image: HTMLImageElement) => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    // Ignored where canvas filters are unsupported; the upscale alone still reads as a blur.
    context.filter = `blur(1px) saturate(${saturate})`;
    context.drawImage(image, 0, 0, WASH_SIZE, WASH_SIZE);
  }, [saturate]);

  return (
    <>
      <TrackArtwork
        artworkUrl={artworkUrl}
        size={120}
        iconSize={0}
        loading="eager"
        onImageLoad={paint}
        className="pointer-events-none absolute size-px opacity-0"
      />
      <canvas ref={canvasRef} width={WASH_SIZE} height={WASH_SIZE} className={className} aria-hidden="true" />
    </>
  );
}
