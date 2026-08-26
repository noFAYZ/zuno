export type SettingsTab = "about" | "appearance" | "playback" | "system" | "shortcuts" | "window";

export type SettingsSearchEntry = {
  tab: SettingsTab;
  category: string;
  title: string;
  description: string;
};

const ENTRIES: SettingsSearchEntry[] = [
  { tab: "about", category: "Account", title: "Account", description: "Sign in and manage your YouTube Music account." },
  { tab: "about", category: "Account", title: "Last.fm", description: "Connect Last.fm and scrobble plays." },
  { tab: "about", category: "Account", title: "Discord presence", description: "Show what you are playing and hide status when paused." },
  { tab: "about", category: "Account", title: "Updates", description: "Check for and install Zuno updates." },
  { tab: "appearance", category: "Appearance", title: "Theme", description: "Choose light, dark, or system theme." },
  { tab: "appearance", category: "Appearance", title: "Motion", description: "Control animations and visual effects." },
  { tab: "appearance", category: "Appearance", title: "Toolbar", description: "Choose which controls appear in the title bar." },
  { tab: "appearance", category: "Appearance", title: "Onboarding", description: "Restart the first-run introduction." },
  { tab: "appearance", category: "Appearance", title: "Made for you", description: "Show personalized recommendations on Home." },
  { tab: "playback", category: "Playback", title: "Output device", description: "Choose where Zuno sends audio." },
  { tab: "playback", category: "Playback", title: "Equalizer", description: "Adjust audio frequencies and presets." },
  { tab: "playback", category: "Playback", title: "Gapless playback", description: "Remove silence between tracks." },
  { tab: "playback", category: "Playback", title: "Crossfade", description: "Blend the end of one track into the next." },
  { tab: "playback", category: "Playback", title: "Restore tabs and queues", description: "Restore your playback session after restarting." },
  { tab: "playback", category: "Playback", title: "Audio engine", description: "Choose the playback method and authenticated streaming." },
  { tab: "system", category: "Library", title: "Local music", description: "Create playlists from folders on this computer." },
  { tab: "system", category: "Library", title: "Cache", description: "Set cache size and clear cached content." },
  { tab: "system", category: "Library", title: "Downloads", description: "Set offline storage limits and remove downloads." },
  { tab: "system", category: "Library", title: "Streaming quality", description: "Choose quality for music played over the network." },
  { tab: "system", category: "Library", title: "Download quality", description: "Choose quality for offline music." },
  { tab: "system", category: "Library", title: "Lyrics", description: "Translate lyrics, set text size, and choose a source." },
  { tab: "system", category: "Library", title: "Launch at startup", description: "Start Zuno when your computer starts." },
  { tab: "system", category: "Library", title: "Minimize to tray", description: "Keep Zuno available from the system tray." },
  { tab: "system", category: "Library", title: "Remember window size and location", description: "Restore the main window geometry." },
  { tab: "system", category: "Library", title: "Troubleshooting", description: "Open logs or reset Zuno data." },
  { tab: "window", category: "Window", title: "Mini player", description: "Show a compact player when the main window loses focus." },
  { tab: "window", category: "Window", title: "Library sidebar", description: "Choose the playlist rail size and hover behavior." },
  { tab: "window", category: "Window", title: "Window controls", description: "Choose macOS, Windows, or native title-bar buttons." },
  { tab: "window", category: "Window", title: "Compact player bar", description: "Use a smaller playback bar." },
  { tab: "window", category: "Window", title: "System media controls", description: "Show playback in system media controls." },
  { tab: "shortcuts", category: "Shortcuts", title: "Keyboard shortcuts", description: "View, record, or clear keyboard bindings." },
];

export function searchSettings(query: string): SettingsSearchEntry[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return ENTRIES.filter((entry) => {
    const haystack = `${entry.category} ${entry.title} ${entry.description}`.toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
