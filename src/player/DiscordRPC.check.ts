/**
 * Self-check for the presence dedupe key.
 *
 * `PlayerController.emit()` fires on every state change, most of which have nothing to do with
 * Discord. Getting the key wrong in either direction fails quietly: too narrow and a real track
 * change stops updating Discord, too wide and every queue reorder goes back to spamming an IPC
 * call for a payload that already matches what is showing.
 */
export {};

import {
  createPresenceSynchronizer,
  presenceDedupeKey,
  shouldClearPresence,
  type DiscordPresenceData,
} from "./DiscordRPC";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

const base: DiscordPresenceData = {
  title: "Song",
  artist: "Artist",
  album: "Album",
  duration: 200,
  currentTime: 10,
  isPlaying: true,
};

// The whole point: currentTime alone must not change the key.
check(
  presenceDedupeKey(base) === presenceDedupeKey({ ...base, currentTime: 45 }),
  "currentTime is excluded from the key",
);

// Anything else changing has to produce a different key, or Discord never hears about it.
check(
  presenceDedupeKey(base) !== presenceDedupeKey({ ...base, title: "Other song" }),
  "title change is not deduped away",
);
check(
  presenceDedupeKey(base) !== presenceDedupeKey({ ...base, isPlaying: false }),
  "play/pause change is not deduped away",
);

check(shouldClearPresence("paused", true, true), "paused presence clears when enabled");
check(!shouldClearPresence("paused", true, false), "paused presence remains when disabled");
check(shouldClearPresence("idle", false, false), "idle presence clears");
check(shouldClearPresence("loading", true, false), "loading presence clears");

const calls: string[] = [];
const synchronizer = createPresenceSynchronizer({
  clear: async () => { calls.push("clear"); },
  update: async () => { calls.push("update"); },
});
await synchronizer.sync({ data: base, status: "paused" }, { enabled: true, hideWhenPaused: true });
await synchronizer.sync({ data: base, status: "paused" }, { enabled: true, hideWhenPaused: true });
await synchronizer.sync({ data: { ...base, isPlaying: true }, status: "playing" }, { enabled: true, hideWhenPaused: true });
check(calls.join(",") === "clear,update", "paused clear is deduped and resume republishes");

const toggleCalls: string[] = [];
const toggleSynchronizer = createPresenceSynchronizer({
  clear: async () => { toggleCalls.push("clear"); },
  update: async () => { toggleCalls.push("update"); },
});
await toggleSynchronizer.sync({ data: base, status: "paused" }, { enabled: true, hideWhenPaused: false });
await toggleSynchronizer.sync({ data: base, status: "paused" }, { enabled: true, hideWhenPaused: true });
await toggleSynchronizer.sync({ data: base, status: "paused" }, { enabled: true, hideWhenPaused: false });
check(toggleCalls.join(",") === "update,clear,update", "changing the pause setting synchronizes immediately");

let releaseClear!: () => void;
const clearStarted = new Promise<void>((resolve) => { releaseClear = resolve; });
const raceCalls: string[] = [];
const racingSynchronizer = createPresenceSynchronizer({
  clear: async () => {
    raceCalls.push("clear");
    await clearStarted;
  },
  update: async () => { raceCalls.push("update"); },
});
const pause = racingSynchronizer.sync({ data: base, status: "paused" }, { enabled: true, hideWhenPaused: true });
await Promise.resolve();
const resume = racingSynchronizer.sync({ data: { ...base, isPlaying: true }, status: "playing" }, { enabled: true, hideWhenPaused: true });
releaseClear();
await Promise.all([pause, resume]);
check(raceCalls.join(",") === "clear,update", "resume publishes after an in-flight pause clear");

let failedClear = true;
const retryCalls: string[] = [];
const retrySynchronizer = createPresenceSynchronizer({
  clear: async () => {
    retryCalls.push("clear");
    if (failedClear) {
      failedClear = false;
      throw new Error("Discord unavailable");
    }
  },
  update: async () => { retryCalls.push("update"); },
});
await retrySynchronizer.sync({ data: base, status: "paused" }, { enabled: true, hideWhenPaused: true });
await retrySynchronizer.sync({ data: base, status: "paused" }, { enabled: true, hideWhenPaused: true });
check(retryCalls.join(",") === "clear,clear", "failed clear is retried without wedging later syncs");

console.log("DiscordRPC.check.ts passed");
