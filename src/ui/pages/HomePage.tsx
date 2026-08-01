import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CylinderCarousel } from "@/components/motion/cylinder-carousel";
import { PlayActiveIcon } from "@/ui/icons";
import type { Track } from "../../datasource/types";
import type { LibraryController, LibraryState } from "../../player/LibraryController";
import type { PlayerControllerActions } from "../../player/playerStore";
import type { SearchController } from "../../player/SearchController";
import { AlbumCard } from "../components/AlbumCard";
import { DiceCard } from "../components/DiceCard";
import { PickCard } from "../components/PickCard";
import { TrackArtwork } from "../components/TrackArtwork";
import { useTrackContextMenu } from "../components/TrackContextMenu";
import { HomeDestinations, type HomeDestinationHandlers } from "../components/HomeDestinations";
import { ArtistLinks } from "../components/ArtistLinks";
import { usePlayHistory } from "../../player/playHistory";
import { useMadeForYouVisible } from "../settings/homeSections";

const FALLBACK_QUERIES = [
  "new music",
  "popular songs",
  "indie mix",
  "electronic mix",
  "late night music",
  "discover weekly",
];

/*
 * The carousel hands each item a square slot; PickCard is portrait and centres itself inside
 * it, so PICKS_ITEM_SIZE is the card's *height* and the width follows from PICKS_ASPECT.
 * Telling the carousel that aspect (see `itemAspect`) is what lets the cards grow this
 * large: without it the fit rule reserves width for a square the card never fills.
 */
const PICKS_ASPECT = 3 / 4;
const PICKS_VISIBLE_ITEMS = 5;
const PICKS_ITEM_SIZE = 250;

/*
 * Curve depth. The default is 35% of the item size, which on cards this large lifts the
 * centre ones ~38px above the midline — past the stage's clip-path, so their tops get cut.
 * A flatter arc keeps the cylinder legible and the row inside its box.
 */
const PICKS_ARC = 68;

/*
 * Stage height must clear the tallest thing that can happen: the card, plus half the arc
 * (convex raises the centre cards), plus the hover lift. Sized so nothing reaches the clip
 * edge rather than exactly hugging the card.
 */
const PICKS_STAGE_HEIGHT = PICKS_ITEM_SIZE + PICKS_ARC ;

const suggestionCache = new Map<string, Track[]>();
const suggestionLoads = new Map<string, Promise<Track[]>>();
const EMPTY_TRACKS: Track[] = [];

/**
 * Cap on memoized suggestion sets.
 *
 * The key carries both the tab and a signature of the recently-played list, so a new entry
 * appears for every tab and again on every library refresh — and each holds 36 full tracks.
 * Unbounded, that grew for as long as the app stayed open.
 *
 * Insertion order gives LRU for free: reads re-insert, so eviction takes the coldest.
 */
const MAX_SUGGESTION_ENTRIES = 20;

function readSuggestionCache(key: string): Track[] | undefined {
  const hit = suggestionCache.get(key);
  if (hit === undefined) return undefined;
  suggestionCache.delete(key);
  suggestionCache.set(key, hit);
  return hit;
}

function writeSuggestionCache(key: string, tracks: Track[]): void {
  suggestionCache.delete(key);
  suggestionCache.set(key, tracks);

  for (const coldest of [...suggestionCache.keys()]) {
    if (suggestionCache.size <= MAX_SUGGESTION_ENTRIES) break;
    suggestionCache.delete(coldest);
  }
}

interface HomePageProps {
  tabId: string;
  playerController: PlayerControllerActions;
  libraryController: LibraryController;
  libraryState: LibraryState;
  searchController: SearchController;
  onSignIn: () => Promise<void>;
  destinations: HomeDestinationHandlers;
}

function shuffle<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function uniqueTracks(tracks: readonly Track[]): Track[] {
  return [...new Map(tracks.map((track) => [track.id, track])).values()];
}

export function HomePage({
  tabId,
  playerController,
  libraryController,
  libraryState,
  searchController,
  onSignIn,
  destinations,
}: HomePageProps) {
  const { openTrackMenu } = useTrackContextMenu();
  const showMadeForYou = useMadeForYouVisible();
  const recentlyPlayed = useMemo(
    () => libraryState.library?.recentlyPlayed ?? EMPTY_TRACKS,
    [libraryState.library],
  );
  const recentTrackKey = recentlyPlayed.map((track) => track.id).join(":");
  /*
   * Computed before the state below, not after, so the initial render can read the cache under
   * the key writes actually use. It previously seeded from `tabId` alone — a key nothing ever
   * stored — so the memo never hit and Home opened on a spinner every single time, which is
   * the exact thing this cache exists to prevent.
   */
  const suggestionCacheKey = recentlyPlayed.length > 0
    ? `${tabId}:recent:${recentTrackKey}`
    : `${tabId}:${libraryState.status}:empty`;
  const [suggestions, setSuggestions] = useState<Track[]>(
    () => readSuggestionCache(suggestionCacheKey) ?? [],
  );
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(
    () => !suggestionCache.has(suggestionCacheKey),
  );
  const [isSurpriseSpinning, setIsSurpriseSpinning] = useState(false);
  const loadIdRef = useRef(0);
  /*
   * What is shown as "Recently played": this session's plays first, then YouTube's history.
   * The library snapshot only refreshes on start-up, so on its own the row sat unchanged
   * however much you listened. Suggestions still seed from the snapshot alone — keying them
   * on the live list would refetch them after every song.
   */
  const playHistory = usePlayHistory();
  const recentPlays = useMemo(
    () => uniqueTracks([...playHistory.map((entry) => entry.track), ...recentlyPlayed]),
    [playHistory, recentlyPlayed],
  );
  const isWaitingForLibrary = !libraryState.library
    && (
      libraryState.status === "restoring"
      || libraryState.status === "loading"
      || libraryState.status === "authorizing"
    );

  useEffect(() => {
    if (isWaitingForLibrary) {
      loadIdRef.current += 1;
      setSuggestions([]);
      setIsLoadingSuggestions(true);
      return;
    }

    const cached = readSuggestionCache(suggestionCacheKey);
    if (cached) {
      setSuggestions(cached);
      setIsLoadingSuggestions(false);
      return;
    }

    const loadId = ++loadIdRef.current;
    setIsLoadingSuggestions(true);

    let loadPromise = suggestionLoads.get(suggestionCacheKey);
    if (!loadPromise) {
      loadPromise = (async () => {
        const seeds = shuffle(recentlyPlayed).slice(0, 3);
        let loaded: Track[] = [];

        if (seeds.length > 0) {
          const recommendationSets = await Promise.allSettled(
            seeds.map((seed) => libraryController.getRecommendations(seed)),
          );
          loaded = recommendationSets.flatMap((result) =>
            result.status === "fulfilled" ? result.value : []
          );
        }

        if (loaded.length < 12) {
          const query = FALLBACK_QUERIES[Math.floor(Math.random() * FALLBACK_QUERIES.length)];
          try {
            loaded.push(...await searchController.searchTracks(query));
          } catch {
            // Recent tracks still provide a useful offline fallback.
          }
        }

        return shuffle(uniqueTracks([...loaded, ...recentlyPlayed])).slice(0, 36);
      })();
      suggestionLoads.set(suggestionCacheKey, loadPromise);
    }

    void loadPromise.then((loadedSuggestions) => {
      writeSuggestionCache(suggestionCacheKey, loadedSuggestions);
      suggestionLoads.delete(suggestionCacheKey);
      if (loadId !== loadIdRef.current) return;
      setSuggestions(loadedSuggestions);
      setIsLoadingSuggestions(false);
    });
  }, [
    isWaitingForLibrary,
    libraryController,
    recentlyPlayed,
    searchController,
    suggestionCacheKey,
  ]);

  const compactRecent = useMemo(() => recentPlays.slice(0, 6), [recentPlays]);
  const largeRecent = useMemo(() => recentPlays.slice(6, 24), [recentPlays]);
  const topSuggestions = suggestions.slice(0, 11);
  const moreSuggestions = suggestions.slice(11, 23);
  const surpriseSuggestions = suggestions.slice(11);

  const playTrack = (track: Track, queue: readonly Track[]) => {
    void playerController.playTrackById(track.id, queue, true);
  };

  const playSurprise = () => {
    if (surpriseSuggestions.length === 0 || isSurpriseSpinning) return;
    setIsSurpriseSpinning(true);
    window.setTimeout(() => {
      const selected = surpriseSuggestions[
        Math.floor(Math.random() * surpriseSuggestions.length)
      ];
      setIsSurpriseSpinning(false);
      playTrack(selected, surpriseSuggestions);
    }, 720);
  };

  const madeForYouSection = (
    <section
      className={`${"flex flex-col gap-3"} ${
        isLoadingSuggestions ? "opacity-60" : "opacity-100 transition-opacity"
      }`}
    >
        
      <div className="flex items-center justify-between gap-3">
        <h1>Made for you</h1>
      </div>
      {isLoadingSuggestions ? (
        <div
          className="h-[--stage] w-full animate-pulse rounded-2xl bg-card"
          style={{ "--stage": `${PICKS_STAGE_HEIGHT}px` } as CSSProperties}
          aria-label="Loading suggestions"
        />
      ) : (
        /*
          The picks ride the inside of a cylinder instead of sitting in a grid: the row
          recedes toward the middle and grows at the edges, so a shelf of recommendations
          reads as something you roll through rather than a wall you scan. Drag, wheel or
          arrow-key it. The same DiceCard/AlbumCard children as before — only the container
          changed — so context menus, artist links and playback all behave identically.
        */
        <CylinderCarousel
          itemSize={PICKS_ITEM_SIZE}
          height={PICKS_STAGE_HEIGHT}
          visibleItems={PICKS_VISIBLE_ITEMS}
          itemAspect={PICKS_ASPECT}
          arc={PICKS_ARC}
          minScale={0.72}
          /*
            Convex, not the default concave: a shelf of picks wants its hero in the middle
            where the eye already is. Concave puts the *largest* cards at the container edge,
            which is exactly where they get clipped — the biggest, loudest items end up half
            cut off while the centre of attention holds the smallest one.
          */
          variant="convex"
          className="-mx-4 cursor-grab active:cursor-grabbing"
        >
          <DiceCard
            tracks={surpriseSuggestions}
            isSpinning={isSurpriseSpinning}
            onClick={playSurprise}
          />
          {topSuggestions.map((track) => (
            <PickCard
              key={track.id}
              artworkUrl={track.artworkUrl}
              title={track.title}
              subtitle={track.artist}
              onContextMenu={(event) => openTrackMenu(event, track)}
              onSelect={() => playTrack(track, suggestions)}
            />
          ))}
        </CylinderCarousel>
      )}

    </section>
  );

  return (
    <div className="flex flex-col gap-8">
      {libraryState.status === "signed-out" && (
        <section className="flex items-center justify-between gap-4 rounded-xl bg-card/60 px-4 py-3 text-sm text-muted-foreground">
          <div>
            <h1>You&apos;re not signed in</h1>
            <p>Sign in to access your history, playlists, and albums.</p>
          </div>
          <button type="button" onClick={() => void onSignIn()}>
            Sign in
          </button>
        </section>
      )}

      {showMadeForYou && !isLoadingSuggestions && madeForYouSection}

      {/* Directly under the carousel: the picks are what you came for, these are where you
          go when none of them appeal. */}
      <HomeDestinations {...destinations} />

      {compactRecent.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-foreground">Recently played</h2>
          <div className="grid gap-1.5 [grid-template-columns:repeat(auto-fill,minmax(16rem,1fr))]">
            {compactRecent.map((track) => (
              <button
                key={track.id}
                type="button"
                className="group/row flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onContextMenu={(event) => openTrackMenu(event, track)}
                onClick={() => playTrack(track, recentPlays)}
              >
                <TrackArtwork
                  className="size-11 shrink-0 rounded-md object-cover"
                  size={44}
                  artworkUrl={track.artworkUrl}
                  iconSize={24}
                />
                <span className="flex min-w-0 flex-1 flex-col [&_span]:truncate [&_span]:text-xs [&_span]:text-muted-foreground [&_strong]:truncate [&_strong]:text-sm [&_strong]:font-medium">
                  <strong>{track.title}</strong>
                  <ArtistLinks artists={track.artists} fallback={track.artist} />
                </span>
                <PlayActiveIcon size={18} />
              </button>
            ))}
          </div>
        </section>
      )}

      {showMadeForYou && isLoadingSuggestions && madeForYouSection}

      {moreSuggestions.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-foreground">More recommendations</h2>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(9.5rem,1fr))]">
            {moreSuggestions.map((track) => (
              <AlbumCard
                key={track.id}
                artworkUrl={track.artworkUrl}
                title={track.title}
                subtitleContent={<ArtistLinks artists={track.artists} fallback={track.artist} />}
                onContextMenu={(event) => openTrackMenu(event, track)}
                onClick={() => playTrack(track, suggestions)}
              />
            ))}
          </div>
        </section>
      )}

      {largeRecent.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-foreground">Listen again</h2>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(9.5rem,1fr))]">
            {largeRecent.map((track) => (
              <AlbumCard
                key={track.id}
                artworkUrl={track.artworkUrl}
                title={track.title}
                subtitleContent={<ArtistLinks artists={track.artists} fallback={track.artist} />}
                onContextMenu={(event) => openTrackMenu(event, track)}
                onClick={() => playTrack(track, recentPlays)}
              />
            ))}
          </div>
        </section>
      )}

      {!isLoadingSuggestions && suggestions.length === 0 && (
        <div className="px-2 py-10 text-center text-sm text-muted-foreground">
          <p>Recommendations could not be loaded.</p>
          {libraryState.status === "signed-out" && (
            <button onClick={() => void onSignIn()}>
              Sign in with YouTube Music
            </button>
          )}
        </div>
      )}
    </div>
  );
}
