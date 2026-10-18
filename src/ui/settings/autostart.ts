import {
  disable,
  enable,
  isEnabled,
} from "@tauri-apps/plugin-autostart";
import { isAndroid } from "../platform";

export function getAutostartEnabled() {
  if (isAndroid) return Promise.resolve(false);
  return isEnabled();
}

export async function setAutostartEnabled(enabled: boolean) {
  if (isAndroid) return;
  if (enabled) {
    await enable();
  } else {
    await disable();
  }
}
