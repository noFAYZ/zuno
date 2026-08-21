/**
 * Self-check for the stale-shuffle-flag fix. No test runner in this project, so:
 *
 *   npx esbuild src/player/shuffleFlag.check.ts --bundle --platform=node --format=esm
 *     --outfile=check.mjs && node check.mjs
 *
 * `setShuffleEnabled(true)` used to early-return when the persisted flag already read "on",
 * so the playlist header's Shuffle action picked a random start track but never reordered
 * what followed — Up next stayed as the unshuffled remains of the playlist. The fix reorders
 * whenever no un-shuffle snapshot exists, regardless of the flag's previous value.
 */
export {};

/* Hand-rolled stubs rather than a framework: this file only needs somewhere for module-level
   localStorage reads (playback settings) and Tauri IPC log writes to land. */
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
  window: {
    __TAURI_INTERNALS__: {
      invoke: () => Promise.resolve(null),
      transformCallback: () => 0,
    },
  },
});

import { PlayerController } from "./PlayerController";
import type { Track } from "../datasource/types";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const track = (id: string): Track => ({ id, source: "youtube", title: id, artist: "a" }) as Track;
const ids = (controller: PlayerController) =>
  controller.getPlayerSession().queue.map((item) => item.id).join(",");
const SOURCE = ["a", "b", "c", "d", "e", "f"];

function make(shuffleEnabled: boolean, isPlaylistMode = true): PlayerController {
  const controller = new PlayerController({} as never);
  controller.restoreSession({
    currentTrack: null,
    history: [],
    queue: SOURCE.map(track),
    queueIndex: 2,
    status: "idle",
    positionSec: 0,
    volume: 1,
    muted: false,
    autoplayEnabled: false,
    playbackOrderMode: "in-order",
    shuffleEnabled,
    isPlaylistMode,
  });
  return controller;
}

const sortedIds = (order: string) => order.split(",").sort().join(",");

// The bug: flag persisted "on" from a previous session, playlist freshly loaded in order.
// playShuffled calls setShuffleEnabled(true) again — this must actually reorder the tail now.
{
  const controller = make(true);
  const before = ids(controller);
  equal(before.split(",")[2], "c", "current track starts at its queue index");
  controller.setShuffleEnabled(true);

  const after = ids(controller);
  equal(sortedIds(after), sortedIds(before), "shuffling loses no tracks");
  equal(after.split(",")[0] + after.split(",")[1], "ab", "history before the cursor stays put");
  equal(after.split(",")[2], "c", "current track keeps its slot");
  check(
    Array.from({ length: 10 }, () => {
      controller.setShuffleEnabled(false);
      controller.setShuffleEnabled(true);
      return ids(controller);
    }).some((order) => order !== before),
    "repeated enable cycles do reshuffle a fresh tail (the fixed path)",
  );
}

// Enabling twice in a row must not reshuffle an already-shuffled tail.
{
  const controller = make(false);
  controller.setShuffleEnabled(true);
  const once = ids(controller);
  controller.setShuffleEnabled(true);
  equal(ids(controller), once, "a redundant enable does not reshuffle");
}

// Disabling restores the source order exactly.
{
  const controller = make(false);
  controller.setShuffleEnabled(true);
  controller.setShuffleEnabled(false);
  equal(ids(controller), "a,b,c,d,e,f", "disable rebuilds the original order");
}

// Non-playlist queues stay untouched by the toggle, as before.
{
  const controller = make(true, false);
  controller.setShuffleEnabled(true);
  equal(ids(controller), "a,b,c,d,e,f", "single-track/radio mode ignores the shuffle toggle");
}

console.log("shuffleFlag: ok");
