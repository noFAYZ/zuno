import { useSyncExternalStore } from "react";
import { isAndroid } from "../platform";
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
  writeLocalJsonSetting,
} from "../../internal/durableLocalSetting";
import { setAppSetting } from "../../internal/appSettings";

const MINI_PLAYER_LABEL = "mini-player";
const STORAGE_KEY = "mini-player-enabled";
const POSITION_STORAGE_KEY = "mini-player-position";
const HOVER_ACTION_STORAGE_KEY = "mini-player-hover-action";
const CHANGE_EVENT = "mini-player-enabled-change";
const HOVER_ACTION_CHANGE_EVENT = "mini-player-hover-action-change";
const SKIN_STORAGE_KEY = "mini-player-skin";
const SKIN_CHANGE_EVENT = "mini-player-skin-change";
const MINI_PLAYER_BOTTOM_MARGIN = 24;
const POSITION_SAVE_DELAY_MS = 350;
let positionSaveTimer: number | null = null;

export type MiniPlayerHoverAction = "seek" | "volume";

/**
 * Mini player skins. Metadata only — the components live in mini-player/skins — so the main
 * window can open the mini window at its skin's size without loading any skin code.
 * `width`/`height` are the window, shadow room included.
 */
export const MINI_PLAYER_SKINS = [
  {
    id: "classic",
    name: "Classic",
    description: "The glass capsule that opens on hover.",
    width: 146,
    height: 116,
  },
  {
    id: "cassette",
    name: "Cassette",
    description: "A tape deck whose reels wind through the song.",
    width: 272,
    height: 180,
  },
  {
    id: "vinyl",
    name: "Vinyl",
    description: "A spinning record with a tonearm that tracks the song.",
    width: 216,
    height: 216,
  },
  {
    id: "y2k",
    name: "Y2K",
    description: "Candy-gel gloss, a chrome play orb and a backlit LCD.",
    width: 316,
    height: 156,
  },

] as const;

export type MiniPlayerSkinId = (typeof MINI_PLAYER_SKINS)[number]["id"];

function isMiniPlayerSkinId(value: unknown): value is MiniPlayerSkinId {
  return MINI_PLAYER_SKINS.some((skin) => skin.id === value);
}

export function getMiniPlayerSkin(): MiniPlayerSkinId {
  return readLocalJsonSetting(SKIN_STORAGE_KEY, isMiniPlayerSkinId) ?? "classic";
}

export function getMiniPlayerSkinInfo(id: MiniPlayerSkinId) {
  return MINI_PLAYER_SKINS.find((skin) => skin.id === id) ?? MINI_PLAYER_SKINS[0];
}

export function setMiniPlayerSkin(id: MiniPlayerSkinId) {
  writeLocalJsonSetting(SKIN_STORAGE_KEY, id);
  window.dispatchEvent(new Event(SKIN_CHANGE_EVENT));
}

function subscribeSkin(callback: () => void) {
  window.addEventListener(SKIN_CHANGE_EVENT, callback);
  // The mini player is another window; this is how it hears a change made in Settings.
  window.addEventListener("storage", callback);
  return () => {
    window.removeEventListener(SKIN_CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function useMiniPlayerSkin(): MiniPlayerSkinId {
  return useSyncExternalStore(subscribeSkin, getMiniPlayerSkin, () => "classic");
}

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
    hydrateLocalJsonSetting(SKIN_STORAGE_KEY, isMiniPlayerSkinId),
  ]);

  if (!readLocalJsonSetting(HOVER_ACTION_STORAGE_KEY, isMiniPlayerHoverAction)) {
    setMiniPlayerHoverAction(storedHoverAction);
  }

  window.dispatchEvent(new Event(HOVER_ACTION_CHANGE_EVENT));
  window.dispatchEvent(new Event(SKIN_CHANGE_EVENT));
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
 * Whether the window is on screen right now.
 *
 * The main window pushes playback time and volume to it on an interval, and had no way to ask
 * whether anybody was listening — so it emitted two Tauri events every second for the whole
 * session, across the IPC boundary, to a window that exists only while the app is backgrounded
 * and usually does not exist at all. This is the answer to that question.
 */
let miniPlayerWindowLive = false;
const liveListeners = new Set<() => void>();

function setMiniPlayerWindowLive(live: boolean): void {
  if (live === miniPlayerWindowLive) return;
  miniPlayerWindowLive = live;
  for (const listener of liveListeners) listener();
}

function subscribeToWindowLive(listener: () => void): () => void {
  liveListeners.add(listener);
  return () => {
    liveListeners.delete(listener);
  };
}

function getWindowLive(): boolean {
  return miniPlayerWindowLive;
}

/** True while the mini player window exists. Drives the main window's push-sync interval. */
export function useMiniPlayerWindowLive(): boolean {
  return useSyncExternalStore(subscribeToWindowLive, getWindowLive, () => false);
}

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

  // Opened at the skin's size, so it never flashes at another skin's size first.
  const { width, height } = getMiniPlayerSkinInfo(getMiniPlayerSkin());
  return new Promise<WebviewWindow | null>((resolve) => {
    const miniWin = new WebviewWindow(MINI_PLAYER_LABEL, {
      url: "/mini.html",
      width,
      height,
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
  // Android has a single webview window; there is nothing to create.
  if (isAndroid) return Promise.resolve(null);
  if (miniPlayerCreation) return miniPlayerCreation;

  const creation = queueMiniPlayerOp(createMiniPlayerWindow);
  miniPlayerCreation = creation;
  void creation.then(
    (miniWin) => setMiniPlayerWindowLive(miniWin !== null),
    () => setMiniPlayerWindowLive(false),
  );
  void creation.catch(() => null).finally(() => {
    if (miniPlayerCreation === creation) miniPlayerCreation = null;
  });
  return creation;
}

/** Frees the window's process. `hide()` keeps it resident; only destroying returns the memory. */
export function destroyMiniPlayerWindow(): Promise<void> {
  if (isAndroid) return Promise.resolve();
  return queueMiniPlayerOp(async () => {
    setMiniPlayerWindowLive(false);
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
  if (isAndroid) return;
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
