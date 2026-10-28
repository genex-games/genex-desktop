/**
 * Native evidence: how the harness looks at a compiled game's (C++ · raylib or Rust · wgpu)
 * desktop build, with no page and no JavaScript. Two things live here.
 *
 *  - The native evidence pass (`nativeEvidence`): what `gatherEvidence` runs on a lease whose
 *    judging target is a desktop build (a Mac-only game on a Mac). It answers the same `Evidence`
 *    the web pass does — frames from the same named cameras, `state()`, demos, the console — from
 *    the native protocol's typed calls, and names what a native run cannot measure (GPU errors,
 *    page UI, the user's view, frame similarity) `unmeasured`, never a pass.
 *  - The parity gate (`runParityGate`, plan §8.4): a game whose destinations include a desktop
 *    build this host runs passes, in order, the host's admission facts, ready, the step witness,
 *    captures, the frame verdicts on those captures, a seeded replay across two native runs and a
 *    fixed-horizon `state()` agreement with the web build. Frame similarity is `unmeasured` until
 *    PX10 sets its threshold. The host's admission fact beats whatever the game says it renders
 *    with. A Windows or Linux destination this host builds but does not run (a Mac's) is built
 *    through the lane and admitted by the host's gate, and every row after admission is
 *    `unmeasured` ("built, not run on this Mac"), never a pass. The verdict rides on the look
 *    (`withParity`) and becomes one board row (checks.ts).
 *
 * Both read the run's memory from `native.status`: a run past the 4 GiB budget is fine on a
 * desktop and warned, with its peak, only when the game also ships to the web or a phone; a run
 * the host killed past its cap (`memory-cap`) fails naming the footprint and the cap.
 *
 * A new module on purpose: a seed upgrade keeps any older module the agent edited, so it imports
 * the frame verdicts from their own module and only names its neighbours have always exported.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_CAMERA } from "./cameras.ts";
import { WINDOW_RETRIES_MS } from "./config.ts";
import { type FrameLook, weighBlackness, weighDraws, weighDuplicates } from "./frame-verdicts.ts";
import { HostMethod } from "./host-methods.ts";
import { isRecord } from "./json.ts";
import { playScriptFor, wantsEyeCameras } from "./kinds.ts";
import {
  BuildTarget,
  type Destinations,
  GameStack,
  type LeaseCapacity,
  type LeasedJudging,
  type NativeAdmissionFacts,
  NativeProbe,
  NativeRefusal,
  isNativeAudioMeasured,
  RAYLIB_NATIVE_UNMEASURED,
  RAYLIB_WEB_UNMEASURED,
  RUST_WEB_UNMEASURED,
  runRefusal,
  servedStacks,
  TargetRefusal,
  leasedJudging,
} from "./native-contract.ts";
import { type CompiledStack, stampedStack } from "./native-loop.ts";
import { templateMainOf } from "./native-review.ts";
import { PageMethod } from "./page-contract.ts";
import { applyPlayScript } from "./play-script.ts";
import { touchesSkipped } from "./native-refusal.ts";
import { slug } from "./spec.ts";
import { sleep } from "./time.ts";
import type { AnyRecord, HarnessCtx, Run } from "../types/harness.d.ts";
import type { BuildProblem, BuildProblemCode, NativeRunMemory, StudioPlatform } from "../types/host-api.d.ts";
import type { applySetup, consoleProblems, Evidence, GatherOptions, Shot } from "./evidence.ts";

/**
 * This module judges a Rust · wgpu game by its own stack: what its web build cannot measure, its
 * logical (tagged) draw count apart from the GPU encoder's, its phones built and admitted only, and
 * a tolerance per stack and target pair. A copy kept from before Rust games judged one as raylib or
 * not at all, and run-dispatch.ts refuses a Rust night on it (`RUST_PARTS`).
 */
export const SERVES_RUST = true;

/**
 * What the native pass borrows from the web pass's module (evidence.ts hands them in, so neither
 * module imports the other): the requested-state replay and the console's inherited-error rule.
 */
export interface WebPassParts {
  applySetup: typeof applySetup;
  consoleProblems: typeof consoleProblems;
}

// ── the gate's vocabulary ──────────────────────────────────────────────────────────────────

/** The parity gate's rows, in the order it runs them. Wire values (evidence rows): never rename one. */
export const ParityRow = {
  Admission: "admission",
  Ready: "ready",
  Witness: "witness",
  Captures: "captures",
  FrameVerdicts: "frameVerdicts",
  Replay: "replay",
  CrossTarget: "crossTarget",
  FrameSimilarity: "frameSimilarity",
} as const;
export type ParityRow = (typeof ParityRow)[keyof typeof ParityRow];

/** The destinations any host cross-builds with zig, and runs only on their own OS. */
const CROSS_TARGETS: readonly BuildTarget[] = [BuildTarget.Windows, BuildTarget.Linux];
/**
 * The phone destinations (a Rust · wgpu game's): built through the lane and admitted by the host,
 * never run by the harness. A device run is the person's, started from Studio (containment stage 1).
 */
const PHONE_TARGETS: readonly BuildTarget[] = [BuildTarget.Ios, BuildTarget.Android];

/** The lane's problem codes the gate reads (shared/build-problem.ts). Wire values: never rename one. */
const LaneProblem = {
  ToolchainMissing: "toolchain-missing",
  ToolchainStale: "toolchain-stale",
  ToolchainUnprepared: "toolchain-unprepared",
  ToolchainNotHosted: "not-hosted",
  UnsupportedHost: "unsupported-host",
  Cancelled: "cancelled",
  GateRefused: "gate-refused",
} as const satisfies Record<string, BuildProblemCode>;

/** A problem that says this host cannot build a destination yet, never that the game is broken: `toolchain-missing`. */
const TOOLCHAIN_PROBLEMS: ReadonlySet<string> = new Set([
  LaneProblem.ToolchainMissing,
  LaneProblem.ToolchainStale,
  LaneProblem.ToolchainUnprepared,
  LaneProblem.ToolchainNotHosted,
  LaneProblem.UnsupportedHost,
]);

/** The rows the gate needs passed. Frame similarity is reported, never counted, until PX10 sets its threshold. */
export const REQUIRED_PARITY_ROWS: readonly ParityRow[] = [
  ParityRow.Admission,
  ParityRow.Ready,
  ParityRow.Witness,
  ParityRow.Captures,
  ParityRow.FrameVerdicts,
  ParityRow.Replay,
  ParityRow.CrossTarget,
];

/** One row's outcome: pass, fail, or `null` for a row nobody could measure (never a pass). */
export interface ParityRowResult {
  row: ParityRow;
  pass: boolean | null;
  reason: string;
  /** The typed refusal behind a failed or unmeasured row, when there is one. */
  refusal: string | null;
}

/** One desktop destination's gate. */
export interface TargetParity {
  target: BuildTarget;
  pass: boolean | null;
  reason: string;
  rows: ParityRowResult[];
  /** What the next builder should know and that fails nothing (a run over the memory budget). */
  warnings?: string[];
}

/** Every desktop destination's gate on one look, and what they add up to. */
export interface ParityVerdict {
  pass: boolean | null;
  reason: string;
  /** `no-judging-target` when the judging-only web build failed; else null. */
  refusal: string | null;
  targets: TargetParity[];
}

/** The fixed horizon of the cross-target drive: `seed` plus exactly this many ticks. */
export const CROSS_TARGET_TICKS = 120;
/** One tick of simulated time, as the runtime's `step` counts it (one tick per call). */
const TICK_MS = 16;
/** The injected input of every drive the gate compares, at the tick it lands on. */
const DRIVE_INPUT: ReadonlyArray<{ tick: number; down: string[]; up: string[] }> = [
  { tick: 0, down: ["KeyD"], up: [] },
  { tick: 60, down: [], up: ["KeyD"] },
  { tick: 90, down: ["Space"], up: [] },
  { tick: 91, down: [], up: ["Space"] },
];
/** The C++ web shell's verb for injected input (`__studio.input`): a key held the same tick as the native op. */
const ShellVerb = { Input: "input" } as const;
/** A numeric leaf's tolerance before any run on this game passed, relative to the larger of 1 and its value. */
export const CROSS_TARGET_TOLERANCE = 1e-3;
/** Tolerances are never tightened below this, nor closer than this headroom over what a passing run saw. */
const CROSS_TARGET_TOLERANCE_FLOOR = 1e-5;
const CROSS_TARGET_HEADROOM = 10;
/** What never compares within a target: the real frame rate and anything the game marks volatile. */
const REPLAY_VOLATILE = ["volatile", "fps"] as const;
/**
 * The contract envelope a contract v2 native run adds to `state()` (`contractVersion` 2, `lifecycle`,
 * `safeArea`) and a web build, which stays at protocol 1, never carries: the protocol, never gameplay.
 */
const CONTRACT_ENVELOPE = ["contractVersion", "lifecycle", "safeArea"] as const;
/**
 * Across targets, renderer counters (including their root aliases), float checksums, files,
 * pointer lock and the contract envelope differ.
 */
const CROSS_TARGET_VOLATILE = [
  ...REPLAY_VOLATILE,
  ...CONTRACT_ENVELOPE,
  "__render",
  "drawCalls",
  "triangles",
  "checksum",
  "assets",
  "pointerLock",
] as const;

/** The host as a sentence names it: "built, not run on this Mac". */
const HOST_NAME = {
  darwin: "Mac",
  win32: "Windows PC",
  linux: "Linux PC",
} as const satisfies Record<StudioPlatform, string>;

/** What the gate says, in its own words. */
const MESSAGE = {
  similarity: "frame similarity is unmeasured until PX10 sets its threshold",
  webUnheard: "the web build did not answer its sound level",
  notRunHere: (target: string) => `not built or run on this host: ${target} runs only on its own OS`,
  noGameBox: (target: string) => `this host has no game box for ${target}`,
  macNeedsAMac: "Mac builds need a Mac",
  captureThrew: (camera: string, why: string) => `screenshot(${camera}) failed: ${why}`,
  replayUncaptured: "the replay frame was not captured, so no pixels were compared",
  notRun: "not run: an earlier row stopped the gate",
  noLease: (target: string) => `no ${target} lease was free to run the gate`,
  buildFailed: (target: string, why: string) => `the ${target} build failed: ${why}`,
  builtNotRun: (host: string) => `built, not run on this ${host}`,
  builtWhereIntegrated: (target: string) =>
    `not built in a worker's copy: the ${target} build is made where the run integrates, so each copy does not keep one of its own`,
  phoneNotBuilt: (target: string) =>
    `not built or run by the judge: an ${target} build is made by the export lane and runs only on a device the person starts from Studio, so its gameplay is judged on this computer's build`,
  hostRefusedBuild: (refusal: string, detail: string | null) =>
    `the host refused the build: ${refusal}${detail ? ` (${detail})` : ""}`,
  noToolchain: (target: string, why: string) =>
    `this host cannot make a ${target} build yet, so nothing was judged${why ? `: ${why}` : ""}`,
  cancelled: (target: string) => `the ${target} build was cancelled before it finished`,
  noBuildAnswer: "the host answered no build",
  noFacts: "this host answers no admission facts for the build",
  openGl: (name: string, backend: string | null) =>
    `the host's admission read an OpenGL import (${name})${backend ? `, whatever the game reports (${backend})` : ""}`,
  refused: (refusal: string, detail: string | null) =>
    `the host refused the bundle: ${refusal}${detail ? ` (${detail})` : ""}`,
  notReady: (reason: string) => `the game never said it was ready: ${reason}`,
  stepped: (witness: AnyRecord) =>
    `stepping moved nothing: frames ${witness.frameBefore} → ${witness.frameAfter}, ${witness.simulatedMs} ms simulated, ${witness.drawCalls} draws`,
  noFrame: (asked: readonly string[]) => `no camera produced a frame (asked for: ${asked.join(", ") || "none"})`,
  replayState: (paths: string) => `two runs from the same seed and input disagree: ${paths}`,
  replayDigest: "two runs from the same seed and input drew different pixels",
  crossTarget: (paths: string) => `the web and native builds disagree after ${CROSS_TARGET_TICKS} ticks: ${paths}`,
  judgingFailed: (why: string) => `the judging-only web build failed, so nothing judged this game's frames: ${why}`,
  parity: (target: string, reason: string) => `native parity (${target}): ${reason}`,
  noHost: "this studio names no host platform, so no desktop build runs here",
  webUnjudged: "the web look judged no frames, so there is nothing to agree with",
  webWithoutWebGpu:
    "the web build could not run in this preview: it offers no WebGPU (gpu-unsupported), so cross-target agreement is unavailable, not failed",
  overBudget: (target: string, peak: string, budget: string, small: string) =>
    `the ${target} build used ${peak} GiB at peak: fine on a desktop, but over the ${budget} GiB budget a game should fit in to run ${small}, which this game also ships to; keep what those builds load under ${budget} GiB`,
  memoryCap: (target: string, used: string, cap: string) =>
    `the ${target} build used ${used} GiB and was stopped past this computer's ${cap} GiB memory cap (${NativeRefusal.MemoryCap})`,
} as const;

/** A desktop destination as a sentence names it: "the Mac build". */
const DESKTOP_NAME: Readonly<Partial<Record<BuildTarget, string>>> = {
  [BuildTarget.Mac]: "Mac",
  [BuildTarget.Windows]: "Windows",
  [BuildTarget.Linux]: "Linux",
};
/** The destinations a game must fit the memory budget for, as the warning names them. */
const SMALL_DESTINATION_NAME: Readonly<Partial<Record<BuildTarget, string>>> = {
  [BuildTarget.Web]: "in a browser",
  [BuildTarget.Ios]: "on an iPhone",
  [BuildTarget.Android]: "on an Android phone",
};
const GIB_BYTES = 1024 ** 3;

// ── memory ────────────────────────────────────────────────────────────────────────────────

/** What `native.status` says of a run's memory and whether the host killed it past the cap. */
interface MemoryReading {
  memory: NativeRunMemory | null;
  killedPastCap: boolean;
}

const isBytes = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** A `native.status` answer's `memory`, or null when it has none or not in its shape. */
export function runMemoryOf(status: unknown): NativeRunMemory | null {
  const memory = isRecord(status) ? status.memory : null;
  if (!isRecord(memory)) return null;
  const { peakBytes, budgetBytes, capBytes, overBudget } = memory;
  const counted = isBytes(peakBytes) && isBytes(budgetBytes) && isBytes(capBytes);
  return counted && typeof overBudget === "boolean" ? { peakBytes, budgetBytes, capBytes, overBudget } : null;
}

/** Bytes in GiB as a sentence says them: "5.3", "4". */
const gib = (bytes: number): string => String(Number((bytes / GIB_BYTES).toFixed(1)));
const desktopName = (target: BuildTarget): string => DESKTOP_NAME[target] ?? target;

/** The lease's run memory and whether it ended `memory-cap`; nothing when the host answers no status. */
async function readMemory(ctx: HarnessCtx, project: string, handle: string | null | undefined): Promise<MemoryReading> {
  const params = handle ? { project, handle } : { project };
  const status: unknown = await ctx.call(HostMethod.NativeStatus, params).catch(() => null);
  const killedPastCap = isRecord(status) && status.refusal === NativeRefusal.MemoryCap;
  return { memory: runMemoryOf(status), killedPastCap };
}

/**
 * The warning a run over the memory budget earns: none for a game that ships only to desktops (more
 * than 4 GiB is normal there), or that names no destinations; else one naming the peak, the budget
 * and the web or phone destinations it is too much for.
 */
export function memoryWarnings(
  memory: NativeRunMemory | null,
  target: BuildTarget,
  destinations: Destinations | null | undefined,
): string[] {
  if (!memory?.overBudget) return [];
  const small = (destinations?.targets ?? []).flatMap((entry) => SMALL_DESTINATION_NAME[entry] ?? []);
  if (small.length === 0) return [];
  const where = small.join(" or ");
  return [MESSAGE.overBudget(desktopName(target), gib(memory.peakBytes), gib(memory.budgetBytes), where)];
}

/** The failure a run killed past the cap reads as: the footprint that killed it and the cap. */
function memoryCapReason(target: BuildTarget, memory: NativeRunMemory): string {
  return MESSAGE.memoryCap(desktopName(target), gib(memory.peakBytes), gib(memory.capBytes));
}

/** A gate whose run the host killed past its cap: the row that failed says so with the numbers. */
function nameTheCap(rows: ParityRowResult[], target: BuildTarget, reading: MemoryReading): void {
  if (!reading.killedPastCap || !reading.memory) return;
  const failure = rows.find((entry) => entry.pass === false);
  if (!failure) return;
  failure.reason = memoryCapReason(target, reading.memory);
  failure.refusal = NativeRefusal.MemoryCap;
}

// ── rows and verdicts ──────────────────────────────────────────────────────────────────────

const passed = (row: ParityRow): ParityRowResult => ({ row, pass: true, reason: "", refusal: null });
const failed = (row: ParityRow, reason: string, refusal: string | null = null): ParityRowResult => ({
  row,
  pass: false,
  reason,
  refusal,
});
const unmeasuredRow = (row: ParityRow, reason: string, refusal: string | null = null): ParityRowResult => ({
  row,
  pass: null,
  reason,
  refusal,
});

/** What the rows add up to: any required row failing fails; any unmeasured leaves it unmeasured; else it passes. */
export function weighParity(rows: readonly ParityRowResult[]): { pass: boolean | null; reason: string } {
  const required = rows.filter((entry) => REQUIRED_PARITY_ROWS.includes(entry.row) && !webLacksWebGpu(entry));
  const failing = required.find((entry) => entry.pass === false);
  if (failing) return { pass: false, reason: `${failing.row}: ${failing.reason}` };
  const open = required.find((entry) => entry.pass === null);
  if (open || required.length === 0) return { pass: null, reason: open ? `${open.row}: ${open.reason}` : "" };
  return { pass: true, reason: "" };
}

/** Whether a row was left unmeasured because the preview offers no WebGPU. */
const refusedGpuUnsupported = (entry: ParityRowResult): boolean =>
  entry.pass === null && entry.refusal === NativeRefusal.GpuUnsupported;

/**
 * Whether a row is the cross-target agreement this preview could not measure because its web build
 * found no WebGPU (`gpu-unsupported`, such as a Linux Electron preview): the preview's limit, never
 * the game's, so it is reported and left out of the weighing (plan M3.3).
 */
function webLacksWebGpu(entry: ParityRowResult): boolean {
  return entry.row === ParityRow.CrossTarget && refusedGpuUnsupported(entry);
}

/** A gate whose rows are what they are, weighed. */
function targetParity(target: BuildTarget, rows: ParityRowResult[]): TargetParity {
  return { target, ...weighParity(rows), rows };
}

/** Why a destination does not run here, in the refusal's own words: nothing was built for any of them. */
function refusalReason(target: BuildTarget, refusal: string | null): string {
  if (refusal === TargetRefusal.NoGameBox) return MESSAGE.noGameBox(target);
  if (refusal === TargetRefusal.MacBuildsNeedAMac) return MESSAGE.macNeedsAMac;
  return MESSAGE.notRunHere(target);
}

/**
 * A desktop destination the gate neither built nor ran here: every row unmeasured with `refusal`
 * (`not-runnable-here` unless named), so it never passes and never fails a board.
 */
export function unrunnableParity(
  target: BuildTarget,
  refusal: string | null = TargetRefusal.NotRunnableHere,
  reason: string = refusalReason(target, refusal),
): TargetParity {
  return targetParity(
    target,
    Object.values(ParityRow).map((row) => unmeasuredRow(row, reason, refusal)),
  );
}

/** Every row from `from` on, unmeasured for `reason`: the gate stopped before them. */
function restUnmeasured(rows: ParityRowResult[], reason: string, refusal: string | null = null): ParityRowResult[] {
  const done = new Set(rows.map((entry) => entry.row));
  const rest = Object.values(ParityRow)
    .filter((row) => !done.has(row))
    .map((row) =>
      row === ParityRow.FrameSimilarity ? unmeasuredRow(row, MESSAGE.similarity) : unmeasuredRow(row, reason, refusal),
    );
  return [...rows, ...rest];
}

// ── the cross-target comparator (plan §8.6) ────────────────────────────────────────────────

/** One leaf two states disagree on, by its path. */
export interface Disagreement {
  path: string;
  why: string;
}

/** Whether two states agree, where they do not, and the largest relative difference a numeric leaf showed. */
export interface StateComparison {
  agree: boolean;
  disagreements: Disagreement[];
  maxDelta: number;
}

/** Whether `path` is one the comparison leaves out: a `volatile` segment anywhere, or a listed path or below it. */
function excluded(pathName: string, volatile: readonly string[]): boolean {
  if (pathName.split(".").includes("volatile")) return true;
  return volatile.some((name) => pathName === name || pathName.startsWith(`${name}.`));
}

/** How far past the tolerance a difference may sit and still be the tolerance: binary rounding, not a game's drift. */
const TOLERANCE_ROUNDING = 1e-12;
/** A numeric leaf's relative difference: its gap over the larger of 1 and either value. */
const relativeGap = (a: number, b: number): number => Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));

/** One leaf compared: integers, strings, booleans and enums exactly, other numbers within `tolerance`. */
function compareLeaf(a: unknown, b: unknown, tolerance: number): { why: string | null; delta: number } {
  const numbers = typeof a === "number" && typeof b === "number";
  if (!numbers) return { why: Object.is(a, b) ? null : `${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`, delta: 0 };
  if (Number.isInteger(a) && Number.isInteger(b)) return { why: a === b ? null : `${a} ≠ ${b}`, delta: 0 };
  const delta = relativeGap(a, b);
  const within = delta - tolerance <= TOLERANCE_ROUNDING;
  return { why: within ? null : `${a} vs ${b} (off by ${delta.toExponential(2)})`, delta };
}

/** A value walked as a tree: objects and arrays by key, anything else a leaf. */
const isBranch = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/**
 * Two `state()` answers compared leaf by leaf: a path present on one side only disagrees by its
 * name; `volatile` paths are left out; numbers that are not both integers compare within
 * `tolerance` (relative to the larger of 1 and the value); every other leaf compares exactly.
 */
export function compareStates(
  a: unknown,
  b: unknown,
  { tolerance, volatile }: { tolerance: number; volatile: readonly string[] },
): StateComparison {
  const out: StateComparison = { agree: true, disagreements: [], maxDelta: 0 };
  walkStates(out, a, b, "", { tolerance, volatile });
  out.agree = out.disagreements.length === 0;
  return out;
}

/** Two branches walked key by key, or two leaves compared, into `out`. */
function walkStates(
  out: StateComparison,
  left: unknown,
  right: unknown,
  at: string,
  rule: { tolerance: number; volatile: readonly string[] },
): void {
  if (at && excluded(at, rule.volatile)) return;
  if (isBranch(left) && isBranch(right) && Array.isArray(left) === Array.isArray(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) walkStates(out, left[key], right[key], at ? `${at}.${key}` : key, rule);
    return;
  }
  const missing = missingSide(left, right);
  if (missing) {
    out.disagreements.push({ path: at, why: missing });
    return;
  }
  const leaf = compareLeaf(left, right, rule.tolerance);
  out.maxDelta = Math.max(out.maxDelta, leaf.delta);
  if (leaf.why) out.disagreements.push({ path: at, why: leaf.why });
}

/** Which side a path is missing on, or null when both have it. */
function missingSide(left: unknown, right: unknown): string | null {
  if (left === undefined) return "missing on the first side";
  if (right === undefined) return "missing on the second side";
  return null;
}

/** The tolerance after a passing run that saw `maxDelta`: never looser than `recorded`, never below the floor. */
export function tightenTolerance(recorded: number | null, maxDelta: number): number {
  const seen = Math.max(CROSS_TARGET_TOLERANCE_FLOOR, maxDelta * CROSS_TARGET_HEADROOM);
  return Math.min(recorded ?? CROSS_TARGET_TOLERANCE, seen);
}

/** The two builds a tolerance compares, and the stack they are of: one tolerance per such pair. */
export interface TolerancePair {
  stack: GameStack;
  a: BuildTarget;
  b: BuildTarget;
}

/** Where a game's cross-target tolerances are kept between runs, one per pair (absent: the raylib web and desktop pair). */
export interface ToleranceStore {
  read(project: string, pair?: TolerancePair): Promise<number | null>;
  write(project: string, tolerance: number, pair?: TolerancePair): Promise<void>;
}

/** A pair's key in a game's parity file: `<stack>:<a>:<b>`. */
const pairKey = (pair: TolerancePair): string => `${pair.stack}:${pair.a}:${pair.b}`;
/** A tolerance read from a file: a finite, non-negative number, else nothing. */
const toleranceOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
/** Whether a pair is the one the file's top-level `tolerance` has always held: a raylib game's (or none named). */
const isLegacyPair = (pair: TolerancePair | undefined): boolean => !pair || pair.stack === GameStack.RaylibCpp;

/**
 * The harness workspace's tolerances: `library/games/<game>.parity.json`, one file per game and
 * one tolerance per (stack, target, target) under `tolerances`. A raylib pair also keeps the
 * top-level `tolerance` every file has held since the gate began, so an older reader still reads
 * it and a file written before pairs still serves a raylib game; a Rust pair never reads it.
 */
export function workspaceTolerances(workspace: string): ToleranceStore {
  const file = (project: string) => path.join(workspace, "library", "games", `${slug(project, "game")}.parity.json`);
  const load = async (project: string): Promise<AnyRecord> => {
    const text = await readFile(file(project), "utf8").catch(() => "");
    const parsed: unknown = text ? JSON.parse(text) : null;
    return isRecord(parsed) ? parsed : {};
  };
  return {
    read: async (project, pair) => {
      const saved = await load(project);
      const pairs = isRecord(saved.tolerances) ? saved.tolerances : {};
      const own = pair ? toleranceOf(pairs[pairKey(pair)]) : null;
      return own ?? (isLegacyPair(pair) ? toleranceOf(saved.tolerance) : null);
    },
    write: async (project, tolerance, pair) => {
      const saved = await load(project).catch(() => ({}) as AnyRecord);
      const pairs = isRecord(saved.tolerances) ? saved.tolerances : {};
      const legacy = isLegacyPair(pair) ? tolerance : toleranceOf(saved.tolerance);
      const nextPairs = pair ? { ...pairs, [pairKey(pair)]: tolerance } : pairs;
      const next: AnyRecord = {
        ...(legacy === null ? {} : { tolerance: legacy }),
        ...(Object.keys(nextPairs).length ? { tolerances: nextPairs } : {}),
      };
      await mkdir(path.dirname(file(project)), { recursive: true });
      await writeFile(file(project), `${JSON.stringify(next, null, 2)}\n`);
    },
  };
}

/** Names the disagreements a sentence quotes. */
const DISAGREEMENTS_QUOTED = 4;
const quote = (comparison: StateComparison): string =>
  comparison.disagreements
    .slice(0, DISAGREEMENTS_QUOTED)
    .map((entry) => `${entry.path} (${entry.why})`)
    .join("; ");

// ── the gate ───────────────────────────────────────────────────────────────────────────────

/** What one gate is asked to look at. */
export interface ParityRequest {
  run: Run;
  /** The game's destinations: a run over the memory budget is warned only when they include the web or a phone. */
  destinations?: Destinations;
  /** The desktop destination the gate runs (a build this host runs in its game box). */
  target: BuildTarget;
  /** The web lease the look judged (null: the studio's stand-in), which the cross-target drive steps. */
  webHandle: string | null;
  /** The worktree the look judged, when it was not the game folder. */
  root?: string | null;
  seed: number;
  /** The cameras the web pass photographed: the native run is photographed through the same ones. */
  cameras: readonly string[];
  /** The viewpoints the game declares (default `cameras`): identical frames elsewhere are not a dead camera. */
  viewpoints?: readonly string[];
  /** Where the game's cross-target tolerance is kept (default: the harness workspace). */
  tolerances?: ToleranceStore;
  /** The waits between asks for a native lease (default `WINDOW_RETRIES_MS`). */
  retriesMs?: readonly number[];
}

/** One gate's state, row to row. */
interface GateRun {
  ctx: HarnessCtx;
  request: ParityRequest;
  rows: ParityRowResult[];
  handle: string;
  /** The OpenGL import the host's facts named on an otherwise admitted build, for the admission row's sentence. */
  openGl: string | null;
  shots: Shot[];
}

/** Apple's OpenGL frameworks and libGL, as the host's admission names them: the fact a claim cannot beat. */
const OPENGL_FRAMEWORK = /(^|\/)(opengl|agl|glut)\.framework(\/|$)/i;
const LIBGL = /^libglu?(\.\d+)*\.dylib$/i;
const isOpenGlImport = (name: string): boolean => OPENGL_FRAMEWORK.test(name) || LIBGL.test(path.posix.basename(name));

/** The typed refusal a host error carries, directly or in its RPC `data`. */
function refusalOf(error: unknown): string | null {
  const record = isRecord(error) ? error : {};
  const data = isRecord(record.data) ? record.data : {};
  const refusal = record.refusal ?? data.refusal;
  return typeof refusal === "string" ? refusal : null;
}
const messageOf = (error: unknown): string => String((error as Error | null)?.message ?? error);

/**
 * Starts the run (`preview.load`). An ejected game's build with no passing conformance run is
 * refused `conformance-required`, keyed by the build of the folder it would start: a worktree's
 * build is judged on that worktree (`game.conformance` with its `root`), once, and the start asked
 * again when the suite passed. Any other refusal, or a red suite, is the start's own answer.
 */
async function loadJudged(ctx: HarnessCtx, params: { project: string; root?: string; handle?: string }) {
  try {
    return await ctx.call(HostMethod.PreviewLoad, params);
  } catch (error) {
    if (refusalOf(error) !== NativeRefusal.ConformanceRequired) throw error;
    const where = params.root ? { root: params.root } : {};
    const report = await ctx.call(HostMethod.GameConformance, { project: params.project, ...where });
    if (report?.passed !== true) throw error;
    return await ctx.call(HostMethod.PreviewLoad, params);
  }
}

/**
 * The parity gate for one desktop destination (plan §8.4), in order: the lane's build and the
 * host's admission facts, a native lease, ready, the step witness, the same cameras as the web
 * pass, the frame verdicts on those shots, a seeded replay across two native runs, the
 * fixed-horizon agreement with the web build, and frame similarity (unmeasured until PX10).
 */
export async function runParityGate(ctx: HarnessCtx, request: ParityRequest): Promise<TargetParity> {
  const { target } = request;
  const rows: ParityRowResult[] = [];
  const admitted = await admitBuild(ctx, request, rows);
  if (!admitted.run) return targetParity(target, restUnmeasured(rows, MESSAGE.notRun));
  const handle = await nativeLease(ctx, request);
  if (!handle) return targetParity(target, restUnmeasured(rows, MESSAGE.noLease(target)));
  const gate: GateRun = { ctx, request, rows, handle, openGl: admitted.openGl, shots: [] };
  let reading: MemoryReading = { memory: null, killedPastCap: false };
  try {
    for (const step of GATE_STEPS) if (!(await step(gate))) break;
    reading = await readMemory(ctx, request.run.project, handle);
  } finally {
    await ctx.call(HostMethod.PreviewRelease, { handle }).catch(() => {});
  }
  nameTheCap(rows, target, reading);
  const parity = targetParity(target, restUnmeasured(rows, MESSAGE.notRun));
  const warnings = memoryWarnings(reading.memory, target, request.destinations);
  return warnings.length ? { ...parity, warnings } : parity;
}

/**
 * The lane's build and the host's own facts about it. A refused bundle never runs; an OpenGL
 * import the facts name fails the row whatever the game will say it renders with.
 */
async function admitBuild(
  ctx: HarnessCtx,
  request: ParityRequest,
  rows: ParityRowResult[],
): Promise<{ run: boolean; openGl: string | null }> {
  const { run, root, target } = request;
  const built = await ctx
    .call(HostMethod.NativeBuild, { project: run.project, target, ...(root ? { root } : {}) })
    .catch((error: unknown) => ({ ok: false, problem: { message: messageOf(error) }, admission: null }));
  if (!built?.ok) {
    const why = String(
      (built?.problem as AnyRecord | null)?.message ?? (built?.problem as AnyRecord | null)?.reason ?? "",
    );
    rows.push(failed(ParityRow.Admission, MESSAGE.buildFailed(target, why), NativeRefusal.BuildFailed));
    return { run: false, openGl: null };
  }
  const facts: NativeAdmissionFacts | null = built.admission ?? null;
  if (!facts) {
    rows.push(unmeasuredRow(ParityRow.Admission, MESSAGE.noFacts));
    return { run: true, openGl: null };
  }
  if (facts.refusal) {
    rows.push(failed(ParityRow.Admission, MESSAGE.refused(facts.refusal, facts.detail), facts.refusal));
    return { run: false, openGl: null };
  }
  const openGl = facts.imports.find(isOpenGlImport) ?? null;
  rows.push(
    openGl
      ? failed(ParityRow.Admission, MESSAGE.openGl(openGl, null), NativeRefusal.LinksOpenGl)
      : passed(ParityRow.Admission),
  );
  return { run: true, openGl };
}

/** A native lease for `target`, asked again a few times when every native lease is held; null when none came. */
async function nativeLease(ctx: HarnessCtx, request: ParityRequest): Promise<string | null> {
  const retries = request.retriesMs ?? WINDOW_RETRIES_MS;
  const label = `parity:${request.target}`;
  // The lease declares the stacks this harness serves, as every lease does (`acquireFor`): the host
  // loads a Rust game only through a lease whose harness says it serves Rust games.
  const stacks = [...servedStacks()];
  for (let attempt = 0; ; attempt++) {
    const lease = await ctx
      .call(HostMethod.PreviewAcquire, { label, target: request.target, stacks })
      .catch(() => null);
    if (lease?.handle) return lease.handle;
    if (attempt >= retries.length || ctx.cancelled) return null;
    await sleep(retries[attempt]);
  }
}

/** The gate's rows after admission, in order; each answers whether the gate goes on. */
const GATE_STEPS: ReadonlyArray<(gate: GateRun) => Promise<boolean>> = [
  readyRow,
  witnessRow,
  capturesRow,
  frameVerdictsRow,
  replayAndCrossRows,
  async (gate) => {
    gate.rows.push(unmeasuredRow(ParityRow.FrameSimilarity, MESSAGE.similarity));
    return true;
  },
];

/** The run started from the build and said it was ready; the game's backend claim is named beside the host's fact. */
async function readyRow(gate: GateRun): Promise<boolean> {
  const { ctx, handle, request } = gate;
  const h = { handle };
  try {
    await loadJudged(ctx, {
      project: request.run.project,
      ...(request.root ? { root: request.root } : {}),
      ...h,
    });
    const ready = await ctx.call(HostMethod.PreviewReady, { ...h });
    if (ready?.ready !== true) {
      gate.rows.push(
        failed(
          ParityRow.Ready,
          MESSAGE.notReady(String(ready?.reason ?? ready?.phase ?? "unknown")),
          NativeRefusal.ReadyTimeout,
        ),
      );
      return false;
    }
  } catch (error) {
    gate.rows.push(failed(ParityRow.Ready, MESSAGE.notReady(messageOf(error)), refusalOf(error)));
    return false;
  }
  gate.rows.push(passed(ParityRow.Ready));
  if (gate.openGl) await nameTheClaim(gate);
  return true;
}

/** The admission row's sentence names the game's own claim the host's fact beat. */
async function nameTheClaim(gate: GateRun): Promise<void> {
  const status = await gate.ctx
    .call(HostMethod.NativeStatus, { project: gate.request.run.project, handle: gate.handle })
    .catch(() => null);
  const admission = gate.rows.find((entry) => entry.row === ParityRow.Admission);
  const backend = typeof status?.backend === "string" ? status.backend : null;
  if (admission && gate.openGl) admission.reason = MESSAGE.openGl(gate.openGl, backend);
}

/** One witness step: the game's own frame counter and simulated time moved, and something was drawn. */
async function witnessRow(gate: GateRun): Promise<boolean> {
  const { ctx, handle, request } = gate;
  try {
    await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Seed, arg: request.seed, handle });
    await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Pause, handle });
    const witness = await ctx.call(HostMethod.PreviewWitness, { handle });
    const moved = witness.frameAfter > witness.frameBefore && witness.simulatedMs > 0 && witness.drawCalls > 0;
    gate.rows.push(moved ? passed(ParityRow.Witness) : failed(ParityRow.Witness, MESSAGE.stepped(witness)));
    return moved;
  } catch (error) {
    const refusal = refusalOf(error);
    const unsupported = refusal === NativeRefusal.Unsupported;
    gate.rows.push((unsupported ? unmeasuredRow : failed)(ParityRow.Witness, messageOf(error), refusal));
    return unsupported;
  }
}

/**
 * The web pass's cameras, photographed on the native run. A camera the game does not have is
 * skipped; a capture that throws fails the row by name, and so does a gate with no frame.
 */
async function capturesRow(gate: GateRun): Promise<boolean> {
  const { ctx, handle, request } = gate;
  const threw: string[] = [];
  for (const camera of request.cameras) {
    const label = `parity/${request.target}/${camera}`;
    const shot = await photograph(ctx, request.run, { handle }, camera, label).catch((error: unknown) => {
      threw.push(MESSAGE.captureThrew(camera, messageOf(error)));
      return null;
    });
    if (shot) gate.shots.push(shot);
  }
  const framed = gate.shots.length > 0;
  if (!framed) gate.rows.push(failed(ParityRow.Captures, MESSAGE.noFrame(request.cameras)));
  else if (threw.length > 0) gate.rows.push(failed(ParityRow.Captures, threw.join("; ")));
  else gate.rows.push(passed(ParityRow.Captures));
  return framed;
}

/**
 * The waits before each retry of a capture a native run refused `device-lost`: the run re-creates
 * its device between requests (CONTRACT.md), so the caller retries a bounded number of times.
 */
const DEVICE_LOST_RETRIES_MS: readonly number[] = [250, 500, 1000];

/** One screenshot, retried after each wait in `waits` while the run answers `device-lost`. */
async function screenshotThroughDeviceLoss(
  ctx: HarnessCtx,
  params: Record<string, unknown>,
  waits: readonly number[],
): Promise<AnyRecord | null> {
  for (const wait of [...waits, null]) {
    try {
      return await ctx.call(HostMethod.PreviewScreenshot, params);
    } catch (error) {
      if (refusalOf(error) !== NativeRefusal.DeviceLost || wait === null) throw error;
      await sleep(wait);
    }
  }
  return null;
}

/** Point the run at `camera` and photograph it; null when the game does not have that camera. */
async function photograph(
  ctx: HarnessCtx,
  run: Run,
  h: { handle?: string },
  camera: string,
  label: string,
  waits: readonly number[] = DEVICE_LOST_RETRIES_MS,
): Promise<Shot | null> {
  const placed = await ctx.call(HostMethod.PreviewCall, { method: PageMethod.DebugCamera, arg: camera, ...h });
  if (isRecord(placed) && placed.ok === false && camera !== DEFAULT_CAMERA) return null;
  const params = { runId: run.runId, label, surface: "canvas", ...h };
  const shot = await screenshotThroughDeviceLoss(ctx, params, waits);
  if (!shot?.base64) return null;
  return {
    camera,
    path: shot.path,
    bytes: shot.bytes,
    base64: shot.base64,
    stats: shot.stats ?? null,
    surface: "canvas",
  };
}

/** The web pass's frame verdicts, unchanged, on the native shots. */
async function frameVerdictsRow(gate: GateRun): Promise<boolean> {
  const entry = templateMainOf(stackOfRun(gate.request.run));
  const look = verdictLook(gate.shots, gate.request.viewpoints ?? gate.request.cameras, entry);
  const fine = look.problems.length === 0;
  gate.rows.push(fine ? passed(ParityRow.FrameVerdicts) : failed(ParityRow.FrameVerdicts, look.problems.join("; ")));
  return true;
}

/**
 * The frame verdicts run on `shots`: what they found wrong (`problems`) and worth saying
 * (`warnings`), naming `entry` (the stack's template entry) where the cameras are wired.
 */
function verdictLook(shots: Shot[], viewpoints: readonly string[], entry: string, emptyScene = false): FrameLook {
  const look: FrameLook = {
    shots,
    problems: [],
    warnings: [],
    emptyScene,
    declaredViewpoints: [...viewpoints],
    uiEntries: [],
    uiPrimary: false,
    entry,
  };
  weighBlackness(look, weighDraws(look));
  weighDuplicates(look);
  return look;
}

/** The seeded replay (two native runs) and the fixed-horizon agreement with the web build. */
async function replayAndCrossRows(gate: GateRun): Promise<boolean> {
  const { ctx, handle, request } = gate;
  // Both replay runs start from a reload: the captures before this drew frames, and a renderer's
  // pixels carry earlier frames (TAA jitter and history), so a run that skipped it never matched.
  const first = await freshRun(ctx, handle)
    .then(() => drive(ctx, request, { handle, target: request.target }))
    .catch((error: unknown) => error as Error);
  if (first instanceof Error) {
    gate.rows.push(failed(ParityRow.Replay, messageOf(first), refusalOf(first)));
    return false;
  }
  gate.rows.push(await replayRow(gate, first));
  gate.rows.push(await crossTargetRow(gate, first));
  return true;
}

/** Reload the native run and wait until it is ready again; refused `notReady` when it does not come back. */
async function freshRun(ctx: HarnessCtx, handle: string): Promise<void> {
  await ctx.call(HostMethod.PreviewReload, { handle });
  const ready = await ctx.call(HostMethod.PreviewReady, { handle });
  if (ready?.ready !== true) throw new Error(MESSAGE.notReady(String(ready?.reason ?? "unknown")));
}

/** The second native run from the same seed and input: the same `state()` and the same pixels. */
async function replayRow(gate: GateRun, first: Drive): Promise<ParityRowResult> {
  const { ctx, handle, request } = gate;
  try {
    await freshRun(ctx, handle);
    const second = await drive(ctx, request, { handle, target: request.target });
    const same = compareStates(first.state, second.state, { tolerance: 0, volatile: REPLAY_VOLATILE });
    if (!same.agree) return failed(ParityRow.Replay, MESSAGE.replayState(quote(same)));
    // Two missing pictures are no match: pixels never compared never pass.
    if (first.digest === null || second.digest === null)
      return unmeasuredRow(ParityRow.Replay, MESSAGE.replayUncaptured);
    if (first.digest !== second.digest) return failed(ParityRow.Replay, MESSAGE.replayDigest);
    return passed(ParityRow.Replay);
  } catch (error) {
    return failed(ParityRow.Replay, messageOf(error), refusalOf(error));
  }
}

/** The web build driven the same way: its `state()` agrees with the native run's within the game's tolerance. */
async function crossTargetRow(gate: GateRun, native: Drive): Promise<ParityRowResult> {
  const { ctx, request } = gate;
  const web = request.webHandle ? { handle: request.webHandle } : {};
  const tolerances = request.tolerances ?? workspaceTolerances(ctx.workspace);
  const pair: TolerancePair = { stack: stackOfRun(request.run), a: BuildTarget.Web, b: request.target };
  try {
    const recorded = await tolerances.read(request.run.project, pair).catch(() => null);
    const tolerance = recorded ?? CROSS_TARGET_TOLERANCE;
    const browser = await drive(ctx, request, { ...web, target: BuildTarget.Web });
    const compared = compareStates(browser.state, native.state, { tolerance, volatile: CROSS_TARGET_VOLATILE });
    if (!compared.agree) return failed(ParityRow.CrossTarget, MESSAGE.crossTarget(quote(compared)));
    const tightened = tightenTolerance(recorded, compared.maxDelta);
    if (tightened !== recorded) await tolerances.write(request.run.project, tightened, pair).catch(() => {});
    return passed(ParityRow.CrossTarget);
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal === NativeRefusal.GpuUnsupported)
      return unmeasuredRow(ParityRow.CrossTarget, MESSAGE.webWithoutWebGpu, refusal);
    return failed(ParityRow.CrossTarget, messageOf(error), refusal);
  } finally {
    await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Start, ...web }).catch(() => {});
  }
}

/** Where one drive ended: the game's `state()` and the digest of its default camera's frame. */
interface Drive {
  state: unknown;
  digest: string | null;
}

/**
 * One fixed-horizon drive: `seed`, paused, exactly `CROSS_TARGET_TICKS` one-tick steps with the
 * same injected input landing on the same ticks, then `state()` and the default camera's frame.
 * A native run takes the input as the protocol's `input` op; the web build through its shell's
 * injected-input verb, never a synthesized browser event, so both land on the same tick.
 */
async function drive(
  ctx: HarnessCtx,
  request: ParityRequest,
  lease: { handle?: string; target: BuildTarget },
): Promise<Drive> {
  const h = lease.handle ? { handle: lease.handle } : {};
  const native = lease.target !== BuildTarget.Web;
  // A native run is stepped on the default camera from the start: the captures before the first
  // drive leave it on their last camera, and a frame keeps what it was stepped under (temporal
  // history, cells streamed around the camera), so a replay that switched only for the picture
  // never matched the second run, which starts on the default.
  if (native) await ctx.call(HostMethod.PreviewCall, { method: PageMethod.DebugCamera, arg: DEFAULT_CAMERA, ...h });
  await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Seed, arg: request.seed, ...h });
  await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Pause, ...h });
  for (let tick = 0; tick < CROSS_TARGET_TICKS; tick++) {
    const input = DRIVE_INPUT.find((entry) => entry.tick === tick);
    if (input) await inject(ctx, lease.target, h, input);
    await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Step, arg: TICK_MS, ...h });
  }
  const state = await ctx.call(HostMethod.PreviewState, { ...h });
  if (!native) return { state, digest: null };
  const shot = await ctx.call(HostMethod.PreviewScreenshot, {
    runId: request.run.runId,
    label: `parity/${lease.target}/replay`,
    surface: "canvas",
    ...h,
  });
  return { state, digest: shot?.base64 ? createHash("sha256").update(shot.base64).digest("hex") : null };
}

/** One tick's injected input: the native `input` op, or the web shell's injected-input verb. */
async function inject(
  ctx: HarnessCtx,
  target: BuildTarget,
  h: { handle?: string },
  input: { down: string[]; up: string[] },
): Promise<void> {
  const { down, up } = input;
  if (target === BuildTarget.Web) {
    await ctx.call(HostMethod.PreviewCall, { method: ShellVerb.Input, arg: { down, up }, ...h });
    return;
  }
  const actions = [
    ...(down.length ? [{ type: "down" as const, keys: down }] : []),
    ...(up.length ? [{ type: "up" as const, keys: up }] : []),
  ];
  await ctx.call(HostMethod.PreviewInput, { actions, ...h });
}

// ── which gates a look owes ────────────────────────────────────────────────────────────────

/** What `parityFor` decides from: the game, the host, and the look it rides on. */
export interface ParityLook {
  run: Run;
  destinations: Destinations;
  capacity: LeaseCapacity;
  webHandle: string | null;
  root?: string | null;
  seed: number;
  cameras: readonly string[];
  viewpoints?: readonly string[];
  /** Whether the web look judged real frames: false when the judging-only web build failed. */
  judged: boolean;
  tolerances?: ToleranceStore;
  retriesMs?: readonly number[];
  /**
   * Build the Windows and Linux destinations this host builds but does not run (the default).
   * False on a Loop worker's copy: a cross build is many gigabytes per folder, so it is made once,
   * where the run integrates, and the worker's look leaves those rows unmeasured.
   */
  crossBuilds?: boolean;
}

/**
 * The gates a compiled game's look owes, one per destination besides the browser: the full gate for one this host runs
 * (beside the web build the look judged); for a Windows or Linux one it builds but does not run,
 * the build and the host's admission, the rest unmeasured (`crossGate`); every row unmeasured for
 * one it cannot build here. A game judged on a judging-only web build that failed fails with
 * `no-judging-target`, never passes. A phone is built and admitted only (`crossGate`): its
 * gameplay is judged on this computer's build of the same code (until the host builds phones
 * for the gate, every phone row is unmeasured). Null for a game with no
 * destination besides the browser.
 */
export async function parityFor(ctx: HarnessCtx, look: ParityLook): Promise<ParityVerdict | null> {
  const desktops = look.destinations.targets.filter((target) => target !== BuildTarget.Web);
  if (desktops.length === 0) return null;
  const targets: TargetParity[] = [];
  for (const target of desktops) targets.push(await targetGate(ctx, look, target));
  // A web build this preview could not run says so as its own destination: unavailable (checks.ts).
  if (targets.some((gate) => gate.rows.some(webLacksWebGpu)))
    targets.push(unrunnableParity(BuildTarget.Web, NativeRefusal.GpuUnsupported, MESSAGE.webWithoutWebGpu));
  const judgingOnly = !look.destinations.targets.includes(BuildTarget.Web);
  if (judgingOnly && !look.judged) {
    const reason = MESSAGE.judgingFailed(MESSAGE.webUnjudged);
    return { pass: false, reason, refusal: TargetRefusal.NoJudgingTarget, targets };
  }
  return { ...addUp(targets), refusal: null, targets };
}

/**
 * One desktop destination's gate: run when this host runs it beside a judged web look; built and
 * admitted when it is a Windows or Linux build this host makes but does not run; else every row
 * unmeasured.
 */
async function targetGate(ctx: HarnessCtx, look: ParityLook, target: BuildTarget): Promise<TargetParity> {
  // The judge never builds a phone: its rows stay unmeasured ("not built or run by the judge"),
  // never a pass, although `native.build` takes a phone target on a Mac. Building and admitting it
  // through `crossGate` (the admission row, the rest "built and admitted, not run") is open.
  if (PHONE_TARGETS.includes(target))
    return unrunnableParity(target, TargetRefusal.NotRunnableHere, MESSAGE.phoneNotBuilt(target));
  const host = look.capacity.host ?? null;
  if (!host) return unrunnableParity(target, TargetRefusal.NotRunnableHere, MESSAGE.noHost);
  const refusal = runRefusal(host, target, { gameBox: look.capacity.native?.gameBox === true });
  const builtNotRun = refusal === TargetRefusal.NotRunnableHere && CROSS_TARGETS.includes(target);
  if (builtNotRun && look.crossBuilds === false)
    return unrunnableParity(target, TargetRefusal.NotRunnableHere, MESSAGE.builtWhereIntegrated(target));
  if (builtNotRun) return crossGate(ctx, look, target, MESSAGE.builtNotRun(HOST_NAME[host]));
  if (refusal) return unrunnableParity(target, refusal);
  if (!look.judged) return unrunnableParity(target, null, MESSAGE.webUnjudged);
  return runParityGate(ctx, { ...look, target });
}

/**
 * A Windows or Linux destination this host builds but does not run (§3.9 U6), or a phone (never run
 * by the harness): the lane builds it (`native.build`; the game's own folder records its
 * destination check) and the host's gate admits or refuses it. Admitted, the admission row passes
 * and every other row is unmeasured for `notRun` ("built, not run on this <host>"), so it never
 * passes. Refused, or a build that failed, fails the admission
 * row: the game is broken for a destination it names. A toolchain this host cannot build with yet
 * leaves every row unmeasured (`toolchain-missing`), as does a host call that threw, in its words.
 */
async function crossGate(
  ctx: HarnessCtx,
  look: ParityLook,
  target: BuildTarget,
  notRun: string,
): Promise<TargetParity> {
  const params = { project: look.run.project, target, ...(look.root ? { root: look.root } : {}) };
  const built = await ctx.call(HostMethod.NativeBuild, params).then(
    (answer) => ({ answer }),
    (error: unknown) => ({ error }),
  );
  if ("error" in built) return unrunnableParity(target, refusalOf(built.error), messageOf(built.error));
  const { answer } = built;
  if (!isRecord(answer)) return unrunnableParity(target, null, MESSAGE.noBuildAnswer);
  if (answer.ok !== true) return failedCross(target, answer.problem ?? null);
  const admission = crossAdmissionRow(answer.admission ?? null);
  const rest = admission.pass === false ? MESSAGE.notRun : notRun;
  return targetParity(target, [admission, ...afterAdmission(rest)]);
}

/** Every row after admission, unmeasured for `reason`: this host does not run the destination. */
function afterAdmission(reason: string): ParityRowResult[] {
  return Object.values(ParityRow)
    .filter((row) => row !== ParityRow.Admission)
    .map((row) => unmeasuredRow(row, reason, TargetRefusal.NotRunnableHere));
}

/** The admission row from the host's facts about a build it made: the gate's refusal fails it. */
function crossAdmissionRow(facts: NativeAdmissionFacts | null): ParityRowResult {
  if (!facts) return unmeasuredRow(ParityRow.Admission, MESSAGE.noFacts);
  if (!facts.refusal) return passed(ParityRow.Admission);
  return failed(ParityRow.Admission, MESSAGE.hostRefusedBuild(facts.refusal, facts.detail), facts.refusal);
}

/**
 * A Windows or Linux build that did not finish, by the lane's typed problem: one this host cannot
 * build yet, or a cancelled one, leaves every row unmeasured; the gate's refusal or a failed
 * compile fails the admission row.
 */
function failedCross(target: BuildTarget, problem: BuildProblem | null): TargetParity {
  const why = problemWords(problem);
  const reason = problem?.reason ?? null;
  if (reason && TOOLCHAIN_PROBLEMS.has(reason))
    return unrunnableParity(target, LaneProblem.ToolchainMissing, MESSAGE.noToolchain(target, why));
  if (reason === LaneProblem.Cancelled) return unrunnableParity(target, null, MESSAGE.cancelled(target));
  const gate = reason === LaneProblem.GateRefused ? (problem?.gate ?? null) : null;
  const admission = gate
    ? failed(ParityRow.Admission, MESSAGE.hostRefusedBuild(gate.refusal, why || null), gate.refusal)
    : failed(ParityRow.Admission, MESSAGE.buildFailed(target, why), NativeRefusal.BuildFailed);
  return targetParity(target, [admission, ...afterAdmission(MESSAGE.notRun)]);
}

/** What a build problem says first: its first parsed diagnostic, else its first line of output, else its code. */
function problemWords(problem: BuildProblem | null): string {
  const diagnostic = problem?.diagnostics?.[0];
  if (diagnostic) {
    const at = [diagnostic.file, diagnostic.line, diagnostic.column].filter((part) => part !== null).join(":");
    return at ? `${at}: ${diagnostic.message}` : diagnostic.message;
  }
  const line = problem?.lines?.find((entry) => entry.trim() !== "");
  return line ?? problem?.reason ?? "";
}

/**
 * Every destination's gate added up: any failing fails, any unmeasured leaves it unmeasured. A web
 * build this preview could not run (every row refused `gpu-unsupported`) is reported, not weighed.
 */
function addUp(all: readonly TargetParity[]): { pass: boolean | null; reason: string } {
  const unavailableWeb = (entry: TargetParity) =>
    entry.target === BuildTarget.Web && entry.rows.every(refusedGpuUnsupported);
  const targets = all.filter((entry) => !unavailableWeb(entry));
  const failing = targets.find((entry) => entry.pass === false);
  if (failing) return { pass: false, reason: MESSAGE.parity(failing.target, failing.reason) };
  const open = targets.find((entry) => entry.pass === null);
  if (open) return { pass: null, reason: MESSAGE.parity(open.target, open.reason) };
  return { pass: true, reason: "" };
}

/** What each compiled stack's web build cannot measure, and why, by name: `unmeasured`, never a pass. */
const WEB_UNMEASURED = {
  [GameStack.RaylibCpp]: {
    probes: RAYLIB_WEB_UNMEASURED,
    reason: "a C++ · raylib web build has no counterpart for this probe",
  },
  [GameStack.RustWgpu]: {
    probes: RUST_WEB_UNMEASURED,
    reason: "a Rust · wgpu web build has no counterpart for this probe",
  },
} as const satisfies Record<CompiledStack, { probes: readonly NativeProbe[]; reason: string }>;

/** What each compiled stack's native run cannot measure (the same probes: neither has a page or a GPU error log). */
const NATIVE_UNMEASURED = {
  [GameStack.RaylibCpp]: RAYLIB_NATIVE_UNMEASURED,
  [GameStack.RustWgpu]: RAYLIB_NATIVE_UNMEASURED,
} as const satisfies Record<CompiledStack, readonly NativeProbe[]>;

/** A run's compiled stack: the one it was stamped with, else raylib (every native run before stacks were stamped). */
function stackOfRun(run: Readonly<Record<string, unknown>> | null | undefined): CompiledStack {
  return stampedStack(run) ?? GameStack.RaylibCpp;
}
/** What a native run cannot measure, by name. */
const NATIVE_UNMEASURED_REASON: Readonly<Record<string, string>> = {
  [NativeProbe.GpuErrors]: "a native run reports no GPU error log",
  [NativeProbe.PageUi]: "a native run has no page outside its frame",
  [NativeProbe.UserView]: "a native run's frame is what the player sees: there is no page to compare",
  [NativeProbe.FrameSimilarity]: MESSAGE.similarity,
};

/**
 * A compiled game's web look, finished: what its stack's web build cannot measure is named
 * `unmeasured` (`WEB_UNMEASURED`), and the gates its other destinations owe ride on it (`parity`). A failed gate fails the look like any
 * problem a build has; an unmeasured one is reported, never counted as passing.
 */
export async function withParity(
  ctx: HarnessCtx,
  options: GatherOptions,
  evidence: Evidence,
  leased: LeasedJudging | null,
): Promise<Evidence> {
  const stack = stampedStack(options.run);
  if (!stack) return evidence;
  const { probes, reason } = WEB_UNMEASURED[stack];
  evidence.unmeasured = {
    ...(evidence.unmeasured ?? {}),
    ...Object.fromEntries(probes.map((probe) => [probe, reason])),
  };
  // A page's level counts only when its `audio()` answered `available`; anything else is named.
  const heard = !probes.includes(NativeProbe.Audio) && isNativeAudioMeasured(evidence.audio);
  if (!heard) {
    evidence.audio = null;
    evidence.unmeasured[NativeProbe.Audio] ??= MESSAGE.webUnheard;
  }
  const destinations = leased?.destinations ?? (await destinationsOf(ctx, options.run.project));
  if (!destinations) return evidence;
  const capacity = leased?.capacity.host ? leased.capacity : await hostCapacity(ctx);
  const cameras = lookedThrough(evidence.shots);
  const parity = await parityFor(ctx, {
    run: options.run,
    destinations,
    capacity,
    webHandle: options.handle ?? null,
    root: options.root ?? null,
    seed: options.seed ?? 0,
    cameras,
    viewpoints: evidence.viewpoints ?? cameras,
    judged: !evidence.loadError && cameras.length > 0,
    crossBuilds: options.crossBuilds !== false,
  });
  if (!parity) return evidence;
  evidence.parity = parity;
  evidence.warnings.push(...parity.targets.flatMap((entry) => entry.warnings ?? []));
  if (parity.pass === false) {
    evidence.ok = false;
    evidence.problems.push(parity.reason);
  }
  return evidence;
}

/** The game's destinations as the library names them; null when it is not a library game. */
async function destinationsOf(ctx: HarnessCtx, project: string): Promise<Destinations | null> {
  const games = await ctx.call(HostMethod.GameList, {}).catch(() => []);
  const game = (Array.isArray(games) ? games : []).find((entry: AnyRecord) => entry?.name === project);
  return game?.destinations ?? null;
}

/** What the host says about itself: its platform and its game box. */
async function hostCapacity(ctx: HarnessCtx): Promise<LeaseCapacity> {
  return (await ctx.call(HostMethod.PreviewCapacity, {}).catch(() => null)) ?? {};
}

/** The cameras a look photographed, without its demo end-frames, the user's view or an eye. */
function lookedThrough(shots: readonly Shot[]): string[] {
  const own = (camera: string) => !camera.startsWith("demo:") && !camera.startsWith("eye:") && camera !== "user:view";
  return [...new Set(shots.map((shot) => shot.camera).filter(own))];
}

/** What `gatherEvidence` runs a lease on: the native pass for a desktop judging target, else the web pass. */
export function judgesNatively(handle: string | null | undefined): boolean {
  const leased = leasedJudging(handle);
  return leased !== null && leased.target !== BuildTarget.Web;
}

// ── the native evidence pass ───────────────────────────────────────────────────────────────

/** The native pass drives this many steps of this long (the web pass's thirty simulated seconds). */
const DRIVE_STEPS = 29;
const DRIVE_STEP_MS = 960;
/** A pass without a spec photographs at most this many cameras. */
const MAX_CAMERAS = 6;
/** The demos a pass runs besides the ones a check names, when the caller names no cap (the web pass's default). */
const DEFAULT_MAX_DEMOS = 3;
/** The player's-eye cameras a pass photographs when the game has them. */
const EYE_CAMERAS = ["eye:spawn", "eye:here", "eye:down"];
/** What the answer keeps of the console: the last few errors for a prompt, and the baseline. */
const PROMPT_CONSOLE_ERRORS = 5;
const MAX_CONSOLE_BASELINE = 200;

/** The native pass's own state, phase to phase. */
interface NativeLook {
  ctx: HarnessCtx;
  options: GatherOptions;
  parts: WebPassParts;
  h: { handle?: string };
  prefix: string;
  problems: string[];
  warnings: string[];
  shots: Shot[];
  askedFor: string[];
  missingCameras: string[];
  declaredCameras: string[];
  eyeNames: string[];
  unmeasured: Record<string, string>;
  // biome-ignore lint/suspicious/noExplicitAny: each phase adds the readings the phases after it read.
  [field: string]: any;
}

/** A list a page answers as an array and the native protocol as `{<field>: [...]}`. */
function namesIn(answer: unknown, field: string): string[] | null {
  if (Array.isArray(answer)) return answer.map(String);
  const list = isRecord(answer) ? answer[field] : null;
  return Array.isArray(list) ? list.map(String) : null;
}

/**
 * The evidence pass on a lease whose judging target is a desktop build: the host's admission
 * facts, the run's own readiness, the step witness, the drive, the same named cameras as the web
 * pass, the frame verdicts on those shots, demos and the console — over the typed calls only.
 * What a native run cannot measure is named in `unmeasured`. A pass with no frame fails.
 */
export async function nativeEvidence(ctx: HarnessCtx, options: GatherOptions, parts: WebPassParts): Promise<Evidence> {
  const look: NativeLook = {
    ctx,
    options,
    parts,
    h: options.handle ? { handle: options.handle } : {},
    prefix: options.labelPrefix ?? `iter_${options.iterationId}`,
    problems: [],
    warnings: [],
    shots: [],
    askedFor: [],
    missingCameras: [],
    declaredCameras: [],
    eyeNames: [],
    unmeasured: Object.fromEntries(
      NATIVE_UNMEASURED[stackOfRun(options.run)].map((probe) => [probe, NATIVE_UNMEASURED_REASON[probe] ?? ""]),
    ),
    motionFrames: [],
    demos: {},
    demoStates: {},
    demoShots: [],
    probes: {},
  };
  const up = (await admitNative(look)) && (await loadNative(look));
  if (!up) return reportNative(look);
  try {
    for (const phase of NATIVE_PHASES) await phase(look);
    await memoryNative(look);
  } finally {
    await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Start, ...look.h }).catch(() => {});
  }
  return reportNative(look);
}

/** The run's memory: over the budget a warning when the game also ships to the web or a phone; killed past the cap, a problem. */
async function memoryNative(look: NativeLook): Promise<void> {
  const leased = leasedJudging(look.options.handle);
  const target = leased?.target ?? BuildTarget.Mac;
  const reading = await readMemory(look.ctx, look.options.run.project, look.options.handle);
  look.warnings.push(...memoryWarnings(reading.memory, target, leased?.destinations));
  if (reading.killedPastCap && reading.memory) look.problems.push(memoryCapReason(target, reading.memory));
}

/** The pass on a ready run, in order. */
const NATIVE_PHASES: ReadonlyArray<(look: NativeLook) => Promise<void>> = [
  setupNative,
  witnessNative,
  driveNative,
  probeNative,
  photographNative,
  async (look) => {
    const entry = templateMainOf(stackOfRun(look.options.run));
    const verdicts = verdictLook(look.shots, look.declaredViewpoints ?? [], entry, look.emptyScene === true);
    look.problems.push(...verdicts.problems);
    look.warnings.push(...verdicts.warnings);
  },
  demosNative,
  consoleNative,
];

/** The lane's build of the lease's target and the host's facts about it: a refused or OpenGL bundle is the build's problem. */
async function admitNative(look: NativeLook): Promise<boolean> {
  const { ctx, options } = look;
  const target = leasedJudging(options.handle)?.target ?? BuildTarget.Mac;
  const rows: ParityRowResult[] = [];
  const request = {
    run: options.run,
    target,
    webHandle: null,
    seed: options.seed ?? 0,
    cameras: [],
    root: options.root ?? null,
  };
  const admitted = await admitBuild(ctx, request, rows);
  look.admission = rows[0] ?? null;
  if (look.admission?.pass === false) look.problems.push(look.admission.reason);
  return admitted.run;
}

/** Start the run and read whether it is up: a refusal or a run that never says ready is the build's problem. */
async function loadNative(look: NativeLook): Promise<boolean> {
  const { ctx, h, options, problems } = look;
  try {
    await loadJudged(ctx, {
      project: options.run.project,
      ...(options.root ? { root: options.root } : {}),
      ...h,
    });
    look.ready = await ctx.call(HostMethod.PreviewReady, { ...h });
  } catch (error) {
    problems.push(MESSAGE.notReady(messageOf(error)));
    return false;
  }
  const status = await ctx.call(HostMethod.PreviewStatus, { ...h }).catch(() => null);
  if (status?.loadError) problems.push(status.loadError);
  if (status?.crashed) problems.push("the game crashed");
  const native = await ctx.call(HostMethod.NativeStatus, { project: options.run.project, ...h }).catch(() => null);
  look.backend = typeof native?.backend === "string" ? native.backend : null;
  if (look.ready?.ready !== true)
    problems.push(MESSAGE.notReady(String(look.ready?.reason ?? look.ready?.phase ?? "unknown")));
  return look.ready?.ready === true && !status?.loadError && !status?.crashed;
}

/** The requested state, replayed as the web pass does; a native run needs no knock. */
async function setupNative(look: NativeLook): Promise<void> {
  const setup = look.options.setup === undefined ? look.options.run.setup : look.options.setup;
  if (!setup) return;
  const { gesture: _gesture, ...withoutKnock } = setup;
  look.requestedState = await look.parts.applySetup(look.ctx, withoutKnock, look.h);
  if (look.requestedState.reached === false)
    look.warnings.push(`requested state not reached: ${look.requestedState.reason}`);
}

/** Seed, pause and one witness step: the run rides the studio's clock and draws. */
async function witnessNative(look: NativeLook): Promise<void> {
  const { ctx, h, options } = look;
  try {
    await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Seed, arg: options.seed ?? 0, ...h });
    await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Pause, ...h });
    const witness = await ctx.call(HostMethod.PreviewWitness, { ...h });
    const ok = witness.frameAfter > witness.frameBefore && witness.drawCalls > 0;
    look.clockProof = {
      ok,
      frames: witness.frameAfter - witness.frameBefore,
      drawCalls: witness.drawCalls,
      ms: witness.simulatedMs,
      reason: ok ? "" : MESSAGE.stepped(witness),
    };
    if (!ok) look.problems.push(MESSAGE.stepped(witness));
  } catch (error) {
    look.clockProof = { ok: false, frames: 0, drawCalls: 0, ms: 0, reason: messageOf(error) };
    look.problems.push(`could not drive the game: ${messageOf(error)}`);
  }
}

/** The drive: the game's own controls over thirty simulated seconds, a motion strip, then its state and its sound. */
async function driveNative(look: NativeLook): Promise<void> {
  const { ctx, h, options } = look;
  const step = () => ctx.call(HostMethod.PreviewCall, { method: PageMethod.Step, arg: DRIVE_STEP_MS, ...h });
  const motionAt = motionSteps(Math.max(0, options.motion ?? 0));
  try {
    await step();
    look.stateEarly = await ctx.call(HostMethod.PreviewState, { ...h });
    const script = playScriptFor(options.run?.game);
    const played = await applyPlayScript(ctx, script, { clock: "step", runId: options.run.runId, ...h }).catch(
      (error: unknown) => {
        look.warnings.push(`the play script did not run on the native build: ${messageOf(error)}`);
        return null;
      },
    );
    if (played && played.refused > 0) look.warnings.push(touchesSkipped(played.refused));
    for (let i = 0; i < DRIVE_STEPS; i++) {
      if (motionAt.has(i)) await takeMotionFrame(look);
      await step();
    }
    look.state = await ctx.call(HostMethod.PreviewState, { ...h });
  } catch (error) {
    look.problems.push(`could not drive the game: ${messageOf(error)}`);
  }
  if (isRecord(look.state?.error)) look.problems.push(`runtime error: ${look.state.error.message}`);
  await listenNative(look);
}

/** The drive steps a motion strip of `count` frames is taken at, spread over the drive. */
function motionSteps(count: number): Set<number> {
  const last = DRIVE_STEPS - 1;
  const at = new Set<number>();
  for (let k = 0; k < count; k++) at.add(Math.round((k * last) / Math.max(1, count - 1)));
  return at;
}

/** One motion frame off the default camera; a lost one is a thinner strip, never a voided pass. */
async function takeMotionFrame(look: NativeLook): Promise<void> {
  const index = look.motionFrames.length + 1;
  const label = `${look.prefix}/motion/m${String(index).padStart(2, "0")}`;
  const frame = await photograph(look.ctx, look.options.run, look.h, DEFAULT_CAMERA, label).catch(() => null);
  if (frame) look.motionFrames.push({ ...frame, index });
}

/** The run's sound level: measured when the game answers it, else named unmeasured. */
async function listenNative(look: NativeLook): Promise<void> {
  if (look.options.audio === false) return;
  const level = await look.ctx.call(HostMethod.PreviewCall, { method: PageMethod.Audio, ...look.h }).catch(() => null);
  if (isRecord(level) && typeof level.rms === "number") look.audioProbe = level;
  else look.unmeasured[NativeProbe.Audio] = "the native run did not answer its sound level";
}

/** The game's own phase and camera, measured exactly when its `state()` reports them. */
async function probeNative(look: NativeLook): Promise<void> {
  const { ctx, h } = look;
  const empty = await ctx.call(HostMethod.PreviewEmptyScene, { ...h }).catch(() => null);
  const pose = await ctx.call(HostMethod.PreviewCameraPose, { ...h }).catch(() => null);
  look.probes = { emptyScene: empty, cameraPose: pose };
  if (!empty?.measured) look.unmeasured.emptyScene = "the game's state() reports no phase";
  if (!pose?.measured) look.unmeasured.cameraPose = "the game's state() reports no camera";
  const baseStage = look.options.scaffold === true && look.options.iterationId === "base";
  look.emptyScene = baseStage && empty?.measured === true && empty.drawCalls === 0;
}

/** The cameras: the facet's own (default first), else the game's declared ones, plus its player's eyes. */
async function camerasFor(look: NativeLook): Promise<string[]> {
  const { ctx, h, options } = look;
  const names = [DEFAULT_CAMERA];
  const add = (name: string) => {
    if (!names.includes(name)) names.push(name);
  };
  const declared = namesIn(
    await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Cameras, ...h }).catch(() => null),
    "cameras",
  );
  look.declaredCameras = declared ?? [];
  if (options.cameras?.length) for (const name of options.cameras) add(String(name));
  else for (const name of look.declaredCameras.slice(0, MAX_CAMERAS - 1)) add(name);
  look.declaredViewpoints = names.filter((name) => name === DEFAULT_CAMERA || look.declaredCameras.includes(name));
  if (options.eyes !== false && wantsEyeCameras(options.run?.game)) {
    const eyes = namesIn(
      await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Eyes, ...h }).catch(() => null),
      "eyes",
    );
    look.eyeNames = (eyes ?? []).filter((name) => name.startsWith("eye:"));
    for (const name of look.eyeNames.filter((eye) => EYE_CAMERAS.includes(eye))) add(name);
  }
  return names;
}

/** Every camera photographed off the native run; one the game does not have is named, a failed capture is a problem. */
async function photographNative(look: NativeLook): Promise<void> {
  const { ctx, h, options } = look;
  for (const camera of await camerasFor(look)) {
    look.askedFor.push(camera);
    const label = `${look.prefix}/screenshots/${camera.replace(/[^a-z0-9-_]+/gi, "-")}`;
    try {
      const waits = options.deviceLostRetriesMs ?? DEVICE_LOST_RETRIES_MS;
      const shot = await photograph(ctx, options.run, h, camera, label, waits);
      if (shot) look.shots.push(shot);
      else if (!camera.startsWith("eye:")) look.missingCameras.push(camera);
    } catch (error) {
      look.captureFailed = true;
      look.problems.push(MESSAGE.captureThrew(camera, messageOf(error)));
    }
  }
  if (look.shots.length > 0) return;
  look.captureFailed = true;
  look.problems.push(MESSAGE.noFrame(look.askedFor));
}

/** The game's demos (the ones a check names first, then up to the cap), each photographed at its end. */
async function demosNative(look: NativeLook): Promise<void> {
  const { ctx, h, options } = look;
  const registered = namesIn(
    await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Demos, ...h }).catch(() => null),
    "demos",
  );
  look.registeredDemos = registered;
  const required = new Set((options.requiredDemos ?? []).map(String));
  const ordered = [...(registered ?? [])].sort((a, b) => Number(required.has(b)) - Number(required.has(a)));
  const asked = options.maxDemos ?? DEFAULT_MAX_DEMOS;
  const cap = Number.isFinite(asked) ? Math.max(1, asked) : Infinity;
  const extra = ordered.filter((name) => !required.has(name));
  const toRun = [...ordered.filter((name) => required.has(name)), ...extra.slice(0, cap)];
  look.skippedDemos = extra.slice(cap);
  for (const name of toRun) {
    try {
      look.demos[name] = await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Demo, arg: name, ...h });
      if (look.demos[name]?.ok !== true) continue;
      look.demoStates[name] = await ctx.call(HostMethod.PreviewState, { ...h });
      const shot = await ctx.call(HostMethod.PreviewScreenshot, {
        runId: options.run.runId,
        label: `${look.prefix}/screenshots/demo_${name.replace(/[^a-z0-9-_]+/gi, "-")}`,
        surface: "canvas",
        ...h,
      });
      if (shot?.base64)
        look.demoShots.push({
          camera: `demo:${name}`,
          path: shot.path,
          bytes: shot.bytes,
          base64: shot.base64,
          stats: shot.stats ?? null,
          surface: "canvas",
        });
    } catch (error) {
      look.demos[name] = { ok: false, error: messageOf(error) };
    }
  }
}

/** The run's stderr and fatal lines against what the build inherited. */
async function consoleNative(look: NativeLook): Promise<void> {
  const entries = await look.ctx.call(HostMethod.PreviewConsole, { sinceMs: 0, ...look.h }).catch(() => []);
  look.consoleErrors = (Array.isArray(entries) ? entries : []).filter((entry) => entry.level === "error");
  const verdict = look.parts.consoleProblems(look.consoleErrors, look.options.inheritedConsole ?? []);
  look.problems.push(...verdict.problems);
  look.warnings.push(...verdict.warnings);
}

/** The pass's answer, shaped as the web pass's: what a native run cannot measure is named, never passed. */
function reportNative(look: NativeLook): Evidence {
  const { problems, shots } = look;
  // `photographNative` already said so when it ran; the early ends (refused, never ready) did not.
  if (shots.length === 0 && !look.captureFailed) {
    look.captureFailed = true;
    problems.push(MESSAGE.noFrame(look.askedFor));
  }
  return {
    ok: problems.length === 0 && shots.length > 0,
    problems,
    warnings: look.warnings,
    shots: [...shots, ...look.demoShots],
    ...nativeReadings(look),
    ...nativeConsole(look),
    gpuErrors: [],
    motion: look.motionFrames,
    eyes: look.eyeNames,
    missingCameras: look.missingCameras,
    readyAfterMs: null,
    surface: "canvas",
    pageUi: null,
    canvas: null,
    stack: stackOfRun(look.options.run),
    unmeasured: look.unmeasured,
    probes: look.probes,
    captureFailed: look.captureFailed === true,
  };
}

/** What the pass read of the game, each null when it never got that far. */
function nativeReadings(look: NativeLook): AnyRecord {
  return {
    requestedState: look.requestedState ?? null,
    emptyScene: look.emptyScene === true,
    demos: Object.keys(look.demos).length ? look.demos : null,
    demoStates: Object.keys(look.demoStates).length ? look.demoStates : null,
    registeredDemos: look.registeredDemos ?? null,
    skippedDemos: look.skippedDemos ?? [],
    state: look.state ?? null,
    stateEarly: look.stateEarly ?? null,
    audio: look.audioProbe ?? null,
    ready: look.ready ?? null,
    clock: look.clockProof ?? null,
    admission: look.admission ?? null,
    backend: look.backend ?? null,
    render: renderTally(look.state),
  };
}

/** What a frame drew, as the evidence reports it: logical draws by tag, and the GPU encoder's counts apart. */
export interface RenderTally {
  /** The game's tagged (logical) draws: the sum over its tags, before any GPU culling or batching. */
  drawCalls: number;
  /** Each tag's logical draws. */
  tags: Record<string, number>;
  /** The GPU encoder's own counts (`state().volatile.gpu`): indirect and multi-draws, never compared. */
  gpu: AnyRecord | null;
}

/**
 * The frame's draws from a run's `state()`: `drawCalls` is the logical count the game tagged
 * (`__render.tags`; `__render.drawCalls` when it names no tags), which GPU culling never changes,
 * and what the encoder issued lives under `gpu` (`volatile.gpu`), never in `drawCalls`. Null when
 * the run reported no tally.
 */
function renderTally(state: unknown): RenderTally | null {
  const render = isRecord(state) && isRecord(state.__render) ? state.__render : null;
  if (!render) return null;
  const tagged = isRecord(render.tags) ? render.tags : {};
  const tags: Record<string, number> = {};
  for (const [tag, entry] of Object.entries(tagged)) {
    const draws = isRecord(entry) ? Number(entry.drawCalls) : Number.NaN;
    if (Number.isFinite(draws)) tags[tag] = draws;
  }
  const summed = Object.values(tags).reduce((total, draws) => total + draws, 0);
  const reported = Number.isFinite(Number(render.drawCalls)) ? Number(render.drawCalls) : 0;
  const drawCalls = Object.keys(tags).length ? summed : reported;
  const volatile = isRecord(state) && isRecord(state.volatile) ? state.volatile : null;
  return { drawCalls, tags, gpu: volatile && isRecord(volatile.gpu) ? volatile.gpu : null };
}

/** The console as the answer keeps it: the last few errors for a prompt, and every distinct one for a baseline. */
function nativeConsole(look: NativeLook): { consoleErrors: string[]; consoleBaseline: string[] } {
  const errors: AnyRecord[] = look.consoleErrors ?? [];
  return {
    consoleErrors: errors.slice(-PROMPT_CONSOLE_ERRORS).map((entry) => String(entry.message)),
    consoleBaseline: [...new Set(errors.map((entry) => String(entry.message)))].slice(0, MAX_CONSOLE_BASELINE),
  };
}
