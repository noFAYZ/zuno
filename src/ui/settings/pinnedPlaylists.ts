import { playlistIdSetting } from "./playlistIdSetting";

/** Playlists kept at the top of the sidebar, in the order they were pinned (#187). */
const pinned = playlistIdSetting("sidebar-pinned-playlists", "pinned-playlists-change");

export const pinPlaylist = pinned.add;
export const unpinPlaylist = pinned.remove;
export const hydratePinnedPlaylists = pinned.hydrate;
export const usePinnedPlaylistIds = pinned.useIds;
