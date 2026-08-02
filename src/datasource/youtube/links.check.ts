/**
 * Self-check for the YouTube link parser. No test runner in this project, so:
 *
 *   npx esbuild src/datasource/youtube/links.check.ts --bundle --platform=node --format=esm
 *     --outfile=check.mjs && node check.mjs
 *
 * The dangerous cases are the two that look alike: a watch link that also carries `list=`
 * (opening the playlist instead of the song the user clicked), and an `OLAK5uy_` playlist
 * (which is an album release and looks wrong opened as a playlist). Both are silent — the app
 * opens *something*, just not the thing that was pasted.
 */
export {};

import { isVideoId, looksLikeYouTubeLink, parseYouTubeLink } from "./links";
import type { ResolvedLink } from "../types";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function resolvesTo(input: string, expected: ResolvedLink, message: string): void {
  const actual = parseYouTubeLink(input);
  check(
    actual?.kind === expected.kind && actual?.id === expected.id,
    `${message}: expected ${expected.kind}/${expected.id}, got ${
      actual ? `${actual.kind}/${actual.id}` : "null"
    }`,
  );
}

function resolvesToNothing(input: string, message: string): void {
  const actual = parseYouTubeLink(input);
  check(actual === null, `${message}: expected null, got ${actual ? actual.kind : "null"}`);
}

// Watch links, in the shapes YouTube actually serves them.
resolvesTo(
  "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
  { kind: "track", id: "dQw4w9WgXcQ" },
  "music watch link",
);
resolvesTo(
  "https://youtu.be/dQw4w9WgXcQ?si=abc",
  { kind: "track", id: "dQw4w9WgXcQ" },
  "short link with a share parameter",
);
resolvesTo(
  "https://www.youtube.com/shorts/dQw4w9WgXcQ",
  { kind: "track", id: "dQw4w9WgXcQ" },
  "shorts link",
);
resolvesTo(
  "music.youtube.com/watch?v=dQw4w9WgXcQ",
  { kind: "track", id: "dQw4w9WgXcQ" },
  "pasted link without a scheme",
);

// A watch link inside a playlist is still a request for the video.
resolvesTo(
  "https://music.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc123",
  { kind: "track", id: "dQw4w9WgXcQ" },
  "watch link carrying a list parameter",
);

// Collections.
resolvesTo(
  "https://music.youtube.com/playlist?list=PLabc123",
  { kind: "playlist", id: "PLabc123" },
  "playlist link",
);
resolvesTo(
  "https://music.youtube.com/browse/VLPLabc123",
  { kind: "playlist", id: "PLabc123" },
  "browse ids carry a VL prefix the playlist view does not want",
);
resolvesTo(
  "https://music.youtube.com/browse/MPREb_abc123",
  { kind: "album", id: "MPREb_abc123" },
  "album browse id",
);
resolvesTo(
  "https://music.youtube.com/playlist?list=OLAK5uy_abc",
  { kind: "album", id: "OLAK5uy_abc" },
  "an OLAK5uy_ playlist is an album release and opens as one",
);

// Artists.
resolvesTo(
  "https://music.youtube.com/channel/UCabcdefghijklmnopqrstu",
  { kind: "artist", id: "UCabcdefghijklmnopqrstu" },
  "channel link",
);

// Things that must not resolve locally.
resolvesToNothing("https://example.com/watch?v=dQw4w9WgXcQ", "a non-YouTube host");
resolvesToNothing("https://www.youtube.com/@someartist", "a handle needs the API");
resolvesToNothing("not a url at all", "free text");
resolvesToNothing("", "empty input");
resolvesToNothing(
  "https://music.youtube.com/watch?v=tooshort",
  "an 11-character id is the only thing accepted as a video id",
);

// The search-versus-open decision.
check(looksLikeYouTubeLink("https://youtu.be/dQw4w9WgXcQ"), "a short link is a link");
check(
  looksLikeYouTubeLink("music.youtube.com/watch?v=dQw4w9WgXcQ"),
  "a scheme-less link is still a link",
);
check(
  !looksLikeYouTubeLink("best youtube.com/ playlists"),
  "text that merely mentions youtube is a search, not a link",
);
check(!looksLikeYouTubeLink("metro boomin"), "an ordinary query is a search");

/*
 * What may be treated as something that plays.
 *
 * The case that made this necessary: an artist page's popular-songs shelf mixes in podcast
 * shows, whose id is a browse id rather than a video id. They were turned into tracks, and
 * clicking one walked all three Innertube clients only to be told "This video is unavailable"
 * by each — the id had never named a video.
 */
check(isVideoId("dQw4w9WgXcQ"), "an ordinary video id");
check(isVideoId("_lMlsPQJs6U"), "leading underscore is in the alphabet");
check(isVideoId("SOySR3DJO5Q"), "mixed case is in the alphabet");
check(
  !isVideoId("MPSPPLDfKAXSi6kUZChoCmv-rvfdEEfgZTFBzS"),
  "a show's browse id is not a video id",
);
check(!isVideoId("MPREb_9nY3XYZ1234"), "an album browse id is not a video id");
check(!isVideoId("PLDfKAXSi6kUZChoCmv"), "a playlist id is not a video id");
check(!isVideoId("tooshort"), "ten characters is not eleven");
check(!isVideoId("dQw4w9WgXcQ!"), "a character outside the alphabet disqualifies it");
check(!isVideoId(""), "empty is not an id");
check(!isVideoId(undefined), "absent is not an id");

console.log("links.check.ts OK");
