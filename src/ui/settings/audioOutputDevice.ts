import { useSyncExternalStore } from "react";
import {
  hydrateLocalJsonSetting,
  readLocalJsonSetting,
  writeLocalJsonSetting,
} from "../../internal/durableLocalSetting";
import { logInternalWarn } from "../../internal/logging";
import { playerController } from "../../player/playerStore";
import {
  listOutputDevices as invokeListOutputDevices,
  setOutputDevice as pushOutputDevice,
  type OutputDevice,
} from "../../player/rustAudio";
import { usesRustAudioEngine } from "./audioEngine";
import { isAndroid } from "../platform";

export type { OutputDevice };
export const listOutputDevices = invokeListOutputDevices;

/**
 * Which cpal output device the Rust engine writes to, by id. `null` is the OS default — what
 * `open_default_sink` grabs when nothing has ever been chosen.
 *
 * Only the Rust engine has a device to pick: the IFrame and native paths play through the
 * webview and follow the OS default the same as any other browser tab.
 */
const STORAGE_KEY = "audio-output-device";
const CHANGE_EVENT = "audio-output-device-change";

/** The `Select` sentinel for "no id" — Radix rejects an empty-string item value. */
export const SYSTEM_DEFAULT_DEVICE = "system-default";

function isDeviceId(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function read(): string | null {
  return readLocalJsonSetting<string | null>(STORAGE_KEY, isDeviceId);
}

/**
 * Pushes the choice down to Rust and, if the engine had a track loaded, reloads it — reopening
 * the stream drops both decks, the same loss `PlayerController.recoverFromPrematureEnd`
 * recovers from when a connection dies mid-track, reused here since a device switch empties the
 * decks the same way.
 *
 * ponytail: a paused track blips playing for an instant before pausing back down, rather than
 * teaching this a load-that-does-not-play path just for the one case where nothing was audible
 * anyway.
 */
async function push(id: string | null): Promise<void> {
  // No Rust engine on Android, so there is no device to select.
  if (isAndroid) return;
  const session = usesRustAudioEngine() ? playerController.getPlayerSession() : null;
  try {
    await pushOutputDevice(id);
  } catch (error) {
    logInternalWarn("Output device push failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  if (!session?.currentTrack || session.status === "idle") return;
  const wasPlaying = session.status === "playing";
  await playerController.playTrackById(session.currentTrack.id);
  if (session.positionSec > 0) await playerController.seekTo(session.positionSec);
  if (!wasPlaying) await playerController.pause();
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function getOutputDevice(): string | null {
  return read();
}

export function setOutputDevice(id: string | null): void {
  writeLocalJsonSetting(STORAGE_KEY, id);
  void push(id);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export async function hydrateOutputDevice(): Promise<void> {
  await hydrateLocalJsonSetting(STORAGE_KEY, isDeviceId);
  // A fresh Rust process always opens the OS default until told otherwise, so the stored choice
  // has to be pushed down once at startup — nothing is loaded this early, so `push` just forwards
  // it.
  void push(read());
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useOutputDevice(): string | null {
  return useSyncExternalStore(subscribe, read, () => null);
}
