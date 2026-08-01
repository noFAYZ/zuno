import { useSyncExternalStore } from "react";
import {
  hydrateLocalBooleanSetting,
  readLocalBooleanSetting,
  writeLocalBooleanSetting,
} from "../../internal/durableLocalSetting";

/**
 * What Zuno does with the signed-in YouTube account beyond reading the library.
 *
 * Both default off. Each changes what leaves the machine — one attaches credentials to stream
 * resolution, the other writes to the account's listening history — so each is a decision the
 * listener makes rather than something that starts happening after an update.
 */

const AUTHENTICATED_STREAMING_KEY = "youtube-authenticated-streaming";
const SCROBBLING_KEY = "youtube-scrobbling";
const CHANGE_EVENT = "youtube-account-settings-change";

/*
 * Cached: the streaming flag is read on every track load and the scrobble flag on every
 * progress tick. Neither wants a synchronous localStorage hit in the playback path.
 */
let cachedAuthenticatedStreaming: boolean | null = null;
let cachedScrobbling: boolean | null = null;

function readAuthenticatedStreaming(): boolean {
  if (cachedAuthenticatedStreaming === null) {
    cachedAuthenticatedStreaming = readLocalBooleanSetting(AUTHENTICATED_STREAMING_KEY, false);
  }
  return cachedAuthenticatedStreaming;
}

function readScrobbling(): boolean {
  if (cachedScrobbling === null) {
    cachedScrobbling = readLocalBooleanSetting(SCROBBLING_KEY, false);
  }
  return cachedScrobbling;
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

// The mini-player window writes the same keys, so a cross-window change drops the cache too.
if (typeof window !== "undefined") {
  window.addEventListener("storage", () => {
    cachedAuthenticatedStreaming = null;
    cachedScrobbling = null;
  });
}

/**
 * Whether *playback* resolves stream URLs with the session attached.
 *
 * Off resolves through the anonymous attested client, which needs a PO token and returns the
 * signed-out format ladder. On puts the authenticated client first — the only session a
 * Premium entitlement could be read from.
 *
 * Downloads never consult this. `resolveDownloadUrl` does not reference it at all, which is
 * the point of it being a separate method rather than a flag on a shared one.
 */
export function usesAuthenticatedStreaming(): boolean {
  return readAuthenticatedStreaming();
}

/** Whether finished plays are reported to YouTube Music's own listening history. */
export function usesYouTubeScrobbling(): boolean {
  return readScrobbling();
}

/** Independent: signed-in resolution is useful on its own, without reporting anything back. */
export function setAuthenticatedStreaming(enabled: boolean): void {
  cachedAuthenticatedStreaming = enabled;
  writeLocalBooleanSetting(AUTHENTICATED_STREAMING_KEY, enabled, CHANGE_EVENT);
}

/**
 * Sets this flag and nothing else.
 *
 * It used to also drive `setAuthenticatedStreaming`, which made a setter quietly mutate a
 * second setting — invisible at the call site and wrong for the toolbar shortcut, where the
 * point is to flip one thing. Callers that *want* both now say so; the Settings toggle does,
 * the toolbar button does not.
 *
 * The two are technically independent: the scrobble pings go out through the authenticated
 * music client whatever stream resolution is doing.
 */
export function setYouTubeScrobbling(enabled: boolean): void {
  cachedScrobbling = enabled;
  writeLocalBooleanSetting(SCROBBLING_KEY, enabled, CHANGE_EVENT);
}

export async function hydrateYouTubeAccountSettings(): Promise<void> {
  await Promise.all([
    hydrateLocalBooleanSetting(AUTHENTICATED_STREAMING_KEY, false, CHANGE_EVENT),
    hydrateLocalBooleanSetting(SCROBBLING_KEY, false, CHANGE_EVENT),
  ]);
  cachedAuthenticatedStreaming = null;
  cachedScrobbling = null;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useAuthenticatedStreaming(): boolean {
  return useSyncExternalStore(subscribe, readAuthenticatedStreaming, () => false);
}

export function useYouTubeScrobbling(): boolean {
  return useSyncExternalStore(subscribe, readScrobbling, () => false);
}
