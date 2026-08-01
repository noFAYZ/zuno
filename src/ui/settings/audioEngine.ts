import { useSyncExternalStore } from "react";
import {
  hydrateLocalJsonSetting,
  readLocalJsonSetting,
  writeLocalJsonSetting,
} from "../../internal/durableLocalSetting";

/**
 * Which pipeline actually makes sound.
 *
 * `iframe` hands the video id to a hidden YouTube IFrame player and lets Google's own embed
 * resolve and stream it. `native` resolves the signed URL here, downloads it through Rust, and
 * plays the bytes from the local media server through an `<audio>` element.
 *
 * The difference that matters is a whole second webview: the IFrame player runs in a
 * `youtube.com` subframe process of its own, which costs roughly 90 MB and a steady slice of
 * the GPU process. Native has no subframe at all.
 *
 * Native is not the default *yet*, for three reasons: it resolves a signed URL and downloads
 * the whole track before the first sample plays, so it starts slower; it is the path that
 * historically answered 403, which is why this was hardcoded off until PO tokens landed; and
 * gapless and crossfade ride the standby IFrame deck, so neither applies to it. Downloads have
 * used this exact resolve-and-fetch path successfully since PO tokens, which is what makes it
 * worth offering — leaving the default alone means a regression costs a setting rather than
 * everyone's playback.
 */
export type AudioEngineMode = "iframe" | "native";

const STORAGE_KEY = "audio-engine-mode";
/** Exported so `AudioEngine` can free its decks the moment the mode stops being `iframe`. */
export const AUDIO_ENGINE_MODE_CHANGE_EVENT = "audio-engine-mode-change";
const CHANGE_EVENT = AUDIO_ENGINE_MODE_CHANGE_EVENT;
const DEFAULT_MODE: AudioEngineMode = "iframe";

export const AUDIO_ENGINE_MODES: ReadonlyArray<{
  value: AudioEngineMode;
  label: string;
  hint: string;
}> = [
  {
    value: "iframe",
    label: "YouTube player",
    hint: "Most reliable. Runs a hidden youtube.com frame, ~90 MB.",
  },
  {
    value: "native",
    label: "Native audio",
    hint: "No hidden frame. Lower memory, slower to start, no gapless or crossfade.",
  },
];

function isAudioEngineMode(value: unknown): value is AudioEngineMode {
  return value === "iframe" || value === "native";
}

/*
 * Cached because `AudioEngine` reads this on every load, play, pause, seek and volume change —
 * a synchronous localStorage hit on each would sit directly in the playback path.
 */
let cachedMode: AudioEngineMode | null = null;

function readMode(): AudioEngineMode {
  if (cachedMode === null) {
    cachedMode = readLocalJsonSetting(STORAGE_KEY, isAudioEngineMode) ?? DEFAULT_MODE;
  }
  return cachedMode;
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

/*
 * The cache has to drop on a write from the other window too, or the mini player keeps
 * answering with the value it read at startup.
 *
 * Guarded because this runs at import and `player/AudioEngine.ts` imports this module — which
 * puts it one import away from the `*.check.ts` bundles, and those run in Node with no `window`.
 */
if (typeof window !== "undefined") {
  window.addEventListener("storage", () => {
    cachedMode = null;
  });
}

export function getAudioEngineMode(): AudioEngineMode {
  return readMode();
}

/** True when the current mode plays through `<audio>` rather than the YouTube IFrame. */
export function usesNativeAudioEngine(): boolean {
  return readMode() === "native";
}

export function setAudioEngineMode(mode: AudioEngineMode) {
  cachedMode = mode;
  writeLocalJsonSetting(STORAGE_KEY, mode);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export async function hydrateAudioEngineMode(): Promise<void> {
  await hydrateLocalJsonSetting(STORAGE_KEY, isAudioEngineMode);
  cachedMode = null;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useAudioEngineMode(): AudioEngineMode {
  return useSyncExternalStore(subscribe, readMode, () => DEFAULT_MODE);
}
