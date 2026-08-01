import type { Tab } from "../ui/types/tab";
import type { TabManagerSession } from "./TabManager";

const STORAGE_KEY = "yt-music-dock.app-session.v1";

export interface AppSession {
  version: 1;
  tabs: Tab[];
  activeTabId: string;
  nextTabId: number;
  player: TabManagerSession;
}

function restoreWithoutAutoplay(session: AppSession): AppSession {
  return {
    ...session,
    player: {
      ...session.player,
      players: Object.fromEntries(
        Object.entries(session.player.players).map(([id, player]) => [
          id,
          {
            ...player,
            status: player.status === "playing" ? "paused" : player.status,
          },
        ]),
      ),
    },
  };
}

export function loadAppSession(): AppSession | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as AppSession | null;
    if (
      parsed?.version !== 1
      || !Array.isArray(parsed.tabs)
      || parsed.tabs.length === 0
      || typeof parsed.activeTabId !== "string"
      || typeof parsed.nextTabId !== "number"
      || !parsed.player
    ) {
      return null;
    }
    return restoreWithoutAutoplay(parsed);
  } catch {
    return null;
  }
}

/**
 * The payload last written, so an unchanged session costs a comparison rather than a write.
 *
 * The session is persisted from three places — a heartbeat, an effect watching the tabs and
 * player session, and `beforeunload` — and most of those fire when nothing that actually gets
 * persisted has moved. `localStorage.setItem` is synchronous and disk-backed, so skipping the
 * no-op writes is worth more than the string comparison costs.
 */
let lastWrittenSession: string | null = null;

export function saveAppSession(session: AppSession): void {
  try {
    const payload = JSON.stringify(session);
    if (payload === lastWrittenSession) return;
    localStorage.setItem(STORAGE_KEY, payload);
    lastWrittenSession = payload;
  } catch {
    // Persistence failure should not interrupt playback.
  }
}

export function clearAppSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    // Or the next save would match the cleared value and decline to rewrite it.
    lastWrittenSession = null;
  } catch {
    // Persistence failure should not interrupt a full reset.
  }
}
