import { useState, type KeyboardEvent } from "react";
import { BrandIcon, OS_ICON } from "./brandIcons";
import { ArrowUpRightIcon, DownloadIcon, ShieldIcon } from "./icons";
import { CopyBlock, FOCUS_RING, LinkButton, SectionHeading, cn } from "./ui";
import { RELEASES_URL, formatSize, timeAgo, type LatestRelease, type PlatformId } from "../releases";

interface Variant {
  label: string;
  platform: PlatformId;
  /** Narrows within a platform's assets: Linux ships three formats under one id. */
  match?: RegExp;
  note?: string;
}

interface OsTile {
  id: "windows" | "macos" | "linux";
  name: string;
  detects: readonly PlatformId[];
  requirement: string;
  variants: readonly Variant[];
}

const MAC_NOTE = "Unsigned: right-click → Open the first time.";

const TILES: readonly OsTile[] = [
  {
    id: "windows",
    name: "Windows",
    detects: ["windows"],
    requirement: "Windows 10 and 11 · x64 and ARM64",
    variants: [
      { label: "x64", platform: "windows", match: /-setup\.exe$/i },
      { label: "x64 MSI", platform: "windows", match: /\.msi$/i },
      { label: "ARM64", platform: "windows-arm64" },
    ],
  },
  {
    id: "macos",
    name: "macOS",
    detects: ["macos-arm", "macos-intel"],
    requirement: "macOS 12 and later",
    variants: [
      { label: "Apple Silicon", platform: "macos-arm", note: MAC_NOTE },
      { label: "Intel", platform: "macos-intel", note: MAC_NOTE },
    ],
  },
  {
    id: "linux",
    name: "Linux",
    detects: ["linux"],
    requirement: "x86_64 · glibc 2.31+",
    variants: [
      { label: "AppImage", platform: "linux", match: /\.AppImage$/i, note: "chmod +x, then run it." },
      { label: ".deb", platform: "linux", match: /\.deb$/i, note: "Debian, Ubuntu, Mint." },
      { label: ".rpm", platform: "linux", match: /\.rpm$/i, note: "Fedora, openSUSE." },
    ],
  },
];

function Tile({ tile, release, detected }: { tile: OsTile; release: LatestRelease | null; detected: PlatformId | null }) {
  const isYours = detected !== null && tile.detects.includes(detected);
  const [variantIndex, setVariantIndex] = useState(() => Math.max(0, tile.variants.findIndex((variant) => variant.platform === detected)));
  const variant = tile.variants[variantIndex];
  const build = release?.downloads[variant.platform];
  // Linux resolves one asset per id; if it is not the chosen format, the releases page beats a wrong file.
  const asset = build && (!variant.match || variant.match.test(build.name)) ? build : undefined;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = (variantIndex + delta + tile.variants.length) % tile.variants.length;
    setVariantIndex(next);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  };

  return (
    <article
      className={cn(
        "spotlight reveal relative flex flex-col gap-6 overflow-hidden rounded-3xl p-6 sm:p-7",
        isYours ? "bg-card/70" : "bg-card/35",
      )}
    >
      {isYours ? (
        <span
          className="pointer-events-none absolute -top-24 left-1/2 h-48 w-3/4 -translate-x-1/2 rounded-full bg-primary/25 blur-3xl"
          aria-hidden="true"
        />
      ) : null}

      <div className="flex items-start justify-between gap-3">
        <BrandIcon icon={OS_ICON[tile.id]} width={36} height={36} className="text-foreground" />
        {isYours ? (
          <span className="rounded-full bg-primary/15 px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-primary">your system</span>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <h3 className="text-2xl font-semibold tracking-[-0.03em]">{tile.name}</h3>
        <span className="font-mono text-[12px] text-muted-foreground">{tile.requirement}</span>
      </div>

      <div className="flex gap-1 rounded-full bg-background/70 p-1" role="radiogroup" aria-label={`${tile.name} format`} onKeyDown={onKeyDown}>
        {tile.variants.map((option, index) => (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={index === variantIndex}
            tabIndex={index === variantIndex ? 0 : -1}
            onClick={() => setVariantIndex(index)}
            className={cn(
              "flex-1 rounded-full px-2 py-2 font-mono text-[12px] transition-colors",
              FOCUS_RING,
              "focus-visible:ring-inset",
              index === variantIndex ? "bg-card text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="mt-auto flex flex-col gap-3">
        <LinkButton href={asset?.url ?? RELEASES_URL} rel="noopener" variant={isYours ? "solid" : "ghost"} className="w-full">
          <DownloadIcon size={18} />
          Download
        </LinkButton>
        <div className="flex min-h-10 flex-col gap-0.5">
          <span className="truncate font-mono text-[12px] text-muted-foreground">
            {asset ? `${asset.name} · ${formatSize(asset.size)}` : "see all releases"}
          </span>
          {variant.note ? <span className="text-[13px] text-muted-foreground/75">{variant.note}</span> : null}
        </div>
      </div>
    </article>
  );
}

export function Downloads({ release, platform }: { release: LatestRelease | null; platform: PlatformId | null }) {
  return (
    <section id="download">
      <div className="mx-auto max-w-6xl px-6 py-20 lg:py-28">
        <SectionHeading
          index="03"
          label="download"
          title="Get Zuno."
          lede="Updates install themselves."
        />

        <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[12px] text-muted-foreground">
          <span className="text-foreground">{release ? `v${release.version}` : "latest"}</span>
          {release ? <span>released {timeAgo(release.publishedAt)}</span> : null}
          <span className="flex items-center gap-1.5 text-primary">
            <ShieldIcon size={14} />
            signed updates
          </span>
        </div>

        <div className="mt-12 grid grid-cols-1 gap-4 md:grid-cols-3">
          {TILES.map((tile) => (
            <Tile key={tile.id} tile={tile} release={release} detected={platform} />
          ))}
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-[1fr_auto]">
          <div className="flex flex-col gap-3 rounded-3xl bg-card/35 p-5 sm:flex-row sm:items-center sm:gap-5">
            <span className="shrink-0 pl-1 text-[15px] font-medium">On Arch?</span>
            <div className="min-w-0 flex-1">
              <CopyBlock label="the AUR install command" lines={["yay -S zuno"]} />
            </div>
          </div>
          <a
            href={RELEASES_URL}
            rel="noopener"
            className={cn(
              "flex items-center justify-between gap-6 rounded-3xl bg-card/35 px-6 py-5 text-[15px] font-medium transition-colors hover:bg-card/60",
              FOCUS_RING,
            )}
          >
            All releases & changelogs
            <ArrowUpRightIcon size={18} className="text-muted-foreground" />
          </a>
        </div>
      </div>
    </section>
  );
}
