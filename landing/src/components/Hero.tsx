import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { BrandIcon, OS_ICON, SERVICE_ICON } from "./brandIcons";
import { Deck } from "./Deck";
import { ArrowDownIcon, ArrowRightIcon } from "./icons";
import { FOCUS_RING, LinkButton, cn } from "./ui";
import { formatCount } from "../github";
import { GITHUB_REPO, RELEASES_URL, timeAgo, type LatestRelease, type PlatformId } from "../releases";

const PLATFORM_LABEL: Record<PlatformId, string> = {
  windows: "Windows",
  "windows-arm64": "Windows ARM64",
  "macos-arm": "macOS",
  "macos-intel": "macOS",
  linux: "Linux",
};

const step = (index: number): CSSProperties => ({ animationDelay: `${0.08 + index * 0.08}s` });

// Decorative and wide-screen only: both services are named again further down the page.
function ServiceBadge({ className, tilt, delay, children }: { className: string; tilt: string; delay: string; children: ReactNode }) {
  return (
    <span className={cn("scroll-fade pointer-events-none absolute z-10 hidden lg:block", className)} aria-hidden="true">
      <span
        className="float flex items-center gap-2.5 rounded-full bg-card/60 py-2 pl-3 pr-3.5 shadow-lg backdrop-blur-md"
        style={{ rotate: tilt, animationDelay: delay, animationDuration: "7.5s" }}
      >
        {children}
      </span>
    </span>
  );
}

function ReleaseChip({ release }: { release: LatestRelease | null }) {
  return (
    <a
      href={release ? `${GITHUB_REPO}/releases/tag/v${release.version}` : RELEASES_URL}
      rel="noopener"
      className={cn(
        "rise group inline-flex items-center gap-2.5 rounded-full bg-card/50 py-1.5 pl-1.5 pr-3.5 text-[13px] text-muted-foreground backdrop-blur transition-colors hover:bg-card hover:text-foreground",
        FOCUS_RING,
      )}
      style={step(0)}
    >
      <span className="rounded-full bg-primary/15 px-2 py-0.5 font-mono text-[11px] font-medium text-primary">
        {release ? `v${release.version}` : "new"}
      </span>
      {release ? timeAgo(release.publishedAt) : "Latest release"}
      <ArrowRightIcon size={14} className="transition-transform duration-200 group-hover:translate-x-0.5" />
    </a>
  );
}

export function Hero({
  release,
  platform,
  stars,
}: {
  release: LatestRelease | null;
  platform: PlatformId | null;
  stars: number | null;
}) {
  const heroRef = useRef<HTMLElement>(null);

  // Out of view, the floating mini player takes over, the way the app's appears when you look away.
  useEffect(() => {
    const hero = heroRef.current;
    if (!hero) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        document.documentElement.dataset.heroOut = String(!entry.isIntersecting);
      },
      { rootMargin: "-35% 0px 0px 0px" },
    );
    observer.observe(hero);
    return () => observer.disconnect();
  }, []);

  return (
    <section id="top" ref={heroRef} className="grain relative isolate overflow-x-clip">
      <div className="hero-aurora" aria-hidden="true" />
      <div className="relative mx-auto grid min-h-svh max-w-6xl grid-cols-1 items-center gap-x-10 gap-y-16 px-6 pb-20 pt-32 lg:grid-cols-[1.25fr_0.75fr] lg:pb-16 lg:pt-28">
        <ServiceBadge className="left-[36%] top-[31%]" tilt="-7deg" delay="-2.4s">
          <BrandIcon icon={SERVICE_ICON.discord} width={19} height={15} />
          <span className="font-mono text-[12px] text-muted-foreground">rich presence</span>
        </ServiceBadge>
        <ServiceBadge className="left-[40%] top-[51%]" tilt="6deg" delay="-5.1s">
          <BrandIcon icon={SERVICE_ICON.lastfm} width={48} height={12} />
          <span className="font-mono text-[12px] text-muted-foreground">scrobbling</span>
        </ServiceBadge>

        <div className="flex flex-col items-start">
          <ReleaseChip release={release} />

          <h1 className="rise mt-6 text-[clamp(4.5rem,10vw,8.5rem)] font-bold leading-[0.9] tracking-[-0.06em]" style={step(1)}>
            zuno<span className="caret text-primary" aria-hidden="true">_</span>
          </h1>

          <p className="rise mt-6 max-w-[36ch] text-balance text-xl leading-[1.5] tracking-[-0.01em] text-muted-foreground" style={step(2)}>
            A desktop client for the YouTube Music.
            <br className="max-sm:hidden" /> Downloads, Lyrics & No Ads.
          </p>

          <div className="rise mt-10 flex w-full flex-col gap-3 sm:w-auto sm:flex-row" style={step(3)}>
            <LinkButton href="#download" size="lg">
              Download{platform ? ` for ${PLATFORM_LABEL[platform]}` : ""}
              <ArrowDownIcon size={17} className="transition-transform duration-200 group-hover:translate-y-0.5" />
            </LinkButton>
            <LinkButton href={GITHUB_REPO} rel="noopener" variant="ghost" size="lg">
              <BrandIcon icon={SERVICE_ICON.github} width={18} height={18} />
              Star on GitHub
              {stars === null ? null : (
                <span className="rounded-full bg-background/60 px-2 py-0.5 font-mono text-[12px] tabular-nums text-muted-foreground">
                  {formatCount(stars)}
                </span>
              )}
            </LinkButton>
          </div>

          <ul className="rise mt-8 flex items-center gap-4 font-mono text-[12px] text-muted-foreground" style={step(4)} aria-label="Platforms">
            {(["windows", "macos", "linux"] as const).map((os) => (
              <li key={os} className="flex items-center gap-1.5">
                <BrandIcon icon={OS_ICON[os]} width={14} height={14} className="text-foreground" />
                {os === "macos" ? "macOS" : os === "windows" ? "Windows" : "Linux"}
              </li>
            ))}
          </ul>
        </div>

        <Deck />
      </div>
    </section>
  );
}
