import { getAppSetting, setAppSetting } from "../internal/appSettings";

const STORAGE_KEY = "playback-settings";

/** Longest crossfade offered. Past this the overlap eats more of a song than it smooths. */
export const MAX_CROSSFADE_SEC = 12;

export interface PlaybackSettings {
  volume: number;
  muted: boolean;
  /** 1 is normal speed. Optional so settings written before this existed still load. */
  playbackRate?: number;
  /**
   * Seconds of overlap between tracks. 0 turns crossfading off, which is the default because
   * it changes how every album transition sounds and should be asked for.
   */
  crossfadeSec?: number;
  /**
   * Cue the next track while the current one is still playing, so the switch has nothing to
   * load. On by default: it removes a gap without altering how anything sounds.
   */
  gaplessEnabled?: boolean;
}

function isPlaybackSettings(value: unknown): value is PlaybackSettings {
  return (
    typeof value === "object"
    && value !== null
    && Number.isFinite((value as PlaybackSettings).volume)
    && (value as PlaybackSettings).volume >= 0
    && (value as PlaybackSettings).volume <= 1
    && typeof (value as PlaybackSettings).muted === "boolean"
  );
}

export function readPlaybackSettings(): PlaybackSettings {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as unknown;
    if (isPlaybackSettings(parsed)) return parsed;
  } catch {
    // Defaults below keep playback usable if local storage is unavailable.
  }

  return { volume: 1, muted: false, playbackRate: 1, crossfadeSec: 0, gaplessEnabled: true };
}

export function savePlaybackSettings(settings: PlaybackSettings): void {
  const normalizedSettings = {
    volume: Math.min(1, Math.max(0, settings.volume)),
    muted: settings.muted,
    playbackRate: Math.min(4, Math.max(0.25, settings.playbackRate ?? 1)),
    crossfadeSec: Math.min(MAX_CROSSFADE_SEC, Math.max(0, settings.crossfadeSec ?? 0)),
    gaplessEnabled: settings.gaplessEnabled ?? true,
  };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizedSettings));
  } catch {
    // Durable app settings still get the write below.
  }

  void setAppSetting(STORAGE_KEY, normalizedSettings);
}

export async function hydratePlaybackSettings(): Promise<PlaybackSettings> {
  const stored = await getAppSetting<unknown>(STORAGE_KEY);
  if (isPlaybackSettings(stored)) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      // The caller still receives the hydrated value.
    }
    return stored;
  }

  const localSettings = readPlaybackSettings();
  void setAppSetting(STORAGE_KEY, localSettings);
  return localSettings;
}
