export {};

import { searchSettings } from "./settingsSearchIndex";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

check(searchSettings("").length === 0, "empty search has no results");
check(
  searchSettings("discord pause").some((entry) => entry.title === "Discord presence" && entry.tab === "about"),
  "search matches terms across a setting description",
);
check(
  searchSettings("quality").some((entry) => entry.title === "Streaming quality"),
  "search finds a library setting",
);
check(searchSettings("this cannot match").length === 0, "unknown query has no results");

console.log("settingsSearch.check.ts passed");
