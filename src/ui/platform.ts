export const isMacOS =
  typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent);

/**
 * The Android build of the app (Tauri mobile, running in the system WebView).
 *
 * Checked before anything else because an Android user agent also says "Linux" — every
 * `isLinux` test below has to exclude it, or the phone would be treated as a desktop with a
 * tiling window manager and an MPRIS bus.
 */
export const isAndroid =
  typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

/** True where there is no desktop window to manage: no title bar, tray, second window or updater. */
export const isMobile = isAndroid;

export const isLinux =
  typeof navigator !== "undefined" && /Linux/.test(navigator.userAgent) && !isAndroid;

export const isWindows =
  typeof navigator !== "undefined" && /Windows NT/.test(navigator.userAgent);

/**
 * Compositors that tile windows and handle close/minimize/maximize themselves, so an
 * app-drawn set of window buttons would be dead weight. Detected from `XDG_CURRENT_DESKTOP`.
 */
const TILING_WINDOW_MANAGERS = new Set([
  "niri", "sway", "hyprland", "i3", "river", "bspwm", "dwm", "qtile",
  "xmonad", "awesome", "herbstluftwm", "dwl", "leftwm", "spectrwm",
]);

let tilingWindowManager = false;
let tilingSubscribers: Array<() => void> = [];

export function isTilingWindowManager(): boolean {
  return tilingWindowManager;
}

export function subscribeTilingWindowManager(callback: () => void): () => void {
  tilingSubscribers.push(callback);
  return () => {
    tilingSubscribers = tilingSubscribers.filter((entry) => entry !== callback);
  };
}

export async function detectTilingWindowManager(): Promise<void> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const desktop = await invoke<string>("desktop_environment");
    tilingWindowManager = TILING_WINDOW_MANAGERS.has(desktop.trim().toLowerCase());
  } catch {
    // Non-Tauri (plain browser) or a runtime without the command: fall back to showing buttons.
    tilingWindowManager = false;
  }
  document.documentElement.toggleAttribute("data-tiling-wm", tilingWindowManager);
  for (const callback of tilingSubscribers) callback();
}

export const primaryModifierLabel = isMacOS ? "⌘" : "Ctrl";

export function applyPlatformAttributes() {
  document.documentElement.toggleAttribute("data-platform-linux", isLinux);
  document.documentElement.toggleAttribute("data-platform-android", isAndroid);
  document.documentElement.toggleAttribute("data-mobile", isMobile);
}

export function hasPrimaryModifierOnly(event: KeyboardEvent): boolean {
  return isMacOS
    ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    : event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}
