import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  hydrateLocalBooleanSetting,
  readLocalBooleanSetting,
  writeLocalBooleanSetting,
} from "../../internal/durableLocalSetting";
import { logInternalWarn } from "../../internal/logging";

/** Plays every track at a similar loudness, from YouTube's own measurement (#181). Off by default. */
const STORAGE_KEY = "volume-normalization-enabled";
const CHANGE_EVENT = "volume-normalization-change";

const readEnabled = () => readLocalBooleanSetting(STORAGE_KEY, false);

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

function applyToEngine(): void {
  invoke("native_audio_set_normalization", { enabled: readEnabled() }).catch((error: unknown) => {
    logInternalWarn("volume normalization apply failed", { error: String(error) });
  });
}

export function setVolumeNormalization(enabled: boolean): void {
  writeLocalBooleanSetting(STORAGE_KEY, enabled, CHANGE_EVENT);
  applyToEngine();
}

export async function hydrateVolumeNormalization(): Promise<void> {
  await hydrateLocalBooleanSetting(STORAGE_KEY, false, CHANGE_EVENT);
  applyToEngine();
}

export function useVolumeNormalization(): boolean {
  return useSyncExternalStore(subscribe, readEnabled, () => false);
}
