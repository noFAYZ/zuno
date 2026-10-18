import type { ComponentType } from "react";
import { cn } from "@/lib/utils";
import {
  CompassIcon,
  HomeActiveIcon,
  HomeIcon,
  MusicNoteActiveIcon,
  MusicNoteIcon,
  SearchIcon,
  SettingsActiveIcon,
  SettingsIcon,
} from "@/ui/icons";
import type { TabView } from "../types/tab";

interface MobileNavProps {
  activeView: TabView | undefined;
  onHome: () => void;
  onSearch: () => void;
  onLibrary: () => void;
  onBrowse: () => void;
  onSettings: () => void;
}

type IconComponent = ComponentType<{ size?: number | string; className?: string }>;

interface NavItem {
  key: string;
  label: string;
  Icon: IconComponent;
  ActiveIcon: IconComponent;
  active: boolean;
  onPress: () => void;
}

/**
 * The phone replacement for the desktop title bar and library rail: the five places the app
 * actually has, one thumb-width apart at the bottom of the screen.
 */
export function MobileNav({
  activeView,
  onHome,
  onSearch,
  onLibrary,
  onBrowse,
  onSettings,
}: MobileNavProps) {
  const items: NavItem[] = [
    { key: "home", label: "Home", Icon: HomeIcon, ActiveIcon: HomeActiveIcon, active: activeView === "home", onPress: onHome },
    { key: "search", label: "Search", Icon: SearchIcon, ActiveIcon: SearchIcon, active: activeView === "search", onPress: onSearch },
    { key: "library", label: "Library", Icon: MusicNoteIcon, ActiveIcon: MusicNoteActiveIcon, active: activeView === "library", onPress: onLibrary },
    { key: "browse", label: "Browse", Icon: CompassIcon, ActiveIcon: CompassIcon, active: activeView === "browse", onPress: onBrowse },
    { key: "settings", label: "Settings", Icon: SettingsIcon, ActiveIcon: SettingsActiveIcon, active: activeView === "settings", onPress: onSettings },
  ];

  return (
    <nav
      aria-label="Main"
      className="flex shrink-0 items-stretch border-t border-border bg-background pb-[env(safe-area-inset-bottom)]"
    >
      {items.map(({ key, label, Icon, ActiveIcon, active, onPress }) => {
        const Glyph = active ? ActiveIcon : Icon;
        return (
          <button
            key={key}
            type="button"
            onClick={onPress}
            aria-label={label}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
              active ? "text-primary" : "text-muted-foreground",
            )}
          >
            <Glyph size={22} />
            <span className="truncate">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
