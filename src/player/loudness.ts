/**
 * Each track's loudness as YouTube measured it, in dB against its reference (#181).
 *
 * Recorded when a stream is resolved, which downloads do too, so a downloaded track keeps its
 * measurement offline. ponytail: capped by dropping the oldest entries; no LRU.
 */
const STORAGE_KEY = "track-loudness";
const MAX_ENTRIES = 5_000;

let cache: Record<string, number> | null = null;

function read(): Record<string, number> {
  if (cache) return cache;
  try {
    cache = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, number>;
  } catch {
    cache = {};
  }
  return cache;
}

export function getLoudness(trackId: string): number | undefined {
  const value = read()[trackId];
  return typeof value === "number" ? value : undefined;
}

export function rememberLoudness(trackId: string, loudnessDb: unknown): void {
  if (typeof loudnessDb !== "number" || !Number.isFinite(loudnessDb)) return;
  const entries = read();
  if (entries[trackId] === loudnessDb) return;
  delete entries[trackId];
  entries[trackId] = loudnessDb;
  const ids = Object.keys(entries);
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_ENTRIES))) delete entries[id];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // Quota: the measurement still applies for this session.
  }
}
