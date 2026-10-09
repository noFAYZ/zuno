import { useSyncExternalStore } from "react";
import {
  availableMonitors,
  getCurrentWindow,
  PhysicalPosition,
} from "@tauri-apps/api/window";
import { PhysicalSize } from "@tauri-apps/api/dpi";
import {
  hydrateLocalBooleanSetting,
  hydrateLocalJsonSetting,
  readLocalBooleanSetting,
  readLocalJsonSetting,
  writeLocalBooleanSetting,
  writeLocalJsonSetting,
} from "../../internal/durableLocalSetting";
import { removeAppSetting } from "../../internal/appSettings";
import { logInternalError } from "../../internal/logging";

const STORAGE_KEY = "main-window-geometry";
const GEOMETRY_ENABLED_STORAGE_KEY = "main-window-geometry-persistence-enabled";
const LEGACY_LOCATION_ENABLED_STORAGE_KEY = "main-window-location-persistence-enabled";
const GEOMETRY_ENABLED_CHANGE_EVENT = "main-window-geometry-persistence-change";
const MIN_WIDTH = 900;
const MIN_HEIGHT = 600;
const SAVE_DELAY_MS = 250;

interface MainWindowGeometry {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

function isMainWindowGeometry(value: unknown): value is MainWindowGeometry {
  return (
    typeof value === "object"
    && value !== null
    && Number.isFinite((value as MainWindowGeometry).width)
    && Number.isFinite((value as MainWindowGeometry).height)
    && (value as MainWindowGeometry).width >= MIN_WIDTH
    && (value as MainWindowGeometry).height >= MIN_HEIGHT
    && (
      (
        (value as MainWindowGeometry).x === undefined
        && (value as MainWindowGeometry).y === undefined
      )
      || (
        Number.isFinite((value as MainWindowGeometry).x)
        && Number.isFinite((value as MainWindowGeometry).y)
      )
    )
  );
}

function hasSavedPosition(
  geometry: MainWindowGeometry,
): geometry is MainWindowGeometry & { x: number; y: number } {
  return Number.isFinite(geometry.x) && Number.isFinite(geometry.y);
}

function intersects(
  first: { x: number; y: number; width: number; height: number },
  second: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    first.x < second.x + second.width
    && first.x + first.width > second.x
    && first.y < second.y + second.height
    && first.y + first.height > second.y
  );
}

async function isGeometryOnAnyMonitor(geometry: MainWindowGeometry): Promise<boolean> {
  if (!hasSavedPosition(geometry)) return false;

  const monitors = await availableMonitors();
  return monitors.some((monitor) => intersects(
    {
      x: geometry.x,
      y: geometry.y,
      width: geometry.width,
      height: geometry.height,
    },
    {
      x: monitor.position.x,
      y: monitor.position.y,
      width: monitor.size.width,
      height: monitor.size.height,
    },
  ));
}

async function saveCurrentMainWindowGeometry(): Promise<void> {
  const win = getCurrentWindow();
  // Inner size, because that is what `setSize` restores. Saving the outer size grew the
  // window by the height of the OS frame on every launch with native decorations on.
  const [position, size, isMaximized, isFullscreen] = await Promise.all([
    win.outerPosition(),
    win.innerSize(),
    win.isMaximized(),
    win.isFullscreen(),
  ]);

  if (isMaximized || isFullscreen) return;

  if (!readMainWindowGeometryPersistenceEnabled()) return;

  writeLocalJsonSetting(STORAGE_KEY, {
    x: position.x,
    y: position.y,
    width: Math.max(MIN_WIDTH, size.width),
    height: Math.max(MIN_HEIGHT, size.height),
  });
}

function clearSavedMainWindowGeometry(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Durable app settings are cleared below.
  }

  void removeAppSetting(STORAGE_KEY);
}

export async function hydrateMainWindowGeometry(): Promise<void> {
  await Promise.all([
    hydrateLocalJsonSetting(STORAGE_KEY, isMainWindowGeometry),
    hydrateLocalBooleanSetting(
      GEOMETRY_ENABLED_STORAGE_KEY,
      false,
      GEOMETRY_ENABLED_CHANGE_EVENT,
    ),
  ]);

  if (
    !readLocalBooleanSetting(GEOMETRY_ENABLED_STORAGE_KEY, false)
    && readLocalBooleanSetting(LEGACY_LOCATION_ENABLED_STORAGE_KEY, false)
  ) {
    setMainWindowGeometryPersistenceEnabled(true);
  }
}

export async function restoreMainWindowGeometry(): Promise<void> {
  if (!readMainWindowGeometryPersistenceEnabled()) return;

  const geometry = readLocalJsonSetting(STORAGE_KEY, isMainWindowGeometry);
  if (!geometry || !hasSavedPosition(geometry) || !await isGeometryOnAnyMonitor(geometry)) return;

  const win = getCurrentWindow();
  await win.setSize(new PhysicalSize(geometry.width, geometry.height));
  await win.setPosition(new PhysicalPosition(geometry.x, geometry.y));
}

export async function persistMainWindowGeometry(): Promise<() => void> {
  const win = getCurrentWindow();
  let saveTimer: number | null = null;

  const saveSoon = () => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
    }
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      void saveCurrentMainWindowGeometry().catch((error) => {
        logInternalError("mainWindowGeometry.save failed", error);
      });
    }, SAVE_DELAY_MS);
  };

  const [unlistenMoved, unlistenResized] = await Promise.all([
    win.onMoved(saveSoon),
    win.onResized(saveSoon),
  ]);

  return () => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    unlistenMoved();
    unlistenResized();
  };
}

function subscribeMainWindowGeometryPersistence(callback: () => void) {
  window.addEventListener(GEOMETRY_ENABLED_CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(GEOMETRY_ENABLED_CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

function readMainWindowGeometryPersistenceEnabled(): boolean {
  return readLocalBooleanSetting(GEOMETRY_ENABLED_STORAGE_KEY, false);
}

export function setMainWindowGeometryPersistenceEnabled(enabled: boolean): void {
  writeLocalBooleanSetting(
    GEOMETRY_ENABLED_STORAGE_KEY,
    enabled,
    GEOMETRY_ENABLED_CHANGE_EVENT,
  );
  if (!enabled) {
    clearSavedMainWindowGeometry();
    return;
  }

  void saveCurrentMainWindowGeometry().catch((error) => {
    logInternalError("mainWindowGeometry.saveGeometrySetting failed", error);
  });
}

export function useMainWindowGeometryPersistenceEnabled(): boolean {
  return useSyncExternalStore(
    subscribeMainWindowGeometryPersistence,
    readMainWindowGeometryPersistenceEnabled,
    () => false,
  );
}
