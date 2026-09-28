import { invoke } from "@tauri-apps/api/core";
import type { PlayerStatus } from "./PlayerController";
import { createSerialQueue } from "../internal/asyncQueue";
import { logInternalDebug, logInternalWarn } from "../internal/logging";
import {
  getDiscordHideWhenPaused,
  getDiscordPresenceEnabled,
  setDiscordHideWhenPaused as saveDiscordHideWhenPaused,
  setDiscordPresenceEnabled,
} from "../ui/settings/discord";

export interface DiscordPresenceData {
  title: string;
  artist: string;
  album: string;
  artworkUrl?: string;
  songUrl?: string;
  artistUrl?: string;
  albumUrl?: string;
  duration: number;
  currentTime: number;
  isPlaying: boolean;
}

type PresenceSnapshot = { data: DiscordPresenceData; status: PlayerStatus } | null;
type PresenceTransport = {
  clear: () => Promise<void>;
  update: (data: DiscordPresenceData) => Promise<void>;
};

const DISCORD_TEXT_LIMIT = 128;
const DISCORD_ASSET_URL_LIMIT = 256;
const TRUSTED_ARTWORK_HOSTS = new Set([
  "i.ytimg.com",
  "lh3.googleusercontent.com",
  "yt3.ggpht.com",
]);
const TRUSTED_PRESENCE_LINK_HOSTS = new Set([
  "music.youtube.com",
  "youtube.com",
  "www.youtube.com",
]);

function sanitizeDiscordText(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= DISCORD_TEXT_LIMIT) return text;
  return `${text.slice(0, DISCORD_TEXT_LIMIT - 3)}...`;
}

function sanitizeArtworkUrl(value?: string): string | undefined {
  if (!value) return undefined;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || !TRUSTED_ARTWORK_HOSTS.has(parsed.hostname)) return undefined;
    const url = parsed.toString();
    return url.length <= DISCORD_ASSET_URL_LIMIT ? url : undefined;
  } catch {
    return undefined;
  }
}

function sanitizePresenceLink(value?: string): string | undefined {
  if (!value) return undefined;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || !TRUSTED_PRESENCE_LINK_HOSTS.has(parsed.hostname)) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/** Identity of a presence payload for dedupe purposes — everything but `currentTime`. */
export function presenceDedupeKey(data: DiscordPresenceData): string {
  const { currentTime: _currentTime, ...rest } = data;
  return JSON.stringify(rest);
}

export function shouldClearPresence(
  status: PlayerStatus,
  hasTrack: boolean,
  hideWhenPaused: boolean,
): boolean {
  return !hasTrack || status === "idle" || status === "error" || status === "loading" ||
    (status === "paused" && hideWhenPaused);
}

function sanitizePresenceData(data: DiscordPresenceData): DiscordPresenceData {
  return {
    title: sanitizeDiscordText(data.title),
    artist: sanitizeDiscordText(data.artist),
    album: sanitizeDiscordText(data.album),
    artworkUrl: sanitizeArtworkUrl(data.artworkUrl),
    songUrl: sanitizePresenceLink(data.songUrl),
    artistUrl: sanitizePresenceLink(data.artistUrl),
    albumUrl: sanitizePresenceLink(data.albumUrl),
    duration: Math.max(0, Math.floor(Number.isFinite(data.duration) ? data.duration : 0)),
    currentTime: Math.max(0, Math.floor(Number.isFinite(data.currentTime) ? data.currentTime : 0)),
    isPlaying: data.isPlaying,
  };
}

/**
 * Serializes presence commands and coalesces bursts to their latest desired state.
 * `publishedKey` is undefined before the first command, null after a clear, or the last sent
 * track key. One field deliberately models all three states, so clear/update dedupe cannot drift.
 */
export function createPresenceSynchronizer(transport: PresenceTransport) {
  let latest: PresenceSnapshot = null;
  let enabled = true;
  let hideWhenPaused = false;
  let publishedKey: string | null | undefined;
  const enqueue = createSerialQueue();

  async function publishLatest(): Promise<void> {
    if (!latest || !enabled || shouldClearPresence(latest.status, true, hideWhenPaused)) {
      if (publishedKey === null) return;
      try {
        await transport.clear();
        publishedKey = null;
      } catch {
        // Keep the old state so the next sync retries it.
      }
      return;
    }

    const data = sanitizePresenceData(latest.data);
    const key = presenceDedupeKey(data);
    if (key === publishedKey) return;
    try {
      await transport.update(data);
      publishedKey = key;
    } catch {
      // Keep the old state so the next sync retries it.
    }
  }

  return {
    sync(next: PresenceSnapshot, options: { enabled: boolean; hideWhenPaused: boolean }): Promise<void> {
      latest = next;
      enabled = options.enabled;
      hideWhenPaused = options.hideWhenPaused;
      return enqueue(publishLatest);
    },
  };
}

/** Manages Discord Rich Presence and owns its playback-to-presence policy. */
export class DiscordRpcService {
  private static lastPlayback: PresenceSnapshot = null;
  private static synchronizer = createPresenceSynchronizer({
    async clear() {
      try {
        logInternalDebug("Discord.clearPresence", {});
        await invoke("discord_rpc_clear");
        logInternalDebug("Discord.clearPresence.success", {});
      } catch (error) {
        logInternalWarn("Discord.clearPresence.failed", error as Record<string, unknown>);
        throw error;
      }
    },
    async update(data) {
      try {
        logInternalDebug("Discord.updatePresence", {
          title: data.title,
          artist: data.artist,
          isPlaying: data.isPlaying,
        });
        await invoke("discord_rpc_update", {
          title: data.title,
          artist: data.artist,
          album: data.album,
          artworkUrl: data.artworkUrl,
          songUrl: data.songUrl,
          artistUrl: data.artistUrl,
          albumUrl: data.albumUrl,
          duration: data.duration,
          currentTime: data.currentTime,
          isPlaying: data.isPlaying,
        });
        logInternalDebug("Discord.updatePresence.success", {});
      } catch (error) {
        logInternalWarn("Discord.updatePresence.failed", error as Record<string, unknown>);
        throw error;
      }
    },
  });

  static async init(): Promise<void> {
    logInternalDebug("Discord.init", { message: "Rust backend will handle connection" });
  }

  static async setHideWhenPaused(hidden: boolean): Promise<void> {
    saveDiscordHideWhenPaused(hidden);
    await this.syncLatest();
  }

  static async syncPresence(data: DiscordPresenceData | null, status: PlayerStatus): Promise<void> {
    this.lastPlayback = data ? { data, status } : null;
    await this.syncLatest();
  }

  static async setEnabled(enabled: boolean): Promise<void> {
    setDiscordPresenceEnabled(enabled);
    await this.syncLatest();
  }

  private static syncLatest(): Promise<void> {
    return this.synchronizer.sync(this.lastPlayback, {
      enabled: getDiscordPresenceEnabled(),
      hideWhenPaused: getDiscordHideWhenPaused(),
    });
  }
}

export default DiscordRpcService;
