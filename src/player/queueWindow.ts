/**
 * Which slice of the queue gets persisted, and where the indices land inside it.
 *
 * Split out of `PlayerController` because the rebasing is the part that fails quietly: an index
 * that is off by the window offset points the restored session at the wrong track, and it looks
 * like a working session until you notice it is playing something else.
 */

/** Upcoming tracks kept in the session. Generous — this is what a restored queue plays. */
export const PERSISTED_QUEUE_AHEAD = 100;
/** Played tracks kept behind the cursor. Only has to cover skipping back a few times. */
export const PERSISTED_QUEUE_BEHIND = 25;

export interface QueueWindow {
  from: number;
  to: number;
  /** `currentIndex` rebased onto the slice. */
  queueIndex: number;
  /** `stopAfterIndex` rebased, or null when it falls outside the slice. */
  stopAfterQueueIndex: number | null;
}

export function computeQueueWindow(
  length: number,
  currentIndex: number,
  stopAfterIndex: number,
): QueueWindow {
  const from = Math.max(0, currentIndex - PERSISTED_QUEUE_BEHIND);
  const to = Math.min(length, Math.max(currentIndex, 0) + PERSISTED_QUEUE_AHEAD + 1);

  return {
    from,
    to,
    // An empty queue reports -1, which is not an index and must survive as it is.
    queueIndex: currentIndex < 0 ? currentIndex : currentIndex - from,
    /*
     * Dropped rather than clamped when it falls outside the window. A stop marker on the wrong
     * song ends playback somewhere the listener never asked for, which is worse than losing it.
     */
    stopAfterQueueIndex:
      stopAfterIndex >= from && stopAfterIndex < to ? stopAfterIndex - from : null,
  };
}
