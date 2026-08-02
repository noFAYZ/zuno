import type { AudioEngineMode } from "../ui/settings/audioEngine";

/**
 * The only two things about a track that decide whether it may be preloaded.
 *
 * Both mean "these bytes are already on this machine", which is what the IFrame deck cannot
 * honour and the Rust deck can.
 */
export type PreloadSubject = {
  /** A file the user pointed a music folder at. */
  isLocal: boolean;
  /** A YouTube track whose bytes are in the offline store. */
  isDownloaded: boolean;
};

/**
 * Whether a track can be loaded onto a standby deck ahead of its turn.
 *
 * This is what gapless and crossfade ride on: with the next track already sitting decoded, a
 * handover is a volume ramp between two live decks rather than a stop followed by a load.
 *
 * Which engines have a deck at all:
 *
 * - `iframe` has two, but they resolve their own stream from a video id. Handing one a track
 *   the user downloaded on purpose would play the *online* copy instead, over the network,
 *   which is why anything read from disk is excluded there.
 * - `rust` has two, and they open whatever they are given — a signed URL, a file in the offline
 *   store, a path on disk. Nothing is excluded, and a downloaded album is exactly where gapless
 *   is wanted most.
 * - `native` has no standby deck at all: one `<audio>` element, one body. Gapless and crossfade
 *   have always silently done nothing there.
 */
export function hasPreloadDeck(engine: AudioEngineMode, track: PreloadSubject): boolean {
  switch (engine) {
    case "rust":
      return true;
    case "iframe":
      return !track.isLocal && !track.isDownloaded;
    default:
      return false;
  }
}
