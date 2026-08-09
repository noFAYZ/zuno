import { useSyncExternalStore } from "react";
import {
  hydrateLocalBooleanSetting,
  readLocalBooleanSetting,
  writeLocalBooleanSetting,
} from "../../internal/durableLocalSetting";

/**
 * Whether playback is exposed to the desktop's media controls (MPRIS on Linux, via
 * `linux_media.rs`/souvlaki). Also drives the now-playing notifications some desktops show.
 * Turning this off stops publishing updates so neither appears.
 */
const MEDIA_SESSION_STORAGE_KEY = "linux-media-session";
const CHANGE_EVENT = "media-session-change";

function readMediaSession() {
  return readLocalBooleanSetting(MEDIA_SESSION_STORAGE_KEY, true);
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function setLinuxMediaSession(enabled: boolean) {
  writeLocalBooleanSetting(MEDIA_SESSION_STORAGE_KEY, enabled, CHANGE_EVENT);
}

export async function hydrateMediaSessionSettings() {
  await hydrateLocalBooleanSetting(MEDIA_SESSION_STORAGE_KEY, true, CHANGE_EVENT);
}

export function useLinuxMediaSession() {
  return useSyncExternalStore(subscribe, readMediaSession, () => true);
}
