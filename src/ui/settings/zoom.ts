import { useSyncExternalStore } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  hydrateLocalJsonSetting,
  readLocalJsonSetting,
  writeLocalJsonSetting,
} from "../../internal/durableLocalSetting";
import { logInternalWarn } from "../../internal/logging";

/** Whole-app zoom for Hi-DPI screens (#175): Settings, or Ctrl/Cmd with +, - and 0. */
const STORAGE_KEY = "ui-zoom";
const CHANGE_EVENT = "ui-zoom-change";

export const ZOOM_LEVELS = [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

const isZoomLevel = (value: unknown): value is number => ZOOM_LEVELS.includes(value as number);
const readZoom = () => readLocalJsonSetting(STORAGE_KEY, isZoomLevel) ?? 1;

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function useZoom(): number {
  return useSyncExternalStore(subscribe, readZoom, () => 1);
}

function applyZoom(): void {
  getCurrentWebview().setZoom(readZoom()).catch((error: unknown) => {
    logInternalWarn("zoom apply failed", { error: String(error) });
  });
}

export function setZoom(level: number): void {
  if (!isZoomLevel(level)) return;
  writeLocalJsonSetting(STORAGE_KEY, level);
  window.dispatchEvent(new Event(CHANGE_EVENT));
  applyZoom();
}

function stepZoom(direction: 1 | -1): void {
  const index = ZOOM_LEVELS.indexOf(readZoom()) + direction;
  setZoom(ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, index))]);
}

export async function hydrateZoom(): Promise<void> {
  await hydrateLocalJsonSetting(STORAGE_KEY, isZoomLevel);
  window.dispatchEvent(new Event(CHANGE_EVENT));
  applyZoom();
}

/** The browser's own zoom keys, which the webview has turned off. */
export function watchZoomKeys(): void {
  window.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    if (event.key === "=" || event.key === "+") stepZoom(1);
    else if (event.key === "-") stepZoom(-1);
    else if (event.key === "0") setZoom(1);
    else return;
    event.preventDefault();
  });
}
