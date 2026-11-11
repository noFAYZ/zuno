/**
 * Self-check for sidebar library filtering and sorting. No test runner in this project, so:
 *
 *   npx esbuild src/ui/components/sidebarLibrary.check.ts --bundle --platform=node --format=esm
 *     --outfile=check.mjs && node check.mjs
 *
 * The dangerous case here is not a wrong sort — that is visible. It is dragging while the list
 * is filtered or alphabetised, which silently persists an order derived from a list the user
 * was never looking at, and only shows up later as a scrambled sidebar.
 */
export {};

import {
  canReorderLibrary,
  filterLibraryEntries,
  pinnedFirst,
  matchesLibraryQuery,
  reorderBlockedReason,
  sortLibraryEntries,
  type LibraryEntry,
} from "./sidebarLibrary";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const entry = (id: string, title: string, subtitle?: string): LibraryEntry => ({ id, title, subtitle });
const ids = (entries: LibraryEntry[]) => entries.map((item) => item.id).join(",");

// --- filtering ----------------------------------------------------------------------------

const library = [
  entry("a", "Daft Punk Essentials", "Faizan Asad"),
  entry("b", "2019 chill mix", "Faizan Asad"),
  entry("c", "Björk", "YouTube Music"),
  entry("d", "Late Night Drive", "Someone Else"),
];

check(matchesLibraryQuery(library[0], ""), "an empty query matches everything");
check(matchesLibraryQuery(library[0], "daft"), "plain substring matches");
check(matchesLibraryQuery(library[0], "DAFT"), "matching is case-insensitive");

// Terms in any order — a single-substring filter fails this and feels broken.
check(matchesLibraryQuery(library[0], "punk daft"), "terms match out of order");
check(matchesLibraryQuery(library[1], "chill 2019"), "terms match across the title");

// Accents: typing "bjork" on a keyboard without diacritics must still find it.
check(matchesLibraryQuery(library[2], "bjork"), "accent-insensitive matching");
check(matchesLibraryQuery(library[2], "björk"), "the accented spelling still matches");

// The subtitle is searchable, so you can find a playlist by who owns it.
check(matchesLibraryQuery(library[3], "someone"), "subtitle is matched");
check(!matchesLibraryQuery(library[0], "reggae"), "a non-match is rejected");

equal(ids(filterLibraryEntries(library, "faizan")), "a,b", "filters by owner");
equal(ids(filterLibraryEntries(library, "   ")), "a,b,c,d", "whitespace-only query filters nothing");
equal(ids(filterLibraryEntries(library, "nothing here")), "", "no matches yields an empty list");

// --- sorting ------------------------------------------------------------------------------

const ordered = [entry("a", "Zebra"), entry("b", "apple"), entry("c", "Mango")];

equal(ids(sortLibraryEntries(ordered, "custom")), "a,b,c", "custom preserves the caller's order");
equal(ids(sortLibraryEntries(ordered, "name")), "b,c,a", "name sorts case-insensitively");

const recency: Record<string, number> = { a: 10, b: 30, c: 20 };
equal(
  ids(sortLibraryEntries(ordered, "recent", { recencyOf: (id) => recency[id] ?? 0 })),
  "b,c,a",
  "recent sorts newest first",
);

// Never-played entries all share 0 and must keep their incoming order rather than twitch.
const unplayed = [entry("x", "One"), entry("y", "Two"), entry("z", "Three")];
equal(
  ids(sortLibraryEntries(unplayed, "recent", { recencyOf: () => 0 })),
  "x,y,z",
  "equal timestamps keep a stable order",
);

// Liked Songs is a fixed destination in the computed orders, not a competitor for position.
const withPinned = [entry("a", "Zebra"), entry("LM", "Liked Songs"), entry("b", "apple")];
for (const sort of ["name", "recent"] as const) {
  const sorted = sortLibraryEntries(withPinned, sort, { pinnedId: "LM" });
  equal(sorted[0]?.id, "LM", `pinned entry stays first under ${sort}`);
  equal(sorted.length, 3, `pinned entry is not duplicated under ${sort}`);
}

/*
 * But custom must not pin. Pinning there overrides the users own drag order and silently undoes
 * a drop on the next render, which is indistinguishable from reordering being broken.
 */
equal(
  ids(sortLibraryEntries(withPinned, "custom", { pinnedId: "LM" })),
  "a,LM,b",
  "custom leaves the pinned entry exactly where it was dragged",
);

// --- the reorder guard --------------------------------------------------------------------

check(canReorderLibrary("custom", ""), "custom order with no filter allows dragging");
check(!canReorderLibrary("name", ""), "an alphabetical list must not be draggable");
check(!canReorderLibrary("recent", ""), "a recency list must not be draggable");
check(!canReorderLibrary("custom", "daft"), "a filtered list must not be draggable");
check(!canReorderLibrary("name", "daft"), "filtered and sorted is still not draggable");
check(canReorderLibrary("custom", "   "), "a whitespace-only filter does not block dragging");

equal(reorderBlockedReason("custom", ""), null, "no reason when dragging is allowed");
check(
  (reorderBlockedReason("custom", "daft") ?? "").includes("filter"),
  "the filter is named as the blocker",
);
check(
  (reorderBlockedReason("name", "") ?? "").includes("Custom"),
  "the sort mode is named as the blocker",
);
// The filter is the more immediate blocker when both apply, since it is what is on screen.
check(
  (reorderBlockedReason("name", "daft") ?? "").includes("filter"),
  "the filter takes precedence in the explanation",
);

// Pins lead in pin order whatever the sort, and a pin the filter hid stays hidden.
equal(ids(pinnedFirst(ordered, ["c", "a"])), "c,a,b", "pinned playlists lead in pin order");
equal(ids(pinnedFirst(ordered, ["gone"])), "a,b,c", "a pin for a missing playlist changes nothing");
equal(ids(pinnedFirst([entry("b", "apple")], ["a"])), "b", "a filtered-out pin is not brought back");

console.log("sidebarLibrary: ok");
