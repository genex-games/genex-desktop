/**
 * A server-authoritative game's room module, staged into the Genex plugin's publish copy beside
 * its public `dist/`. The CLI bundles and validates the module from the folder it runs in, and
 * every file the bundle reads must be inside that folder, so the copy gets the game's `server/`
 * and every file of the game the module imports (a movement step in `src/` the client also runs),
 * at the paths they have in the game. None of it goes into `dist/`: it is server code, and the
 * CLI uploads it only to Genex's private module store.
 *
 * Everything is read and checked before anything is written: a link anywhere on the way, a file
 * outside the game or at its top level, a folder the copy keeps for itself, or too much to be a
 * room module refuses the whole stage and leaves the copy as it was.
 */
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { init, parse } from "es-module-lexer";
import { t } from "../shared/i18n.ts";
import { CodedError } from "../shared/errors.ts";
import { ExportRefusal } from "../shared/game-library.ts";
import { atomicWriteJson, isJsonObject, readJsonIfExists } from "./fsx.ts";
import { isPlainRelativePath } from "./paths.ts";

/** The folder a game keeps its server code in; the room module must be in it (the CLI's rule). */
export const ROOM_SERVER_DIR = "server";
/** A room module's file: a script the authority bundler takes. */
const ROOM_MODULE_FILE = /\.(js|ts)$/;
/** Scripts whose imports are followed. */
const SCRIPT_FILE = /\.(js|mjs|cjs|jsx|ts|mts|cts|tsx)$/;
/** TypeScript, whose types are stripped before its imports are read. */
const TYPESCRIPT_FILE = /\.(ts|mts|cts|tsx)$/;
/** What a relative import without its extension may name, in the order esbuild tries them. */
const IMPORT_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs", ".mts", ".cjs", ".cts", ".json"];
/** A `.js` import a TypeScript file may mean (esbuild resolves `./x.js` to `./x.ts`). */
const TS_FOR_JS: Readonly<Record<string, readonly string[]>> = { ".js": [".ts", ".tsx"], ".mjs": [".mts"] };
/** The most files a staged room takes. */
const MAX_ROOM_FILES = 2000;
/** The most bytes a staged room takes: far over a room module's 2 MiB bundle, well under a game. */
const MAX_ROOM_BYTES = 32 * 1024 * 1024;
/** Where the publish copy records the folders it staged last time, so the next stage clears them. */
const STAGED_RECORD = ".genex/studio-room.json";
/** What a staged folder's ignore file holds: git keeps none of it, so a source push never carries server code. */
const STAGED_IGNORE = "# Studio's staged room module: server code, never pushed\n*\n";
/** Names in the publish copy that are the CLI's or Studio's, whatever is already there. */
const RESERVED_TOPS = new Set(["dist", "home", "node_modules", "package.json", "publish.json"]);

/** Why a stage stopped, as the person reads it. */
const MESSAGE = {
  Link: (rel: string) => t("The room module reaches {file} through a link; publish needs the real file", { file: rel }),
  Outside: (rel: string) =>
    t("The room module imports {file}, outside the game's folders; keep shared code in a folder like src/", {
      file: rel,
    }),
  Reserved: (rel: string) =>
    t("The room module imports {file}, in a folder the publish copy keeps for itself; move it to src/", {
      file: rel,
    }),
  TooLarge: () => t("The room module's server/ folder and imports are too large to publish as a room module"),
} as const;

/** What was staged: the files, as paths in the game, and the top-level folders that hold them. */
export interface StagedRoom {
  files: string[];
  tops: string[];
}

/**
 * The room module's path when `block` is a usable `authority` block (a plain relative `.js` or
 * `.ts` path in `server/`), else null: a malformed block stages nothing and the CLI refuses it.
 */
export function roomModulePath(block: unknown): string | null {
  if (!isJsonObject(block)) return null;
  const module = block.module;
  if (!isPlainRelativePath(module) || !ROOM_MODULE_FILE.test(module)) return null;
  const segments = module.split("/");
  return segments[0] === ROOM_SERVER_DIR && segments.length > 1 ? module : null;
}

/** The first part of `rel` (from `game`) that is a link, or that is missing; null when every part is real. */
async function linkOrMissing(game: string, rel: string): Promise<"link" | "missing" | null> {
  let at = game;
  for (const part of rel.split("/")) {
    at = path.join(at, part);
    const info = await lstat(at).catch(() => null);
    if (!info) return "missing";
    if (info.isSymbolicLink()) return "link";
  }
  return null;
}

/** The game-relative path a relative import names, or null when it climbs out of the game. */
function importTarget(from: string, specifier: string): string | null {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  return joined.startsWith("../") || joined === ".." || joined === "." ? null : joined;
}

/** The paths a relative import may resolve to, in esbuild's order. */
function importCandidates(target: string): string[] {
  const ext = path.posix.extname(target);
  const stem = target.slice(0, target.length - ext.length);
  const swapped = (TS_FOR_JS[ext] ?? []).map((alt) => stem + alt);
  return [
    target,
    ...swapped,
    ...IMPORT_EXTENSIONS.map((e) => target + e),
    ...IMPORT_EXTENSIONS.map((e) => `${target}/index${e}`),
  ];
}

/** The relative import specifiers of a script; none when it cannot be read as a module. */
async function relativeImports(rel: string, source: string): Promise<string[]> {
  try {
    const code = TYPESCRIPT_FILE.test(rel) ? stripTypeScriptTypes(source, { mode: "transform" }) : source;
    await init;
    const [imports] = parse(code);
    return imports.map((entry) => entry.n).filter((n): n is string => typeof n === "string" && n.startsWith("."));
  } catch {
    // The bundler reads it again and names what it cannot parse.
    return [];
  }
}

/** Every file under `rel` (a real folder in `game`), refusing any link in it. */
async function folderFiles(game: string, rel: string, into: Set<string>): Promise<void> {
  for (const entry of await readdir(path.join(game, rel), { withFileTypes: true })) {
    const child = `${rel}/${entry.name}`;
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (entry.isSymbolicLink()) throw new CodedError(ExportRefusal.RoomLink, MESSAGE.Link(child));
    if (entry.isDirectory()) await folderFiles(game, child, into);
    else if (entry.isFile()) into.add(child);
    if (into.size > MAX_ROOM_FILES) throw new CodedError(ExportRefusal.RoomTooLarge, MESSAGE.TooLarge());
  }
}

/** Whether a game-relative path may be staged: inside a top-level folder that is neither hidden nor reserved. */
function checkPlace(rel: string): void {
  const [top, ...rest] = rel.split("/");
  if (!top || rest.length === 0) throw new CodedError(ExportRefusal.RoomOutside, MESSAGE.Outside(rel));
  if (top.startsWith(".") || RESERVED_TOPS.has(top.toLowerCase()))
    throw new CodedError(ExportRefusal.RoomReserved, MESSAGE.Reserved(rel));
}

/** The first candidate that is a real file in the game; null when none is (the bundler names it). */
async function resolveImport(game: string, target: string): Promise<string | null> {
  for (const candidate of importCandidates(target)) {
    const found = await linkOrMissing(game, candidate);
    if (found === "missing") continue;
    if (found === "link") throw new CodedError(ExportRefusal.RoomLink, MESSAGE.Link(candidate));
    if ((await lstat(path.join(game, candidate))).isFile()) return candidate;
  }
  return null;
}

/**
 * The room's files, read and checked in `game` (a real path): `server/` whole, then every file a
 * staged script imports by a relative path, and theirs. Nothing is written.
 */
export async function roomFiles(game: string, module: string): Promise<Map<string, Buffer>> {
  const moduleState = await linkOrMissing(game, module);
  if (moduleState === "link") throw new CodedError(ExportRefusal.RoomLink, MESSAGE.Link(module));
  const names = new Set<string>();
  if ((await linkOrMissing(game, ROOM_SERVER_DIR)) === null) await folderFiles(game, ROOM_SERVER_DIR, names);
  const files = new Map<string, Buffer>();
  const queue = [...names];
  let bytes = 0;
  for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
    if (files.has(rel)) continue;
    checkPlace(rel);
    const data = await readFile(path.join(game, rel));
    bytes += data.length;
    if (bytes > MAX_ROOM_BYTES || files.size >= MAX_ROOM_FILES)
      throw new CodedError(ExportRefusal.RoomTooLarge, MESSAGE.TooLarge());
    files.set(rel, data);
    if (SCRIPT_FILE.test(rel)) queue.push(...(await importedFiles(game, rel, data.toString("utf8"))));
  }
  return files;
}

/** The game files a staged script imports by a relative path, each checked for its place. */
async function importedFiles(game: string, rel: string, source: string): Promise<string[]> {
  const found: string[] = [];
  for (const specifier of await relativeImports(rel, source)) {
    const target = importTarget(rel, specifier);
    if (target === null) throw new CodedError(ExportRefusal.RoomOutside, MESSAGE.Outside(specifier));
    checkPlace(target);
    const file = await resolveImport(game, target);
    if (file !== null) found.push(file);
  }
  return found;
}

/** The folders a previous stage recorded, each a plain name that is not reserved. */
async function recordedTops(workspace: string): Promise<string[]> {
  const record = await readJsonIfExists<{ tops?: unknown }>(path.join(workspace, STAGED_RECORD)).catch(() => null);
  const tops = Array.isArray(record?.tops) ? record.tops : [];
  return tops.filter(
    (top): top is string =>
      isPlainRelativePath(top) && !top.includes("/") && !top.startsWith(".") && !RESERVED_TOPS.has(top.toLowerCase()),
  );
}

/** Remove what the last stage put in the publish copy, and its record. */
export async function clearStagedRoom(workspace: string): Promise<void> {
  for (const top of await recordedTops(workspace))
    await rm(path.join(workspace, top), { recursive: true, force: true });
  await rm(path.join(workspace, STAGED_RECORD), { force: true });
}

/**
 * Stage the room module `module` of the game in `gameDir` into the publish copy `workspace`,
 * replacing the last stage. Throws a coded refusal, with the copy untouched, when the room cannot go.
 */
export async function stageRoom(gameDir: string, workspace: string, module: string): Promise<StagedRoom> {
  const game = await realpath(gameDir);
  const files = await roomFiles(game, module);
  const tops = [...new Set([...files.keys()].map((rel) => rel.split("/")[0] as string))].sort();
  const previous = new Set(await recordedTops(workspace));
  for (const top of tops) {
    const taken = !previous.has(top) && (await lstat(path.join(workspace, top)).catch(() => null)) !== null;
    if (taken) throw new CodedError(ExportRefusal.RoomReserved, MESSAGE.Reserved(top));
  }
  await clearStagedRoom(workspace);
  for (const top of tops) {
    await mkdir(path.join(workspace, top), { recursive: true });
    await writeFile(path.join(workspace, top, ".gitignore"), STAGED_IGNORE);
  }
  for (const [rel, data] of files) {
    await mkdir(path.dirname(path.join(workspace, rel)), { recursive: true });
    await writeFile(path.join(workspace, rel), data);
  }
  await atomicWriteJson(path.join(workspace, STAGED_RECORD), { tops });
  return { files: [...files.keys()].sort(), tops };
}
