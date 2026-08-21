/**
 * Self-check for the queue mutations added for "add album to queue", "generate queue from
 * here" and "clear queue". There is no test runner in this project, so it runs via esbuild:
 *
 *   npx esbuild src/player/Queue.check.ts --bundle --platform=node --format=esm
 *     --outfile=check.mjs && node check.mjs
 *
 * The arithmetic worth pinning down is the manual/automatic split: Queue.move refuses to
 * reorder across that boundary and skip-back clears it, so a miscounted manual run is a real
 * behaviour bug rather than a cosmetic one.
 */
export {};

import { Queue } from "./Queue";
import type { Track } from "../datasource/types";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const track = (id: string): Track => ({ id, source: "youtube", title: id, artist: "a" }) as Track;
const ids = (queue: Queue) => queue.all.map((item) => item.id).join(",");

// addMany appends behind everything already hand-picked, and counts as manual itself.
const queued = new Queue();
queued.set([track("a"), track("b"), track("c")], 0);
queued.add(track("m1"));
queued.addMany([track("x"), track("y")]);
equal(ids(queued), "a,m1,x,y,b,c", "addMany lands after the current track and existing manual run");
equal(queued.queuedManually, 3, "addMany extends the manual run");

// Bulk-adding nothing must not disturb the run length.
queued.addMany([]);
equal(queued.queuedManually, 3, "empty addMany is inert");

// replaceAfter keeps everything up to and including the index, drops the rest.
const generated = new Queue();
generated.set([track("a"), track("b"), track("c"), track("d")], 0);
generated.add(track("m1"));
generated.add(track("m2"));
equal(ids(generated), "a,m1,m2,b,c,d", "manual entries sit directly after the current track");
equal(generated.queuedManually, 2, "two manual entries");

// Cutting inside the manual run: only the part before the cut is still hand-picked.
generated.replaceAfter(1, [track("g1"), track("g2")]);
equal(ids(generated), "a,m1,g1,g2", "replaceAfter truncates at the index");
equal(generated.queuedManually, 1, "manual run shrinks to what survived the cut");

// Out-of-range and at-or-before-current indices are refused rather than corrupting the queue.
const guarded = new Queue();
guarded.set([track("a"), track("b")], 1);
guarded.replaceAfter(0, [track("z")]);
equal(ids(guarded), "a,b", "replaceAfter refuses an index before the current track");
guarded.replaceAfter(9, [track("z")]);
equal(ids(guarded), "a,b", "replaceAfter refuses an index past the end");

// clearUpcoming keeps the current track playing and drops the rest.
const cleared = new Queue();
cleared.set([track("a"), track("b"), track("c")], 1);
cleared.add(track("m1"));
cleared.clearUpcoming();
equal(ids(cleared), "a,b", "clearUpcoming keeps history and the current track");
equal(cleared.current?.id, "b", "clearUpcoming does not stop what is playing");
equal(cleared.queuedManually, 0, "clearUpcoming empties the manual run");

// shuffleAll mixes played history back into the upcoming tail — the fix for "shuffle does
// nothing on the last track of a playlist". Current track stays put; manual entries stay put.
const lastTrack = new Queue();
lastTrack.set([track("a"), track("b"), track("c"), track("d"), track("e")], 4);
equal(lastTrack.all.length - (lastTrack.currentIndex + 1), 0, "nothing is upcoming on the last track");
lastTrack.shuffleAll(0);
equal(lastTrack.all.length, 5, "shuffleAll keeps every track in the queue");
equal(lastTrack.current?.id, "e", "shuffleAll pins the current track");
equal(ids(lastTrack).split(",").sort().join(","), "a,b,c,d,e", "shuffleAll loses nothing");
check(
  Array.from({ length: 20 }, () => {
    lastTrack.shuffleAll(0);
    return ids(lastTrack);
  }).some((order) => order !== "a,b,c,d,e"),
  "shuffleAll actually reorders (identity every time would mean the pool is never touched)",
);

// Manual entries survive untouched and keep their count.
const withManual = new Queue();
withManual.set([track("a"), track("b"), track("c"), track("d"), track("e")], 2);
withManual.add(track("m1"));
withManual.shuffleAll(withManual.queuedManually);
equal(ids(withManual).split(",")[0], "c", "current track moves to the front");
equal(ids(withManual).split(",")[1], "m1", "manual entry stays right after the current track");
equal(withManual.queuedManually, 1, "manual count survives shuffleAll");

// restoreOriginalOrder undoes a whole-queue shuffle exactly.
withManual.restoreOriginalOrder(withManual.queuedManually);
equal(ids(withManual), "a,b,c,m1,d,e", "restoreOriginalOrder rebuilds the full pre-shuffle state");
equal(withManual.currentIndex, 2, "restoreOriginalOrder puts the cursor back");
equal(withManual.queuedManually, 1, "restoreOriginalOrder restores the manual count");

console.log("Queue: ok");
