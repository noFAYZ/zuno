import { invoke } from "@tauri-apps/api/core";
import type { Playlist, Track } from "../datasource/types";
import { logInternalInfo } from "../internal/logging";

/** Bumped only on a breaking shape change; import accepts anything it still understands. */
const FORMAT_VERSION = 1;

interface ExportedTrack {
  id: string;
  title: string;
  artist: string;
  album?: string;
  durationSec?: number;
  /** Present for local files, so a re-import on the same machine keeps working. */
  localPath?: string;
}

interface ExportedPlaylist {
  format: "zuno-playlist";
  version: number;
  title: string;
  owner?: string;
  exportedAt: string;
  tracks: ExportedTrack[];
}

function sanitizeFileName(name: string): string {
  /*
   * Replaces only what a filesystem actually rejects.
   *
   * The class is written out member by member on purpose. The obvious `[<>:"/\\|?* -]` reads
   * as "...asterisk, space, dash", but a regex parses `* -` as the *range* 0x2A-0x2D: it
   * quietly matched `+` and `,` and never matched a space at all. Accidental ranges inside a
   * character class are easy to write and invisible once written.
   *
   * Spaces are legal in filenames and kept, since mangling them only makes the suggested name
   * harder to recognise. Trailing dots and spaces go because Windows drops them silently,
   * which would mean the file saved under a different name than the one shown.
   */
  return name
    .replace(/[<>:"?*|\\/\\\\]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    || "playlist";
}

/**
 * Writes a playlist to disk as JSON, or as M3U when that extension is chosen.
 *
 * JSON is the lossless option and the one that round-trips back into Zuno, because it keeps
 * the YouTube video ids. M3U is offered because everything else on the machine can read it,
 * but it only carries file paths — so it is useful for local playlists and near-useless for
 * YouTube ones, which is why the caller is told what was actually written.
 */
export async function exportPlaylist(
  playlist: Playlist,
  tracks: Track[],
): Promise<{ path: string; format: "json" | "m3u"; written: number } | null> {
  // A YouTube track has no path an external player could open, so M3U skips it.
  const m3uTracks = tracks.filter((track) => track.localPath);
  const m3u = ["#EXTM3U", ...m3uTracks.flatMap((track) => [
    `#EXTINF:${Math.round(track.durationSec ?? -1)},${track.artist} - ${track.title}`,
    track.localPath as string,
  ])].join("\n");
  const payload: ExportedPlaylist = {
    format: "zuno-playlist",
    version: FORMAT_VERSION,
    title: playlist.title,
    owner: playlist.owner,
    exportedAt: new Date().toISOString(),
    tracks: tracks.map((track) => ({
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationSec: track.durationSec,
      localPath: track.localPath,
    })),
  };

  // Rust shows the dialog and writes the file, so no path ever travels from the webview.
  const saved = await invoke<{ path: string; format: number } | null>("export_text_file", {
    title: `Export ${playlist.title}`,
    fileName: `${sanitizeFileName(playlist.title)}.zuno.json`,
    formats: [
      { name: "Zuno playlist", extensions: ["json"], contents: JSON.stringify(payload, null, 2) },
      { name: "M3U playlist", extensions: ["m3u", "m3u8"], contents: `${m3u}\n` },
    ],
  });
  if (!saved) return null;
  const result = saved.format === 1
    ? { path: saved.path, format: "m3u" as const, written: m3uTracks.length }
    : { path: saved.path, format: "json" as const, written: tracks.length };
  logInternalInfo("playlistTransfer.export", { format: result.format, written: result.written, total: tracks.length });
  return result;
}

export interface ImportedPlaylist {
  title: string;
  tracks: Track[];
}

function parseZunoJson(contents: string): ImportedPlaylist | null {
  const parsed: unknown = JSON.parse(contents);
  if (!parsed || typeof parsed !== "object") return null;

  const candidate = parsed as Partial<ExportedPlaylist>;
  if (candidate.format !== "zuno-playlist" || !Array.isArray(candidate.tracks)) return null;

  const tracks: Track[] = candidate.tracks
    .filter((entry): entry is ExportedTrack => Boolean(entry?.id))
    .map((entry) => ({
      id: entry.id,
      source: entry.localPath ? "local" : "youtube",
      title: entry.title || entry.id,
      artist: entry.artist || "",
      album: entry.album,
      durationSec: entry.durationSec,
      localPath: entry.localPath,
    }) as Track);

  return { title: candidate.title?.trim() || "Imported playlist", tracks };
}

function parseM3u(contents: string, fallbackTitle: string): ImportedPlaylist {
  const tracks: Track[] = [];
  let pendingTitle: string | undefined;
  let pendingArtist: string | undefined;
  let pendingDuration: number | undefined;

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF:")) {
      // "#EXTINF:<seconds>,<artist> - <title>"
      const [durationPart, ...rest] = line.slice("#EXTINF:".length).split(",");
      const seconds = Number(durationPart);
      pendingDuration = Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
      const label = rest.join(",").trim();
      const dash = label.indexOf(" - ");
      if (dash > 0) {
        pendingArtist = label.slice(0, dash).trim();
        pendingTitle = label.slice(dash + 3).trim();
      } else {
        pendingTitle = label || undefined;
      }
      continue;
    }
    if (line.startsWith("#")) continue;

    tracks.push({
      // M3U carries no ids, so the path is the identity — which is exactly what local
      // playback already uses.
      id: `local:${line}`,
      source: "local",
      title: pendingTitle ?? line.split(/[\\/]/).pop() ?? line,
      artist: pendingArtist ?? "Local files",
      durationSec: pendingDuration,
      localPath: line,
    } as Track);
    pendingTitle = undefined;
    pendingArtist = undefined;
    pendingDuration = undefined;
  }

  return { title: fallbackTitle, tracks };
}

/** Reads a playlist file chosen by the user. Returns null when the dialog is dismissed. */
export async function importPlaylistFile(): Promise<ImportedPlaylist | null> {
  const opened = await invoke<{ path: string; contents: string } | null>("import_text_file", {
    title: "Import playlist",
    filterName: "Playlists",
    extensions: ["json", "m3u", "m3u8"],
  });
  if (!opened) return null;
  const { path, contents } = opened;
  const fileName = path.split(/[\\/]/).pop() ?? "Imported playlist";
  const baseTitle = fileName.replace(/\.(zuno\.)?(json|m3u8?)$/i, "");

  if (/\.m3u8?$/i.test(path)) {
    return parseM3u(contents, baseTitle);
  }

  try {
    const parsed = parseZunoJson(contents);
    if (!parsed) throw new Error("unrecognised");
    return parsed;
  } catch {
    throw new Error("That file is not a Zuno playlist export.");
  }
}

/**
 * Pure parsing internals, exposed for the self-check.
 *
 * Kept behind one deliberately awkward name so it reads as a test seam rather than as API —
 * the dialog and file I/O around these are Tauri calls that cannot run under node.
 */
export const __parseForTest = { parseZunoJson, parseM3u, sanitizeFileName };
