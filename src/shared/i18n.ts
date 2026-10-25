/**
 * The app's words in the reader's language. Every sentence a person reads is written once, in
 * English, as `t("Publish your game")`; the English is the key a translation is looked up by, so
 * the code reads as the screen does. A missing translation shows the English.
 *
 * Words that change with a number or a choice use the ICU message syntax every translator knows:
 * `t("{count, plural, one {# game} other {# games}}", { count })`. Each language brings its own
 * plural forms (Russian has four), so a sentence is never assembled from English pieces.
 *
 * Browser-safe and without state beyond the active language: the renderer sets it before the app
 * loads (`renderer/language.ts`), main when it starts and whenever Settings changes it.
 */
import { Locale } from "./locale.ts";

/** Values a message's `{placeholders}` take. */
export type MessageParams = Readonly<Record<string, string | number>>;

/** One language's translations, keyed by the English (with its context, see {@link messageKey}). */
export type Catalog = Readonly<Record<string, string>>;

/** Joins a context to its English in a catalog key, as gettext does. */
const CONTEXT_SEPARATOR = "\u0004";

/** The active language, in one slot per process: a plugin backend bundles its own copy of this module, and its host's bootstrap sets the language there. */
interface LanguageSlot {
  locale: Locale;
  catalog: Catalog;
}
const SLOT = Symbol.for("genex.language");
const parsed = new Map<string, MessageNode[]>();
const pluralRules = new Map<Locale, Intl.PluralRules>();

function slot(): LanguageSlot {
  const holder = globalThis as { [SLOT]?: LanguageSlot };
  holder[SLOT] ??= { locale: Locale.English, catalog: {} };
  return holder[SLOT];
}

/** Make `locale` the language every following `t` answers in. */
export function setLocale(locale: Locale, catalog: Catalog): void {
  const current = slot();
  current.locale = locale;
  current.catalog = locale === Locale.English ? {} : catalog;
}

/** The language `t` answers in. */
export function currentLocale(): Locale {
  return slot().locale;
}

/** The active language's translations, for a process that has none of its own (a plugin backend). */
export function activeCatalog(): Catalog {
  return slot().catalog;
}

/**
 * The locale dates and numbers are written in: the computer's own while the app is in English
 * (an English app on a German Mac keeps German dates, as it always has), the app's otherwise.
 */
export function intlLocale(): string | undefined {
  const locale = currentLocale();
  return locale === Locale.English ? undefined : locale;
}

/** The catalog key of `source` said in `context`; the bare English when there is no context. */
export function messageKey(context: string | undefined, source: string): string {
  return context ? `${context}${CONTEXT_SEPARATOR}${source}` : source;
}

/** `source` (English, ICU syntax) in the active language, its placeholders filled in. */
export function t(source: string, params?: MessageParams): string {
  return translate(source, source, params);
}

/**
 * `source` in the active language where the same English needs different words in different
 * places: "Play" the tab and "Play" the button can differ in German.
 */
export function tc(context: string, source: string, params?: MessageParams): string {
  return translate(messageKey(context, source), source, params);
}

/** The translation of `key`, filled in; the English when there is none or it cannot be read. */
function translate(key: string, source: string, params: MessageParams | undefined): string {
  const { locale, catalog } = slot();
  const translation = catalog[key];
  if (translation) {
    try {
      return formatMessage(translation, params, locale);
    } catch {
      // A catalog with a broken message shows that one message in English, never an error.
    }
  }
  return formatMessage(source, params, Locale.English);
}

/** "a, b and c" in the active language. English keeps the app's own form: no comma before "and". */
export function formatList(items: readonly string[]): string {
  const locale = currentLocale();
  if (locale === Locale.English) {
    if (items.length < 2) return items.join("");
    return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  }
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(items);
}

// ---------------------------------------------------------------------------------------------
// ICU message syntax: plain text, {name}, {name, number}, {name, plural, …} with `#` and =N
// cases, and {name, select, …}. Apostrophes quote only before syntax characters, as in ICU, so
// "Couldn't" needs no escaping and '{' writes a brace.
// ---------------------------------------------------------------------------------------------

/** A parsed piece of a message. */
export type MessageNode =
  | string
  | { kind: "arg"; name: string }
  | { kind: "number"; name: string }
  | { kind: "pound" }
  | { kind: "plural"; name: string; cases: ReadonlyMap<string, MessageNode[]> }
  | { kind: "select"; name: string; cases: ReadonlyMap<string, MessageNode[]> };

/** Why a message cannot be read; a catalog test reports it with the key. */
export class MessageSyntaxError extends Error {}

/** `pattern` as nodes; throws {@link MessageSyntaxError} for broken syntax. */
export function parseMessage(pattern: string): MessageNode[] {
  const parser = { text: pattern, at: 0 };
  const nodes = parseNodes(parser, false);
  if (parser.at < pattern.length) throw new MessageSyntaxError(`Unexpected "}" at ${parser.at} in ${pattern}`);
  return nodes;
}

/** The placeholder names a message reads, plural and select names included. */
export function messageArguments(pattern: string): Set<string> {
  const names = new Set<string>();
  const walk = (nodes: readonly MessageNode[]): void => {
    for (const node of nodes) {
      if (typeof node === "string" || node.kind === "pound") continue;
      names.add(node.name);
      if (node.kind === "plural" || node.kind === "select") for (const branch of node.cases.values()) walk(branch);
    }
  };
  walk(parseMessage(pattern));
  return names;
}

interface Parser {
  text: string;
  at: number;
}

function parseNodes(parser: Parser, inPlural: boolean): MessageNode[] {
  const nodes: MessageNode[] = [];
  let text = "";
  const flush = (): void => {
    if (text) nodes.push(text);
    text = "";
  };
  while (parser.at < parser.text.length) {
    const char = parser.text[parser.at];
    if (char === "}") break;
    if (char === "'") {
      text += readQuoted(parser, inPlural);
      continue;
    }
    if (char === "{") {
      flush();
      nodes.push(parseArgument(parser));
      continue;
    }
    if (char === "#" && inPlural) {
      flush();
      nodes.push({ kind: "pound" });
      parser.at += 1;
      continue;
    }
    text += char;
    parser.at += 1;
  }
  flush();
  return nodes;
}

/** An apostrophe: `''` is one, `'{…'` quotes syntax, anything else is a plain apostrophe. */
function readQuoted(parser: Parser, inPlural: boolean): string {
  const next = parser.text[parser.at + 1];
  if (next === "'") {
    parser.at += 2;
    return "'";
  }
  const quotesSyntax = next === "{" || next === "}" || (inPlural && next === "#");
  if (!quotesSyntax) {
    parser.at += 1;
    return "'";
  }
  const end = parser.text.indexOf("'", parser.at + 1);
  const close = end === -1 ? parser.text.length : end;
  const quoted = parser.text.slice(parser.at + 1, close);
  parser.at = close + 1;
  return quoted;
}

function parseArgument(parser: Parser): MessageNode {
  parser.at += 1;
  const name = readWord(parser);
  if (!name) throw new MessageSyntaxError(`Placeholder without a name at ${parser.at} in ${parser.text}`);
  skipSpace(parser);
  if (parser.text[parser.at] === "}") {
    parser.at += 1;
    return { kind: "arg", name };
  }
  expect(parser, ",");
  const type = readWord(parser);
  skipSpace(parser);
  if (type === "number") {
    expect(parser, "}");
    return { kind: "number", name };
  }
  if (type !== "plural" && type !== "select")
    throw new MessageSyntaxError(`Unknown placeholder type "${type}" in ${parser.text}`);
  expect(parser, ",");
  const cases = parseCases(parser, type === "plural");
  expect(parser, "}");
  if (!cases.has("other")) throw new MessageSyntaxError(`A ${type} needs an "other" case in ${parser.text}`);
  return { kind: type, name, cases };
}

function parseCases(parser: Parser, plural: boolean): Map<string, MessageNode[]> {
  const cases = new Map<string, MessageNode[]>();
  for (;;) {
    skipSpace(parser);
    if (parser.text[parser.at] === "}" || parser.at >= parser.text.length) return cases;
    const key = readWord(parser);
    if (!key) throw new MessageSyntaxError(`Case without a name at ${parser.at} in ${parser.text}`);
    skipSpace(parser);
    expect(parser, "{");
    cases.set(key, parseNodes(parser, plural));
    expect(parser, "}");
  }
}

function readWord(parser: Parser): string {
  skipSpace(parser);
  const match = /^[=\w-]+/.exec(parser.text.slice(parser.at));
  if (!match) return "";
  parser.at += match[0].length;
  return match[0];
}

function skipSpace(parser: Parser): void {
  while (/\s/.test(parser.text[parser.at] ?? "")) parser.at += 1;
}

function expect(parser: Parser, char: string): void {
  skipSpace(parser);
  if (parser.text[parser.at] !== char)
    throw new MessageSyntaxError(`Expected "${char}" at ${parser.at} in ${parser.text}`);
  parser.at += 1;
}

/** `pattern` with its placeholders filled in, plural forms chosen by `locale`'s rules. */
export function formatMessage(pattern: string, params: MessageParams | undefined, locale: Locale): string {
  if (!pattern.includes("{") && !pattern.includes("'")) return pattern;
  let nodes = parsed.get(pattern);
  if (!nodes) {
    nodes = parseMessage(pattern);
    parsed.set(pattern, nodes);
  }
  return render(nodes, params ?? {}, locale, undefined);
}

function render(
  nodes: readonly MessageNode[],
  params: MessageParams,
  locale: Locale,
  count: number | undefined,
): string {
  return nodes.map((node) => renderNode(node, params, locale, count)).join("");
}

function renderNode(node: MessageNode, params: MessageParams, locale: Locale, count: number | undefined): string {
  if (typeof node === "string") return node;
  if (node.kind === "pound") return poundWords(count, locale);
  if (node.kind === "arg") return node.name in params ? String(params[node.name]) : `{${node.name}}`;
  if (node.kind === "number") return formatNumber(Number(params[node.name]), locale);
  if (node.kind === "plural") {
    const value = Number(params[node.name]);
    return render(pluralBranch(node.cases, value, locale), params, locale, value);
  }
  const branch = node.cases.get(String(params[node.name])) ?? node.cases.get("other") ?? [];
  return render(branch, params, locale, count);
}

function pluralBranch(cases: ReadonlyMap<string, MessageNode[]>, value: number, locale: Locale): MessageNode[] {
  const exact = cases.get(`=${value}`);
  if (exact) return exact;
  let rules = pluralRules.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return cases.get(rules.select(value)) ?? cases.get("other") ?? [];
}

/** A plural's `#`: its count as the language writes numbers ("1 200" in Russian); English keeps "1200". */
function poundWords(count: number | undefined, locale: Locale): string {
  if (count === undefined) return "#";
  return locale === Locale.English ? String(count) : formatNumber(count, locale);
}

function formatNumber(value: number, locale: Locale): string {
  if (!Number.isFinite(value)) return "";
  return new Intl.NumberFormat(locale === Locale.English ? undefined : locale).format(value);
}
