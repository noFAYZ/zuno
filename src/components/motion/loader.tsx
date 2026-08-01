"use client";
// beui.dev/components/motion/loader

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useState } from "react";
import { EASE_IN_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";
import clsx from "clsx";

export type LoaderVariant =
  | "spinner"
  | "dots"
  | "bars"
  | "dot-matrix"
  | "dither"
  | "ascii"
  | "ascii-line"
  | "ascii-braille"
  | "ascii-blocks"
  | "ascii-bounce"
  | "morph"
  | "comet"
  | "music"
  | "scramble"
  | "metaballs"
  | "newton"
  | "helix"
  | "percent";

// Terminal-style frame sets — the loaders CLI AI agents cycle through.
const ASCII_SETS: Record<string, string[]> = {
  ascii: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  "ascii-line": ["|", "/", "-", "\\"],
  "ascii-braille": ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
  "ascii-blocks": ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂"],
  "ascii-bounce": ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"],
};

export interface LoaderProps {
  /** Which animation to render. */
  variant?: LoaderVariant;
  /** Base square size in px. Everything scales from this. */
  size?: number;
  /** Seconds per animation cycle. */
  speed?: number;
  /** Accessible label announced to screen readers. */
  label?: string;
  /**
   * Drives the "percent" variant from real progress (0-100).
   *
   * Left undefined the variant sweeps 0-100 on a timer, which is fine as decoration but
   * misleading over a real transfer — it would sit at 100% while bytes were still arriving.
   */
  value?: number;
  className?: string;
}

// Reduced motion keeps a calm opacity pulse and drops every transform.
const REDUCED = {
  animate: { opacity: [1, 0.4, 1] },
  transition: { duration: 1.2, ease: EASE_IN_OUT, repeat: Infinity },
};

export function Loader({
  variant = "spinner",
  size = 32,
  speed = 1,
  label = "Loading",
  value,
  className,
}: LoaderProps) {
  const reduce = useReducedMotion() ?? false;

  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        "inline-flex items-center justify-center text-foreground",
        className,
      )}
    >
      {variant === "spinner" && <SpinnerSteps size={size} speed={speed} reduce={reduce} />}
      {variant === "dots" && <Dots size={size} speed={speed} reduce={reduce} />}
      {variant === "bars" && <Bars size={size} speed={speed} reduce={reduce} />}
      {variant === "dot-matrix" && (
        <DotMatrix size={size} speed={speed} reduce={reduce} />
      )}
      {variant === "dither" && <Dither size={size} speed={speed} reduce={reduce} />}
      {ASCII_SETS[variant] && (
        <Ascii frames={ASCII_SETS[variant]} size={size} speed={speed} reduce={reduce} />
      )}
      {variant === "morph" && <Morph size={size} speed={speed} reduce={reduce} />}
      {variant === "comet" && <Comet size={size} speed={speed} reduce={reduce} />}
      {variant === "scramble" && (
        <Scramble size={size} speed={speed} reduce={reduce} />
      )}
      {variant === "metaballs" && (
        <Metaballs size={size} speed={speed} reduce={reduce} />
      )}
      {variant === "newton" && <Newton size={size} speed={speed} reduce={reduce} />}
      {variant === "helix" && <Helix size={size} speed={speed} reduce={reduce} />}
      {variant === "ascii" && <Ascii frames={ASCII_SETS['ascii-blocks']} size={size} speed={speed} reduce={reduce} />}
      {variant === "percent" && (
        <Percent size={size} speed={speed} reduce={reduce} value={value} />
      )}
      {variant === "music" && (
  <Music size={size} speed={speed} reduce={reduce} />
)}
      <span className="sr-only">{label}</span>
    </span>
  );
}

interface PartProps {
  size: number;
  speed: number;
  reduce: boolean;
}

function Dots({ size, speed, reduce }: PartProps) {
  const dot = size * 0.24;
  return (
    <span className="flex items-center" style={{ gap: size * 0.14 }}>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="rounded-full bg-current"
          style={{ width: dot, height: dot }}
          animate={
            reduce
              ? { opacity: [0.4, 1, 0.4] }
              : { y: [0, -size * 0.3, 0], opacity: [0.5, 1, 0.5] }
          }
          transition={{
            duration: speed,
            ease: EASE_IN_OUT,
            repeat: Infinity,
            delay: i * speed * 0.16,
          }}
        />
      ))}
    </span>
  );
}

function Ascii({
  frames,
  size,
  speed,
  reduce,
}: PartProps & { frames: string[] }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    // Reduced motion slows the cycle rather than stopping it — it's a glyph
    // swap, not on-screen movement.
    const step = ((reduce ? speed * 2.5 : speed) / frames.length) * 1000;
    const id = setInterval(
      () => setFrame((f) => (f + 1) % frames.length),
      step,
    );
    return () => clearInterval(id);
  }, [frames.length, speed, reduce]);

  return (
    <span
      className="font-mono leading-none tabular-nums"
      style={{ fontSize: size, lineHeight: 1 }}
    >
      {frames[frame % frames.length]}
    </span>
  );
}

type SpinnerStepsProps = {
  size?: number;
  color?: string;
  speed?: number;
  className?: string;
  reduce?: boolean;
};

const OPACITY = [
  1,
  1,
  1,
  0.9,
  0.8,
  0.7,
  0.6,
  0.5,
  0.4,
  0.3,
  0.2,
  0.1,
];

export function Music({ size, speed, reduce }: PartProps) {
  const bars = 23;

  const gap = size * 0.03;
  const width = (size - gap * (bars - 1)) / bars;

  const [levels, setLevels] = useState<number[]>(
    () => Array(bars).fill(0.35),
  );

  useEffect(() => {
    if (reduce) return;

    let raf = 0;
    let time = 0;

    const animate = () => {
      time += 0.018 * speed;

      setLevels((prev) =>
        prev.map((old, i) => {
          const x = i / (bars - 1);

          // Louder in the middle, softer on the edges.
          const envelope =
            0.35 +
            Math.exp(-Math.pow((x - 0.5) / 0.28, 2)) * 0.65;

          // Organic moving waves.
          const low =
            Math.sin(time * 0.85 + x * Math.PI * 2.2) * 0.28;

          const mid =
            Math.sin(time * 1.9 - x * Math.PI * 7.4) * 0.16;

          const high =
            Math.cos(time * 3.8 + x * Math.PI * 15.0) * 0.06;

          // Traveling energy pulse.
          const pulsePos =
            (Math.sin(time * 0.45) + 1) / 2;

          const pulse =
            Math.exp(
              -Math.pow(
                (x - pulsePos) / 0.11,
                2,
              ),
            ) * 0.42;

          let target =
            (0.46 + low + mid + high + pulse) *
            envelope;

          target = Math.max(0.08, Math.min(1, target));

          // Smooth movement.
          return old * 0.78 + target * 0.22;
        }),
      );

      raf = requestAnimationFrame(animate);
    };

    raf = requestAnimationFrame(animate);

    return () => cancelAnimationFrame(raf);
  }, [reduce, speed]);

  if (reduce) {
    return (
      <span
        className="flex items-end justify-center"
        style={{
          gap,
          height: size,
        }}
      >
        {Array.from({ length: bars }).map((_, i) => {
          const center =
            1 -
            Math.abs(i - (bars - 1) / 2) /
              ((bars - 1) / 2);

          return (
            <motion.span
              key={i}
              className="rounded-full bg-current"
              style={{
                width: width * (0.82 + center * 0.22),
                height: size,
                originY: 1,
              }}
              animate={{
                opacity: [0.45, 1, 0.45],
              }}
              transition={{
                duration: 1.8,
                repeat: Infinity,
                delay: i * 0.03,
              }}
            />
          );
        })}
      </span>
    );
  }

  return (
    <span
      className="flex items-end justify-center"
      style={{
        gap,
        height: size,
      }}
    >
      {levels.map((level, i) => {
        const center =
          Math.exp(
            -Math.pow(
              (i - (bars - 1) / 2) /
                (bars / 4),
              2,
            ),
          );

        return (
          <motion.span
            key={i}
            className="bg-current rounded-full"
            animate={{
              scaleY: level,
              opacity: 0.35 + level * 0.65,
            }}
            transition={{
              type: "spring",
              stiffness: 340,
              damping: 24,
              mass: 0.22,
            }}
            style={{
              width:
                width *
                (0.82 + center * 0.25),

              height: size,

              originY: 1,

              borderRadius: 9999,

              filter:
                "drop-shadow(0 0 4px currentColor)",

              willChange:
                "transform, opacity",
            }}
          />
        );
      })}
    </span>
  );
}

interface MusicVisualizerProps {
  /** Odd counts keep a single bar exactly on the centre, which is what the ramp is built on. */
  bars?: number;
  className?: string;
}

/**
 * Equaliser bars in the brand accent.
 *
 * Colour and timing are both a function of one thing — how far a bar sits from the middle —
 * so both are computed here rather than written out as `:nth-child` rules. Fifteen hand-kept
 * pairs in the stylesheet could only ever restate this ramp, and would silently stop covering
 * the bars the moment the count changed.
 *
 * The shades are `color-mix` against `--color-primary` rather than fixed hex, so the whole
 * thing follows the brand accent and works on any surface: mixing toward transparent means
 * the faded edges pick up whatever is behind them instead of a guessed background.
 */
export function MusicVisualizer({ bars = 15, className }: MusicVisualizerProps) {
  const centre = (bars - 1) / 2;

  return (
    <div className={cn("music", className)} aria-hidden="true">
      {Array.from({ length: bars }, (_, index) => {
        // 0 in the middle, 1 at either edge.
        const distance = centre === 0 ? 0 : Math.abs(index - centre) / centre;

        return (
          <div
            key={index}
            className="music-bar"
            style={{
              background: `color-mix(in oklab, var(--color-primary) ${Math.round(
                100 - distance * 45,
              )}%, transparent)`,
              // The centre leads and the edges trail, so the motion reads as coming from
              // the middle out rather than as fifteen bars bouncing independently.
              animationDelay: `${(0.1 + distance * 0.4).toFixed(0)}s`,
            }}
          />
        );
      })}
    </div>
  );
}

export function SpinnerSteps({
  size = 24,
  color = "currentColor",
  speed = 0.8,
  className,
  reduce = false,
}: SpinnerStepsProps) {
  const spokes = 12;
  const width = 4;
  const height = 16;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      className={clsx("spinner-steps", className)}
      style={
        {
          color,
          // Reduced motion slows the wheel rather than stopping it: the spokes are
          // pre-faded, so a frozen one reads as a normal static graphic and the UI
          // looks hung. Same call as the Ascii variant below.
          "--spinner-duration": `${reduce ? speed * 3 : speed}s`,
        } as React.CSSProperties
      }
    >
      {Array.from({ length: spokes }).map((_, i) => (
        <rect
          key={i}
          x={50 - width / 2}
          y={8}
          width={width}
          height={height}
          rx={width / 2}
          fill="currentColor"
          opacity={OPACITY[i]}
          transform={`rotate(${i * (360 / spokes)} 50 50)`}
        />
      ))}
    </svg>
  );
}

// Each shape is sampled at the same number of points and emitted as an SVG
// path with identical command structure, so framer tweens the `d` attribute
// point-to-point — a real morph, not a snap. (clip-path polygon strings don't
// interpolate reliably in framer, which left the shapes broken.)
const MORPH_POINTS = 24;

function ngonRadius(ang: number, n: number, phase = 0) {
  const seg = (2 * Math.PI) / n;
  const a = ang - phase;
  const local = (((a % seg) + seg) % seg) - seg / 2;
  return Math.cos(Math.PI / n) / Math.cos(local);
}

function morphPath(radiusAt: (ang: number) => number) {
  const parts: string[] = [];
  for (let i = 0; i < MORPH_POINTS; i++) {
    const ang = (i / MORPH_POINTS) * 2 * Math.PI - Math.PI / 2;
    const r = Math.min(1.05, radiusAt(ang));
    const x = (50 + Math.cos(ang) * 46 * r).toFixed(2);
    const y = (50 + Math.sin(ang) * 46 * r).toFixed(2);
    parts.push(`${i === 0 ? "M" : "L"}${x} ${y}`);
  }
  return `${parts.join(" ")} Z`;
}

const MORPH_PATHS = [
  morphPath(() => 1), // circle
  morphPath((a) => ngonRadius(a, 4, Math.PI / 4)), // square
  morphPath((a) => ngonRadius(a, 3)), // triangle
  morphPath((a) => ngonRadius(a, 6)), // hexagon
  morphPath((a) => ngonRadius(a, 4)), // diamond
];

// Each shape appears twice in a row so it fully forms and HOLDS before the
// next morph. Even keyframe spacing then alternates hold / morph segments.
const MORPH_SEQ = [...MORPH_PATHS.flatMap((p) => [p, p]), MORPH_PATHS[0]];
// Rotation and scale only change across the morph segments, staying put on the
// holds, so a settled shape sits still.
const MORPH_ROT = [0, 0, 72, 72, 144, 144, 216, 216, 288, 288, 360];
const MORPH_SCALE = [1, 1, 0.88, 0.88, 1, 1, 0.88, 0.88, 1, 1, 1];

function Morph({ size, speed, reduce }: PartProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img">
      <title>Loading</title>
      <motion.path
        fill="currentColor"
        d={MORPH_PATHS[0]}
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
        animate={
          reduce
            ? { opacity: [1, 0.4, 1] }
            : { d: MORPH_SEQ, rotate: MORPH_ROT, scale: MORPH_SCALE }
        }
        transition={
          reduce
            ? { duration: 1.4, ease: EASE_IN_OUT, repeat: Infinity }
            : { duration: speed * 5, ease: EASE_IN_OUT, repeat: Infinity }
        }
      />
    </svg>
  );
}

const COMET_TRAIL = [0, 1, 2, 3, 4, 5];

function Comet({ size, speed, reduce }: PartProps) {
  const head = size * 0.2;
  const r = size / 2 - head / 2;
  return (
    <span className="relative" style={{ width: size, height: size }}>
      <motion.span
        className="absolute inset-0"
        animate={reduce ? REDUCED.animate : { rotate: 360 }}
        transition={
          reduce
            ? REDUCED.transition
            : { duration: speed, ease: "linear", repeat: Infinity }
        }
      >
        {COMET_TRAIL.map((i) => {
          const scale = 1 - i * 0.13;
          const sz = head * scale;
          return (
            <span
              key={i}
              className="absolute top-1/2 left-1/2 rounded-full bg-current"
              style={{
                width: sz,
                height: sz,
                marginLeft: -sz / 2,
                marginTop: -sz / 2,
                opacity: 1 - i * 0.16,
                transform: `rotate(${-i * 15}deg) translateY(${-r}px)`,
              }}
            />
          );
        })}
      </motion.span>
    </span>
  );
}

const SCRAMBLE_TARGET = "LOADING";
const SCRAMBLE_GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<>/*#@";

function Scramble({ size, speed, reduce }: PartProps) {
  const [text, setText] = useState(SCRAMBLE_TARGET);
  useEffect(() => {
    if (reduce) {
      setText(SCRAMBLE_TARGET);
      return;
    }
    let tick = 0;
    const total = SCRAMBLE_TARGET.length + 4;
    const id = setInterval(
      () => {
        const reveal = tick % total;
        let s = "";
        for (let i = 0; i < SCRAMBLE_TARGET.length; i++) {
          s +=
            i < reveal
              ? SCRAMBLE_TARGET[i]
              : SCRAMBLE_GLYPHS[
                  Math.floor(Math.random() * SCRAMBLE_GLYPHS.length)
                ];
        }
        setText(s);
        tick++;
      },
      (speed / SCRAMBLE_TARGET.length) * 1000 * 0.55,
    );
    return () => clearInterval(id);
  }, [speed, reduce]);

  return (
    <span
      className="font-mono font-medium tracking-[0.2em] tabular-nums"
      style={{ fontSize: size * 0.42 }}
    >
      {text}
    </span>
  );
}

function Metaballs({ size, speed, reduce }: PartProps) {
  const id = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img">
      <title>Loading</title>
      <defs>
        <filter id={id}>
          <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="b" />
          <feColorMatrix
            in="b"
            values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -8"
          />
        </filter>
      </defs>
      <g filter={`url(#${id})`} fill="currentColor">
        <motion.circle
          cy="50"
          r="15"
          animate={reduce ? { opacity: [0.4, 1, 0.4] } : { cx: [30, 70, 30] }}
          transition={{ duration: speed * 1.6, ease: EASE_IN_OUT, repeat: Infinity }}
          cx={reduce ? 40 : undefined}
        />
        <motion.circle
          cy="50"
          r="15"
          animate={reduce ? { opacity: [0.4, 1, 0.4] } : { cx: [70, 30, 70] }}
          transition={{ duration: speed * 1.6, ease: EASE_IN_OUT, repeat: Infinity }}
          cx={reduce ? 60 : undefined}
        />
      </g>
    </svg>
  );
}

const NEWTON_BALLS = [0, 1, 2, 3, 4];

function Newton({ size, speed, reduce }: PartProps) {
  const d = size * 0.2;
  const out = d * 1.1;
  // Only the end balls move: the left slides out and back on the first half,
  // then the right on the second half — the impact appears to jump the three
  // still middle balls. Pure horizontal slide, no swing, no strings.
  const moves: Record<number, { x: number[]; times: number[] }> = {
    0: { x: [0, -out, 0, 0], times: [0, 0.28, 0.5, 1] },
    4: { x: [0, 0, out, 0], times: [0, 0.5, 0.78, 1] },
  };

  return (
    <span className="flex items-center justify-center" style={{ height: d }}>
      {NEWTON_BALLS.map((i) => {
        const move = moves[i];
        return (
          <motion.span
            key={i}
            className="rounded-full bg-current"
            style={{ width: d, height: d }}
            animate={reduce || !move ? undefined : { x: move.x }}
            transition={
              reduce || !move
                ? undefined
                : {
                    duration: speed * 1.5,
                    ease: EASE_IN_OUT,
                    repeat: Infinity,
                    times: move.times,
                  }
            }
          />
        );
      })}
    </span>
  );
}

function Helix({ size, speed, reduce }: PartProps) {
  const rows = 7;
  const dot = size * 0.14;
  const amp = size * 0.32;
  return (
    <span className="relative" style={{ width: size, height: size }}>
      {Array.from({ length: rows }, (_, r) => {
        const top = (r / (rows - 1)) * (size - dot);
        const delay = (r / rows) * speed;
        return (
          <span key={`row-${top}`}>
            <motion.span
              className="absolute rounded-full bg-current"
              style={{ width: dot, height: dot, left: size / 2 - dot / 2, top }}
              animate={
                reduce
                  ? { opacity: [0.4, 1, 0.4] }
                  : {
                      x: [amp, -amp, amp],
                      scale: [1, 0.5, 1],
                      opacity: [1, 0.45, 1],
                    }
              }
              transition={{
                duration: speed,
                ease: EASE_IN_OUT,
                repeat: Infinity,
                delay,
              }}
            />
            <motion.span
              className="absolute rounded-full bg-current"
              style={{ width: dot, height: dot, left: size / 2 - dot / 2, top }}
              animate={
                reduce
                  ? { opacity: [0.4, 1, 0.4] }
                  : {
                      x: [-amp, amp, -amp],
                      scale: [0.5, 1, 0.5],
                      opacity: [0.45, 1, 0.45],
                    }
              }
              transition={{
                duration: speed,
                ease: EASE_IN_OUT,
                repeat: Infinity,
                delay,
              }}
            />
          </span>
        );
      })}
    </span>
  );
}

function Percent({ size, speed, reduce, value }: PartProps & { value?: number }) {
  const [p, setP] = useState(0);
  const isControlled = value !== undefined;

  useEffect(() => {
    // No timer at all when a real value is supplied, so the two cannot fight over the number.
    if (isControlled) return;

    const dur = (reduce ? speed * 2 : speed) * 1000;
    const start = { t: 0 };
    const tickMs = 40;
    const id = setInterval(() => {
      start.t += tickMs;
      const next = Math.min(100, Math.round((start.t / dur) * 100));
      setP(next);
      if (next >= 100) start.t = 0;
    }, tickMs);
    return () => clearInterval(id);
  }, [speed, reduce, isControlled]);

  const shown = isControlled ? Math.min(100, Math.max(0, Math.round(value))) : p;

  return (
    <span
      className="flex flex-col items-center"
      style={{ gap: size * 0.14, width: size * 1.4 }}
    >
      <span
        className="font-mono font-medium tabular-nums"
        style={{ fontSize: size * 0.42, lineHeight: 1 }}
      >
        {shown}%
      </span>
      <span
        className="w-full overflow-hidden rounded-full bg-current/15"
        style={{ height: Math.max(3, size * 0.1) }}
      >
        <span
          className="block h-full rounded-full bg-current"
          style={{ width: `${shown}%` }}
        />
      </span>
    </span>
  );
}

function Bars({ size, speed, reduce }: PartProps) {
  const bar = size * 0.16;
  return (
    <span className="flex items-center" style={{ gap: size * 0.1, height: size }}>
      {[0, 1, 2, 3].map((i) => (
        <motion.span
          key={i}
          className="rounded-full bg-current"
          style={{ width: bar, height: size, originY: 1 }}
          animate={
            reduce ? { opacity: [0.4, 1, 0.4] } : { scaleY: [0.3, 1, 0.3] }
          }
          transition={{
            duration: speed,
            ease: EASE_IN_OUT,
            repeat: Infinity,
            delay: i * speed * 0.12,
          }}
        />
      ))}
    </span>
  );
}

function DotMatrix({ size, speed, reduce }: PartProps) {
  const n = 3;
  const gap = size * 0.14;
  const dot = (size - gap * (n - 1)) / n;
  const cells = Array.from({ length: n * n }, (_, idx) => idx);
  return (
    <span
      className="grid"
      style={{
        gap,
        gridTemplateColumns: `repeat(${n}, ${dot}px)`,
      }}
    >
      {cells.map((idx) => {
        const x = idx % n;
        const y = Math.floor(idx / n);
        // Diagonal wave: cells light in order of their distance from the corner.
        const delay = ((x + y) / (2 * (n - 1))) * speed;
        return (
          <motion.span
            key={idx}
            className="rounded-full bg-current"
            style={{ width: dot, height: dot }}
            animate={
              reduce
                ? { opacity: [0.3, 1, 0.3] }
                : { opacity: [0.2, 1, 0.2], scale: [0.7, 1, 0.7] }
            }
            transition={{
              duration: speed,
              ease: EASE_IN_OUT,
              repeat: Infinity,
              delay,
            }}
          />
        );
      })}
    </span>
  );
}

// Ordered Bayer 4x4 matrix — the classic dithering threshold pattern. Cells
// light in this order, so the fill shimmers like a dissolving halftone.
const BAYER_4 = [
  0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5,
];

function Dither({ size, speed, reduce }: PartProps) {
  const n = 4;
  const gap = Math.max(1, size * 0.05);
  const cell = (size - gap * (n - 1)) / n;
  return (
    <span
      className="grid"
      style={{ gap, gridTemplateColumns: `repeat(${n}, ${cell}px)` }}
    >
      {BAYER_4.map((order, idx) => (
        <motion.span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed matrix cells, order never changes
          key={idx}
          className="bg-current"
          style={{ width: cell, height: cell }}
          animate={reduce ? { opacity: [0.3, 1, 0.3] } : { opacity: [0.1, 1, 0.1] }}
          transition={{
            duration: speed,
            ease: EASE_IN_OUT,
            repeat: Infinity,
            delay: (order / BAYER_4.length) * speed,
          }}
        />
      ))}
    </span>
  );
}
