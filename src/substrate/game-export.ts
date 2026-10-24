import { init, parse } from "es-module-lexer";
import path from "node:path";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  lstat,
  open,
  realpath,
  copyFile,
  rename,
  rm,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { ExportError, ExportRefusal } from "../shared/game-export-contract.ts";
import type { ExportResult } from "../shared/game-project.ts";
import { t } from "../shared/i18n.ts";
import { isBelow, isInside, toPosixRelative } from "./paths.ts";
import { MIN_SECRET_LENGTH } from "../shared/redact.ts";
import { realpathNearest } from "./fsx.ts";

/**
 * Whether a path segment is private, so an export never publishes it: a dotfile, a key, env or log
 * file, notes and agent files, tests, docs and other working folders. One table: whatever packs a
 * game's files for publishing (the C++ lane's `index.data`) should leave out the same names.
 */
export const excludedFromExport = (name: string): boolean =>
  name.startsWith(".") ||
  /^(node_modules|references|cache|__pycache__|coverage|tests?|docs|archive|research|evidence|captures|screenshots|logs)$/i.test(
    name,
  ) ||
  /^(AGENTS|CLAUDE|NOTES|README|PLAN)(\.|$)/i.test(name) ||
  /\.(pem|key|p12|pfx|jks|keystore|env|map|log)$/i.test(name) ||
  /^(id_rsa|id_ed25519|credentials|secrets|env)(\.|$)/i.test(name);

/** `game.export` answers this to the harness, so it lives in `shared/game-project.ts`. */
export type { ExportResult };

export interface ExportOptions {
  /**
   * The credential values Studio holds (the same set its log redactor uses). A public file that
   * contains one stops the export: a token an agent wrote into a game must not be published.
   */
  secretValues?: Iterable<string>;
  /**
   * Where the export is staged before it is renamed into place: a folder only the host writes,
   * on the target's volume (the studio passes `<userData>/${EXPORT_STAGING_DIR}`). The exports
   * folder is a sandbox writable root, so an agent's process could plant a link in a staging
   * folder there that the host's next write would follow. Absent, it is staged beside the target.
   */
  stagingRoot?: string;
}

/** Past this a file is an asset, not a place a token was pasted; it is not read to check. */
const MAX_SCANNED_BYTES = 32 * 1024 * 1024;
/**
 * Emscripten's preload pack (a C++ game's `index.data`): every asset in one file, so a token pasted
 * into any of them lands here. It is read for held credentials whatever its size.
 */
const PACKED_ASSETS = /\.data$/i;
/** How much of a file the credential check reads at a time. */
const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;

/** The marker file an export writes, which is what lets a later export replace the folder. */
export const EXPORT_MANIFEST = ".studio-export.json";
/** What the marker file holds when the folder is an app-managed export. */
const EXPORT_MARK = '"studioExport":1';
/** The staging folder's name prefix. */
export const STAGING_PREFIX = ".studio-export-";
/** The host-only folder under the studio's user data that every export is staged in (`layout.exportStaging`). */
export const EXPORT_STAGING_DIR = "export-staging";
/** The host's note beside a web export whose page loads WebAssembly; never a public file of the game's. */
export const EXPORT_README = "README.txt";
/** A WebAssembly module at the export's root: Emscripten's `index.wasm`, the page loads it by name. */
const ROOT_WASM = /^[^/]+\.wasm$/i;

/** What a web export that loads WebAssembly says about serving it (`README.txt`). */
export const WEB_SERVER_README = [
  "This game runs in a web browser. Put this whole folder on a web server and open index.html there.",
  "Opening index.html straight from the disk does not work: browsers do not load WebAssembly from file:// pages.",
  "",
  "The server must send each file with its type:",
  "  .wasm  application/wasm",
  "  .data  application/octet-stream",
  "  .js    text/javascript",
  "  .html  text/html",
  "",
  "Most hosts already do. If the game stays on a black screen, check the .wasm type first.",
  "",
].join("\n");
/** Where the vendored library sits inside an export. */
const VENDOR_DIR = "vendor";
/** The Basis transcoder KTX2Loader loads at run time, which no import names. */
const BASIS_DIR = "vendor/three/examples/jsm/libs/basis/";
const BASIS_FILES = ["basis_transcoder.js", "basis_transcoder.wasm"];

/** Why an export stopped, as the person reads it; functions, as main sets its language after this loads. */
const MESSAGE = {
  InsideGame: () => t("Export destination must be outside the game"),
  ResolvesInsideGame: () => t("Export destination must resolve outside the game"),
  NotADirectory: () => t("Export target must be an ordinary directory"),
  NotAnExport: () => t("Export target is not an app-managed export; choose an empty directory"),
  BackupOccupied: "The previous-export backup path already exists; nothing was replaced.",
  InvalidPublicPath: (rel: string) => t("Invalid public path: {path}", { path: rel }),
  MissingPublicPath: (rel: string) => t("Selected public path is missing or unreadable: {path}", { path: rel }),
  Symlink: (rel: string) => t("Export refuses symlink: {path}", { path: rel }),
  NotAFile: (rel: string) => t("Not a public file: {path}", { path: rel }),
  SecretLeaked: (rel: string) =>
    t(
      "Export stopped: {file} contains a credential Studio holds (an API key or sign-in token). Remove it from the game and export again.",
      { file: rel },
    ),
  NoEntry: () => t("Export needs index.html in the public selection/build output"),
  ScopedImportMap: () =>
    t("Export validation does not yet support scoped import maps; build this project before export"),
  UnresolvedModule: (ref: string) => t("Export has an unresolved module: {module}", { module: ref }),
  MissingReference: (ref: string, from: string) =>
    t("Export is missing a referenced public file: {file} in {from}", { file: ref, from }),
} as const;

/**
 * Whether a file's bytes hold any of `needles`. It is read `chunk` at a time, each read searched
 * together with the end of the one before, so a needle split across two reads is found.
 */
async function holdsAny(file: string, needles: Buffer[], chunk: Buffer): Promise<boolean> {
  const overlap = Math.max(...needles.map((needle) => needle.length)) - 1;
  const handle = await open(file, "r");
  try {
    let tail = Buffer.alloc(0);
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) return false;
      const window = Buffer.concat([tail, chunk.subarray(0, bytesRead)]);
      if (needles.some((needle) => window.includes(needle))) return true;
      tail = window.subarray(Math.max(0, window.length - overlap));
    }
  } finally {
    await handle.close();
  }
}

/**
 * The first staged file that contains a held credential, byte for byte (text or binary). A file
 * over {@link MAX_SCANNED_BYTES} is not read, unless `alwaysRead` says it is read whatever its size
 * (by default a preload pack, {@link PACKED_ASSETS}; a Mac app adds its executable).
 */
export async function fileWithSecret(
  staging: string,
  files: readonly string[],
  values: Iterable<string>,
  alwaysRead: (rel: string) => boolean = (rel) => PACKED_ASSETS.test(rel),
): Promise<string | undefined> {
  const needles = [...new Set(values)]
    .filter((v) => typeof v === "string" && v.length >= MIN_SECRET_LENGTH)
    .map((v) => Buffer.from(v));
  if (!needles.length) return undefined;
  const chunk = Buffer.alloc(SCAN_CHUNK_BYTES);
  for (const rel of files) {
    const file = path.join(staging, rel);
    const unread = (await lstat(file)).size > MAX_SCANNED_BYTES && !alwaysRead(rel);
    if (!unread && (await holdsAny(file, needles, chunk))) return rel;
  }
  return undefined;
}

/** The refusal an export gets for a file holding a held credential; the sentence never repeats the value. */
export function secretFoundError(rel: string): ExportError {
  return new ExportError(ExportRefusal.SecretFound, MESSAGE.SecretLeaked(rel));
}

/** Either folder holds the other. */
function overlaps(a: string, b: string): boolean {
  return isInside(a, b) || isInside(b, a);
}

/** Whether an existing target folder may be replaced: empty, or an export this app wrote. */
async function isReplaceableExport(target: string): Promise<boolean> {
  if ((await readdir(target)).length === 0) return true;
  return (await readFile(path.join(target, EXPORT_MANIFEST), "utf8").catch(() => "")).includes(EXPORT_MARK);
}

/** Where an export goes, resolved: the folder, its real parent, and what is there now. */
export interface ExportTarget {
  target: string;
  parent: string;
  existing: Stats | null;
}

/**
 * Where the export goes, resolved by realpath through its parent, and what is there now. The
 * destination may never hold the game or sit inside it, before or after links are followed, and
 * a refused one has nothing made for it: its missing parents are made only once it is checked.
 */
export async function resolveExportTarget(source: string, requested: string): Promise<ExportTarget> {
  const lexical = path.resolve(requested);
  if (overlaps(source, lexical)) throw new Error(MESSAGE.InsideGame());
  // A link that does not resolve is left to the checks below, which refuse it in their own words.
  const nearest = await realpathNearest(lexical).catch(() => null);
  if (nearest && overlaps(source, nearest)) throw new Error(MESSAGE.ResolvesInsideGame());
  await mkdir(path.dirname(lexical), { recursive: true });
  const parent = await realpath(path.dirname(lexical));
  const target = path.join(parent, path.basename(lexical));
  if (overlaps(source, target)) throw new Error(MESSAGE.ResolvesInsideGame());
  const existing = await lstat(target).catch(() => null);
  const plainDirectory = existing?.isDirectory() && !existing.isSymbolicLink();
  if (existing && !plainDirectory) throw new Error(MESSAGE.NotADirectory());
  if (existing && !(await isReplaceableExport(target)))
    throw new ExportError(ExportRefusal.NotAnExportFolder, MESSAGE.NotAnExport());
  return { target, parent, existing };
}

/** Reject interior symlinks as well as symlink leaves, including a selected nested root. */
async function refuseSymlinkOnTheWay(base: string, parts: string[], rel: string): Promise<void> {
  let parentPath = base;
  for (const part of parts) {
    parentPath = path.join(parentPath, part);
    if ((await lstat(parentPath)).isSymbolicLink()) throw new Error(MESSAGE.Symlink(rel));
  }
}

/** Copy one approved public path (a file, or a folder walked recursively) into staging. */
export async function stagePath(
  staging: string,
  result: ExportResult,
  base: string,
  rel: string,
  destRel = rel,
): Promise<void> {
  const parts = rel.split(/[\\/]/);
  if (path.isAbsolute(rel) || parts.includes("..")) throw new Error(MESSAGE.InvalidPublicPath(rel));
  if (parts.some(excludedFromExport)) {
    result.excluded.push(destRel);
    return;
  }
  const src = path.join(base, rel);
  const st = await lstat(src).catch(() => null);
  if (!st) throw new Error(MESSAGE.MissingPublicPath(rel));
  await refuseSymlinkOnTheWay(base, parts, rel);
  if (st.isDirectory()) {
    for (const name of await readdir(src)) {
      // `/`-joined on every platform: these are the export's own names, listed and compared as such.
      await stagePath(staging, result, base, path.posix.join(rel, name), path.posix.join(destRel, name));
    }
    return;
  }
  if (!st.isFile()) throw new Error(MESSAGE.NotAFile(rel));
  const dest = path.join(staging, destRel);
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(src, dest);
  result.included.push(destRel);
}

/** Whether `rel` is a staged file of the vendored library (only when one was staged). */
function isVendorFile(rel: string, vendor: string | undefined): boolean {
  return Boolean(vendor) && rel.startsWith(`${VENDOR_DIR}/`);
}

/** Stage the page, rewritten so root-relative vendor and source URLs work from any folder. */
async function rewriteEntry(staging: string): Promise<{ entry: string; html: string }> {
  const entry = path.join(staging, "index.html");
  const original = await readFile(entry, "utf8").catch(() => null);
  if (original === null) throw new Error(MESSAGE.NoEntry());
  const html = original.replaceAll('"/vendor/', '"./vendor/').replaceAll('"/src/', '"./src/');
  await writeFile(entry, html);
  return { entry, html };
}

/** The page's import map (`imports` only; a scoped map is refused). */
function importMapOf(html: string): Record<string, string> {
  const imports: Record<string, string> = {};
  for (const [, body = ""] of html.matchAll(/<script\b[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const map = JSON.parse(body);
    for (const [key, value] of Object.entries(map.imports ?? {})) if (typeof value === "string") imports[key] = value;
    if (map.scopes && Object.keys(map.scopes).length) throw new Error(MESSAGE.ScopedImportMap());
  }
  return imports;
}

/**
 * How a reference is read: a URL that must name a file, a URL that loads a module (a page's script
 * address or an import map's, never a bare name for the map), or a module's own import specifier.
 */
const Reference = {
  /** A page, style or classic-script URL: the file must be in the export; it is not read. */
  Url: "url",
  /** A module script's `src`: a URL (never looked up in the import map), read as a module. */
  ModuleUrl: "module-url",
  /** An import's specifier: a bare one goes through the import map; read as a module. */
  Specifier: "specifier",
} as const;
type Reference = (typeof Reference)[keyof typeof Reference];

/** How a script's import specifiers are followed. */
const ScriptKind = {
  /** A module: every specifier must resolve. */
  Module: "module",
  /**
   * A classic script the entry page loads, such as Emscripten's glue: its relative, absolute and
   * mapped specifiers are followed as a module's are. A bare one no import map answers is not: the
   * browser could never load it, so it sits on a path the browser never takes (emcc's Node branch).
   */
  Classic: "classic",
} as const;
type ScriptKind = (typeof ScriptKind)[keyof typeof ScriptKind];

/**
 * A `<script>` start tag's attributes, quoted, single-quoted or bare (minifiers, emcc's among them,
 * drop the quotes), with a quoted value free to hold `>`.
 */
const SCRIPT_TAG = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
const TAG_ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
/** The `type` a module script carries (HTML: trimmed, ASCII case-insensitive). */
const MODULE_TYPE = "module";

/** One `<script src>` of a page, and whether it loads a module. */
interface ScriptSource {
  src: string;
  module: boolean;
}

/** The scripts a page loads by `src`; a repeated attribute keeps its first value, as browsers do. */
function scriptSources(html: string): ScriptSource[] {
  const scripts: ScriptSource[] = [];
  for (const [, attributes = ""] of html.matchAll(SCRIPT_TAG)) {
    const values = new Map<string, string>();
    for (const [, name = "", double, single, bare] of attributes.matchAll(TAG_ATTRIBUTE)) {
      const key = name.toLowerCase();
      if (!values.has(key)) values.set(key, double ?? single ?? bare ?? "");
    }
    const src = values.get("src");
    if (src !== undefined) scripts.push({ src, module: values.get("type")?.trim().toLowerCase() === MODULE_TYPE });
  }
  return scripts;
}

/** Whether a reference points off the machine or at the page itself: not the export's to check. */
function isRemoteOrFragment(reference: string): boolean {
  return /^(?:[a-z]+:|\/\/|#)/i.test(reference);
}

/** The staged file a URL names from `from`, or null for an empty path. */
function stagedTarget(staging: string, from: string, ref: string): string | null {
  const pathname = decodeURIComponent(ref.split(/[?#]/)[0] ?? "");
  if (!pathname) return null;
  return pathname.startsWith("/") ? path.resolve(staging, `.${pathname}`) : path.resolve(path.dirname(from), pathname);
}

/**
 * The staged files the entry page loads as classic scripts (a `<script src>` without
 * `type="module"`), such as Emscripten's glue: read as {@link ScriptKind.Classic}, not as modules.
 */
function classicScriptsOf(staging: string, entry: string, html: string): Set<string> {
  const classic = new Set<string>();
  for (const { src, module } of scriptSources(html)) {
    if (module || isRemoteOrFragment(src)) continue;
    const file = stagedTarget(staging, entry, src);
    if (file) classic.add(file);
  }
  return classic;
}

/** What the reference check walks with: the staged page, its import map, and the modules still to read. */
interface ReferenceCheck {
  staging: string;
  entry: string;
  imports: Record<string, string>;
  queue: string[];
  visited: Set<string>;
  /** Vendored files something in the export actually loads. */
  neededVendor: Set<string>;
  /** Files the entry page loads as classic scripts: read as classic scripts, not as modules, for being staged. */
  classic: Set<string>;
}

/** The import-map entry that answers a bare specifier (the longest key wins), or undefined. */
function importMapEntry(imports: Record<string, string>, ref: string): [string, string] | undefined {
  return Object.entries(imports)
    .sort(([a], [b]) => b.length - a.length)
    .find(([key]) => key === ref || (key.endsWith("/") && ref.startsWith(key)));
}

/** A bare module specifier through the import map: the longest key that answers it wins. */
function mapBareSpecifier(imports: Record<string, string>, ref: string): string {
  const match = importMapEntry(imports, ref);
  if (!match) throw new Error(MESSAGE.UnresolvedModule(ref));
  const [key, target] = match;
  return target + ref.slice(key.length);
}

/** Whether a specifier is bare (not a URL, nor `.`- or `/`-relative) and no import-map entry answers it. */
function isUnansweredBare(imports: Record<string, string>, ref: string): boolean {
  const bare = !isRemoteOrFragment(ref) && !ref.startsWith(".") && !ref.startsWith("/");
  return bare && importMapEntry(imports, ref) === undefined;
}

/**
 * One reference from a staged file: it must name a regular file inside the export. A script or
 * import is followed (queued); a vendored file it reaches is kept. Remote URLs, fragments and a
 * bare specifier the map sends off-machine are not the export's to check.
 */
async function checkReference(
  check: ReferenceCheck,
  reference: string,
  referrer: string,
  kind: Reference = Reference.Url,
): Promise<void> {
  if (isRemoteOrFragment(reference)) return;
  let ref = reference;
  let from = referrer;
  const bareSpecifier = kind === Reference.Specifier && !ref.startsWith(".") && !ref.startsWith("/");
  if (bareSpecifier) {
    ref = mapBareSpecifier(check.imports, ref);
    from = check.entry;
    if (/^(?:[a-z]+:|\/\/)/i.test(ref)) return;
  }
  const { staging } = check;
  const file = stagedTarget(staging, from, ref);
  if (!file) return;
  const st = await lstat(file).catch(() => null);
  const publicFile = isInside(staging, file) && st?.isFile() === true;
  if (!publicFile) throw new Error(MESSAGE.MissingReference(ref, toPosixRelative(path.relative(staging, from))));
  if (isBelow(path.join(staging, VENDOR_DIR), file))
    check.neededVendor.add(toPosixRelative(path.relative(staging, file)));
  if (kind !== Reference.Url && /\.m?js$/i.test(file)) check.queue.push(file);
}

/** A script's import specifiers, each checked (and a module one followed) as its kind says. */
async function scanScript(
  check: ReferenceCheck,
  text: string,
  file: string,
  kind: ScriptKind = ScriptKind.Module,
): Promise<void> {
  const [specifiers] = parse(text);
  for (const { n: name } of specifiers) {
    if (name === undefined) continue;
    if (kind === ScriptKind.Classic && isUnansweredBare(check.imports, name)) continue;
    await checkReference(check, name, file, Reference.Specifier);
  }
}

/**
 * A page's references. A `<script src>` is a URL: a module script's file is read as a module, a
 * classic script's has to be in the export (the entry's are read as classic scripts once staged).
 * Other `src`/`href` values naming a `.js` file (a module preload) are read as modules, as before.
 */
async function scanHtml(check: ReferenceCheck, text: string, file: string): Promise<void> {
  for (const { src, module } of scriptSources(text))
    await checkReference(check, src, file, module ? Reference.ModuleUrl : Reference.Url);
  const withoutScriptTags = text.replace(SCRIPT_TAG, "");
  for (const [, ref = ""] of withoutScriptTags.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g))
    await checkReference(check, ref, file, /\.m?js(?:[?#]|$)/i.test(ref) ? Reference.ModuleUrl : Reference.Url);
  for (const [, body = ""] of text.matchAll(/<script\b[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/gi))
    await scanScript(check, body, file);
}

/**
 * One staged game file: HTML and CSS references are checked, modules queued. Every staged script is
 * read as a module (a worker or a chunk no page names still has to resolve), except the entry's
 * classic scripts, read here as classic scripts; one a module imports is still read as a module.
 */
async function scanStagedFile(check: ReferenceCheck, rel: string): Promise<void> {
  if (!/\.(html|m?js|css)$/i.test(rel)) return;
  const file = path.join(check.staging, rel);
  const text = await readFile(file, "utf8");
  const script = /\.m?js$/i.test(rel);
  if (/\.html$/i.test(rel)) await scanHtml(check, text, file);
  if (script && check.classic.has(file)) await scanScript(check, text, file, ScriptKind.Classic);
  else if (script) check.queue.push(file);
  if (/\.css$/i.test(rel))
    for (const [, url = ""] of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g))
      await checkReference(check, url.trim(), file);
}

/**
 * Follow actual module specifiers, not strings in comments/examples: every reference the staged
 * page, its styles and its modules make must be a file in the export. Returns the vendored files
 * those references reach.
 */
async function checkReferences(
  staging: string,
  page: { entry: string; html: string },
  included: string[],
  vendor: string | undefined,
): Promise<Set<string>> {
  await init;
  const check: ReferenceCheck = {
    staging,
    entry: page.entry,
    imports: importMapOf(page.html),
    queue: [],
    visited: new Set(),
    neededVendor: new Set(),
    classic: classicScriptsOf(staging, page.entry, page.html),
  };
  // An import map's address is a URL beside the page, never a bare name for the map itself.
  for (const ref of Object.values(check.imports))
    if (!ref.endsWith("/")) await checkReference(check, ref, page.entry, Reference.ModuleUrl);
  for (const rel of included) {
    if (isVendorFile(rel, vendor)) continue;
    await scanStagedFile(check, rel);
  }
  for (let file = check.queue.pop(); file !== undefined; file = check.queue.pop()) {
    if (check.visited.has(file)) continue;
    check.visited.add(file);
    await scanScript(check, await readFile(file, "utf8"), file);
  }
  return check.neededVendor;
}

/** The vendored library a file belongs to: its first folder under `vendor/`; null for the vendor root's own files. */
function vendoredLibrary(rel: string): string | null {
  const [, library, ...rest] = rel.split("/");
  return rest.length > 0 && library ? library : null;
}

/**
 * Whether a vendored licence, notice or version file stays: one at the vendor root always does,
 * one inside a library's folder (`vendor/genex/LICENSES.md`) only when the game uses that library.
 */
function keptNotice(rel: string, usedLibraries: ReadonlySet<string>): boolean {
  if (!/LICENSE|NOTICE|VERSION/i.test(rel)) return false;
  const library = vendoredLibrary(rel);
  return library === null || usedLibraries.has(library);
}

/** Drop the vendored files nothing loads (the notices of what stays stay too), moving them to `excluded`. */
async function pruneUnusedVendor(staging: string, result: ExportResult, neededVendor: Set<string>): Promise<void> {
  if ([...neededVendor].some((file) => file.endsWith("/KTX2Loader.js")))
    for (const file of BASIS_FILES) neededVendor.add(BASIS_DIR + file);
  const usedLibraries = new Set([...neededVendor].map(vendoredLibrary).filter((name) => name !== null));
  const unused = result.included.filter(
    (rel) => rel.startsWith(`${VENDOR_DIR}/`) && !neededVendor.has(rel) && !keptNotice(rel, usedLibraries),
  );
  for (const rel of unused) await rm(path.join(staging, rel));
  result.excluded.push(...unused);
  const removed = new Set(unused);
  result.included = result.included.filter((rel) => !removed.has(rel));
}

/**
 * A fresh staging folder for an export into `parent`: inside `stagingRoot`, the host's own folder,
 * when one is given (then the swap renames it into place), else beside the target.
 */
export async function makeStaging(parent: string, stagingRoot: string | undefined): Promise<string> {
  if (stagingRoot === undefined) return mkdtemp(path.join(parent, STAGING_PREFIX));
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  return mkdtemp(path.join(stagingRoot, STAGING_PREFIX));
}

/**
 * Put the staged export where the target was, keeping the previous one until the swap succeeded.
 * `now` names the previous export's folder while it is moved aside.
 */
export async function swapIntoPlace(
  staging: string,
  target: string,
  existing: Stats | null,
  now: () => number = Date.now,
): Promise<void> {
  const backup = `${target}.previous-${now()}`;
  if (existing) {
    const occupied = await lstat(backup).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (occupied) throw new ExportError(ExportRefusal.NotAnExportFolder, MESSAGE.BackupOccupied);
    await rename(target, backup);
  }
  try {
    await rename(staging, target);
  } catch (e) {
    if (existing) await rename(backup, target);
    throw e;
  }
  if (existing) await rm(backup, { recursive: true, force: true });
}

/** Assemble only approved public roots, never a recursive copy of a development project. */
export async function exportPublicGame(
  sourceDir: string,
  targetDir: string,
  roots: string[],
  vendor?: string,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const source = await realpath(sourceDir);
  const { target, parent, existing } = await resolveExportTarget(source, targetDir);
  const staging = await makeStaging(parent, options.stagingRoot);
  const result: ExportResult = { dir: target, files: 0, included: [], excluded: [] };
  try {
    for (const root of roots) await stagePath(staging, result, source, root);
    if (vendor) {
      const names = await readdir(vendor);
      for (const name of names)
        await stagePath(staging, result, await realpath(vendor), name, path.posix.join(VENDOR_DIR, name));
    }
    // Studio's own vendored library is not the game's to leak into; everything else is checked.
    const leaked = options.secretValues
      ? await fileWithSecret(
          staging,
          result.included.filter((rel) => !isVendorFile(rel, vendor)),
          options.secretValues,
        )
      : undefined;
    if (leaked) throw secretFoundError(leaked);
    const page = await rewriteEntry(staging);
    const neededVendor = await checkReferences(staging, page, result.included, vendor);
    if (vendor) await pruneUnusedVendor(staging, result, neededVendor);
    result.files = result.included.length;
    // `wx`: the host's own files are new; a name already there is refused, never written through.
    if (result.included.some((rel) => ROOT_WASM.test(rel)))
      await writeFile(path.join(staging, EXPORT_README), WEB_SERVER_README, { flag: "wx" });
    await writeFile(
      path.join(staging, EXPORT_MANIFEST),
      JSON.stringify({ studioExport: 1, included: result.included }),
      { flag: "wx" },
    );
    await swapIntoPlace(staging, target, existing);
    return result;
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    throw e;
  }
}
