/**
 * The window's language: the one chosen in Settings → Appearance, else the computer's. It is set
 * before the app's code loads (`main.tsx`), because the app's words are read once, when their
 * modules load; a new choice therefore reloads the window.
 */
import { setLocale } from "../shared/i18n.ts";
import { isLanguageChoice, type LanguageChoice, Locale, resolveLanguage, SYSTEM_LANGUAGE } from "../shared/locale.ts";
import { loadCatalog } from "../shared/locales/index.ts";
import type { StudioApi } from "../shared/studio-api.ts";
import { readText, STORAGE_KEYS, writeText } from "./storage.ts";

/** The language Settings remembers on this computer; System until one is chosen. */
export function languageChoice(): LanguageChoice {
  const stored = readText(STORAGE_KEYS.language);
  return isLanguageChoice(stored) ? stored : SYSTEM_LANGUAGE;
}

/** A page's view of `window.studio`: the studio's, the Play bar's, or none (a gallery, a test). */
type PageBridge = { studio?: Partial<Pick<StudioApi, "systemLanguages">> };

/**
 * The computer's languages in order: main's list, which its preload carries, so System picks here
 * what it picks for the menus; Chromium's own list (it may hold only Chromium's locale) where main gave none.
 */
function systemTags(): readonly string[] {
  const page = (globalThis as { window?: PageBridge }).window;
  const fromMain = page?.studio?.systemLanguages?.() ?? [];
  return fromMain.length > 0 ? fromMain : (globalThis.navigator?.languages ?? []);
}

/** The language this window speaks for `choice`, with the computer's own list for System. */
export function windowLanguage(choice: LanguageChoice = languageChoice()): Locale {
  return resolveLanguage(choice, systemTags());
}

/**
 * Load the window's language and mark the page with it (screen readers, line breaking and the
 * per-language fonts in theme.css read `lang`). A catalog that cannot load leaves English.
 */
export async function startLanguage(): Promise<Locale> {
  const locale = windowLanguage();
  try {
    setLocale(locale, await loadCatalog(locale));
  } catch {
    setLocale(Locale.English, {});
  }
  document.documentElement.lang = locale;
  return locale;
}

/** Remember `choice`; false when it could not be kept. The caller reloads the window to show it. */
export function rememberLanguage(choice: LanguageChoice): boolean {
  return writeText(STORAGE_KEYS.language, choice);
}

/**
 * Speak `choice`: remember it for this window and tell main (its menus and notifications), then
 * reload, since the app's words are read when it loads. Main missing the news only delays its menu
 * to the next launch.
 */
export async function switchLanguage(
  api: Pick<StudioApi, "setSettings">,
  choice: LanguageChoice,
  reload: () => void = () => window.location.reload(),
): Promise<void> {
  rememberLanguage(choice);
  try {
    await api.setSettings({ language: choice });
  } catch {
    // The window speaks it either way.
  }
  reload();
}

/** Tell main the window's language when they disagree (a choice made before main kept one). */
export async function shareLanguage(api: Pick<StudioApi, "settings" | "setSettings">): Promise<void> {
  const choice = languageChoice();
  const settings = await api.settings();
  if (settings.language !== choice) await api.setSettings({ language: choice });
}
