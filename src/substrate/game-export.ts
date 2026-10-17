import { init, parse } from "es-module-lexer";
import path from "node:path";
import { mkdir, mkdtemp, readdir, readFile, writeFile, lstat, realpath, copyFile, rename, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { ExportResult } from "../shared/game-project.ts";
import { isBelow, isInside, toPosixRelative } from "./paths.ts";
import { MIN_SECRET_LENGTH } from "../shared/redact.ts";

const excluded = (name: string) =>
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
}

/** Past this a file is an asset, not a place a token was pasted; it is not read whole to check. */
const MAX_SCANNED_BYTES = 32 * 1024 * 1024;

/** The marker file an export writes, which is what lets a later export replace the folder. */
const EXPORT_MANIFEST = ".studio-export.json";
/** What the marker file holds when the folder is an app-managed export. */
const EXPORT_MARK = '"studioExport":1';
/** The staging folder's name prefix, beside the target. */
const STAGING_PREFIX = ".studio-export-";
/** Where the vendored library sits inside an export. */
const VENDOR_DIR = "vendor";
/** The Basis transcoder KTX2Loader loads at run time, which no import names. */
const BASIS_DIR = "vendor/three/examples/jsm/libs/basis/";
const BASIS_FILES = ["basis_transcoder.js", "basis_transcoder.wasm"];

const MESSAGE = {
  InsideGame: "Export destination must be outside the game",
  ResolvesInsideGame: "Export destination must resolve outside the game",
  NotADirectory: "Export target must be an ordinary directory",
  NotAnExport: "Export target is not an app-managed export; choose an empty directory",
  InvalidPublicPath: (rel: string) => `Invalid public path: ${rel}`,
  MissingPublicPath: (rel: string) => `Selected public path is missing or unreadable: ${rel}`,
  Symlink: (rel: string) => `Export refuses symlink: ${rel}`,
  NotAFile: (rel: string) => `Not a public file: ${rel}`,
  SecretLeaked: (rel: string) =>
    `Export stopped: ${rel} contains a credential Studio holds (an API key or sign-in token). Remove it from the game and export again.`,
  NoEntry: "Export needs index.html in the public selection/build output",
  ScopedImportMap: "Export validation does not yet support scoped import maps; build this project before export",
  UnresolvedModule: (ref: string) => `Export has an unresolved module: ${ref}`,
  MissingReference: (ref: string, from: string) => `Export is missing a referenced public file: ${ref} in ${from}`,
} as const;

/** The first staged file that contains a held credential, byte for byte (text or binary). */
async function fileWithSecret(staging: string, files: string[], values: Iterable<string>): Promise<string | undefined> {
  const needles = [...new Set(values)]
    .filter((v) => typeof v === "string" && v.length >= MIN_SECRET_LENGTH)
    .map((v) => Buffer.from(v));
  if (!needles.length) return undefined;
  for (const rel of files) {
    const file = path.join(staging, rel);
    if ((await lstat(file)).size > MAX_SCANNED_BYTES) continue;
    const bytes = await readFile(file);
    if (needles.some((needle) => bytes.includes(needle))) return rel;
  }
  return undefined;
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

/**
 * Where the export goes, resolved by realpath through its parent, and what is there now. The
 * destination may never hold the game or sit inside it, before or after links are followed.
 */
async function resolveExportTarget(
  source: string,
  requested: string,
): Promise<{ target: string; parent: string; existing: Stats | null }> {
  const lexical = path.resolve(requested);
  if (overlaps(source, lexical)) throw new Error(MESSAGE.InsideGame);
  await mkdir(path.dirname(lexical), { recursive: true });
  const parent = await realpath(path.dirname(lexical));
  const target = path.join(parent, path.basename(lexical));
  if (overlaps(source, target)) throw new Error(MESSAGE.ResolvesInsideGame);
  const existing = await lstat(target).catch(() => null);
  const plainDirectory = existing?.isDirectory() && !existing.isSymbolicLink();
  if (existing && !plainDirectory) throw new Error(MESSAGE.NotADirectory);
  if (existing && !(await isReplaceableExport(target))) throw new Error(MESSAGE.NotAnExport);
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
async function stagePath(
  staging: string,
  result: ExportResult,
  base: string,
  rel: string,
  destRel = rel,
): Promise<void> {
  const parts = rel.split(/[\\/]/);
  if (path.isAbsolute(rel) || parts.includes("..")) throw new Error(MESSAGE.InvalidPublicPath(rel));
  if (parts.some(excluded)) {
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
  if (original === null) throw new Error(MESSAGE.NoEntry);
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
    if (map.scopes && Object.keys(map.scopes).length) throw new Error(MESSAGE.ScopedImportMap);
  }
  return imports;
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
}

/** A bare module specifier through the import map: the longest key that answers it wins. */
function mapBareSpecifier(imports: Record<string, string>, ref: string): string {
  const match = Object.entries(imports)
    .sort(([a], [b]) => b.length - a.length)
    .find(([key]) => key === ref || (key.endsWith("/") && ref.startsWith(key)));
  if (!match) throw new Error(MESSAGE.UnresolvedModule(ref));
  const [key, target] = match;
  return target + ref.slice(key.length);
}

/**
 * One reference from a staged file: it must name a regular file inside the export. A module
 * reference is followed (queued); a vendored file it reaches is kept. Remote URLs, fragments and
 * a bare specifier the map sends off-machine are not the export's to check.
 */
async function checkReference(
  check: ReferenceCheck,
  reference: string,
  referrer: string,
  module = false,
): Promise<void> {
  if (/^(?:[a-z]+:|\/\/|#)/i.test(reference)) return;
  let ref = reference;
  let from = referrer;
  const bareSpecifier = module && !ref.startsWith(".") && !ref.startsWith("/");
  if (bareSpecifier) {
    ref = mapBareSpecifier(check.imports, ref);
    from = check.entry;
    if (/^(?:[a-z]+:|\/\/)/i.test(ref)) return;
  }
  const pathname = decodeURIComponent(ref.split(/[?#]/)[0] ?? "");
  if (!pathname) return;
  const { staging } = check;
  const file = pathname.startsWith("/")
    ? path.resolve(staging, `.${pathname}`)
    : path.resolve(path.dirname(from), pathname);
  const st = await lstat(file).catch(() => null);
  const publicFile = isInside(staging, file) && st?.isFile() === true;
  if (!publicFile) throw new Error(MESSAGE.MissingReference(ref, toPosixRelative(path.relative(staging, from))));
  if (isBelow(path.join(staging, VENDOR_DIR), file))
    check.neededVendor.add(toPosixRelative(path.relative(staging, file)));
  if (module && /\.m?js$/i.test(file)) check.queue.push(file);
}

async function scanModule(check: ReferenceCheck, text: string, file: string): Promise<void> {
  const [specifiers] = parse(text);
  for (const specifier of specifiers)
    if (specifier.n !== undefined) await checkReference(check, specifier.n, file, true);
}

async function scanHtml(check: ReferenceCheck, text: string, file: string): Promise<void> {
  for (const [, ref = ""] of text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g))
    await checkReference(check, ref, file, /\.m?js(?:[?#]|$)/i.test(ref));
  for (const [, body = ""] of text.matchAll(/<script\b[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/gi))
    await scanModule(check, body, file);
}

/** One staged game file: HTML and CSS references are checked, modules queued. */
async function scanStagedFile(check: ReferenceCheck, rel: string): Promise<void> {
  if (!/\.(html|m?js|css)$/i.test(rel)) return;
  const file = path.join(check.staging, rel);
  const text = await readFile(file, "utf8");
  if (/\.html$/i.test(rel)) await scanHtml(check, text, file);
  if (/\.m?js$/i.test(rel)) check.queue.push(file);
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
  };
  for (const ref of Object.values(check.imports))
    if (!ref.endsWith("/")) await checkReference(check, ref, page.entry, true);
  for (const rel of included) {
    if (isVendorFile(rel, vendor)) continue;
    await scanStagedFile(check, rel);
  }
  for (let file = check.queue.pop(); file !== undefined; file = check.queue.pop()) {
    if (check.visited.has(file)) continue;
    check.visited.add(file);
    await scanModule(check, await readFile(file, "utf8"), file);
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

/** Put the staged export where the target was, keeping the previous one until the swap succeeded. */
async function swapIntoPlace(staging: string, target: string, existing: Stats | null): Promise<void> {
  const backup = `${target}.previous-${Date.now()}`;
  if (existing) await rename(target, backup);
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
  const staging = await mkdtemp(path.join(parent, STAGING_PREFIX));
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
    if (leaked) throw new Error(MESSAGE.SecretLeaked(leaked));
    const page = await rewriteEntry(staging);
    const neededVendor = await checkReferences(staging, page, result.included, vendor);
    if (vendor) await pruneUnusedVendor(staging, result, neededVendor);
    result.files = result.included.length;
    await writeFile(
      path.join(staging, EXPORT_MANIFEST),
      JSON.stringify({ studioExport: 1, included: result.included }),
    );
    await swapIntoPlace(staging, target, existing);
    return result;
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    throw e;
  }
}
