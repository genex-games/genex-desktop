/**
 * How Genex runs Godot: each job is a value (its arguments, what it may read and write, its
 * deadline), and one runner starts it in Genex's sandbox. On a Mac that is the sandbox Genex's
 * native jobs use (`runNativeProcess`): Godot gets a private home (so a game's `user://` files and
 * Godot's own caches stay out of the person's), no network, writes only to the project and the
 * job's own folders, and its whole process group is stopped at its deadline or the turn's Stop. On
 * Windows the job is the host's sandbox job (`sandbox.run`: ProcessSandbox, as the sandbox user,
 * no network), which reads and writes only inside the game: a folder the job writes outside it (a
 * capture's stills, the class reference) waits in the project's own `.godot` folder and is copied
 * out once the job ends, and a file it reads outside it (an export template) is copied in first. A deadline is a must: a script that awaits a frame that never draws (a headless
 * capture) would wait forever. Tests hand in their own runner and never start Godot.
 */
import { randomUUID } from "node:crypto";
import { constants as FS } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, rmdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { PluginContext } from "../../plugin-sdk/index.d.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import {
  PLUGIN_SANDBOX_MAX_RUNNING,
  type PluginSandboxJob,
  type PluginSandboxRunArgs,
  PluginService,
  SandboxJobState,
} from "../../shared/plugins.ts";
import { createFileInDir, openNoFollow, writeFileNoFollow } from "../../substrate/fsx.ts";
import { isBelow, isInside } from "../../substrate/paths.ts";
import { NativeEndReason, runNativeProcess } from "../../substrate/plugins/native-process.ts";
import { type KeyPress, keysArg, PLAY_FPS, type ShotAt, shotsArg } from "./play-input.ts";

/** The jobs Genex runs Godot for. Never rename a value: records name them. */
export const GodotJob = {
  Import: "import",
  Check: "check",
  Run: "run",
  Capture: "capture",
  Play: "play",
  Reference: "reference",
  Export: "export",
  /** Windows: a file Genex staged put into Godot's own data folder (an export template). */
  Data: "data",
} as const;
export type GodotJob = (typeof GodotJob)[keyof typeof GodotJob];

/** Genex's own GDScript, shipped beside the backend in `scripts/`. */
export const GodotScript = { Check: "genex_check.gd", Play: "genex_play.gd", Data: "genex_data.gd" } as const;

/** An import of a big project's assets can take minutes the first time; later ones are quick. */
const IMPORT_TIMEOUT_MS = 5 * MINUTE_MS;
const CHECK_TIMEOUT_MS = 2 * MINUTE_MS;
const REFERENCE_TIMEOUT_MS = 2 * MINUTE_MS;
const DATA_TIMEOUT_MS = MINUTE_MS;
/** A run's own seconds play at a fixed 60 frames each, faster than real time headless; this covers its start and a slow game. */
const RUN_START_MS = 30 * SECOND_MS;
const RUN_SECOND_BUDGET_MS = 3 * SECOND_MS;
/** The frames a run plays each second of its game time (the play script's own rate). */
export const RUN_FPS = PLAY_FPS;
/** The longest a run plays and the default, in game seconds. */
export const MAX_RUN_SECONDS = 60;
export const DEFAULT_RUN_SECONDS = 5;
/** The size of a still, and where its window opens: off every screen, so it never covers the person's work. */
const STILL_SIZE = "1280x720";
const OFF_SCREEN = "-10000,-10000";
/** The most of Godot's output one job keeps, from its end. */
const OUTPUT_BYTES = 200_000;
const SCRATCH_PREFIX = "genex-godot-";
/** The private home the sandbox makes in a job's scratch folder (`runNativeProcess`). */
const HOME_FOLDER = "home";
/** How often a Windows job's record is read while it runs. */
const JOB_POLL_MS = SECOND_MS / 4;
/**
 * Where a Windows job's folders and files outside the game wait while it runs: the project's own
 * cache folder, or with no project in the game (a class reference before the first game) a folder
 * of the job's own at the game's root, removed with it.
 */
const STAGING = [".godot", "genex-jobs"];
const OWN_FOLDER_PREFIX = "genex-godot-job-";
/** The game's ignore file, and its line that keeps a job's own folder out of every save point and checkpoint. */
const IGNORE_FILE = ".gitignore";
const OWN_FOLDER_IGNORE = `${OWN_FOLDER_PREFIX}*/`;
/** How often, and how far apart, removing a stage is tried again while Windows still holds a file in it. */
const CLEANUP_RETRIES = 5;
const CLEANUP_RETRY_MS = SECOND_MS / 5;
const INPUTS_FOLDER = "in";
/** A stage's own name: a UUID, so the sweep never takes a folder someone else named. */
const STAGE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Windows's own folder when its environment names none, and its command interpreter in it, whose `rd` removes a stage. */
const WINDOWS_ROOT = "C:\\Windows";
const WINDOWS_CMD = ["System32", "cmd.exe"];
const REMOVE_MS = MINUTE_MS;
/** The most of rd's own words a log line keeps. */
const REMOVAL_WORDS_CHARS = 300;
/** The variable `rd`'s line reaches cmd in: expanded before cmd reads `&` or `^`, which stay plain inside its quotes. */
const REMOVE_LINE_ENV = "GODOT_STAGE_RD";
/** What a job leaves in a staged folder for Genex (stills, class reference pages), how much, and how deep. */
const COPY_OUT_KINDS: ReadonlySet<string> = new Set([".png", ".xml"]);
const COPY_OUT_MAX_BYTES = 16 * 1024 * 1024;
const COPY_OUT_MAX_FILES = 5000;
const COPY_OUT_DEPTH = 4;
/** A terminal's colour sequence, which Godot's Windows build prints into a file too. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape character is what this removes
const COLOUR = /\x1b\[[0-9;]*m/g;

const MESSAGE = {
  Unsupported: "Genex runs Godot on a Mac and on Windows.",
  NoGame: "Open a game in Genex first: on Windows Genex runs Godot in the game's folder.",
  OutsideGame:
    "On Windows Genex runs Godot only on a project inside the game's folder; this game's project is linked from elsewhere.",
  NotStarted: (reason: string) => `Genex's sandbox didn't start Godot (${reason}).`,
  Lost: "Genex's sandbox lost Godot's job before it ended.",
  StageLink: (folder: string) =>
    `Genex runs Godot's jobs only in folders of the game's own: ${folder} is a link or a junction, so Genex stopped. Remove it, then try again.`,
  TooManyFiles: "Godot's job left more files than Genex copies out of it.",
  /** A line for the backend's log (the developer's debug sink), never shown to the person. */
  StageLeft: (stage: string, why: string) =>
    `Genex Godot: a job's folder is still there after its removal (${why}); the next sweep tries again: ${stage}`,
} as const;

/** One job: Godot's arguments, the folder it runs in, what it may read and write, and its deadline. */
export type GodotCall = {
  job: GodotJob;
  args: string[];
  cwd: string;
  reads: string[];
  writes: string[];
  timeoutMs: number;
  /** A job that draws (a still) needs the GPU and a window. */
  gpu: boolean;
  /** Files written under names that only start so (a program's own temporary names), as real absolute paths. */
  writePrefixes?: string[];
  /** A Mac's: folders linked into the job's private home (`at`, relative to it), read-only: the person's export templates. */
  homeLinks?: ReadonlyArray<{ at: string; to: string }>;
  /**
   * Windows's: files outside the game the job reads (Genex's own scripts in the plugin's package,
   * an export template), copied in before it starts: the sandbox user reads neither folder.
   */
  stagedInputs?: readonly string[];
};

/** What a job printed (errors first, then the rest), and how it ended. */
export type GodotResult = { output: string; timedOut: boolean; cancelled: boolean };

/**
 * What a job runs under: the call's stop, the plugin's host (a Windows job is the host's sandbox
 * job), the open game's folder, and its Godot project, where a Windows job's folders outside the
 * game wait while it runs.
 */
export type GodotJobScope = {
  signal: AbortSignal;
  host: PluginContext["host"];
  game: string | undefined;
  project: string | null;
  /**
   * The time a call has for this job, read when it starts (after any wait for its turn): its
   * deadline on `now`'s clock, and the least it starts with (`refusal` when less is left).
   */
  budget?: { until: number; now: () => number; least: number; refusal: string };
};

/** Starts one job with a Godot binary; the scope's signal stops it. */
export type GodotRunner = (binary: string, call: GodotCall, job: GodotJobScope) => Promise<GodotResult>;

/** An import: Godot reads the project's assets and scripts into `.godot/`, which a check and a run need first. */
export function importCall(project: string): GodotCall {
  return {
    job: GodotJob.Import,
    args: ["--headless", "--path", project, "--import"],
    cwd: project,
    reads: [],
    writes: [project],
    timeoutMs: IMPORT_TIMEOUT_MS,
    gpu: false,
  };
}

/** A check: Genex's check script loads every script, scene and resource, so Godot names each problem. */
export function checkCall(project: string, scripts: string): GodotCall {
  return {
    job: GodotJob.Check,
    args: ["--headless", "--path", project, "-s", path.join(scripts, GodotScript.Check)],
    cwd: project,
    reads: [scripts],
    writes: [project],
    stagedInputs: [path.join(scripts, GodotScript.Check)],
    timeoutMs: CHECK_TIMEOUT_MS,
    gpu: false,
  };
}

/** A headless run of a scene (the main scene when `scene` is empty) for `seconds` of game time at a fixed frame rate. */
export function runCall(project: string, scene: string, seconds: number): GodotCall {
  return {
    job: GodotJob.Run,
    args: [
      "--headless",
      "--path",
      project,
      "--fixed-fps",
      String(RUN_FPS),
      "--quit-after",
      String(seconds * RUN_FPS),
      ...(scene ? ["--scene", scene] : []),
    ],
    cwd: project,
    reads: [],
    writes: [project],
    timeoutMs: RUN_START_MS + seconds * RUN_SECOND_BUDGET_MS,
    gpu: false,
  };
}

/**
 * A play of a scene (the main scene when `scene` is empty) through Genex's play script: `frames` at
 * 60 a second, `keys` pressed on their timeline, and `shots` saved as `<out>-<frame>-<n>.png`. With
 * stills it draws, in a window off every screen; without, it runs headless. `hero` lets the game's
 * own project settings move its hero shot (`genex/shot_seconds`, `genex/shot_keys`).
 */
export type PlayRequest = {
  scene: string;
  frames: number;
  keys: readonly KeyPress[];
  shots: readonly ShotAt[];
  out: string | null;
  most: number;
  hero: boolean;
};

/** The play script's arguments for a request, each one `key=value`. */
function playArgs(request: PlayRequest): string[] {
  return [
    `scene=${request.scene}`,
    `frames=${request.frames}`,
    `keys=${keysArg(request.keys)}`,
    `shots=${shotsArg(request.shots)}`,
    ...(request.out ? [`out=${request.out}`] : []),
    `most=${request.most}`,
    ...(request.hero ? ["hero=1"] : []),
  ];
}

/** A play job: drawn with stills to take, headless without. */
export function playCall(project: string, scripts: string, request: PlayRequest): GodotCall {
  const draws = request.out !== null && request.shots.length > 0;
  const window = draws ? ["--position", OFF_SCREEN, "--resolution", STILL_SIZE, "--disable-vsync"] : ["--headless"];
  const seconds = request.frames / PLAY_FPS;
  return {
    job: draws ? GodotJob.Capture : GodotJob.Play,
    args: [
      ...window,
      "--path",
      project,
      "--fixed-fps",
      String(PLAY_FPS),
      "-s",
      path.join(scripts, GodotScript.Play),
      "--",
      ...playArgs(request),
    ],
    cwd: project,
    reads: [scripts],
    writes: [project, ...(draws && request.out ? [path.dirname(request.out)] : [])],
    stagedInputs: [path.join(scripts, GodotScript.Play)],
    timeoutMs: RUN_START_MS + Math.ceil(seconds) * RUN_SECOND_BUDGET_MS,
    gpu: draws,
  };
}

/**
 * Windows's: the person's file (an export template) put at `to` in Godot's own data folder as the
 * sandbox user sees it, where an export looks for templates; that user can't read the person's.
 */
export function dataCopyCall(project: string, scripts: string, file: string, to: string): GodotCall {
  return {
    job: GodotJob.Data,
    args: [
      "--headless",
      "--path",
      project,
      "-s",
      path.join(scripts, GodotScript.Data),
      "--",
      `from=${file}`,
      `to=${to.split(path.sep).join("/")}`,
    ],
    cwd: project,
    reads: [scripts],
    writes: [project],
    stagedInputs: [file, path.join(scripts, GodotScript.Data)],
    timeoutMs: DATA_TIMEOUT_MS,
    gpu: false,
  };
}

/** Godot's class reference as XML (`<folder>/doc/classes/*.xml`, its modules' beside), for one version. */
export function referenceCall(folder: string): GodotCall {
  return {
    job: GodotJob.Reference,
    args: ["--headless", "--doctool", folder],
    cwd: folder,
    reads: [],
    writes: [folder],
    timeoutMs: REFERENCE_TIMEOUT_MS,
    gpu: false,
  };
}

/** The job's home (`<scratch>/home`, as the sandbox makes it) with each link in place before Godot starts. */
async function linkIntoHome(scratch: string, links: NonNullable<GodotCall["homeLinks"]>): Promise<void> {
  for (const { at, to } of links) {
    const where = path.join(scratch, HOME_FOLDER, at);
    await mkdir(path.dirname(where), { recursive: true });
    await symlink(to, where);
  }
}

/** The runner Genex uses on this computer: a Mac's native-job sandbox, Windows's host sandbox jobs. */
export function confinedRunner(platform: NodeJS.Platform = process.platform): GodotRunner {
  if (platform === "darwin") return macRunner;
  if (platform === "win32") return windowsRunner(sleep, windowsCmd(process.env));
  return async () => {
    throw new Error(MESSAGE.Unsupported);
  };
}

/** A Mac's: each job in the native-job sandbox, in a scratch folder removed after it. */
const macRunner: GodotRunner = async (binary, call, { signal }) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), SCRATCH_PREFIX));
  try {
    await linkIntoHome(scratch, call.homeLinks ?? []);
    const ended = await runNativeProcess({
      binary,
      args: call.args,
      cwd: call.cwd,
      scratch,
      reads: call.reads,
      writes: call.writes,
      ...(call.writePrefixes ? { writePrefixes: call.writePrefixes } : {}),
      denyRead: [],
      gpu: call.gpu,
      signal,
      timeoutMs: call.timeoutMs,
      maxOutputBytes: OUTPUT_BYTES,
    });
    return {
      output: `${ended.stderr}\n${ended.stdout}`,
      timedOut: ended.reason === NativeEndReason.Timeout,
      cancelled: ended.reason === NativeEndReason.Cancelled,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};

/** A folder a Windows job writes outside the game, and where it waits inside the project while the job runs. */
type Staged = { folder: string; staged: string };

/** Whether a Windows job may name `folder` as one it writes: a folder inside the game, in none of its hidden folders. */
function writableInGame(game: string, folder: string): boolean {
  if (!isBelow(game, folder)) return false;
  return !path
    .relative(game, folder)
    .split(path.sep)
    .some((part) => part.startsWith("."));
}

/**
 * A Windows job's folders: those inside the game it names as it writes them, each other one staged
 * (the stage named in their place), and each file it reads from outside the game staged too. The
 * stage is in the project's `.godot`, or a folder of the job's own when the game has no project of
 * its own; a job that writes a project linked from outside the game is refused.
 */
async function windowsFolders(call: GodotCall, job: GodotJobScope) {
  if (!job.game) throw new Error(MESSAGE.NoGame);
  const game = await realpath(job.game);
  const linked = job.project ? await realpath(job.project).catch(() => job.project) : null;
  const project = linked && writableInGame(game, linked) ? linked : null;
  const root = project
    ? path.join(project, ...STAGING, randomUUID())
    : path.join(game, `${OWN_FOLDER_PREFIX}${randomUUID()}`);
  const outside = linked && !project ? linked : null;
  const { writes, staged } = await splitWrites(call.writes, { game, outside, root });
  const inputs = (call.stagedInputs ?? []).map((file, index) => ({
    folder: file,
    staged: path.join(root, INPUTS_FOLDER, String(index), path.basename(file)),
  }));
  if (!project) await ignoreOwnFolders(game);
  // The real folder the stage is made in: every folder from it to the stage is checked as Genex's own.
  const base = project ?? game;
  return { root, base, game, project, writes: writes.length ? writes : [project ?? root], staged, inputs };
}

/**
 * Whether `folder` (below `base`, a real path) is a real folder reached through real folders only:
 * no link or junction on the way, and its real path is the one named. Nothing is made, listed,
 * copied out of or removed through one that isn't, since Genex's backend runs as the person.
 */
async function realBelow(base: string, folder: string): Promise<boolean> {
  if (!isBelow(base, folder)) return false;
  let at = base;
  for (const part of path.relative(base, folder).split(path.sep)) {
    at = path.join(at, part);
    if (!(await isRealFolder(at))) return false;
  }
  const real = await realpath(folder).catch(() => null);
  return real !== null && path.relative(real, folder) === "";
}

/** Whether `folder` is a folder itself, never a link or a junction to one. */
const isRealFolder = async (folder: string): Promise<boolean> => {
  const stat = await lstat(folder).catch(() => null);
  return stat?.isDirectory() === true && !stat.isSymbolicLink();
};

/** Makes `folder` below `base` one folder at a time, refusing one that is a link or a junction. */
async function makeBelow(base: string, folder: string): Promise<void> {
  let at = base;
  for (const part of path.relative(base, folder).split(path.sep)) {
    at = path.join(at, part);
    await mkdir(at).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (!(await isRealFolder(at))) throw new Error(MESSAGE.StageLink(at));
  }
  if (!(await realBelow(base, folder))) throw new Error(MESSAGE.StageLink(folder));
}

/**
 * A job's write folders: those inside the game named as they are, each other one staged under
 * `root`; one in a project linked from outside the game (`outside`) is refused.
 */
async function splitWrites(folders: readonly string[], at: { game: string; outside: string | null; root: string }) {
  const writes: string[] = [];
  const staged: Staged[] = [];
  for (const folder of folders) {
    const real = await realpath(folder).catch(() => folder);
    if (at.outside && isInside(at.outside, real)) throw new Error(MESSAGE.OutsideGame);
    if (writableInGame(at.game, real)) writes.push(real);
    else staged.push({ folder, staged: path.join(at.root, String(staged.length)) });
  }
  return { writes, staged };
}

/**
 * The game's `.gitignore` names a job's own folders (`genex-godot-job-` and any name after), so a save point or a
 * checkpoint taken while the job runs, or after a crash left it, never keeps it; what is there
 * stays, and nothing is written through a link.
 */
async function ignoreOwnFolders(game: string): Promise<void> {
  const file = path.join(game, IGNORE_FILE);
  const current = await readFile(file, "utf8").catch(() => null);
  if (current?.split(/\r?\n/).some((line) => line.trim() === OWN_FOLDER_IGNORE)) return;
  const before = current === null ? "" : `${current.replace(/\s*$/, "")}\n`;
  await writeFileNoFollow(file, `${before}${OWN_FOLDER_IGNORE}\n`);
}

/** A stage and the real folder it was made in. */
type Stage = { base: string; stage: string };

/**
 * Every stage a job of this game left, at the game's root and in its project's `.godot`: none of
 * them is running. Only real folders are stages: a link or a junction among them, or in place of
 * `.godot` or its `genex-jobs`, is never listed through or removed.
 */
async function staleStages(game: string, project: string | null): Promise<Stage[]> {
  const own = (await foldersIn(game)).filter(
    (name) => name.startsWith(OWN_FOLDER_PREFIX) && STAGE_NAME.test(name.slice(OWN_FOLDER_PREFIX.length)),
  );
  const stages = own.map((name) => ({ base: game, stage: path.join(game, name) }));
  const inProject = project ? path.join(project, ...STAGING) : null;
  if (!project || !inProject || !(await realBelow(project, inProject))) return stages;
  const left = (await foldersIn(inProject)).filter((name) => STAGE_NAME.test(name));
  return [...stages, ...left.map((name) => ({ base: project, stage: path.join(inProject, name) }))];
}

/** The names of the real folders in `folder` (no link, junction or file). */
async function foldersIn(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name);
}

/** Windows's own command interpreter by its full path under SystemRoot, so neither PATH nor the current folder stands in. */
export function windowsCmd(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot && path.win32.isAbsolute(env.SystemRoot) ? env.SystemRoot : WINDOWS_ROOT;
  return path.win32.join(root, ...WINDOWS_CMD);
}

/**
 * The sandbox job that removes a stage: Windows's `rd`, which removes a link or a junction it meets
 * rather than what it points to, run as the sandbox user, so even one swapped in while it works
 * reaches only what that user may write. Genex's backend, which runs as the person, never walks a
 * stage to remove it.
 */
function removalRequest(cmd: string, { base, stage }: Stage): PluginSandboxRunArgs {
  // A stage of the project's is removed with the project's rights; one of the job's own at the game's root with its own.
  const writes = path.dirname(stage) === base ? [stage] : [base];
  return {
    program: cmd,
    args: ["/d", "/v:off", "/c", `%${REMOVE_LINE_ENV}%`],
    env: { [REMOVE_LINE_ENV]: `rd /s /q "${stage}"` },
    reads: [path.win32.dirname(cmd)],
    writes,
    timeoutMs: REMOVE_MS,
  };
}

/**
 * Removes a stage through the sandbox (`removalRequest`), trying again while Windows still holds a
 * file in it (an antivirus scan, Godot not quite gone); one still held is left for the next sweep,
 * never failing the job. What the sandbox left is an empty folder at most, removed by itself (never
 * what is in it). A stage that isn't there, or no longer a real folder of `base`, is left as it is.
 */
async function removeStage(
  stage: Stage,
  remove: (stage: Stage) => Promise<string>,
  wait: (ms: number) => Promise<unknown>,
): Promise<void> {
  for (let tries = 0; ; tries += 1) {
    if (!(await realBelow(stage.base, stage.stage))) return;
    const why = await remove(stage).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    // rd may leave the folder itself where the sandbox user may not remove it: an empty one goes now.
    if (await realBelow(stage.base, stage.stage)) await rmdir(stage.stage).catch(() => undefined);
    if (!(await realBelow(stage.base, stage.stage))) return;
    if (tries >= CLEANUP_RETRIES) {
      console.error(MESSAGE.StageLeft(stage.stage, why || "Windows still holds a file in it"));
      return;
    }
    await wait(CLEANUP_RETRY_MS);
  }
}

/** What a removal job's end says when it removed nothing: rd's own words, or its exit code. */
function removalWords(record: PluginSandboxJob): string {
  const said = `${record.stderr ?? ""} ${record.stdout ?? ""}`.trim();
  if (said) return said.slice(0, REMOVAL_WORDS_CHARS);
  return record.reason ?? `rd ended with ${record.exitCode ?? record.state}`;
}

/**
 * The stage, each staged folder in it, and each file read from outside the game copied in, before
 * the job starts: each made one folder at a time from `base`, never through a link or a junction.
 */
async function stageFolders(
  { base, root }: { base: string; root: string },
  staged: readonly Staged[],
  inputs: readonly Staged[],
): Promise<void> {
  await makeBelow(base, root);
  for (const { staged: folder } of staged) await makeBelow(base, folder);
  for (const { folder: file, staged: copy } of inputs) {
    await makeBelow(base, path.dirname(copy));
    // Made new, and only while its folder still resolves to itself: never written through a link swapped in.
    await createFileInDir(path.dirname(copy), path.basename(copy), await readFile(file));
  }
}

/**
 * What a job wrote in a staged folder, copied out to the folder the call named: only its stills and
 * class reference pages, one plain file at a time, each opened without following a link and kept
 * only while its folder still resolves to itself under `base`. Links, junctions and anything else
 * are left behind; nothing is copied as a tree.
 */
async function copyOut(base: string, staged: readonly Staged[]): Promise<void> {
  const left = { files: COPY_OUT_MAX_FILES };
  for (const { folder, staged: inProject } of staged) await copyFolderOut(base, inProject, folder, 0, left);
}

/** One staged folder's stills and pages copied out to `to`, and its folders' to theirs, `depth` folders down. */
async function copyFolderOut(base: string, from: string, to: string, depth: number, left: { files: number }) {
  if (!(await realBelow(base, from))) throw new Error(MESSAGE.StageLink(from));
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const source = path.join(from, entry.name);
    if (entry.isDirectory() && depth < COPY_OUT_DEPTH) {
      await copyFolderOut(base, source, path.join(to, entry.name), depth + 1, left);
      continue;
    }
    if (!entry.isFile() || !COPY_OUT_KINDS.has(path.extname(entry.name).toLowerCase())) continue;
    left.files -= 1;
    if (left.files < 0) throw new Error(MESSAGE.TooManyFiles);
    const bytes = await readStaged(base, from, source).catch(() => null);
    if (bytes) await writeFileNoFollow(path.join(to, entry.name), bytes);
  }
}

/**
 * A staged file's bytes, or null: a plain file opened without following a link, kept only while its
 * folder still is the stage's own and its name still names the very file read, and that folder
 * still is the stage's after that (a junction put in for the open and taken out for the checks reads
 * another file than the name holds now, and is refused). `between` runs after the open: a test's swap.
 */
export async function readStaged(
  base: string,
  folder: string,
  file: string,
  between?: () => Promise<void>,
): Promise<Buffer | null> {
  const handle = await openNoFollow(file, FS.O_RDONLY | FS.O_NONBLOCK);
  try {
    await between?.();
    const read = await handle.stat();
    if (!read.isFile() || read.size > COPY_OUT_MAX_BYTES) return null;
    const bytes = await handle.readFile();
    if (bytes.length > COPY_OUT_MAX_BYTES || !(await realBelow(base, folder))) return null;
    const named = await lstat(file).catch(() => null);
    const same = named !== null && !named.isSymbolicLink() && named.dev === read.dev && named.ino === read.ino;
    return same && (await realBelow(base, folder)) ? bytes : null;
  } finally {
    await handle.close();
  }
}

/** A path as Godot prints it on Windows too: with forward slashes. */
const slashed = (folder: string): string => folder.replaceAll("\\", "/");

/**
 * A text with each staged folder's path put in place of its folder's (`toStaged`), or back; back,
 * Godot's own spelling of it (forward slashes) is put back too.
 */
function swapFolders(text: string, staged: readonly Staged[], toStaged: boolean): string {
  return staged.reduce((swapped, { folder, staged: inProject }) => {
    if (toStaged) return swapped.replaceAll(folder, inProject);
    return swapped.replaceAll(inProject, folder).replaceAll(slashed(inProject), slashed(folder));
  }, text);
}

/** The sandbox job a Godot call is: Godot itself, reading its own folder and the call's, writing the folders named. */
function sandboxRequest(binary: string, call: GodotCall, folders: Awaited<ReturnType<typeof windowsFolders>>) {
  const reads = [...new Set([path.dirname(binary), ...call.reads])];
  const request: PluginSandboxRunArgs = {
    program: binary,
    args: call.args.map((arg) => swapFolders(arg, [...folders.inputs, ...folders.staged], true)),
    reads,
    writes: folders.writes,
    timeoutMs: call.timeoutMs,
  };
  return request;
}

/** Follows a sandbox job until it ends; a stop of the call stops it. */
async function jobEnd(job: GodotJobScope, id: string, wait: (ms: number) => Promise<unknown>) {
  let stopping = false;
  for (;;) {
    if (job.signal.aborted && !stopping) {
      stopping = true;
      await job.host(PluginService.SandboxStop, { id }).catch(() => undefined);
    }
    const record: PluginSandboxJob | null = await job.host(PluginService.SandboxResult, { id });
    if (!record) throw new Error(MESSAGE.Lost);
    if (record.state !== SandboxJobState.Running) return record;
    await wait(JOB_POLL_MS);
  }
}

/** A job's end as a Godot result: what it printed (as a Mac's lines read), staged paths named as their folders, and how it ended. */
function resultOf(record: PluginSandboxJob, staged: readonly Staged[]): GodotResult {
  if (record.state === SandboxJobState.Failed) throw new Error(MESSAGE.NotStarted(record.reason ?? ""));
  const printed = `${record.stderr ?? ""}\n${record.stdout ?? ""}`.replaceAll("\r\n", "\n").replace(COLOUR, "");
  return {
    output: swapFolders(printed.slice(-OUTPUT_BYTES), staged, false),
    timedOut: record.state === SandboxJobState.TimedOut,
    cancelled: record.state === SandboxJobState.Stopped,
  };
}

/**
 * Windows's: each job a sandbox job of the host's (ProcessSandbox, as the sandbox user), followed
 * until it ends; what it wrote in a staged folder is copied out to the folder the call named, and
 * the staged folders are removed either way. `wait` is the pause between two reads of its record.
 */
export function windowsRunner(wait: (ms: number) => Promise<unknown> = sleep, cmd = windowsCmd({})): GodotRunner {
  const turn = jobTurns(PLUGIN_SANDBOX_MAX_RUNNING);
  // Cleaning up is never stopped: a stopped call's stage still goes.
  const always = new AbortController().signal;
  /** A stage removed by the sandbox user, at its turn among the plugin's jobs. */
  const removal = (job: GodotJobScope) => async (stage: Stage) => {
    const done = await turn(always);
    try {
      const { id } = await job.host(PluginService.SandboxRun, removalRequest(cmd, stage));
      return removalWords(await jobEnd({ ...job, signal: always }, id, wait));
    } finally {
      done();
    }
  };
  // Once per game after the backend starts, before its first stage: what a crash or a held file left.
  const swept = new Map<string, Promise<void>>();
  const sweep = (job: GodotJobScope, game: string, project: string | null) => {
    const key = path.resolve(game).toLowerCase();
    const sweeping =
      swept.get(key) ??
      staleStages(game, project).then(async (stages) => {
        for (const stage of stages) await removeStage(stage, removal(job), wait);
      });
    swept.set(key, sweeping);
    return sweeping;
  };
  return async (binary, call, job) => {
    job.signal.throwIfAborted();
    const folders = await windowsFolders(call, job);
    await sweep(job, folders.game, folders.project);
    try {
      await stageFolders(folders, folders.staged, folders.inputs);
      const done = await turn(job.signal);
      try {
        const request = sandboxRequest(binary, withBudget(call, job), folders);
        const { id } = await job.host(PluginService.SandboxRun, request);
        const result = resultOf(await jobEnd(job, id, wait), [...folders.inputs, ...folders.staged]);
        await copyOut(folders.base, folders.staged);
        return result;
      } finally {
        done();
      }
    } finally {
      await removeStage({ base: folders.base, stage: folders.root }, removal(job), wait);
    }
  };
}

/** The call as it starts now: its deadline cut to what its budget leaves, or refused when too little is left. */
function withBudget(call: GodotCall, { budget }: GodotJobScope): GodotCall {
  if (!budget) return call;
  const left = budget.until - budget.now();
  if (left < budget.least) throw new Error(budget.refusal);
  return { ...call, timeoutMs: Math.min(call.timeoutMs, left) };
}

/**
 * Turns at the host's sandbox: at most `size` of the plugin's jobs at once, as many as the host
 * runs for one plugin, the others waiting in order (never refused as busy); a stop ends a wait.
 * Answers the turn's end, which hands it to the next job waiting.
 */
function jobTurns(size: number) {
  let free = size;
  const waiting: Array<() => void> = [];
  const pass = () => {
    const next = waiting.shift();
    if (next) next();
    else free += 1;
  };
  const once = () => {
    let passed = false;
    return () => {
      if (!passed) pass();
      passed = true;
    };
  };
  return async (signal: AbortSignal): Promise<() => void> => {
    signal.throwIfAborted();
    if (free > 0) {
      free -= 1;
      return once();
    }
    await new Promise<void>((resolve, reject) => {
      const go = () => {
        signal.removeEventListener("abort", stop);
        resolve();
      };
      const stop = () => {
        waiting.splice(waiting.indexOf(go), 1);
        reject(signal.reason);
      };
      waiting.push(go);
      signal.addEventListener("abort", stop, { once: true });
    });
    return once();
  };
}
