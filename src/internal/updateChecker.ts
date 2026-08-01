import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { logInternalError } from "./logging";

const RELEASE_TAG_PREFIX = "v";
const RELEASES_URL =
  "https://github.com/noFAYZ/zuno/releases/tag";
const RELEASES_API_URL =
  "https://api.github.com/repos/noFAYZ/zuno/releases/latest";
const SNOOZE_PREFIX = "just-another-music-client:update-snooze:";
const SNOOZE_DURATION_MS = 24 * 60 * 60 * 1000;

export interface UpdateInfo {
  installedVersion: string;
  version: string;
  releaseUrl: string;
  canInstall: boolean;
  update?: Update;
}

export interface UpdateInstallProgress {
  downloadedBytes: number;
  totalBytes?: number;
  percent?: number;
}

export async function getInstalledVersion(): Promise<string> {
  return getVersion();
}

function parseVersion(version: string): number[] {
  return version.replace(/^v/, "").split(".").map(Number);
}

function isNewerVersion(installed: string, candidate: string): boolean {
  const installedParts = parseVersion(installed);
  const candidateParts = parseVersion(candidate);
  for (let i = 0; i < Math.max(installedParts.length, candidateParts.length); i++) {
    const a = installedParts[i] ?? 0;
    const b = candidateParts[i] ?? 0;
    if (b > a) return true;
    if (b < a) return false;
  }
  return false;
}

async function checkViaGithubApi(): Promise<UpdateInfo | null> {
  try {
    const response = await fetch(RELEASES_API_URL);
    if (!response.ok) return null;
    const data = await response.json() as { tag_name?: string };
    const tagName = data.tag_name ?? "";
    const latestVersion = tagName.replace(RELEASE_TAG_PREFIX, "");
    const installedVersion = await getVersion();

    if (!latestVersion || !isNewerVersion(installedVersion, latestVersion)) {
      return null;
    }

    return {
      installedVersion,
      version: latestVersion,
      releaseUrl: `${RELEASES_URL}/${encodeURIComponent(tagName || latestVersion)}`,
      canInstall: false,
    };
  } catch {
    return null;
  }
}

export async function checkForUpdates(): Promise<UpdateInfo | null> {
  const isMacOS =
    typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent);

  if (isMacOS) {
    return checkViaGithubApi();
  }

  let update: Update | null;
  try {
    update = await check();
  } catch (error) {
    logInternalError("updateChecker.checkForUpdates failed", error);
    throw error;
  }

  if (!update) return null;

  return {
    installedVersion: update.currentVersion,
    version: update.version,
    releaseUrl: `${RELEASES_URL}/${RELEASE_TAG_PREFIX}${encodeURIComponent(update.version)}`,
    canInstall: true,
    update,
  };
}

export async function installUpdate(
  info: UpdateInfo,
  onProgress?: (progress: UpdateInstallProgress) => void,
): Promise<void> {
  if (!info.update) {
    throw new Error(
      "This update cannot be installed automatically. Please download it from the release page.",
    );
  }

  let downloadedBytes = 0;
  let totalBytes: number | undefined;

  const reportProgress = (event: DownloadEvent) => {
    if (event.event === "Started") {
      downloadedBytes = 0;
      totalBytes = event.data.contentLength;
    } else if (event.event === "Progress") {
      downloadedBytes += event.data.chunkLength;
    } else if (event.event === "Finished" && totalBytes !== undefined) {
      downloadedBytes = totalBytes;
    }

    onProgress?.({
      downloadedBytes,
      totalBytes,
      percent: totalBytes && totalBytes > 0
        ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
        : undefined,
    });
  };

  try {
    await info.update.downloadAndInstall(reportProgress);
    await relaunch();
  } catch (error) {
    logInternalError("updateChecker.installUpdate failed", error, {
      version: info.version,
    });
    throw error;
  }
}

export function getUpdateFailureMessage(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage.trim();

  if (!message) {
    return "Unable to check for updates. The updater did not return an error message.";
  }

  return `Unable to check for updates: ${message}`;
}

export function isUpdateSnoozed(version: string): boolean {
  const snoozedUntil = Number(localStorage.getItem(`${SNOOZE_PREFIX}${version}`));
  return Number.isFinite(snoozedUntil) && snoozedUntil > Date.now();
}

export function snoozeUpdate(version: string): void {
  localStorage.setItem(
    `${SNOOZE_PREFIX}${version}`,
    String(Date.now() + SNOOZE_DURATION_MS),
  );
}
