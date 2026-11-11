/**
 * The frontend half of the Rust audio engine.
 *
 * Rust owns decoding, output and the clock; this module owns the invoke calls and the cached
 * position that makes them look synchronous. `AudioEngine` calls it and does not know it is
 * talking to another process.
 *
 * Position is pushed rather than polled: Rust emits `native-audio-position` every 250 ms, the
 * same cadence `PlayerController` ticks at. `getCurrentTime()` has to be synchronous — it is
 * read on every progress frame — so it answers from the last event rather than awaiting an
 * `invoke` that could not resolve in time anyway.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { logInternalWarn } from "../internal/logging";
import type { RustAudioSource } from "../datasource/types";
import { getLoudness } from "./loudness";

export type { RustAudioSource };

type PositionEvent = {
  trackId: string;
  positionSec: number;
  durationSec: number;
};

type EndedEvent = { trackId: string };

let positionSec = 0;
let durationSec = 0;
let positionTrackId: string | null = null;
/** When `positionSec` last arrived from Rust; -Infinity freezes it (paused, seeked, stopped). */
let positionAt = -Infinity;
let rate = 1;
let endedListener: (() => void) | null = null;
const positionListeners = new Set<() => void>();
let unlisten: Promise<UnlistenFn[]> | null = null;

/*
 * Subscribed once for the whole process, not once per engine.
 *
 * There is one Rust engine and one set of events, but a `PlayerController` — and therefore an
 * `AudioEngine` — exists per tab. Listeners per engine would each handle every event and the
 * `ended` callback would fire once per open tab, advancing the queue several times on one track
 * end. Which engine owns `ended` is decided by `setEndedListener`, and only the playback owner
 * ever sets it.
 */
function ensureListening(): Promise<UnlistenFn[]> {
  if (!unlisten) {
    unlisten = Promise.all([
      listen<PositionEvent>("native-audio-position", (event) => {
        positionTrackId = event.payload.trackId;
        positionSec = event.payload.positionSec;
        durationSec = event.payload.durationSec;
        positionAt = performance.now();
        for (const listener of positionListeners) listener();
      }),
      listen<EndedEvent>("native-audio-ended", () => {
        // Zeroed after, not before: the listener needs the final position to tell a track that
        // finished from a stream that died.
        endedListener?.();
        positionSec = 0;
        positionAt = -Infinity;
        positionTrackId = null;
      }),
    ]);
  }
  return unlisten;
}

export function setEndedListener(listener: (() => void) | null): void {
  endedListener = listener;
  if (listener) void ensureListening();
}

/**
 * Decodes a track onto a deck. `standby` targets the idle deck, which `transition` later swaps
 * to. Resolves with the duration Rust decoded, or `fallbackDurationSec` when the container
 * declares none.
 */
export async function load(
  trackId: string,
  source: RustAudioSource,
  fallbackDurationSec: number,
  standby = false,
): Promise<number> {
  await ensureListening();
  const duration = await invoke<number>("native_audio_load", {
    trackId,
    source,
    durationSec: fallbackDurationSec,
    standby,
    loudnessDb: getLoudness(trackId) ?? null,
  });
  if (!standby) {
    positionTrackId = trackId;
    positionSec = 0;
    positionAt = -Infinity;
    durationSec = duration;
  }
  return duration;
}

export function play(): Promise<void> {
  return invoke("native_audio_play");
}

export function pause(): Promise<void> {
  positionSec = getCurrentTime();
  positionAt = -Infinity;
  return invoke("native_audio_pause");
}

export async function stop(): Promise<void> {
  positionSec = 0;
  positionAt = -Infinity;
  durationSec = 0;
  positionTrackId = null;
  await invoke("native_audio_stop");
}

export async function seek(seconds: number): Promise<void> {
  // Written through so the bar does not snap back before Rust's next event confirms the move.
  positionSec = Math.max(0, seconds);
  positionAt = -Infinity;
  await invoke("native_audio_seek", { positionSec: positionSec });
}

export function setVolume(volume: number, muted: boolean): Promise<void> {
  return invoke("native_audio_set_volume", { volume, muted });
}

/** Speed keeps pitch; `pitch` is a frequency ratio that keeps speed. */
export function setRate(next: number, pitch = 1): Promise<void> {
  rate = next;
  return invoke("native_audio_set_rate", { rate: next, pitch });
}

export type OutputDevice = { id: string; name: string; isDefault: boolean };

/** Devices cpal can currently see. Cheap — does not open a device or touch the audio thread. */
export function listOutputDevices(): Promise<OutputDevice[]> {
  return invoke<OutputDevice[]>("native_audio_list_output_devices");
}

/**
 * Switches the device the engine plays to, by the `id` `listOutputDevices` reported. `null` is
 * the OS default. Clears whatever was loaded if the audio thread was already running — the
 * caller reloads the current track the same way a dead stream recovers elsewhere in this file.
 */
export function setOutputDevice(id: string | null): Promise<void> {
  return invoke("native_audio_set_output_device", { id });
}

export function transition(trackId: string, fadeMs: number): Promise<boolean> {
  return invoke<boolean>("native_audio_transition", { trackId, fadeMs });
}

export function hasStandby(trackId: string): Promise<boolean> {
  return invoke<boolean>("native_audio_has_standby", { trackId });
}

export function dropStandby(): Promise<void> {
  return invoke("native_audio_drop_standby");
}

/** Stops and clears the active deck only. See `Command::DropActive` on the Rust side. */
export function dropActive(): Promise<void> {
  return invoke("native_audio_drop_active");
}

/**
 * Drops the audio bodies the local media server is holding.
 *
 * Not strictly a Rust-engine call, but this is its only caller: the media server exists to feed
 * an `<audio>` element, and the Rust engine is the one path that has none. Lives here rather
 * than in a module of its own because one invoke does not need one.
 *
 * Resolves with how many bodies were dropped — zero when the app launched straight into the
 * Rust engine, because the server is lazy and was never started.
 */
export function releaseMediaServer(): Promise<number> {
  return invoke<number>("media_server_release");
}

/**
 * Extrapolated between Rust's 250 ms events so readers sampling per frame move smoothly. Capped at
 * one tick: past that the engine has paused or stalled, and guessing further would run ahead.
 */
export function getCurrentTime(): number {
  const elapsedSec = Math.min(performance.now() - positionAt, 300) / 1000;
  return elapsedSec > 0 ? positionSec + elapsedSec * rate : positionSec;
}

/**
 * Called on every position event. Event delivery is not timer-driven, so unlike `setInterval` it
 * keeps its 250 ms cadence while the window is hidden and Chromium throttles timers.
 */
export function onPosition(listener: () => void): () => void {
  positionListeners.add(listener);
  void ensureListening();
  return () => positionListeners.delete(listener);
}

export function getDuration(): number {
  return durationSec;
}

/** The track Rust last reported on, so a stale event for a skipped track can be ignored. */
export function getPositionTrackId(): string | null {
  return positionTrackId;
}

/** Records the deck swap on this side, since `transition` produces no load event. */
export function adoptTransitioned(trackId: string, duration: number): void {
  positionTrackId = trackId;
  positionSec = 0;
  positionAt = -Infinity;
  durationSec = duration;
}

export function warn(context: string, error: unknown): void {
  logInternalWarn(context, {
    error: error instanceof Error ? error.message : String(error),
  });
}
