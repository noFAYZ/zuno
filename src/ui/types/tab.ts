import type { Album, Artist, Playlist, SearchResults, Track } from "../../datasource/types";

export type TabView = "home" | "album" | "artist" | "playlist" | "related" | "search" | "history" | "browse" | "library" | "settings";
export type NavigableTabView = Exclude<TabView, "settings">;

export interface TabViewState {
  title?: string;
  view: NavigableTabView;
  album?: Album;
  artist?: Artist;
  playlist?: Playlist;
  /** The track a "related" view is about. */
  relatedTrack?: Track;
  searchQuery?: string;
  searchResults?: Track[];
  mixedSearchResults?: SearchResults;
  searchLoading?: boolean;
}

export interface TabNavigationHistory {
  back: TabViewState[];
  forward: TabViewState[];
}

export interface Tab {
  id: string;
  /** Which Browse tab to open on. Only meaningful when `view` is "browse". */
  browseTab?: string;
  title?: string;
  view: TabView;
  album?: Album;
  artist?: Artist;
  playlist?: Playlist;
  relatedTrack?: Track;
  searchQuery?: string;
  searchResults?: Track[];
  mixedSearchResults?: SearchResults;
  searchLoading?: boolean;
  isQueueOpen?: boolean;
  navigationHistory?: TabNavigationHistory;
}
