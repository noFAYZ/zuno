import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  hydrateLocalJsonSetting,
  readLocalJsonSetting,
  writeLocalJsonSetting,
} from "../../internal/durableLocalSetting";
import { logInternalWarn } from "../../internal/logging";
import { usesRustAudioEngine } from "./audioEngine";

/**
 * Ten-band graphic equaliser.
 *
 * The gains live here; the filtering happens in Rust, between the decoder and the deck. That is
 * also why this only works on the Rust engine — the IFrame player never exposes its samples, and
 * a track that fell back to it plays unequalised however these sliders are set.
 *
 * Rust holds the current values in process-global state, so they survive track changes and apply
 * to both decks during a crossfade. They do *not* survive a restart, which is why `hydrate` ends
 * by pushing them back down.
 */
export const EQUALIZER_BANDS_HZ = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

/** Matches `MAX_GAIN_DB` in `equalizer.rs`, which clamps to the same range on the way in. */
export const EQUALIZER_MAX_DB = 12;

export type EqualizerSettings = {
  preampDb: number;
  bandsDb: number[];
};

export const EQUALIZER_FLAT: EqualizerSettings = {
  preampDb: 0,
  bandsDb: EQUALIZER_BANDS_HZ.map(() => 0),
};

/*
 * Presets carry a negative preamp wherever they boost.
 *
 * A normalised track has very little headroom left, so lifting four bands by 6 dB without
 * trimming the input hits the limiter and what comes out is compression rather than tone. Each
 * preset gives back roughly what its largest boost takes.
 */
export const EQUALIZER_PRESETS: ReadonlyArray<{ name: string; settings: EqualizerSettings }> = [
  { name: "Flat", settings: EQUALIZER_FLAT },
  {
    name: "Bass",
    settings: { preampDb: -4, bandsDb: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  },
  {
    name: "Vocal",
    settings: { preampDb: -3, bandsDb: [-2, -2, -1, 1, 3, 4, 3, 1, 0, 0] },
  },
  {
    name: "Treble",
    settings: { preampDb: -3, bandsDb: [0, 0, 0, 0, 0, 1, 2, 4, 5, 5] },
  },
];

const STORAGE_KEY = "equalizer-v1";
const CHANGE_EVENT = "equalizer-change";

function isEqualizerSettings(value: unknown): value is EqualizerSettings {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as EqualizerSettings;
  return typeof candidate.preampDb === "number"
    && Array.isArray(candidate.bandsDb)
    && candidate.bandsDb.length === EQUALIZER_BANDS_HZ.length
    && candidate.bandsDb.every((gain) => typeof gain === "number");
}

/*
 * Cached because the settings page reads this on every render of every slider, and the snapshot
 * handed to `useSyncExternalStore` has to be reference-stable or React re-renders forever.
 */
let cached: EqualizerSettings | null = null;

function readSettings(): EqualizerSettings {
  if (cached === null) {
    cached = readLocalJsonSetting(STORAGE_KEY, isEqualizerSettings) ?? EQUALIZER_FLAT;
  }
  return cached;
}

/** True when every band and the preamp are at zero, so nothing is being changed. */
export function isEqualizerFlat(settings: EqualizerSettings): boolean {
  return settings.preampDb === 0 && settings.bandsDb.every((gain) => gain === 0);
}

/** Whether the selected engine can apply it at all. */
export function isEqualizerAvailable(): boolean {
  return usesRustAudioEngine();
}

function push(settings: EqualizerSettings): void {
  void invoke("native_audio_set_equalizer", {
    preampDb: settings.preampDb,
    bandsDb: settings.bandsDb,
  }).catch((error: unknown) => {
    logInternalWarn("Equalizer push failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export function getEqualizer(): EqualizerSettings {
  return readSettings();
}

export function setEqualizer(settings: EqualizerSettings): void {
  const clamped: EqualizerSettings = {
    preampDb: clamp(settings.preampDb),
    bandsDb: settings.bandsDb.map(clamp),
  };
  cached = clamped;
  writeLocalJsonSetting(STORAGE_KEY, clamped);
  // Before the event, so a component that reads back on the change already sees it applied.
  push(clamped);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function clamp(gain: number): number {
  if (!Number.isFinite(gain)) return 0;
  return Math.min(EQUALIZER_MAX_DB, Math.max(-EQUALIZER_MAX_DB, gain));
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", () => {
    cached = null;
  });
}

export async function hydrateEqualizer(): Promise<void> {
  await hydrateLocalJsonSetting(STORAGE_KEY, isEqualizerSettings);
  cached = null;
  /*
   * Rust starts flat every launch — the values are process state, not a file — so the stored
   * settings have to be pushed down or the equaliser silently does nothing until the user
   * touches a slider.
   */
  push(readSettings());
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useEqualizer(): EqualizerSettings {
  return useSyncExternalStore(subscribe, readSettings, () => EQUALIZER_FLAT);
}
