import { useSyncExternalStore } from "react";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  availableMonitors,
  currentMonitor,
  PhysicalPosition,
  primaryMonitor,
} from "@tauri-apps/api/window";
import {
  hydrateLocalBooleanSetting,
  hydrateLocalJsonSetting,
  readLocalBooleanSetting,
  readLocalJsonSetting,
  writeLocalBooleanSetting,
} from "../../internal/durableLocalSetting";
import { setAppSetting } from "../../internal/appSettings";

const MINI_PLAYER_LABEL = "mini-player";
const STORAGE_KEY = "mini-player-enabled";
const POSITION_STORAGE_KEY = "mini-player-position";
const HOVER_ACTION_STORAGE_KEY = "mini-player-hover-action";
const CHANGE_EVENT = "mini-player-enabled-change";
const HOVER_ACTION_CHANGE_EVENT = "mini-player-hover-action-change";
const MINI_PLAYER_BOTTOM_MARGIN = 24;
const POSITION_SAVE_DELAY_MS = 350;
let positionSaveTimer: number | null = null;

export type MiniPlayerHoverAction = "seek" | "volume";

export interface MiniPlayerPosition {
  x: number;
  y: number;
}

function isMiniPlayerPosition(value: unknown): value is MiniPlayerPosition {
  return (
    typeof value === "object"
    && value !== null
    && Number.isFinite((value as MiniPlayerPosition).x)
    && Number.isFinite((value as MiniPlayerPosition).y)
  );
}

function readMiniPlayerEnabled() {
  return readLocalBooleanSetting(STORAGE_KEY, true);
}

function isMiniPlayerHoverAction(value: unknown): value is MiniPlayerHoverAction {
  return value === "seek" || value === "volume";
}

function readMiniPlayerHoverAction() {
  return readLocalJsonSetting(HOVER_ACTION_STORAGE_KEY, isMiniPlayerHoverAction) ?? "seek";
}

function subscribe(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

function subscribeHoverAction(callback: () => void) {
  window.addEventListener(HOVER_ACTION_CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(HOVER_ACTION_CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function setMiniPlayerEnabled(enabled: boolean) {
  writeLocalBooleanSetting(STORAGE_KEY, enabled, CHANGE_EVENT);
}

export function getMiniPlayerEnabled() {
  return readMiniPlayerEnabled();
}

export function getSavedMiniPlayerPosition(): MiniPlayerPosition | null {
  return readLocalJsonSetting(POSITION_STORAGE_KEY, isMiniPlayerPosition);
}

export function saveMiniPlayerPosition(position: MiniPlayerPosition) {
  try {
    localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(position));
  } catch {
    // Durable app settings still get the debounced write below.
  }

  if (positionSaveTimer !== null) {
    window.clearTimeout(positionSaveTimer);
  }
  positionSaveTimer = window.setTimeout(() => {
    positionSaveTimer = null;
    void setAppSetting(POSITION_STORAGE_KEY, position);
  }, POSITION_SAVE_DELAY_MS);
}

export function setMiniPlayerHoverAction(action: MiniPlayerHoverAction) {
  try {
    localStorage.setItem(HOVER_ACTION_STORAGE_KEY, JSON.stringify(action));
  } catch {
    // Durable app settings still get the write below.
  }
  void setAppSetting(HOVER_ACTION_STORAGE_KEY, action);
  window.dispatchEvent(new Event(HOVER_ACTION_CHANGE_EVENT));
}

export async function hydrateMiniPlayerSettings() {
  const storedHoverAction = readLocalJsonSetting(
    HOVER_ACTION_STORAGE_KEY,
    isMiniPlayerHoverAction,
  ) ?? "seek";

  await Promise.all([
    hydrateLocalBooleanSetting(STORAGE_KEY, true, CHANGE_EVENT),
    hydrateLocalJsonSetting(POSITION_STORAGE_KEY, isMiniPlayerPosition),
    hydrateLocalJsonSetting(HOVER_ACTION_STORAGE_KEY, isMiniPlayerHoverAction),
  ]);

  if (!readLocalJsonSetting(HOVER_ACTION_STORAGE_KEY, isMiniPlayerHoverAction)) {
    setMiniPlayerHoverAction(storedHoverAction);
  }

  window.dispatchEvent(new Event(HOVER_ACTION_CHANGE_EVENT));
}

/*
 * The mini player window is created on demand rather than declared in tauri.conf.json.
 *
 * A declared window is spawned at launch even with `visible: false`, and an idle hidden WebView2
 * process costs ~32 MB — paid by every user, including the ones who have the mini player switched
 * off and never see it. Creation follows the setting instead.
 */
let miniPlayerCreation: Promise<WebviewWindow | null> | null = null;

/*
 * Creation and destruction are serialized against each other.
 *
 * Alt-tabbing fires blur and focus within a few milliseconds, and focus now *destroys* the
 * window rather than hiding it. Interleaved, the pair can either leave an orphan on screen or
 * tear down the window that was just asked for. One chain means the last call wins.
 */
let miniPlayerOps: Promise<unknown> = Promise.resolve();

function queueMiniPlayerOp<T>(op: () => Promise<T>): Promise<T> {
  const next = miniPlayerOps.then(op, op);
  // A rejection belongs to its own caller; the chain has to survive it or every later
  // show and hide is dropped with it.
  miniPlayerOps = next.catch(() => undefined);
  return next;
}

async function createMiniPlayerWindow(): Promise<WebviewWindow | null> {
  const existing = await WebviewWindow.getByLabel(MINI_PLAYER_LABEL);
  if (existing) return existing;

  return new Promise<WebviewWindow | null>((resolve) => {
    const miniWin = new WebviewWindow(MINI_PLAYER_LABEL, {
      url: "/mini.html",
      width: 146,
      height: 116,
      resizable: false,
      decorations: false,
      alwaysOnTop: true,
      transparent: true,
      visible: false,
      shadow: false,
      skipTaskbar: true,
    });
    // Resolved on the window's own events: the constructor returns before the webview exists,
    // and showing it too early races the process that has to back it.
    void miniWin.once("tauri://created", () => resolve(miniWin));
    void miniWin.once("tauri://error", () => resolve(null));
  });
}

/**
 * The mini player window, creating it if this is the first time it has been needed.
 *
 * Deduplicated: enabling the setting and backgrounding the main window can both ask for it in
 * the same tick, and creating the label twice is an error rather than a second window.
 */
export function ensureMiniPlayerWindow(): Promise<WebviewWindow | null> {
  if (miniPlayerCreation) return miniPlayerCreation;

  const creation = queueMiniPlayerOp(createMiniPlayerWindow);
  miniPlayerCreation = creation;
  void creation.catch(() => null).finally(() => {
    if (miniPlayerCreation === creation) miniPlayerCreation = null;
  });
  return creation;
}

/** Frees the window's process. `hide()` keeps it resident; only destroying returns the memory. */
export function destroyMiniPlayerWindow(): Promise<void> {
  return queueMiniPlayerOp(async () => {
    const miniWin = await WebviewWindow.getByLabel(MINI_PLAYER_LABEL);
    if (!miniWin) return;
    try {
      await miniWin.destroy();
    } catch {
      // Already gone, or closing concurrently; either way there is nothing left to free.
    }
  });
}

export async function resetMiniPlayerPosition() {
  const miniWin = await WebviewWindow.getByLabel("mini-player");
  const monitor = await currentMonitor()
    ?? await primaryMonitor()
    ?? (await availableMonitors())[0];
  if (!miniWin || !monitor) return;

  const size = await miniWin.outerSize();
  const x = monitor.position.x + Math.round((monitor.size.width - size.width) / 2);
  const y = monitor.position.y + monitor.size.height - size.height - MINI_PLAYER_BOTTOM_MARGIN;

  await miniWin.setPosition(new PhysicalPosition(x, y));
  saveMiniPlayerPosition({ x, y });
}

export function useMiniPlayerEnabled() {
  return useSyncExternalStore(subscribe, readMiniPlayerEnabled, () => true);
}

export function useMiniPlayerHoverAction() {
  return useSyncExternalStore(subscribeHoverAction, readMiniPlayerHoverAction, () => "seek");
}
