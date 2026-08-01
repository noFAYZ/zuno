/**
 * Central icon module — every icon in the app is imported from here.
 *
 * Convention (see docs/solarIcons.md):
 *   - Default export  = Solar **Linear** (stroked, strokeWidth 1.5) for resting/secondary state.
 *   - `*ActiveIcon`   = Solar **Bold** (filled) for active/primary state — playing, liked,
 *                       saved, selected. The weight change is the state signal.
 *
 * Single-icon import paths are used deliberately: importing the style barrel
 * (`@solar-icons/react/linear`) makes the dev server resolve ~1.2k modules per style.
 *
 * Routing every icon through one file means a renamed or missing Solar icon breaks
 * this module alone, not the 27 component files that consume it.
 */

import type { SVGProps } from "react";

/* ── Transport ─────────────────────────────────────────────────────── */
export { PlayIcon } from "@solar-icons/react/linear/play";
export { PlayIcon as PlayActiveIcon } from "@solar-icons/react/bold/play";
export { PauseIcon } from "@solar-icons/react/linear/pause";
export { PauseIcon as PauseActiveIcon } from "@solar-icons/react/bold/pause";
export { SkipNextIcon } from "@solar-icons/react/linear/skip-next";
export { SkipNextIcon as SkipNextActiveIcon } from "@solar-icons/react/bold/skip-next";
export { SkipPreviousIcon } from "@solar-icons/react/linear/skip-previous";
export { SkipPreviousIcon as SkipPreviousActiveIcon } from "@solar-icons/react/bold/skip-previous";

/* ── Playback order ────────────────────────────────────────────────── */
export { ShuffleIcon } from "@solar-icons/react/linear/shuffle";
export { ShuffleIcon as ShuffleActiveIcon } from "@solar-icons/react/bold/shuffle";
export { RepeatIcon } from "@solar-icons/react/linear/repeat";
export { RepeatIcon as RepeatActiveIcon } from "@solar-icons/react/bold/repeat";
export { RepeatOneIcon } from "@solar-icons/react/linear/repeat-one";
export { RepeatOneIcon as RepeatOneActiveIcon } from "@solar-icons/react/bold/repeat-one";

/* ── Volume ────────────────────────────────────────────────────────── */
export { VolumeLoudIcon } from "@solar-icons/react/linear/volume-loud";
export { VolumeLoudIcon as VolumeLoudActiveIcon } from "@solar-icons/react/bold/volume-loud";
export { VolumeSmallIcon } from "@solar-icons/react/linear/volume-small";
export { VolumeCrossIcon as VolumeMutedIcon } from "@solar-icons/react/linear/volume-cross";
export { VolumeCrossIcon as VolumeMutedActiveIcon } from "@solar-icons/react/bold/volume-cross";

/* ── Library state (like / save / rate) ────────────────────────────── */
export { HeartIcon } from "@solar-icons/react/linear/heart";
export { DislikeIcon } from "@solar-icons/react/linear/dislike";
export { DislikeIcon as DislikeActiveIcon } from "@solar-icons/react/bold/dislike";
export { HeartIcon as HeartActiveIcon } from "@solar-icons/react/bold/heart";
export { HeartCrackIcon as HeartBrokenIcon } from "@solar-icons/react/linear/heart-crack";
export { BookmarkIcon } from "@solar-icons/react/linear/bookmark";
export { BookmarkIcon as BookmarkActiveIcon } from "@solar-icons/react/bold/bookmark";
export { StarIcon } from "@solar-icons/react/linear/star";
export { StarIcon as StarActiveIcon } from "@solar-icons/react/bold/star";

/* ── Content types ─────────────────────────────────────────────────── */
export { MusicNoteIcon } from "@solar-icons/react/linear/music-note";
export { MusicNoteIcon as MusicNoteActiveIcon } from "@solar-icons/react/bold/music-note";
export { PlaylistIcon } from "@solar-icons/react/linear/playlist";
export { PlaylistIcon as PlaylistActiveIcon } from "@solar-icons/react/bold/playlist";
export { PlaylistMinimalisticIcon as PlaylistAddIcon } from "@solar-icons/react/linear/playlist-minimalistic";
export { VinylIcon as AlbumIcon } from "@solar-icons/react/linear/vinyl";
export { VinylIcon as AlbumActiveIcon } from "@solar-icons/react/bold/vinyl";
export { Microphone2Icon as LyricsIcon } from "@solar-icons/react/linear/microphone-2";
export { Microphone2Icon as LyricsActiveIcon } from "@solar-icons/react/bold/microphone-2";

/* ── Files & folders (local music) ─────────────────────────────────── */
export { FolderIcon } from "@solar-icons/react/linear/folder";
export { FolderOpenIcon } from "@solar-icons/react/linear/folder-open";
export { AddFolderIcon as FolderAddIcon } from "@solar-icons/react/linear/add-folder";
export { DocumentTextIcon as LogFileIcon } from "@solar-icons/react/linear/document-text";

/* ── Navigation & chrome ───────────────────────────────────────────── */
export { Home2Icon as HomeIcon } from "@solar-icons/react/linear/home-2";
export { Home2Icon as HomeActiveIcon } from "@solar-icons/react/bold/home-2";
export { SidebarMinimalisticIcon as QueuePanelIcon } from "@solar-icons/react/linear/sidebar-minimalistic";
export { MagnifierIcon as SearchIcon } from "@solar-icons/react/linear/magnifier";
export { CompassIcon } from "@solar-icons/react/linear/compass";
export { PaletteIcon } from "@solar-icons/react/linear/palette";
export { PaletteIcon as PaletteActiveIcon } from "@solar-icons/react/bold/palette";
export { SettingsIcon } from "@solar-icons/react/linear/settings";
export { SettingsIcon as SettingsActiveIcon } from "@solar-icons/react/bold/settings";
export { ListIcon } from "@solar-icons/react/linear/list";
export { SortIcon } from "@solar-icons/react/linear/sort";
export { CloseCircleIcon as CloseIcon } from "@solar-icons/react/linear/close-circle";
export { CloseCircleIcon as CloseActiveIcon } from "@solar-icons/react/bold/close-circle";
export { AddCircleIcon as PlusIcon } from "@solar-icons/react/linear/add-circle";
export { CheckCircleIcon as CheckIcon } from "@solar-icons/react/linear/check-circle";
export { CheckCircleIcon as CheckActiveIcon } from "@solar-icons/react/bold/check-circle";
export { RefreshIcon } from "@solar-icons/react/linear/refresh";
export { DownloadMinimalisticIcon as DownloadIcon } from "@solar-icons/react/linear/download-minimalistic";
export { TrashBinTrashIcon as TrashIcon } from "@solar-icons/react/linear/trash-bin-trash";
export { CopyIcon } from "@solar-icons/react/linear/copy";
export { PenIcon as PencilIcon } from "@solar-icons/react/linear/pen";
export { LinkIcon } from "@solar-icons/react/linear/link";

/* ── Arrows ────────────────────────────────────────────────────────── */
export { ArrowUpIcon } from "@solar-icons/react/linear/arrow-up";
export { ArrowDownIcon } from "@solar-icons/react/linear/arrow-down";
export { ArrowLeftIcon } from "@solar-icons/react/linear/arrow-left";
export { ArrowRightIcon } from "@solar-icons/react/linear/arrow-right";
export { AltArrowDownIcon as ChevronDownIcon } from "@solar-icons/react/linear/alt-arrow-down";

/* ── Account & settings surfaces ───────────────────────────────────── */
export { UserIcon } from "@solar-icons/react/linear/user";
export { UserIcon as UserActiveIcon } from "@solar-icons/react/bold/user";
export { UserPlusIcon } from "@solar-icons/react/linear/user-plus";
export { Login2Icon as LoginIcon } from "@solar-icons/react/linear/login-2";
export { GlobalIcon } from "@solar-icons/react/linear/global";
export { Logout2Icon as LogoutIcon } from "@solar-icons/react/linear/logout-2";
export { KeyIcon } from "@solar-icons/react/linear/key";
export { BugIcon } from "@solar-icons/react/linear/bug";
export { ClockCircleIcon as ClockIcon } from "@solar-icons/react/linear/clock-circle";
export { SpeedometerMaxIcon as SpeedIcon } from "@solar-icons/react/linear/speedometer-max";
export { CupHotIcon as CoffeeIcon } from "@solar-icons/react/linear/cup-hot";
export { MagicWandIcon as DiceIcon } from "@solar-icons/react/linear/magic-wand";
export { MagicWandIcon as DiceActiveIcon } from "@solar-icons/react/bold/magic-wand";

/**
 * YouTube Music brand mark.
 *
 * Same reasoning as `GitHubIcon` and `LastFmIcon`: Solar ships no brand icons, and the header
 * indicator has to be recognisable as YouTube Music rather than a generic play glyph sitting
 * next to the Last.fm and Discord marks.
 * Path from Simple Icons (CC0), sized/coloured like a Solar icon.
 */
export function YouTubeMusicIcon({ size = 24, ...props }: SVGProps<SVGSVGElement> & { size?: number | string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M12 0C5.376 0 0 5.376 0 12s5.376 12 12 12 12-5.376 12-12S18.624 0 12 0zm0 19.104c-3.924 0-7.104-3.18-7.104-7.104S8.076 4.896 12 4.896s7.104 3.18 7.104 7.104-3.18 7.104-7.104 7.104zm0-13.332c-3.432 0-6.228 2.796-6.228 6.228S8.568 18.228 12 18.228s6.228-2.796 6.228-6.228S15.432 5.772 12 5.772zM9.6 15.6V8.4l6 3.6-6 3.6z" />
    </svg>
  );
}

/**
 * GitHub brand mark.
 *
 * Same reasoning as `LastFmIcon` below: Solar ships no brand icons, and a brand mark has to
 * stay recognisable rather than be approximated by a generic glyph.
 * Path from Simple Icons (CC0), sized/coloured like a Solar icon.
 */
export function GitHubIcon({ size = 24, ...props }: SVGProps<SVGSVGElement> & { size?: number | string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

/**
 * Google "G" mark, in its four brand colours.
 *
 * The one icon here that deliberately ignores `currentColor`: the G is only the G when it is
 * those four colours, and a monochrome version of it reads as a generic glyph. It sits on the
 * sign-in button, where the whole point is that it is recognisably Google's — the account
 * being signed into really is a Google account.
 * Paths are Google's published mark, sized like a Solar icon.
 */
export function GoogleIcon({ size = 24, ...props }: SVGProps<SVGSVGElement> & { size?: number | string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
      {...props}
    >
      <path
        fill="#4285F4"
        d="M23.52 12.273c0-.851-.076-1.67-.218-2.455H12v4.642h6.458a5.52 5.52 0 0 1-2.396 3.622v3.01h3.878c2.269-2.089 3.58-5.165 3.58-8.819Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.956-1.075 7.94-2.908l-3.878-3.01c-1.075.72-2.45 1.145-4.062 1.145-3.125 0-5.77-2.11-6.714-4.945H1.276v3.109A11.995 11.995 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.286 14.282A7.212 7.212 0 0 1 4.91 12c0-.792.136-1.562.376-2.282V6.609H1.276A11.995 11.995 0 0 0 0 12c0 1.936.464 3.769 1.276 5.391l4.01-3.109Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.773c1.762 0 3.344.605 4.587 1.794l3.442-3.442C17.951 1.19 15.235 0 12 0 7.309 0 3.251 2.69 1.276 6.609l4.01 3.109C6.23 6.882 8.875 4.773 12 4.773Z"
      />
    </svg>
  );
}

/**
 * Discord brand mark.
 *
 * Same reasoning as the other two brand marks here: Solar ships none, and a brand has to stay
 * recognisable rather than be stood in for by a generic chat glyph.
 * Path from Simple Icons (CC0), sized/coloured like a Solar icon.
 */
export function DiscordIcon({ size = 24, ...props }: SVGProps<SVGSVGElement> & { size?: number | string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  );
}

/**
 * Last.fm brand mark.
 *
 * Solar ships no brand icons, and a brand mark must stay recognisable — so this one stays
 * a hand-rolled SVG rather than being approximated by a generic music glyph.
 * Path from Simple Icons (CC0). Sized/coloured like a Solar icon so it drops into the same slots.
 */
export function LastFmIcon({ size = 24, ...props }: SVGProps<SVGSVGElement> & { size?: number | string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      {...props}
    >
      <path d="M10.584 17.21l-.88-2.392s-1.43 1.594-3.573 1.594c-1.897 0-3.244-1.649-3.244-4.288 0-3.382 1.704-4.591 3.381-4.591 2.42 0 3.189 1.567 3.849 3.574l.88 2.749c.88 2.666 2.529 4.81 7.285 4.81 3.409 0 5.718-1.044 5.718-3.793 0-2.227-1.265-3.381-3.62-3.932l-1.757-.385c-1.21-.275-1.567-.77-1.567-1.594 0-.934.742-1.485 1.952-1.485 1.32 0 2.034.495 2.144 1.677l2.749-.33c-.22-2.474-1.924-3.492-4.729-3.492-2.474 0-4.893.935-4.893 3.932 0 1.87.907 3.051 3.189 3.602l1.87.44c1.402.33 1.869.907 1.869 1.694 0 1.017-.99 1.43-2.86 1.43-2.776 0-3.93-1.457-4.59-3.464l-.907-2.749c-1.155-3.573-3-4.893-6.653-4.893C2.008 5.977 0 8.424 0 12.597c0 4.013 2.063 6.184 5.774 6.184 2.997 0 4.435-1.402 4.435-1.402l.375-.169z" />
    </svg>
  );
}
