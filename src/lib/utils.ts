import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

function pad(num: number) {
  return String(num).padStart(2, "0");
} 

/**
 * Formats a whole-second duration as `hh:mm:ss` or just `mm:ss`,
 * depending on the real duration (if greater or less than 1 hour).
 * Callers round `seconds` themselves (floor for elapsed
 * position, ceil for a countdown) — this only formats what it's given.
 */
export function formatMinutesSeconds(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds)) return "0:00";

  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  if (hours > 0) {
    return `${pad(hours)}:${pad(mins)}:${pad(seconds)}`;
  }
  return `${pad(mins)}:${pad(seconds)}`;
}
