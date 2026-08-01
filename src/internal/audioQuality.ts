import { useSyncExternalStore } from "react";
import {
  hydrateLocalJsonSetting,
  readLocalJsonSetting,
  writeLocalJsonSetting,
} from "./durableLocalSetting";

/**
 * Streaming and downloading are set separately on purpose: the usual reason to cap one is not
 * the reason to cap the other. Streaming is capped to save bandwidth on a metered or slow
 * connection; downloading is capped to save disk. Someone on mobile data who wants good
 * offline copies is a normal case, and a single setting cannot express it.
 */
export type AudioQuality = "low" | "normal" | "high";

const STREAMING_KEY = "audio-quality-streaming";
const DOWNLOAD_KEY = "audio-quality-download";
const CHANGE_EVENT = "audio-quality-change";

/**
 * Target bitrates in kbps. "high" has no target — it takes the best on offer, whatever that
 * is, rather than a number that could sit below a format YouTube starts serving later.
 */
const QUALITY_TARGET_KBPS: Record<Exclude<AudioQuality, "high">, number> = {
  low: 64,
  normal: 128,
};

export const AUDIO_QUALITY_LABELS: Record<AudioQuality, string> = {
  low: "Low (~64 kbps)",
  normal: "Normal (~128 kbps)",
  high: "High (best available)",
};

function isAudioQuality(value: unknown): value is AudioQuality {
  return value === "low" || value === "normal" || value === "high";
}

function read(key: string): AudioQuality {
  return readLocalJsonSetting<AudioQuality>(key, isAudioQuality) ?? "high";
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function getStreamingQuality(): AudioQuality {
  return read(STREAMING_KEY);
}

export function getDownloadQuality(): AudioQuality {
  return read(DOWNLOAD_KEY);
}

export function setStreamingQuality(quality: AudioQuality): void {
  writeLocalJsonSetting(STREAMING_KEY, quality);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function setDownloadQuality(quality: AudioQuality): void {
  writeLocalJsonSetting(DOWNLOAD_KEY, quality);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export async function hydrateAudioQualitySettings(): Promise<void> {
  await Promise.all([
    hydrateLocalJsonSetting<AudioQuality>(STREAMING_KEY, isAudioQuality),
    hydrateLocalJsonSetting<AudioQuality>(DOWNLOAD_KEY, isAudioQuality),
  ]);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useStreamingQuality(): AudioQuality {
  return useSyncExternalStore(subscribe, getStreamingQuality, () => "high");
}

export function useDownloadQuality(): AudioQuality {
  return useSyncExternalStore(subscribe, getDownloadQuality, () => "high");
}

/**
 * Picks the format that best matches a quality preference.
 *
 * Nearest match, not "highest at or below the target". A strict cap looks tidier but behaves
 * badly against real data: YouTube's normal AAC tier is around 131 kbps, so a 128 kbps cap
 * rejects it for being 3 kbps over and drops all the way to the 49 kbps tier — a large,
 * audible downgrade from a rounding difference. Nearest also removes the need for a separate
 * fallback when nothing sits below the target, since the cheapest option is then the closest.
 */
export function selectFormatForQuality<T extends { bitrate?: number | null }>(
  formats: T[],
  quality: AudioQuality,
): T | undefined {
  if (formats.length === 0) return undefined;

  const ranked = [...formats].sort((left, right) => (right.bitrate ?? 0) - (left.bitrate ?? 0));
  if (quality === "high") return ranked[0];

  const targetBps = QUALITY_TARGET_KBPS[quality] * 1000;
  return ranked.reduce((best, format) => {
    const distance = Math.abs((format.bitrate ?? 0) - targetBps);
    const bestDistance = Math.abs((best.bitrate ?? 0) - targetBps);
    // Ties keep the earlier (higher-bitrate) entry, since ranked is sorted descending.
    return distance < bestDistance ? format : best;
  }, ranked[0]);
}
