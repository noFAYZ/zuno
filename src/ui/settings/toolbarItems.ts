import { useSyncExternalStore } from "react";
import {
  hydrateLocalBooleanSetting,
  readLocalBooleanSetting,
  writeLocalBooleanSetting,
} from "../../internal/durableLocalSetting";

/**
 * Which optional buttons the title bar carries.
 *
 * All on by default — the toolbar as it has always been — and each is only about *visibility*.
 * Hiding the Discord or Last.fm button does not turn the integration off; that stays where it
 * was, in its own setting, so a hidden button can never silently stop scrobbling.
 */
export type ToolbarItem = "notifications" | "downloads" | "discord" | "lastfm" | "ytmusic" | "github";

const STORAGE_KEYS: Record<ToolbarItem, string> = {
  notifications: "toolbar-notifications-visible",
  downloads: "toolbar-downloads-visible",
  discord: "toolbar-discord-visible",
  lastfm: "toolbar-lastfm-visible",
  ytmusic: "toolbar-ytmusic-visible",
  github: "toolbar-github-visible",
};

/** Label and blurb for the settings rows, in the order they sit in the toolbar. */
export const TOOLBAR_ITEMS: Array<{
  id: ToolbarItem;
  label: string;
  description: string;
}> = [
  {
    id: "notifications",
    label: "Notifications",
    description: "New releases from artists you subscribe to, with an unread count.",
  },
  {
    id: "downloads",
    label: "Downloads",
    description: "Progress for songs being saved for offline, and what is stored.",
  },
  {
    id: "discord",
    label: "Discord presence",
    description: "Shortcut for sharing what you are playing. Hiding it leaves it as it is.",
  },
  {
    id: "lastfm",
    label: "Last.fm scrobbling",
    description: "Shortcut for scrobbling. Hiding it leaves it as it is.",
  },
  {
    id: "ytmusic",
    label: "YouTube Music history",
    description: "Shortcut for reporting plays to YouTube. Hiding it leaves it as it is.",
  },
  {
    id: "github",
    label: "GitHub",
    description: "Opens the project's source in your browser.",
  },
];

const CHANGE_EVENT = "toolbar-items-change";

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  // Another window (the mini player) writes the same keys.
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function readToolbarItemVisible(item: ToolbarItem): boolean {
  return readLocalBooleanSetting(STORAGE_KEYS[item], true);
}

export function setToolbarItemVisible(item: ToolbarItem, visible: boolean) {
  writeLocalBooleanSetting(STORAGE_KEYS[item], visible, CHANGE_EVENT);
}

export function useToolbarItemVisible(item: ToolbarItem): boolean {
  return useSyncExternalStore(subscribe, () => readToolbarItemVisible(item), () => true);
}

export async function hydrateToolbarItemSettings() {
  await Promise.all(
    Object.values(STORAGE_KEYS).map((key) => hydrateLocalBooleanSetting(key, true, CHANGE_EVENT)),
  );
}
