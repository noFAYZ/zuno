/**
 * Self-check for playlist import parsing. No test runner in this project, so:
 *
 *   npx esbuild src/player/playlistTransfer.check.ts --bundle --platform=node --format=esm
 *     --outfile=check.mjs && node check.mjs
 *
 * Parsing is where an import quietly loses songs, and a backup that drops rows without
 * saying so is worse than no backup. The dialog and file I/O are not exercised here — those
 * are Tauri calls; this covers the pure text handling they wrap.
 */
export {};

import { __parseForTest } from "./playlistTransfer";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const { parseZunoJson, parseM3u, sanitizeFileName } = __parseForTest;

// --- Zuno JSON round trip -------------------------------------------------
const exported = JSON.stringify({
  format: "zuno-playlist",
  version: 1,
  title: "Late night",
  tracks: [
    { id: "abc123", title: "One", artist: "A", album: "X", durationSec: 210 },
    { id: "def456", title: "Two", artist: "B" },
  ],
});

const parsed = parseZunoJson(exported);
check(parsed !== null, "a valid export parses");
equal(parsed?.title, "Late night", "title survives the round trip");
equal(parsed?.tracks.length, 2, "every track survives");
equal(parsed?.tracks[0].id, "abc123", "the video id is what makes a re-import work");
equal(parsed?.tracks[0].source, "youtube", "no local path means a remote track");

// Entries without an id cannot be played, so they are dropped rather than half-imported.
const withJunk = JSON.stringify({
  format: "zuno-playlist",
  version: 1,
  title: "T",
  tracks: [{ title: "no id" }, { id: "ok", title: "Fine", artist: "C" }],
});
equal(parseZunoJson(withJunk)?.tracks.length, 1, "entries without an id are dropped");

// Anything not written by Zuno is refused rather than silently producing an empty playlist.
equal(parseZunoJson(JSON.stringify({ format: "spotify", tracks: [] })), null, "foreign formats refused");
equal(parseZunoJson(JSON.stringify({ format: "zuno-playlist" })), null, "missing tracks refused");

// --- M3U ------------------------------------------------------------------
const m3u = [
  "#EXTM3U",
  "#EXTINF:184,Boards of Canada - Roygbiv",
  "C:\\Music\\roygbiv.mp3",
  "# a stray comment",
  "#EXTINF:-1,Untitled",
  "/home/me/other.flac",
  "D:\\Music\\no-extinf.mp3",
].join("\n");

const fromM3u = parseM3u(m3u, "My mix");
equal(fromM3u.title, "My mix", "the filename supplies the title");
equal(fromM3u.tracks.length, 3, "every path becomes a track");
equal(fromM3u.tracks[0].artist, "Boards of Canada", "artist is split off the EXTINF label");
equal(fromM3u.tracks[0].title, "Roygbiv", "title is split off the EXTINF label");
equal(fromM3u.tracks[0].durationSec, 184, "duration is read");
equal(fromM3u.tracks[1].durationSec, undefined, "a -1 duration means unknown, not -1");
equal(fromM3u.tracks[2].title, "no-extinf.mp3", "a path with no EXTINF falls back to its filename");
equal(fromM3u.tracks[2].localPath, "D:\\Music\\no-extinf.mp3", "the path is preserved verbatim");

// --- Filenames ------------------------------------------------------------
// One dash per illegal character, spaces untouched. "AC-DC- Live" is slightly awkward but it
// is a valid, recognisable name — and it is only the *suggested* default in a save dialog the
// user can edit, so cleverer collapsing would risk mangling legitimate titles like "Rock - Live".
equal(sanitizeFileName("AC/DC: Live"), "AC-DC- Live", "illegal characters go, spaces stay");
equal(sanitizeFileName("a<b>c|d?e*f"), "a-b-c-d-e-f", "every reserved character is replaced");
equal(sanitizeFileName("Mix..."), "Mix", "trailing dots go, since Windows drops them silently");
equal(sanitizeFileName("   "), "playlist", "an unusable name falls back rather than erroring");

console.log("playlistTransfer: ok");
