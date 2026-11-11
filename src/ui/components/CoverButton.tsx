import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/lib/utils";
import { CloseIcon } from "@/ui/icons";
import { getFullSizeArtworkUrl } from "../../datasource/youtube/artwork";
import { TrackArtwork } from "./TrackArtwork";

interface CoverButtonProps {
  artworkUrl?: string;
  /** What the cover belongs to, for the button's and dialog's names. */
  label: string;
  className?: string;
  children: ReactNode;
}

/** Makes a cover clickable, opening it full size over the window (#174). */
export function CoverButton({ artworkUrl, label, className, children }: CoverButtonProps) {
  const [open, setOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!artworkUrl) return <>{children}</>;

  return (
    <>
      <button
        type="button"
        aria-label={`View cover of ${label}`}
        onClick={() => setOpen(true)}
        className={cn(
          "shrink-0 cursor-zoom-in transition-opacity hover:opacity-90",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className,
        )}
      >
        {children}
      </button>
      {createPortal(
        <AnimatePresence>
          {open && (
            <motion.div
              // Rounded to the window, or the scrim paints past its corner cutout.
              className="fixed inset-0 z-[200] flex cursor-zoom-out items-center justify-center overflow-hidden rounded-[var(--window-radius)] bg-background/80 p-10 backdrop-blur-md"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onPointerDown={() => setOpen(false)}
            >
              <motion.div
                role="dialog"
                aria-modal="true"
                aria-label={`Cover of ${label}`}
                className="relative"
                initial={{ opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.12 } }}
                transition={{ type: "spring", stiffness: 420, damping: 32, mass: 0.7 }}
              >
                <TrackArtwork
                  artworkUrl={getFullSizeArtworkUrl(artworkUrl)}
                  className="aspect-square w-[min(80vh,80vw)] rounded-2xl shadow-2xl shadow-black/50"
                  iconSize={96}
                  loading="eager"
                />
                <button
                  ref={closeRef}
                  type="button"
                  aria-label="Close cover"
                  onClick={() => setOpen(false)}
                  className={cn(
                    "absolute -right-3 -top-3 grid size-9 place-items-center rounded-full bg-card text-foreground shadow-lg",
                    "transition-colors hover:bg-muted",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                >
                  <CloseIcon size={20} aria-hidden="true" />
                </button>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
