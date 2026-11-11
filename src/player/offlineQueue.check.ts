/**
 * Self-check for the download queue's edges: a failure, a retry, and a cancel that arrives while
 * the file is still in flight. Run with `npm run check`.
 */
export {};

const storage = new Map<string, string>();
const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
let releaseSave: () => void = () => {};
let saveGate = Promise.resolve();
let failNextSave: unknown = null;

// The store's only way out is `invoke`; everything else here is somewhere for its reads to land.
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  },
  window: {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
    __TAURI_INTERNALS__: {
      transformCallback: () => 0,
      async invoke(cmd: string, args: Record<string, unknown> = {}) {
        calls.push({ cmd, args });
        if (cmd !== "offline_audio_save") return null;
        await saveGate;
        if (failNextSave) {
          const error = failNextSave;
          failNextSave = null;
          throw error;
        }
        return 1_000;
      },
    },
  },
});

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

const offline = await import("./offlineStore");
const { setOnline } = await import("../internal/connectivity");
setOnline(true);
offline.setOfflineStreamResolver(async () => ({ url: "https://example.test/a", mimeType: "audio/webm" }));

const track = (id: string) => ({ id, title: id, artist: "Artist", source: "youtube" }) as never;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const hold = () => {
  saveGate = new Promise((resolve) => (releaseSave = resolve));
};
const list = () => offline.selectDownloadList(offline.getOfflineState(), 4);

// A failure stays listed with its track, under the backend's own message (`invoke` rejects with an object).
failNextSave = { message: "HTTP 403" };
offline.queueDownload(track("a"));
await settle();
equal(list().failed.map(({ track: { id } }) => id), ["a"], "a failed download is still shown");
equal(list().failed[0]?.message, "HTTP 403", "with the reason, not [object Object]");

offline.retryDownload("a");
await settle();
equal(offline.getOfflineStatus("a"), "ready", "a retry saves it from the kept metadata");
equal(list().failed, [], "and clears the failure");

// Dismissing a failure removes it entirely.
failNextSave = { message: "HTTP 500" };
offline.queueDownload(track("b"));
await settle();
offline.cancelDownload("b");
equal(list().failed, [], "a dismissed failure is gone");
equal(offline.getOfflineStatus("b"), "absent", "and the track is back to not downloaded");

// Cancelled mid-transfer: the file still lands, and is deleted rather than kept.
hold();
offline.queueDownload(track("c"));
await settle();
equal(offline.getOfflineStatus("c"), "downloading", "the transfer is under way");
offline.cancelDownload("c");
equal(offline.getOfflineStatus("c"), "absent", "a cancel stops it reading as downloading at once");
equal(list().active, null, "and drops it from the panel");
releaseSave();
await settle();
check(
  calls.some(({ cmd, args }) => cmd === "offline_audio_remove" && args.trackId === "c"),
  "the landed file is deleted",
);
equal(offline.getOfflineStatus("c"), "absent", "and never becomes a download");

// Asked for again before it lands: kept after all.
hold();
offline.queueDownload(track("d"));
await settle();
offline.cancelDownload("d");
offline.queueDownload(track("d"));
releaseSave();
await settle();
equal(offline.getOfflineStatus("d"), "ready", "re-requesting a cancelled transfer keeps it");

console.log("offlineQueue.check passed");
