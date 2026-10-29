/**
 * The Game Animation Sample's Motion Matching in a game. Epic's sample can't ship with Genex (it is
 * Fab content for Unreal projects, not Genex's to hand on), so the person gets it once from Fab or
 * the Epic Games Launcher and Genex finds it among their Unreal projects. `motion-status` says where
 * the sample is and whether the game has its content; `add-motion-matching` adds that content in the
 * background, one job per project at a time, once the person confirms: it saves the editor's work
 * and quits Unreal, clones the folders the sample's Motion Matching character needs into the game's
 * Content (a clone shares the sample's blocks on APFS; elsewhere it is a copy), merges the sample's
 * settings the game lacks (`motion-config.ts`), turns on the sample's plugins, keeps the copied
 * folders out of the game's checkpoints (they are the sample's, gigabytes, and come back from it),
 * and opens Unreal again. A game that already holds a file of the same path, that reaches its
 * Content's folders through a link, whose config can't be read, whose trace channel is another's, or
 * with too little disk is refused before Unreal is touched, and the files are looked at again once
 * Unreal is closed. Only folders the copy makes (or files it adds to the game's own folders) are kept
 * out of checkpoints, written before the copy starts. An add that fails is taken back out (the copied
 * files, then the config files, the .uproject and the .gitignore as they were), and an editor the job
 * closed is opened again. The helper's `motion_character` then gives a character the sample's
 * Motion Matching.
 */
import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { cp, lstat, mkdir, readdir, rmdir, stat, statfs, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { StudioPlatform } from "../../shared/boot.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { atomicWriteText, ensureDirBelow, isJsonObject, readRegularFile } from "../../substrate/fsx.ts";
import { enableProjectPlugin } from "./cpp-module.ts";
import { CppEditorTool } from "./cpp-tools.ts";
import {
  type CloseWords,
  closeForBuild,
  type JobRecord,
  OPEN_WAIT_MS,
  openAndWait,
  QUIT_WAIT_MS,
  type RestartDeps,
  runJob,
} from "./editor-restart.ts";
import { mergeEngineIni, mergeGameplayTagsIni } from "./motion-config.ts";

const execFileAsync = promisify(execFile);

/** The Motion Matching tools, by their names after `unreal__`. */
export const MotionToolName = { Status: "motion-status", Add: "add-motion-matching" } as const;
export type MotionToolName = (typeof MotionToolName)[keyof typeof MotionToolName];

/** Where adding the sample's content stands: wire values the tool answers. */
export const MotionAddState = { Idle: "idle", Adding: "adding", Done: "done", Failed: "failed" } as const;
export type MotionAddState = (typeof MotionAddState)[keyof typeof MotionAddState];

/** The folders of the sample's Content its Motion Matching character needs, as the sample lays them out. */
export const SAMPLE_FOLDERS = [
  "Blueprints",
  "Characters/UEFN_Mannequin",
  "Characters/UE5_Mannequins",
  "Input",
  "Audio",
  "Widgets",
  "Misc",
  "Levels/LevelPrototyping",
] as const;
/** The sample's showcase characters whose meshes the game doesn't get: left out, so nothing points at what is missing. */
export const SAMPLE_LEFT_OUT = [
  "Blueprints/RetargetedCharacters/BP_Echo.uasset",
  "Blueprints/RetargetedCharacters/BP_Twinblast.uasset",
  "Blueprints/RetargetedCharacters/BP_UE4_Mannequin.uasset",
] as const;
/**
 * What marks a folder as the sample: its Motion Matching character, beside its .uproject. A game that
 * got the content holds it too, but none of `SAMPLE_LEFT_OUT`, which the sample does.
 */
const SAMPLE_MARK = "Content/Blueprints/SandboxCharacter_CMC.uasset";
/** The config files the sample's settings are merged into, or copied when the game has none. */
const CONFIG = {
  engine: "DefaultEngine.ini",
  tags: "DefaultGameplayTags.ini",
  prediction: "DefaultNetworkPrediction.ini",
} as const;
/** A config file or a .uproject is far smaller than this. */
const CONFIG_MAX_BYTES = 1024 * 1024;
/** The disk a clone leaves free at least: Unreal's first open compresses every clip into its cache. */
const MIN_FREE_BYTES = 3 * 1024 ** 3;
/** macOS's own `cp`: with `-c` it clones through clonefile(2) on APFS (and copies elsewhere). */
const MAC_CP = "/bin/cp";
/** The line the game's .gitignore keeps above the sample's folders. */
const IGNORE_NOTE = "# The Game Animation Sample's content: Genex adds it from the sample; not kept in checkpoints.";
/** The characters a .gitignore pattern reads as a glob. */
const IGNORE_GLOB = /[[\]*?\\]/g;
/** How long Unreal's first open of the sample's content takes about, as the answer tells it. */
const FIRST_OPEN_MINUTES = 10;
/** The most files a refusal names. */
const MAX_NAMED = 5;
const GB = 1024 ** 3;

const MESSAGE = {
  NoProject: "This game isn't linked to an Unreal project, so there is no project to add Motion Matching to.",
  NoSample:
    "The Game Animation Sample isn't among this Mac's Unreal projects. Get it once from Fab or the Epic Games Launcher (Samples), create a project from it, then try again.",
  NoFolder: "The game's folder isn't known, so Genex can't keep the sample's content out of its checkpoints.",
  Collides: (files: string) =>
    `The game already has files where the sample's content goes (${files}), so Genex added nothing. Move or rename them first.`,
  Link: (where: string) => `${where} in the sample is a link; Genex copies only plain files and folders.`,
  GameLink: (where: string) =>
    `${where} in the game's project is a link or a file, not a folder, so Genex added nothing there. Make it a plain folder first.`,
  Unreadable: (name: string, why: string) => `Genex couldn't read ${name} (${why}), so it added nothing.`,
  NoDisk: (needGb: number, freeGb: number) =>
    `Adding the sample's content needs about ${needGb} GB free on the game's disk, and ${freeGb} GB is. Free some space first.`,
  OtherEditor:
    "Unreal is open, but this game's project isn't answering, so Genex can't save its work and didn't quit it to add Motion Matching. When it is this game's Unreal, call unreal__open-editor with restart: true (work not saved in it is lost), then try again; when it is another project's, ask the user to quit it.",
  NotSaved: (why: string) =>
    `Genex couldn't save your work in Unreal (${why}), so it left Unreal open and added nothing.`,
  NoSaveAnswer: "the Genex editor helper didn't answer",
  Unsaved: (names: string) => `Unreal didn't save ${names}, so Genex left it open and added nothing.`,
  NotClosed: `Unreal didn't close within ${QUIT_WAIT_MS / SECOND_MS} s, so Genex added nothing. Call unreal__quit-editor, then try again.`,
  NotAnswering: `Genex added the sample's content, but Unreal didn't answer within ${OPEN_WAIT_MS / MINUTE_MS} minutes of opening the game. Its first open compresses the sample's clips and can take ${FIRST_OPEN_MINUTES} minutes: call unreal__editor-status with seconds until it answers, and unreal__open-editor if it stopped opening.`,
  Started: `Adding the Game Animation Sample's content: Genex saves your work, quits Unreal, adds it and opens Unreal again. Its first open compresses the sample's clips (about ${FIRST_OPEN_MINUTES} minutes). Read motion-status.`,
} as const;

/** How adding the content goes: its state, why it failed, and how long it took once done. */
export type MotionAdding = JobRecord<MotionAddState>;
/** `motion-status`'s answer: where the sample is on this Mac, whether the game holds its content, and the add job. */
export type MotionStatus = { sample: string | null; inGame: boolean; adding: MotionAdding };
/** `add-motion-matching`'s answer: started in the background, or the content the game already holds. */
export type AddMotionAnswer = { started: true; note: string } | { already: true };

/** What the Motion Matching tools need from the computer, the editor and the clock. */
export type MotionToolsDeps = RestartDeps & {
  platform: NodeJS.Platform;
  project(storage: string, game: string): Promise<string | undefined>;
  editorCall(storage: string, game: string, tool: CppEditorTool, args: Record<string, unknown>): Promise<unknown>;
  /** The folders whose subfolders are the person's Unreal projects; `~/Documents/Unreal Projects` unless a test stands in. */
  projectRoots?: readonly string[];
  /** The bytes free on a folder's disk; the file system's own count unless a test stands in. */
  freeBytes?(folder: string): Promise<number>;
};

/** One add job's game: the plugin's storage, the game, its .uproject and folder, and the sample's folder. */
type AddTarget = { storage: string; game: string; project: string; gameDir: string; sample: string };
/** Where adding stands for each project, by its .uproject. */
type Jobs = Map<string, MotionAdding>;

const IDLE: MotionAdding = { state: MotionAddState.Idle };
const ADD_STATES = {
  running: MotionAddState.Adding,
  done: MotionAddState.Done,
  failed: MotionAddState.Failed,
} as const;
const CLOSE_WORDS: CloseWords = {
  otherEditor: MESSAGE.OtherEditor,
  notSaved: MESSAGE.NotSaved,
  noSaveAnswer: MESSAGE.NoSaveAnswer,
  unsaved: MESSAGE.Unsaved,
  notClosed: MESSAGE.NotClosed,
};

const contentOf = (projectFile: string) => path.join(path.dirname(projectFile), "Content");
const onDisk = (root: string, inner: string) => path.join(root, ...inner.split("/"));
const gigabytes = (bytes: number) => Math.ceil(bytes / GB);

/** The person's Unreal projects folders. */
const projectRootsOf = (deps: MotionToolsDeps) =>
  deps.projectRoots ?? [path.join(os.homedir(), "Documents", "Unreal Projects")];

/** Whether a file is there (a link counts, as nothing may be written through it). */
const present = async (file: string) => Boolean(await lstat(file).catch(() => null));

/** Whether a folder is the sample itself: its character, and a showcase character no game gets. */
async function isSample(folder: string): Promise<boolean> {
  if (!(await lstat(onDisk(folder, SAMPLE_MARK)).catch(() => null))?.isFile()) return false;
  for (const file of SAMPLE_LEFT_OUT) if (await present(onDisk(path.join(folder, "Content"), file))) return true;
  return false;
}

/** The sample's folder among the person's Unreal projects (the first by name), or null. */
export async function findSample(roots: readonly string[]): Promise<string | null> {
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch((): Dirent[] => []);
    const folders = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    for (const name of folders) if (await isSample(path.join(root, name))) return path.join(root, name);
  }
  return null;
}

/** The files of the sample's Content the game gets (`/`-separated, inside Content) and their bytes; refused at a link. */
export async function sampleFiles(sample: string): Promise<{ files: string[]; bytes: number }> {
  const content = path.join(sample, "Content");
  const left = new Set<string>(SAMPLE_LEFT_OUT);
  const files: string[] = [];
  let bytes = 0;
  for (const folder of SAMPLE_FOLDERS) {
    const entries = await readdir(onDisk(content, folder), { withFileTypes: true, recursive: true }).catch(
      (): Dirent[] => [],
    );
    for (const entry of entries) {
      const inner = path.relative(content, path.join(entry.parentPath, entry.name)).split(path.sep).join("/");
      if (entry.isSymbolicLink()) throw new Error(MESSAGE.Link(inner));
      if (!entry.isFile() || left.has(inner)) continue;
      files.push(inner);
      bytes += (await stat(onDisk(content, inner))).size;
    }
  }
  return { files: files.sort(), bytes };
}

/** The folders the files go in (`/`-separated, inside Content), each once, Content itself as "". */
function foldersOf(files: readonly string[]): string[] {
  const folders = new Set<string>([""]);
  for (const file of files)
    for (let folder = path.posix.dirname(file); folder !== "."; folder = path.posix.dirname(folder))
      folders.add(folder);
  return [...folders];
}

/**
 * Refuses a game whose Content, or a folder in it the sample's files go in, is a link or a file: the
 * copy would write through it, and taking a failed copy back out would delete through it.
 */
async function refuseGameLinks(content: string, files: readonly string[]): Promise<void> {
  for (const folder of foldersOf(files)) {
    const info = await lstat(folder ? onDisk(content, folder) : content).catch(() => null);
    if (info && !info.isDirectory()) throw new Error(MESSAGE.GameLink(folder ? `Content/${folder}` : "Content"));
  }
}

/** The game's files where the sample's would go, at most `MAX_NAMED` of them. */
async function collisions(content: string, files: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const file of files) {
    if (await present(onDisk(content, file))) found.push(file);
    if (found.length >= MAX_NAMED) break;
  }
  return found;
}

/** Refuses a game whose project reaches outside through a link, or that already has files where the sample's go. */
async function refuseGameInTheWay(content: string, files: readonly string[]): Promise<void> {
  await refuseGameLinks(content, files);
  const blocking = await collisions(content, files);
  if (blocking.length) throw new Error(MESSAGE.Collides(blocking.join(", ")));
}

/**
 * Refuses a game without room: a clone (on macOS, on the sample's own disk) needs only
 * `MIN_FREE_BYTES`, a copy the sample's size too.
 */
async function checkDisk(deps: MotionToolsDeps, sample: string, content: string, bytes: number): Promise<void> {
  const projectDir = path.dirname(content);
  const sameDisk = (await stat(sample)).dev === (await stat(projectDir)).dev;
  const clones = deps.platform === StudioPlatform.Mac && sameDisk;
  const need = MIN_FREE_BYTES + (clones ? 0 : bytes);
  const free = await (deps.freeBytes ?? diskFree)(projectDir);
  if (free < need) throw new Error(MESSAGE.NoDisk(gigabytes(need), Math.floor(free / GB)));
}

/** The bytes free to this user on a folder's disk. */
async function diskFree(folder: string): Promise<number> {
  const disk = await statfs(folder);
  return Number(disk.bavail) * Number(disk.bsize);
}

/**
 * Clones (or copies) each of the sample's folders into the game's Content, never over a file there,
 * through folders made below the project that are no links; then takes out what the game doesn't get.
 */
async function copyFolders(platform: NodeJS.Platform, sample: string, content: string): Promise<void> {
  const from = path.join(sample, "Content");
  for (const folder of SAMPLE_FOLDERS) {
    const source = onDisk(from, folder);
    if (!(await lstat(source).catch(() => null))?.isDirectory()) continue;
    const parentParts = [
      "Content",
      ...path.posix
        .dirname(folder)
        .split("/")
        .filter((part) => part !== "."),
    ];
    const parent = await ensureDirBelow(path.dirname(content), parentParts);
    const target = path.join(parent, path.posix.basename(folder));
    if (platform === StudioPlatform.Mac)
      await execFileAsync(MAC_CP, ["-c", "-R", "-n", "--", source, `${parent}${path.sep}`]);
    // Like `cp -n`: into a folder the game has already, skipping a file there (refuseGameInTheWay refused those).
    else await cp(source, target, { recursive: true, errorOnExist: false, force: false });
  }
  for (const file of SAMPLE_LEFT_OUT) await unlink(onDisk(content, file)).catch(() => {});
}

/** Takes a failed copy back out: every file it would have added, then its folders once empty, deepest first. */
async function removeCopy(content: string, files: readonly string[]): Promise<void> {
  for (const file of files) await unlink(onDisk(content, file)).catch(() => {});
  const deepestFirst = foldersOf(files)
    .filter(Boolean)
    .sort((a, b) => b.split("/").length - a.split("/").length);
  for (const folder of deepestFirst) await rmdir(onDisk(content, folder)).catch(() => {});
}

/** A config file's text, or null when the folder has none; any other failure to read it refuses the add. */
const configText = (folder: string, name: string) =>
  readRegularFile(path.join(folder, name), CONFIG_MAX_BYTES).then(
    (bytes) => bytes.toString("utf8"),
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw new Error(MESSAGE.Unreadable(path.join(folder, name), errorMessage(error)));
    },
  );

/** The game's DefaultEngine.ini with the sample's settings merged in, read now; throws when its channel is taken. */
async function mergedEngineIni(sample: string, projectFile: string): Promise<string> {
  const ours = (await configText(path.join(path.dirname(projectFile), "Config"), CONFIG.engine)) ?? "";
  const engine = mergeEngineIni(ours, (await configText(path.join(sample, "Config"), CONFIG.engine)) ?? "");
  if ("conflict" in engine) throw new Error(engine.conflict);
  return engine.text;
}

/**
 * The sample's settings merged into the game's config: its trace channel and console variables into
 * DefaultEngine.ini, its tags into DefaultGameplayTags.ini, its network prediction settings when the
 * game has none. Only additions: nothing the game had is changed.
 */
async function mergeConfig(sample: string, projectFile: string): Promise<void> {
  const theirs = path.join(sample, "Config");
  const ours = path.join(path.dirname(projectFile), "Config");
  const engine = await mergedEngineIni(sample, projectFile);
  const sampleTags = await configText(theirs, CONFIG.tags);
  const prediction = await configText(theirs, CONFIG.prediction);
  await mkdir(ours, { recursive: true });
  await atomicWriteText(path.join(ours, CONFIG.engine), engine);
  if (sampleTags !== null) {
    const tags = mergeGameplayTagsIni(await configText(ours, CONFIG.tags), sampleTags);
    await atomicWriteText(path.join(ours, CONFIG.tags), tags);
  }
  if (prediction !== null && (await configText(ours, CONFIG.prediction)) === null)
    await atomicWriteText(path.join(ours, CONFIG.prediction), prediction);
}

/** The plugins the sample's .uproject turns on. */
async function samplePlugins(sample: string): Promise<string[]> {
  const entries = await readdir(sample).catch(() => []);
  const file = entries.find((name) => name.endsWith(".uproject"));
  if (!file) return [];
  const project = JSON.parse((await readRegularFile(path.join(sample, file), CONFIG_MAX_BYTES)).toString("utf8"));
  const listed = isJsonObject(project) && Array.isArray(project.Plugins) ? project.Plugins : [];
  return listed
    .filter(
      (entry): entry is { Name: string } =>
        isJsonObject(entry) && entry.Enabled === true && typeof entry.Name === "string",
    )
    .map((entry) => entry.Name);
}

/**
 * What the copy adds, as the game's .gitignore keeps it out (`/`-separated, inside Content): in each
 * of the sample's folders, the first folder down a file's path the game doesn't have yet (with a
 * trailing `/`), or the file itself when it goes in a folder the game already has. So the game's own
 * folders, and its files in them, stay in its checkpoints.
 */
export async function copiedEntries(content: string, files: readonly string[]): Promise<string[]> {
  const entries = new Set<string>();
  const exists = new Map<string, boolean>();
  const has = async (folder: string) => {
    if (!exists.has(folder)) exists.set(folder, await present(onDisk(content, folder)));
    return exists.get(folder) === true;
  };
  for (const file of files) {
    const top = SAMPLE_FOLDERS.find((folder) => file.startsWith(`${folder}/`));
    if (!top) continue;
    const below = path.posix.dirname(file.slice(top.length + 1));
    const steps = below === "." ? [] : below.split("/");
    let folder: string = top;
    let entry = `${top}/`;
    for (let at = 0; (await has(folder)) && entry !== file; at++) {
      const step = steps[at];
      folder = step === undefined ? folder : `${folder}/${step}`;
      entry = step === undefined ? file : `${folder}/`;
    }
    entries.add(entry);
  }
  return [...entries].sort();
}

/** The game's .gitignore keeping the copy's entries out, when the project is inside the game folder. */
async function ignoreCopied(gameDir: string, projectFile: string, copied: readonly string[]): Promise<void> {
  const relative = path.relative(gameDir, path.dirname(projectFile));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return;
  const inGame = relative ? `/${relative.split(path.sep).join("/")}/Content` : "/Content";
  // A name's glob characters are its own: escaped, a pattern names that file alone.
  const wanted = copied.map((entry) => `${inGame}/${entry.replace(IGNORE_GLOB, "\\$&")}`);
  const text = (await configText(gameDir, ".gitignore")) ?? "";
  const have = new Set(text.split(/\r?\n/).map((line) => line.trim()));
  const added = wanted.filter((line) => !have.has(line));
  if (!added.length) return;
  const lines = have.has(IGNORE_NOTE) ? added : [IGNORE_NOTE, ...added];
  await atomicWriteText(
    path.join(gameDir, ".gitignore"),
    `${text.replace(/\n*$/, text ? "\n" : "")}${lines.join("\n")}\n`,
  );
}

/** A file the add may change, and its text before (null: it had none). */
type KeptText = { file: string; text: string | null };

/** The texts of every file the add changes beside the copy: the game's config files, its .uproject and its .gitignore. */
async function keepSettings(target: AddTarget): Promise<KeptText[]> {
  const config = path.join(path.dirname(target.project), "Config");
  const files = [
    ...Object.values(CONFIG).map((name) => path.join(config, name)),
    target.project,
    path.join(target.gameDir, ".gitignore"),
  ];
  const kept: KeptText[] = [];
  for (const file of files) kept.push({ file, text: await configText(path.dirname(file), path.basename(file)) });
  return kept;
}

/** Puts those files back as they were: their text, or gone when they had none. */
async function restoreSettings(kept: readonly KeptText[]): Promise<void> {
  for (const { file, text } of kept) {
    if (text === null) await unlink(file).catch(() => {});
    else await atomicWriteText(file, text).catch(() => {});
  }
}

/**
 * Everything the add writes with Unreal closed, the game looked at again first (it may have changed
 * since the start): the .gitignore before any file is copied, then the copy, the config and the
 * plugins. A step that fails takes the copied content back out and puts the settings back.
 */
async function addContent(deps: MotionToolsDeps, target: AddTarget, files: readonly string[]): Promise<void> {
  const content = contentOf(target.project);
  await refuseGameInTheWay(content, files);
  await mergedEngineIni(target.sample, target.project);
  const copied = await copiedEntries(content, files);
  const kept = await keepSettings(target);
  try {
    await ignoreCopied(target.gameDir, target.project, copied);
    await copyFolders(deps.platform, target.sample, content);
    await mergeConfig(target.sample, target.project);
    for (const plugin of await samplePlugins(target.sample)) await enableProjectPlugin(target.project, plugin);
  } catch (failure) {
    await removeCopy(content, [...files, ...SAMPLE_LEFT_OUT]);
    await restoreSettings(kept);
    throw failure;
  }
}

/** The add job: close Unreal, add the content, open Unreal again; an editor it closed is reopened on failure. */
async function addNow(deps: MotionToolsDeps, target: AddTarget, files: readonly string[]): Promise<void> {
  const save = () => deps.editorCall(target.storage, target.game, CppEditorTool.SaveAll, {});
  const wasOpen = await closeForBuild(deps, target, save, CLOSE_WORDS);
  try {
    await addContent(deps, target, files);
  } catch (failure) {
    if (wasOpen && (await deps.restart.editors().catch(() => 1)) === 0)
      await openAndWait(deps, target, MESSAGE.NotAnswering).catch(() => {});
    throw failure;
  }
  await openAndWait(deps, target, MESSAGE.NotAnswering);
}

/** The game's linked project, or why there is none. */
async function linked(deps: MotionToolsDeps, storage: string, game: string): Promise<string> {
  const project = await deps.project(storage, game);
  if (!project) throw new Error(MESSAGE.NoProject);
  return project;
}

/** Whether the game's project holds the sample's character already. */
const holdsSample = async (project: string) =>
  Boolean((await lstat(onDisk(path.dirname(project), SAMPLE_MARK)).catch(() => null))?.isFile());

/**
 * Starts adding the sample's content unless the game holds it (answered as it is) or a job already
 * adds it: refused, with nothing touched, without the sample, for a game with files in its way, or
 * without the disk for it, or whose trace channel is the sample's under another name.
 */
async function startAdding(
  deps: MotionToolsDeps,
  jobs: Jobs,
  where: { storage: string; game: string; gameDir: string | undefined },
): Promise<AddMotionAnswer> {
  const project = await linked(deps, where.storage, where.game);
  if (jobs.get(project)?.state === MotionAddState.Adding) return { started: true, note: MESSAGE.Started };
  if (await holdsSample(project)) return { already: true };
  if (!where.gameDir) throw new Error(MESSAGE.NoFolder);
  const sample = await findSample(projectRootsOf(deps));
  if (!sample) throw new Error(MESSAGE.NoSample);
  const { files, bytes } = await sampleFiles(sample);
  const content = contentOf(project);
  await refuseGameInTheWay(content, files);
  await checkDisk(deps, sample, content, bytes);
  await mergedEngineIni(sample, project);
  // Another call may have started the job while this one checked.
  if (jobs.get(project)?.state === MotionAddState.Adding) return { started: true, note: MESSAGE.Started };
  const target: AddTarget = { storage: where.storage, game: where.game, project, gameDir: where.gameDir, sample };
  runJob(jobs, project, ADD_STATES, deps.now, () => addNow(deps, target, files));
  return { started: true, note: MESSAGE.Started };
}

/** `motion-status` for a game: where the sample is, whether the game holds its content, and the add job. */
async function motionStatus(deps: MotionToolsDeps, jobs: Jobs, storage: string, game: string): Promise<MotionStatus> {
  const project = await deps.project(storage, game).catch(() => undefined);
  const adding = (project ? jobs.get(project) : undefined) ?? IDLE;
  return {
    sample: await findSample(projectRootsOf(deps)),
    inGame: project ? await holdsSample(project) : false,
    adding: { ...adding },
  };
}

/**
 * `motion-status` and `add-motion-matching` over one set of add jobs, and whether a project's job is
 * adding now (`adding`, by its .uproject): Unreal is closed and reopened by Genex itself meanwhile.
 */
export function createMotionTools(deps: MotionToolsDeps) {
  const jobs: Jobs = new Map();
  return {
    status: (storage: string, game: string) => motionStatus(deps, jobs, storage, game),
    add: (storage: string, game: string, gameDir: string | undefined) =>
      startAdding(deps, jobs, { storage, game, gameDir }),
    adding: (project: string) => jobs.get(project)?.state === MotionAddState.Adding,
  };
}
