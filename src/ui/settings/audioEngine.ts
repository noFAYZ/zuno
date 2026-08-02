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
 * plays the bytes from the local media server through an `<audio>` element. `rust` resolves the
 * same URL and decodes it in the Rust process with symphonia, straight out to the sound card.
 *
 * The difference that matters is a whole second webview: the IFrame player runs in a
 * `youtube.com` subframe process of its own, which costs roughly 90 MB and a steady slice of
 * the GPU process. Neither of the other two has a subframe at all.
 *
 * `rust` is what `native` was trying to be. `native` still hands whole songs to the webview over
 * loopback HTTP, which means a second copy of every track lives in the renderer, and it has no
 * standby deck — so gapless and crossfade silently do nothing there. The Rust engine has two
 * real decks and mixes them, decodes as the bytes arrive rather than after, and never puts audio
 * in the renderer at all.
 *
 * `rust` is the default. What made that safe is not that a signed URL never gets refused — it
 * still can, and that is what hardcoded `native` off between v1.2.65 and PO tokens landing — but
 * that a refusal is no longer fatal: `PlayerController` catches a failed resolve or load on a
 * streamed track and plays it on the IFrame deck instead, costing that one track a subframe.
 * `iframe` stays selectable for anyone who wants Google's player for everything.
 */
export type AudioEngineMode = "iframe" | "native" | "rust";

const STORAGE_KEY = "audio-engine-mode";
/** Exported so `AudioEngine` can free its decks the moment the mode stops being `iframe`. */
export const AUDIO_ENGINE_MODE_CHANGE_EVENT = "audio-engine-mode-change";
const CHANGE_EVENT = AUDIO_ENGINE_MODE_CHANGE_EVENT;
const DEFAULT_MODE: AudioEngineMode = "rust";

export const AUDIO_ENGINE_MODES: ReadonlyArray<{
  value: AudioEngineMode;
  label: string;
  hint: string;
}> = [
  {
    value: "rust",
    label: "Rust audio",
    hint: "Decoded in the app. Lowest memory, gapless and crossfade, falls back if a track is refused.",
  },
  {
    value: "iframe",
    label: "YouTube player",
    hint: "Google's own player for everything. Runs a hidden youtube.com frame, ~90 MB.",
  },
  {
    value: "native",
    label: "Native audio",
    hint: "Plays through the webview. Keeps a second copy of each track in memory, no gapless.",
  },
];

function isAudioEngineMode(value: unknown): value is AudioEngineMode {
  return value === "iframe" || value === "native" || value === "rust";
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

/**
 * True when playback does *not* go through the YouTube IFrame.
 *
 * Deliberately covers both non-iframe engines. Every caller of this asks the same question —
 * "is a signed URL being resolved here rather than by Google's embed" — which is what gates
 * stream warming, play reporting and the error copy. Use `usesRustAudioEngine` for the narrower
 * question of *which* of the two.
 */
export function usesNativeAudioEngine(): boolean {
  return readMode() !== "iframe";
}

/** True when Rust decodes and plays the audio itself, with no `<audio>` element involved. */
export function usesRustAudioEngine(): boolean {
  return readMode() === "rust";
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
