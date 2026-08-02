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
let endedListener: (() => void) | null = null;
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
      }),
      listen<EndedEvent>("native-audio-ended", () => {
        positionSec = 0;
        positionTrackId = null;
        endedListener?.();
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
  });
  if (!standby) {
    positionTrackId = trackId;
    positionSec = 0;
    durationSec = duration;
  }
  return duration;
}

export function play(): Promise<void> {
  return invoke("native_audio_play");
}

export function pause(): Promise<void> {
  return invoke("native_audio_pause");
}

export async function stop(): Promise<void> {
  positionSec = 0;
  durationSec = 0;
  positionTrackId = null;
  await invoke("native_audio_stop");
}

export async function seek(seconds: number): Promise<void> {
  // Written through immediately so the progress bar does not snap back to the old position for
  // the up-to-250 ms before Rust's next event confirms the move.
  positionSec = Math.max(0, seconds);
  await invoke("native_audio_seek", { positionSec: positionSec });
}

export function setVolume(volume: number, muted: boolean): Promise<void> {
  return invoke("native_audio_set_volume", { volume, muted });
}

export function setRate(rate: number): Promise<void> {
  return invoke("native_audio_set_rate", { rate });
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

export function getCurrentTime(): number {
  return positionSec;
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
  durationSec = duration;
}

export function warn(context: string, error: unknown): void {
  logInternalWarn(context, {
    error: error instanceof Error ? error.message : String(error),
  });
}
