/**
 * Self-check for the post-update note. Run with the whole suite:
 *
 *   npm run check
 *
 * Two failures matter and neither is visible in testing on a machine that has already run the
 * app: greeting a brand-new user with release notes for software they have never used, and
 * showing the same note on every launch forever. Both are pinned here.
 */
export {};

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

const { RELEASE_NOTE_BODY, parseReleaseNote, shouldShowReleaseNote } =
  await import("./releaseNote");

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

check(
  !shouldShowReleaseNote("1.2.0", null, false),
  "a fresh install is not an update — nothing has changed for someone who has never run it",
);

/*
 * The case 1.2.0 got wrong. On the first release that ships this feature nobody has a stored
 * version, because nothing was writing one — so "no version" cannot mean "new user", and
 * treating it that way showed the note to zero of the people it was written for.
 */
check(
  shouldShowReleaseNote("1.2.0", null, true),
  "no stored version but evidence of prior use is an update, not a fresh install",
);
check(
  !shouldShowReleaseNote("1.2.0", "1.2.0"),
  "the same version twice shows nothing, so it cannot repeat on every launch",
);
check(
  shouldShowReleaseNote("1.2.0", "1.1.3"),
  "a newer version after an older one is the case this exists for",
);
check(
  shouldShowReleaseNote("1.1.3", "1.2.0"),
  "a downgrade also shows: it is still a version whose notes were never read",
);
check(
  shouldShowReleaseNote("1.2.0-beta.2", "1.2.0-beta.1"),
  "prerelease builds differ as plain strings, with no version parser to get wrong",
);
check(
  !shouldShowReleaseNote("", "1.1.3"),
  "no installed version means no note, rather than a note with nothing to say",
);
check(!shouldShowReleaseNote("", null), "and neither half being known is still nothing");

check(RELEASE_NOTE_BODY.trim().length > 0, "the note has content");
check(
  !RELEASE_NOTE_BODY.includes("TODO"),
  "the note is not a placeholder left over from the previous release",
);

/* Linkifying: the body is plain text, so the parse is the only thing between a written
   mention and a working link — and a silent failure just renders it as prose. */

const plain = parseReleaseNote("nothing to see here");
equal(plain.length, 1, "text with no links is one segment");
equal(plain[0].kind, "text", "and it is text");

const sub = parseReleaseNote("Come say hello at /r/myzuno, and enjoy");
equal(sub.length, 3, "a subreddit splits the sentence in three");
equal(sub[1].kind, "link", "the middle piece is the link");
equal(sub[1].kind === "link" ? sub[1].url : "", "https://www.reddit.com/r/myzuno", "resolved to reddit");
equal(sub[2].kind === "text" ? sub[2].value : "", ", and enjoy", "the comma stays outside the link");

const url = parseReleaseNote("see https://example.com/x for more");
equal(url[1].kind === "link" ? url[1].url : "", "https://example.com/x", "a bare URL links to itself");

const both = parseReleaseNote("/r/one and /r/two");
equal(both.filter((s) => s.kind === "link").length, 2, "every mention links, not just the first");

equal(parseReleaseNote("")[0], undefined, "an empty body yields no segments");
equal(
  parseReleaseNote("/r/myzuno").length,
  1,
  "a body that is nothing but a link has no empty text around it",
);

/* Rejoining every segment must reproduce the original exactly, or the note silently loses text.
   `**` is the one thing deliberately consumed, so it is put back before comparing — everything
   else, prose and links alike, has to survive verbatim. */
const roundTrip = parseReleaseNote(RELEASE_NOTE_BODY)
  .map((s) => (s.kind === "strong" ? `**${s.value}**` : s.value))
  .join("");
equal(roundTrip, RELEASE_NOTE_BODY, "parsing never drops or duplicates a character");

check(
  parseReleaseNote(RELEASE_NOTE_BODY).some((s) => s.kind === "link"),
  "this release's note actually contains a link",
);

/* Emphasis. Added for the 1.3.0 note, which leads with a bulleted list of feature names — a
   `**` that silently rendered as literal asterisks would be visible to every user on update. */
const bold = parseReleaseNote("Try **Gapless** today");
equal(bold.length, 3, "emphasis splits the line in three");
equal(bold[1].kind, "strong", "the middle piece is emphasised");
equal(bold[1].kind === "strong" ? bold[1].value : "", "Gapless", "and the markers are stripped");

const mixed = parseReleaseNote("**Equaliser** — see /r/myzuno");
equal(mixed.filter((s) => s.kind === "strong").length, 1, "emphasis and links coexist");
equal(mixed.filter((s) => s.kind === "link").length, 1, "the link still resolves alongside it");

check(
  parseReleaseNote(RELEASE_NOTE_BODY).some((s) => s.kind === "strong"),
  "this release's note actually uses emphasis",
);

// Unpaired markers are prose, not broken markup: the note is hand-written per release.
equal(parseReleaseNote("2 ** 3 is eight").length, 1, "a lone marker stays text");

console.log("releaseNote self-check passed");
