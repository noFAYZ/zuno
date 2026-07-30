import { useRef, useState, type CSSProperties } from "react";
import { BrandIcon, OS_ICON } from "./brandIcons";
import { DownloadIcon, PauseIcon, PlayIcon, SpeakerIcon } from "./icons";
import { Header } from "./Header";
import { LinkButton, Mono } from "./ui";
import { useReducedMotion } from "@/useReducedMotion";
import {
  GITHUB_REPO,
  RELEASES_URL,
  formatSize,
  type LatestRelease,
  type PlatformId,
} from "../releases";

const PLATFORM_LABEL: Record<PlatformId, string> = {
  windows: "Windows",
  "macos-arm": "macOS",
  "macos-intel": "macOS",
  linux: "Linux",
};

const DEMO_VIDEO = "https://pub-493a5d4ea10b45dcaa83917aa3856a32.r2.dev/zunodem.mp4";
const DEMO_POSTER = "./zuno-d1-1.2.PNG";
/** Read off the file's own header. Declared so the box is reserved before a byte arrives. */
const DEMO_W = 1234;
const DEMO_H = 922;

/** What the player window says it is playing. The demo is the product, so it is the track. */
const TRACK_TITLE = "zuno — desktop demo";

/** The queue along the foot. Six, which is one clean row, and each one is a real feature. */
const QUEUE = [
  "tabs, one queue each",
  "line-synced lyrics",
  "offline downloads",
  "your local files",
  "discord presence",
  "last.fm scrobbling",
];

/**
 * The small mono label used across the chrome.
 *
 * Not `Mono` from ui.tsx: that one hard-codes 13px, and passing a second font-size utility
 * beside it leaves which one wins up to Tailwind's class ordering rather than to intent.
 */
const MICRO = "font-mono text-[11px] tracking-tight tabular-nums";

const fmt = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/** Three bars on staggered delays — the app's own playing indicator, reused as a status light. */
function Equaliser({ playing }: { playing: boolean }) {
  return (
    <span className="flex h-3 items-end gap-[3px]" aria-hidden="true">
      {[0, 0.35, 0.7].map((delay, i) => (
        <span
          key={i}
          className={`w-[2px] rounded-full bg-primary ${playing ? "equaliser-bar" : ""}`}
          style={{ animationDelay: `${delay}s`, height: playing ? "100%" : "45%" }}
        />
      ))}
    </span>
  );
}

/**
 * The hero, built as the player window itself.
 *
 * The alternative — a screenshot floating over a gradient with a shadow under it — is the same
 * picture every desktop-app site ships. This one is the software: chrome across the top, the
 * footage in the pane, and a transport bar underneath whose controls are wired to the video
 * rather than drawn. The scrubber moves because the demo is playing, the play button pauses it,
 * the speaker unmutes it. Nothing on it is a picture of a control.
 *
 * That is also why there is no separate "watch the demo" button: the demo is already running,
 * and the page is holding the thing it is selling.
 */
function PlayerWindow({ autoPlay }: { autoPlay: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(autoPlay);
  const [muted, setMuted] = useState(true);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const progress = duration ? time / duration : 0;

  const toggle = () => {
    const el = video.current;
    if (!el) return;
    // State follows the element's own events, so a rejected autoplay or a browser-level pause
    // cannot leave the button lying about what the video is doing.
    if (el.paused) void el.play().catch(() => undefined);
    else el.pause();
  };

  const toggleSound = () => {
    const el = video.current;
    if (!el) return;
    el.muted = !el.muted;
    setMuted(el.muted);
  };

  const seek = (fraction: number) => {
    const el = video.current;
    if (el && duration) el.currentTime = fraction * duration;
  };

  return (
    <div className="relative">
      {/* The lamp behind the window. Tinted by the brand, not by a six-stop gradient. */}
      <div
        className="pointer-events-none absolute -inset-x-6 -bottom-8 -top-6 -z-10 rounded-[2rem] opacity-70 blur-3xl"
        style={{
          background:
            "radial-gradient(60% 60% at 30% 20%, color-mix(in oklch, var(--color-primary) 34%, transparent) 0%, transparent 70%)",
        }}
        aria-hidden="true"
      />

      <figure className="overflow-hidden rounded-2xl bg-[oklch(0.16_0_0)] shadow-[0_40px_120px_-30px_rgb(0_0_0/0.9)] ring-1 ring-white/10">
        {/* Titlebar. Zuno's own window has one, so the page's does too. */}
        <div className="flex h-10 items-center gap-3 border-b border-white/[0.07] px-4">
          <span className="flex gap-1.5" aria-hidden="true">
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-primary/70" />
          </span>
          <span className="mx-auto truncate font-mono text-[11px] uppercase tracking-[0.22em] text-foreground/35">
            zuno_
          </span>
          <span className={`${MICRO} hidden text-foreground/25 sm:block`}>
            {DEMO_W}×{DEMO_H}
          </span>
        </div>

        <video
          ref={video}
          className="block w-full bg-black"
          width={DEMO_W}
          height={DEMO_H}
          src={DEMO_VIDEO}
          poster={DEMO_POSTER}
          /* Autoplay is muted and inline because every mobile engine requires both, and it is
             withheld entirely under reduced motion — the transport below is then the way in. */
          autoPlay={autoPlay}
          muted
          loop
          playsInline
          preload="metadata"
          onClick={toggle}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          aria-label="Zuno playing a song, with the queue and synced lyrics open"
        />

        {/* Transport. Every control here moves the video above it. */}
        <div className="border-t border-white/[0.07] bg-[oklch(0.12_0_0)] px-4 py-3">
          <div className="flex items-center gap-3">
            <span className={`${MICRO} w-9 shrink-0 text-foreground/40`}>{fmt(time)}</span>
            <input
              className="scrub min-w-0 flex-1"
              type="range"
              min={0}
              max={1}
              step={0.001}
              value={progress}
              onChange={(e) => seek(e.currentTarget.valueAsNumber)}
              style={{ "--p": progress } as CSSProperties}
              aria-label="Seek the demo"
              aria-valuetext={`${fmt(time)} of ${fmt(duration)}`}
            />
            <span className={`${MICRO} w-9 shrink-0 text-right text-foreground/40`}>
              {fmt(duration)}
            </span>
          </div>

          <div className="mt-2 flex items-center gap-3">
            <img className="size-9 shrink-0 rounded-md bg-white/5 p-1.5" src="./logo.png" alt="" />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-medium text-foreground/90">{TRACK_TITLE}</span>
              <span className="flex items-center gap-2">
                <Equaliser playing={playing} />
                <span className={`${MICRO} text-foreground/35`}>
                  {playing ? "now playing" : "paused"}
                </span>
              </span>
            </span>

            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                className="grid size-9 place-items-center rounded-full text-foreground/50 transition-colors hover:bg-white/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={toggleSound}
                aria-pressed={!muted}
                aria-label={muted ? "Unmute the demo" : "Mute the demo"}
              >
                <SpeakerIcon size={18} muted={muted} />
              </button>
              <button
                type="button"
                className="grid size-10 place-items-center rounded-full bg-foreground text-background transition-transform hover:scale-105 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                onClick={toggle}
                aria-label={playing ? "Pause the demo" : "Play the demo"}
              >
                {playing ? <PauseIcon size={18} /> : <PlayIcon size={18} className="ml-0.5" />}
              </button>
            </div>
          </div>
        </div>
      </figure>
    </div>
  );
}

export function Hero({
  release,
  platform,
}: {
  release: LatestRelease | null;
  platform: PlatformId | null;
}) {
  const reducedMotion = useReducedMotion();
  const target = platform ?? "windows";
  const asset = release?.downloads[target];
  const label = platform ? PLATFORM_LABEL[platform] : "your system";

  return (
    <section
      id="top"
      className="grain relative isolate flex min-h-svh w-full flex-col overflow-hidden bg-background"
    >
      {/*
        Ambient artwork, the way a player does it: the frame behind the frame, blurred out to a
        wash of its own colour. It is the poster the video is already loading, so it costs one
        cached request and it changes with the product instead of being invented in a gradient
        editor.
      */}
      <img
        className="pointer-events-none absolute inset-0 -z-10 h-full w-full scale-110 object-cover opacity-25 blur-[90px] saturate-150"
        src={DEMO_POSTER}
        alt=""
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute inset-0 -z-10"
        style={{
          background:
            "radial-gradient(120% 80% at 50% 0%, transparent 20%, var(--color-background) 78%)",
        }}
        aria-hidden="true"
      />

      <Header />

      <div className="mx-auto grid w-full max-w-7xl flex-1 items-center gap-y-14 px-6 pb-12 pt-10 lg:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)] lg:gap-x-16 lg:pb-16 lg:pt-4">
        <div className="flex flex-col items-start">
          {/* Set as a player sets its status line: the state, then the pressing. */}
          <div className="flex items-center gap-2.5 rounded-full border border-white/10 bg-white/[0.04] py-1.5 pl-3 pr-4 backdrop-blur-sm">
            <Equaliser playing={!reducedMotion} />
            <span className={`${MICRO} uppercase tracking-[0.2em] text-foreground/45`}>
              {release ? `v${release.version}` : "apache-2.0"} · free forever
            </span>
          </div>

          {/*
            The one claim no wrapped browser tab can make, set at poster scale. The accent lands
            on the noun that is the whole argument.
          */}
          <h1 className="mt-7 text-balance text-[clamp(48px,6.6vw,92px)] font-semibold leading-[0.88] tracking-[-0.055em] text-foreground">
            <span className="block">Every tab</span>
            <span className="block">
              a <span className="text-primary">queue</span>.
            </span>
          </h1>

          <p className="mt-7 max-w-[42ch] text-pretty text-lg leading-8 text-foreground/60">
            A desktop client for your own YouTube Music account. Not a wrapped tab — a real
            window, with your downloads and local files in the same list.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <LinkButton
              href={asset?.url ?? RELEASES_URL}
              rel="noopener"
              className="group rounded-full px-7 py-4 text-lg transition-transform duration-200 hover:-translate-y-0.5"
            >
              <DownloadIcon
                size={20}
                className="transition-transform duration-200 group-hover:translate-y-0.5"
              />
              Download for {label}
            </LinkButton>

            <LinkButton
              variant="muted"
              href={GITHUB_REPO}
              rel="noopener"
              className="rounded-full px-6 py-4 text-lg transition-transform duration-200 hover:-translate-y-0.5"
            >
              <BrandIcon icon={OS_ICON.github} width={19} height={19} />
              Source
            </LinkButton>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-2">
            <span className="flex items-center gap-3" aria-label="Windows, macOS and Linux">
              <BrandIcon icon={OS_ICON.windows} width={16} height={16} />
              <BrandIcon icon={OS_ICON.macos} width={16} height={16} className="text-foreground" />
              <BrandIcon icon={OS_ICON.linux} width={16} height={16} />
            </span>
            <Mono className="text-foreground/35">
              {asset ? `${formatSize(asset.size)} · signed` : "windows · macos · linux"}
            </Mono>
          </div>
        </div>

        <div className="w-full max-lg:mx-auto max-lg:max-w-2xl">
          <PlayerWindow autoPlay={!reducedMotion} />
        </div>
      </div>

      {/* The queue. Static: the information is the point, and a marquee makes it unreadable. */}
      <div className="mx-auto w-full max-w-7xl border-t border-white/10 px-6 py-6">
        <span className={`${MICRO} uppercase tracking-[0.24em] text-foreground/30`}>up next</span>
        <ol className="mt-3 grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
          {QUEUE.map((track, i) => (
            <li key={track} className="flex items-baseline gap-2.5">
              <Mono className="text-foreground/25 tabular-nums">{String(i + 1).padStart(2, "0")}</Mono>
              <span className="text-pretty text-sm leading-6 text-foreground/60">{track}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
