/**
 * What every lane shares (§5.2): the instruction suffix, the raw lanes' deliverable text, the one
 * answer policy, the rail's constants, the run workspace and its ancestor guard, the child
 * environment, and the process supervisor that timestamps each stdout line on receipt (Rule 12)
 * and holds the rail: deadline + grace, then SIGTERM to the process group, then SIGKILL.
 */
import { type SpawnOptions, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, rmdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as sleep } from "node:timers/promises";
import { MINUTE_MS, SECOND_MS } from "../../../src/shared/duration.ts";
import type { CodingProvider } from "../../../src/shared/coding-cli.ts";
import { EVAL_LANE_ANSWER_TEXT, type EvalCliHomes } from "../../../src/shared/eval-lane.ts";
import { EngineId } from "../../../src/shared/providers.ts";
import { childEnv } from "../../../src/substrate/child-env.ts";
import {
  ACCOUNT_HOME_ENV_NAMES,
  AGENT_SESSION_ENV_PREFIXES,
  NODE_MODE_ENV_NAMES,
  SESSION_ROUTING_ENV_NAMES,
} from "../../studio-dev/live-env.ts";
import { AnswerPolicy, BrowserPin } from "../vocabulary.ts";

/** Grace after a case's deadline before the rail stops the lane (§5.2). */
export const RAIL_GRACE_MS = 5 * MINUTE_MS;
/** How long a SIGTERMed process group has before SIGKILL. */
export const RAIL_KILL_AFTER_MS = 10 * SECOND_MS;
/** How often a stopping process group is asked whether it is gone. */
const REAP_POLL_MS = 250;
/** A process ended by a signal exits 128 + the signal's number, as a shell reports it. */
const SIGNAL_EXIT_BASE = 128;
/** How many typed questions a Genex lane answers with the policy's sentence. */
export const MAX_ANSWERS = 3;
/** The one answer policy every lane applies. */
export const ANSWER_POLICY: AnswerPolicy = AnswerPolicy.NoAnswers;

/** The sentence an answer policy gives the agent, up front (raw lanes) or as the answer (Genex): the app's own. */
export function answerText(policy: AnswerPolicy): string {
  return EVAL_LANE_ANSWER_TEXT[policy];
}

/** The shared instruction suffix every lane appends to the brief, identical across lanes (Rule 5). */
export function instructionSuffix(deadlineMin: number, policy: AnswerPolicy = ANSWER_POLICY): string {
  if (!Number.isInteger(deadlineMin) || deadlineMin <= 0)
    throw new RangeError("deadlineMin must be a positive integer");
  return [
    `You have about ${deadlineMin} minutes.`,
    "Get a playable version working early, then keep improving it until the brief is fully met or time runs out.",
    answerText(policy),
  ].join(" ");
}

/** The deliverable shape raw lanes are told: the one stated asymmetry (Rule 5). */
export const RAW_DELIVERABLE =
  "Build it as a static web game. Serving this folder's `index.html` (or `dist/` after `npm run build`) from a plain static server must run it. Three.js is allowed.";

/** The line naming the pinned browser command (D10), appended when a raw lane's browser pin is `look-at-page`. */
export const LOOK_AT_PAGE_LINE =
  "To look at the running game, use the shell command `look-at-page <url> [--out shot.png]`: it opens a loopback URL (http://localhost or http://127.0.0.1) in headless Chromium, prints the page's console errors and saves a screenshot.";

/** The deliverable text a raw lane gets for its browser pin. */
export function rawDeliverable(browser: BrowserPin): string {
  return browser === BrowserPin.LookAtPage ? `${RAW_DELIVERABLE}\n\n${LOOK_AT_PAGE_LINE}` : RAW_DELIVERABLE;
}

/** A raw lane's whole prompt: the brief verbatim, the shared suffix, then the deliverable. */
export function rawPrompt(brief: string, suffix: string, deliverable: string): string {
  return [brief.trim(), suffix, deliverable].join("\n\n");
}

/** sha256[:12] of the parts, separated so that moving text between parts changes the digest. */
export function textDigest(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 12);
}

// ── the run workspace ─────────────────────────────────────────────────────────────────────

/** Why a run workspace was refused (§5.2): each would load someone's instructions or state into the lane. */
export const WorkspaceRefusal = {
  NotAbsolute: "not-absolute",
  InsideGitRepo: "inside-git-repo",
  AgentInstructions: "agent-instructions",
  NotEmpty: "not-empty",
  NotDirectory: "not-directory",
  /** The lanes folder is inside the evals home (or holds it): a lane could list the holdouts, the key or other runs. */
  InsideEvalsHome: "inside-evals-home",
} as const;
export type WorkspaceRefusal = (typeof WorkspaceRefusal)[keyof typeof WorkspaceRefusal];

/** Files an ancestor must not hold: a CLI would load them as instructions. */
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"] as const;
/** A project settings folder; `$HOME/.claude` itself is the operator's config home, so only folders below `$HOME` count. */
const PROJECT_SETTINGS_DIR = ".claude";
/** The run's project folder inside its work root: the agent's cwd, empty at start. */
export const PROJECT_DIR = "project";

/** A refused workspace, naming the rule and the path that broke it. */
export class WorkspaceRefusedError extends Error {
  readonly refusal: WorkspaceRefusal;
  readonly at: string;
  constructor(refusal: WorkspaceRefusal, at: string) {
    super(`run workspace refused (${refusal}): ${at}`);
    this.name = "WorkspaceRefusedError";
    this.refusal = refusal;
    this.at = at;
  }
}

/** A workspace ancestor check: clean, or the first refusal found. */
export type WorkspaceCheck = { ok: true } | { ok: false; refusal: WorkspaceRefusal; at: string };

/**
 * The folder under the system temp folder that holds every running lane's root, outside the evals
 * home: nothing the agent's `ls ..` reaches lists the holdouts, the key, the ledger or another run.
 */
export const LANES_DIR = "genex-evals-lanes";
/** The lanes folder's mode: its owner creates and enters lane roots by name but cannot list them. */
const LANES_DIR_MODE = 0o300;
/** The error a rename across volumes fails with. */
const CROSS_DEVICE = "EXDEV";
/** The prefix of each lane root's random name, so a concurrent run's root cannot be guessed (and `gc` knows a leftover one). */
export const LANE_ROOT_PREFIX = "run-";

/** The machine's lanes folder: `LANES_DIR` under the system temp folder. */
export function defaultLanesRoot(): string {
  return path.join(os.tmpdir(), LANES_DIR);
}

/** Whether `inner` is `outer` or below it. */
const within = (outer: string, inner: string): boolean => inner === outer || inner.startsWith(outer + path.sep);

/**
 * A fresh lane root for one run, on its real path: a randomly named folder in `lanesDir`, which is
 * made unlistable. The agent works inside it; the scheduler moves what it made into the run's work
 * root when the run ends. A lanes folder inside the evals home, or one holding it, is refused
 * before anything is created.
 */
export async function createLaneRoot(lanesDir: string, evalsRoot: string): Promise<string> {
  const lanes = await realOrLexical(path.resolve(lanesDir));
  const evals = await realOrLexical(path.resolve(evalsRoot));
  if (within(evals, lanes) || within(lanes, evals))
    throw new WorkspaceRefusedError(WorkspaceRefusal.InsideEvalsHome, lanesDir);
  await mkdir(lanes, { recursive: true, mode: LANES_DIR_MODE });
  await chmod(lanes, LANES_DIR_MODE);
  return realpath(await mkdtemp(path.join(lanes, LANE_ROOT_PREFIX)));
}

/** A fresh run workspace: the work root and the empty project folder inside the lane root. */
export interface RunWorkspace {
  workRoot: string;
  projectDir: string;
}

const exists = async (file: string): Promise<boolean> =>
  lstat(file).then(
    () => true,
    () => false,
  );

/** `dir` resolved through the links of its nearest existing ancestor; the missing tail stays lexical. */
async function realOrLexical(dir: string): Promise<string> {
  const missing: string[] = [];
  let at = dir;
  while (!(await exists(at))) {
    const parent = path.dirname(at);
    if (parent === at) return dir;
    missing.unshift(path.basename(at));
    at = parent;
  }
  return path.join(await realpath(at), ...missing);
}

/** Every strict ancestor of `dir`, nearest first, up to the filesystem root. */
function ancestors(dir: string): string[] {
  const out: string[] = [];
  for (let at = path.dirname(dir); ; at = path.dirname(at)) {
    out.push(at);
    if (path.dirname(at) === at) return out;
  }
}

/** The first marker in `dir` that would put someone's repository or instructions into the lane. */
async function ancestorRefusal(dir: string, homes: readonly string[]): Promise<WorkspaceCheck> {
  if (await exists(path.join(dir, ".git"))) return { ok: false, refusal: WorkspaceRefusal.InsideGitRepo, at: dir };
  const belowHome = homes.some((home) => dir.startsWith(home + path.sep));
  const markers = belowHome ? [...INSTRUCTION_FILES, PROJECT_SETTINGS_DIR] : INSTRUCTION_FILES;
  for (const marker of markers) {
    const file = path.join(dir, marker);
    if (await exists(file)) return { ok: false, refusal: WorkspaceRefusal.AgentInstructions, at: file };
  }
  return { ok: true };
}

/**
 * Whether `dir` may hold a lane: absolute and normalized, outside any Git repository, and with no
 * `AGENTS.md`, `CLAUDE.md` or `CLAUDE.local.md` in any ancestor (nor a `.claude` folder below
 * `$HOME`). Both the lexical and the link-resolved ancestors are checked. Reads only.
 */
export async function checkWorkspaceAncestors(dir: string, home: string = os.homedir()): Promise<WorkspaceCheck> {
  const dotted = dir.split(/[\\/]/).some((segment) => segment === "." || segment === "..");
  if (!path.isAbsolute(dir) || dotted) return { ok: false, refusal: WorkspaceRefusal.NotAbsolute, at: dir };
  const homes = [path.resolve(home), await realOrLexical(path.resolve(home))];
  const chains = [...new Set([...ancestors(dir), ...ancestors(await realOrLexical(dir))])];
  for (const ancestor of chains) {
    const found = await ancestorRefusal(ancestor, homes);
    if (!found.ok) return found;
  }
  return { ok: true };
}

/** An existing work root must be an empty directory; a missing one is fine. */
async function emptyOrMissing(dir: string): Promise<WorkspaceCheck> {
  const info = await stat(dir).catch(() => null);
  if (!info) return { ok: true };
  if (!info.isDirectory()) return { ok: false, refusal: WorkspaceRefusal.NotDirectory, at: dir };
  if ((await readdir(dir)).length) return { ok: false, refusal: WorkspaceRefusal.NotEmpty, at: dir };
  return { ok: true };
}

/**
 * Create a run's workspace after the ancestor guard and the empty check pass: the work root (the
 * run's bookkeeping) and the project folder in the lane root, the agent's own (the work root itself
 * when none is given). A refused workspace throws `WorkspaceRefusedError` before anything is created.
 */
export async function createRunWorkspace(
  workRoot: string,
  home: string = os.homedir(),
  laneRoot: string = workRoot,
): Promise<RunWorkspace> {
  const projectDir = path.join(laneRoot, PROJECT_DIR);
  const checks = [
    await checkWorkspaceAncestors(workRoot, home),
    await emptyOrMissing(workRoot),
    await checkWorkspaceAncestors(projectDir, home),
    await emptyOrMissing(projectDir),
  ];
  for (const check of checks) if (!check.ok) throw new WorkspaceRefusedError(check.refusal, check.at);
  await mkdir(workRoot, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  return { workRoot, projectDir };
}

/** Move one entry, copying then removing it when the two folders are on different volumes. */
async function moveEntry(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== CROSS_DEVICE) throw error;
    await cp(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    await rm(from, { recursive: true, force: true });
  }
}

/**
 * When a run ends, move everything its agent made in the lane root into the run's work root, and
 * remove the lane root, so no finished game is left where a later lane could reach it. Nothing to do
 * when the lane ran in its work root.
 */
export async function settleLaneRoot(laneRoot: string, workRoot: string): Promise<void> {
  if (laneRoot === workRoot) return;
  await mkdir(workRoot, { recursive: true });
  for (const name of await readdir(laneRoot)) await moveEntry(path.join(laneRoot, name), path.join(workRoot, name));
  await rmdir(laneRoot);
}

/** A path as it reads once the lane root has moved into the work root; one outside the lane root is unchanged. */
export function settledPath(file: string, laneRoot: string, workRoot: string): string {
  return within(laneRoot, file) ? path.join(workRoot, path.relative(laneRoot, file)) : file;
}

/** Whether a folder holds at least one file anywhere below it (the `zero-files` guard). */
export async function holdsAnyFile(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isFile() || entry.isSymbolicLink()) return true;
    if (entry.isDirectory() && (await holdsAnyFile(path.join(dir, entry.name)))) return true;
  }
  return false;
}

// ── the child environment ─────────────────────────────────────────────────────────────────

/**
 * Variables no lane child inherits: metered keys, other logins and the operator's own homes. The
 * session's own variables are the ones a live studio:dev launch drops too (`studio-dev/live-env.ts`);
 * the order is part of `laneFlagsDigest`.
 */
export const STRIPPED_ENV_NAMES: readonly string[] = [
  ...SESSION_ROUTING_ENV_NAMES,
  ...ACCOUNT_HOME_ENV_NAMES,
  ...NODE_MODE_ENV_NAMES,
];
/** Prefixes no lane child inherits: Claude Code's and the Agent SDK's switches, and every Genex variable. */
export const STRIPPED_ENV_PREFIXES: readonly string[] = [...AGENT_SESSION_ENV_PREFIXES, "GENEX_"];

/** The parent's environment without any stripped variable. */
export function strippedEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) {
    const stripped = STRIPPED_ENV_NAMES.includes(name) || STRIPPED_ENV_PREFIXES.some((p) => name.startsWith(p));
    if (!stripped && value !== undefined) env[name] = value;
  }
  return env;
}

/** The home variables that point both CLIs at the eval-owned homes, with the auto-updater off (Rule 24). */
export function evalHomesEnv(homes: EvalCliHomes): Record<string, string> {
  return { CLAUDE_CONFIG_DIR: homes.claude, CODEX_HOME: homes.codex, DISABLE_AUTOUPDATER: "1" };
}

/** The vendor the app's contractor filter (`childEnv`) knows each coding CLI by. */
const CONTRACTOR_VENDOR = {
  [EngineId.ClaudeCode]: "claude",
  [EngineId.Codex]: "codex",
  [EngineId.OpenCode]: "opencode",
} as const satisfies Record<CodingProvider, string>;

/** The marker `laneFlagsDigest` folds in for the raw lanes' credential policy, so a change to it moves the pin. */
export const RAW_LANE_CREDENTIAL_POLICY = "credentials:contractor";

/**
 * A raw lane child's environment: the app's contractor filter for the lane's CLI (SEC-2: every
 * credential, the other vendor's variables and the CLI's own sign-in variables dropped; the studio's
 * commit identity set, as the app's own agents get it) over the parent minus every stripped
 * variable, then the eval homes, the auto-updater off, and `pathPrefix` (the `look-at-page` shim
 * folder) at the front of PATH.
 */
export function laneChildEnv(
  parent: NodeJS.ProcessEnv,
  homes: EvalCliHomes,
  engine: CodingProvider,
  pathPrefix: readonly string[] = [],
): NodeJS.ProcessEnv {
  const contractor = childEnv(strippedEnv(parent), { base: "contractor", vendor: CONTRACTOR_VENDOR[engine] });
  const env: NodeJS.ProcessEnv = { ...contractor, ...evalHomesEnv(homes) };
  if (pathPrefix.length) env.PATH = [...pathPrefix, env.PATH].filter(Boolean).join(path.delimiter);
  return env;
}

// ── the supervisor ────────────────────────────────────────────────────────────────────────

/** The part of a child process the supervisor uses; a test passes a fake that replays a fixture. */
export interface ChildLike {
  pid?: number;
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** How the supervisor starts a child. */
export type SpawnLike = (file: string, args: readonly string[], options: SpawnOptions) => ChildLike;

/** The rail's clock: the time now, and a cancellable timer. */
export interface RailClock {
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
}

/** Signals to a process group, and whether any of it still runs. */
export interface GroupControl {
  kill(pid: number, signal: NodeJS.Signals): void;
  alive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
}

/** What the supervisor needs from the machine; every part is injectable. */
export interface SupervisorDeps {
  spawn: SpawnLike;
  clock: RailClock;
  group: GroupControl;
}

/** One process to supervise, and where its output goes. */
export interface SupervisedRun {
  file: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to stdin and closed; null leaves stdin ignored. */
  stdin: string | null;
  /** Where each stdout line lands as `{receivedAt, line}` JSONL on receipt; null keeps only the raw stdout. */
  streamPath: string | null;
  stdoutPath: string;
  stderrPath: string;
  /** When the rail fires, from spawn. */
  railMs: number;
  /** Where the group leader's pid is kept while it runs (`LANE_PID_FILE` beside the run); removed once reaped. */
  pidPath?: string;
}

/** How a supervised process ended. */
export interface SupervisedOutcome {
  startedAtMs: number;
  endedAtMs: number;
  exitCode: number | null;
  signal: string | null;
  /** The rail fired: the process outlived deadline + grace. */
  railFired: boolean;
  /** The group needed SIGKILL, on the rail or at reaping. */
  sigkilled: boolean;
  lines: number;
  /** The spawn failed (a missing executable); the local log only. */
  spawnError: string | null;
}

/** One received stdout line as the stream file stores it. */
export interface StreamRecord {
  /** Epoch milliseconds on the receive clock. */
  receivedAt: number;
  line: string;
}

/** The machine's own process groups: a signal to the whole group, and whether any of it runs. */
export const SYSTEM_GROUP: GroupControl = {
  kill: (pid, signal) => {
    try {
      process.kill(-pid, signal);
    } catch {
      /* the group is already gone */
    }
  },
  alive: (pid) => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  sleep: (ms) => sleep(ms),
};

/** The machine's own clock, process groups and spawn. */
export const SYSTEM_SUPERVISOR: SupervisorDeps = {
  spawn: (file, args, options) => spawn(file, [...args], options),
  clock: {
    now: () => Date.now(),
    setTimer: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    },
  },
  group: SYSTEM_GROUP,
};

// ── live groups and interrupts ────────────────────────────────────────────────────────────

/** The file beside a run that names its lane's process-group leader while the lane runs. */
export const LANE_PID_FILE = ".lane.pid";

/** The pid file's text: the group leader and when it started. */
export function lanePidText(pid: number, startedAtMs: number): string {
  return `${JSON.stringify({ pid, startedAtMs })}\n`;
}

/** The group leader a pid file names, or null when it names none. */
export function readLanePid(text: string): number | null {
  try {
    const value = JSON.parse(text) as { pid?: unknown };
    return Number.isInteger(value.pid) && Number(value.pid) > 0 ? Number(value.pid) : null;
  } catch {
    return null;
  }
}

/** Every supervised process group still running, by leader pid: what an interrupt must stop. */
const LIVE_GROUPS = new Set<number>();

/** The leader pids of every supervised process group still running. */
export function liveGroups(): number[] {
  return [...LIVE_GROUPS];
}

/** The signals that stop a campaign from the terminal or the system; each reaps the live lanes first. */
export const INTERRUPT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const satisfies readonly NodeJS.Signals[];

/** Where the interrupt reaper hooks in and how it stops the process; injectable. */
export interface InterruptDeps {
  onSignal(signal: NodeJS.Signals, handler: () => void): void;
  onExit(handler: () => void): void;
  group: GroupControl;
  exit(code: number): void;
}

/** This process's own signals, process groups and exit. */
export const SYSTEM_INTERRUPTS: InterruptDeps = {
  onSignal: (signal, handler) => {
    process.on(signal, handler);
  },
  onExit: (handler) => {
    process.on("exit", handler);
  },
  group: SYSTEM_GROUP,
  exit: (code) => process.exit(code),
};

/** Stop every live lane group (SIGTERM, then SIGKILL after the rail's wait), then exit as the signal would. */
async function reapAllAndExit(signal: NodeJS.Signals, deps: InterruptDeps): Promise<void> {
  await Promise.all(liveGroups().map((pid) => reapGroup(pid, deps.group)));
  deps.exit(SIGNAL_EXIT_BASE + os.constants.signals[signal]);
}

/** Interrupt deps already hooked in, so a second install adds no second set of handlers. */
const INSTALLED = new WeakSet<InterruptDeps>();

/**
 * Hook the campaign's process so no lane outlives it: Ctrl-C, SIGTERM or SIGHUP stops every live
 * lane group before the process exits, and an exit with a group still live SIGKILLs it. A lane runs
 * detached in its own process group, so the terminal's Ctrl-C never reaches it on its own.
 */
export function installInterruptReaper(deps: InterruptDeps = SYSTEM_INTERRUPTS): void {
  if (INSTALLED.has(deps)) return;
  INSTALLED.add(deps);
  for (const signal of INTERRUPT_SIGNALS) deps.onSignal(signal, () => void reapAllAndExit(signal, deps));
  deps.onExit(() => {
    for (const pid of liveGroups()) deps.group.kill(pid, "SIGKILL");
  });
}

/** A line splitter that writes each complete stdout line as a stream record, stamped on receipt. */
function lineSink(streamFd: number | null, clock: RailClock): { push(text: string): void; end(): number } {
  let pending = "";
  let lines = 0;
  const write = (line: string): void => {
    lines++;
    if (streamFd === null) return;
    const record: StreamRecord = { receivedAt: clock.now(), line: line.replace(/\r$/, "") };
    fs.writeSync(streamFd, `${JSON.stringify(record)}\n`);
  };
  return {
    push(text) {
      const parts = (pending + text).split("\n");
      pending = parts.pop() ?? "";
      for (const part of parts) write(part);
    },
    end() {
      if (pending) write(pending);
      pending = "";
      return lines;
    },
  };
}

/** SIGTERM whatever of the group is left, then SIGKILL after the rail's wait; true when SIGKILL was needed. */
export async function reapGroup(pid: number, group: GroupControl): Promise<boolean> {
  if (!group.alive(pid)) return false;
  group.kill(pid, "SIGTERM");
  for (let waited = 0; waited < RAIL_KILL_AFTER_MS; waited += REAP_POLL_MS) {
    if (!group.alive(pid)) return false;
    await group.sleep(REAP_POLL_MS);
  }
  if (!group.alive(pid)) return false;
  group.kill(pid, "SIGKILL");
  return true;
}

/** Open the run's output files for appending (created when missing). */
function openOutputs(run: SupervisedRun): { stream: number | null; stdout: number; stderr: number } {
  return {
    stream: run.streamPath ? fs.openSync(run.streamPath, "a") : null,
    stdout: fs.openSync(run.stdoutPath, "a"),
    stderr: fs.openSync(run.stderrPath, "a"),
  };
}

/** The rail for one process group: SIGTERM at `railMs`, SIGKILL `RAIL_KILL_AFTER_MS` later if any of it is left. */
function armRail(
  pid: number | undefined,
  run: SupervisedRun,
  deps: SupervisorDeps,
): {
  state: { fired: boolean; sigkilled: boolean };
  cancel: () => void;
} {
  const state = { fired: false, sigkilled: false };
  let cancelKill = (): void => {};
  const cancelTerm = deps.clock.setTimer(() => {
    if (pid === undefined) return;
    state.fired = true;
    deps.group.kill(pid, "SIGTERM");
    cancelKill = deps.clock.setTimer(() => {
      if (!deps.group.alive(pid)) return;
      state.sigkilled = true;
      deps.group.kill(pid, "SIGKILL");
    }, RAIL_KILL_AFTER_MS);
  }, run.railMs);
  return {
    state,
    cancel: () => {
      cancelTerm();
      cancelKill();
    },
  };
}

/** Register a started group as live, and name its leader beside the run. */
function enterLive(pid: number, run: SupervisedRun, startedAtMs: number): void {
  LIVE_GROUPS.add(pid);
  if (run.pidPath) fs.writeFileSync(run.pidPath, lanePidText(pid, startedAtMs));
}

/** Forget a reaped group, and its pid file. */
function leaveLive(pid: number, run: SupervisedRun): void {
  LIVE_GROUPS.delete(pid);
  if (run.pidPath) fs.rmSync(run.pidPath, { force: true });
}

/**
 * Run one process in its own process group under the rail: each stdout line is written as a
 * `{receivedAt, line}` record the moment it arrives, stdout and stderr are kept raw, and when the
 * leader exits whatever it left behind in its group is reaped (SIGTERM, then SIGKILL).
 */
export async function superviseProcess(
  run: SupervisedRun,
  deps: SupervisorDeps = SYSTEM_SUPERVISOR,
): Promise<SupervisedOutcome> {
  const fds = openOutputs(run);
  const startedAtMs = deps.clock.now();
  const sink = lineSink(fds.stream, deps.clock);
  const decoder = new StringDecoder("utf8");
  try {
    const child = deps.spawn(run.file, run.args, {
      cwd: run.cwd,
      env: run.env,
      detached: true,
      stdio: [run.stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const rail = armRail(child.pid, run, deps);
    if (child.pid !== undefined) enterLive(child.pid, run, startedAtMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      fs.writeSync(fds.stdout, chunk);
      sink.push(decoder.write(chunk));
    });
    child.stderr?.on("data", (chunk: Buffer) => fs.writeSync(fds.stderr, chunk));
    // A child that exits before reading its prompt closes the pipe; that is its exit to report, not a crash here.
    child.stdin?.on("error", () => {});
    if (run.stdin !== null) child.stdin?.end(run.stdin);
    const ended = await new Promise<{ code: number | null; signal: string | null; error: string | null }>((resolve) => {
      child.on("error", (error) => resolve({ code: null, signal: null, error: error.message }));
      child.on("close", (code, signal) => resolve({ code, signal, error: null }));
    });
    rail.cancel();
    sink.push(decoder.end());
    const reapKilled = child.pid === undefined ? false : await reapGroup(child.pid, deps.group);
    if (child.pid !== undefined) leaveLive(child.pid, run);
    return {
      startedAtMs,
      endedAtMs: deps.clock.now(),
      exitCode: ended.code,
      signal: ended.signal,
      railFired: rail.state.fired,
      sigkilled: rail.state.sigkilled || reapKilled,
      lines: sink.end(),
      spawnError: ended.error,
    };
  } finally {
    for (const fd of [fds.stream, fds.stdout, fds.stderr]) if (fd !== null) fs.closeSync(fd);
  }
}

/** The stream file's records, in order; a line that is not a record is skipped. */
export function readStreamRecords(text: string): StreamRecord[] {
  const out: StreamRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Partial<StreamRecord>;
      if (typeof value.receivedAt === "number" && typeof value.line === "string")
        out.push({ receivedAt: value.receivedAt, line: value.line });
    } catch {
      /* not a record */
    }
  }
  return out;
}
