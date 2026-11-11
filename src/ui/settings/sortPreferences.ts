import { useSyncExternalStore } from "react";
import {
  hydrateLocalJsonSetting,
  readLocalJsonSetting,
  writeLocalJsonSetting,
} from "../../internal/durableLocalSetting";

/** Sort choices outlive the tab that made them (#185, #173). */
const CHANGE_EVENT = "sort-preference-change";

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

// Strings rather than one object per page: a snapshot has to compare equal between reads.
function sortPreference<T extends string>(key: string, values: readonly T[], fallback: T) {
  const isValid = (value: unknown): value is T => values.includes(value as T);
  const read = () => readLocalJsonSetting(key, isValid) ?? fallback;
  const useValue = () => useSyncExternalStore(subscribe, read, () => fallback);
  const setValue = (value: T) => {
    writeLocalJsonSetting(key, value);
    window.dispatchEvent(new Event(CHANGE_EVENT));
  };
  const hydrate = () => hydrateLocalJsonSetting(key, isValid);
  return [useValue, setValue, hydrate] as const;
}

export type PlaylistSort = "dateAdded" | "name" | "album";
export type SortDirection = "asc" | "desc";
export type LibrarySort = "recent" | "title" | "artist";

const [usePlaylistSort, setPlaylistSort, hydratePlaylistSort] = sortPreference<PlaylistSort>(
  "playlist-sort",
  ["dateAdded", "name", "album"],
  "dateAdded",
);
const [usePlaylistSortDirection, setPlaylistSortDirection, hydratePlaylistSortDirection] =
  sortPreference<SortDirection>("playlist-sort-direction", ["asc", "desc"], "desc");
const [useLibrarySort, setLibrarySort, hydrateLibrarySort] = sortPreference<LibrarySort>(
  "library-page-sort",
  ["recent", "title", "artist"],
  "recent",
);

export {
  setLibrarySort,
  setPlaylistSort,
  setPlaylistSortDirection,
  useLibrarySort,
  usePlaylistSort,
  usePlaylistSortDirection,
};

export async function hydrateSortPreferences(): Promise<void> {
  await Promise.all([hydratePlaylistSort(), hydratePlaylistSortDirection(), hydrateLibrarySort()]);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
