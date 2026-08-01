import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Loader } from "@/components/motion/loader";
import { CheckActiveIcon, UserIcon } from "@/ui/icons";
import type { AccountOption } from "../../datasource/types";
import type { LibraryController } from "../../player/LibraryController";
import { logInternalWarn } from "../../internal/logging";

/** Round profile image with a glyph fallback, shared by every account surface. */
export function AccountAvatar({
  artworkUrl,
  className,
  iconSize = 18,
}: {
  artworkUrl?: string;
  className?: string;
  iconSize?: number;
}) {
  const [failed, setFailed] = useState(false);

  // A new URL deserves a fresh attempt; without this, one broken image would poison the slot
  // for every account shown in it afterwards.
  useEffect(() => setFailed(false), [artworkUrl]);

  if (artworkUrl && !failed) {
    return (
      <img
        src={artworkUrl}
        alt=""
        className={cn("shrink-0 rounded-full object-cover", className)}
        onError={() => setFailed(true)}
        referrerPolicy="no-referrer"
      />
    );
  }

  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-card text-muted-foreground",
        className,
      )}
    >
      <UserIcon size={iconSize} aria-hidden="true" />
    </span>
  );
}

/**
 * Picks between the channels on the signed-in Google account.
 *
 * The accounts are fetched when this mounts rather than held in library state: the list only
 * matters while a switcher is open, and it costs a request to YouTube to build.
 */
export function AccountSwitcher({
  libraryController,
  onSwitched,
  showSingle = false,
  className,
}: {
  libraryController: LibraryController;
  /** Fired once a switch completes, so a popover can close itself. */
  onSwitched?: () => void;
  /**
   * Render even when only one channel was found. Settings sets this so you can see which
   * channel is active and that the lookup worked; the title bar popover does not, because a
   * picker with a single option is noise.
   */
  showSingle?: boolean;
  className?: string;
}) {
  const [accounts, setAccounts] = useState<AccountOption[] | null>(null);
  const [switchingId, setSwitchingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    libraryController
      .listAccounts()
      .then((options) => {
        if (!cancelled) setAccounts(options);
      })
      .catch((error: unknown) => {
        logInternalWarn("AccountSwitcher.listAccounts failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        if (!cancelled) setAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [libraryController]);

  const handleSelect = async (account: AccountOption) => {
    if (account.isActive || switchingId) return;
    setSwitchingId(account.id);
    try {
      await libraryController.selectAccount(account.id);
      // Closing here, not before the await: an early close unmounts the row and its
      // spinner on the same tick, so the switch looks like nothing happened.
      onSwitched?.();
    } finally {
      setSwitchingId(null);
    }
  };

  if (accounts === null) {
    return (
      <div className={cn("flex items-center gap-2 px-1  text-sm text-muted-foreground", className)}>
        <Loader variant="spinner" size={16} />
        Loading channels...
      </div>
    );
  }

  if (accounts.length === 0) {
    return showSingle ? (
      <p className={cn("px-2 py-2 text-sm text-muted-foreground", className)}>
        No channels were returned for this account.
      </p>
    ) : null;
  }
  // One channel is not a choice, so there is normally nothing to show.
  if (accounts.length === 1 && !showSingle) return null;

  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      {accounts.map((account) => (
        <button
          key={account.id}
          type="button"
          disabled={Boolean(switchingId)}
          onClick={() => void handleSelect(account)}
          aria-current={account.isActive ? "true" : undefined}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted/70",
            " disabled:pointer-events-none disabled:opacity-60",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            account.isActive && "bg-muted/40",
          )}
        >
          <AccountAvatar artworkUrl={account.artworkUrl} className="size-8" iconSize={16} />
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">{account.name}</span>
          {switchingId === account.id ? (
            <Loader variant="spinner" size={15} />
          ) : account.isActive ? (
            <CheckActiveIcon size={16} className="shrink-0 text-primary" aria-hidden="true" />
          ) : null}
        </button>
      ))}
    </div>
  );
}
