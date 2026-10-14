/**
 * The M0a authoring trial (M0a.14a driver; the paid run is the owner gate M0a.14): the same facet
 * asks (`authoring-asks.json`) against the Rust pond on the genex facade (with `GENEX_API.md`) and
 * the raylib-cpp fishing game, scored per stack as first-compile success, repair
 * turns until a green build, warm rebuild+link time and a web probe, then compared in one table.
 * The plan's kill line: Rust below the raylib baseline, or a warm rebuild over 2× the C++ lane.
 *
 *   node scripts/spike/rust-wgpu/authoring-trial.ts --dry-run [--out <dir>]
 *   GENEX_AUTHORING_TRIAL_AUTHORIZED=<attempt cap> node scripts/spike/rust-wgpu/authoring-trial.ts \
 *     --live --profile <owned studio:dev live profile> --model <model> \
 *     --rust-game <workspace copy> --raylib-game <fishing game copy> [--stack rust|raylib] [--out <dir>]
 *
 * - The dry run (the default) replays fixture transcripts through a stub provider: no provider, no
 *   build, no network. It proves the scoring and writes the comparison table the gate fills.
 * - A live run needs the owner's variable: an attempt cap of facet asks per stack (1–24). Without
 *   it, or with anything but a plain positive integer, the run is refused before a provider exists
 *   and writes nothing: one typed line on stderr (`genex-authoring-refusal: {"code":…}`), exit 78.
 * - Live turns run the provider's coding CLI headless (Claude Code, print mode, `acceptEdits`) in a
 *   fresh copy of the game per ask (M0a predates the in-app Rust lane, so the turn is the CLI's, not
 *   the app's). The named owned `studio:dev` live profile is validated; like every retained live
 *   profile it shares the operator's provider account (a fresh-machine profile's own HOME is used
 *   when the profile has one). The CLI gets the app's contractor environment: every credential
 *   variable (GitHub, cloud, SSH agent, metered keys) and `CLAUDE_CONFIG_DIR` dropped, the
 *   auto-updater off.
 * - After each reply, before anything is built, the driver checks the turn's scope against the
 *   copy it started from: a change outside the stack's `editable` folders, a symbolic link, a
 *   `.cargo` folder, a manifest or lockfile (Cargo.toml, Cargo.lock, CMakeLists.txt), a build
 *   script, or (Rust) `unsafe` in an edited file ends the attempt with a typed scope refusal and
 *   nothing is built. Every configure, build and web command then runs inside `ProcessSandbox`
 *   (no network; writes only under the run's folder and the spike's cargo home) with the
 *   sandbox's allow-listed environment, so agent-edited code never builds as the operator.
 * - The driver builds the copy itself (cargo JSON diagnostics, or the C++ compiler's
 *   `file:line:col: error:` lines) and, while the build is red and repair turns remain, sends the
 *   errors back as the next ask. A green attempt is timed on a warm rebuild after touching one
 *   source file and, when the stack has a web build, probed through the existing Chromium prober.
 *   TODO(M0a.14): the agent turn itself runs outside the sandbox (the CLI needs its account and
 *   the network); the owner runs the paid trial from a dedicated account.
 * - Raw evidence stays under `.studio-dev/evidence/` (`trial.json`, `comparison.md`,
 *   `transcripts.jsonl`, agent streams); only an `evals/baselines` entry is ever committed, and only
 *   if the owner wants one.
 */
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { appendFile, cp, lstat, mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MINUTE_MS, SECOND_MS } from "../../../src/shared/duration.ts";
import { EngineId } from "../../../src/shared/providers.ts";
import { childEnv } from "../../../src/substrate/child-env.ts";
import { shellQuote } from "../../../src/substrate/shell-quote.ts";
import { configuredEvalsHome } from "../../evals/home.ts";
import { probeLockPath } from "../../evals/prober/lock.ts";

const REPO = path.resolve(import.meta.dirname, "../../..");

/** The two stacks the trial compares; raylib-cpp is the baseline. */
export const TrialStack = {
  Rust: "rust",
  Raylib: "raylib",
} as const;
export type TrialStack = (typeof TrialStack)[keyof typeof TrialStack];
/** The stacks in the order a run visits them. */
export const TRIAL_STACKS: readonly TrialStack[] = [TrialStack.Rust, TrialStack.Raylib];

/** Where a run's transcripts come from. */
export const TrialMode = {
  DryRun: "dry-run",
  Live: "live",
} as const;
export type TrialMode = (typeof TrialMode)[keyof typeof TrialMode];

/** How a green attempt's web build fared in the prober. */
export const ProbeOutcome = {
  Pass: "pass",
  Fail: "fail",
  NotRun: "not-run",
} as const;
export type ProbeOutcome = (typeof ProbeOutcome)[keyof typeof ProbeOutcome];

/** Why an agent turn's edits were refused before anything was built. */
export const TurnScopeCode = {
  /** A file outside the stack's editable folders was added, changed or removed. */
  OutsideEditable: "outside-editable",
  /** The copy holds a symbolic link: an edit through it lands outside the copy. */
  Symlink: "symlink",
  /** A `.cargo` folder: cargo reads its config (a runner, a linker, a rustc wrapper, a source). */
  CargoConfig: "cargo-config",
  /** A manifest or lockfile changed (Cargo.toml, Cargo.lock, CMakeLists.txt): new crates, build scripts, proc macros, `[patch]`. */
  Manifest: "manifest",
  /** A build script (`build.rs`) appeared or changed. */
  BuildScript: "build-script",
  /** An edited Rust file uses `unsafe`. */
  UnsafeCode: "unsafe-code",
} as const;
export type TurnScopeCode = (typeof TurnScopeCode)[keyof typeof TurnScopeCode];

/** A turn whose edits went out of scope. */
export interface ScopeRefusal {
  code: TurnScopeCode;
  detail: string;
}

/** Why a run did not start. */
export const TrialRefusalCode = {
  AuthorizationMissing: "authorization-missing",
  AuthorizationInvalid: "authorization-invalid",
  LivePrerequisiteMissing: "live-prerequisite-missing",
  InputInvalid: "input-invalid",
} as const;
export type TrialRefusalCode = (typeof TrialRefusalCode)[keyof typeof TrialRefusalCode];

/** The plan's kill criteria this trial can witness. */
export const KillReason = {
  FirstCompileBelow: "first-compile-below-baseline",
  SuccessBelow: "success-below-baseline",
  WarmRebuildOver2x: "warm-rebuild-over-2x",
} as const;
export type KillReason = (typeof KillReason)[keyof typeof KillReason];

/** The comparison table's rows. */
export const TrialMetric = {
  FirstCompile: "first-compile",
  Success: "success",
  RepairTurns: "repair-turns",
  WarmRebuild: "warm-rebuild",
  ProbePass: "probe-pass",
} as const;
export type TrialMetric = (typeof TrialMetric)[keyof typeof TrialMetric];

/** What a row says about Rust against the baseline. */
export const RowVerdict = {
  AtOrAbove: "at-or-above-baseline",
  Below: "below-baseline",
  Within2x: "within-2x",
  Over2x: "over-2x",
  Informational: "informational",
  NotMeasured: "not-measured",
} as const;
export type RowVerdict = (typeof RowVerdict)[keyof typeof RowVerdict];

/** The owner's variable: its value is the attempt cap (facet asks per stack). */
export const TRIAL_AUTHORIZATION_VAR = "GENEX_AUTHORING_TRIAL_AUTHORIZED";
/** The largest cap the variable may name (four times the plan's default of six). */
export const MAX_ATTEMPT_CAP = 24;
/** A refused run's exit code, as the spike scripts use. */
export const REFUSAL_EXIT = 78;
/** The prefix of the one typed refusal line on stderr. */
export const REFUSAL_PREFIX = "genex-authoring-refusal: ";
/** The asks both stacks get. */
export const DEFAULT_ASKS_FILE = path.join(import.meta.dirname, "authoring-asks.json");
/** The stub provider's synthetic transcripts. */
export const DEFAULT_TRANSCRIPTS_FILE = path.join(REPO, "tests/fixtures/authoring-trial/transcripts.json");

const USAGE_EXIT = 2;
const REPORT_SCHEMA = "genex-authoring-trial/1";
const ASKS_SCHEMA = "genex-authoring-asks/1";
const TRANSCRIPTS_SCHEMA = "genex-authoring-transcripts/1";
const DRY_RUN_OUT = path.join(REPO, ".studio-dev/evidence/rust-authoring-trial/dry-run");
/** Said under a dry run's table, so its synthetic verdict is never read as a measurement. */
const DRY_RUN_NOTE =
  "Dry run: synthetic fixture transcripts through the stub provider. These numbers test the driver, not the stacks.";
const LIVE_OUT_ROOT = path.join(REPO, ".studio-dev/evidence/m0a/authoring");
/** Rust's warm rebuild+link may take at most this multiple of the C++ lane's. */
const WARM_REBUILD_RATIO_MAX = 2;
/** How many diagnostics a repair ask quotes, and how long one message may be. */
const REPAIR_DIAGNOSTICS = 10;
const MESSAGE_CHARS_MAX = 500;
const AGENT_TURN_TIMEOUT_MS = 20 * MINUTE_MS;
const BUILD_TIMEOUT_MS = 15 * MINUTE_MS;
const PROBE_FIRST_DRAW_MS = 120 * SECOND_MS;
const PROBE_NO_ERRORS_MS = 60 * SECOND_MS;
const OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
/** The run's own prober lock (relative to its folder) when no evals home is set. */
const TRIAL_PROBE_LOCK = ["locks", "prober.lock"] as const;
/** The last lines of a failed configure's output its refusal quotes. */
const CONFIGURE_TAIL_LINES = 10;
/** Folders a per-ask work copy leaves behind: build products and history, never sources. */
const WORK_COPY_SKIPPED = new Set(["target", "build", "node_modules", ".git"]);
/** The coding CLI's own folder in its working folder: never read by a build. */
const CLI_STATE_DIR = ".claude";
/** File names whose change is a manifest change wherever they are. */
const MANIFEST_NAMES = new Set(["Cargo.toml", "Cargo.lock", "CMakeLists.txt", "rust-toolchain", "rust-toolchain.toml"]);
const BUILD_SCRIPT_NAME = "build.rs";
const CARGO_CONFIG_DIR = ".cargo";
const UNSAFE_TOKEN = /\bunsafe\b/;
/** The exit a scope-refused turn's (unrun) build is recorded with. */
const SCOPE_REFUSED_EXIT = 78;
/** Variables no trial child gets even when the contractor filter would keep them. */
const TRIAL_DROPPED_ENV = ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "CLAUDE_CONFIG_DIR"];
const PROFILE_SLUG = /^[a-z0-9][a-z0-9-]{0,47}$/;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;
const ATTEMPT_CAP = /^[1-9][0-9]?$/;
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
/** clang/gcc: `file:line:col: error: message` or `fatal error:`. */
const CPP_LOCATED = /^(.+?):(\d+):(\d+): (?:fatal )?error: (.*)$/;
/** MSVC: `file(line,col): error C1234: message`. */
const MSVC_LOCATED = /^(.+?)\((\d+),(\d+)\): (?:fatal )?error (\w+): (.*)$/;
/** A tool-level error with no location: `clang++: error: linker command failed …`. */
const CPP_UNLOCATED = /^[^\s:]+: (?:fatal )?error: /;

/** What one build printed and how it ended. */
export interface BuildOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** One located compiler error. */
export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  code: string | null;
  message: string;
}

/** A build read through its stack's diagnostics. */
export interface ParsedBuild {
  ok: boolean;
  diagnostics: Diagnostic[];
  /** Errors with no source location (a link failure, a summary line). */
  unlocatedErrors: number;
}

/** One agent turn and the build after it. */
export interface TurnRecord {
  prompt: string;
  build: BuildOutput;
}

/** One facet ask on one stack, as the provider (or the stub) produced it. */
export interface AttemptTranscript {
  stack: TrialStack;
  ask: string;
  turns: TurnRecord[];
  warmRebuildMs: number | null;
  probe: ProbeOutcome;
  /** Set when a turn's edits were refused: the attempt ended there and nothing was built. */
  scopeRefusal?: ScopeRefusal;
}

/** One scored attempt. */
export interface AttemptRecord {
  stack: TrialStack;
  ask: string;
  firstCompileOk: boolean;
  firstCompileErrors: number;
  /** Turns after the first until a green build: 0 when the first was green, null when none was. */
  repairTurns: number | null;
  succeeded: boolean;
  turns: number;
  warmRebuildMs: number | null;
  probe: ProbeOutcome;
  firstDiagnostics: Diagnostic[];
}

/** One stack's totals. */
export interface StackSummary {
  stack: TrialStack;
  attempts: number;
  firstCompileOk: number;
  succeeded: number;
  meanRepairTurns: number | null;
  medianWarmRebuildMs: number | null;
  probePassed: number;
}

/** One row of the comparison table. */
export interface ComparisonRow {
  metric: TrialMetric;
  rust: string;
  raylib: string;
  verdict: RowVerdict;
}

/** Whether the trial hit a kill criterion. */
export interface TrialVerdict {
  kill: boolean;
  reasons: KillReason[];
}

/** Who and what produced the transcripts. */
export interface TrialIdentity {
  provider: string;
  model: string | null;
  profile: string | null;
  build: string | null;
}

/** Everything a run records. */
export interface TrialReport {
  schema: typeof REPORT_SCHEMA;
  mode: TrialMode;
  identity: TrialIdentity;
  attemptCap: number;
  maxRepairTurns: number;
  attempts: AttemptRecord[];
  summaries: Partial<Record<TrialStack, StackSummary>>;
  comparison: ComparisonRow[];
  verdict: TrialVerdict;
}

/** A command line from the asks file; `{repo}`, `{game}`, `{buildDir}` and `{webOut}` expand. */
export interface CommandSpec {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

/** How one stack is asked and built. */
export interface StackSpec {
  label: string;
  baseline: boolean;
  preamble: string;
  touch: string;
  /** Folders (relative, ending in `/`) the agent may change; anything else refuses the turn. */
  editable: string[];
  configure?: CommandSpec | null;
  build: CommandSpec;
  web: CommandSpec | null;
}

/** One facet ask. */
export interface FacetAsk {
  id: string;
  facet: string;
  text: string;
}

/** The asks file. */
export interface TrialAsks {
  maxRepairTurns: number;
  repairTemplate: string;
  stacks: Record<TrialStack, StackSpec>;
  asks: FacetAsk[];
}

/** What a live provider is built from. */
export interface LiveContext {
  out: string;
  asks: TrialAsks;
  profile: string;
  model: string;
  games: Partial<Record<TrialStack, string>>;
  attemptCap: number;
}

/** Produces one attempt's transcript. */
export interface TrialProvider {
  attempt(stack: TrialStack, ask: FacetAsk): Promise<AttemptTranscript>;
}

/** Builds the live provider; only ever called after the owner's variable was accepted. */
export type LiveProviderFactory = (ctx: LiveContext) => TrialProvider | Promise<TrialProvider>;

/** A run's request. */
export interface TrialOptions {
  mode: TrialMode;
  env: NodeJS.ProcessEnv;
  out?: string;
  asksFile?: string;
  transcriptsFile?: string;
  profile?: string;
  model?: string;
  games?: Partial<Record<TrialStack, string>>;
  stacks?: readonly TrialStack[];
}

/** What a run may be given instead of the system's own parts. */
export interface TrialDeps {
  liveProvider?: LiveProviderFactory;
  buildIdentity?: () => Promise<string | null>;
}

/** A typed refusal. */
export interface TrialRefusal {
  code: TrialRefusalCode;
  detail: string;
}

/** A run's outcome. */
export type TrialResult = { ok: true; report: TrialReport; out: string } | { ok: false; refusal: TrialRefusal };

// ---------------------------------------------------------------------------------------------
// Diagnostics

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const linesOf = (text: string) => text.split(/\r?\n/);

const clipped = (message: string) => message.slice(0, MESSAGE_CHARS_MAX);

function jsonLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** The primary span of a cargo message as a diagnostic, or null when it has none. */
function cargoDiagnostic(message: Record<string, unknown>): Diagnostic | null {
  const spans = Array.isArray(message.spans) ? message.spans.filter(isRecord) : [];
  const span = spans.find((s) => s.is_primary === true) ?? spans[0];
  if (!span) return null;
  const located = typeof span.file_name === "string" && Number.isInteger(span.line_start);
  if (!located || typeof message.message !== "string") return null;
  const code = isRecord(message.code) && typeof message.code.code === "string" ? message.code.code : null;
  const column = Number.isInteger(span.column_start) ? Number(span.column_start) : 0;
  return {
    file: String(span.file_name),
    line: Number(span.line_start),
    column,
    code,
    message: clipped(message.message),
  };
}

/** A cargo `--message-format=json` build: error-level compiler messages and `build-finished`. */
export function parseCargoBuild(output: BuildOutput): ParsedBuild {
  const diagnostics: Diagnostic[] = [];
  let unlocatedErrors = 0;
  let finishedOk: boolean | null = null;
  for (const line of linesOf(output.stdout)) {
    const record = jsonLine(line.trim());
    if (record?.reason === "build-finished") finishedOk = record.success === true;
    const message = record?.reason === "compiler-message" ? record.message : null;
    if (!isRecord(message) || message.level !== "error") continue;
    const diagnostic = cargoDiagnostic(message);
    if (diagnostic) diagnostics.push(diagnostic);
    else unlocatedErrors += 1;
  }
  const exitedOk = finishedOk ?? output.exitCode === 0;
  const ok = exitedOk && output.exitCode === 0 && diagnostics.length === 0 && unlocatedErrors === 0;
  return { ok, diagnostics, unlocatedErrors };
}

function cppDiagnostic(line: string): Diagnostic | null {
  const msvc = MSVC_LOCATED.exec(line);
  if (msvc) {
    const [, file = "", row = "0", column = "0", code = "", message = ""] = msvc;
    return { file, line: Number(row), column: Number(column), code, message: clipped(message) };
  }
  const clang = CPP_LOCATED.exec(line);
  if (!clang) return null;
  const [, file = "", row = "0", column = "0", message = ""] = clang;
  return { file, line: Number(row), column: Number(column), code: null, message: clipped(message) };
}

/** A C++ build: the compiler's `file:line:col: error:` lines (and MSVC's), tool errors, the exit code. */
export function parseCppBuild(output: BuildOutput): ParsedBuild {
  const diagnostics: Diagnostic[] = [];
  let unlocatedErrors = 0;
  for (const raw of linesOf(`${output.stdout}\n${output.stderr}`)) {
    const line = raw.replace(ANSI_ESCAPE, "").trimEnd();
    const diagnostic = cppDiagnostic(line);
    if (diagnostic) diagnostics.push(diagnostic);
    else if (CPP_UNLOCATED.test(line)) unlocatedErrors += 1;
  }
  const ok = output.exitCode === 0 && diagnostics.length === 0 && unlocatedErrors === 0;
  return { ok, diagnostics, unlocatedErrors };
}

/** Each stack's diagnostics reader. */
const PARSERS = {
  [TrialStack.Rust]: parseCargoBuild,
  [TrialStack.Raylib]: parseCppBuild,
} as const satisfies Record<TrialStack, (output: BuildOutput) => ParsedBuild>;

/** One build read through its stack's reader. */
export const parseBuild = (stack: TrialStack, output: BuildOutput): ParsedBuild => PARSERS[stack](output);

// ---------------------------------------------------------------------------------------------
// Scoring

/** One transcript scored; turns past the repair cap are not counted. */
export function scoreAttempt(transcript: AttemptTranscript, maxRepairTurns: number): AttemptRecord {
  const parsed = transcript.turns.slice(0, maxRepairTurns + 1).map((t) => parseBuild(transcript.stack, t.build));
  const greenAt = parsed.findIndex((p) => p.ok);
  const succeeded = greenAt >= 0;
  const first = parsed[0];
  return {
    stack: transcript.stack,
    ask: transcript.ask,
    firstCompileOk: greenAt === 0,
    firstCompileErrors: first ? first.diagnostics.length + first.unlocatedErrors : 0,
    repairTurns: succeeded ? greenAt : null,
    succeeded,
    turns: parsed.length,
    warmRebuildMs: succeeded ? transcript.warmRebuildMs : null,
    probe: succeeded ? transcript.probe : ProbeOutcome.NotRun,
    firstDiagnostics: first ? first.diagnostics.slice(0, REPAIR_DIAGNOSTICS) : [],
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  return ((sorted[mid - 1] ?? upper) + upper) / 2;
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

const notNull = <T>(value: T | null): value is T => value !== null;

/** One stack's totals, or null when it has no attempts. */
function summarizeStack(stack: TrialStack, records: AttemptRecord[]): StackSummary | null {
  const own = records.filter((r) => r.stack === stack);
  if (own.length === 0) return null;
  return {
    stack,
    attempts: own.length,
    firstCompileOk: own.filter((r) => r.firstCompileOk).length,
    succeeded: own.filter((r) => r.succeeded).length,
    meanRepairTurns: mean(own.map((r) => r.repairTurns).filter(notNull)),
    medianWarmRebuildMs: median(own.map((r) => r.warmRebuildMs).filter(notNull)),
    probePassed: own.filter((r) => r.probe === ProbeOutcome.Pass).length,
  };
}

const rate = (count: number, of: number) => (of === 0 ? 0 : count / of);
const share = (count: number, of: number) => `${count}/${of} (${Math.round(rate(count, of) * 100)}%)`;
const DASH = "—";

/** A row comparing a count-of-attempts share, where higher is better. */
function shareRow(metric: TrialMetric, rust: StackSummary, raylib: StackSummary, pick: (s: StackSummary) => number) {
  const below = rate(pick(rust), rust.attempts) < rate(pick(raylib), raylib.attempts);
  return {
    metric,
    rust: share(pick(rust), rust.attempts),
    raylib: share(pick(raylib), raylib.attempts),
    verdict: below ? RowVerdict.Below : RowVerdict.AtOrAbove,
  };
}

function repairRow(rust: StackSummary, raylib: StackSummary): ComparisonRow {
  const text = (value: number | null) => (value === null ? DASH : value.toFixed(2));
  const measured = rust.meanRepairTurns !== null && raylib.meanRepairTurns !== null;
  const more = measured && (rust.meanRepairTurns ?? 0) > (raylib.meanRepairTurns ?? 0);
  const verdict = more ? RowVerdict.Below : RowVerdict.AtOrAbove;
  return {
    metric: TrialMetric.RepairTurns,
    rust: text(rust.meanRepairTurns),
    raylib: text(raylib.meanRepairTurns),
    verdict: measured ? verdict : RowVerdict.NotMeasured,
  };
}

/** Rust's warm rebuild over the C++ lane's, or null when either was not measured. */
function warmRatio(rust: StackSummary, raylib: StackSummary): number | null {
  if (rust.medianWarmRebuildMs === null || !raylib.medianWarmRebuildMs) return null;
  return rust.medianWarmRebuildMs / raylib.medianWarmRebuildMs;
}

function warmRow(rust: StackSummary, raylib: StackSummary): ComparisonRow {
  const text = (value: number | null) => (value === null ? DASH : `${Math.round(value)} ms`);
  const ratio = warmRatio(rust, raylib);
  const over = ratio !== null && ratio > WARM_REBUILD_RATIO_MAX;
  const verdict = over ? RowVerdict.Over2x : RowVerdict.Within2x;
  const suffix = ratio === null ? "" : ` (${ratio.toFixed(2)}×)`;
  return {
    metric: TrialMetric.WarmRebuild,
    rust: `${text(rust.medianWarmRebuildMs)}${suffix}`,
    raylib: text(raylib.medianWarmRebuildMs),
    verdict: ratio === null ? RowVerdict.NotMeasured : verdict,
  };
}

function comparisonOf(rust: StackSummary, raylib: StackSummary): ComparisonRow[] {
  return [
    shareRow(TrialMetric.FirstCompile, rust, raylib, (s) => s.firstCompileOk),
    shareRow(TrialMetric.Success, rust, raylib, (s) => s.succeeded),
    repairRow(rust, raylib),
    warmRow(rust, raylib),
    { ...shareRow(TrialMetric.ProbePass, rust, raylib, (s) => s.probePassed), verdict: RowVerdict.Informational },
  ];
}

/** The rows of a run that measured one stack only. */
function oneSidedComparison(summaries: Partial<Record<TrialStack, StackSummary>>): ComparisonRow[] {
  const cell = (summary: StackSummary | undefined, value: (s: StackSummary) => string) =>
    summary ? value(summary) : DASH;
  const rows: Array<[TrialMetric, (s: StackSummary) => string]> = [
    [TrialMetric.FirstCompile, (s) => share(s.firstCompileOk, s.attempts)],
    [TrialMetric.Success, (s) => share(s.succeeded, s.attempts)],
    [TrialMetric.RepairTurns, (s) => (s.meanRepairTurns === null ? DASH : s.meanRepairTurns.toFixed(2))],
    [TrialMetric.WarmRebuild, (s) => (s.medianWarmRebuildMs === null ? DASH : `${s.medianWarmRebuildMs} ms`)],
    [TrialMetric.ProbePass, (s) => share(s.probePassed, s.attempts)],
  ];
  return rows.map(([metric, value]) => ({
    metric,
    rust: cell(summaries[TrialStack.Rust], value),
    raylib: cell(summaries[TrialStack.Raylib], value),
    verdict: RowVerdict.NotMeasured,
  }));
}

const KILL_ROWS = [
  [TrialMetric.FirstCompile, RowVerdict.Below, KillReason.FirstCompileBelow],
  [TrialMetric.Success, RowVerdict.Below, KillReason.SuccessBelow],
  [TrialMetric.WarmRebuild, RowVerdict.Over2x, KillReason.WarmRebuildOver2x],
] as const;

/** Totals, the comparison table and the kill verdict for scored attempts. */
export function summarizeTrial(records: AttemptRecord[]) {
  const summaries: Partial<Record<TrialStack, StackSummary>> = {};
  for (const stack of TRIAL_STACKS) {
    const summary = summarizeStack(stack, records);
    if (summary) summaries[stack] = summary;
  }
  const rust = summaries[TrialStack.Rust];
  const raylib = summaries[TrialStack.Raylib];
  const comparison = rust && raylib ? comparisonOf(rust, raylib) : oneSidedComparison(summaries);
  const reasons = KILL_ROWS.filter(([metric, verdict]) =>
    comparison.some((row) => row.metric === metric && row.verdict === verdict),
  ).map(([, , reason]) => reason);
  return { summaries, comparison, verdict: { kill: reasons.length > 0, reasons } };
}

const METRIC_LABEL = {
  [TrialMetric.FirstCompile]: "First-compile success",
  [TrialMetric.Success]: "Green within the repair cap",
  [TrialMetric.RepairTurns]: "Mean repair turns (green attempts)",
  [TrialMetric.WarmRebuild]: "Median warm rebuild+link",
  [TrialMetric.ProbePass]: "Web probe passed",
} as const satisfies Record<TrialMetric, string>;

/** The comparison as Markdown: the table the M0a.14 gate fills. */
export function comparisonMarkdown(report: TrialReport): string {
  const { identity } = report;
  const rows = report.comparison.map(
    (row) => `| ${METRIC_LABEL[row.metric]} | ${row.rust} | ${row.raylib} | ${row.verdict} |`,
  );
  const reasons = report.verdict.reasons.length ? report.verdict.reasons.join(", ") : "none";
  return [
    `# Authoring trial (${report.mode})`,
    "",
    `- Provider: ${identity.provider}; model: ${identity.model ?? DASH}; profile: ${identity.profile ?? DASH}; build: ${identity.build ?? DASH}`,
    `- Attempt cap: ${report.attemptCap} facet asks per stack; repair cap: ${report.maxRepairTurns} turns`,
    "",
    "| Metric | Rust (genex) | raylib-cpp (baseline) | Verdict |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    `Kill criteria hit: ${reasons}.`,
    "",
    "The kill criteria are first-compile and green rates below the baseline and a warm rebuild over 2× the",
    "C++ lane; repair turns are reported for the owner's judgement.",
    ...(report.mode === TrialMode.DryRun ? ["", DRY_RUN_NOTE] : []),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Inputs

class InputError extends Error {}
/** The live provider could not be set up (profile, CLI): refused as a missing prerequisite. */
class LiveSetupError extends Error {}

function requireShape(condition: boolean, what: string): void {
  if (!condition) throw new InputError(what);
}

function commandSpec(value: unknown, what: string): CommandSpec {
  requireShape(isRecord(value), `${what} is not an object`);
  const spec = value as Record<string, unknown>;
  const argv = Array.isArray(spec.argv) ? spec.argv : [];
  requireShape(argv.length > 0 && argv.every((a) => typeof a === "string"), `${what}.argv`);
  requireShape(typeof spec.cwd === "string", `${what}.cwd`);
  const env = isRecord(spec.env) ? spec.env : {};
  requireShape(
    Object.values(env).every((v) => typeof v === "string"),
    `${what}.env`,
  );
  return { argv: argv as string[], cwd: String(spec.cwd), env: env as Record<string, string> };
}

/** A relative folder below the game's root, spelled `a/b/` with no climb. */
function isEditableFolder(folder: string): boolean {
  const parts = folder.split("/");
  const named = parts.slice(0, -1);
  return folder.endsWith("/") && named.length > 0 && named.every((p) => p !== "" && p !== "." && p !== "..");
}

function stackSpec(value: unknown, stack: TrialStack): StackSpec {
  requireShape(isRecord(value), `stacks.${stack} is missing`);
  const spec = value as Record<string, unknown>;
  for (const key of ["label", "preamble", "touch"])
    requireShape(typeof spec[key] === "string", `stacks.${stack}.${key}`);
  const optional = (key: string) => (spec[key] ? commandSpec(spec[key], `stacks.${stack}.${key}`) : null);
  const editable = Array.isArray(spec.editable) ? spec.editable : [];
  const folders = editable.every((e) => typeof e === "string" && isEditableFolder(e));
  requireShape(editable.length > 0 && folders, `stacks.${stack}.editable`);
  return {
    label: String(spec.label),
    baseline: spec.baseline === true,
    preamble: String(spec.preamble),
    touch: String(spec.touch),
    editable: editable as string[],
    configure: optional("configure"),
    build: commandSpec(spec.build, `stacks.${stack}.build`),
    web: optional("web"),
  };
}

function facetAsk(value: unknown, index: number): FacetAsk {
  requireShape(isRecord(value), `asks[${index}]`);
  const ask = value as Record<string, unknown>;
  const fields = [ask.id, ask.facet, ask.text];
  requireShape(
    fields.every((f) => typeof f === "string" && f.length > 0),
    `asks[${index}] fields`,
  );
  return { id: String(ask.id), facet: String(ask.facet), text: String(ask.text) };
}

/** The asks file, checked. */
export async function loadAsks(file: string): Promise<TrialAsks> {
  const doc: unknown = JSON.parse(await readFile(file, "utf8"));
  requireShape(isRecord(doc) && doc.schema === ASKS_SCHEMA, `${file}: schema is not ${ASKS_SCHEMA}`);
  const asks = doc as Record<string, unknown>;
  const maxRepairTurns = Number(asks.maxRepairTurns);
  requireShape(Number.isInteger(maxRepairTurns) && maxRepairTurns >= 0, "maxRepairTurns");
  requireShape(typeof asks.repairTemplate === "string", "repairTemplate");
  requireShape(isRecord(asks.stacks) && Array.isArray(asks.asks), "stacks/asks");
  const stacks = asks.stacks as Record<string, unknown>;
  const list = (asks.asks as unknown[]).map(facetAsk);
  requireShape(new Set(list.map((a) => a.id)).size === list.length, "ask ids are not unique");
  return {
    maxRepairTurns,
    repairTemplate: String(asks.repairTemplate),
    stacks: {
      [TrialStack.Rust]: stackSpec(stacks.rust, TrialStack.Rust),
      [TrialStack.Raylib]: stackSpec(stacks.raylib, TrialStack.Raylib),
    },
    asks: list,
  };
}

const isStack = (value: unknown): value is TrialStack => TRIAL_STACKS.some((s) => s === value);
const isProbe = (value: unknown): value is ProbeOutcome => Object.values(ProbeOutcome).some((p) => p === value);

function buildOutput(value: unknown): BuildOutput {
  requireShape(isRecord(value), "turn.build");
  const build = value as Record<string, unknown>;
  requireShape(typeof build.stdout === "string" && typeof build.stderr === "string", "turn.build output");
  requireShape(Number.isInteger(build.exitCode), "turn.build.exitCode");
  return { stdout: String(build.stdout), stderr: String(build.stderr), exitCode: Number(build.exitCode) };
}

function transcriptOf(value: unknown): AttemptTranscript {
  requireShape(isRecord(value), "transcript");
  const t = value as Record<string, unknown>;
  requireShape(isStack(t.stack) && typeof t.ask === "string" && Array.isArray(t.turns), "transcript fields");
  requireShape(isProbe(t.probe), "transcript.probe");
  const warm = t.warmRebuildMs === null ? null : Number(t.warmRebuildMs);
  requireShape(warm === null || (Number.isFinite(warm) && warm >= 0), "transcript.warmRebuildMs");
  const turns = (t.turns as unknown[]).map((turn) => {
    requireShape(isRecord(turn), "turn");
    const prompt = (turn as Record<string, unknown>).prompt;
    return {
      prompt: typeof prompt === "string" ? prompt : "",
      build: buildOutput((turn as Record<string, unknown>).build),
    };
  });
  return {
    stack: t.stack as TrialStack,
    ask: String(t.ask),
    turns,
    warmRebuildMs: warm,
    probe: t.probe as ProbeOutcome,
  };
}

/** The stub provider's transcripts, checked. */
export async function loadTranscripts(file: string): Promise<AttemptTranscript[]> {
  const doc: unknown = JSON.parse(await readFile(file, "utf8"));
  requireShape(isRecord(doc) && doc.schema === TRANSCRIPTS_SCHEMA, `${file}: schema is not ${TRANSCRIPTS_SCHEMA}`);
  const list = (doc as Record<string, unknown>).transcripts;
  requireShape(Array.isArray(list), "transcripts");
  return (list as unknown[]).map(transcriptOf);
}

/** Replays fixture transcripts; an ask with no transcript is an input error. */
function stubProvider(transcripts: AttemptTranscript[]): TrialProvider {
  return {
    attempt: async (stack, ask) => {
      const found = transcripts.find((t) => t.stack === stack && t.ask === ask.id);
      if (!found) throw new InputError(`no fixture transcript for ${stack}/${ask.id}`);
      return found;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Authorization

type Authorization = { ok: true; cap: number } | { ok: false; refusal: TrialRefusal };

/** The owner's attempt cap from the environment, or why there is none. */
export function authorize(env: NodeJS.ProcessEnv): Authorization {
  const value = env[TRIAL_AUTHORIZATION_VAR];
  if (value === undefined || value === "") {
    const detail = `${TRIAL_AUTHORIZATION_VAR} is not set: a live run is a paid owner gate (M0a.14)`;
    return { ok: false, refusal: { code: TrialRefusalCode.AuthorizationMissing, detail } };
  }
  const cap = ATTEMPT_CAP.test(value) ? Number(value) : Number.NaN;
  if (!(cap >= 1 && cap <= MAX_ATTEMPT_CAP)) {
    const detail = `${TRIAL_AUTHORIZATION_VAR} must be an attempt cap from 1 to ${MAX_ATTEMPT_CAP}`;
    return { ok: false, refusal: { code: TrialRefusalCode.AuthorizationInvalid, detail } };
  }
  return { ok: true, cap };
}

const isDirectory = (dir: string) => existsSync(dir) && statSync(dir).isDirectory();

/** A path's real location; the path itself when it does not exist. */
function realOrSelf(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * Whether `target` is the user's games folder or inside it, both by their real paths (a link to
 * `~/AI Games` is inside it): the trial only ever edits copies.
 */
function inUserGames(target: string): boolean {
  const games = realOrSelf(path.join(os.homedir(), "AI Games"));
  const rel = path.relative(games, realOrSelf(target));
  return rel === "" || !(rel.startsWith("..") || path.isAbsolute(rel));
}

/** The first symbolic link under `dir` (build products and history skipped), or null. */
function firstSymlink(dir: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) return full;
    if (!entry.isDirectory() || WORK_COPY_SKIPPED.has(entry.name)) continue;
    const below = firstSymlink(full);
    if (below) return below;
  }
  return null;
}

/** What a live run is missing, or null when it has it all. */
function livePrerequisiteGap(options: TrialOptions, stacks: readonly TrialStack[]): string | null {
  if (!PROFILE_SLUG.test(options.profile ?? "")) return "--profile must name an owned studio:dev live profile (a slug)";
  if (!MODEL_NAME.test(options.model ?? "")) return "--model must name the provider model";
  for (const stack of stacks) {
    const game = options.games?.[stack];
    if (!game || !isDirectory(game)) return `--${stack}-game must be an existing folder`;
    if (inUserGames(game)) return `--${stack}-game must be a copy outside ~/AI Games`;
    const link = lstatSync(game).isSymbolicLink() ? game : firstSymlink(game);
    if (link) return `--${stack}-game must hold no symbolic links (${link})`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The run

const refused = (code: TrialRefusalCode, detail: string): TrialResult => ({ ok: false, refusal: { code, detail } });

async function gitBuildIdentity(): Promise<string | null> {
  const run = await runCommand({ argv: ["git", "rev-parse", "HEAD"], cwd: REPO, env: {} }, {}, SECOND_MS * 10);
  return run.exitCode === 0 ? run.stdout.trim() : null;
}

function defaultOut(mode: TrialMode): string {
  if (mode === TrialMode.DryRun) return DRY_RUN_OUT;
  return path.join(LIVE_OUT_ROOT, new Date().toISOString().replace(/[:.]/g, "-"));
}

/** The provider for a run that passed every check; live is only built here. */
async function providerFor(options: TrialOptions, deps: TrialDeps, ctx: LiveContext): Promise<TrialProvider> {
  if (options.mode === TrialMode.DryRun) {
    return stubProvider(await loadTranscripts(options.transcriptsFile ?? DEFAULT_TRANSCRIPTS_FILE));
  }
  return (deps.liveProvider ?? systemLiveProvider)(ctx);
}

async function writeReport(out: string, report: TrialReport): Promise<void> {
  await writeFile(path.join(out, "trial.json"), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(path.join(out, "comparison.md"), comparisonMarkdown(report));
}

/** Every attempt in order, each written as it arrives so a run that stops keeps what it paid for. */
async function collectTranscripts(
  provider: TrialProvider,
  stacks: readonly TrialStack[],
  asks: FacetAsk[],
  out: string,
) {
  const file = path.join(out, "transcripts.jsonl");
  await mkdir(out, { recursive: true });
  await writeFile(file, "");
  const transcripts: AttemptTranscript[] = [];
  for (const stack of stacks) {
    for (const ask of asks) {
      const transcript = await provider.attempt(stack, ask);
      transcripts.push(transcript);
      await appendFile(file, `${JSON.stringify(transcript)}\n`);
    }
  }
  return transcripts;
}

/** The attempt cap a run may use, or why it may not start; nothing is built or written here. */
function admit(options: TrialOptions, stacks: readonly TrialStack[]): Authorization {
  if (options.mode !== TrialMode.Live) return { ok: true, cap: MAX_ATTEMPT_CAP };
  const authorization = authorize(options.env);
  if (!authorization.ok) return authorization;
  const gap = livePrerequisiteGap(options, stacks);
  if (!gap) return authorization;
  return { ok: false, refusal: { code: TrialRefusalCode.LivePrerequisiteMissing, detail: gap } };
}

async function identityOf(options: TrialOptions, deps: TrialDeps): Promise<TrialIdentity> {
  const build = await (deps.buildIdentity ?? gitBuildIdentity)();
  if (options.mode === TrialMode.DryRun) return { provider: "stub", model: null, profile: null, build };
  return { provider: EngineId.ClaudeCode, model: options.model ?? null, profile: options.profile ?? null, build };
}

/** An admitted run: every ask (up to the cap) on every stack, scored and written. */
async function execute(options: TrialOptions, deps: TrialDeps, stacks: readonly TrialStack[], cap: number) {
  const asks = await loadAsks(options.asksFile ?? DEFAULT_ASKS_FILE);
  const out = path.resolve(options.out ?? defaultOut(options.mode));
  const attemptCap = Math.min(cap, asks.asks.length);
  const ctx: LiveContext = {
    out,
    asks,
    profile: options.profile ?? "",
    model: options.model ?? "",
    games: options.games ?? {},
    attemptCap,
  };
  const provider = await providerFor(options, deps, ctx);
  const transcripts = await collectTranscripts(provider, stacks, asks.asks.slice(0, attemptCap), out);
  const attempts = transcripts.map((t) => scoreAttempt(t, asks.maxRepairTurns));
  const report: TrialReport = {
    schema: REPORT_SCHEMA,
    mode: options.mode,
    identity: await identityOf(options, deps),
    attemptCap,
    maxRepairTurns: asks.maxRepairTurns,
    attempts,
    ...summarizeTrial(attempts),
  };
  await writeReport(out, report);
  return { ok: true as const, report, out };
}

/** Checks, then runs every ask (up to the cap) on every stack and writes the report. */
export async function runTrial(options: TrialOptions, deps: TrialDeps = {}): Promise<TrialResult> {
  const stacks = options.stacks ?? TRIAL_STACKS;
  const admitted = admit(options, stacks);
  if (!admitted.ok) return { ok: false, refusal: admitted.refusal };
  try {
    return await execute(options, deps, stacks, admitted.cap);
  } catch (error) {
    if (error instanceof LiveSetupError) return refused(TrialRefusalCode.LivePrerequisiteMissing, error.message);
    if (error instanceof InputError || error instanceof SyntaxError) {
      return refused(TrialRefusalCode.InputInvalid, error.message);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// The live provider (paid; reached only through runTrial after authorization)

/** A command line's `{repo}`, `{game}`, `{buildDir}`, `{webOut}` and `{targetDir}` values. */
export type Vars = Record<string, string>;

const expand = (text: string, vars: Vars) => text.replace(/\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole);

/** A stack command's environment: the sandbox allow-list over `parent`, then the spec's own values. */
function commandEnv(parent: NodeJS.ProcessEnv, spec: CommandSpec, vars: Vars): Record<string, string> {
  const set: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.env)) set[key] = expand(value, vars);
  if (vars.targetDir) set.CARGO_TARGET_DIR = vars.targetDir;
  return childEnv(parent, { base: "sandbox", set });
}

/** Runs one host command (the build identity) with no shell; never throws for a failed command. */
function runCommand(spec: CommandSpec, vars: Vars, timeoutMs: number): Promise<BuildOutput> {
  const [file = "", ...args] = spec.argv.map((a) => expand(a, vars));
  const env = commandEnv(process.env, spec, vars);
  const options = { cwd: expand(spec.cwd, vars), env, timeout: timeoutMs, maxBuffer: OUTPUT_MAX_BYTES };
  return new Promise((resolve) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      const failed = error ? 1 : 0;
      const exitCode = error && typeof error.code === "number" ? error.code : failed;
      resolve({ stdout: String(stdout), stderr: String(stderr), exitCode });
    });
  });
}

/** The first ask: the stack's preamble, then the facet ask itself (identical across stacks). */
export const firstPrompt = (spec: StackSpec, ask: FacetAsk) => `${spec.preamble}\n\n${ask.text}`;

/** A repair ask quoting the build's located errors (or its tail when it had none). */
export function repairPrompt(template: string, parsed: ParsedBuild, build: BuildOutput): string {
  const located = parsed.diagnostics
    .slice(0, REPAIR_DIAGNOSTICS)
    .map((d) => `${d.file}:${d.line}:${d.column}: error${d.code ? `[${d.code}]` : ""}: ${d.message}`);
  const tail = linesOf(`${build.stdout}\n${build.stderr}`)
    .filter((l) => l.trim())
    .slice(-REPAIR_DIAGNOSTICS);
  const quoted = located.length ? located : tail.map((l) => clipped(l.replace(ANSI_ESCAPE, "")));
  return template.replace("{diagnostics}", quoted.join("\n"));
}

/** Runs one stack command (configure, build, web); the live run's runs it inside `ProcessSandbox`. */
export type CommandRunner = (spec: CommandSpec, vars: Vars, timeoutMs: number) => Promise<BuildOutput>;

/** One agent turn in the work copy; it throws when the provider did not finish the turn. */
export type AgentTurn = (cwd: string, prompt: string, continued: boolean, log: string) => Promise<void>;

/** What a live attempt is run with. */
export interface LiveParts {
  ctx: LiveContext;
  turn: AgentTurn;
  run: CommandRunner;
  probeDeps: ProbeDeps;
}

/** The web prober and its loopback server. */
export interface ProbeDeps {
  probe: (url: string, evidenceDir: string) => Promise<ProbeOutcome>;
  serve: (root: string) => Promise<{ url: string; close(): Promise<void> }>;
}

/**
 * The coding CLI's environment: the app's contractor filter for Claude Code (every credential
 * variable and the other vendor's dropped) over the parent minus the eval-stripped variables, the
 * SSH agent and `CLAUDE_CONFIG_DIR`, with the auto-updater off. A fresh-machine profile's own
 * HOME replaces the operator's.
 */
export function trialChildEnv(
  parent: NodeJS.ProcessEnv,
  stripped: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv,
  profileHome: string | null,
): Record<string, string> {
  const base = stripped(parent);
  for (const name of TRIAL_DROPPED_ENV) delete base[name];
  delete base[TRIAL_AUTHORIZATION_VAR];
  const env = childEnv(base, { base: "contractor", vendor: "claude", set: { DISABLE_AUTOUPDATER: "1" } });
  if (profileHome) env.HOME = profileHome;
  return env;
}

/** One agent turn through the provider CLI in the work copy; its stream is kept as evidence. */
export async function agentTurn(cli: string, env: Record<string, string>, model: string, turn: Parameters<AgentTurn>) {
  const [cwd, prompt, continued, log] = turn;
  const { assertNoBannedArgv } = await import("../../evals/lanes/argv.ts");
  const { PermissionMode } = await import("../../../src/shared/permissions.ts");
  const argv = assertNoBannedArgv([
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    "--permission-mode",
    PermissionMode.AcceptEdits,
    ...(continued ? ["--continue"] : []),
    prompt,
  ]);
  const run = await new Promise<BuildOutput>((resolve) => {
    const options = { cwd, env, timeout: AGENT_TURN_TIMEOUT_MS, maxBuffer: OUTPUT_MAX_BYTES };
    const child = execFile(cli, [...argv], options, (error, stdout, stderr) => {
      const failed = error ? 1 : 0;
      const exitCode = error && typeof error.code === "number" ? error.code : failed;
      resolve({ stdout: String(stdout), stderr: String(stderr), exitCode });
    });
    // The prompt is an argument: an open stdin only makes the CLI wait for input that never comes.
    child.stdin?.end();
  });
  await mkdir(path.dirname(log), { recursive: true });
  await writeFile(log, run.stdout);
  if (run.stderr) await writeFile(`${log}.stderr`, run.stderr);
  // A turn the provider did not finish would leave the copy as it was and score a free green build.
  if (run.exitCode !== 0) throw new Error(`agent turn failed with exit ${run.exitCode}; its stream is ${log}`);
}

/** A fresh copy of the game for one ask, without build products or history. */
async function workCopy(ctx: LiveContext, stack: TrialStack, askId: string): Promise<string> {
  const source = ctx.games[stack] ?? "";
  const dest = path.join(ctx.out, "work", stack, askId);
  // The source holds no symbolic link (`livePrerequisiteGap`), so the copy holds none either.
  await cp(source, dest, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (from) => !WORK_COPY_SKIPPED.has(path.basename(from)) || from === source,
  });
  return dest;
}

/** Every file under `dir` (relative, `/`-separated) with its bytes; links are reported, never followed. */
async function treeOf(dir: string, top = dir, out = new Map<string, Buffer | null>()) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(top, full).split(path.sep).join("/");
    if (dir === top && (WORK_COPY_SKIPPED.has(entry.name) || entry.name === CLI_STATE_DIR)) continue;
    if (entry.isSymbolicLink()) out.set(rel, null);
    else if (entry.isDirectory()) await treeOf(full, top, out);
    else if (entry.isFile()) out.set(rel, await readFile(full));
  }
  return out;
}

const segments = (rel: string) => rel.split("/");
const under = (rel: string, folders: readonly string[]) => folders.some((folder) => rel.startsWith(folder));

/** The first rule a changed path breaks, or null. */
function changedPathRefusal(rel: string, stack: TrialStack, editable: readonly string[], now: Buffer | null) {
  const name = segments(rel).at(-1) ?? "";
  if (segments(rel).includes(CARGO_CONFIG_DIR)) return { code: TurnScopeCode.CargoConfig, detail: rel };
  if (MANIFEST_NAMES.has(name)) return { code: TurnScopeCode.Manifest, detail: rel };
  if (name === BUILD_SCRIPT_NAME) return { code: TurnScopeCode.BuildScript, detail: rel };
  if (!under(rel, editable)) return { code: TurnScopeCode.OutsideEditable, detail: rel };
  const rust = stack === TrialStack.Rust && rel.endsWith(".rs");
  if (rust && now && UNSAFE_TOKEN.test(now.toString("utf8"))) return { code: TurnScopeCode.UnsafeCode, detail: rel };
  return null;
}

/**
 * Whether an agent turn kept to its scope: `work` against the `source` it was copied from. Nothing
 * is built for a refused turn (see `TurnScopeCode`).
 */
export async function checkTurnScope(
  source: string,
  work: string,
  stack: TrialStack,
  editable: readonly string[],
): Promise<ScopeRefusal | null> {
  if ((await lstat(work)).isSymbolicLink()) return { code: TurnScopeCode.Symlink, detail: "." };
  const [before, after] = await Promise.all([treeOf(source), treeOf(work)]);
  for (const [rel, bytes] of after) {
    if (bytes === null) return { code: TurnScopeCode.Symlink, detail: rel };
  }
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  for (const rel of paths) {
    const was = before.get(rel);
    const now = after.get(rel) ?? null;
    const same = was !== undefined && now !== null && was !== null && was.equals(now);
    if (same) continue;
    const refusal = changedPathRefusal(rel, stack, editable, now);
    if (refusal) return refusal;
  }
  return null;
}

/** The record of a turn whose build never ran: its refusal stands where the build output would. */
function scopeRefusedBuild(refusal: ScopeRefusal): BuildOutput {
  return {
    stdout: "",
    stderr: `turn refused before the build: ${JSON.stringify(refusal)}`,
    exitCode: SCOPE_REFUSED_EXIT,
  };
}

/** A warm rebuild+link: touch one source file of a green build and build again, timed. */
async function warmRebuildMs(run: CommandRunner, spec: StackSpec, vars: Vars, work: string): Promise<number | null> {
  const now = new Date();
  await utimes(path.join(work, spec.touch), now, now);
  const started = performance.now();
  const build = await run(spec.build, vars, BUILD_TIMEOUT_MS);
  return build.exitCode === 0 ? Math.round(performance.now() - started) : null;
}

/** The stack's web build, served from loopback and run through the quick prober. */
async function probeWeb(parts: LiveParts, spec: StackSpec, vars: Vars): Promise<ProbeOutcome> {
  if (!spec.web) return ProbeOutcome.NotRun;
  const web = await parts.run(spec.web, vars, BUILD_TIMEOUT_MS);
  const webOut = vars.webOut ?? "";
  if (web.exitCode !== 0 || !existsSync(path.join(webOut, "index.html"))) return ProbeOutcome.Fail;
  const served = await parts.probeDeps.serve(webOut);
  try {
    return await parts.probeDeps.probe(served.url, path.join(webOut, "..", `${path.basename(webOut)}-probe`));
  } finally {
    await served.close();
  }
}

/**
 * Runs the stack's configure step; a failure throws (the run is refused) before any paid turn,
 * which could only be spent repairing build errors no source edit fixes.
 */
async function configureOrRefuse(run: CommandRunner, configure: CommandSpec, vars: Vars): Promise<void> {
  const result = await run(configure, vars, BUILD_TIMEOUT_MS);
  if (result.exitCode === 0) return;
  const tail = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .filter((line) => line.trim())
    .slice(-CONFIGURE_TAIL_LINES)
    .map((line) => clipped(line.replace(ANSI_ESCAPE, "")));
  throw new LiveSetupError(`configure failed (exit ${result.exitCode}) before any agent turn: ${tail.join(" | ")}`);
}

/**
 * One live attempt: a fresh copy, then agent turns while the build is red and repair turns remain.
 * After each turn its scope is checked first; a refused turn ends the attempt with nothing built.
 */
export async function liveAttempt(parts: LiveParts, stack: TrialStack, ask: FacetAsk): Promise<AttemptTranscript> {
  const { ctx } = parts;
  const spec = ctx.asks.stacks[stack];
  const work = await workCopy(ctx, stack, ask.id);
  const vars: Vars = {
    repo: REPO,
    game: work,
    buildDir: path.join(ctx.out, "build", stack, ask.id),
    webOut: path.join(ctx.out, "web", stack, ask.id),
    targetDir: path.join(ctx.out, "target", stack),
  };
  if (spec.configure) await configureOrRefuse(parts.run, spec.configure, vars);
  const turns: TurnRecord[] = [];
  let prompt = firstPrompt(spec, ask);
  for (let turn = 0; turn <= ctx.asks.maxRepairTurns; turn += 1) {
    const log = path.join(ctx.out, "agent", `${stack}-${ask.id}-${turn}.jsonl`);
    await parts.turn(work, prompt, turn > 0, log);
    const scope = await checkTurnScope(ctx.games[stack] ?? "", work, stack, spec.editable);
    if (scope) {
      turns.push({ prompt, build: scopeRefusedBuild(scope) });
      return { stack, ask: ask.id, turns, warmRebuildMs: null, probe: ProbeOutcome.NotRun, scopeRefusal: scope };
    }
    const build = await parts.run(spec.build, vars, BUILD_TIMEOUT_MS);
    turns.push({ prompt, build });
    const parsed = parseBuild(stack, build);
    if (parsed.ok) {
      const warm = await warmRebuildMs(parts.run, spec, vars, work);
      return { stack, ask: ask.id, turns, warmRebuildMs: warm, probe: await probeWeb(parts, spec, vars) };
    }
    prompt = repairPrompt(ctx.asks.repairTemplate, parsed, build);
  }
  return { stack, ask: ask.id, turns, warmRebuildMs: null, probe: ProbeOutcome.NotRun };
}

/**
 * The web prober's lock: the evals home's machine-wide one when `$GENEX_EVALS_HOME` is set, else
 * one in the run's own folder, so a run without an evals home probes instead of throwing after
 * its first paid turn. A relative `$GENEX_EVALS_HOME` throws here, during setup.
 */
export function trialProbeLockPath(env: Readonly<Record<string, string | undefined>>, out: string): string {
  return configuredEvalsHome(env) === null ? path.join(out, ...TRIAL_PROBE_LOCK) : probeLockPath(env);
}

/** The prober and loopback server of the eval tooling, loaded only for a live run. */
async function systemProbeDeps(ctx: LiveContext): Promise<ProbeDeps> {
  const lockPath = trialProbeLockPath(process.env, ctx.out);
  const { runQuickProbe } = await import("../../evals/grade/quick-probe.ts");
  const { startStaticServer } = await import("../../evals/grade/serve.ts");
  const { CheckResult, RendererMode, ServedVia } = await import("../../evals/vocabulary.ts");
  return {
    serve: (root) => startStaticServer({ root, vendorDir: null, servedVia: ServedVia.AsIs }),
    probe: async (url, evidenceDir) => {
      await mkdir(evidenceDir, { recursive: true });
      const options = {
        firstDrawTimeoutMs: PROBE_FIRST_DRAW_MS,
        rendererMode: RendererMode.Gpu,
        noErrorsMs: PROBE_NO_ERRORS_MS,
        evidenceDir,
      };
      const result = await runQuickProbe(url, options, { lockPath });
      return result.l1Gate === CheckResult.Pass ? ProbeOutcome.Pass : ProbeOutcome.Fail;
    },
  };
}

/** One setup step; its failure becomes a typed refusal instead of a crash. */
async function setupStep<T>(what: string, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw new LiveSetupError(`${what}: ${(error as Error).message}`);
  }
}

/**
 * The stack commands' runner: each inside `ProcessSandbox`, with no network, writing only under
 * the run's folder and the spike's cargo home (cargo's package-cache lock), with the sandbox's
 * allow-listed environment; whatever a command leaves running in its group ends with it.
 */
async function sandboxRunner(ctx: LiveContext): Promise<CommandRunner> {
  const { ProcessSandbox } = await import("../../../src/substrate/spawn.ts");
  const cargoHome = path.join(REPO, ".studio-dev", "spike-toolchain", "cargo-home");
  const sandbox = await ProcessSandbox.create({
    writableRoots: [ctx.out, cargoHome],
    scratchDir: path.join(ctx.out, "scratch"),
    secretPaths: [],
  });
  return async (spec, vars, timeoutMs) => {
    const command = spec.argv.map((a) => shellQuote(expand(a, vars))).join(" ");
    const env = commandEnv(process.env, spec, vars);
    const cwd = expand(spec.cwd, vars);
    const result = await sandbox.run({
      command,
      cwd,
      env,
      timeoutMs,
      reapGroup: true,
      maxOutputBytes: OUTPUT_MAX_BYTES,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code ?? 1 };
  };
}

/**
 * The paid provider: checks the named profile is an owned `studio:dev` live profile of this
 * checkout, finds the Claude Code CLI the app would use, and runs each ask as described above.
 */
export async function systemLiveProvider(ctx: LiveContext): Promise<TrialProvider> {
  const { validateProfile } = await import("../../studio-dev/ownership.mjs");
  const owner = await setupStep(`profile ${ctx.profile}`, async () => validateProfile(REPO, ctx.profile));
  if (owner.providers !== "live") throw new LiveSetupError(`profile ${ctx.profile} is not a live studio:dev profile`);
  const { resolveLaneCli } = await import("../../evals/lanes/argv.ts");
  const { strippedEnv } = await import("../../evals/lanes/common.ts");
  const cli = await setupStep("the Claude Code CLI", () => resolveLaneCli(EngineId.ClaudeCode));
  const profileHome = owner.freshMachine === true && typeof owner.home === "string" ? owner.home : null;
  const env = trialChildEnv(process.env, strippedEnv, profileHome);
  const parts: LiveParts = {
    ctx,
    turn: (...turn) => agentTurn(cli.path, env, ctx.model, turn),
    run: await setupStep("the build sandbox", () => sandboxRunner(ctx)),
    probeDeps: await setupStep("the web prober's lock", () => systemProbeDeps(ctx)),
  };
  return { attempt: (stack, ask) => liveAttempt(parts, stack, ask) };
}

// ---------------------------------------------------------------------------------------------
// CLI

const USAGE =
  "Usage: authoring-trial.ts [--dry-run] [--out DIR] [--asks FILE] [--transcripts FILE]\n" +
  `       ${TRIAL_AUTHORIZATION_VAR}=<cap> authoring-trial.ts --live --profile SLUG --model MODEL --rust-game DIR --raylib-game DIR [--stack rust|raylib] [--out DIR]`;

const VALUE_FLAGS = new Set([
  "--out",
  "--asks",
  "--transcripts",
  "--profile",
  "--model",
  "--rust-game",
  "--raylib-game",
  "--stack",
]);
const SWITCHES = new Set(["--dry-run", "--live"]);

class UsageError extends Error {}

function flagValues(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (SWITCHES.has(arg)) {
      flags.set(arg, "");
      continue;
    }
    const value = argv[i + 1];
    if (!VALUE_FLAGS.has(arg) || value === undefined) throw new UsageError(`unexpected argument ${arg}`);
    flags.set(arg, value);
    i += 1;
  }
  return flags;
}

/** The CLI's options; the dry run is the default and `--live` is never implied. */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): TrialOptions {
  const flags = flagValues(argv);
  if (flags.has("--dry-run") && flags.has("--live")) throw new UsageError("--dry-run and --live exclude each other");
  const stack = flags.get("--stack");
  if (stack !== undefined && !isStack(stack)) throw new UsageError("--stack must be rust or raylib");
  const games: Partial<Record<TrialStack, string>> = {};
  for (const s of TRIAL_STACKS) {
    const game = flags.get(`--${s}-game`);
    if (game) games[s] = path.resolve(game);
  }
  return {
    mode: flags.has("--live") ? TrialMode.Live : TrialMode.DryRun,
    env,
    out: flags.get("--out"),
    asksFile: flags.get("--asks"),
    transcriptsFile: flags.get("--transcripts"),
    profile: flags.get("--profile"),
    model: flags.get("--model"),
    games,
    stacks: stack ? [stack] : undefined,
  };
}

async function main(): Promise<number> {
  let options: TrialOptions;
  try {
    options = parseArgs(process.argv.slice(2), process.env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n${USAGE}\n`);
    return USAGE_EXIT;
  }
  const result = await runTrial(options);
  if (!result.ok) {
    process.stderr.write(`${REFUSAL_PREFIX}${JSON.stringify(result.refusal)}\n`);
    return REFUSAL_EXIT;
  }
  process.stdout.write(`${comparisonMarkdown(result.report)}\nWritten to ${result.out}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
