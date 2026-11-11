/**
 * Self-check for `isEmbedRestrictedPlaybackError`, the switch that decides whether an IFrame
 * playback failure is the one kind worth retrying on native audio (owner disabled embedding)
 * versus every other kind (network hiccup, removed video, ...) where retrying elsewhere would
 * just fail the same way. Run via `npm run check`.
 */
export {};

import { isEmbedRestrictedPlaybackError } from "./AudioEngine";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

check(
  isEmbedRestrictedPlaybackError(new Error("YouTube player error 150")),
  "150 is the owner-disabled-embedding code",
);
check(
  isEmbedRestrictedPlaybackError(new Error("YouTube player error 101")),
  "101 is 150's alias",
);
check(
  !isEmbedRestrictedPlaybackError(new Error("YouTube player error 100")),
  "100 (video removed/private) is not embed-restriction and should not be retried",
);
check(
  !isEmbedRestrictedPlaybackError(new Error("YouTube player error 2")),
  "2 (invalid parameter) is not embed-restriction",
);
check(
  !isEmbedRestrictedPlaybackError(new Error("Some other failure")),
  "unrelated error messages don't match",
);
check(!isEmbedRestrictedPlaybackError("YouTube player error 150"), "non-Error values don't match");
check(!isEmbedRestrictedPlaybackError(null), "null doesn't throw or match");

console.log("AudioEngine.check.ts passed");
