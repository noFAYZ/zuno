import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Loader } from "@/components/motion/loader";
import { CloseIcon } from "@/ui/icons";
import type { UpdateInfo, UpdateInstallProgress } from "../../internal/updateChecker";
import { installUpdate, snoozeUpdate } from "../../internal/updateChecker";

const AUTO_DISMISS_MS = 60_000;

const PRIMARY_ACTION =
  "rounded-full bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const SECONDARY_ACTION =
  "rounded-full px-3 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

interface UpdateToastProps {
  update: UpdateInfo;
  onDismiss: () => void;
}

export function UpdateToast({ update, onDismiss }: UpdateToastProps) {
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateInstallProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const releaseLabel = update.canInstall ? "GitHub" : "Download";

  useEffect(() => {
    if (installing) return;
    const timer = window.setTimeout(() => {
      snoozeUpdate(update.version);
      onDismiss();
    }, AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [installing, onDismiss, update.version]);

  const dismiss = () => {
    if (installing) return;
    snoozeUpdate(update.version);
    onDismiss();
  };

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      await installUpdate(update, setProgress);
    } catch {
      setError("Installation failed. You can still open the release on GitHub.");
      setInstalling(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 24, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 24, scale: 0.96 }}
      transition={{ type: "spring", stiffness: 400, damping: 32 }}
      className="fixed bottom-28 right-5 z-50 flex max-w-md items-center gap-4 rounded-xl bg-card/95 px-4 py-3 shadow-2xl backdrop-blur"
      role="status"
      aria-live="polite"
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <strong className="text-sm font-medium text-foreground">
          Version {update.version} is available
        </strong>
        {installing && (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Loader variant="spinner" size={12} />
            {progress?.percent !== undefined
              ? `Downloading ${progress.percent}%`
              : "Preparing update..."}
          </span>
        )}
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        {update.canInstall && (
          <button
            className={PRIMARY_ACTION}
            type="button"
            disabled={installing}
            onClick={() => void install()}
          >
            {installing ? "Installing..." : "Install"}
          </button>
        )}
        <a
          className={update.canInstall ? SECONDARY_ACTION : PRIMARY_ACTION}
          href={update.releaseUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open version ${update.version} release on GitHub`}
          onClick={(e) => {
            e.preventDefault();
            void openUrl(update.releaseUrl);
          }}
        >
          {releaseLabel}
        </a>
        <button
          className="flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          type="button"
          disabled={installing}
          onClick={dismiss}
          aria-label="Close update notification"
          title="Close"
        >
          <CloseIcon size={16} />
        </button>
      </div>
    </motion.div>
  );
}
