import {
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import { CloseIcon, LyricsIcon, RefreshIcon } from "@/ui/icons";
import type { Lyrics, LyricsSourceAttempt, LyricsSourceStatus } from "../../datasource/types";
import { LYRICS_SOURCES } from "../../datasource/youtube/lyricsSources";
import { FloatingPanel } from "../components/FloatingPanel";
import { logInternalWarn } from "../../internal/logging";
import { playerController, shallowEqual, usePlayerSelector } from "../../player/playerStore";
import { ArtistLinks } from "../components/ArtistLinks";
import { TrackArtwork } from "../components/TrackArtwork";
import { setAmbientArtwork } from "../stores/ambientArtworkStore";
import { OFFSET_STEP_SEC, setLyricsOffset, useLyricsOffset } from "../settings/lyricsOffset";
import { useLyricsFontScale } from "../settings/lyricsFontScale";
import { TRANSLATION_OFF, useLyricsTranslationLang } from "../settings/lyricsTranslation";
import { translateLines } from "../../datasource/translate";
import { findActiveLineIndex, getLineProgress, isSyncedLyrics } from "./lyricsTiming";

/** How long a manual scroll keeps the auto-follow parked. */
const AUTO_SCROLL_RESUME_MS = 4500;
/** Sampling rate while paused — see the frame loop for why it is not zero. */
const PAUSED_SAMPLE_MS = 250;

/**
 * Depth by distance from the active line: opacity, then blur.
 *
 * The blur is what makes the column read as a focal plane rather than a dimmed list, but it
 * is a GPU filter and every blurred node is its own layer — so it stops after four lines
 * either side. Past that the opacity alone is low enough that nobody can tell.
 */
const DEPTH = [
  { opacity: 1, blur: 0 },
  { opacity: 0.55, blur: 0.7 },
  { opacity: 0.36, blur: 1.5 },
  { opacity: 0.24, blur: 2.4 },
  { opacity: 0.16, blur: 3.2 },
  { opacity: 0.12, blur: 0 },
];

/*
 * Type scale, driven by the container's width so opening the queue panel reflows it rather
 * than overflowing. The Tailwind size classes on the elements are a floor, not decoration:
 * if these ever fail to resolve the lines fall back to a display size instead of to 16px.
 */
const LINE_FONT_SIZE = "clamp(1.625rem, 2.6cqi + 0.85rem, 2.875rem)";
const LINE_GAP = "clamp(0.95rem, 1.2cqi + 0.45rem, 1.9rem)";
/** Unsynced lyrics are read, not followed — smaller, with the leading a paragraph wants. */
const READING_FONT_SIZE = "clamp(1.125rem, 1cqi + 0.7rem, 1.5rem)";

const STATUS_DOT: Record<LyricsSourceStatus, string> = {
  hit: "bg-primary",
  miss: "bg-muted-foreground/40",
  timeout: "bg-destructive/60",
  error: "bg-destructive",
  skipped: "bg-muted-foreground/20",
};

const ARROW_KEYS = ["ArrowDown", "ArrowUp", "Home", "End"];

interface LyricsViewProps {
  onClose: () => void;
}

export function LyricsView({ onClose }: LyricsViewProps) {
  const playerState = usePlayerSelector(
    (player) => ({ currentTrack: player.currentTrack, status: player.status }),
    shallowEqual,
  );
  const track = playerState.currentTrack;
  const isPlaying = playerState.status === "playing";
  const reduce = useReducedMotion() ?? false;
  const offset = useLyricsOffset(track?.id);
  const fontScale = useLyricsFontScale();
  const translationLang = useLyricsTranslationLang();
  const [translations, setTranslations] = useState<string[] | null>(null);

  const [lyrics, setLyrics] = useState<Lyrics | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isFollowPaused, setIsFollowPaused] = useState(false);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<Array<HTMLElement | null>>([]);
  const resumeTimerRef = useRef<number | null>(null);

  const lines = lyrics?.lines ?? [];
  const isSynced = isSyncedLyrics(lyrics);
  const hasLines = lines.length > 0;

  /* Read inside the sampling loop below, which must not restart when these change — a new
     array identity every render would tear it down sixty times a second. */
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const durationRef = useRef(track?.durationSec);
  durationRef.current = track?.durationSec;

  /** Lines a listener can actually land on: blanks are instrumental beats, not targets. */
  const seekableIndices = useMemo(() => {
    const indices: number[] = [];
    lyrics?.lines.forEach((line, index) => {
      if (line.text.trim()) indices.push(index);
    });
    return indices;
  }, [lyrics]);

  // The same wash Layout paints for album and playlist pages, so the chrome above this view
  // stays tinted by the cover instead of ending at a hard edge.
  useEffect(() => {
    setAmbientArtwork(track?.artworkUrl ?? null);
    return () => setAmbientArtwork(null);
  }, [track?.artworkUrl]);

  useEffect(() => {
    const update = () => setIsOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLyrics(null);
    setFailed(false);
    setActiveIndex(-1);
    setFocusIndex(null);
    lineRefs.current = [];
    if (!track) return;

    setIsLoading(true);
    void playerController.getLyrics(track)
      .then((result) => {
        if (!cancelled) setLyrics(result);
      })
      .catch((error) => {
        logInternalWarn("LyricsView load failed", {
          trackId: track.id,
          error: error instanceof Error ? error.message : String(error),
        });
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [track?.id, reloadToken]);

  /*
   * Every provider is a network call, so a song opened offline has nothing to show. Retrying
   * the moment the connection returns saves the listener from noticing and pressing a button
   * about it — keyed on the transition only, so a genuinely lyric-less song is asked for
   * exactly once per reconnect rather than in a loop.
   */
  const wasOnlineRef = useRef(isOnline);
  useEffect(() => {
    const wasOnline = wasOnlineRef.current;
    wasOnlineRef.current = isOnline;
    // The offline → online edge only. On the level it would also be true on mount, firing a
    // second fetch on top of the one the effect above has already started.
    if (!isOnline || wasOnline) return;
    if (isLoading || hasLines || !track) return;
    setReloadToken((token) => token + 1);
  }, [isOnline]);

  /*
   * Own the scroll maths instead of scrollIntoView.
   *
   * This scroller is nested inside Layout's page scroll root; scrollIntoView walks up the
   * ancestor chain and moves that one too, which drags the whole page under the header.
   */
  const scrollToLine = useCallback((index: number, smooth: boolean) => {
    const scroller = scrollerRef.current;
    const line = lineRefs.current[index];
    if (!scroller || !line) return;
    scroller.scrollTo({
      top: Math.max(0, line.offsetTop - scroller.clientHeight / 2 + line.offsetHeight / 2),
      behavior: smooth ? "smooth" : "auto",
    });
  }, []);

  /* Read by the ResizeObserver below, which must not be torn down and rebuilt every time
     either value changes — it would miss the resize it exists to catch. */
  const activeIndexRef = useRef(activeIndex);
  activeIndexRef.current = activeIndex;
  const isFollowPausedRef = useRef(isFollowPaused);
  isFollowPausedRef.current = isFollowPaused;

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    /*
     * Opening the queue panel narrows this column, which re-wraps every line and invalidates
     * the offsets the last scroll was computed from — the active line drifts off centre and
     * stays there until the next line happens to come round and trigger a fresh scroll.
     *
     * Jumped, not animated: this is a correction to a layout change the user made, so it
     * should look like the text was always there, not like the page scrolled by itself.
     */
    const observer = new ResizeObserver(() => {
      if (isFollowPausedRef.current) return;
      const index = activeIndexRef.current;
      if (index >= 0) scrollToLine(index, false);
    });
    observer.observe(scroller);
    return () => observer.disconnect();
  }, [scrollToLine]);

  useEffect(() => {
    if (!isSynced) {
      setActiveIndex(-1);
      return;
    }

    let current = -1;
    const sample = () => {
      const time = playerController.getCurrentTime() + offset;
      const currentLines = linesRef.current;
      const next = findActiveLineIndex(currentLines, time);

      /* Committing every frame would re-render the whole column sixty times a second for a
         value that flips a few times a minute. Only the flip is worth a render. */
      if (next !== current) {
        current = next;
        setActiveIndex(next);
      }

      if (reduce || next < 0) return;
      /* The sweep is written straight onto the node. It changes every frame by definition,
         so routing it through state would undo the optimisation directly above. */
      const progress = getLineProgress(currentLines, next, time, durationRef.current);
      lineRefs.current[next]?.style.setProperty("--sweep", `${(progress * 100).toFixed(1)}%`);
    };

    sample();

    /*
     * Paused is not idle — the listener can still drag the scrubber, and the highlight has to
     * follow it. But a paused window has no business holding a frame loop open: this used to
     * poll at 60fps for as long as the view stayed open, which on a laptop is a core kept
     * awake to watch a number that is not changing.
     */
    if (!isPlaying) {
      const interval = window.setInterval(sample, PAUSED_SAMPLE_MS);
      return () => window.clearInterval(interval);
    }

    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      sample();
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [isSynced, isPlaying, lyrics, offset, reduce]);

  /*
   * Translation is best-effort and entirely optional: a failure leaves `translations` null
   * and the screen shows the original words, which is what it would have shown anyway. The
   * stale guard matters more than usual here — the request is slow enough that skipping two
   * tracks while it is in flight is easy, and a late reply would caption the wrong song.
   */
  useEffect(() => {
    setTranslations(null);
    if (translationLang === TRANSLATION_OFF || !hasLines || !track) return;

    let cancelled = false;
    void translateLines(lines.map((line) => line.text), translationLang, track.id)
      .then((result) => {
        if (!cancelled) setTranslations(result);
      })
      .catch((error) => {
        logInternalWarn("LyricsView translation failed", {
          trackId: track.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [lyrics, translationLang, track?.id]);

  // A fresh song starts at the top, whether or not it turned out to be synced.
  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: 0 });
  }, [lyrics]);

  useEffect(() => {
    if (activeIndex < 0 || isFollowPaused) return;
    scrollToLine(activeIndex, !reduce);
  }, [activeIndex, isFollowPaused, reduce, scrollToLine]);

  useEffect(() => () => {
    if (resumeTimerRef.current !== null) window.clearTimeout(resumeTimerRef.current);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const pauseFollow = () => {
    if (!isSynced || activeIndex < 0) return;
    setIsFollowPaused(true);
    if (resumeTimerRef.current !== null) window.clearTimeout(resumeTimerRef.current);
    resumeTimerRef.current = window.setTimeout(() => {
      resumeTimerRef.current = null;
      setIsFollowPaused(false);
    }, AUTO_SCROLL_RESUME_MS);
  };

  const resumeFollow = () => {
    if (resumeTimerRef.current !== null) {
      window.clearTimeout(resumeTimerRef.current);
      resumeTimerRef.current = null;
    }
    setIsFollowPaused(false);
    scrollToLine(activeIndex, !reduce);
  };

  const handleLineClick = (index: number) => {
    const start = lines[index]?.startTimeSec;
    if (start === undefined) return;
    resumeFollow();
    // Lines are matched against `currentTime + offset`, so the audio for this line sits that
    // far back. Seeking to the raw start time would land a whole offset away from the words.
    void playerController.seekTo(Math.max(0, start - offset));
  };

  /*
   * Handed to every memoised line, so they have to be referentially stable for the lifetime
   * of the view. Reading through a ref keeps the identity fixed while the behaviour still
   * tracks the latest render — a `useCallback` with real dependencies would change identity
   * whenever the offset or the line list did, re-rendering the whole column.
   */
  const lineClickRef = useRef(handleLineClick);
  lineClickRef.current = handleLineClick;
  const seekLine = useCallback((index: number) => lineClickRef.current(index), []);
  const registerLine = useCallback((index: number, element: HTMLElement | null) => {
    lineRefs.current[index] = element;
  }, []);

  /*
   * Roving tabindex.
   *
   * A synced song is a hundred-odd buttons. Leaving them all tabbable means a keyboard user
   * has to walk the entire lyric sheet to reach the close button, so exactly one line is in
   * the tab order and the arrows move between them — the same contract as a listbox.
   */
  const tabbableIndex = focusIndex
    ?? (seekableIndices.includes(activeIndex) ? activeIndex : seekableIndices[0] ?? -1);

  const handleLineKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!ARROW_KEYS.includes(event.key)) return;
    event.preventDefault();

    const position = seekableIndices.indexOf(tabbableIndex);
    const nextPosition = event.key === "Home"
      ? 0
      : event.key === "End"
        ? seekableIndices.length - 1
        : Math.min(
            seekableIndices.length - 1,
            Math.max(0, position + (event.key === "ArrowDown" ? 1 : -1)),
          );

    const nextIndex = seekableIndices[nextPosition];
    if (nextIndex === undefined) return;
    setFocusIndex(nextIndex);
    pauseFollow();
    // `preventScroll` because this view owns its scrolling: the default focus scroll would
    // put the line at the nearest edge rather than the centre the whole design is built on.
    lineRefs.current[nextIndex]?.focus({ preventScroll: true });
    scrollToLine(nextIndex, !reduce);
  };

  const sourceLabel = lyrics?.sourceLabel;
  const timingLabel = hasLines ? (isSynced ? "Synced" : "Unsynced") : null;
  const emptyMessage = !isOnline
    ? "You're offline. Lyrics need a connection."
    : failed
      ? "Lyrics could not be loaded."
      : "No lyrics found for this song.";

  return (
    <section
      className="@container/lyrics relative flex h-full min-h-0 w-full flex-col overflow-hidden"
      aria-label="Lyrics"
    >
      {/*
        The cover, oversized and blurred past recognition, is the only colour on the screen.
        Sized at the smallest variant deliberately: at 70px of blur nothing above 120px
        survives to be seen, so a larger one would cost texture memory and show nothing.
      */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        {track?.artworkUrl && (
          <div
            key={track.artworkUrl}
            className={cn(
              "absolute -inset-[18%] opacity-50 blur-[70px] saturate-[1.7]",
              !reduce && "lyrics-drift",
            )}
          >
            <TrackArtwork className="size-full" size={120} artworkUrl={track.artworkUrl} iconSize={0} />
          </div>
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-background/75 via-background/88 to-background" />
      </div>

      {/*
        The buttons below are navigable but never announced as they light up, so a listener
        using a screen reader would get a static sheet and no sense of where the song is.
      */}
      <p className="sr-only" role="status" aria-live="polite">
        {isSynced && activeIndex >= 0 ? lines[activeIndex]?.text ?? "" : ""}
      </p>

      <button
        type="button"
        className="absolute right-4 top-4 z-20 flex size-9 items-center justify-center rounded-full bg-card/60 text-muted-foreground backdrop-blur transition-colors hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onClose}
        aria-label="Close lyrics"
        title="Close lyrics (Esc)"
      >
        <CloseIcon size={19} />
      </button>

      <div className="relative flex min-h-0 flex-1 flex-col @4xl/lyrics:flex-row">
        {/* Wide enough for two columns: the song gets a poster, the lyrics get the rest. */}
        <aside className="hidden shrink-0 flex-col gap-6 px-8 py-8 @4xl/lyrics:flex @4xl/lyrics:w-[19rem] @6xl/lyrics:w-[22rem]">
          <TrackArtwork
            artworkUrl={track?.artworkUrl}
            size={288}
            className="aspect-square w-full rounded-2xl shadow-2xl shadow-black/50"
            iconSize={40}
            loading="eager"
          />
          <div className="min-w-0">
            <h1 className="text-balance text-2xl font-bold leading-tight tracking-[-0.03em] text-foreground">
              {track?.title ?? "Nothing playing"}
            </h1>
            {track && (
              <p className="mt-1.5 text-sm text-muted-foreground">
                <ArtistLinks artists={track.artists} fallback={track.artist} />
              </p>
            )}
          </div>
        </aside>

        {/* Narrow: the poster would eat the column, so the song identifies itself in a strip. */}
        <header className="flex shrink-0 items-center gap-3.5 px-6 pb-3 pr-16 pt-5 @4xl/lyrics:hidden">
          <TrackArtwork
            artworkUrl={track?.artworkUrl}
            size={56}
            className="size-14 rounded-xl shadow-lg shadow-black/30"
            iconSize={20}
            loading="eager"
          />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-bold tracking-[-0.02em] text-foreground">
              {track?.title ?? "Nothing playing"}
            </h1>
            {track && (
              <p className="truncate text-sm text-muted-foreground">
                <ArtistLinks artists={track.artists} fallback={track.artist} />
              </p>
            )}
          </div>
        </header>

        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollerRef}
            /* `relative` makes this the offsetParent the scroll maths measures against. */
            className="relative h-full overflow-y-auto overscroll-contain px-6 [scrollbar-width:none] @4xl/lyrics:pr-10 [&::-webkit-scrollbar]:hidden"
            onWheel={pauseFollow}
            onPointerDown={pauseFollow}
            onTouchMove={pauseFollow}
          >
            <div
              className={cn(
                "mx-auto max-w-3xl @4xl/lyrics:mx-0",
                // Half a viewport of air top and bottom so the first and last line can still
                // reach the centre, where the highlight lives.
                isSynced ? "py-[44vh]" : "pb-20 pt-4",
              )}
            >
              {isLoading && <LyricsSkeleton />}

              {!isLoading && !track && <LyricsMessage text="Play something to see its lyrics." />}

              {!isLoading && track && !hasLines && (
                <LyricsMessage
                  text={emptyMessage}
                  onRetry={isOnline ? () => setReloadToken((token) => token + 1) : undefined}
                />
              )}

              {!isLoading && hasLines && (
                <div
                  className="flex flex-col pl-5"
                  style={{
                    /* Multiplied rather than replaced: the clamp still does the adapting, the
                       preference just moves the whole scale up or down with it. */
                    fontSize: `calc(${isSynced ? LINE_FONT_SIZE : READING_FONT_SIZE} * ${fontScale})`,
                    gap: isSynced ? `calc(${LINE_GAP} * ${fontScale})` : undefined,
                  }}
                  onKeyDown={isSynced ? handleLineKeyDown : undefined}
                >
                  {lines.map((line, index) =>
                    isSynced ? (
                      <SyncedLine
                        key={`${index}:${line.text}`}
                        index={index}
                        text={line.text}
                        /* Clamped to the table length so every line past the ramp shares one
                           prop value — otherwise line 300 of a long song would re-render on
                           every flip just because its distance went from 287 to 286. */
                        distance={
                          activeIndex < 0
                            ? 1
                            : Math.min(DEPTH.length - 1, Math.abs(index - activeIndex))
                        }
                        isActive={index === activeIndex}
                        isTabbable={index === tabbableIndex}
                        reduce={reduce}
                        translation={translations?.[index] || undefined}
                        onSeek={seekLine}
                        onFocusLine={setFocusIndex}
                        register={registerLine}
                      />
                    ) : (
                      <p
                        key={`${index}:${line.text}`}
                        ref={(element) => registerLine(index, element)}
                        className="text-pretty py-1 leading-relaxed text-foreground/85"
                      >
                        {line.text}
                        {translations?.[index] && (
                          <span className="mt-0.5 block text-[0.72em] text-muted-foreground">
                            {translations[index]}
                          </span>
                        )}
                      </p>
                    ),
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Fades the column into the chrome at both ends instead of cutting lines in half. */}
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b from-background to-transparent"
            aria-hidden="true"
          />
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-background to-transparent"
            aria-hidden="true"
          />

          {isFollowPaused && activeIndex >= 0 && (
            <button
              type="button"
              className="absolute bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-card px-4 py-2 text-sm font-medium text-foreground shadow-xl shadow-black/30 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={resumeFollow}
              aria-label="Resync lyrics to current playback position"
            >
              <RefreshIcon size={15} aria-hidden="true" />
              Back to current line
            </button>
          )}
        </div>
      </div>

      <footer className="relative flex h-10 shrink-0 items-center justify-between gap-3 px-6 pb-2 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-2">
          {timingLabel && (
            <span className="flex shrink-0 items-center gap-1.5">
              <LyricsIcon size={13} aria-hidden="true" />
              {timingLabel}
            </span>
          )}
          {lyrics?.attempts?.length ? (
            <LyricsSourcePanel attempts={lyrics.attempts} activeId={lyrics.sourceId} />
          ) : (
            sourceLabel && <span className="truncate">via {sourceLabel}</span>
          )}
        </span>
        {isSynced && track && <LyricsOffsetControl trackId={track.id} offset={offset} />}
      </footer>
    </section>
  );
}

interface SyncedLineProps {
  index: number;
  text: string;
  distance: number;
  isActive: boolean;
  isTabbable: boolean;
  reduce: boolean;
  /** Absent when translation is off, still loading, or could not be aligned to this line. */
  translation?: string;
  onSeek: (index: number) => void;
  onFocusLine: (index: number) => void;
  register: (index: number, element: HTMLElement | null) => void;
}

/**
 * One lyric line, memoised.
 *
 * Windowing was the obvious answer to long sheets and the wrong one: this column's whole
 * design is centring maths against real `offsetTop` values, and a virtualiser that guesses
 * heights for unmounted lines breaks exactly that. The actual cost was never the DOM — it
 * was re-rendering all three hundred lines each time the active one advanced. With the
 * distance clamped to the depth ramp only the dozen lines whose appearance genuinely
 * changed re-render, so line count stops mattering and the scrolling stays honest.
 *
 * Every callback prop is stable by construction; one inline arrow here would defeat the memo
 * and quietly restore the original cost.
 */
const SyncedLine = memo(function SyncedLine({
  index,
  text,
  distance,
  isActive,
  isTabbable,
  reduce,
  translation,
  onSeek,
  onFocusLine,
  register,
}: SyncedLineProps) {
  const depth = DEPTH[Math.min(distance, DEPTH.length - 1)];
  const attach = useCallback(
    (element: HTMLElement | null) => register(index, element),
    [index, register],
  );

  // Check if there's letters
  const isArabic = /[\u0600-\u06FF]/.test(text);

  // An empty LRC line is a real instrumental beat, not junk. It keeps its slot so the timing
  // stays honest, and announces itself when it comes up.
  if (!text.trim()) {
    return (
      <div
        ref={attach}
        aria-hidden="true"
        className="flex items-center gap-1.5 py-1"
        style={{ opacity: depth.opacity }}
      >
        {[0, 1, 2].map((dot) => (
          <span
            key={dot}
            className={cn(
              "size-2 rounded-full bg-foreground/60",
              isActive && !reduce && "animate-pulse",
            )}
            style={isActive ? { animationDelay: `${dot * 180}ms` } : undefined}
          />
        ))}
      </div>
    );
  }

  return (
    <button
      ref={attach}
      type="button"
      // The direction of the language
      dir={isArabic ? "rtl" : "ltr"}
      tabIndex={isTabbable ? 0 : -1}
      aria-current={isActive ? "true" : undefined}
      onFocus={() => onFocusLine(index)}
      className={cn(
        "group relative origin-left text-pretty text-left font-bold leading-[1.16] tracking-[-0.035em]",
        "transition-[opacity,filter,color] duration-500 ease-out",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        /*
         * The sweep paints its own colour through background-clip, so the active line must
         * not also carry a text colour — and it is only safe while the sampling loop is
         * running. Under reduced motion nothing writes `--sweep`, so the line would stick at
         * the gradient's 0% end and render dimmer than its neighbours.
         */
        isActive && !reduce ? "lyric-sweep" : "text-foreground",
        !isActive && "hover:opacity-100",
      )}
      style={{
        opacity: depth.opacity,
        filter: depth.blur ? `blur(${depth.blur}px)` : undefined,
      }}
      onClick={() => onSeek(index)}
    >
      {/* The one piece of brand colour on the screen, and the only thing marking which line
          is playing when the sweep is at either end. */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute -left-5 top-[0.28em] h-[0.72em] w-[3px] rounded-full bg-primary transition-opacity duration-300",
          isActive ? "opacity-100" : "opacity-0 group-hover:opacity-40",
        )}
      />
      {text}
      {/* Sized in `em` so it tracks the line it belongs to, and deliberately quieter: it is
          a gloss on the lyric, not a second lyric competing with it. */}
      {translation && (
        <span className="mt-1 block text-[0.62em] font-medium leading-snug text-muted-foreground">
          {translation}
        </span>
      )}
    </button>
  );
});

/**
 * Which sources were tried, in priority order, and what each one did.
 *
 * "No lyrics available" is the least useful sentence a music app can show — it gives the
 * listener nothing to act on and gives a bug report nothing to go on. This turns it into a
 * fact: which of the five ranked sources was asked, how long it took, and why it lost.
 */
function LyricsSourcePanel({
  attempts,
  activeId,
}: {
  attempts: LyricsSourceAttempt[];
  activeId?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const winner = attempts.find((attempt) => attempt.id === activeId);

  return (
    <FloatingPanel
      open={isOpen}
      onOpenChange={setIsOpen}
      side="top"
      className="w-[21rem]"
      triggerClassName="min-w-0"
      trigger={
        <button
          type="button"
          className="flex min-w-0 items-center gap-1.5 rounded-full px-1.5 py-0.5 transition-colors hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setIsOpen((open) => !open)}
          aria-expanded={isOpen}
          aria-haspopup="dialog"
          aria-label="Show which lyric sources were tried"
        >
          <span
            className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[winner?.status ?? "miss"])}
            aria-hidden="true"
          />
          <span className="truncate">{winner ? `via ${winner.label}` : "No source matched"}</span>
        </button>
      }
    >
      <p className="px-2 pb-1.5 pt-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        Sources, best first
      </p>
      <div className="flex flex-col">
        {attempts.map((attempt) => {
          const isWinner = attempt.id === activeId;
          return (
            <div
              key={attempt.id}
              className={cn("flex items-start gap-2 rounded-lg px-2 py-1.5", isWinner && "bg-muted/40")}
              // The ranking rationale, one hover away — it explains the order without
              // spending five permanent lines of the panel on it.
              title={LYRICS_SOURCES.find((source) => source.id === attempt.id)?.note}
            >
              <span
                className={cn("mt-[0.4rem] size-1.5 shrink-0 rounded-full", STATUS_DOT[attempt.status])}
                aria-hidden="true"
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-baseline justify-between gap-2">
                  <span
                    className={cn(
                      "truncate text-sm",
                      isWinner ? "font-semibold text-foreground" : "text-foreground/80",
                    )}
                  >
                    {attempt.label}
                  </span>
                  {attempt.durationMs > 0 && (
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {attempt.durationMs}ms
                    </span>
                  )}
                </span>
                <span className="truncate text-xs text-muted-foreground">{attempt.detail}</span>
              </span>
            </div>
          );
        })}
      </div>
    </FloatingPanel>
  );
}

function formatOffset(offset: number): string {
  if (offset === 0) return "In sync";
  const magnitude = Math.abs(offset).toFixed(2).replace(/\.?0+$/, "");
  return `${offset > 0 ? "+" : "−"}${magnitude}s`;
}

/**
 * Nudges the whole lyric sheet against the audio.
 *
 * "+" advances the lyrics, matching the sign convention of an LRC `[offset:]` tag, and the
 * value doubles as the reset button so correcting a mistake costs one click rather than
 * hunting for a separate control.
 */
function LyricsOffsetControl({ trackId, offset }: { trackId: string; offset: number }) {
  const step = (delta: number) => setLyricsOffset(trackId, offset + delta);

  return (
    <div
      className="flex shrink-0 items-center gap-0.5 rounded-full bg-card/70 p-0.5"
      role="group"
      aria-label="Lyric timing"
    >
      <OffsetButton
        label="−"
        ariaLabel={`Delay lyrics by ${OFFSET_STEP_SEC} seconds`}
        onClick={() => step(-OFFSET_STEP_SEC)}
      />
      <button
        type="button"
        className="min-w-[4.25rem] rounded-full px-1 py-0.5 text-center tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:hover:text-muted-foreground"
        onClick={() => setLyricsOffset(trackId, 0)}
        disabled={offset === 0}
        aria-label={offset === 0 ? "Lyrics are in sync" : "Reset lyric timing"}
        title={offset === 0 ? undefined : "Reset"}
      >
        {formatOffset(offset)}
      </button>
      <OffsetButton
        label="+"
        ariaLabel={`Advance lyrics by ${OFFSET_STEP_SEC} seconds`}
        onClick={() => step(OFFSET_STEP_SEC)}
      />
    </div>
  );
}

function OffsetButton({
  label,
  ariaLabel,
  onClick,
}: {
  label: string;
  ariaLabel: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex size-6 items-center justify-center rounded-full text-sm leading-none transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onClick}
      aria-label={ariaLabel}
    >
      {label}
    </button>
  );
}

/* Staggered bars rather than a spinner: it previews the shape of what is arriving, so the
   swap to real lines reads as content landing instead of a screen change. */
function LyricsSkeleton() {
  const widths = [72, 58, 84, 46, 66, 78, 52];
  return (
    <div className="flex flex-col gap-7 pt-10" role="status" aria-label="Loading lyrics">
      {widths.map((width, index) => (
        <div
          key={width}
          className="h-8 animate-pulse rounded-lg bg-foreground/10"
          style={{ width: `${width}%`, animationDelay: `${index * 90}ms` }}
        />
      ))}
    </div>
  );
}

function LyricsMessage({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 px-2 py-24 text-center" role="status">
      <LyricsIcon size={28} className="text-muted-foreground/50" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">{text}</p>
      {onRetry && (
        <button
          type="button"
          className="flex items-center gap-2 rounded-full bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onRetry}
        >
          <RefreshIcon size={15} aria-hidden="true" />
          Try again
        </button>
      )}
    </div>
  );
}
