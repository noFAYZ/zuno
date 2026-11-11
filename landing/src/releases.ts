export const GITHUB_REPO = "https://github.com/noFAYZ/zuno";
export const RELEASES_URL = `${GITHUB_REPO}/releases/latest`;
const LATEST_RELEASE_API = "https://api.github.com/repos/noFAYZ/zuno/releases/latest";

export type PlatformId = "windows" | "windows-arm64" | "macos-arm" | "macos-intel" | "linux";

export interface PlatformBuild {
  id: PlatformId;
  label: string;
  /** Shown under the label — "Apple Silicon", ".deb · AppImage". */
  hint: string;
  /** Matched against asset filenames, first match wins. */
  patterns: RegExp[];
}

/**
 * One entry per download button.
 *
 * Order matters: the first pattern that matches an asset name is the one linked, so the
 * preferred installer for each platform is listed first — NSIS ahead of MSI on Windows because
 * it is the one the updater ships, `.deb` ahead of AppImage on Linux because it integrates.
 */
export const PLATFORM_BUILDS: readonly PlatformBuild[] = [
  {
    id: "windows",
    label: "Windows",
    hint: "Installer · 10 and 11",
    patterns: [/_x64-setup\.exe$/i, /_x64[^/]*\.msi$/i],
  },
  {
    id: "windows-arm64",
    label: "Windows ARM64",
    hint: "Installer · 10 and 11",
    patterns: [/_arm64-setup\.exe$/i, /_arm64[^/]*\.msi$/i],
  },
  {
    id: "macos-arm",
    label: "macOS",
    hint: "Apple Silicon",
    patterns: [/aarch64\.dmg$/i, /arm64\.dmg$/i],
  },
  {
    id: "macos-intel",
    label: "macOS",
    hint: "Intel",
    patterns: [/x64\.dmg$/i, /x86_64\.dmg$/i],
  },
  {
    id: "linux",
    label: "Linux",
    hint: "AppImage · .deb · .rpm",
    patterns: [/\.AppImage$/i, /\.deb$/i, /\.rpm$/i],
  },
];

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface LatestRelease {
  version: string;
  publishedAt: string | null;
  /** Direct download URL per platform. Absent when the release has no matching asset. */
  downloads: Partial<Record<PlatformId, { url: string; name: string; size: number }>>;
}

function pickAsset(assets: ReleaseAsset[], patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = assets.find((asset) => pattern.test(asset.name));
    if (match) {
      return { url: match.browser_download_url, name: match.name, size: match.size };
    }
  }
  return undefined;
}

/**
 * Reads the newest release straight from GitHub.
 *
 * Asset names carry the version (`Zuno_1.1.1_x64-setup.exe`), so there is no stable per-file
 * URL to hardcode — the alternative to this request is sending everyone to the releases page
 * to work out which file they need. Every button falls back to exactly that page if this
 * fails, so a rate limit or an offline visitor still gets a working download.
 */
export async function fetchLatestRelease(signal?: AbortSignal): Promise<LatestRelease> {
  const response = await fetch(LATEST_RELEASE_API, {
    headers: { Accept: "application/vnd.github+json" },
    signal,
  });
  if (!response.ok) {
    throw new Error(`GitHub returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    tag_name?: string;
    name?: string;
    published_at?: string;
    assets?: ReleaseAsset[];
  };

  const assets = payload.assets ?? [];
  const downloads: LatestRelease["downloads"] = {};
  for (const build of PLATFORM_BUILDS) {
    const asset = pickAsset(assets, build.patterns);
    if (asset) downloads[build.id] = asset;
  }

  return {
    version: (payload.tag_name ?? payload.name ?? "").replace(/^v/, ""),
    publishedAt: payload.published_at ?? null,
    downloads,
  };
}

/**
 * Best guess at the visitor's platform, used only to emphasise one button.
 *
 * Never used to hide the others: detection is unreliable, and someone downloading for a
 * different machine is a completely ordinary thing to do.
 */
export function detectPlatform(): PlatformId | null {
  if (typeof navigator === "undefined") return null;

  const platform = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`.toLowerCase();
  if (platform.includes("win")) return "windows";
  if (platform.includes("linux") && !platform.includes("android")) return "linux";
  if (platform.includes("mac")) {
    /*
     * Apple Silicon is not in the user agent — Safari reports Intel on every Mac. This probes
     * for a WebGL renderer string that only the Apple GPU exposes, and falls back to Apple
     * Silicon because it is the overwhelmingly more common Mac to be reading this on now.
     */
    try {
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl");
      const info = gl?.getExtension("WEBGL_debug_renderer_info");
      const renderer = info
        ? String(gl?.getParameter(info.UNMASKED_RENDERER_WEBGL) ?? "")
        : "";
      if (renderer.toLowerCase().includes("intel")) return "macos-intel";
    } catch {
      // Blocked WebGL is not worth failing detection over.
    }
    return "macos-arm";
  }
  return null;
}

export function formatSize(bytes: number): string {
  const megabytes = bytes / 1024 / 1024;
  return `${megabytes.toFixed(1)} MB`;
}

/** "3 days ago", "last week" — or "recently" when GitHub gave no date. */
export function timeAgo(iso: string | null, now = Date.now()): string {
  const then = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(then)) return "recently";
  const days = Math.round((then - now) / 86_400_000);
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(days) < 7) return format.format(days, "day");
  if (Math.abs(days) < 60) return format.format(Math.round(days / 7), "week");
  return format.format(Math.round(days / 30), "month");
}
