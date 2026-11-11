import { useSyncExternalStore } from "react";
import {
  hydrateLocalJsonSetting,
  readLocalJsonSetting,
  writeLocalJsonSetting,
} from "../../internal/durableLocalSetting";

const EMPTY: string[] = [];

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** A persisted, ordered set of playlist ids, shared by both windows. */
export function playlistIdSetting(storageKey: string, changeEvent: string) {
  /*
   * Cached: `readLocalJsonSetting` parses fresh JSON on every call, and a new array per render
   * makes `useSyncExternalStore` believe the store changed and re-render forever.
   */
  let cached: string[] | null = null;
  const read = () => (cached ??= readLocalJsonSetting(storageKey, isIdList) ?? EMPTY);
  const write = (ids: string[]) => {
    cached = ids;
    writeLocalJsonSetting(storageKey, ids);
    window.dispatchEvent(new Event(changeEvent));
  };
  const subscribe = (callback: () => void) => {
    window.addEventListener(changeEvent, callback);
    window.addEventListener("storage", callback);
    return () => {
      window.removeEventListener(changeEvent, callback);
      window.removeEventListener("storage", callback);
    };
  };
  if (typeof window !== "undefined") {
    window.addEventListener("storage", () => {
      cached = null;
    });
  }

  return {
    has: (id: string) => read().includes(id),
    add: (id: string) => {
      if (!read().includes(id)) write([...read(), id]);
    },
    remove: (id: string) => {
      if (read().includes(id)) write(read().filter((item) => item !== id));
    },
    hydrate: async () => {
      await hydrateLocalJsonSetting(storageKey, isIdList);
      cached = null;
      window.dispatchEvent(new Event(changeEvent));
    },
    useIds: () => useSyncExternalStore(subscribe, read, () => EMPTY),
  };
}
