import { useSyncExternalStore } from "react";

/**
 * True on a phone held upright: narrower than Tailwind's `md` breakpoint (768px).
 *
 * The desktop shell — a title bar with tabs and window controls, a library rail, a three-column
 * player bar, a 340px queue panel — has no room to be itself in that width, so the app swaps
 * it for a bottom nav, a one-row player bar and a full-screen queue. Kept as a media query
 * rather than a user-agent check so a phone turned sideways (wider than this) gets the desktop
 * layout back, and so a narrowed desktop window behaves the same way.
 */
const QUERY = "(max-width: 767px)";

function subscribe(callback: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(QUERY);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

function read() {
  return typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia(QUERY).matches
    : false;
}

export function useCompactViewport(): boolean {
  return useSyncExternalStore(subscribe, read, () => false);
}
