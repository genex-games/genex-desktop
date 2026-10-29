/**
 * Main's language: the menus, dialogs and notifications speak the one chosen in Settings, else
 * the computer's. A window loads its own copy before main answers (`renderer/language.ts`), and
 * resolves System from the list main hands its preload ({@link pageLanguageArguments}): Chromium's
 * own list may hold only the locale Chromium picked, so the two would otherwise disagree.
 */
import { app } from "electron";
import { currentLocale, setLocale } from "../shared/i18n.ts";
import { computerLanguages, Locale, resolveLanguage, systemLanguagesArgument } from "../shared/locale.ts";
import { loadCatalog } from "../shared/locales/index.ts";

/** The computer's languages in order, or the one a launch pinned with `--lang` (`computerLanguages`). */
export function systemLanguages(): string[] {
  return computerLanguages({
    pinned: app.commandLine.getSwitchValue("lang"),
    preferred: app.getPreferredSystemLanguages(),
    locale: app.getLocale(),
    systemLocale: app.getSystemLocale(),
  });
}

/** A studio page's `additionalArguments`: the computer's languages, for its System. */
export function pageLanguageArguments(): string[] {
  return [systemLanguagesArgument(systemLanguages())];
}

/**
 * Speak `choice` from now on; true when the language changed, so the caller rebuilds what it drew
 * in the old one (the menu). A catalog that cannot load leaves English.
 */
export async function applyMainLanguage(choice: unknown): Promise<boolean> {
  const before = currentLocale();
  const locale = resolveLanguage(choice, systemLanguages());
  try {
    setLocale(locale, await loadCatalog(locale));
  } catch {
    setLocale(Locale.English, {});
  }
  return currentLocale() !== before;
}
