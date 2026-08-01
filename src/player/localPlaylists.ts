import { invoke } from "@tauri-apps/api/core";
import type { Playlist, Track, TrackPage } from "../datasource/types";
import { getAppSetting, setAppSetting } from "../internal/appSettings";

const STORAGE_KEY = "ytc-local-playlists-v1";
const LOCAL_PLAYLIST_TRACKS_STORAGE_KEY = "ytc-local-playlist-tracks-v1";
const LOCAL_PLAYLIST_TRACK_ORDER_KEY = "ytc-local-playlist-track-order-v1";
const LOCAL_PLAYLIST_PREFIX = "local-playlist:";
const LOCAL_PLAYLIST_TRACK_PREFIX = "local-playlist-track:";
const listeners = new Set<() => void>();
let cachedRaw: string | null = null;
let cachedPlaylists: LocalPlaylist[] = [];
let cachedPlaylistItemsRaw: string | null = null;
let cachedPlaylistItems: Playlist[] = [];
let cachedPlaylistTracksRaw: string | null = null;
let cachedPlaylistTracks: Record<string, Track[]> = {};
let cachedTrackOrderRaw: string | null = null;
let cachedTrackOrder: Record<string, string[]> = {};
let hydrationStarted = false;

export interface LocalPlaylist {
  id: string;
  name: string;
  paths: string[];
}

interface LocalAudioFile {
  path: string;
  title: string;
  album?: string;
  durationSec?: number;
}

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${LOCAL_PLAYLIST_PREFIX}${crypto.randomUUID()}`;
  }
  return `${LOCAL_PLAYLIST_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function normalizePlaylist(value: unknown): LocalPlaylist | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<LocalPlaylist>;
  if (typeof candidate.id !== "string" || !candidate.id.startsWith(LOCAL_PLAYLIST_PREFIX)) return null;
  if (typeof candidate.name !== "string" || !candidate.name.trim()) return null;
  const paths = Array.isArray(candidate.paths)
    ? candidate.paths.filter((path): path is string => typeof path === "string" && path.trim().length > 0)
    : [];
  return {
    id: candidate.id,
    name: candidate.name.trim(),
    paths: Array.from(new Set(paths.map((path) => path.trim()))),
  };
}

function readLocalPlaylists(): LocalPlaylist[] {
  if (typeof window === "undefined") return [];
  hydrateLocalPlaylistStorage();
  const raw = localStorage.getItem(STORAGE_KEY) ?? "[]";
  if (raw === cachedRaw) return cachedPlaylists;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    cachedRaw = raw;
    cachedPlaylists = parsed
      .map(normalizePlaylist)
      .filter((playlist): playlist is LocalPlaylist => Boolean(playlist));
    return cachedPlaylists;
  } catch {
    cachedRaw = raw;
    cachedPlaylists = [];
    return [];
  }
}

function writeLocalPlaylists(playlists: LocalPlaylist[]): void {
  queueMicrotask(syncLocalAudioWatcher);
  if (typeof window === "undefined") return;
  const raw = JSON.stringify(playlists);
  writeLocalStorageJson(STORAGE_KEY, playlists);
  void setAppSetting(STORAGE_KEY, playlists);
  cachedRaw = raw;
  cachedPlaylists = playlists;
  listeners.forEach((listener) => listener());
}

function normalizeStoredTrack(value: unknown): Track | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<Track>;
  if (candidate.source !== "local") return null;
  if (typeof candidate.id !== "string" || !candidate.id.trim()) return null;
  if (typeof candidate.title !== "string" || !candidate.title.trim()) return null;
  if (typeof candidate.localPath !== "string" || !candidate.localPath.trim()) return null;

  return {
    id: candidate.id,
    source: "local",
    title: candidate.title,
    artist: typeof candidate.artist === "string" && candidate.artist.trim()
      ? candidate.artist
      : "Local files",
    artists: Array.isArray(candidate.artists) ? candidate.artists : undefined,
    album: typeof candidate.album === "string" ? candidate.album : undefined,
    durationSec: typeof candidate.durationSec === "number" ? candidate.durationSec : undefined,
    artworkUrl: typeof candidate.artworkUrl === "string" ? candidate.artworkUrl : undefined,
    playlistItemId: typeof candidate.playlistItemId === "string"
      ? candidate.playlistItemId
      : candidate.localPath,
    localPath: candidate.localPath,
  };
}

function readLocalPlaylistTracks(): Record<string, Track[]> {
  if (typeof window === "undefined") return {};
  hydrateLocalPlaylistStorage();
  const raw = localStorage.getItem(LOCAL_PLAYLIST_TRACKS_STORAGE_KEY) ?? "{}";
  if (raw === cachedPlaylistTracksRaw) return cachedPlaylistTracks;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    cachedPlaylistTracksRaw = raw;
    cachedPlaylistTracks = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .map(([playlistId, tracks]) => [
          playlistId,
          Array.isArray(tracks)
            ? tracks.map(normalizeStoredTrack).filter((track): track is Track => Boolean(track))
            : [],
        ])
        .filter(([, tracks]) => tracks.length > 0),
    );
    return cachedPlaylistTracks;
  } catch {
    cachedPlaylistTracksRaw = raw;
    cachedPlaylistTracks = {};
    return {};
  }
}

function writeLocalPlaylistTracks(playlistTracks: Record<string, Track[]>): void {
  if (typeof window === "undefined") return;
  const raw = JSON.stringify(playlistTracks);
  writeLocalStorageJson(LOCAL_PLAYLIST_TRACKS_STORAGE_KEY, playlistTracks);
  void setAppSetting(LOCAL_PLAYLIST_TRACKS_STORAGE_KEY, playlistTracks);
  cachedPlaylistTracksRaw = raw;
  cachedPlaylistTracks = playlistTracks;
  listeners.forEach((listener) => listener());
}

function readTrackOrder(): Record<string, string[]> {
  if (typeof window === "undefined") return {};
  hydrateLocalPlaylistStorage();
  const raw = localStorage.getItem(LOCAL_PLAYLIST_TRACK_ORDER_KEY) ?? "{}";
  if (raw === cachedTrackOrderRaw) return cachedTrackOrder;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    cachedTrackOrderRaw = raw;
    cachedTrackOrder = Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .map(([playlistId, order]) => [
          playlistId,
          Array.isArray(order)
            ? order.filter((item): item is string => typeof item === "string" && item.length > 0)
            : [],
        ])
        .filter(([, order]) => order.length > 0),
    );
    return cachedTrackOrder;
  } catch {
    cachedTrackOrderRaw = raw;
    cachedTrackOrder = {};
    return {};
  }
}

function writeTrackOrder(order: Record<string, string[]>): void {
  if (typeof window === "undefined") return;
  const raw = JSON.stringify(order);
  writeLocalStorageJson(LOCAL_PLAYLIST_TRACK_ORDER_KEY, order);
  void setAppSetting(LOCAL_PLAYLIST_TRACK_ORDER_KEY, order);
  cachedTrackOrderRaw = raw;
  cachedTrackOrder = order;
  listeners.forEach((listener) => listener());
}

export function subscribeToLocalPlaylists(listener: () => void): () => void {
  hydrateLocalPlaylistStorage();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function normalizePlaylistList(value: unknown): LocalPlaylist[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .map(normalizePlaylist)
    .filter((playlist): playlist is LocalPlaylist => Boolean(playlist));
}

function normalizeTrackMap(value: unknown): Record<string, Track[]> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([playlistId, tracks]): [string, Track[]] => [
        playlistId,
        Array.isArray(tracks)
          ? tracks.map(normalizeStoredTrack).filter((track): track is Track => Boolean(track))
          : [],
      ])
      .filter(([, tracks]) => tracks.length > 0),
  );
}

function normalizeTrackOrderMap(value: unknown): Record<string, string[]> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([playlistId, order]): [string, string[]] => [
        playlistId,
        Array.isArray(order)
          ? order.filter((item): item is string => typeof item === "string" && item.length > 0)
          : [],
      ])
      .filter(([playlistId, order]) => playlistId.startsWith(LOCAL_PLAYLIST_PREFIX) && order.length > 0),
  );
}

function writeLocalStorageJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Durable app settings remain the source of truth after hydration.
  }
}

function refreshLocalPlaylistCaches(): void {
  cachedRaw = null;
  cachedPlaylistItemsRaw = null;
  cachedPlaylistTracksRaw = null;
  cachedTrackOrderRaw = null;
  readLocalPlaylists();
  readLocalPlaylistTracks();
  readTrackOrder();
}

async function hydrateSetting<T>(
  key: string,
  normalize: (value: unknown) => T | null,
  fallback: () => T,
): Promise<boolean> {
  const stored = normalize(await getAppSetting<unknown>(key));
  if (stored) {
    writeLocalStorageJson(key, stored);
    return true;
  }

  const localValue = fallback();
  if (
    Array.isArray(localValue)
      ? localValue.length > 0
      : Object.keys(localValue as Record<string, unknown>).length > 0
  ) {
    void setAppSetting(key, localValue);
  }
  return false;
}

function hydrateLocalPlaylistStorage(): void {
  if (hydrationStarted || typeof window === "undefined") return;
  hydrationStarted = true;

  void Promise.all([
    hydrateSetting(STORAGE_KEY, normalizePlaylistList, readLocalPlaylists),
    hydrateSetting(LOCAL_PLAYLIST_TRACKS_STORAGE_KEY, normalizeTrackMap, readLocalPlaylistTracks),
    hydrateSetting(LOCAL_PLAYLIST_TRACK_ORDER_KEY, normalizeTrackOrderMap, readTrackOrder),
  ]).then((results) => {
    if (!results.some(Boolean)) return;
    refreshLocalPlaylistCaches();
    listeners.forEach((listener) => listener());
  });
}

export function getLocalPlaylists(): LocalPlaylist[] {
  return readLocalPlaylists();
}

export function getLocalPlaylist(id: string): LocalPlaylist | null {
  return readLocalPlaylists().find((playlist) => playlist.id === id) ?? null;
}

export function createLocalPlaylist(name: string): LocalPlaylist {
  const trimmedName = name.trim();
  if (!trimmedName) {
    throw new Error("Playlist name is required.");
  }
  const playlist: LocalPlaylist = {
    id: createId(),
    name: trimmedName,
    paths: [],
  };
  writeLocalPlaylists([playlist, ...readLocalPlaylists()]);
  return playlist;
}

export function renameLocalPlaylist(id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const playlists = readLocalPlaylists();
  const next = playlists.map((playlist) =>
    playlist.id === id ? { ...playlist, name: trimmed } : playlist,
  );
  writeLocalPlaylists(next);
}

export function deleteLocalPlaylist(id: string): void {
  const playlists = readLocalPlaylists().filter((playlist) => playlist.id !== id);
  writeLocalPlaylists(playlists);
  // Clean up stored tracks and order for this playlist
  const tracks = readLocalPlaylistTracks();
  const { [id]: _removedTracks, ...remainingTracks } = tracks;
  writeLocalPlaylistTracks(remainingTracks);
  const order = readTrackOrder();
  const { [id]: _removedOrder, ...remainingOrder } = order;
  writeTrackOrder(remainingOrder);
}

export function addLocalPlaylistPath(id: string, path: string): void {
  const trimmedPath = path.trim();
  if (!trimmedPath) return;
  writeLocalPlaylists(readLocalPlaylists().map((playlist) =>
    playlist.id === id
      ? { ...playlist, paths: Array.from(new Set([...playlist.paths, trimmedPath])) }
      : playlist
  ));
}

export function removeLocalPlaylistPath(id: string, path: string): void {
  writeLocalPlaylists(readLocalPlaylists().map((playlist) =>
    playlist.id === id
      ? { ...playlist, paths: playlist.paths.filter((item) => item !== path) }
      : playlist
  ));
}

export function localPlaylistToPlaylist(playlist: LocalPlaylist): Playlist {
  return {
    id: playlist.id,
    title: playlist.name,
    owner: "Local files",
    kind: "local",
    isEditable: true,
    localPaths: playlist.paths,
  };
}

/**
 * Keeps the OS watching every folder that feeds a local playlist.
 *
 * Re-registered whenever the set of folders changes: the Rust side replaces its watcher
 * wholesale on each call, so this is idempotent and there is nothing to unregister first.
 */
/** Forces every local-playlist subscriber to re-read, e.g. after the watcher reports a change. */
export function notifyLocalPlaylistsChanged(): void {
  // Dropping the cache is what makes the next read hit disk instead of returning stale items.
  cachedRaw = null;
  cachedPlaylistItemsRaw = null;
  listeners.forEach((listener) => listener());
}

export function syncLocalAudioWatcher(): void {
  const paths = Array.from(new Set(readLocalPlaylists().flatMap((playlist) => playlist.paths)));
  void invoke("local_audio_watch", { paths }).catch(() => {
    // Watching is a convenience; a failure must not stop playlists from working.
  });
}

export function getLocalPlaylistItems(): Playlist[] {
  readLocalPlaylists();
  if (cachedPlaylistItemsRaw === cachedRaw) return cachedPlaylistItems;
  cachedPlaylistItemsRaw = cachedRaw;
  cachedPlaylistItems = cachedPlaylists.map(localPlaylistToPlaylist);
  return cachedPlaylistItems;
}

function localTrackId(path: string): string {
  return `local:${btoa(unescape(encodeURIComponent(path)))}`;
}

export function isLocalPlaylist(playlist: Playlist): boolean {
  return playlist.kind === "local" || playlist.id.startsWith(LOCAL_PLAYLIST_PREFIX);
}

function getLocalPlaylistTrackItemId(playlistId: string, track: Track): string {
  return `${LOCAL_PLAYLIST_TRACK_PREFIX}${playlistId}:${track.localPath ?? track.id}`;
}

export function getLocalTracksForPlaylist(playlist: Playlist): Track[] {
  return readLocalPlaylistTracks()[playlist.id] ?? [];
}

export function addLocalTrackToPlaylist(
  track: Track,
  playlist: Playlist,
): "added" | "already-present" {
  if (track.source !== "local" || !track.localPath) {
    throw new Error("Only local songs can be stored locally in playlists.");
  }
  const playlistTracks = readLocalPlaylistTracks();
  const tracks = playlistTracks[playlist.id] ?? [];
  if (tracks.some((item) => item.localPath === track.localPath)) {
    return "already-present";
  }

  const localTrack: Track = {
    ...track,
    source: "local",
    artist: track.artist || "Local files",
    playlistItemId: getLocalPlaylistTrackItemId(playlist.id, track),
  };
  writeLocalPlaylistTracks({
    ...playlistTracks,
    [playlist.id]: [...tracks, localTrack],
  });
  return "added";
}

export function removeLocalTrackFromPlaylist(track: Track, playlist: Playlist): void {
  const playlistTracks = readLocalPlaylistTracks();
  const tracks = playlistTracks[playlist.id] ?? [];
  const nextTracks = tracks.filter((item) => {
    if (track.localPath) return item.localPath !== track.localPath;
    return item.playlistItemId !== track.playlistItemId && item.id !== track.id;
  });

  if (nextTracks.length === tracks.length) return;
  const nextPlaylistTracks = { ...playlistTracks };
  if (nextTracks.length > 0) {
    nextPlaylistTracks[playlist.id] = nextTracks;
  } else {
    delete nextPlaylistTracks[playlist.id];
  }
  writeLocalPlaylistTracks(nextPlaylistTracks);
}

export function reorderLocalPlaylistTracks(
  playlistId: string,
  fromIndex: number,
  toIndex: number,
): void {
  const order = readTrackOrder();
  const playlistOrder = order[playlistId];
  if (!playlistOrder || fromIndex < 0 || fromIndex >= playlistOrder.length) return;

  const nextOrder = [...playlistOrder];
  const [moved] = nextOrder.splice(fromIndex, 1);
  const insertIndex = Math.max(
    0,
    Math.min(fromIndex < toIndex ? toIndex - 1 : toIndex, nextOrder.length),
  );
  nextOrder.splice(insertIndex, 0, moved);
  writeTrackOrder({
    ...order,
    [playlistId]: nextOrder,
  });
}

export async function getLocalPlaylistTrackPage(playlist: Playlist): Promise<TrackPage> {
  const paths = playlist.localPaths ?? getLocalPlaylist(playlist.id)?.paths ?? [];
  if (!paths.length) return { tracks: [], hasMore: false };
  const files = await invoke<LocalAudioFile[]>("local_audio_scan", { paths });
  const scannedTracks: Track[] = files.map((file): Track => ({
    id: localTrackId(file.path),
    source: "local",
    title: file.title,
    artist: "Local files",
    album: file.album,
    durationSec: file.durationSec,
    playlistItemId: file.path,
    localPath: file.path,
  }));

  // Apply saved track order if it exists
  const order = readTrackOrder();
  const savedOrder = order[playlist.id];
  if (savedOrder && savedOrder.length > 0) {
    const trackByPath = new Map(scannedTracks.map((track) => [track.localPath ?? track.id, track]));
    const orderedTracks: Track[] = [];
    const remainingPaths = new Set(scannedTracks.map((track) => track.localPath ?? track.id));

    for (const path of savedOrder) {
      const track = trackByPath.get(path);
      if (track) {
        orderedTracks.push(track);
        remainingPaths.delete(path);
      }
    }

    // Append any tracks that are in the scanned results but not in the saved order
    for (const track of scannedTracks) {
      const key = track.localPath ?? track.id;
      if (remainingPaths.has(key)) {
        orderedTracks.push(track);
      }
    }

    return { tracks: orderedTracks, hasMore: false };
  }

  // Save the initial scan order so reordering works from a known baseline
  writeTrackOrder({
    ...order,
    [playlist.id]: scannedTracks.map((track) => track.localPath ?? track.id),
  });

  return { tracks: scannedTracks, hasMore: false };
}
