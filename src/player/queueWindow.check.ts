/**
 * Self-check for the persisted-queue window.
 *
 * The rebasing is what fails quietly: an index left un-offset points a restored session at the
 * wrong track, and it looks like a working session until you notice it is playing something
 * else. The stop marker is worse — clamping it to a nearby track ends playback somewhere the
 * listener never asked for.
 */
export {};

import {
  computeQueueWindow,
  PERSISTED_QUEUE_AHEAD,
  PERSISTED_QUEUE_BEHIND,
} from "./queueWindow";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

// A queue small enough to fit is not windowed, and nothing is rebased.
const short = computeQueueWindow(30, 10, -1);
equal(short.from, 0, "a short queue starts at the beginning");
equal(short.to, 30, "and runs to the end");
equal(short.queueIndex, 10, "so the index is unchanged");
equal(short.stopAfterQueueIndex, null, "no marker stays no marker");

// The case this exists for: a long playlist with the cursor deep inside it.
const deep = computeQueueWindow(2000, 900, -1);
equal(deep.from, 900 - PERSISTED_QUEUE_BEHIND, "keeps only the look-behind");
equal(deep.to, 900 + PERSISTED_QUEUE_AHEAD + 1, "and the look-ahead");
equal(deep.queueIndex, PERSISTED_QUEUE_BEHIND, "cursor sits look-behind deep into the slice");
check(deep.to - deep.from < 200, "the slice stays bounded however long the queue is");

// Near the start there is nothing behind to keep, so the slice cannot run negative.
const early = computeQueueWindow(2000, 3, -1);
equal(early.from, 0, "never starts before the queue does");
equal(early.queueIndex, 3, "no offset to subtract when the window starts at zero");

// Near the end it is clamped to the real length rather than past it.
const late = computeQueueWindow(50, 49, -1);
equal(late.to, 50, "never reports more tracks than exist");
equal(late.queueIndex, 49 - late.from, "still rebased against its own start");

// An empty queue reports -1, which is a sentinel and not an index.
const empty = computeQueueWindow(0, -1, -1);
equal(empty.queueIndex, -1, "-1 must survive rebasing untouched");

// A stop marker inside the window is rebased with everything else...
const marked = computeQueueWindow(2000, 900, 910);
equal(marked.stopAfterQueueIndex, 910 - marked.from, "marker rebased onto the slice");

// ...and one outside it is dropped, never clamped to a nearby track.
equal(
  computeQueueWindow(2000, 900, 1500).stopAfterQueueIndex,
  null,
  "a marker past the window is lost, not moved",
);
equal(
  computeQueueWindow(2000, 900, 10).stopAfterQueueIndex,
  null,
  "same for one before it",
);

console.log("queueWindow.check.ts passed");
