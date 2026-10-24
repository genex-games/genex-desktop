/**
 * Edits to a web game's entry page that connect it to Genex, as text: Studio's copies of
 * `@genex-ai/embed-sdk` (and `@genex-ai/multiplayer` when asked) in a template game's import map,
 * the module that connects the page beside them, and the `<head>` tag the games host injects its
 * environment into.
 */
import { GENEX_EMBED_VENDOR, type GenexGamePackage, studioSdkImports, studioSdkPackages } from "./genex.ts";

/** The package a page imports the SDK by. */
const SDK_PACKAGE = "@genex-ai/embed-sdk";

const HEAD_OPEN = /<head(?=[\s>/])[^>]*>/i;
const HTML_OPEN = /<html(?=[\s>/])[^>]*>/i;
const DOCTYPE = /<!doctype[^>]*>/i;
const IMPORT_MAP = /(<script\b[^>]*\btype\s*=\s*["']?importmap["']?[^>]*>)([\s\S]*?)(<\/script\s*>)/gi;
const COMMENT = /<!--[\s\S]*?(?:-->|$)/g;

/** The page with every comment blanked: offsets stay the page's, and a tag inside a comment is not found. */
function visibleTags(html: string): string {
  return html.replace(COMMENT, (comment) => " ".repeat(comment.length));
}

function insertAt(html: string, at: number, text: string): string {
  return html.slice(0, at) + text + html.slice(at);
}

/** Just past the first match of `pattern` in `text`, or -1. */
function endOf(text: string, pattern: RegExp): number {
  const match = pattern.exec(text);
  return match ? match.index + match[0].length : -1;
}

/** Every import map the page really has (none inside a comment), in page order. */
function importMaps(html: string): RegExpExecArray[] {
  return [...visibleTags(html).matchAll(IMPORT_MAP)];
}

/** Where a page loads the connect module from: `vendorBase` is `/vendor` in a game, `./vendor` in a published copy. */
export function connectModuleSrc(vendorBase: string): string {
  return `${vendorBase}/${GENEX_EMBED_VENDOR.Connect}`;
}

/**
 * The page with a `<head>` tag: one already there is kept; otherwise an empty one goes where the
 * parser opens it anyway (after `<html>`, the doctype, or a byte-order mark), so the page's own
 * head content still lands in it and the doctype stays first.
 */
export function withHead(html: string): string {
  const visible = visibleTags(html);
  if (HEAD_OPEN.test(visible)) return html;
  const after = [HTML_OPEN, DOCTYPE].map((pattern) => endOf(visible, pattern)).find((at) => at >= 0);
  const start = html.startsWith("\uFEFF") ? 1 : 0;
  return insertAt(html, after ?? start, "<head></head>");
}

/**
 * The page loading the connect module from `src`: after its last import map (a module before one
 * stops the map from applying), else first in its head, so it runs before any of the game's
 * modules. A page that already loads it is left as it is; one with neither gets a head.
 */
export function withConnectScript(html: string, src: string): string {
  const tag = `<script type="module" src="${src}"></script>`;
  if (visibleTags(html).includes(GENEX_EMBED_VENDOR.Connect)) return html;
  const lastMap = importMaps(html).at(-1);
  if (lastMap) return insertAt(html, lastMap.index + lastMap[0].length, tag);
  const page = withHead(html);
  return insertAt(page, endOf(visibleTags(page), HEAD_OPEN), tag);
}

/** Whether a game's page loads the Genex SDK through Studio's copy: its import map names it, or it loads the connect module. */
export function pageLoadsGenexSdk(html: string): boolean {
  const visible = visibleTags(html);
  if (visible.includes(GENEX_EMBED_VENDOR.Connect)) return true;
  return importMaps(html).some(([, , body = ""]) => {
    try {
      return Object.hasOwn(JSON.parse(body)?.imports ?? {}, SDK_PACKAGE);
    } catch {
      return false;
    }
  });
}

/** The indentation of the first line of `body` that has text on it. */
function indentOf(body: string): string {
  return /^([ \t]*)\S/m.exec(body)?.[1] ?? "";
}

/** The page's first import map: where it sits, its tag's three parts read from the page itself, and its JSON. */
function firstImportMap(html: string) {
  const [found] = importMaps(html);
  if (!found) return null;
  // The groups are read from the page itself: the search ran on a copy with its comments blanked.
  const whole = html.slice(found.index, found.index + found[0].length);
  const [, open = "", body = "", close = ""] = new RegExp(IMPORT_MAP.source, "i").exec(whole) ?? [];
  let map: { imports?: Record<string, unknown>; scopes?: unknown };
  try {
    map = JSON.parse(body);
  } catch {
    return null;
  }
  if (map === null || typeof map !== "object" || Array.isArray(map)) return null;
  return { at: found.index, length: whole.length, open, body, close, map };
}

/** The Genex packages a template game's page takes from Studio's copies, by its first import map. */
export function pageStudioSdkPackages(html: string): GenexGamePackage[] {
  return studioSdkPackages(firstImportMap(html)?.map.imports ?? {});
}

/**
 * A template game's page with Studio's copies of `name` (and what it needs) in its first import
 * map, at `/vendor`, and the connect module loaded right after the map. Null when the page has no
 * import map, or one that does not parse or is scoped: such a page is not the template's, and is not
 * edited.
 */
export function withGenexSdkImport(html: string, name: GenexGamePackage = "@genex-ai/embed-sdk"): string | null {
  const found = firstImportMap(html);
  if (!found || found.map.scopes !== undefined) return null;
  const wanted = studioSdkImports(name);
  const current = found.map.imports ?? {};
  const missing = Object.keys(wanted).some((specifier) => !Object.hasOwn(current, specifier));
  if (!missing) return withConnectScript(html, connectModuleSrc("/vendor"));
  const imports = { ...current, ...missingOnly(wanted, current) };
  const indent = indentOf(found.body);
  const json = JSON.stringify({ ...found.map, imports }, null, 2)
    .split("\n")
    .map((line) => indent + line)
    .join("\n");
  const closeIndent = /\n([ \t]*)$/.exec(found.body)?.[1] ?? "";
  const rewritten = `${found.open}\n${json}\n${closeIndent}${found.close}`;
  const page = html.slice(0, found.at) + rewritten + html.slice(found.at + found.length);
  return withConnectScript(page, connectModuleSrc("/vendor"));
}

/** The entries of `wanted` the map does not name yet: a specifier the game already maps keeps its own URL. */
function missingOnly(wanted: Record<string, string>, current: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(wanted).filter(([specifier]) => !Object.hasOwn(current, specifier)));
}
