import type { SVGProps } from "react";

/**
 * Icons, hand-rolled rather than pulled from Solar.
 *
 * The app routes every icon through `@/ui/icons` and pays for ~1.2k modules of Solar to do it.
 * This page needs six glyphs; a dependency and a barrel import for that would be the tail
 * wagging the dog. Sized and stroked to match Solar Linear (24px box, 1.5 stroke) so they sit
 * correctly beside the app's own screenshots.
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 20, children, ...props }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 20h16" />
    </Icon>
  );
}

/* Transport glyphs are solid — a hairline triangle reads as an arrow, not a play button. */
export function PlayIcon(props: IconProps) {
  return (
    <Icon fill="currentColor" stroke="none" {...props}>
      <path d="M8 5.2v13.6a1 1 0 0 0 1.53.85l10.6-6.8a1 1 0 0 0 0-1.7L9.53 4.35A1 1 0 0 0 8 5.2Z" />
    </Icon>
  );
}

export function PauseIcon(props: IconProps) {
  return (
    <Icon fill="currentColor" stroke="none" {...props}>
      <rect x="6.5" y="4.5" width="4" height="15" rx="1.4" />
      <rect x="13.5" y="4.5" width="4" height="15" rx="1.4" />
    </Icon>
  );
}

/** One glyph, two states: the waves are dropped when muted rather than drawing a second icon. */
export function SpeakerIcon({ muted, ...props }: IconProps & { muted?: boolean }) {
  return (
    <Icon {...props}>
      <path
        d="M4 9.5h3l4.3-3.6a.8.8 0 0 1 1.3.6v11a.8.8 0 0 1-1.3.6L7 14.5H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z"
        fill="currentColor"
        stroke="none"
      />
      {muted ? (
        <>
          <path d="m17 10 4 4" />
          <path d="m21 10-4 4" />
        </>
      ) : (
        <>
          <path d="M16.5 9.5a3.5 3.5 0 0 1 0 5" />
          <path d="M19 7a7 7 0 0 1 0 10" />
        </>
      )}
    </Icon>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m5 13 4 4L19 7" />
    </Icon>
  );
}

export function ShieldIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3l7 3v5.5c0 4.3-3 8.2-7 9.5-4-1.3-7-5.2-7-9.5V6l7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </Icon>
  );
}
