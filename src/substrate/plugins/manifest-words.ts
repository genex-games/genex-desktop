/**
 * A plugin's manifest in Genex's language. The texts of a plugin.json a person reads (its name and
 * description, setup steps, panel titles, setting and action labels, the confirmations its actions
 * and tools ask with and a card field's label, toolbar labels, why it writes in a folder, its Live
 * tab and runtime names) are looked up by their English in the plugin's own `locales/<lang>.json`,
 * the catalog its panel's words come from. `plugin-sdk/panel-words.mjs` lists them in
 * `messages.json` beside the panel's (its `manifestMessages` keeps to {@link manifestTexts}).
 *
 * Only those texts change: ids, action and tool names, values, capabilities and every other field
 * are the manifest's own. The package is untrusted input: a catalog that is missing, not a JSON
 * object of strings, larger than {@link MANIFEST_CATALOG_MAX_BYTES} or reached through a link out of
 * the package is no translations, and a translation that is not plain text of a fitting length, or
 * that names a stage strip button Genex's own, leaves its English.
 */
import { activeCatalog, type Catalog, messageKey } from "../../shared/i18n.ts";
import { Locale, LOCALES } from "../../shared/locale.ts";
import { OBSERVER_LABEL_CHARS, type PluginObserver } from "../../shared/observers.ts";
import {
  CONFIRMATION_INPUT_LABEL_MAX_CHARS,
  PLUGIN_SETUP_STEP_CHARS,
  type PluginManifest,
  type PluginManifestTool,
} from "../../shared/plugins.ts";
import { isJsonObject, readRegularFile } from "../fsx.ts";
import { containedReal } from "../paths.ts";
import { TOOLBAR_ARIA_CHARS, TOOLBAR_LABEL_CHARS } from "./manifest.ts";
import { GENEX_VIEW_LABELS } from "./observer-manifest.ts";
import { RESERVED_TOOLBAR_LABELS } from "./reserved-labels.ts";

/** The package folder beside plugin.json that holds its translations (`LOCALES_FOLDER` in the SDK). */
export const PLUGIN_LOCALES_FOLDER = "locales";
/** The largest catalog read; a bigger one is no translations. */
export const MANIFEST_CATALOG_MAX_BYTES = 512 * 1024;
/** How many times its English's length a translation may be, and the room a short text always has. */
const TRANSLATION_GROWTH = 3;
const TRANSLATION_ROOM_CHARS = 40;
/** What no translation holds: a control character, a line or paragraph separator, or a text direction mark, override or isolate. */
const UNSAFE_CHARACTER = /[\p{Cc}\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
/** A byte order mark an editor may put before a catalog's JSON. */
const BYTE_ORDER_MARK = /^\uFEFF/;

/** One plugin's translations for one language, by their English. */
export type ManifestCatalog = ReadonlyMap<string, string>;
const NO_WORDS: ManifestCatalog = new Map();

/** What a manifest text's translation must be besides plain text: at most `maxChars`, a name on the stage strip. */
export interface TextRule {
  maxChars?: number;
  /** Trimmed, and none of the names the strip already shows (Studio's buttons, Genex's own Live views). */
  stripName?: boolean;
}

/** A manifest text as the person reads it; an empty text stays empty. */
export type ManifestSay = (english: string, rule?: TextRule) => string;

const SETUP_STEP: TextRule = { maxChars: PLUGIN_SETUP_STEP_CHARS };
const CARD_FIELD: TextRule = { maxChars: CONFIRMATION_INPUT_LABEL_MAX_CHARS };
const TOOLBAR_LABEL: TextRule = { maxChars: TOOLBAR_LABEL_CHARS, stripName: true };
const TOOLBAR_ARIA: TextRule = { maxChars: TOOLBAR_ARIA_CHARS, stripName: true };
const LIVE_TAB: TextRule = { maxChars: OBSERVER_LABEL_CHARS, stripName: true };

/** `manifest` with each text a person reads said by `say`; every other field is the manifest's own. */
export function mapManifestTexts(manifest: PluginManifest, say: ManifestSay): PluginManifest {
  const shown: PluginManifest = {
    ...manifest,
    name: say(manifest.name),
    description: say(manifest.description),
    panels: manifest.panels.map((panel) => ({ ...panel, title: say(panel.title) })),
    settings: manifest.settings.map((setting) => ({ ...setting, label: say(setting.label) })),
    actions: manifest.actions.map((action) => sayAction(action, say)),
    tools: manifest.tools.map((tool) => sayTool(tool, say)),
  };
  if (manifest.setup) shown.setup = manifest.setup.map((step) => say(step, SETUP_STEP));
  if (manifest.toolbar)
    shown.toolbar = manifest.toolbar.map((item) => ({
      ...item,
      label: say(item.label, TOOLBAR_LABEL),
      ariaLabel: say(item.ariaLabel, TOOLBAR_ARIA),
    }));
  if (manifest.folders) shown.folders = manifest.folders.map((folder) => ({ ...folder, why: say(folder.why) }));
  if (manifest.observers) shown.observers = manifest.observers.map((observer) => sayObserver(observer, say));
  if (manifest.nativeRuntimes)
    shown.nativeRuntimes = manifest.nativeRuntimes.map((runtime) => ({ ...runtime, label: say(runtime.label) }));
  return shown;
}

function sayAction(action: PluginManifest["actions"][number], say: ManifestSay): PluginManifest["actions"][number] {
  const shown = { ...action, label: say(action.label) };
  if (action.confirmation !== undefined) shown.confirmation = say(action.confirmation);
  return shown;
}

function sayTool(tool: PluginManifestTool, say: ManifestSay): PluginManifestTool {
  const shown = { ...tool };
  if (tool.confirmation !== undefined) shown.confirmation = say(tool.confirmation);
  if (tool.confirmationInput)
    shown.confirmationInput = { ...tool.confirmationInput, label: say(tool.confirmationInput.label, CARD_FIELD) };
  return shown;
}

function sayObserver(observer: PluginObserver, say: ManifestSay): PluginObserver {
  return observer.label === undefined ? observer : { ...observer, label: say(observer.label, LIVE_TAB) };
}

/** What of a tool its consent card shows. */
type CardTool = Pick<PluginManifestTool, "name" | "confirmation" | "confirmationInput">;

/**
 * `tool`'s card words (its confirmation and its field's label) as `shown` says them, each only while
 * it is the word `declared` gives the same tool: a card Studio words itself keeps its own words.
 */
export function shownCardTool<T extends CardTool>(
  tool: T,
  declared: PluginManifest | undefined,
  shown: PluginManifest | undefined,
): T {
  const own = declared?.tools.find((t) => t.name === tool.name);
  const said = shown?.tools.find((t) => t.name === tool.name);
  if (!own || !said) return tool;
  const card = { ...tool };
  if (tool.confirmation !== undefined && tool.confirmation === own.confirmation) card.confirmation = said.confirmation;
  const input = tool.confirmationInput;
  const label = said.confirmationInput?.label;
  if (input && label && input.label === own.confirmationInput?.label) card.confirmationInput = { ...input, label };
  return card;
}

/** The texts of `manifest` a person reads, each once, in code-unit order: what a catalog translates. */
export function manifestTexts(manifest: PluginManifest): string[] {
  const texts = new Set<string>();
  mapManifestTexts(manifest, (english) => {
    if (english) texts.add(english);
    return english;
  });
  return [...texts].sort();
}

/**
 * The translations for `locale` in the package at `directory` (its `locales/<locale>.json`), or
 * none: English has none, and so has a file that is missing, a link out of the package, not a
 * regular file, too large, or not a JSON object whose every value is a string. Never throws.
 */
export async function readManifestCatalog(directory: string, locale: Locale): Promise<ManifestCatalog> {
  if (locale === Locale.English || !LOCALES.includes(locale)) return NO_WORDS;
  try {
    const file = await containedReal(directory, `${PLUGIN_LOCALES_FOLDER}/${locale}.json`);
    const text = (await readRegularFile(file, MANIFEST_CATALOG_MAX_BYTES)).toString("utf8");
    return catalogOf(JSON.parse(text.replace(BYTE_ORDER_MARK, "")));
  } catch {
    return NO_WORDS;
  }
}

/** A parsed catalog's translations, its empty ones left out; none for anything but an object of strings. */
function catalogOf(value: unknown): ManifestCatalog {
  if (!isJsonObject(value)) return NO_WORDS;
  const entries = Object.entries(value);
  const allText = entries.every((entry): entry is [string, string] => typeof entry[1] === "string");
  return allText ? new Map(entries.filter(([, said]) => said !== "")) : NO_WORDS;
}

/** `catalog`'s words for a manifest's texts: each translation that fits its text's rule, else the English. */
export function catalogSay(catalog: ManifestCatalog): ManifestSay {
  return (english, rule = {}) => {
    const said = english ? catalog.get(english) : undefined;
    if (said === undefined || !fits(english, said, rule)) return english;
    return rule.stripName && stripNamesTaken().has(said.toLowerCase()) ? english : said;
  };
}

/**
 * Whether `said` may stand for `english`: words, not blank; no longer than its rule allows and
 * {@link TRANSLATION_GROWTH} times its English (or {@link TRANSLATION_ROOM_CHARS}); a line break
 * only where its English has one; no other control or text direction character; a strip name trimmed.
 */
function fits(english: string, said: string, rule: TextRule): boolean {
  const room = Math.min(
    rule.maxChars ?? Number.POSITIVE_INFINITY,
    Math.max(TRANSLATION_ROOM_CHARS, english.length * TRANSLATION_GROWTH),
  );
  const multiline = english.includes("\n");
  const plain = !UNSAFE_CHARACTER.test(multiline ? said.replaceAll("\n", "") : said);
  const trimmed = !rule.stripName || said.trim() === said;
  return said.trim() !== "" && said.length <= room && plain && trimmed;
}

/** The strip's own names, lowercased, as `stripNamesTaken` last read them for one catalog. */
let taken: { catalog: Catalog; names: ReadonlySet<string> } | undefined;

/**
 * The names the stage strip already shows, lowercased: Studio's own buttons and Genex's own Live
 * views, in English and as the app's language says them (with any context).
 */
function stripNamesTaken(): ReadonlySet<string> {
  const catalog = activeCatalog();
  if (taken?.catalog === catalog) return taken.names;
  const english = [...RESERVED_TOOLBAR_LABELS, ...GENEX_VIEW_LABELS];
  const names = new Set(english.map((name) => name.toLowerCase()));
  for (const name of english) {
    // The end of the key a message with any context has: the separator and the English.
    const inContext = messageKey(" ", name).slice(1);
    for (const [key, said] of Object.entries(catalog))
      if (key === name || key.endsWith(inContext)) names.add(said.toLowerCase());
  }
  taken = { catalog, names };
  return names;
}

/**
 * Each package's catalogs, read once per language. Keyed by the package folder, so an update (a new
 * copy) reads its own; {@link forget} drops them all when a plugin changes.
 */
export class ManifestWords {
  #read = new Map<string, Map<Locale, Promise<ManifestCatalog>>>();

  /** The words of the package at `directory` in `locale`. */
  async say(directory: string, locale: Locale): Promise<ManifestSay> {
    return catalogSay(await this.#catalog(directory, locale));
  }

  /** `manifest`, of the package at `directory`, as a person reads it in `locale`. */
  async manifest(manifest: PluginManifest, directory: string, locale: Locale): Promise<PluginManifest> {
    if (locale === Locale.English) return manifest;
    return mapManifestTexts(manifest, await this.say(directory, locale));
  }

  /** Read every catalog again when next asked: a package was installed, updated, reloaded or removed. */
  forget(): void {
    this.#read.clear();
  }

  #catalog(directory: string, locale: Locale): Promise<ManifestCatalog> {
    let catalogs = this.#read.get(directory);
    if (!catalogs) {
      catalogs = new Map();
      this.#read.set(directory, catalogs);
    }
    let catalog = catalogs.get(locale);
    if (!catalog) {
      catalog = readManifestCatalog(directory, locale);
      catalogs.set(locale, catalog);
    }
    return catalog;
  }
}
