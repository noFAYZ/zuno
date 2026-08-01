import { Button } from "@/components/motion/button";
import { Tooltip } from "@/components/motion/tooltip";
import { ArrowLeftIcon, ArrowRightIcon, SearchIcon } from "@/ui/icons";
import { primaryModifierLabel } from "../platform";

interface SearchBarProps {
  onOpen: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onBack: () => void;
  onForward: () => void;
}

export function SearchBar({
  onOpen,
  canGoBack,
  canGoForward,
  onBack,
  onForward,
}: SearchBarProps) {
  const showBackButton = canGoBack || canGoForward;

  return (
    <div className="flex items-center gap-2 max-w-3xl mx-auto">
      {showBackButton && (
        <Tooltip content="Back">
          <Button
            variant="ghost"
            size="icon"
            onClick={onBack}
            disabled={!canGoBack}
            aria-label="Go back"
            className="shrink-0 rounded-full"
          >
            <ArrowLeftIcon size={18} aria-hidden="true" />
          </Button>
        </Tooltip>
      )}
      {canGoForward && (
        <Tooltip content="Forward">
          <Button
            variant="ghost"
            size="icon"
            onClick={onForward}
            aria-label="Go forward"
            className="shrink-0 rounded-full"
          >
            <ArrowRightIcon size={18} aria-hidden="true" />
          </Button>
        </Tooltip>
      )}

      <button
        type="button"
        onClick={onOpen}
        data-onboarding="search"
        className="group flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-full bg-card px-3.5 text-left text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <SearchIcon size={17} className="shrink-0" />
        <span className="truncate">Search artists, songs, playlists, and albums</span>
        <kbd className="ml-auto shrink-0 rounded bg-background/60 px-1.5 py-0.5 font-sans text-xs text-muted-foreground">
          {primaryModifierLabel} Space
        </kbd>
      </button>
    </div>
  );
}
