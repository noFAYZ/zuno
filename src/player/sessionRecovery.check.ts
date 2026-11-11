/**
 * Self-check for silent session recovery. No test runner in this project, so:
 *
 *   npx esbuild src/player/sessionRecovery.check.ts --bundle --platform=node --format=esm
 *     --outfile=check.mjs && node check.mjs
 *
 * Recovery opens a hidden webview, and a rejected session rejects *every* request in flight —
 * so the gating is the part that matters. Without single-flight and a cooldown, one dead
 * session turns into a burst of hidden browser windows. That is what this pins.
 */
export {};

/* Hand-rolled stubs rather than a framework: this file only needs somewhere for the module's
   top-level `localStorage` read to land. */
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  },
});

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const { LibraryController } = await import("./LibraryController");

const EMPTY_LIBRARY = {
  account: { name: "Test", artworkUrl: undefined },
  albums: [],
  playlists: [],
  likedSongs: [],
  artists: [],
  recentlyPlayed: [],
};

// The real class, not a lookalike: the controller branches on `instanceof`, so a stand-in
// would exercise the ordinary-failure path and prove nothing about this one.
const { AuthExpiredError } = await import("../datasource/DataSource");

function makeDataSource(
  refreshResult: boolean | (() => boolean),
  libraryFailsAfterRecovery = false,
  restoreResult = true,
  signInError: unknown = null,
) {
  let authExpired: (() => void) | null = null;
  let refreshCalls = 0;
  let recovered = false;

  const dataSource = {
    getTrack: async () => ({}),
    getStreamUrl: async () => "",
    onAuthExpired(handler: () => void) {
      authExpired = handler;
    },
    async restoreSession() {
      return restoreResult;
    },
    async refreshSession() {
      refreshCalls += 1;
      recovered = true;
      return typeof refreshResult === "function" ? refreshResult() : refreshResult;
    },
    async getLibrary() {
      if (recovered && libraryFailsAfterRecovery) throw new AuthExpiredError("expired");
      return EMPTY_LIBRARY;
    },
    async signIn() {
      throw signInError;
    },
  };

  return {
    controller: new LibraryController(dataSource as never),
    expire: () => authExpired?.(),
    refreshCalls: () => refreshCalls,
  };
}

// A burst of rejections is the normal shape of this failure: one dead session rejects the
// library sync, the channel lookup and whatever the user just clicked, all at once.
{
  const { controller, expire, refreshCalls } = makeDataSource(true);
  await controller.initialize();

  expire();
  expire();
  expire();
  await new Promise((resolve) => setTimeout(resolve, 0));

  equal(refreshCalls(), 1, "a burst of rejections triggers exactly one recovery");
}

// A recovery that works keeps the user signed in — no banner, no prompt.
{
  const { controller, expire } = makeDataSource(true);
  await controller.initialize();

  expire();
  await new Promise((resolve) => setTimeout(resolve, 10));

  equal(controller.getState().status, "ready", "a successful recovery stays signed in");
  equal(controller.getState().error, null, "and says nothing about it");
}

// A session that genuinely lapsed has to admit it rather than retry forever.
{
  const { controller, expire, refreshCalls } = makeDataSource(false);
  await controller.initialize();

  expire();
  await new Promise((resolve) => setTimeout(resolve, 10));

  equal(controller.getState().status, "signed-out", "a failed recovery signs out");
  check(
    (controller.getState().error ?? "").includes("expired"),
    "and explains why, so the failure is not silent again",
  );

  // Already signed out: further rejections must not reopen the hidden window.
  expire();
  await new Promise((resolve) => setTimeout(resolve, 10));
  equal(refreshCalls(), 1, "rejections after signing out do not retry");
}

/*
 * A renewal that mints a cookie YouTube still refuses. Recovery suppresses markSessionExpired
 * while it runs — itself — so nothing else can resolve this, and the library would sit spinning
 * on "loading" forever. Caught by this check the first time it ran.
 */
{
  const { controller, expire } = makeDataSource(true, true);
  await controller.initialize();

  expire();
  await new Promise((resolve) => setTimeout(resolve, 10));

  equal(
    controller.getState().status,
    "signed-out",
    "a renewal YouTube still refuses resolves to signed out, not a stuck spinner",
  );
}

/*
 * No stored credential at startup. The keyring entry can fail to read while the sign-in webview's
 * Google session is still alive, and prompting there is a sign-in the user did not need.
 */
{
  const { controller, refreshCalls } = makeDataSource(true, false, false);
  await controller.initialize();

  equal(refreshCalls(), 1, "a missing credential asks the login partition before the user");
  equal(controller.getState().status, "ready", "and a renewal there starts up signed in");
}

// The same, when the partition cannot help either: that is a real sign-out, said plainly.
{
  const { controller } = makeDataSource(false, false, false);
  await controller.initialize();

  equal(controller.getState().status, "signed-out", "a genuinely absent session signs out");
  equal(controller.getState().error, null, "with no error: nothing failed, nobody is signed in");
}

// Adding an account while signed in. `invoke` rejects with a plain object, not an Error.
{
  const cancelled = { message: "YouTube Music sign-in was cancelled." };
  const { controller } = makeDataSource(true, false, true, cancelled);
  await controller.initialize();

  equal(await controller.signIn(), false, "a cancelled add-account reports no sign-in");
  equal(controller.getState().status, "ready", "and leaves the current account signed in");
  equal(controller.getState().error, null, "without calling a cancel a failure");
}

{
  const { controller } = makeDataSource(true, false, true, { message: "YouTube Music sign-in timed out." });
  await controller.initialize();

  equal(await controller.signIn(), false, "a failed add-account reports no sign-in");
  equal(controller.getState().status, "ready", "and still leaves the current account signed in");
  check((controller.getState().error ?? "").includes("timed out"), "while saying why it failed");
}

{
  const cancelled = { message: "YouTube Music sign-in was cancelled." };
  const { controller } = makeDataSource(false, false, false, cancelled);
  await controller.initialize();

  await controller.signIn();
  equal(controller.getState().status, "signed-out", "cancelling a first sign-in stays signed out");
  equal(controller.getState().error, null, "quietly");
}

console.log("sessionRecovery.check passed");
