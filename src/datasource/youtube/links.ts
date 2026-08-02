import type { ResolvedLink } from "../types";

/**
 * Reads a YouTube or YouTube Music link without touching the network.
 *
 * Almost every link a user pastes already names its target in the URL, so resolving it through
 * Innertube would be a round-trip to learn something the string already says. This handles those
 * locally and returns null for the rest — vanity channel URLs, `@handles` and `youtu.be`-style
 * redirects — which the caller then resolves through the API.
 *
 * Ordering matters: a watch URL can carry both `v` and `list`, and the video is what the user
 * clicked, so `v` wins. Album links are the exception — `OLAK5uy_` playlists *are* albums and
 * open far better as one.
 */
export function parseYouTubeLink(input: string): ResolvedLink | null {
  const url = toUrl(input);
  if (!url) return null;
  if (!isYouTubeHost(url.hostname)) return null;

  const path = url.pathname.replace(/\/+$/, "");
  const videoId = url.searchParams.get("v");
  const listId = url.searchParams.get("list");

  // youtu.be/<id> puts the video id in the path and nothing else.
  if (url.hostname.endsWith("youtu.be")) {
    const shortId = path.slice(1);
    return isVideoId(shortId) ? { kind: "track", id: shortId } : null;
  }

  if (videoId && isVideoId(videoId)) return { kind: "track", id: videoId };

  const embedded = /^\/(?:embed|shorts|live|v)\/([^/?#]+)/.exec(path)?.[1];
  if (embedded && isVideoId(embedded)) return { kind: "track", id: embedded };

  if (listId) return playlistOrAlbum(listId);

  // music.youtube.com/playlist and /browse/<id> both address collections by browse id.
  const browseId = /^\/browse\/([^/?#]+)/.exec(path)?.[1];
  if (browseId) {
    if (browseId.startsWith("MPRE")) return { kind: "album", id: browseId };
    if (browseId.startsWith("UC")) return { kind: "artist", id: browseId };
    if (browseId.startsWith("VL")) return playlistOrAlbum(browseId.slice(2));
    return null;
  }

  const channelId = /^\/channel\/([^/?#]+)/.exec(path)?.[1];
  if (channelId?.startsWith("UC")) return { kind: "artist", id: channelId };

  return null;
}

/**
 * An `OLAK5uy_` playlist is the auto-generated one behind an album release. Opening it as a
 * playlist works but loses the album header, the year and the artist link, so it is classified
 * as an album and let the album view resolve it.
 */
function playlistOrAlbum(listId: string): ResolvedLink {
  if (listId.startsWith("OLAK5uy_")) return { kind: "album", id: listId };
  return { kind: "playlist", id: listId };
}

function toUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    // Bare "music.youtube.com/..." is a normal thing to paste and is not a valid URL without
    // a scheme, so one is assumed rather than rejecting the input.
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
}

function isYouTubeHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return host === "youtube.com"
    || host === "music.youtube.com"
    || host === "m.youtube.com"
    || host === "youtu.be";
}

/**
 * Video ids are 11 characters of the URL-safe base64 alphabet.
 *
 * Exported because it is also what decides whether a shelf row may become a *track*. An artist
 * page mixes songs with shows, and a show's `id` is a browse id — `MPSP` wrapped around a `PL…`
 * playlist id, 34 characters. Those were turned into tracks, and every Innertube client answered
 * "This video is unavailable" when one was clicked, because the id had never named a video.
 *
 * Widened to accept a missing value so callers do not each repeat the same null check.
 */
export function isVideoId(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[\w-]{11}$/.test(value);
}

/**
 * Whether a string is worth trying to resolve at all.
 *
 * Used to decide between "open this link" and "search for this text", so it errs toward false:
 * a query that merely mentions youtube should still be searched.
 */
export function looksLikeYouTubeLink(input: string): boolean {
  const trimmed = input.trim();
  if (/\s/.test(trimmed)) return false;
  return /(^|\/\/|\.)(youtube\.com|youtu\.be)\//i.test(trimmed);
}
