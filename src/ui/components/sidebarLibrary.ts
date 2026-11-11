/**
 * Filtering and sorting for the sidebar's library list.
 *
 * Kept out of the component because none of it is React, and because the interaction between
 * the three ordering modes and drag-reorder is the part that can quietly corrupt saved state:
 * dropping a row while the list is filtered or alphabetised would write an order derived from
 * a list the user was not actually looking at. See sidebarLibrary.check.ts.
 */

export type LibrarySort = "custom" | "recent" | "name";

export const LIBRARY_SORTS: ReadonlyArray<{ value: LibrarySort; label: string; hint: string }> = [
  { value: "custom", label: "Custom", hint: "Your order — drag to rearrange" },
  { value: "recent", label: "Recent", hint: "Most recently played first" },
  { value: "name", label: "Name", hint: "Alphabetical" },
];

/** The shape both playlists and albums satisfy, so one path serves the whole sidebar. */
export interface LibraryEntry {
  id: string;
  title: string;
  /** Owner for a playlist, artist for an album. Matched by the filter too. */
  subtitle?: string;
}

/**
 * Normalises for comparison: case-insensitive, and accent-insensitive so "Bjork" finds
 * "Björk". Without the decomposition step a diacritic makes a playlist unreachable by typing
 * its name on a keyboard that cannot produce it.
 */
function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase()
    .trim();
}

/**
 * Matches every whitespace-separated term independently, in any order.
 *
 * "daft punk" and "punk daft" both find "Daft Punk", and "chill 2019" finds "2019 chill mix" —
 * a single substring match fails both, which is what makes a naive filter feel broken.
 */
export function matchesLibraryQuery(entry: LibraryEntry, query: string): boolean {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return true;

  const haystack = `${normalize(entry.title)} ${normalize(entry.subtitle ?? "")}`;
  return terms.every((term) => haystack.includes(term));
}

export function filterLibraryEntries<T extends LibraryEntry>(entries: readonly T[], query: string): T[] {
  if (!query.trim()) return [...entries];
  return entries.filter((entry) => matchesLibraryQuery(entry, query));
}

/**
 * Applies a sort mode.
 *
 * `custom` is the identity: the caller has already arranged the list in the user's saved drag
 * order, and re-sorting it here would throw that away.
 *
 * `pinnedId` keeps Liked Songs at the top of the *computed* orders, where it is a fixed
 * destination rather than a playlist competing for position — but deliberately **not** under
 * `custom`. Pinning there would override the very thing custom means: it silently undoes a drag
 * on the next render, which looks exactly like reordering being broken.
 */
export function sortLibraryEntries<T extends LibraryEntry>(
  entries: readonly T[],
  sort: LibrarySort,
  options: { recencyOf?: (id: string) => number; pinnedId?: string } = {},
): T[] {
  const { recencyOf } = options;
  if (sort === "custom") return [...entries];

  const { pinnedId } = options;
  const pinned = pinnedId ? entries.filter((entry) => entry.id === pinnedId) : [];
  const rest = pinnedId ? entries.filter((entry) => entry.id !== pinnedId) : [...entries];

  if (sort === "name") {
    rest.sort((left, right) =>
      left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: "base" }),
    );
  } else if (sort === "recent") {
    // Stable within equal timestamps: entries never played share 0, and reshuffling them on
    // every render would make the list twitch for no reason.
    const indexOf = new Map(rest.map((entry, index) => [entry.id, index]));
    rest.sort((left, right) => {
      const delta = (recencyOf?.(right.id) ?? 0) - (recencyOf?.(left.id) ?? 0);
      return delta !== 0 ? delta : (indexOf.get(left.id) ?? 0) - (indexOf.get(right.id) ?? 0);
    });
  }

  return [...pinned, ...rest];
}

/** Pinned entries first, in pin order, ahead of whatever the sort decided (#187). */
export function pinnedFirst<T extends LibraryEntry>(entries: readonly T[], pinnedIds: readonly string[]): T[] {
  if (!pinnedIds.length) return [...entries];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const pinned = pinnedIds.map((id) => byId.get(id)).filter((entry): entry is T => Boolean(entry));
  const pinnedSet = new Set(pinnedIds);
  return [...pinned, ...entries.filter((entry) => !pinnedSet.has(entry.id))];
}

/**
 * Whether rows may be dragged right now.
 *
 * Reordering only means anything against the full list in its saved order. While a filter
 * hides rows, or an alphabetical sort overrides that order, a drop would persist positions
 * derived from a list that is not the one being stored — so the affordance is withdrawn rather
 * than left to write something wrong.
 */
export function canReorderLibrary(sort: LibrarySort, query: string): boolean {
  return sort === "custom" && !query.trim();
}

/** Why dragging is unavailable, for the tooltip. Null when it is available. */
export function reorderBlockedReason(sort: LibrarySort, query: string): string | null {
  if (query.trim()) return "Clear the filter to rearrange";
  if (sort !== "custom") return "Switch to Custom order to rearrange";
  return null;
}
