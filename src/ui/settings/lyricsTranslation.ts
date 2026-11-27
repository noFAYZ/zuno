import { useSyncExternalStore } from "react";

/**
 * Target language for lyric translation, or "off".
 *
 * Off by default and off is a real value, not an absence: translation goes out to a
 * third-party endpoint with the words of whatever is playing, so it happens because someone
 * asked for it rather than because nobody changed a setting.
 */
const STORAGE_KEY = "lyrics-translation-lang";
const CHANGE_EVENT = "lyrics-translation-change";

export const TRANSLATION_OFF = "off";

/** Codes the endpoint accepts; the labels come from the platform, not from a table here. */
export const TRANSLATION_LANGUAGES = [
  "en", "es", "fr", "de", "it", "pt", "ru", "tr", "ar", "hi",
  "ur", "fa", "ja", "ko", "zh-CN", "id", "vi", "th", "pl", "nl", "sv",
];

/**
 * Endonym-ish label via `Intl.DisplayNames` — already in the runtime, always in step with
 * the user's locale, and one less table to leave un-updated.
 */
export function getLanguageLabel(code: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

export function getLyricsTranslationLang(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || TRANSLATION_OFF;
  } catch {
    return TRANSLATION_OFF;
  }
}

export function setLyricsTranslationLang(lang: string): void {
  try {
    if (lang === TRANSLATION_OFF) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // Quota or a locked profile: the choice still applies for this session.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  // Not optional in a multi-window app: without it the other window never sees the change.
  window.addEventListener("storage", listener);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener("storage", listener);
  };
}

export function useLyricsTranslationLang(): string {
  return useSyncExternalStore(subscribe, getLyricsTranslationLang, () => TRANSLATION_OFF);
}
