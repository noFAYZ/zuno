/**
 * Self-check for `removeAccountOutcome`, the one piece of the multi-account switch/remove flow
 * that lives on the TypeScript side rather than in Rust's `YoutubeAccountStore` (see its own
 * tests in src-tauri/src/lib.rs). It decides what `LibraryController.removeGoogleAccount` shows
 * the user: nothing, a fallback account's library, or signed-out.
 */
export {};

import { artistFromSubtitle, removeAccountOutcome } from "./YouTubeMusicDataSource";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

// Removing an account that was not active must not disturb the current session at all.
check(
  removeAccountOutcome("cookie-a", "cookie-a") === "unchanged",
  "same cookie before and after means the removed account was not the active one",
);

// Removing the active account with another stored one falls back to it.
check(
  removeAccountOutcome("cookie-a", "cookie-b") === "switched",
  "a different, non-null cookie afterward means another stored account took over",
);

// Removing the last account leaves nothing active.
check(
  removeAccountOutcome("cookie-a", null) === "signed-out",
  "no cookie afterward means that was the last stored account",
);

// Removing the only account while never having been signed in is still a no-op, not a crash.
check(
  removeAccountOutcome(null, null) === "unchanged",
  "null before and after must not be read as switching to 'no one'",
);

console.log("YouTubeMusicDataSource.removeAccountOutcome: ok");

// An album card on an artist's own page names no artist; its year is not one (#169).
check(artistFromSubtitle("Album • 2021") === undefined, "type and year alone name no artist");
check(artistFromSubtitle("2016") === undefined, "a bare year is not an artist");
check(artistFromSubtitle("Radiohead • 1995") === "Radiohead", "an artist beside a year survives");
check(artistFromSubtitle("Single • The 1975") === "The 1975", "a name containing digits is still a name");
check(artistFromSubtitle(undefined) === undefined, "no subtitle, no artist");

console.log("YouTubeMusicDataSource.artistFromSubtitle: ok");
