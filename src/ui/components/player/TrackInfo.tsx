import { useLayoutEffect, useRef, useState } from "react";
import { SpinnerSteps } from "@/components/motion/loader";
import { Marquee } from "@/components/motion/marquee";
import { cn } from "@/lib/utils";
import { HeartActiveIcon, HeartBrokenIcon, HeartIcon } from "@/ui/icons";
import { shallowEqual, usePlayerSelector } from "../../../player/playerStore";
import { useLibraryState } from "../../../player/playerStore";
import { usePlayerUIState } from "../../stores/playerUIStore";
import { TrackArtwork } from "../TrackArtwork";
import { CoverButton } from "../CoverButton";
import { ArtistLinks } from "../ArtistLinks";
import { useTrackContextMenu } from "../TrackContextMenu";

export function TrackInfo() {
  const state = usePlayerSelector((player) => ({ currentTrack: player.currentTrack }), shallowEqual);
  const libraryState = useLibraryState();
  const uiState = usePlayerUIState();
  const { openTrackMenu, toggleTrackLike } = useTrackContextMenu();
  const currentTrack = state.currentTrack;
  const titleViewportRef = useRef<HTMLDivElement>(null);
  const titleTextRef = useRef<HTMLSpanElement>(null);
  const [isTitleOverflowing, setIsTitleOverflowing] = useState(false);

  // Only scroll a title that actually overflows — a permanent marquee on short
  // titles is noise. Measured rather than guessed from character count.
  useLayoutEffect(() => {
    const viewport = titleViewportRef.current;
    const text = titleTextRef.current;
    if (!viewport || !text) return;

    const updateOverflow = () => {
      setIsTitleOverflowing(text.scrollWidth - viewport.clientWidth > 1);
    };
    updateOverflow();

    const observer = new ResizeObserver(updateOverflow);
    observer.observe(viewport);
    observer.observe(text);
    return () => observer.disconnect();
  }, [currentTrack?.title]);

  if (!currentTrack) {
    return null;
  }

  const isLikeStatusLoading =
    (libraryState.status === "restoring" || libraryState.status === "loading")
    && !libraryState.library;
  const canLikeCurrentTrack = currentTrack.source !== "local";
  const isLikePending = canLikeCurrentTrack && libraryState.pendingLikeTrackIds.has(currentTrack.id);
  const isLiked = canLikeCurrentTrack && (libraryState.library?.likedSongs.some(
    (track) => track.id === currentTrack.id,
  ) ?? false);

  return (
    <div
      className="flex min-w-0 items-center gap-3"
      onContextMenu={(event) => openTrackMenu(event, currentTrack)}
    >
      {uiState.showAlbumArt && (
        <CoverButton artworkUrl={currentTrack.artworkUrl} label={currentTrack.title}>
          <TrackArtwork
            className="size-12 shrink-0  object-cover"
            size={48}
            artworkUrl={currentTrack.artworkUrl}
            iconSize={22}
          />
        </CoverButton>
      )}
      <div className="flex min-w-0 flex-col gap-0.5">
        <div ref={titleViewportRef} className="relative min-w-0 overflow-hidden">
          {/* Hidden measuring copy — Marquee duplicates its children, so width
              must be read from a single stable node. */}
          <span
            ref={titleTextRef}
            aria-hidden={isTitleOverflowing}
            className={cn(
              "block whitespace-nowrap text-sm font-medium text-foreground",
              isTitleOverflowing && "invisible absolute",
            )}
          >
            {currentTrack.title}
          </span>
          {isTitleOverflowing && (
            <Marquee speed={22} gap="2.5rem" className="text-sm font-medium text-foreground">
              <span className="whitespace-nowrap" title={currentTrack.title}>
                {currentTrack.title}
              </span>
            </Marquee>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          <ArtistLinks artists={currentTrack.artists} fallback={currentTrack.artist} />
        </div>
      </div>

      {canLikeCurrentTrack && (
        <button
          type="button"
          className={cn(
            "group/like flex size-8 shrink-0 items-center justify-center rounded-full transition-colors",
            "disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isLiked ? "text-primary" : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => void toggleTrackLike(currentTrack)}
          disabled={isLikeStatusLoading || isLikePending}
          aria-label={
            isLikeStatusLoading || isLikePending
              ? "Loading like status"
              : isLiked
                ? "Remove like"
                : libraryState.status === "signed-out"
                  ? "Sign in to like"
                  : "Like song"
          }
          title={
            libraryState.status === "signed-out"
              ? "Sign in to like"
              : isLiked
                ? "Remove like"
                : "Like song"
          }
        >
          {isLikeStatusLoading || isLikePending ? (
            <SpinnerSteps size={18} color="currentColor" />
          ) : isLiked ? (
            // Hovering a liked track previews the un-like action.
            <span className="relative grid size-[18px] place-items-center" aria-hidden="true">
              <HeartActiveIcon
                size={18}
                className="absolute transition-opacity group-hover/like:opacity-0"
              />
              <HeartBrokenIcon
                size={18}
                className="absolute opacity-0 transition-opacity group-hover/like:opacity-100"
              />
            </span>
          ) : (
            <HeartIcon size={18} />
          )}
        </button>
      )}
    </div>
  );
}
