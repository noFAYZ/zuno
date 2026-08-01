import { useSyncExternalStore } from "react";
import {
  hydrateLocalBooleanSetting,
  readLocalBooleanSetting,
  writeLocalBooleanSetting,
} from "../../internal/durableLocalSetting";

const EXTRA_CONTROLS_ALWAYS_VISIBLE_STORAGE_KEY = "extra-player-controls-always-visible";
/** Compact puts the seek bar under the controls; expanded keeps it as a full-width rail on top. */
const COMPACT_PLAYER_BAR_STORAGE_KEY = "compact-player-bar";
const CHANGE_EVENT = "player-controls-change";

function readExtraControlsAlwaysVisible() {
  return readLocalBooleanSetting(EXTRA_CONTROLS_ALWAYS_VISIBLE_STORAGE_KEY, true);
}

function readCompactPlayerBar() {
  return readLocalBooleanSetting(COMPACT_PLAYER_BAR_STORAGE_KEY, false);
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function setExtraPlayerControlsAlwaysVisible(enabled: boolean) {
  writeLocalBooleanSetting(EXTRA_CONTROLS_ALWAYS_VISIBLE_STORAGE_KEY, enabled, CHANGE_EVENT);
}

export function setCompactPlayerBar(enabled: boolean) {
  writeLocalBooleanSetting(COMPACT_PLAYER_BAR_STORAGE_KEY, enabled, CHANGE_EVENT);
}

export async function hydratePlayerControlSettings() {
  await Promise.all([
    hydrateLocalBooleanSetting(EXTRA_CONTROLS_ALWAYS_VISIBLE_STORAGE_KEY, true, CHANGE_EVENT),
    hydrateLocalBooleanSetting(COMPACT_PLAYER_BAR_STORAGE_KEY, false, CHANGE_EVENT),
  ]);
}

export function useExtraPlayerControlsAlwaysVisible() {
  return useSyncExternalStore(subscribe, readExtraControlsAlwaysVisible, () => true);
}

export function useCompactPlayerBar() {
  return useSyncExternalStore(subscribe, readCompactPlayerBar, () => false);
}
