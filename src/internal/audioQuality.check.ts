/**
 * Self-check for quality-based format selection. No test runner in this project, so:
 *
 *   npx esbuild src/internal/audioQuality.check.ts --bundle --platform=node --format=esm
 *     --outfile=check.mjs && node check.mjs
 *
 * The branch worth pinning is the fallback: YouTube does not always offer a low tier, and
 * "no format at or below the cap" must degrade to the cheapest one rather than to nothing.
 */
export {};

import { selectFormatForQuality } from "./audioQuality";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const full = [
  { bitrate: 49_000 },
  { bitrate: 131_000 },
  { bitrate: 261_000 },
];

// High takes the best on offer regardless of any target.
equal(selectFormatForQuality(full, "high")?.bitrate, 261_000, "high picks the top bitrate");

// Normal and low snap to the tier nearest their target, not strictly below it.
equal(selectFormatForQuality(full, "normal")?.bitrate, 131_000, "normal snaps to the ~128k tier");
equal(selectFormatForQuality(full, "low")?.bitrate, 49_000, "low snaps to the ~64k tier");

// Nothing near the cap: the closest is the cheapest, so no special fallback is needed.
const expensiveOnly = [{ bitrate: 256_000 }, { bitrate: 320_000 }];
equal(
  selectFormatForQuality(expensiveOnly, "low")?.bitrate,
  256_000,
  "low picks the closest when every option exceeds the target",
);

// Unordered input must not change the answer.
const shuffled = [{ bitrate: 261_000 }, { bitrate: 49_000 }, { bitrate: 131_000 }];
equal(selectFormatForQuality(shuffled, "normal")?.bitrate, 131_000, "input order is irrelevant");

// Missing bitrates count as zero rather than throwing.
equal(
  selectFormatForQuality([{ bitrate: undefined }, { bitrate: 96_000 }], "high")?.bitrate,
  96_000,
  "a missing bitrate never outranks a real one",
);

equal(selectFormatForQuality([], "high"), undefined, "no formats yields undefined");

console.log("audioQuality: ok");
