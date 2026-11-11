import { init, parse } from "es-module-lexer";
import path from "node:path";
import { mkdir, mkdtemp, readdir, readFile, writeFile, lstat, realpath, copyFile, rename, rm } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { ExportResult } from "../shared/game-project.ts";
import { t } from "../shared/i18n.ts";
import { isBelow, isInside, toPosixRelative } from "./paths.ts";
import { CodedError } from "../shared/errors.ts";
import { ExportRefusal } from "../shared/game-library.ts";
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

/** The two lists of an export: the public paths a copy holds and the ones it leaves out. */
export type ExportListing = Pick<ExportResult, "included" | "excluded">;

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

/** Why an export stopped, as the person reads it; functions, as main sets its language after this loads. */
const MESSAGE = {
  InsideGame: () => t("Export destination must be outside the game"),
  ResolvesInsideGame: () => t("Export destination must resolve outside the game"),
  NotADirectory: () => t("Export target must be an ordinary directory"),
  NotAnExport: () => t("Export target is not an app-managed export; choose an empty directory"),
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

/** The first of `files` (public paths below `root`) that contains a held credential, byte for byte (text or binary). */
async function fileWithSecret(root: string, files: string[], values: Iterable<string>): Promise<string | undefined> {
  const needles = [...new Set(values)]
    .filter((v) => typeof v === "string" && v.length >= MIN_SECRET_LENGTH)
    .map((v) => Buffer.from(v));
  if (!needles.length) return undefined;
  for (const rel of files) {
    const file = path.join(root, rel);
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
  if (overlaps(source, lexical)) throw new CodedError(ExportRefusal.TargetInsideGame, MESSAGE.InsideGame());
  await mkdir(path.dirname(lexical), { recursive: true });
  const parent = await realpath(path.dirname(lexical));
  const target = path.join(parent, path.basename(lexical));
  if (overlaps(source, target)) throw new CodedError(ExportRefusal.TargetInsideGame, MESSAGE.ResolvesInsideGame());
  const existing = await lstat(target).catch(() => null);
  const plainDirectory = existing?.isDirectory() && !existing.isSymbolicLink();
  if (existing && !plainDirectory) throw new CodedError(ExportRefusal.TargetNotFolder, MESSAGE.NotADirectory());
  if (existing && !(await isReplaceableExport(target)))
    throw new CodedError(ExportRefusal.TargetNotExport, MESSAGE.NotAnExport());
  return { target, parent, existing };
}

/** Whether the path `parts` name below `base` is a link or goes through one: interior links, leaves and a nested root alike. */
async function hasLinkOnTheWay(base: string, parts: string[]): Promise<boolean> {
  let parentPath = base;
  for (const part of parts) {
    parentPath = path.join(parentPath, part);
    if ((await lstat(parentPath)).isSymbolicLink()) return true;
  }
  return false;
}

/** What a walk does with each public file it reaches, given where it is and its public path. */
type TakeFile = (src: string, destRel: string) => Promise<void>;

/** Copies each public file to its place under `staging`. */
function copyInto(staging: string): TakeFile {
  return async (src, destRel) => {
    const dest = path.join(staging, destRel);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(src, dest);
  };
}

/** Leaves each public file where it is: the walk only lists it. */
const leaveInPlace: TakeFile = async () => {};

/** Walk one approved public path (a file, or a folder walked recursively): each public file is taken and listed. */
async function walkPublicPath(
  take: TakeFile,
  result: ExportListing,
  base: string,
  rel: string,
  destRel = rel,
): Promise<void> {
  const parts = rel.split(/[\\/]/);
  if (path.isAbsolute(rel) || parts.includes(".."))
    throw new CodedError(ExportRefusal.PublicPathInvalid, MESSAGE.InvalidPublicPath(rel));
  if (parts.some(excluded)) {
    result.excluded.push(destRel);
    return;
  }
  const src = path.join(base, rel);
  const st = await lstat(src).catch(() => null);
  if (!st) throw new CodedError(ExportRefusal.PublicPathMissing, MESSAGE.MissingPublicPath(rel));
  if (await hasLinkOnTheWay(base, parts)) throw new CodedError(ExportRefusal.Symlink, MESSAGE.Symlink(rel));
  if (st.isDirectory()) {
    for (const name of await readdir(src)) {
      // `/`-joined on every platform: these are the export's own names, listed and compared as such.
      await walkPublicPath(take, result, base, path.posix.join(rel, name), path.posix.join(destRel, name));
    }
    return;
  }
  if (!st.isFile()) throw new CodedError(ExportRefusal.NotAFile, MESSAGE.NotAFile(rel));
  await take(src, destRel);
  result.included.push(destRel);
}

/**
 * The files of a public copy as its checks read them: a staged copy, or a game's own folder with
 * the list of what a copy of it would hold.
 */
interface PublicTree {
  /** The folder the public paths are below. */
  root: string;
  /** Whether the copy holds `file` as a regular file. */
  holds: (file: string) => Promise<boolean>;
}

/** A staged copy holds what is on the disk below it. */
function stagedTree(staging: string): PublicTree {
  return {
    root: staging,
    holds: async (file) => isInside(staging, file) && (await lstat(file).catch(() => null))?.isFile() === true,
  };
}

/**
 * The copy `included` (public paths below `root`) would make, with every file still where it is.
 * A disk that takes `Main.js` for `main.js` answers a staged copy by both names, so a name that is
 * not listed is asked of the disk: the copy holds it when it reaches a listed file, through no link.
 */
function listedTree(root: string, included: readonly string[]): PublicTree {
  const relOf = (file: string): string => toPosixRelative(path.relative(root, file));
  const listed = new Set(included.map((rel) => relOf(path.join(root, rel))));
  return {
    root,
    holds: async (file) => {
      if (!isInside(root, file)) return false;
      if (listed.has(relOf(file))) return true;
      const onDisk = await lstat(file).catch(() => null);
      if (!onDisk?.isFile() || (await hasLinkOnTheWay(root, relOf(file).split("/")))) return false;
      return listed.has(relOf(await realpath(file)));
    },
  };
}

/** Whether `rel` is a staged file of the vendored library (only when one was staged). */
function isVendorFile(rel: string, vendor: string | undefined): boolean {
  return Boolean(vendor) && rel.startsWith(`${VENDOR_DIR}/`);
}

/** The copy's page as it is published: rewritten so root-relative vendor and source URLs work from any folder. */
async function publishedPage(tree: PublicTree): Promise<{ entry: string; html: string }> {
  const entry = path.join(tree.root, "index.html");
  const original = (await tree.holds(entry)) ? await readFile(entry, "utf8").catch(() => null) : null;
  if (original === null) throw new CodedError(ExportRefusal.NoEntry, MESSAGE.NoEntry());
  return { entry, html: original.replaceAll('"/vendor/', '"./vendor/').replaceAll('"/src/', '"./src/') };
}

/** The page's import map (`imports` only; a scoped map is refused). */
function importMapOf(html: string): Record<string, string> {
  const imports: Record<string, string> = {};
  for (const [, body = ""] of html.matchAll(/<script\b[^>]*type=["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    const map = JSON.parse(body);
    for (const [key, value] of Object.entries(map.imports ?? {})) if (typeof value === "string") imports[key] = value;
    if (map.scopes && Object.keys(map.scopes).length)
      throw new CodedError(ExportRefusal.ScopedImportMap, MESSAGE.ScopedImportMap());
  }
  return imports;
}

/**
 * How a file names another: an address in a page or an import map is a URL (`File`, or `Script` to
 * follow), and only a module's own import specifier (`Import`) may be a bare name for the import map.
 */
const ReferenceKind = { File: "file", Script: "script", Import: "import" } as const;
type ReferenceKind = (typeof ReferenceKind)[keyof typeof ReferenceKind];

/** What the reference check walks with: the copy's files, its page as published, the page's import map, and the modules still to read. */
interface ReferenceCheck {
  tree: PublicTree;
  entry: string;
  html: string;
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
  if (!match) throw new CodedError(ExportRefusal.UnresolvedModule, MESSAGE.UnresolvedModule(ref));
  const [key, target] = match;
  return target + ref.slice(key.length);
}

/**
 * One reference from a public file: it must name a regular file inside the export. A script or
 * import is followed (queued); a vendored file it reaches is kept. Remote URLs, fragments and a
 * bare specifier the map sends off-machine are not the export's to check.
 */
async function checkReference(
  check: ReferenceCheck,
  reference: string,
  referrer: string,
  kind: ReferenceKind = ReferenceKind.File,
): Promise<void> {
  if (/^(?:[a-z]+:|\/\/|#)/i.test(reference)) return;
  let ref = reference;
  let from = referrer;
  const bareSpecifier = kind === ReferenceKind.Import && !ref.startsWith(".") && !ref.startsWith("/");
  if (bareSpecifier) {
    ref = mapBareSpecifier(check.imports, ref);
    from = check.entry;
    if (/^(?:[a-z]+:|\/\/)/i.test(ref)) return;
  }
  const pathname = decodeURIComponent(ref.split(/[?#]/)[0] ?? "");
  if (!pathname) return;
  const { root } = check.tree;
  const file = pathname.startsWith("/")
    ? path.resolve(root, `.${pathname}`)
    : path.resolve(path.dirname(from), pathname);
  if (!(await check.tree.holds(file)))
    throw new CodedError(
      ExportRefusal.MissingReference,
      MESSAGE.MissingReference(ref, toPosixRelative(path.relative(root, from))),
    );
  if (isBelow(path.join(root, VENDOR_DIR), file)) check.neededVendor.add(toPosixRelative(path.relative(root, file)));
  if (kind !== ReferenceKind.File && /\.m?js$/i.test(file)) check.queue.push(file);
}

async function scanModule(check: ReferenceCheck, text: string, file: string): Promise<void> {
  const [specifiers] = parse(text);
  for (const specifier of specifiers)
    if (specifier.n !== undefined) await checkReference(check, specifier.n, file, ReferenceKind.Import);
}

async function scanHtml(check: ReferenceCheck, text: string, file: string): Promise<void> {
  for (const [, ref = ""] of text.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g))
    await checkReference(check, ref, file, /\.m?js(?:[?#]|$)/i.test(ref) ? ReferenceKind.Script : ReferenceKind.File);
  for (const [, body = ""] of text.matchAll(/<script\b[^>]*type=["']module["'][^>]*>([\s\S]*?)<\/script>/gi))
    await scanModule(check, body, file);
}

/** One of the game's public files: HTML and CSS references are checked, modules queued. The page is read as published. */
async function scanPublicFile(check: ReferenceCheck, rel: string): Promise<void> {
  if (!/\.(html|m?js|css)$/i.test(rel)) return;
  const file = path.join(check.tree.root, rel);
  const text = file === check.entry ? check.html : await readFile(file, "utf8");
  if (/\.html$/i.test(rel)) await scanHtml(check, text, file);
  if (/\.m?js$/i.test(rel)) check.queue.push(file);
  if (/\.css$/i.test(rel))
    for (const [, url = ""] of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g))
      await checkReference(check, url.trim(), file);
}

/**
 * Follow actual module specifiers, not strings in comments/examples: every reference the copy's
 * page, its styles and its modules make must be a file in the export. Returns the vendored files
 * those references reach.
 */
async function checkReferences(
  tree: PublicTree,
  page: { entry: string; html: string },
  included: string[],
  vendor: string | undefined,
): Promise<Set<string>> {
  await init;
  const check: ReferenceCheck = {
    tree,
    entry: page.entry,
    html: page.html,
    imports: importMapOf(page.html),
    queue: [],
    visited: new Set(),
    neededVendor: new Set(),
  };
  for (const ref of Object.values(check.imports))
    if (!ref.endsWith("/")) await checkReference(check, ref, page.entry, ReferenceKind.Script);
  for (const rel of included) {
    if (isVendorFile(rel, vendor)) continue;
    await scanPublicFile(check, rel);
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

/**
 * What every public copy passes, staged or only listed: no file of the game holds a credential
 * Studio keeps, there is a page, and every reference is a file of the copy. Answers the page as
 * published and the vendored files the references reach.
 */
async function checkPublicCopy(
  tree: PublicTree,
  included: string[],
  vendor: string | undefined,
  options: ExportOptions,
): Promise<{ page: { entry: string; html: string }; neededVendor: Set<string> }> {
  // Studio's own vendored library is not the game's to leak into; everything else is checked.
  const leaked = options.secretValues
    ? await fileWithSecret(
        tree.root,
        included.filter((rel) => !isVendorFile(rel, vendor)),
        options.secretValues,
      )
    : undefined;
  if (leaked) throw new CodedError(ExportRefusal.SecretLeaked, MESSAGE.SecretLeaked(leaked));
  const page = await publishedPage(tree);
  return { page, neededVendor: await checkReferences(tree, page, included, vendor) };
}

/**
 * The lists an export of the same public paths answers, by the same walk, refusals and checks, with
 * nothing copied or written: every file is read where it is. For a copy that carries no vendored
 * library; which of that library's files a game needs is settled in the staged copy.
 */
export async function listPublicGame(
  sourceDir: string,
  roots: string[],
  options: ExportOptions = {},
): Promise<ExportListing> {
  const source = await realpath(sourceDir);
  const listing: ExportListing = { included: [], excluded: [] };
  for (const root of roots) await walkPublicPath(leaveInPlace, listing, source, root);
  await checkPublicCopy(listedTree(source, listing.included), listing.included, undefined, options);
  return listing;
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
  const take = copyInto(staging);
  try {
    for (const root of roots) await walkPublicPath(take, result, source, root);
    if (vendor) {
      const names = await readdir(vendor);
      for (const name of names)
        await walkPublicPath(take, result, await realpath(vendor), name, path.posix.join(VENDOR_DIR, name));
    }
    const { page, neededVendor } = await checkPublicCopy(stagedTree(staging), result.included, vendor, options);
    await writeFile(page.entry, page.html);
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
