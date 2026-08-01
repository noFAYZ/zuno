/**
 * Remembers which artwork URL actually loaded, per source URL.
 *
 * Artwork is served from several candidate URLs (the original, plus resized YouTube variants)
 * and falls back to fetching the bytes through Rust when the webview cannot load the image
 * directly. Without this cache every mount restarts that walk from the top: a playlist scrolled
 * twice re-requests every failing candidate again, and proxied blobs were revoked on unmount,
 * so they were re-downloaded in full.
 *
 * Four things this holds, each for a different failure it prevents:
 *
 * - **Resolved URLs** — what finally worked, so a remount paints on the first frame. Bounded,
 *   with insertion order giving LRU for free: reading re-inserts, so eviction takes the coldest
 *   entry, and only then is an object URL revoked.
 * - **In-flight promises** — twenty rows sharing one album cover used to issue twenty identical
 *   proxy fetches, because nothing recorded that the first was already running.
 * - **Failures** — a source whose every candidate 404s would otherwise re-walk the entire
 *   ladder on every single mount, forever.
 * - **A persisted copy** of the plain (non-blob) resolutions, so a restart does not re-derive
 *   what was already learned. Object URLs are deliberately excluded: they die with the page.
 */

const MAX_ENTRIES = 500;
/**
 * Ceiling on blob bytes held at once.
 *
 * The entry count alone does not bound memory: entries are a mix of plain URLs, which cost
 * nothing, and blobs, which cost whatever the image weighs. Five hundred thumbnails and five
 * hundred full-size covers are the same number and two orders of magnitude apart in bytes.
 */
const MAX_BLOB_BYTES = 16 * 1024 * 1024;
const MAX_PERSISTED_ENTRIES = 300;
const STORAGE_KEY = "zuno:artwork-resolved-v1";

const resolved = new Map<string, string>();
/** Values that own a blob and must be revoked when evicted, and what each one weighs. */
const ownedBlobBytes = new Map<string, number>();
let totalBlobBytes = 0;
/** Sources where every candidate and the proxy all failed. */
const failed = new Set<string>();
/** Proxy fetches already running, keyed by source URL, so callers share one request. */
const inFlight = new Map<string, Promise<string | null>>();

let persistTimer: number | null = null;

export function getResolvedArtworkUrl(sourceUrl: string): string | undefined {
  const hit = resolved.get(sourceUrl);
  if (hit === undefined) return undefined;

  // Re-insert so this entry becomes the most recently used.
  resolved.delete(sourceUrl);
  resolved.set(sourceUrl, hit);
  return hit;
}

export function rememberResolvedArtworkUrl(
  sourceUrl: string,
  workingUrl: string,
  options: { ownsObjectUrl?: boolean; byteLength?: number } = {},
): void {
  const previous = resolved.get(sourceUrl);
  if (previous === workingUrl) return;
  if (previous !== undefined) releaseValue(previous);

  resolved.delete(sourceUrl);
  resolved.set(sourceUrl, workingUrl);
  if (options.ownsObjectUrl) {
    ownedBlobBytes.set(workingUrl, options.byteLength ?? 0);
    totalBlobBytes += options.byteLength ?? 0;
  }
  // Anything that resolves is, by definition, no longer a failure.
  failed.delete(sourceUrl);

  // Oldest first, so eviction takes the coldest entry under either limit.
  for (const oldestKey of [...resolved.keys()]) {
    if (resolved.size <= MAX_ENTRIES && totalBlobBytes <= MAX_BLOB_BYTES) break;
    // Never evict the entry just inserted; under a tight budget it is the one still needed.
    if (oldestKey === sourceUrl) continue;
    const oldestValue = resolved.get(oldestKey);
    resolved.delete(oldestKey);
    if (oldestValue !== undefined) releaseValue(oldestValue);
  }

  schedulePersist();
}

/**
 * Drops a resolution that has stopped working.
 *
 * Without this a URL that resolved once and later went dead stays cached forever — and now
 * that resolutions persist, it would survive restarts too, pinning that cover to the proxy
 * path permanently. Forgetting it lets the candidate ladder be walked again from scratch.
 */
export function forgetResolvedArtworkUrl(sourceUrl: string): void {
  const previous = resolved.get(sourceUrl);
  if (previous === undefined) return;
  resolved.delete(sourceUrl);
  releaseValue(previous);
  schedulePersist();
}

/** True once every candidate and the proxy have failed for this source. */
export function hasArtworkFailed(sourceUrl: string): boolean {
  return failed.has(sourceUrl);
}

export function rememberArtworkFailure(sourceUrl: string): void {
  // Bounded the same way, and by the same reasoning, as the resolved map.
  if (failed.size >= MAX_ENTRIES) {
    const oldest = failed.values().next().value;
    if (oldest !== undefined) failed.delete(oldest);
  }
  failed.add(sourceUrl);
}

/**
 * Fetches artwork bytes through the proxy, at most once per cache key.
 *
 * The promise is shared, so a screen full of rows showing the same cover issues one request
 * rather than one each. The result is cached before any caller sees it, so whoever loses the
 * race still reads a hit rather than starting a second fetch.
 *
 * `fetchBlob` takes no URL: keys carry the requested size (see TrackArtwork), so only the
 * caller knows which of a source's size variants it actually wants fetched.
 */
export function resolveArtworkThroughProxy(
  sourceUrl: string,
  fetchBlob: () => Promise<Blob>,
): Promise<string | null> {
  const cached = getResolvedArtworkUrl(sourceUrl);
  if (cached) return Promise.resolve(cached);

  const existing = inFlight.get(sourceUrl);
  if (existing) return existing;

  const request = fetchBlob()
    .then((blob) => {
      const objectUrl = URL.createObjectURL(blob);
      // Handed to the cache, which owns revoking it from here on. The size goes with it: it is
      // the only moment the byte count is known, and the budget cannot be enforced without it.
      rememberResolvedArtworkUrl(sourceUrl, objectUrl, {
        ownsObjectUrl: true,
        byteLength: blob.size,
      });
      return objectUrl;
    })
    .catch(() => {
      rememberArtworkFailure(sourceUrl);
      return null;
    })
    .finally(() => {
      inFlight.delete(sourceUrl);
    });

  inFlight.set(sourceUrl, request);
  return request;
}

function releaseValue(value: string): void {
  const bytes = ownedBlobBytes.get(value);
  if (bytes === undefined) return;
  ownedBlobBytes.delete(value);
  totalBlobBytes -= bytes;
  URL.revokeObjectURL(value);
}

/**
 * Restores the plain resolutions learned in previous sessions.
 *
 * Cheap and worth it: without it, every restart re-walks the candidate ladder for every cover
 * the user has ever seen. Failures are not persisted — a 404 today may be a valid image
 * tomorrow, and a stored "this is broken" would be self-fulfilling.
 */
export function hydrateArtworkCache(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries)) return;

    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [source, working] = entry;
      if (typeof source !== "string" || typeof working !== "string") continue;
      // A blob URL from a previous session points at nothing; skip rather than paint a broken image.
      if (working.startsWith("blob:")) continue;
      resolved.set(source, working);
    }
  } catch {
    // A corrupt or unavailable store is not worth failing a render over.
  }
}

function schedulePersist(): void {
  if (persistTimer !== null) return;
  // Batched: resolutions arrive one per image, and a playlist scroll would otherwise write
  // the whole map to localStorage dozens of times in a second.
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    persistNow();
  }, 2000);
}

function persistNow(): void {
  try {
    const persistable: Array<[string, string]> = [];
    // Walked newest-first so the cap keeps the warmest entries.
    for (const [source, working] of [...resolved.entries()].reverse()) {
      if (working.startsWith("blob:")) continue;
      persistable.push([source, working]);
      if (persistable.length >= MAX_PERSISTED_ENTRIES) break;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persistable.reverse()));
  } catch {
    // Quota or privacy mode; the in-memory cache still works for this session.
  }
}

/** Used when clearing app data, so stale blobs do not outlive a cache reset. */
export function clearArtworkCache(): void {
  for (const value of [...resolved.values()]) releaseValue(value);
  resolved.clear();
  failed.clear();
  inFlight.clear();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing actionable; the in-memory cache is already cleared.
  }
}

/** Exposed for the self-check only. */
export const __artworkCacheForTest = {
  reset(): void {
    resolved.clear();
    ownedBlobBytes.clear();
    totalBlobBytes = 0;
    failed.clear();
    inFlight.clear();
  },
  resolvedSize: () => resolved.size,
  inFlightSize: () => inFlight.size,
  blobBytes: () => totalBlobBytes,
  maxBlobBytes: MAX_BLOB_BYTES,
};
