interface ArtworkCandidate {
  url?: string;
  width?: number;
  height?: number;
}

function normalizeArtworkUrl(url: string): string {
  const trimmedUrl = url.trim();
  return trimmedUrl.startsWith("//") ? `https:${trimmedUrl}` : trimmedUrl;
}

function isArtworkCandidate(value: unknown): value is ArtworkCandidate {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as ArtworkCandidate).url === "string",
  );
}

export function collectArtworkCandidates(...sources: unknown[]): ArtworkCandidate[] {
  const candidates: ArtworkCandidate[] = [];
  const seen = new WeakSet<object>();

  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    if (isArtworkCandidate(value)) {
      candidates.push(value);
    }

    for (const child of Object.values(value)) {
      if (Array.isArray(child) || (child && typeof child === "object")) {
        visit(child);
      }
    }
  };

  for (const source of sources) {
    visit(source);
  }

  return candidates;
}

export function selectArtworkUrl(
  ...candidateGroups: Array<readonly ArtworkCandidate[] | null | undefined>
): string | undefined {
  const candidates = candidateGroups
    .flatMap((group) => group ?? [])
    .filter((candidate): candidate is ArtworkCandidate & { url: string } => Boolean(candidate.url?.trim()));

  const bestCandidate = candidates.reduce<(ArtworkCandidate & { url: string }) | undefined>(
    (best, candidate) => {
      if (!best) return candidate;

      const bestArea = (best.width ?? 0) * (best.height ?? 0);
      const candidateArea = (candidate.width ?? 0) * (candidate.height ?? 0);
      return candidateArea > bestArea ? candidate : best;
    },
    undefined,
  );

  return bestCandidate ? normalizeArtworkUrl(bestCandidate.url) : undefined;
}

function withYoutubeSize(url: string, size: number): string | null {
  if (!/googleusercontent\.com|ggpht\.com|yt3\.ggpht\.com/.test(url)) return null;
  if (/[?&]/.test(url)) return null;
  if (/=/.test(url)) {
    return url.replace(/=[^=/]+$/, `=w${size}-h${size}-l90-rj`);
  }
  return `${url}=w${size}-h${size}-l90-rj`;
}

/**
 * Widths artwork is requested at.
 *
 * Buckets rather than exact sizes because the resolution cache is keyed by size: a distinct
 * width per component would mean a distinct cache entry, and a distinct download, for the same
 * cover shown in two places. A short ladder keeps that sharing while still keeping a 40px row
 * from decoding a 544px texture.
 *
 * 400 exists because of what a decoded bitmap costs. Cards render at 176–200 CSS px, and on the
 * 2× displays most people have that is a 352–400px requirement — which, on a ladder that jumped
 * straight from 240 to 544, rounded up to 544 every time. A decoded image is ~4 bytes per pixel
 * no matter how small the JPEG was, so those cards were each holding 1.18 MB where 0.64 MB
 * covers the slot exactly: a grid of fifty albums was ~59 MB of bitmap instead of ~32 MB.
 *
 * One extra bucket is the whole cost. It was chosen to catch both card widths at 2× rather than
 * splitting them across two new entries, which is what would actually fragment the cache.
 */
const ARTWORK_SIZE_BUCKETS = [120, 240, 400, 544];

/**
 * The smallest bucket that still covers `cssPx` at this display's pixel density.
 *
 * Null means the slot is larger than any bucket — those keep the original, full-size URL,
 * since downscaling a hero image is the one place the extra bytes are visible.
 */
export function getArtworkSizeBucket(cssPx: number): number | null {
  const needed = cssPx * (globalThis.devicePixelRatio || 1);
  return ARTWORK_SIZE_BUCKETS.find((bucket) => bucket >= needed) ?? null;
}

/**
 * `size` is the requested width; omitting it keeps the original URL first, which is what
 * callers rendering at an unknown or full-bleed size want. Everything after the first entry is
 * a fallback for the first one 404ing, so the original stays in the ladder either way.
 */
export function getArtworkUrlCandidates(url?: string, size?: number | null): string[] {
  if (!url?.trim()) return [];

  const normalized = normalizeArtworkUrl(url);
  const candidates = [
    size == null ? null : withYoutubeSize(normalized, size),
    normalized,
    withYoutubeSize(normalized, 544),
    withYoutubeSize(normalized, 240),
    withYoutubeSize(normalized, 120),
  ].filter((candidate): candidate is string => Boolean(candidate));

  // Deduplicate while preserving order.
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

/**
 * One key per image whatever size variant a URL asks for, so a download's saved cover matches
 * the same song wherever it shows — a queue row's `=w120` and a header's `=w544` alike.
 */
export function artworkIdentity(url: string): string {
  const normalized = normalizeArtworkUrl(url);
  const videoThumbnail = normalized.match(/^https:\/\/i\d?\.ytimg\.com\/vi(?:_webp)?\/([^/]+)\//);
  if (videoThumbnail) return `ytimg:${videoThumbnail[1]}`;
  if (/googleusercontent\.com|ggpht\.com/.test(normalized) && !/[?&]/.test(normalized)) {
    return normalized.replace(/=[^=/]+$/, "");
  }
  return normalized;
}

/** The largest variant worth asking for, for the full-size cover view (#174). */
export function getFullSizeArtworkUrl(url: string): string {
  return withYoutubeSize(normalizeArtworkUrl(url), 1200) ?? url;
}

export function getVideoArtworkFallback(videoId: string): string | undefined {
  return /^[A-Za-z0-9_-]{11}$/.test(videoId)
    ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
    : undefined;
}
