/**
 * The languages Genex speaks and how a computer's language list picks one. Browser-safe: main
 * resolves the menus' language with it, the renderer the window's.
 */

/** Every language the app is translated into, by its BCP 47 tag. English is the source. */
export const Locale = {
  English: "en",
  Russian: "ru",
  Spanish: "es",
  PortugueseBrazil: "pt-BR",
  German: "de",
  French: "fr",
  Japanese: "ja",
  Korean: "ko",
  ChineseSimplified: "zh-Hans",
} as const;
export type Locale = (typeof Locale)[keyof typeof Locale];

/** The languages in the order the switcher lists them. */
export const LOCALES: readonly Locale[] = Object.values(Locale);

/** Each language's own name, as the switcher shows it to a person who reads only that language. */
export const LOCALE_NAMES = {
  [Locale.English]: "English",
  [Locale.Russian]: "Русский",
  [Locale.Spanish]: "Español",
  [Locale.PortugueseBrazil]: "Português (Brasil)",
  [Locale.German]: "Deutsch",
  [Locale.French]: "Français",
  [Locale.Japanese]: "日本語",
  [Locale.Korean]: "한국어",
  [Locale.ChineseSimplified]: "简体中文",
} as const satisfies Record<Locale, string>;

/** The choice that follows the computer's own language. */
export const SYSTEM_LANGUAGE = "system" as const;
/** What Settings remembers: a language, or the computer's. */
export type LanguageChoice = Locale | "system";

/** Whether a stored value is a choice this version understands. */
export function isLanguageChoice(value: unknown): value is LanguageChoice {
  return value === SYSTEM_LANGUAGE || LOCALES.includes(value as Locale);
}

/** Traditional Chinese tags: Simplified would read as foreign there, so they fall through to the next language. */
const TRADITIONAL_CHINESE = /^zh-(?:hant|tw|hk|mo)\b/;

/**
 * A tag as one system or another writes it, as a BCP 47 tag in lower case: macOS and Windows write
 * "ja-JP" or "zh-Hans-CN", Linux "ja_JP.UTF-8" or "pt_PT@euro" (its codeset and modifier dropped).
 */
function plainTag(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[.@].*$/, "");
}

/** The supported language one plain tag names ("ru-ru" → ru, "pt-pt" → pt-BR, "zh-cn" → zh-Hans), or none. */
function localeForTag(lower: string): Locale | undefined {
  if (!lower) return undefined;
  const exact = LOCALES.find((locale) => locale.toLowerCase() === lower);
  if (exact) return exact;
  if (TRADITIONAL_CHINESE.test(lower)) return undefined;
  const language = lower.split("-")[0];
  if (language === "zh") return Locale.ChineseSimplified;
  if (language === "pt") return Locale.PortugueseBrazil;
  return LOCALES.find((locale) => locale === language);
}

/**
 * The first supported language in a computer's preference list; English when none is. A bare "zh"
 * after a Traditional Chinese tag is that same locale (glibc lists "zh_TW.UTF-8", "zh_TW", "zh"),
 * so it falls through too.
 */
export function matchLocale(tags: readonly string[]): Locale {
  let traditional = false;
  for (const tag of tags) {
    const plain = plainTag(tag);
    if (TRADITIONAL_CHINESE.test(plain)) traditional = true;
    if (traditional && plain === "zh") continue;
    const locale = localeForTag(plain);
    if (locale) return locale;
  }
  return Locale.English;
}

/** What a computer says about its languages, as Electron reads them. */
export interface ComputerLanguages {
  /** A `--lang` the launch pinned (fixture and test launches), or "". */
  pinned: string;
  /** `app.getPreferredSystemLanguages()`: the person's languages in order. */
  preferred: readonly string[];
  /** `app.getLocale()`: the locale Chromium picked from them. */
  locale: string;
  /** `app.getSystemLocale()`: the region's locale. */
  systemLocale: string;
}

/**
 * The computer's languages in order: a pinned `--lang` alone, else the person's list; Chromium's
 * locale and the region's only when the system gives no list (some Linux desktops).
 */
export function computerLanguages({ pinned, preferred, locale, systemLocale }: ComputerLanguages): string[] {
  if (pinned) return [pinned];
  const listed = preferred.filter(Boolean);
  return listed.length > 0 ? listed : [locale, systemLocale].filter(Boolean);
}

/** The page argument that carries the computer's languages from main to a studio page's preload. */
const SYSTEM_LANGUAGES_SWITCH = "--genex-system-languages=";
/** The most languages carried: a person lists a handful, and the argument stays short. */
const MAX_SYSTEM_LANGUAGES = 16;
/** A plain language tag: letters, then `-` parts; never a comma or a space. */
const LANGUAGE_TAG = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/;

/**
 * Up to {@link MAX_SYSTEM_LANGUAGES} of `tags` as plain tags ({@link plainTag}: "ja_JP.UTF-8" →
 * "ja-jp"), in order and once each, the rest dropped: they read as the same language main reads them as.
 */
function languageTags(tags: readonly string[]): string[] {
  const plain = tags.map(plainTag).filter((tag) => LANGUAGE_TAG.test(tag));
  // Once each, before the cap: glibc spells a language four ways, which would crowd out the rest.
  return [...new Set(plain)].slice(0, MAX_SYSTEM_LANGUAGES);
}

/**
 * The argument main adds to a studio page (`additionalArguments`) with the computer's languages in
 * order, so the page's System is main's: Chromium's own list may hold only the locale it picked.
 */
export function systemLanguagesArgument(tags: readonly string[]): string {
  return `${SYSTEM_LANGUAGES_SWITCH}${languageTags(tags).join(",")}`;
}

/** The computer's languages a page's arguments (`process.argv` in its preload) carry from main; none when absent. */
export function systemLanguagesFromArgs(args: readonly string[]): string[] {
  const carried = args.find((arg) => arg.startsWith(SYSTEM_LANGUAGES_SWITCH));
  return carried ? languageTags(carried.slice(SYSTEM_LANGUAGES_SWITCH.length).split(",")) : [];
}

/** The language a choice means on this computer: a set language, or the computer's own. */
export function resolveLanguage(choice: unknown, systemTags: readonly string[]): Locale {
  if (isLanguageChoice(choice) && choice !== SYSTEM_LANGUAGE) return choice;
  return matchLocale(systemTags);
}
