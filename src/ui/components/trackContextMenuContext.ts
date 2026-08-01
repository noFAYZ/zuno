import { createContext, useContext, type MouseEvent as ReactMouseEvent } from "react";
import type { Playlist, Track, TrackRating } from "../../datasource/types";

/**
 * The track context menu's context object, deliberately alone in its own module.
 *
 * `createContext()` produces a new, unequal object every time the module holding it is
 * evaluated. Living in `TrackContextMenu.tsx` — a 700-line component that imports the loader,
 * the icons and the player store — it was re-created by Vite on any edit to *any* of those,
 * while `App.tsx` kept rendering the provider from the previous copy. Consumers then read the
 * new context, found no provider, and threw "must be used within TrackContextMenuProvider"
 * on a tree that unambiguously had one.
 *
 * This module imports only React and types, so nothing the app does day to day invalidates
 * it and the identity survives every hot update. It is a dev-only failure — a production
 * build evaluates each module once — but it is the kind that costs half an hour before
 * anyone thinks to blame the bundler.
 */
export interface TrackContextMenuValue {
  openTrackMenu: (
    event: ReactMouseEvent,
    track: Track,
    context?: {
      playlist?: Playlist;
      onRemove?: (track: Track) => void;
    },
  ) => void;
  /** Pass `batch` to add several tracks at once; `track` is what the header shows. */
  openPlaylistPicker: (track: Track, batch?: Track[]) => void;
  toggleTrackLike: (track: Track) => Promise<void>;
  /** Three-valued rating. toggleTrackLike is the like-only shorthand over the same path. */
  rateTrack: (track: Track, rating: TrackRating) => Promise<void>;
  /**
   * Opens the album a track belongs to, resolving it by name first.
   *
   * Shared by the context menu item and the album link in `TrackRow`, so the two cannot end up
   * doing different things. Null when the host has not supplied a handler, which is what lets
   * both surfaces hide the affordance rather than offer a dead one.
   */
  openAlbumForTrack: ((track: Track) => void) | null;
}

export const TrackContextMenuContext = createContext<TrackContextMenuValue | null>(null);

export function useTrackContextMenu(): TrackContextMenuValue {
  const value = useContext(TrackContextMenuContext);
  if (!value) {
    throw new Error("useTrackContextMenu must be used within TrackContextMenuProvider.");
  }
  return value;
}
