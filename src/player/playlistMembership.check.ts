/**
 * Self-check for the remembered-membership store. There is no test runner in this project, so
 * it runs through esbuild (already a Vite dependency) to resolve the extensionless imports:
 *
 *   npx esbuild src/player/playlistMembership.check.ts --bundle --platform=node --format=esm
 *     --outfile=check.mjs && node check.mjs
 *
 * Covers the parts that are easy to get wrong — pruning oldest-first and the re-insert that
 * keeps the order honest. Local membership is derived from storage rather than remembered,
 * so it is not exercised here.
 */
/* Hand-rolled rather than node:assert, so this file needs no Node type declarations and the
   app's `tsc --noEmit` keeps passing over it. */
export {};

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message = ""): void {
  check(actual === expected, `${message} expected ${String(expected)}, got ${String(actual)}`);
}

function deepEqual(actual: unknown, expected: unknown): void {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

const store = new Map<string, string>();
Object.assign(globalThis, {
  window: {},
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  },
});

const { forgetTrackInPlaylist, isTrackKnownInPlaylist, rememberTrackInPlaylist } = await import(
  "./playlistMembership.ts"
);

const track = (id: string) => ({ id, source: "youtube", title: id, artist: "" }) as never;
const playlist = (id: string) => ({ id, title: id }) as never;

// Unknown until something tells us otherwise.
equal(isTrackKnownInPlaylist(track("a"), playlist("p1")), false);

rememberTrackInPlaylist(track("a"), playlist("p1"));
equal(isTrackKnownInPlaylist(track("a"), playlist("p1")), true);
equal(isTrackKnownInPlaylist(track("a"), playlist("p2")), false);
equal(isTrackKnownInPlaylist(track("b"), playlist("p1")), false);

// A second playlist joins the same track rather than replacing it.
rememberTrackInPlaylist(track("a"), playlist("p2"));
equal(isTrackKnownInPlaylist(track("a"), playlist("p1")), true);
equal(isTrackKnownInPlaylist(track("a"), playlist("p2")), true);

// Recording twice is a no-op, not a duplicate.
rememberTrackInPlaylist(track("a"), playlist("p2"));
deepEqual(JSON.parse(store.get("ytc-playlist-membership-v1")!).a, ["p1", "p2"]);

forgetTrackInPlaylist(track("a"), playlist("p1"));
equal(isTrackKnownInPlaylist(track("a"), playlist("p1")), false);
equal(isTrackKnownInPlaylist(track("a"), playlist("p2")), true);

// Pruning drops the oldest tracks and keeps the newest, including the one just written.
for (let index = 0; index < 1200; index += 1) {
  rememberTrackInPlaylist(track(`t${index}`), playlist("p1"));
}
const pruned = JSON.parse(store.get("ytc-playlist-membership-v1")!);
equal(Object.keys(pruned).length, 1000);
equal(isTrackKnownInPlaylist(track("t1199"), playlist("p1")), true);
equal(isTrackKnownInPlaylist(track("t0"), playlist("p1")), false);

console.log("playlistMembership: ok");
