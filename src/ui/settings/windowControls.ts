import { useSyncExternalStore } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { logInternalError } from "../../internal/logging";
import {
  hydrateLocalBooleanSetting,
  readLocalBooleanSetting,
  writeLocalBooleanSetting,
} from "../../internal/durableLocalSetting";

const WINDOWS_STYLE_STORAGE_KEY = "windows-style-window-controls";
const NATIVE_CONTROLS_STORAGE_KEY = "native-window-controls";
const FORCE_CONTROLS_STORAGE_KEY = "force-window-controls-on-tiling-wm";
const WINDOW_OUTLINE_STORAGE_KEY = "window-outline-visible";
const CHANGE_EVENT = "window-controls-change";

function readBooleanSetting(key: string) {
  return readLocalBooleanSetting(key, false);
}

function writeBooleanSetting(key: string, enabled: boolean) {
  writeLocalBooleanSetting(key, enabled, CHANGE_EVENT);
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

function readWindowsStyleWindowControls() {
  return readBooleanSetting(WINDOWS_STYLE_STORAGE_KEY);
}

function readNativeWindowControls() {
  // Default off on every platform: the window is configured without decorations
  // (tauri.conf.json `decorations: false`) and the app draws its own title bar,
  // so the OS frame is opt-in rather than something Linux users are stuck with.
  return readLocalBooleanSetting(NATIVE_CONTROLS_STORAGE_KEY, false);
}

function readForceWindowControls() {
  // Default off: tiling compositors hide the app-drawn buttons by default (see
  // TitleBar's showCustomWindowControls). This is the opt-in escape hatch for anyone
  // who still wants a close/minimize button under a tiling WM.
  return readBooleanSetting(FORCE_CONTROLS_STORAGE_KEY);
}

function readWindowOutline() {
  // Default on, so the frameless window keeps the edge it has always had. Some desktops
  // already separate windows well (shadows, a dark wallpaper), where the light hairline
  // reads as a stray white border, so this lets it go.
  return readLocalBooleanSetting(WINDOW_OUTLINE_STORAGE_KEY, true);
}

function emitWindowControlsChange() {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function setWindowsStyleWindowControls(enabled: boolean) {
  writeBooleanSetting(WINDOWS_STYLE_STORAGE_KEY, enabled);
}

export function setNativeWindowControls(enabled: boolean) {
  writeBooleanSetting(NATIVE_CONTROLS_STORAGE_KEY, enabled);
  void applyNativeWindowControls(enabled);
}

export function setForceWindowControls(enabled: boolean) {
  writeBooleanSetting(FORCE_CONTROLS_STORAGE_KEY, enabled);
}

export function setWindowOutline(visible: boolean) {
  writeBooleanSetting(WINDOW_OUTLINE_STORAGE_KEY, visible);
}

export async function applyNativeWindowControls(enabled = readNativeWindowControls()) {
  try {
    await getCurrentWindow().setDecorations(enabled);
    document.documentElement.toggleAttribute("data-native-window-controls", enabled);
  } catch (error) {
    document.documentElement.toggleAttribute("data-native-window-controls", false);
    logInternalError("windowControls.applyNativeWindowControls failed", error);
  } finally {
    emitWindowControlsChange();
  }
}

export async function hydrateWindowControlSettings() {
  await Promise.all([
    hydrateLocalBooleanSetting(WINDOWS_STYLE_STORAGE_KEY, false, CHANGE_EVENT),
    hydrateLocalBooleanSetting(
      NATIVE_CONTROLS_STORAGE_KEY,
      false,
      CHANGE_EVENT,
      () => applyNativeWindowControls(),
    ),
    hydrateLocalBooleanSetting(FORCE_CONTROLS_STORAGE_KEY, false, CHANGE_EVENT),
    hydrateLocalBooleanSetting(WINDOW_OUTLINE_STORAGE_KEY, true, CHANGE_EVENT),
  ]);
}

export function useWindowsStyleWindowControls() {
  return useSyncExternalStore(subscribe, readWindowsStyleWindowControls, () => false);
}

export function useNativeWindowControls() {
  return useSyncExternalStore(subscribe, readNativeWindowControls, () => false);
}

export function useForceWindowControls() {
  return useSyncExternalStore(subscribe, readForceWindowControls, () => false);
}

export function useWindowOutline() {
  return useSyncExternalStore(subscribe, readWindowOutline, () => true);
}
