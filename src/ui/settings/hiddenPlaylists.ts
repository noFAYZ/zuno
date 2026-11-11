import { playlistIdSetting } from "./playlistIdSetting";

/**
 * Playlist ids hidden from the Library page and the sidebar.
 *
 * A display filter only — the playlist itself is untouched on YouTube's side, so hiding one is
 * always reversible and never touches the network. Local playlists and Liked Songs can be
 * hidden the same way as any other; nothing here is specific to a playlist kind.
 */
const hidden = playlistIdSetting("library-hidden-playlists", "hidden-playlists-change");

export const isPlaylistHidden = hidden.has;
export const hidePlaylist = hidden.add;
export const unhidePlaylist = hidden.remove;
export const hydrateHiddenPlaylists = hidden.hydrate;
export const useHiddenPlaylistIds = hidden.useIds;
