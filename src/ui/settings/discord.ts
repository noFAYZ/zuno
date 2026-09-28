import { useSyncExternalStore } from "react";
import {
  hydrateLocalBooleanSetting,
  readLocalBooleanSetting,
  writeLocalBooleanSetting,
} from "../../internal/durableLocalSetting";

const STORAGE_KEY = "discord-presence-enabled";
const HIDE_WHEN_PAUSED_KEY = "discord-hide-when-paused";
const CHANGE_EVENT = "discord-settings-change";

function readDiscordPresenceEnabled() {
  return readLocalBooleanSetting(STORAGE_KEY, true);
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function setDiscordPresenceEnabled(enabled: boolean) {
  writeLocalBooleanSetting(STORAGE_KEY, enabled, CHANGE_EVENT);
}

export function getDiscordPresenceEnabled() {
  return readDiscordPresenceEnabled();
}

export function setDiscordHideWhenPaused(hidden: boolean) {
  writeLocalBooleanSetting(HIDE_WHEN_PAUSED_KEY, hidden, CHANGE_EVENT);
}

export function getDiscordHideWhenPaused() {
  return readLocalBooleanSetting(HIDE_WHEN_PAUSED_KEY, false);
}

export async function hydrateDiscordSettings() {
  await Promise.all([
    hydrateLocalBooleanSetting(STORAGE_KEY, true, CHANGE_EVENT),
    hydrateLocalBooleanSetting(HIDE_WHEN_PAUSED_KEY, false, CHANGE_EVENT),
  ]);
}

export function useDiscordPresenceEnabled() {
  return useSyncExternalStore(subscribe, readDiscordPresenceEnabled, () => true);
}

export function useDiscordHideWhenPaused() {
  return useSyncExternalStore(subscribe, getDiscordHideWhenPaused, () => false);
}
