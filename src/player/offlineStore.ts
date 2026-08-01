import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Track } from "../datasource/types";
import { logInternalError, logInternalInfo, logInternalWarn } from "../internal/logging";
import { getAppSetting, setAppSetting } from "../internal/appSettings";
import { getDownloadQuality, type AudioQuality } from "../internal/audioQuality";

const MANIFEST_KEY = "zuno.offline-manifest.v1";
const MAX_BYTES_KEY = "zuno.offline-max-bytes.v1";

/** Default ceiling for downloaded audio. Roughly 1,500 songs at typical bitrates. */
export const DEFAULT_OFFLINE_MAX_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * One download at a time.
 *
 * Downloads compete with playback for the same connection, and a track that is buffering now
 * matters more than one being saved for later. Serial keeps that contention predictable.
 */
const DOWNLOAD_CONCURRENCY = 1;

export type OfflineStatus = "absent" | "queued" | "downloading" | "ready" | "failed";

export interface OfflineEntry {
  track: Track;
  byteLength: number;
  downloadedAt: number;
}

export interface OfflineState {
  entries: Record<string, OfflineEntry>;
  /** 0-100 for the track currently downloading. Absent when the size is unknown. */
  progress: number | null;
  /** Track ids waiting their turn, in order. */
  queued: string[];
  /**
   * Metadata for everything queued or downloading.
   *
   * Held in state rather than only in the worker's map because the Downloads list and the
   * player bar both need to render a song that has no file yet — an id alone cannot be shown.
   */
  pending: Record<string, Track>;
  downloadingId: string | null;
  failed: Record<string, string>;
  usedBytes: number;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let state: OfflineState = {
  entries: {},
  progress: null,
  pending: {},
  queued: [],
  downloadingId: null,
  failed: {},
  usedBytes: 0,
};
let hydrated = false;
let pumping = false;

function emit(): void {
  for (const listener of listeners) listener();
}

function asManifest(parsed: unknown): Record<string, OfflineEntry> | null {
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, OfflineEntry>
    : null;
}

function readManifest(): Record<string, OfflineEntry> {
  try {
    return asManifest(JSON.parse(localStorage.getItem(MANIFEST_KEY) ?? "{}")) ?? {};
  } catch {
    // A corrupt manifest is rebuilt from disk by reconcile() below.
    return {};
  }
}

/**
 * The same manifest, kept outside webview storage.
 *
 * Downloads are the one thing here that cannot be re-derived: the audio is on disk but the
 * titles and artists that make it playable live only in this manifest, and losing it used to
 * mean the next launch deleted gigabytes as untracked orphans. Local storage is not a safe
 * enough home for that on its own.
 */
async function readDurableManifest(): Promise<Record<string, OfflineEntry>> {
  return asManifest(await getAppSetting<unknown>(MANIFEST_KEY)) ?? {};
}

function writeManifest(entries: Record<string, OfflineEntry>): void {
  try {
    localStorage.setItem(MANIFEST_KEY, JSON.stringify(entries));
  } catch (error) {
    logInternalWarn("offlineStore.writeManifest failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  void setAppSetting(MANIFEST_KEY, entries);
}

function setState(next: Partial<OfflineState>): void {
  state = { ...state, ...next };
  emit();
}

function commitEntries(entries: Record<string, OfflineEntry>): void {
  writeManifest(entries);
  setState({
    entries,
    usedBytes: Object.values(entries).reduce((total, entry) => total + entry.byteLength, 0),
  });
}

export function getOfflineMaxBytes(): number {
  const raw = Number(localStorage.getItem(MAX_BYTES_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_OFFLINE_MAX_BYTES;
}

export function setOfflineMaxBytes(maxBytes: number): void {
  localStorage.setItem(MAX_BYTES_KEY, String(Math.max(0, maxBytes)));
  void prune();
}

/**
 * Matches the manifest against what is actually on disk.
 *
 * Disk decides availability — it is the only thing that determines whether a track will play —
 * but the manifest decides what is *known*, and the two disagreements are not symmetric. An
 * entry with no file is dropped; a file with no entry is only an orphan when there was a
 * manifest to be absent from. No manifest at all reads as a lost manifest rather than an empty
 * library, and deleting the user's downloads on that guess cannot be undone.
 */
export function reconcileManifest(
  manifest: Record<string, OfflineEntry>,
  onDisk: ReadonlyArray<{ trackId: string; byteLength: number }>,
): { entries: Record<string, OfflineEntry>; orphans: string[] } {
  const byId = new Map(onDisk.map((entry) => [entry.trackId, entry.byteLength]));
  const entries: Record<string, OfflineEntry> = {};

  for (const [trackId, entry] of Object.entries(manifest)) {
    const byteLength = byId.get(trackId);
    if (byteLength === undefined) continue;
    entries[trackId] = { ...entry, byteLength };
  }

  const orphans = Object.keys(manifest).length === 0
    ? []
    : [...byId.keys()].filter((trackId) => !entries[trackId]);
  return { entries, orphans };
}

/**
 * Reconciles the manifest against what is actually on disk.
 *
 * The two can drift: a manifest write can fail, the app can be killed mid-download, or the
 * data directory can be cleared out from underneath us.
 */
export async function hydrateOfflineStore(): Promise<void> {
  if (hydrated) return;
  hydrated = true;

  // Both copies, because either one alone can be the survivor: local storage is the hot path,
  // the durable file is what is left when local storage is cleared out from underneath us.
  const manifest = { ...(await readDurableManifest()), ...readManifest() };
  try {
    const onDisk = await invoke<Array<{ trackId: string; byteLength: number }>>(
      "offline_audio_list",
    );
    const { entries, orphans } = reconcileManifest(manifest, onDisk);
    for (const trackId of orphans) {
      void invoke("offline_audio_remove", { trackId }).catch(() => {});
    }

    commitEntries(entries);
    logInternalInfo("offlineStore.hydrate", { count: Object.keys(entries).length });
  } catch (error) {
    logInternalWarn("offlineStore.hydrate failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    commitEntries(manifest);
  }
}

/**
 * Real transfer progress, streamed from Rust.
 *
 * Only the active download reports, because only one runs at a time — keeping a map keyed by
 * track id would be state that can never hold more than one entry.
 */
export function startOfflineProgressFeed(): void {
  void listen<{ trackId: string; percent: number }>("offline-download-progress", (event) => {
    if (event.payload.trackId !== state.downloadingId) return;
    setState({ progress: event.payload.percent });
  });
}

export function getOfflineStatus(trackId: string): OfflineStatus {
  if (state.entries[trackId]) return "ready";
  if (state.downloadingId === trackId) return "downloading";
  if (state.queued.includes(trackId)) return "queued";
  if (state.failed[trackId]) return "failed";
  return "absent";
}

export function isTrackDownloaded(trackId: string): boolean {
  return Boolean(state.entries[trackId]);
}

/**
 * The stored metadata for a downloaded track, or undefined.
 *
 * The manifest keeps the whole Track, not just the id, precisely so playback can name a song
 * with no network — the audio being on disk is useless if the title and artist still require
 * a lookup that cannot happen offline.
 */
export function getOfflineTrack(trackId: string): Track | undefined {
  return state.entries[trackId]?.track;
}

/** Resolves the stream URL for a track. Callers pass this in so the store stays data-source agnostic. */
type StreamUrlResolver = (
  track: Track,
  quality: AudioQuality,
) => Promise<{ url: string; mimeType: string; cookie?: string }>;

let resolveStreamUrl: StreamUrlResolver | null = null;

export function setOfflineStreamResolver(resolver: StreamUrlResolver): void {
  resolveStreamUrl = resolver;
}

export function queueDownload(track: Track): void {
  if (track.source === "local") return;
  if (state.entries[track.id] || state.queued.includes(track.id)) return;
  if (state.downloadingId === track.id) return;

  const { [track.id]: _cleared, ...failed } = state.failed;
  setState({
    queued: [...state.queued, track.id],
    pending: { ...state.pending, [track.id]: track },
    failed,
  });
  pendingTracks.set(track.id, track);
  void pump();
}

export function queueDownloads(tracks: Track[]): void {
  for (const track of tracks) queueDownload(track);
}

export function cancelDownload(trackId: string): void {
  pendingTracks.delete(trackId);
  const { [trackId]: _dropped, ...pending } = state.pending;
  setState({ queued: state.queued.filter((id) => id !== trackId), pending });
}

export async function removeDownload(trackId: string): Promise<void> {
  cancelDownload(trackId);
  try {
    await invoke("offline_audio_remove", { trackId });
  } catch (error) {
    logInternalWarn("offlineStore.remove failed", {
      trackId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const { [trackId]: _removed, ...entries } = state.entries;
  commitEntries(entries);
}

export async function removeAllDownloads(): Promise<void> {
  const ids = Object.keys(state.entries);
  setState({ queued: [], pending: {}, failed: {} });
  pendingTracks.clear();
  for (const trackId of ids) {
    await invoke("offline_audio_remove", { trackId }).catch(() => {});
  }
  commitEntries({});
}

/** Track objects for queued ids, so the worker has metadata without re-fetching. */
const pendingTracks = new Map<string, Track>();

async function pump(): Promise<void> {
  /*
   * `downloadingId` is only ever set by a running pump, so finding it set while none is
   * running means a previous one died mid-flight — a reload during a download, or a throw
   * that escaped. Left alone it would gate every future pump and downloads would silently
   * stop forever, which is exactly the failure this clears.
   */
  if (!pumping && state.downloadingId !== null) {
    logInternalWarn("offlineStore.pump clearing stale download", {
      trackId: state.downloadingId,
    });
    setState({ downloadingId: null, progress: null });
  }

  if (pumping || state.downloadingId !== null) return;
  if (state.queued.length === 0) return;
  if (!resolveStreamUrl) {
    logInternalWarn("offlineStore.pump has no stream resolver");
    return;
  }

  pumping = true;
  try {
    while (state.queued.length > 0) {
      const [trackId, ...rest] = state.queued;
      const track = pendingTracks.get(trackId);
      setState({ queued: rest, downloadingId: trackId, progress: null });

      if (!track) {
        setState({ downloadingId: null, progress: null });
        continue;
      }

      try {
        logInternalInfo("offlineStore.download start", { trackId, title: track.title });
        const { url, mimeType, cookie } = await resolveStreamUrl(track, getDownloadQuality());
        const byteLength = await invoke<number>("offline_audio_save", { url, trackId, cookie });
        logInternalInfo("offlineStore.download complete", { trackId, byteLength });
        pendingTracks.delete(trackId);
        {
          const { [trackId]: _done, ...pending } = state.pending;
          setState({ pending });
        }
        commitEntries({
          ...state.entries,
          [trackId]: { track: { ...track, mimeType }, byteLength, downloadedAt: Date.now() },
        });
        setState({ downloadingId: null, progress: null });
        await prune();
      } catch (error) {
        pendingTracks.delete(trackId);
        const { [trackId]: _failed, ...pending } = state.pending;
        const message = error instanceof Error ? error.message : String(error);
        logInternalError("offlineStore.download failed", error, { trackId });
        setState({
          downloadingId: null,
          progress: null,
          pending,
          failed: { ...state.failed, [trackId]: message },
        });
      }
    }
  } finally {
    pumping = false;
    // DOWNLOAD_CONCURRENCY is 1 today; kept explicit so raising it is a one-line change.
    if (DOWNLOAD_CONCURRENCY > 1 && state.queued.length > 0) void pump();
  }
}

/** Trims the store back under its ceiling, oldest download first. */
async function prune(): Promise<void> {
  const maxBytes = getOfflineMaxBytes();
  if (state.usedBytes <= maxBytes) return;

  try {
    await invoke("offline_audio_prune", { maxBytes });
    const onDisk = await invoke<Array<{ trackId: string; byteLength: number }>>(
      "offline_audio_list",
    );
    const kept = new Set(onDisk.map((entry) => entry.trackId));
    const entries = Object.fromEntries(
      Object.entries(state.entries).filter(([trackId]) => kept.has(trackId)),
    );
    commitEntries(entries);
  } catch (error) {
    logInternalWarn("offlineStore.prune failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getOfflineState(): OfflineState {
  return state;
}

export function useOfflineState(): OfflineState {
  return useSyncExternalStore(subscribe, getOfflineState, getOfflineState);
}
