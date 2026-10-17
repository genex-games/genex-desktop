/**
 * C++ parts on the editor's side. `landPartCpp` brings a part's code from a builder's copy into the
 * game, the editor queue's step before its hot reload. The Loop runner's two tools manage the
 * game's C++ module. `cpp-status` says whether this computer compiles Unreal C++ (a Mac whose
 * Xcode is ready), the game's module and how adding it goes. `add-cpp-module` adds the module in
 * the background, one job per project at a time: it saves the editor's work and quits Unreal (the
 * normal quit), writes the module (`cpp-module.ts`), builds it with UnrealBuildTool (`ubt.ts`) and
 * opens Unreal again, one restart of about two minutes. A project that can't take the module
 * is refused before Unreal is touched, a build that fails takes the module back out, and an editor
 * the job closed is opened again after any failure.
 *
 * Agents write the game folder and the builder's copy, so the copy follows the gate's own rules
 * (`part-files.ts`): plain `.h` and `.cpp` files at most one plain folder deep, read without
 * following a link and within the caps. Anything else in either part folder refuses the whole
 * copy before anything is written, and only the part's own folder in the game changes.
 */
import type { Dirent } from "node:fs";
import { lstat, mkdir, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { atomicWriteText, readRegularFile, writeFileNoFollow } from "../../substrate/fsx.ts";
import {
  type AddCppModuleOptions,
  type AddedCppModule,
  addCppModule,
  checkCppModule,
  isModuleName,
  projectModule,
} from "./cpp-module.ts";
import type { PartCode } from "./editor-queue.ts";
import {
  buildErrors,
  type CloseWords,
  closeForBuild,
  type EditorRestart,
  type JobRecord,
  OPEN_WAIT_MS,
  openAndWait,
  QUIT_WAIT_MS,
  type RestartDeps,
  runJob,
} from "./editor-restart.ts";
import { GAME_PROJECT_FOLDER } from "./game-folder.ts";
import { CPP_FILE, CPP_SUBFOLDER, PART_CPP_LIMITS, PART_NAME } from "./part-files.ts";
import { FINDER_FILE } from "./source-tree.ts";
import { type CompileOptions, type CompileResult, canCompileCpp, compileEditor } from "./ubt.ts";
import type { XcodeState, XcodeStatus } from "./xcode.ts";

/** Where adding the game's C++ module stands: wire values the Loop's runner reads (its `CppAddState`). */
export const CppAddState = { Idle: "idle", Adding: "adding", Done: "done", Failed: "failed" } as const;
export type CppAddState = (typeof CppAddState)[keyof typeof CppAddState];

/** The Genex editor helper's tool the job calls before it quits Unreal. */
export const CppEditorTool = { SaveAll: "save_all" } as const;
export type CppEditorTool = (typeof CppEditorTool)[keyof typeof CppEditorTool];

/** How adding the module goes: its state, why it failed, and how long it took once done. */
export type CppAdding = JobRecord<CppAddState>;
/** `cpp-status`'s answer: whether C++ compiles here, Xcode's state, the platform, the game's module and the add job. */
export type CppStatus = {
  canCompile: boolean;
  xcode: XcodeState;
  platform: string;
  module: string | null;
  adding: CppAdding;
};
/** `add-cpp-module`'s answer: started in the background, or the module the game already has. */
export type AddCppAnswer = { started: true } | { module: string; already: true };

/** What the C++ tools need from the computer, the editor and the clock. */
export type CppToolsDeps = RestartDeps & {
  platform: NodeJS.Platform;
  engine(): Promise<Engine | undefined>;
  project(storage: string, game: string): Promise<string | undefined>;
  xcode(engineDir: string | undefined): Promise<Pick<XcodeStatus, "state"> & Partial<Pick<XcodeStatus, "app">>>;
  editorCall(storage: string, game: string, tool: CppEditorTool, args: Record<string, unknown>): Promise<unknown>;
  restart: EditorRestart;
  /** Writes the module; `addCppModule` unless a test stands in. */
  addModule?: typeof addCppModule;
  /** Builds the project's editor target; UnrealBuildTool's own unless a test stands in. */
  compile?(options: CompileOptions): Promise<CompileResult>;
};

/** A .uproject is a few kilobytes. */
const UPROJECT_MAX_BYTES = 256 * 1024;
const SOURCE_FOLDER = "Source";
const CPP_PARTS_FOLDER = "Parts";
/** How the game's own part folder is named in a refusal (its project folder isn't always the game's `unreal/`). */
const GAME_SHOWN = "the game's project";
const IDLE: CppAdding = { state: CppAddState.Idle };
const ADD_STATES = { running: CppAddState.Adding, done: CppAddState.Done, failed: CppAddState.Failed } as const;
const NOTHING_THERE: PartEntries = { files: [], folders: [] };

const MESSAGE = {
  NoProject: "This game isn't linked to an Unreal project, so there is no project to add a C++ module to.",
  NoEngine: "No supported Unreal is installed, so Genex can't build a C++ module.",
  CannotCompile: (xcode: string) =>
    `This computer can't build Unreal C++ (Xcode: ${xcode}); C++ is built on a Mac whose Xcode is ready.`,
  OtherEditor:
    "Unreal is open, but this game's project isn't answering, so Genex didn't quit it to add C++. Quit Unreal, then try again.",
  NotSaved: (why: string) =>
    `Genex couldn't save your work in Unreal (${why}), so it left Unreal open and added no C++.`,
  NoSaveAnswer: "the Genex editor helper didn't answer",
  Unsaved: (names: string) => `Unreal didn't save ${names}, so Genex left it open and added no C++.`,
  NotClosed: `Unreal didn't close within ${QUIT_WAIT_MS / SECOND_MS} s, so Genex added no C++. Close it from its own window, then try again.`,
  NotBuilt: (why: string) => `The game's new C++ module didn't build, so Genex took it back out: ${why}`,
  NotBuiltNotRemoved: (module: string, why: string) =>
    `The game's new C++ module didn't build, and Genex couldn't take it all back out: remove Source/${module} and its entry in the project's Modules before opening Unreal. ${why}`,
  NotAnswering: `Genex built the game's C++ module, but Unreal didn't answer within ${OPEN_WAIT_MS / MINUTE_MS} minutes of opening it. Open the game from the Unreal button.`,
  ProjectUnreadable: "The game's project file couldn't be read, so Genex added no C++.",
  BadName: "The part's or the module's name isn't a plain identifier. Nothing was copied.",
  NoCopy: "The builder's copy of the game can't be read. Nothing was copied.",
  NoGame: "The game's Unreal project folder can't be read. Nothing was copied.",
  NoCode: (where: string) =>
    `${where} isn't there; a part that lists C++ classes keeps its code there. Nothing was copied.`,
  Refused: (where: string, why: string) => `${where} ${why} Nothing was copied.`,
  Link: "is a link; a part's C++ is plain files in its own folder.",
  NotFolder: "isn't a plain folder.",
  Deep: "is a folder too deep: a part's C++ goes at most one plain-named folder deep (Public/, Private/).",
  NotCpp: "isn't a .h or .cpp file named with letters, digits and _.",
  TooLarge: `is larger than ${PART_CPP_LIMITS.fileBytes / 1024} KB.`,
  Unreadable: "couldn't be read as a plain file.",
  TooMany: `holds more than ${PART_CPP_LIMITS.files} C++ files.`,
} as const;

/** A part folder's files and subfolders, by `/`-separated path inside it. */
type PartEntries = { files: string[]; folders: string[] };
/** What an entry a part folder may hold is. */
const EntryKind = { File: "file", Folder: "folder" } as const;
type EntryKind = (typeof EntryKind)[keyof typeof EntryKind];
const FILE = { kind: EntryKind.File } as const;
const FOLDER = { kind: EntryKind.Folder } as const;
/** One file of a part's C++ folder: its path inside the folder and its bytes. */
type CodeFile = { inner: string; bytes: Buffer };

const refusal = (where: string, why: string) => new Error(MESSAGE.Refused(where, why));
const onDisk = (folder: string, inner: string) => path.join(folder, ...inner.split("/"));

/** How far a chain of folders under `root` exists: the first missing step (steps.length when all are); throws at a link or a non-folder. */
async function existingSteps(root: string, steps: readonly string[], shown: string): Promise<number> {
  for (const [i] of steps.entries()) {
    const reached = steps.slice(0, i + 1);
    const info = await lstat(path.join(root, ...reached)).catch(() => null);
    if (!info) return i;
    const where = [shown, ...reached].join("/");
    if (info.isSymbolicLink()) throw refusal(where, MESSAGE.Link);
    if (!info.isDirectory()) throw refusal(where, MESSAGE.NotFolder);
  }
  return steps.length;
}

/** What one entry of a part folder is: a plain C++ file, a first-level plain folder, or why it can't be there. */
function sortOf(entry: Dirent, inner: string): { kind: EntryKind } | { why: string } {
  if (entry.isSymbolicLink()) return { why: MESSAGE.Link };
  if (entry.isDirectory()) return inner || !CPP_SUBFOLDER.test(entry.name) ? { why: MESSAGE.Deep } : FOLDER;
  return entry.isFile() && CPP_FILE.test(entry.name) ? FILE : { why: MESSAGE.NotCpp };
}

/** Adds the entries of `inner` in a part folder to `found`; throws naming the first that isn't a part's C++. */
async function collect(root: string, inner: string, shown: string, found: PartEntries): Promise<void> {
  const entries = await readdir(onDisk(root, inner), { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === FINDER_FILE) continue;
    const at = inner ? `${inner}/${entry.name}` : entry.name;
    const sort = sortOf(entry, inner);
    if ("why" in sort) throw refusal(`${shown}/${at}`, sort.why);
    if (sort.kind === EntryKind.Folder) {
      found.folders.push(at);
      await collect(root, at, shown, found);
    } else found.files.push(at);
    if (found.files.length > PART_CPP_LIMITS.files) throw refusal(shown, MESSAGE.TooMany);
  }
}

/**
 * A part's C++ folder, checked: its plain .h and .cpp files at most one plain-named folder deep
 * (Finder's file aside) and its subfolders; throws naming anything else, never following a link.
 */
async function partEntries(folder: string, shown: string): Promise<PartEntries> {
  const found: PartEntries = { files: [], folders: [] };
  await collect(folder, "", shown, found);
  return found;
}

/** Each file of a checked part folder with its bytes, read without following a link and within the cap. */
async function readCode(folder: string, shown: string): Promise<CodeFile[]> {
  const { files } = await partEntries(folder, shown);
  return Promise.all(
    files.map(async (inner) => {
      try {
        return { inner, bytes: await readRegularFile(onDisk(folder, inner), PART_CPP_LIMITS.fileBytes) };
      } catch (failure) {
        const tooLarge = (failure as NodeJS.ErrnoException).code === "EFBIG";
        throw refusal(`${shown}/${inner}`, tooLarge ? MESSAGE.TooLarge : MESSAGE.Unreadable);
      }
    }),
  );
}

/** A folder's real path, or `message` as the error when it can't be had. */
const realOr = (folder: string, message: string) =>
  realpath(folder).catch(() => {
    throw new Error(message);
  });

/**
 * Replaces the part's folder in the game with `code`: the missing folders on the way made, the
 * part's earlier files that `code` doesn't have removed, each file written without following a
 * link, and a subfolder left empty removed. Only the part's own folder changes.
 */
async function writeCode(root: string, steps: readonly string[], have: number, code: CodeFile[], old: PartEntries) {
  for (let i = have; i < steps.length; i++) await mkdir(path.join(root, ...steps.slice(0, i + 1)));
  const folder = path.join(root, ...steps);
  const keep = new Set(code.map((file) => file.inner));
  for (const inner of old.files) if (!keep.has(inner)) await unlink(onDisk(folder, inner));
  const used = new Set(code.flatMap((file) => (file.inner.includes("/") ? [file.inner.split("/")[0] ?? ""] : [])));
  for (const sub of used) if (!old.folders.includes(sub)) await mkdir(onDisk(folder, sub));
  for (const file of code) await writeFileNoFollow(onDisk(folder, file.inner), file.bytes);
  // A subfolder still holding Finder's file stays.
  for (const sub of old.folders) if (!used.has(sub)) await rmdir(onDisk(folder, sub)).catch(() => {});
}

/**
 * Brings a C++ part's folder `unreal/Source/<module>/Parts/<part>/` from the builder's copy into the
 * game's project as `Source/<module>/Parts/<part>/`, replacing that folder's files; answers the
 * files copied by their path inside it ([] when the copy is the game itself). Both sides are
 * resolved by real path and checked before anything is written: a link, a file that isn't a
 * plain .h or .cpp, a folder too deep, too many or too large files, in either folder or on the way
 * to it, refuse the whole copy and nothing is written.
 */
export async function landPartCpp(part: string, code: PartCode): Promise<string[]> {
  if (!PART_NAME.test(part) || !isModuleName(code.module)) throw new Error(MESSAGE.BadName);
  const steps = [SOURCE_FOLDER, code.module, CPP_PARTS_FOLDER, part];
  const unreal = path.join(await realOr(code.copy, MESSAGE.NoCopy), GAME_PROJECT_FOLDER);
  const shown = [GAME_PROJECT_FOLDER, ...steps].join("/");
  if ((await lstat(unreal).catch(() => null))?.isDirectory() !== true) throw new Error(MESSAGE.NoCopy);
  if ((await existingSteps(unreal, steps, GAME_PROJECT_FOLDER)) < steps.length) throw new Error(MESSAGE.NoCode(shown));
  const from = path.join(unreal, ...steps);
  const files = await readCode(from, shown);
  const project = await realOr(path.dirname(code.project), MESSAGE.NoGame);
  if (path.join(project, ...steps) === from) return [];
  const have = await existingSteps(project, steps, GAME_SHOWN);
  const old =
    have === steps.length
      ? await partEntries(path.join(project, ...steps), [GAME_SHOWN, ...steps].join("/"))
      : NOTHING_THERE;
  await writeCode(project, steps, have, files, old);
  return files.map((file) => file.inner).sort();
}

/** The supported engine: its version and folder. */
type Engine = { version: string; directory: string };
/** One add job: the game, its project, the engine and the Xcode app UBT may read. */
type AddTarget = { storage: string; game: string; project: string; engine: Engine; xcodeApp: string | null };

/** What adding the module knows of the engine: its own module names are refused, its version sets the include order. */
const moduleOptions = (engine: Engine): AddCppModuleOptions => ({
  engineDir: engine.directory,
  engineVersion: engine.version,
});

/** What closing Unreal to add the module says when it can't. */
const CLOSE_WORDS: CloseWords = {
  otherEditor: MESSAGE.OtherEditor,
  notSaved: MESSAGE.NotSaved,
  noSaveAnswer: MESSAGE.NoSaveAnswer,
  unsaved: MESSAGE.Unsaved,
  notClosed: MESSAGE.NotClosed,
};

/** Closes Unreal for the build when this game's editor is open, saving its work first; answers whether it was open. */
const closeEditor = (deps: CppToolsDeps, target: AddTarget) =>
  closeForBuild(
    deps,
    target,
    () => deps.editorCall(target.storage, target.game, CppEditorTool.SaveAll, {}),
    CLOSE_WORDS,
  );

/** Takes an added module back out: the files it wrote, the folders it made once empty, and the .uproject as it was. */
async function removeModule(projectFile: string, before: Buffer, added: AddedCppModule): Promise<void> {
  const root = await realpath(path.dirname(projectFile));
  for (const relative of added.created) {
    const file = onDisk(root, relative);
    if ((await lstat(file).catch(() => null))?.isFile()) await unlink(file);
  }
  for (const folder of [`${SOURCE_FOLDER}/${added.module}`, SOURCE_FOLDER])
    await rmdir(onDisk(root, folder)).catch(() => {});
  if (added.declared) await atomicWriteText(path.join(root, path.basename(projectFile)), before.toString("utf8"));
}

/** Writes the module and builds the editor target with Unreal closed; a build that fails takes the module back out. */
async function buildModule(deps: CppToolsDeps, target: AddTarget): Promise<void> {
  const before = await readRegularFile(target.project, UPROJECT_MAX_BYTES).catch(() => {
    throw new Error(MESSAGE.ProjectUnreadable);
  });
  const added = await (deps.addModule ?? addCppModule)(target.project, moduleOptions(target.engine));
  const compile = deps.compile ?? compileEditor;
  const result = await compile({
    engineDir: target.engine.directory,
    projectFile: target.project,
    module: added.module,
    xcodeApp: target.xcodeApp,
  });
  if (result.ok) return;
  const removed = await removeModule(target.project, before, added).then(
    () => true,
    () => false,
  );
  const why = `${result.summary}${buildErrors(result)}`;
  throw new Error(removed ? MESSAGE.NotBuilt(why) : MESSAGE.NotBuiltNotRemoved(added.module, why));
}

/** Opens the game's project in Unreal and waits until it answers; throws when it doesn't. */
const openEditor = (deps: CppToolsDeps, target: AddTarget) => openAndWait(deps, target, MESSAGE.NotAnswering);

/** Opens Unreal again after a failure, when no editor runs; never throws (the failure says what went wrong). */
async function reopen(deps: CppToolsDeps, target: AddTarget): Promise<void> {
  if ((await deps.restart.editors().catch(() => 1)) > 0) return;
  await openEditor(deps, target).catch(() => {});
}

/** The add job: close Unreal, write and build the module, open Unreal again; an editor it closed is reopened on failure. */
async function addNow(deps: CppToolsDeps, target: AddTarget): Promise<void> {
  const wasOpen = await closeEditor(deps, target);
  try {
    await buildModule(deps, target);
  } catch (failure) {
    if (wasOpen) await reopen(deps, target);
    throw failure;
  }
  await openEditor(deps, target);
}

/** Where adding stands for each project, by its .uproject. */
type Jobs = Map<string, CppAdding>;

/** The game's linked project, or why there is none. */
async function linked(deps: CppToolsDeps, storage: string, game: string): Promise<string> {
  const project = await deps.project(storage, game);
  if (!project) throw new Error(MESSAGE.NoProject);
  return project;
}

/**
 * Starts adding the module unless the game has one (answered as it is) or a job already adds it:
 * refused, with nothing touched, without a supported engine, where C++ can't compile, or for a
 * project that can't take the module.
 */
async function startAdding(deps: CppToolsDeps, jobs: Jobs, storage: string, game: string): Promise<AddCppAnswer> {
  const project = await linked(deps, storage, game);
  if (jobs.get(project)?.state === CppAddState.Adding) return { started: true };
  const module = await projectModule(project);
  if (module) return { module, already: true };
  const engine = await deps.engine();
  if (!engine) throw new Error(MESSAGE.NoEngine);
  const xcode = await deps.xcode(engine.directory);
  if (!canCompileCpp(xcode, deps.platform)) throw new Error(MESSAGE.CannotCompile(xcode.state));
  await checkCppModule(project, moduleOptions(engine));
  // Another call may have started the job while this one checked.
  if (jobs.get(project)?.state === CppAddState.Adding) return { started: true };
  const target: AddTarget = { storage, game, project, engine, xcodeApp: xcode.app ?? null };
  runJob(jobs, project, ADD_STATES, deps.now, () => addNow(deps, target));
  return { started: true };
}

/** `cpp-status` for a game: whether C++ compiles here, Xcode's state, the platform, its module and its add job. */
async function cppStatus(deps: CppToolsDeps, jobs: Jobs, storage: string, game: string): Promise<CppStatus> {
  const engine = await deps.engine();
  const xcode = await deps.xcode(engine?.directory);
  const project = await deps.project(storage, game).catch(() => undefined);
  const module = project ? ((await projectModule(project)) ?? null) : null;
  const adding = (project ? jobs.get(project) : undefined) ?? IDLE;
  return {
    canCompile: canCompileCpp(xcode, deps.platform),
    xcode: xcode.state,
    platform: deps.platform,
    module,
    adding: { ...adding },
  };
}

/**
 * `cpp-status` and `add-cpp-module` over one set of add jobs, and whether a project's job is adding
 * now (`adding`, by its .uproject): Unreal is closed and reopened by Genex itself meanwhile.
 */
export function createCppTools(deps: CppToolsDeps) {
  const jobs: Jobs = new Map();
  return {
    status: (storage: string, game: string) => cppStatus(deps, jobs, storage, game),
    add: (storage: string, game: string) => startAdding(deps, jobs, storage, game),
    adding: (project: string) => jobs.get(project)?.state === CppAddState.Adding,
  };
}
