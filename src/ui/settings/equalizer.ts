import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isAndroid } from "../platform";
import {
  hydrateLocalBooleanSetting,
  hydrateLocalJsonSetting,
  readLocalBooleanSetting,
  readLocalJsonSetting,
  writeLocalBooleanSetting,
  writeLocalJsonSetting,
} from "../../internal/durableLocalSetting";
import { logInternalWarn } from "../../internal/logging";
import {
  EQUALIZER_BANDS_HZ,
  EQUALIZER_FLAT,
  EQUALIZER_PRESETS,
  sameEqualizerCurve,
  snapGain,
  type EqualizerPreset,
  type EqualizerSettings,
} from "./equalizerCurve";

/**
 * Ten-band graphic equaliser: the live curve, the bypass switch, and the user's own presets.
 *
 * The gains live here; the filtering happens in Rust, between the decoder and the deck. That is
 * also why this only works on the Rust engine — the IFrame player never exposes its samples, and
 * a track that fell back to it plays unequalised however these are set.
 *
 * Rust holds the current values in process-global state, so they survive track changes and apply
 * to both decks during a crossfade. They do *not* survive a restart, which is why `hydrate` ends
 * by pushing them back down.
 */
const STORAGE_KEY = "equalizer-v1";
const CHANGE_EVENT = "equalizer-change";

/*
 * On/off, kept separate from the curve itself.
 *
 * The curve is what the sliders shape; the switch is whether it is currently being listened to.
 * Folding it into `EqualizerSettings` would mean flattening the bands to turn it off and
 * remembering them somewhere to turn it back on — this way the sliders keep the user's shape the
 * whole time, on or off, exactly like a hardware EQ's bypass switch.
 */
const ENABLED_STORAGE_KEY = "equalizer-enabled-v1";
const ENABLED_CHANGE_EVENT = "equalizer-enabled-change";

/** Curves the user named. Built-ins live in `EQUALIZER_PRESETS` and are never stored. */
const PRESETS_STORAGE_KEY = "equalizer-presets-v1";

// The Custom slot: the last curve that matched no preset, so clicking a preset never loses a tweak (#141).
const CUSTOM_STORAGE_KEY = "equalizer-custom-v1";

/** The Custom slot's chip label, reserved so no saved preset can be mistaken for it. */
export const EQUALIZER_CUSTOM_NAME = "Custom";
export const EQUALIZER_PRESET_NAME_MAX = 24;

function isEqualizerSettings(value: unknown): value is EqualizerSettings {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as EqualizerSettings;
  return typeof candidate.preampDb === "number"
    && Array.isArray(candidate.bandsDb)
    && candidate.bandsDb.length === EQUALIZER_BANDS_HZ.length
    && candidate.bandsDb.every((gain) => typeof gain === "number");
}

function isPreset(value: unknown): value is EqualizerPreset {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as EqualizerPreset;
  return typeof candidate.name === "string"
    && candidate.name.trim() !== ""
    && isEqualizerSettings(candidate.settings);
}

// Cached: `useSyncExternalStore` snapshots must be reference-stable or React re-renders forever.
let cached: EqualizerSettings | null = null;
let enabledCached: boolean | null = null;
let presetsCached: EqualizerPreset[] | null = null;
/** `undefined` until read; `null` when nothing custom has been tuned yet. */
let customCached: EqualizerSettings | null | undefined;
/** The preset the live curve last matched — what Save offers to overwrite after a tweak. */
let basePresetName: string | null = null;

const NO_PRESETS: EqualizerPreset[] = [];

function readSettings(): EqualizerSettings {
  if (cached === null) {
    cached = readLocalJsonSetting(STORAGE_KEY, isEqualizerSettings) ?? EQUALIZER_FLAT;
  }
  return cached;
}

function readUserPresets(): EqualizerPreset[] {
  if (presetsCached === null) {
    // Filtered one by one: a malformed entry should cost that preset, not every preset.
    presetsCached = (readLocalJsonSetting(PRESETS_STORAGE_KEY, Array.isArray) ?? []).filter(isPreset);
  }
  return presetsCached;
}

function readCustom(): EqualizerSettings | null {
  if (customCached === undefined) {
    customCached = readLocalJsonSetting(CUSTOM_STORAGE_KEY, isEqualizerSettings);
  }
  return customCached;
}

/** The preset that is exactly this curve, preamp included. Built-ins win ties. */
export function activeEqualizerPreset(
  settings: EqualizerSettings,
  userPresets: readonly EqualizerPreset[],
): EqualizerPreset | undefined {
  return [...EQUALIZER_PRESETS, ...userPresets].find((preset) =>
    sameEqualizerCurve(preset.settings, settings),
  );
}

/** True when every band and the preamp are at zero, so nothing is being changed. */
export function isEqualizerFlat(settings: EqualizerSettings): boolean {
  return settings.preampDb === 0 && settings.bandsDb.every((gain) => gain === 0);
}

/** The bypass switch — independent of the curve. See `ENABLED_STORAGE_KEY`. */
export function isEqualizerEnabled(): boolean {
  if (enabledCached === null) {
    enabledCached = readLocalBooleanSetting(ENABLED_STORAGE_KEY, true);
  }
  return enabledCached;
}

export function setEqualizerEnabled(enabled: boolean): void {
  enabledCached = enabled;
  writeLocalBooleanSetting(ENABLED_STORAGE_KEY, enabled, ENABLED_CHANGE_EVENT);
  // Re-push under the new switch state — flat if this just turned it off, the stored curve if
  // it just turned back on.
  push(readSettings());
}

/// Rust has no notion of "off": it only ever sees a curve, flat or not. The switch lives here,
/// entirely on the frontend, by choosing what to push rather than sending the switch itself.
function push(settings: EqualizerSettings): void {
  // The EQ lives in the Rust decoder, which does not exist on Android.
  if (isAndroid) return;
  const applied = isEqualizerEnabled() ? settings : EQUALIZER_FLAT;
  void invoke("native_audio_set_equalizer", {
    preampDb: applied.preampDb,
    bandsDb: applied.bandsDb,
  }).catch((error: unknown) => {
    logInternalWarn("Equalizer push failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

// Persisted once a drag settles: each `app_setting_set` rewrites the settings file on the
// same Tauri thread that applies the EQ, so per-move writes would lag the audio.
const PERSIST_DELAY_MS = 400;
let persistTimer: number | undefined;

function persistSoon(): void {
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(persistNow, PERSIST_DELAY_MS);
}

function persistNow(): void {
  window.clearTimeout(persistTimer);
  persistTimer = undefined;
  writeLocalJsonSetting(STORAGE_KEY, readSettings());
  const custom = readCustom();
  if (custom) writeLocalJsonSetting(CUSTOM_STORAGE_KEY, custom);
}

/** For event handlers: a drag reads the live curve, not the one its last render closed over. */
export function getEqualizer(): EqualizerSettings {
  return readSettings();
}

export function setEqualizer(settings: EqualizerSettings): void {
  const next: EqualizerSettings = {
    preampDb: snapGain(settings.preampDb),
    bandsDb: settings.bandsDb.map(snapGain),
  };
  // A drag reports every pointer move, and most of them land on the step it was already on.
  if (sameEqualizerCurve(next, readSettings())) return;

  cached = next;
  const preset = activeEqualizerPreset(next, readUserPresets());
  if (preset) basePresetName = preset.name;
  else customCached = next;

  // Before the event, so a component that reads back on the change already hears it applied.
  push(next);
  persistSoon();
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function writeUserPresets(presets: EqualizerPreset[]): void {
  presetsCached = presets;
  writeLocalJsonSetting(PRESETS_STORAGE_KEY, presets);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function findUserPreset(name: string): EqualizerPreset | undefined {
  const key = name.trim().toLowerCase();
  return readUserPresets().find((preset) => preset.name.toLowerCase() === key);
}

/** Whether saving under `name` would overwrite one of the user's presets instead of adding one. */
export function isExistingEqualizerPreset(name: string): boolean {
  return findUserPreset(name) !== undefined;
}

/** Why `name` can't be used, or null. Saving over a user preset is allowed: that's how one is updated. */
export function equalizerPresetNameError(name: string, renaming?: string): string | null {
  const key = name.trim().toLowerCase();
  if (key === "") return "Give it a name";
  if (
    key === EQUALIZER_CUSTOM_NAME.toLowerCase()
    || EQUALIZER_PRESETS.some((preset) => preset.name.toLowerCase() === key)
  ) {
    return "That name belongs to a built-in";
  }
  if (renaming !== undefined && key !== renaming.toLowerCase() && findUserPreset(key)) {
    return "Another preset already has that name";
  }
  return null;
}

/** The user preset the curve was tweaked from (so updating it is one Enter), else "My preset N". */
export function suggestEqualizerPresetName(): string {
  if (basePresetName !== null && findUserPreset(basePresetName)) return basePresetName;
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? "My preset" : `My preset ${n}`;
    if (!findUserPreset(name)) return name;
  }
}

/** Names the live curve, replacing a user preset that already has that name. */
export function saveEqualizerPreset(name: string): void {
  const saved: EqualizerPreset = { name: name.trim(), settings: readSettings() };
  const existing = findUserPreset(saved.name);
  basePresetName = saved.name;
  writeUserPresets(
    existing
      ? readUserPresets().map((preset) => (preset === existing ? saved : preset))
      : [...readUserPresets(), saved],
  );
}

export function renameEqualizerPreset(from: string, to: string): void {
  const name = to.trim();
  if (basePresetName === from) basePresetName = name;
  writeUserPresets(
    readUserPresets().map((preset) => (preset.name === from ? { ...preset, name } : preset)),
  );
}

export function deleteEqualizerPreset(name: string): void {
  const remaining = readUserPresets().filter((preset) => preset.name !== name);
  // A deleted curve that is still playing stays recallable as Custom, so one-click delete is safe.
  const current = readSettings();
  if (!activeEqualizerPreset(current, remaining)) {
    customCached = current;
    persistSoon();
  }
  writeUserPresets(remaining);
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

function subscribeEnabled(callback: () => void) {
  window.addEventListener(ENABLED_CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(ENABLED_CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    // Own keys only: any key would drop a curve still waiting on its debounced write.
    if (event.key !== null && !event.key.startsWith("equalizer-")) return;
    cached = null;
    enabledCached = null;
    presetsCached = null;
    customCached = undefined;
  });
  // A close inside the debounce window would otherwise lose the last adjustment.
  window.addEventListener("pagehide", () => {
    if (persistTimer !== undefined) persistNow();
  });
}

export async function hydrateEqualizer(): Promise<void> {
  await Promise.all([
    hydrateLocalJsonSetting(STORAGE_KEY, isEqualizerSettings),
    hydrateLocalJsonSetting(CUSTOM_STORAGE_KEY, isEqualizerSettings),
    hydrateLocalJsonSetting(PRESETS_STORAGE_KEY, Array.isArray),
    hydrateLocalBooleanSetting(ENABLED_STORAGE_KEY, true, ENABLED_CHANGE_EVENT),
  ]);
  cached = null;
  enabledCached = null;
  presetsCached = null;
  customCached = undefined;

  const current = readSettings();
  // A curve tuned before the Custom slot existed seeds it, or the first preset click would lose it.
  if (readCustom() === null && !activeEqualizerPreset(current, readUserPresets())) {
    customCached = current;
    writeLocalJsonSetting(CUSTOM_STORAGE_KEY, current);
  }

  /*
   * Rust starts flat every launch — the values are process state, not a file — so the stored
   * settings have to be pushed down or the equaliser silently does nothing until the user
   * touches a slider.
   */
  push(current);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useEqualizer(): EqualizerSettings {
  return useSyncExternalStore(subscribe, readSettings, () => EQUALIZER_FLAT);
}

export function useEqualizerEnabled(): boolean {
  return useSyncExternalStore(subscribeEnabled, isEqualizerEnabled, () => true);
}

/** The user's saved presets, in the order they were made. */
export function useEqualizerUserPresets(): EqualizerPreset[] {
  return useSyncExternalStore(subscribe, readUserPresets, () => NO_PRESETS);
}

/** The Custom slot. See `CUSTOM_STORAGE_KEY`. */
export function useEqualizerCustom(): EqualizerSettings | null {
  return useSyncExternalStore(subscribe, readCustom, () => null);
}
