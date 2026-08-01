import { cn } from "@/lib/utils";


interface ExpandedPlayerBarProps {
  isOpen: boolean;
  onClose?: () => void; // Optional: callback to close the player
}

export default function ExpandedPlayerBar({ isOpen, onClose }: ExpandedPlayerBarProps) {
  return (
    /* 1. The outer floating frame that grows from 70px to 100vh */
    <div className={cn("fixed inset-x-0 bottom-0 z-40 flex flex-col rounded-t-2xl bg-popover shadow-2xl", isOpen && "translate-y-0")}>
      
      {/* 2. Mini Player Content (Visible only when closed) */}
      {!isOpen && (
        <div className="flex items-center gap-3">
          <span>🎵 Now Playing: Song Title</span>
          <span className="text-center text-xs text-muted-foreground">Tap to expand</span>
        </div>
      )}

      {/* 3. The Sliding Expanded Panel */}
      <div className={cn("relative overflow-hidden", isOpen && "translate-y-0 opacity-100")}>
        
        {/* Close Button */}
        {onClose && (
          <button className="flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onClose}>✕</button>
        )}

        {/* Full Player Content */}
        <div className="flex flex-col gap-4 p-6">
          <h2>Now Playing</h2>
          <div className="size-16 shrink-0 rounded-lg object-cover"></div>
          <p className="truncate text-sm font-medium text-foreground">Song Title</p>
          <p className="truncate text-sm text-muted-foreground">Artist Name</p>
          {/* Add your controls and progress bars here */}
        </div>

      </div>
    </div>
  );
}