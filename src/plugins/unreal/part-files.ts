/**
 * Reading a part's folder (`unreal/parts/<Part>/`) from a copy of the game, for the gate and the
 * editor queue, and its C++ (`unreal/Source/<Module>/Parts/<Part>/`) with what the copy changed
 * outside it. Builders write these folders, so a folder counts only when it resolves inside the
 * game, files are opened without following a link and within a size cap, and a file that isn't a
 * plain file is skipped (C++: named as a problem). Nothing here writes.
 */
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../../shared/errors.ts";
import { isInside } from "../../substrate/paths.ts";
import { readRegularFile } from "../../substrate/fsx.ts";
import { projectModule } from "./cpp-module.ts";
import { GAME_PROJECT_FOLDER } from "./game-folder.ts";
import { type OtherPart, PartFile, type PartCpp, type PartFiles } from "./part-check.ts";
import { parsePartManifest } from "./part-manifest.ts";
import { changedSource, FINDER_FILE, sameBytes, treeStamp } from "./source-tree.ts";

/** Where a game keeps its parts, relative to its folder. */
export const PARTS_FOLDER = path.join("unreal", "parts");
/** A part's name: its folder's name and `/Game/Parts/<Part>/`, so never a path. */
export const PART_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** How much of a part the gate reads. */
export const PART_LIMITS = { fileBytes: 256 * 1024, blueprintTexts: 12, parts: 64 } as const;
/** How much of a part's C++ the gate reads: files in all, and the largest one. */
export const PART_CPP_LIMITS = { files: 20, fileBytes: 200 * 1024 } as const;
/** The project's C++ folder, its plugins' folder, and the folder of the game module that holds the parts' C++. */
const SOURCE_FOLDER = "Source";
const PLUGINS_FOLDER = "Plugins";
const CPP_PARTS_FOLDER = "Parts";
/** A part's C++ file: a plain name with the header or source extension. */
export const CPP_FILE = /^[A-Za-z][A-Za-z0-9_]{0,63}\.(?:h|cpp)$/;
/** A folder inside a part's C++ folder (Public, Private): a plain name, one level deep. */
export const CPP_SUBFOLDER = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const MESSAGE = {
  BadName: (name: string) =>
    `${JSON.stringify(name)} is not a part name: letters, digits and _, starting with a letter.`,
  Missing: (name: string) => `There is no part ${name} in unreal/parts.`,
  Escapes: (name: string) => `The part folder ${name} leads outside the game.`,
  NotJson: (file: string, why: string) => `${file} isn't valid JSON: ${why}`,
  CppLink: "is a link; a part's C++ is plain files in its own folder.",
  CppNotFolder: "isn't a plain folder; a part's C++ goes in a plain folder.",
  CppDeep: "is a folder too deep: a part's C++ goes at most one plain-named folder deep (Public/, Private/).",
  NotCpp: "isn't a .h or .cpp file named with letters, digits and _; only those belong in a part's C++ folder.",
  CppTooLarge: `is larger than ${PART_CPP_LIMITS.fileBytes / 1024} KB; split it.`,
  CppUnreadable: "couldn't be read as a plain file.",
  CppTooMany: `holds more than ${PART_CPP_LIMITS.files} C++ files; a part has at most ${PART_CPP_LIMITS.files}.`,
} as const;

/** Where a game and the builder's copy of it are, for reading a part's C++. */
export type CppSources = {
  /** The builder's copy of the game folder (the game folder itself outside the Loop). */
  copy: string;
  /** The game's linked .uproject: the copy's has its name, and its folder holds the game's Source. */
  project: string;
};

/** A problem with one entry of a part's C++ folder, named relative to the copy. */
type CppProblem = PartCpp["problems"][number];

/** A part's folder by real path, inside the game; throws for a bad name, a missing folder or one that leads out. */
export async function partFolder(gameDir: string, part: string): Promise<string> {
  if (!PART_NAME.test(part)) throw new Error(MESSAGE.BadName(part));
  const game = await realpath(gameDir);
  const wanted = path.join(game, PARTS_FOLDER, part);
  const real = await realpath(wanted).catch(() => undefined);
  if (!real) throw new Error(MESSAGE.Missing(part));
  // A link anywhere on the way (the part folder itself included) is refused, not followed.
  if (real !== wanted || !isInside(game, real)) throw new Error(MESSAGE.Escapes(part));
  return real;
}

/** A plain file's text, or undefined when it is missing, a link, not a file or too large. */
async function readText(file: string): Promise<string | undefined> {
  const bytes = await readRegularFile(file, PART_LIMITS.fileBytes).catch(() => undefined);
  return bytes?.toString("utf8");
}

/** A JSON file: its value, undefined when missing, or why it doesn't parse. */
async function readJson(dir: string, name: string): Promise<{ value?: unknown; error?: string }> {
  const text = await readText(path.join(dir, name));
  if (text === undefined) return {};
  try {
    return { value: JSON.parse(text) };
  } catch (failure) {
    return { error: MESSAGE.NotJson(name, errorMessage(failure)) };
  }
}

/** The Blueprint text files in a part's folder, by name, up to the cap. */
async function readBlueprintTexts(dir: string): Promise<Record<string, string>> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(PartFile.BlueprintText)).sort();
  const texts: Record<string, string> = {};
  for (const name of names.slice(0, PART_LIMITS.blueprintTexts)) {
    const text = await readText(path.join(dir, name));
    if (text !== undefined) texts[name] = text;
  }
  return texts;
}

/** A part's files as the gate reads them, and its folder's real path. */
export async function readPartFiles(gameDir: string, part: string): Promise<{ dir: string; files: PartFiles }> {
  const dir = await partFolder(gameDir, part);
  const [manifest, test, dsl, apply] = await Promise.all([
    readJson(dir, PartFile.Manifest),
    readJson(dir, PartFile.Test),
    readBlueprintTexts(dir),
    readText(path.join(dir, PartFile.Apply)),
  ]);
  const files: PartFiles = {
    manifest: manifest.value,
    ...(manifest.error ? { manifestError: manifest.error } : {}),
    dsl,
    test: test.value,
    ...(test.error ? { testError: test.error } : {}),
    hasApply: apply !== undefined,
    ...(apply !== undefined ? { apply } : {}),
  };
  return { dir, files };
}

/** Every part of the game whose declaration reads, with the Blueprints it declares and the C++ classes it defines. */
export async function readOtherParts(gameDir: string): Promise<OtherPart[]> {
  const root = path.join(await realpath(gameDir), PARTS_FOLDER);
  const names = (await readdir(root).catch(() => [] as string[])).filter((n) => PART_NAME.test(n)).sort();
  const parts: OtherPart[] = [];
  for (const part of names.slice(0, PART_LIMITS.parts)) {
    const dir = await partFolder(gameDir, part).catch(() => undefined);
    const manifest = dir ? parsePartManifest((await readJson(dir, PartFile.Manifest)).value) : undefined;
    if (manifest?.ok) parts.push({ part, blueprints: manifest.part.blueprints, cpp: manifest.part.cpp });
  }
  return parts;
}

/** A C++ folder's read so far: its files by path inside it, its problems and how many files it has. */
type CppRead = { files: Record<string, string>; problems: CppProblem[]; count: number };

/** Reads one C++ file into `read`, or names why it can't be. */
async function readCppFile(read: CppRead, file: string, inner: string, shown: string): Promise<void> {
  read.count++;
  if (read.count > PART_CPP_LIMITS.files) return;
  try {
    read.files[inner] = (await readRegularFile(file, PART_CPP_LIMITS.fileBytes)).toString("utf8");
  } catch (failure) {
    const tooLarge = (failure as NodeJS.ErrnoException).code === "EFBIG";
    read.problems.push({ file: shown, message: tooLarge ? MESSAGE.CppTooLarge : MESSAGE.CppUnreadable });
  }
}

/** Whether `folder` is a plain folder at its own real path. */
async function isPlainFolder(folder: string): Promise<boolean> {
  const info = await lstat(folder).catch(() => null);
  return info?.isDirectory() === true && (await realpath(folder).catch(() => "")) === folder;
}

/**
 * Reads the C++ under `root` (the part's folder) at `inner` into `read`: plain .h and .cpp files,
 * plain-named folders one level deep; anything else is named, never read.
 */
async function readCppEntries(root: string, inner: string, shown: string, read: CppRead): Promise<void> {
  const entries = await readdir(path.join(root, inner), { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === FINDER_FILE) continue;
    const at = inner ? `${inner}/${entry.name}` : entry.name;
    const named = `${shown}/${at}`;
    const problem = (message: string) => read.problems.push({ file: named, message });
    if (entry.isSymbolicLink()) problem(MESSAGE.CppLink);
    else if (entry.isDirectory()) await readCppSubfolder(root, at, shown, read, problem);
    else if (entry.isFile() && CPP_FILE.test(entry.name)) await readCppFile(read, path.join(root, at), at, named);
    else problem(MESSAGE.NotCpp);
  }
}

/** A folder inside the part's C++ folder: read when it is the first level, plain-named and plain. */
async function readCppSubfolder(
  root: string,
  at: string,
  shown: string,
  read: CppRead,
  problem: (message: string) => void,
): Promise<void> {
  const firstLevel = !at.includes("/") && CPP_SUBFOLDER.test(at);
  if (!firstLevel) return void problem(MESSAGE.CppDeep);
  if (!(await isPlainFolder(path.join(root, at)))) return void problem(MESSAGE.CppLink);
  await readCppEntries(root, at, shown, read);
}

/**
 * The part's C++ folder `unreal/Source/<module>/Parts/<part>` in the copy's real `unreal` folder:
 * no files when it is missing, a problem when it or a folder on the way is a link or not a folder.
 */
async function readCppFolder(unreal: string, module: string, part: string): Promise<Omit<CppRead, "count">> {
  const steps = [SOURCE_FOLDER, module, CPP_PARTS_FOLDER, part];
  for (const [i] of steps.entries()) {
    const shown = [GAME_PROJECT_FOLDER, ...steps.slice(0, i + 1)].join("/");
    const info = await lstat(path.join(unreal, ...steps.slice(0, i + 1))).catch(() => null);
    if (!info) return { files: {}, problems: [] };
    if (info.isSymbolicLink()) return { files: {}, problems: [{ file: shown, message: MESSAGE.CppLink }] };
    if (!info.isDirectory()) return { files: {}, problems: [{ file: shown, message: MESSAGE.CppNotFolder }] };
  }
  const shown = [GAME_PROJECT_FOLDER, ...steps].join("/");
  const read: CppRead = { files: {}, problems: [], count: 0 };
  await readCppEntries(path.join(unreal, ...steps), "", shown, read);
  if (read.count > PART_CPP_LIMITS.files) read.problems.push({ file: shown, message: MESSAGE.CppTooMany });
  return { files: read.files, problems: read.problems };
}

/** `relative` paths of a folder of `unreal/` (the whole folder for "") as the copy names them. */
const shownIn = (folder: string, changed: string[]) =>
  changed.map((relative) => [GAME_PROJECT_FOLDER, folder, relative].filter(Boolean).join("/"));

/**
 * What the copy changed that UnrealBuildTool reads besides the part's own C++ folder, relative to
 * the copy: its Source, its .uproject (modules, plugins, build steps) and its Plugins (descriptors
 * and rules). Nothing when the copy is the game itself or the game's folder can't be read plainly.
 */
async function outsideChanges(unreal: string, sources: CppSources, module: string | undefined, part: string) {
  const game = await realpath(path.dirname(sources.project)).catch(() => undefined);
  if (game === undefined || game === unreal) return [];
  const parts = module === undefined ? undefined : `${module}/${CPP_PARTS_FOLDER}`;
  const source = await changedSource(path.join(unreal, SOURCE_FOLDER), path.join(game, SOURCE_FOLDER), {
    ...(parts === undefined ? {} : { except: `${parts}/${part}`, landing: parts }),
    missing: module !== undefined,
  });
  const plugins = await changedSource(path.join(unreal, PLUGINS_FOLDER), path.join(game, PLUGINS_FOLDER), {
    missing: true,
  });
  const name = path.basename(sources.project);
  const project = (await sameBytes(path.join(unreal, name), path.join(game, name)))
    ? []
    : [`${GAME_PROJECT_FOLDER}/${name}`];
  return [...shownIn(SOURCE_FOLDER, source), ...project, ...shownIn(PLUGINS_FOLDER, plugins)];
}

/**
 * A stamp of what UnrealBuildTool reads in the copy besides the part's C++ (fingerprinted by its
 * text) and the module's rules: its Source but the part's own folder and its Plugins (by path, size
 * and write time), and its .uproject's text, for check-part's compile fingerprint. A copy refreshed
 * at the same path, or one another part landed in, changes it.
 */
export async function copyStamp(sources: CppSources, own: { module: string; part: string }): Promise<string> {
  const unreal = path.join(await realpath(sources.copy), GAME_PROJECT_FOLDER);
  const project = await readRegularFile(path.join(unreal, path.basename(sources.project)), PART_LIMITS.fileBytes)
    .then(String)
    .catch(() => "");
  const [source, plugins] = await Promise.all([
    treeStamp(path.join(unreal, SOURCE_FOLDER), `${own.module}/${CPP_PARTS_FOLDER}/${own.part}`),
    treeStamp(path.join(unreal, PLUGINS_FOLDER)),
  ]);
  return JSON.stringify([source, plugins, project]);
}

/**
 * The part's C++ in the builder's copy: the game's module as the copy's .uproject names it, the
 * part's own C++ folder with its headers and sources (plain .h and .cpp files, at most one folder
 * deep, within {@link PART_CPP_LIMITS}; anything else is a problem, never read), and every file the
 * copy changed outside that folder in its Source. Throws only for a part name that isn't one.
 */
export async function readPartCpp(part: string, sources: CppSources): Promise<PartCpp> {
  if (!PART_NAME.test(part)) throw new Error(MESSAGE.BadName(part));
  const unreal = path.join(await realpath(sources.copy), GAME_PROJECT_FOLDER);
  if (!(await isPlainFolder(unreal)))
    return { module: undefined, folder: undefined, files: {}, problems: [], outside: [] };
  const module = await projectModule(path.join(unreal, path.basename(sources.project)));
  const outside = await outsideChanges(unreal, sources, module, part);
  if (module === undefined) return { module, folder: undefined, files: {}, problems: [], outside };
  const folder = [GAME_PROJECT_FOLDER, SOURCE_FOLDER, module, CPP_PARTS_FOLDER, part].join("/");
  return { module, folder, ...(await readCppFolder(unreal, module, part)), outside };
}
