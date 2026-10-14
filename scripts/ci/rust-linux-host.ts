/**
 * The Rust · wgpu runtime's Linux CI rows (M4.4). The workflows (`rust-linux-host.yml`, the
 * `rust-linux` job of `native-destinations.yml`, `linux-userns.yml`, `release.yml`) only install what
 * a row needs and call `node scripts/ci/rust-linux-host.ts --step <id>`; every check lives here so
 * `tests/conformance/rust-linux-host-ci.test.ts` can drive it on any host.
 *
 *   node scripts/ci/rust-linux-host.ts --table                       the step and workflow tables as JSON
 *   node scripts/ci/rust-linux-host.ts --check-workflow <file>       the workflow calls its steps once, in order
 *   node scripts/ci/rust-linux-host.ts --check-windows <file>        windows.yml's Rust WARP row is gated and ordered
 *   node scripts/ci/rust-linux-host.ts --step <id> [flags]           one CI step (typed refusal, exit 1, on failure)
 *
 * Flags: `--resources <dir>` (a built app's `dist/resources`, or an extracted .deb's
 * `usr/lib/genex/resources/app.asar.unpacked/dist/resources`), `--templates <dir>` (the folder holding
 * `game-template` and `game-template-rust`: the repository's `src` or the same resources folder),
 * `--pond <binary>` (the Rust game's dev-flavour build), `--bundle <dir>` (the run bundle),
 * `--evidence <dir>` (records, default `.studio-dev/evidence/rust-linux-host`).
 *
 * Every step writes `<evidence>/<id>.json`; a failure prints one typed line on stderr and exits 1:
 *   genex-rust-linux-host: {"code":"<code>","detail":"<text>"}
 *
 * What the rows prove, and what they do not:
 * - `bundle-pins`: the ANGLE builds, the SwiftShader split and the Linux sysroot a package carries are
 *   the bytes `native/angle/bundle-lock.json` and the sysroot lock pin (the app's own verifiers).
 * - `fixture-creation`: the Rust template a package ships scaffolds a Rust game through the product's
 *   own workspace (fixture engines: no provider is involved).
 * - `assemble-bundle` + `headless-box`: a Rust game's dev-flavour build, with the package's verified
 *   SwiftShader beside it, runs headless inside the product's Linux game box (bubblewrap, seccomp, no
 *   network, no display) and answers `ready` with a tier-core Vulkan receipt over a software adapter and
 *   a capture that drew something. The game here is the spike's pond built on the runner; the Studio
 *   lane's own Linux build (cargo-zigbuild, the sysroot) has no CI row yet and runs on a developer's
 *   machine through `tests/conformance/rust-linux-lane.test.ts`.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import { NativeBackend, NativeGpuTier, NativeOp, NativeRunMode } from "../../src/shared/native-contract.ts";
import { GameWorkspaces } from "../../src/substrate/game-workspace.ts";
import {
  BUBBLEWRAP_MIN_VERSION,
  bubblewrapSupported,
  LinuxBoxAudio,
  launchLinuxGameBox,
} from "../../src/substrate/linux-game-box.ts";
import { fnv1a64Hex, NativeGamePort } from "../../src/substrate/native-game-port.ts";
import { LinuxVulkanFile } from "../../src/substrate/native-runtime-files.ts";
import type { GameChild, GameExit } from "../../src/substrate/spawn.ts";
import {
  ANGLE_TARGETS,
  BUNDLE_LOCK,
  type BundleCheck,
  verifyAngleBundle,
} from "../../src/substrate/toolchain-store/bundled.ts";
import {
  bundledLinuxSysrootFolder,
  LINUX_SYSROOT_BUNDLE_PIN,
  verifyLinuxSysrootFolder,
} from "../../src/substrate/toolchain-store/linux-sysroot-bundle.ts";
import {
  bundledSwiftShaderFolder,
  readSwiftShaderRuntime,
  type SwiftShaderRuntime,
} from "../../src/substrate/toolchain-store/swiftshader-bundle.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const FORMAT = "genex-rust-linux-host/1";
const REFUSAL_PREFIX = "genex-rust-linux-host: ";
const FAIL_EXIT = 1;
const DEFAULT_EVIDENCE = path.join(REPO, ".studio-dev", "evidence", "rust-linux-host");

const READY_WAIT_MS = SECOND_MS * 90;
const STEP_TIMEOUT_MS = 10 * MINUTE_MS;
const BWRAP_DEFAULT = "/usr/bin/bwrap";
/** How long `bwrap --version` may take. */
const BWRAP_VERSION_WAIT_MS = SECOND_MS * 10;
/** The last stderr lines (the game's and bubblewrap's own) a failed box row keeps, each cut to a width. */
const STDERR_TAIL_LINES = 20;
const STDERR_LINE_CHARS = 80;
/**
 * The script that builds the pinned bubblewrap the box needs (0.8 or later: `--disable-userns`) and
 * points `GENEX_BWRAP` at it. Ubuntu 22.04's own bubblewrap is 0.6.1, so a job that runs the box
 * calls it before the box row.
 */
export const BOX_BUBBLEWRAP_SETUP = "scripts/ci/setup-bubblewrap.sh";
/** A capture with fewer distinct colours than this is blank (a clear and nothing drawn). */
const NONBLANK_MIN_COLOURS = 16;
const BOX_NONCE = "n0nce-ci-rust-0001";
const FIXTURE_TITLE = "Rust fixture";
const FIXTURE_TARGETS = [BuildTarget.Web, BuildTarget.Linux];
const BUNDLE_GAME = "game";
const STAGING_SUFFIX = ".staging";

/** The software adapters the row accepts: SwiftShader (the package's), lavapipe (llvmpipe). */
const SOFTWARE_ADAPTER = /swiftshader|llvmpipe|lavapipe|softpipe/i;

/** How a step run ended, in its evidence record (wire values). */
export const StepStatus = { Pass: "pass", Fail: "fail" } as const;
export type StepStatus = (typeof StepStatus)[keyof typeof StepStatus];

/** The refusal codes this script prints (wire values). */
export const RustLinuxHostCode = {
  Usage: "usage",
  UnknownStep: "unknown-step",
  WorkflowDrift: "workflow-drift",
  ToolMissing: "tool-missing",
  StepFailed: "step-failed",
  BadRecord: "bad-record",
  BlankCapture: "blank-capture",
  DigestMismatch: "digest-mismatch",
  NotCoreTier: "not-core-tier",
  WrongBackend: "wrong-backend",
  NotSoftwareAdapter: "not-software-adapter",
  BundlePinRefused: "bundle-pin-refused",
  FixtureRefused: "fixture-refused",
  BoxRefused: "box-refused",
} as const;
export type RustLinuxHostCode = (typeof RustLinuxHostCode)[keyof typeof RustLinuxHostCode];

/** A typed failure of a step. */
export class RustLinuxHostError extends Error {
  code: RustLinuxHostCode;
  detail: string;

  constructor(code: RustLinuxHostCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "RustLinuxHostError";
    this.code = code;
    this.detail = detail;
  }
}

function fail(code: RustLinuxHostCode, detail: string): never {
  throw new RustLinuxHostError(code, detail);
}

/** Step ids (wire values: the workflow's `--step` argument and the record file names). */
export const StepId = {
  BundlePins: "bundle-pins",
  FixtureCreation: "fixture-creation",
  AssembleBundle: "assemble-bundle",
  HeadlessBox: "headless-box",
} as const;
export type StepId = (typeof StepId)[keyof typeof StepId];

/** One row of the step table. */
export interface StepSpec {
  id: StepId;
  title: string;
  /** The flags the step needs, besides `--evidence`. */
  needs: readonly string[];
}

/** The rows, in run order. */
export const STEP_TABLE: readonly StepSpec[] = [
  {
    id: StepId.BundlePins,
    title: "The ANGLE builds, the SwiftShader split and the Linux sysroot a package carries are the pinned bytes",
    needs: ["--resources"],
  },
  {
    id: StepId.FixtureCreation,
    title: "A Rust game is scaffolded from the template a package ships, through the product's own workspace",
    needs: ["--templates"],
  },
  {
    id: StepId.AssembleBundle,
    title: "A Rust game's dev-flavour build and the package's verified SwiftShader become one run bundle",
    needs: ["--resources", "--pond", "--bundle"],
  },
  {
    id: StepId.HeadlessBox,
    title: "The bundle runs headless in the Linux game box: tier core on a software Vulkan adapter, a drawn capture",
    needs: ["--bundle"],
  },
];

/** A workflow file's Rust row: the job that runs the steps, in order, and any other command it must run once. */
export interface WorkflowRow {
  file: string;
  job: string;
  steps: readonly StepId[];
  /** Commands (substrings of a `run:`) the job must also run exactly once. */
  external: readonly string[];
}

/** Where each workflow calls this script. */
export const WORKFLOW_ROWS: readonly WorkflowRow[] = [
  {
    file: "rust-linux-host.yml",
    job: "deb",
    steps: [StepId.BundlePins, StepId.FixtureCreation, StepId.AssembleBundle, StepId.HeadlessBox],
    external: [BOX_BUBBLEWRAP_SETUP, "tests/e2e/run-rust-packaged-ui.mjs"],
  },
  {
    file: "native-destinations.yml",
    job: "rust-linux",
    steps: [StepId.BundlePins, StepId.AssembleBundle, StepId.HeadlessBox],
    external: [BOX_BUBBLEWRAP_SETUP],
  },
  { file: "linux-userns.yml", job: "ubuntu-24-04", steps: [StepId.BundlePins], external: [] },
  { file: "release.yml", job: "linux", steps: [StepId.BundlePins], external: [] },
];

// ---- pure checks ----------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** FNV-1a 64 of bytes, 16 hex digits (the capture digest the renderer writes). */
export const fnv1a64 = (bytes: Uint8Array): string => fnv1a64Hex(bytes);

/** Distinct colours (alpha ignored) of BGRA bytes, counting no further than `limit`. */
function distinctColours(bgra: Uint8Array, limit: number): number {
  const colours = new Set<number>();
  for (let i = 0; i + 2 < bgra.length && colours.size < limit; i += 4)
    colours.add(((bgra[i] ?? 0) << 16) | ((bgra[i + 1] ?? 0) << 8) | (bgra[i + 2] ?? 0));
  return colours.size;
}

/** The capability receipt of the box row: tier core, Vulkan, and a software adapter (the row proves the floor). */
export function checkBoxReceipt(receipt: unknown): void {
  if (!isObject(receipt)) fail(RustLinuxHostCode.BadRecord, "the ready event carried no capability receipt");
  const { tier, backend, adapter } = receipt;
  if (tier !== NativeGpuTier.Core) fail(RustLinuxHostCode.NotCoreTier, `the receipt says tier ${JSON.stringify(tier)}`);
  if (typeof adapter !== "string" || adapter === "") fail(RustLinuxHostCode.BadRecord, "the receipt names no adapter");
  if (backend !== NativeBackend.Vulkan)
    fail(RustLinuxHostCode.WrongBackend, `backend ${JSON.stringify(backend)} is not vulkan`);
  if (!SOFTWARE_ADAPTER.test(adapter))
    fail(RustLinuxHostCode.NotSoftwareAdapter, `adapter ${JSON.stringify(adapter)} is not a software rasteriser`);
}

/** The facts of a checked capture. */
export interface CaptureFacts {
  width: number;
  height: number;
  digest: string;
  colours: number;
}

/** A capture's bytes are width × height × 4, digest to what the game declared, and drew something. */
export function checkBoxCapture(
  shot: { width: number; height: number; digest: string },
  bytes: Uint8Array,
): CaptureFacts {
  const expected = shot.width * shot.height * 4;
  if (!Number.isInteger(expected) || expected <= 0 || bytes.length !== expected)
    fail(RustLinuxHostCode.BadRecord, `the capture is ${bytes.length} bytes, ${expected} expected`);
  const actual = fnv1a64(bytes);
  if (actual !== shot.digest)
    fail(RustLinuxHostCode.DigestMismatch, `the capture digests to ${actual}, the game declared ${shot.digest}`);
  const colours = distinctColours(bytes, NONBLANK_MIN_COLOURS);
  if (colours < NONBLANK_MIN_COLOURS)
    fail(RustLinuxHostCode.BlankCapture, `the capture has ${colours} distinct colours: nothing was drawn`);
  return { width: shot.width, height: shot.height, digest: actual, colours };
}

/** Every pinned ANGLE build verified once; a refused, missing or repeated one is named. */
export function judgeBundleChecks(checks: readonly BundleCheck[], expected: readonly string[]): void {
  const problems: string[] = [];
  for (const check of checks) if (!check.ok) problems.push(`${check.target}: ${check.fault}: ${check.detail}`);
  for (const target of expected) {
    const seen = checks.filter((check) => check.target === target).length;
    if (seen === 0) problems.push(`${target}: not checked`);
    if (seen > 1) problems.push(`${target}: checked ${seen} times`);
  }
  if (problems.length > 0) fail(RustLinuxHostCode.BundlePinRefused, problems.join("; "));
}

// ---- the workflow check ---------------------------------------------------------------------

/** One workflow step as the check reads it. */
export interface WorkflowStep {
  name: string;
  ifCondition: string | null;
  /** The text of its `run:`. */
  run: string;
}

/** A job of a workflow as the check reads it. */
export interface WorkflowJob {
  name: string;
  runsOn: string | null;
  ifCondition: string | null;
  needs: string | null;
  steps: WorkflowStep[];
}

const JOB_HEADER = /^ {2}([A-Za-z0-9_-]+):\s*$/;
const JOB_KEY = /^ {4}(runs-on|if|needs):\s*(.*?)\s*$/;
const STEP_ITEM = /^ {6}- /;
const STEP_KEY = /^ {6}(?:- | {2})([A-Za-z_-]+):\s*(.*?)\s*$/;
const BLOCK_SCALAR = /^[|>][-+]?$/;
/** A step condition that never skips a call the job reached (it only keeps cancelled runs out). */
const ALWAYS_REACHED = new Set(["", "!cancelled()", "always()"]);

const normalCondition = (condition: string | null) => (condition ?? "").replace(/\$\{\{|\}\}|\s/g, "");
const indentOf = (line: string) => line.length - line.trimStart().length;
const unquote = (value: string) => value.replace(/^(['"])(.*)\1$/, "$2");

interface Reader {
  jobs: WorkflowJob[];
  inJobs: boolean;
  step: { name: string; ifCondition: string | null; run: string[] } | null;
  /** The indentation a block-scalar `run:` continues beyond; -1 outside one. */
  runIndent: number;
}

function closeStep(reader: Reader): void {
  const job = reader.jobs.at(-1);
  if (job && reader.step)
    job.steps.push({
      name: reader.step.name,
      ifCondition: reader.step.ifCondition,
      run: reader.step.run.join("\n"),
    });
  reader.step = null;
}

function readStepLine(reader: Reader, line: string): void {
  const step = reader.step;
  const key = step ? STEP_KEY.exec(line) : null;
  if (!step || !key) return;
  const [, name, value] = key;
  if (name === "name") step.name = unquote(value ?? "");
  if (name === "if") step.ifCondition = value ?? "";
  if (name !== "run") return;
  if (BLOCK_SCALAR.test(value ?? "")) reader.runIndent = indentOf(line) + (line.trimStart().startsWith("- ") ? 2 : 0);
  else step.run.push(value ?? "");
}

/** A line of the `run:` block being read: taken into the step, true; the block ends at the first line that is not inside it. */
function takeRunLine(reader: Reader, line: string): boolean {
  if (reader.runIndent < 0) return false;
  if (line.trim() !== "" && indentOf(line) <= reader.runIndent) {
    reader.runIndent = -1;
    return false;
  }
  reader.step?.run.push(line);
  return true;
}

function readJobKey(job: WorkflowJob, line: string): void {
  const key = JOB_KEY.exec(line);
  if (!key) return;
  if (key[1] === "runs-on") job.runsOn = key[2] ?? null;
  if (key[1] === "if") job.ifCondition = key[2] ?? null;
  if (key[1] === "needs") job.needs = key[2] ?? null;
}

function readLine(reader: Reader, line: string): void {
  if (takeRunLine(reader, line) || line.trimStart().startsWith("#")) return;
  if (/^\S/.test(line)) reader.inJobs = line.startsWith("jobs:");
  if (!reader.inJobs) return;
  const header = JOB_HEADER.exec(line);
  if (header || STEP_ITEM.test(line)) closeStep(reader);
  if (header) {
    reader.jobs.push({ name: header[1] ?? "", runsOn: null, ifCondition: null, needs: null, steps: [] });
    return;
  }
  if (STEP_ITEM.test(line)) reader.step = { name: "", ifCondition: null, run: [] };
  const job = reader.jobs.at(-1);
  if (job && !reader.step) readJobKey(job, line);
  readStepLine(reader, line);
}

/** The jobs under `jobs:`, their `runs-on`, `if`, `needs` and steps (name, `if`, `run` text). */
export function workflowJobs(text: string): WorkflowJob[] {
  const reader: Reader = { jobs: [], inJobs: false, step: null, runIndent: -1 };
  for (const line of text.split("\n")) readLine(reader, line);
  closeStep(reader);
  return reader.jobs;
}

function callsOf(script: string, run: string): string[] {
  const pattern = new RegExp(`scripts/ci/${script}\\.ts --step ([A-Za-z0-9-]+)`, "g");
  return [...run.matchAll(pattern)].map((match) => match[1] ?? "");
}

function drift(detail: string): never {
  return fail(RustLinuxHostCode.WorkflowDrift, detail);
}

/** The calls of `script` a job makes, in order, each with the step's own `if:` normalised. */
function jobCalls(job: WorkflowJob, script: string): Array<{ id: string; condition: string }> {
  return job.steps.flatMap((step) =>
    callsOf(script, step.run).map((id) => ({ id, condition: normalCondition(step.ifCondition) })),
  );
}

/** The job's calls to this script are the row's steps, in order, known, and none can be skipped. */
function checkRowCalls(file: string, row: WorkflowRow, job: WorkflowJob): void {
  const known = new Set<string>(STEP_TABLE.map((step) => step.id));
  const calls = jobCalls(job, "rust-linux-host");
  for (const call of calls)
    if (!known.has(call.id)) fail(RustLinuxHostCode.UnknownStep, `${file} calls --step ${call.id}`);
  for (const call of calls)
    if (!ALWAYS_REACHED.has(call.condition))
      drift(`${file} calls --step ${call.id} under \`if: ${call.condition}\`, which can skip it`);
  if (calls.map((call) => call.id).join() !== row.steps.join())
    drift(
      `${file}'s ${row.job} job calls ${calls.map((call) => call.id).join(", ") || "nothing"}, the table says ${row.steps.join(", ")}`,
    );
}

/** Each external command runs exactly once in the job, unconditionally. */
function checkRowExternal(file: string, row: WorkflowRow, job: WorkflowJob): void {
  for (const command of row.external) {
    const seen = job.steps.filter((step) => step.run.includes(command));
    if (seen.length !== 1) drift(`${file}'s ${row.job} job runs ${command} ${seen.length} times, once is required`);
    if (!ALWAYS_REACHED.has(normalCondition(seen[0]?.ifCondition ?? null)))
      drift(`${file} runs ${command} under a condition that can skip it`);
  }
}

/** A job that runs the box builds the pinned bubblewrap first. */
function checkBoxPrerequisite(file: string, row: WorkflowRow, job: WorkflowJob): void {
  if (!row.steps.includes(StepId.HeadlessBox)) return;
  const setup = job.steps.findIndex((step) => step.run.includes(BOX_BUBBLEWRAP_SETUP));
  const box = job.steps.findIndex((step) => callsOf("rust-linux-host", step.run).includes(StepId.HeadlessBox));
  if (setup < 0 || setup > box) drift(`${file}'s ${row.job} job must run ${BOX_BUBBLEWRAP_SETUP} before the box`);
}

/** A workflow calls its row's steps once each, in the table's order, and no step-level `if:` can skip one. */
export function checkWorkflow(file: string, text: string): void {
  const row = WORKFLOW_ROWS.find((candidate) => candidate.file === file);
  if (!row) fail(RustLinuxHostCode.UnknownStep, `${file} is not a workflow the table names`);
  const job = workflowJobs(text).find((candidate) => candidate.name === row.job);
  if (!job) drift(`${file} has no ${row.job} job`);
  checkRowCalls(file, row, job);
  checkRowExternal(file, row, job);
  checkBoxPrerequisite(file, row, job);
}

/** The condition that starts windows.yml's Rust WARP row: an owner dispatch naming it, or the label. */
export const RUST_WARP_CONDITION =
  "(github.event_name=='workflow_dispatch'&&inputs.rust_warp)||(github.event_name=='pull_request'&&github.event.label.name=='windows-smoke')";
/** The existing gate steps aside for the Rust row's dispatch and for label events. */
export const WINDOWS_GATE_CONDITION = "!inputs.rust_warp&&github.event.action!='labeled'";
const WARP_BUILD = "rust-warp-build";
const WARP_RUN = "rust-warp";

/** The two jobs are gated, on the right runners, and the Windows one waits for the build. */
function checkWarpJobs(build: WorkflowJob, run: WorkflowJob): void {
  for (const job of [build, run])
    if (normalCondition(job.ifCondition) !== RUST_WARP_CONDITION)
      drift(`${job.name} must have \`if: ${RUST_WARP_CONDITION}\`, it has ${job.ifCondition ?? "no if"}`);
  if (!/^ubuntu-/.test(build.runsOn ?? ""))
    drift(`${WARP_BUILD} builds the gnullvm binary on Linux, not ${build.runsOn}`);
  if (!/^windows-/.test(run.runsOn ?? "")) drift(`${WARP_RUN} runs on a Windows runner, not ${run.runsOn}`);
  if ((run.needs ?? "").replace(/[\s[\]]/g, "") !== WARP_BUILD) drift(`${WARP_RUN} must need ${WARP_BUILD}`);
}

/** The build job makes the binary and its decoy once each; the Windows job runs the WARP step once. */
function checkWarpCalls(build: WorkflowJob, run: WorkflowJob): void {
  const built = jobCalls(build, "rust-spike").map((call) => call.id);
  for (const id of ["toolchain", "cross-builds"])
    if (built.filter((call) => call === id).length !== 1) drift(`${WARP_BUILD} must call rust-spike --step ${id} once`);
  const ran = jobCalls(run, "rust-spike");
  if (ran.length !== 1 || ran[0]?.id !== "windows-warp")
    drift(`${WARP_RUN} must call rust-spike --step windows-warp once`);
  if (!ALWAYS_REACHED.has(ran[0]?.condition ?? "")) drift(`${WARP_RUN}'s windows-warp step can be skipped`);
}

/**
 * windows.yml's Rust WARP row: billed, so it runs only on an owner dispatch (or the `windows-smoke`
 * label); a Linux job builds the gnullvm binary and its decoy `dxcompiler.dll` first, the Windows job
 * waits for it and runs rust-spike's `windows-warp` step (a D3D12 WARP adapter at tier core, FXC still the
 * compiler); the existing gate does not run beside it.
 */
export function checkWindowsWorkflow(text: string): void {
  const jobs = workflowJobs(text);
  const gate = jobs.find((job) => job.name === "windows");
  if (!gate || normalCondition(gate.ifCondition) !== WINDOWS_GATE_CONDITION)
    drift(`the windows job must have \`if: ${WINDOWS_GATE_CONDITION}\`, it has ${gate?.ifCondition ?? "no if"}`);
  const build = jobs.find((job) => job.name === WARP_BUILD);
  const run = jobs.find((job) => job.name === WARP_RUN);
  if (!build || !run) drift(`windows.yml needs the ${WARP_BUILD} and ${WARP_RUN} jobs`);
  checkWarpJobs(build, run);
  checkWarpCalls(build, run);
}

// ---- running things -------------------------------------------------------------------------

/** What a step run knows. */
interface Context {
  evidence: string;
  resources: string | null;
  templates: string | null;
  pond: string | null;
  bundle: string | null;
  env: NodeJS.ProcessEnv;
}

interface StepOutcome {
  facts: Record<string, unknown>;
}

const need = <T>(value: T | null, flag: string): T =>
  value ?? fail(RustLinuxHostCode.Usage, `${flag} is required for this step`);

async function lstatOrNull(file: string) {
  return lstat(file).catch(() => null);
}

/** Verifies every pin a package carries: the three ANGLE builds, the SwiftShader split and the Linux sysroot. */
async function stepBundlePins(ctx: Context): Promise<StepOutcome> {
  const resources = need(ctx.resources, "--resources");
  const checks = await verifyAngleBundle(resources);
  const sysroot = await verifyLinuxSysrootFolder(bundledLinuxSysrootFolder(resources)).then(
    (verified) => ({ ok: true as const, files: verified.manifest.files.length }),
    (error: unknown) => ({ ok: false as const, detail: error instanceof Error ? error.message : String(error) }),
  );
  const problems: string[] = [];
  try {
    judgeBundleChecks(checks, ANGLE_TARGETS);
  } catch (error) {
    problems.push(error instanceof RustLinuxHostError ? error.detail : String(error));
  }
  if (!sysroot.ok) problems.push(`linux sysroot: ${sysroot.detail}`);
  else if (sysroot.files !== LINUX_SYSROOT_BUNDLE_PIN.files)
    problems.push(`linux sysroot: ${sysroot.files} files, the pin says ${LINUX_SYSROOT_BUNDLE_PIN.files}`);
  if (problems.length > 0) fail(RustLinuxHostCode.BundlePinRefused, problems.join("; "));
  return {
    facts: {
      resources,
      angleCommit: BUNDLE_LOCK.commit,
      angle: checks,
      swiftshader: { pin: BUNDLE_LOCK.swiftshader?.manifestSha256 ?? null, verifiedWithLinuxBuild: true },
      sysroot: { pin: LINUX_SYSROOT_BUNDLE_PIN.manifestSha256, files: LINUX_SYSROOT_BUNDLE_PIN.files },
    },
  };
}

/** What the fixture creation reports. */
export interface FixtureFacts {
  dir: string;
  stack: string;
  title: string;
  targets: string[];
  files: string[];
}

function listFiles(root: string, rel = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...listFiles(root, next));
    else found.push(next);
  }
  return found.sort();
}

/**
 * Scaffolds the fixture Rust game (web and Linux) from a package's `game-template-rust` through the
 * product's workspace with its development gate open and no provider involved. A package without the
 * template is refused before anything is written.
 */
export async function createFixtureGame(options: {
  templateDir: string;
  rustTemplateDir: string;
  root: string;
}): Promise<FixtureFacts> {
  const manifest = await lstatOrNull(path.join(options.rustTemplateDir, "genex.toml"));
  if (!manifest?.isFile())
    return fail(RustLinuxHostCode.FixtureRefused, `${options.rustTemplateDir} holds no Rust template (genex.toml)`);
  const games = new GameWorkspaces({
    root: path.join(options.root, "games"),
    templateDir: options.templateDir,
    rustTemplateDir: options.rustTemplateDir,
    rustCreation: true,
    vendorDir: path.join(path.dirname(options.templateDir), "vendor"),
    indexFile: path.join(options.root, "projects.json"),
    userData: options.root,
    homeDir: options.root,
    platform: process.platform,
  });
  const game = await games
    .create(FIXTURE_TITLE, { stack: GameStack.RustWgpu, targets: FIXTURE_TARGETS })
    .catch((error: unknown) =>
      fail(RustLinuxHostCode.FixtureRefused, error instanceof Error ? error.message : String(error)),
    );
  const files = listFiles(game.dir);
  const toml = await readFile(path.join(game.dir, "genex.toml"), "utf8");
  if (toml.includes("__GAME_TITLE__"))
    fail(RustLinuxHostCode.FixtureRefused, "genex.toml still holds the title placeholder");
  if (!files.includes("src/main.rs")) fail(RustLinuxHostCode.FixtureRefused, "the scaffold has no src/main.rs");
  if (game.destinations?.stack !== GameStack.RustWgpu)
    fail(RustLinuxHostCode.FixtureRefused, `the game's stack is ${String(game.destinations?.stack)}`);
  return {
    dir: game.dir,
    stack: game.destinations.stack,
    title: game.title,
    targets: [...game.destinations.targets],
    files,
  };
}

async function stepFixtureCreation(ctx: Context): Promise<StepOutcome> {
  const templates = need(ctx.templates, "--templates");
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "genex-rust-fixture-")));
  try {
    const facts = await createFixtureGame({
      templateDir: path.join(templates, "game-template"),
      rustTemplateDir: path.join(templates, "game-template-rust"),
      root,
    });
    return { facts: { ...facts, dir: path.relative(root, facts.dir) } };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** The runtime files the bundle holds at its top, beside the game. */
const RUNTIME_FILES: ReadonlyArray<{ name: LinuxVulkanFile; mode: number }> = [
  { name: LinuxVulkanFile.VulkanLoader, mode: 0o755 },
  { name: LinuxVulkanFile.SwiftShader, mode: 0o755 },
  { name: LinuxVulkanFile.SwiftShaderIcd, mode: 0o644 },
];

/**
 * Makes the run bundle: the game (a plain executable, never a link) and the package's verified
 * SwiftShader runtime at its top. Every input is checked before anything is written; the bundle is
 * assembled beside its destination and renamed into place, and a refused request leaves nothing.
 */
export async function assembleBundle(request: {
  pond: string;
  out: string;
  runtime: SwiftShaderRuntime;
}): Promise<{ out: string; files: string[] }> {
  const pond = await lstatOrNull(request.pond);
  if (!pond) return fail(RustLinuxHostCode.ToolMissing, `the game binary is not at ${request.pond}`);
  if (!pond.isFile())
    fail(RustLinuxHostCode.BadRecord, `${request.pond} is not a plain file (links and folders are refused)`);
  if (await lstatOrNull(request.out)) fail(RustLinuxHostCode.BadRecord, `${request.out} already exists`);
  for (const { name } of RUNTIME_FILES)
    if (!request.runtime.files[name]) fail(RustLinuxHostCode.BundlePinRefused, `the SwiftShader runtime lacks ${name}`);
  const staging = `${request.out}${STAGING_SUFFIX}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await copyFile(request.pond, path.join(staging, BUNDLE_GAME));
    await chmod(path.join(staging, BUNDLE_GAME), 0o755);
    for (const { name, mode } of RUNTIME_FILES) {
      await writeFile(path.join(staging, name), request.runtime.files[name], { mode });
      await chmod(path.join(staging, name), mode);
    }
    await rename(staging, request.out);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return { out: request.out, files: [BUNDLE_GAME, ...RUNTIME_FILES.map(({ name }) => name)] };
}

async function stepAssembleBundle(ctx: Context): Promise<StepOutcome> {
  const resources = need(ctx.resources, "--resources");
  const pin =
    BUNDLE_LOCK.swiftshader ?? fail(RustLinuxHostCode.BundlePinRefused, "the ANGLE lock pins no SwiftShader split");
  const runtime = await readSwiftShaderRuntime(
    bundledSwiftShaderFolder(resources, BUNDLE_LOCK.commit),
    pin,
    BUNDLE_LOCK.commit,
  ).catch((error: unknown) =>
    fail(RustLinuxHostCode.BundlePinRefused, error instanceof Error ? error.message : String(error)),
  );
  const made = await assembleBundle({
    pond: path.resolve(need(ctx.pond, "--pond")),
    out: path.resolve(need(ctx.bundle, "--bundle")),
    runtime,
  });
  return { facts: { ...made, swiftshaderPin: pin.manifestSha256 } };
}

/**
 * The box needs bubblewrap 0.8 or later (`--disable-userns`); an older one exits 1 on its own
 * arguments before the game starts, which the row would read as the game failing. `text` is
 * `bwrap --version`'s output, or null when it did not run.
 */
export function checkBoxBubblewrap(text: string | null): void {
  if (bubblewrapSupported(text)) return;
  const { major, minor } = BUBBLEWRAP_MIN_VERSION;
  fail(
    RustLinuxHostCode.ToolMissing,
    `the box needs bubblewrap ${major}.${minor} or later (--disable-userns); \`bwrap --version\` said ${JSON.stringify(text)}`,
  );
}

/** A failure's detail with the last lines the game and bubblewrap wrote on stderr, bounded. */
export function boxFailureDetail(detail: string, stderr: readonly string[]): string {
  const tail = stderr.slice(-STDERR_TAIL_LINES).map((line) => line.slice(0, STDERR_LINE_CHARS));
  if (!tail.length) return detail;
  return `${detail}; stderr: ${tail.join(" | ")}`;
}

/** `bwrap --version`'s output, or null when it does not run. */
function bubblewrapVersionText(bwrap: string): string | null {
  try {
    return execFileSync(bwrap, ["--version"], { encoding: "utf8", timeout: BWRAP_VERSION_WAIT_MS });
  } catch {
    return null;
  }
}

/** The started bubblewrap as `spawnGame` holds a game: fd 3 for the protocol, its group killed on stop. */
function boxedChild(child: import("node:child_process").ChildProcess): GameChild {
  const { pid, stdout, stderr } = child;
  const fd3 = child.stdio[3];
  if (!fd3 || pid === undefined || !stdout || !stderr || !("write" in fd3))
    return fail(RustLinuxHostCode.BoxRefused, "the box did not start with its protocol pipe");
  const exited = new Promise<GameExit>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const kill = (signal: NodeJS.Signals) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    process.kill(-pid, signal);
  };
  return { pid, fd3: fd3 as GameChild["fd3"], stdout, stderr, exited, kill };
}

async function stepHeadlessBox(ctx: Context): Promise<StepOutcome> {
  const bundle = path.resolve(need(ctx.bundle, "--bundle"));
  const game = await lstatOrNull(path.join(bundle, BUNDLE_GAME));
  if (!game?.isFile()) return fail(RustLinuxHostCode.ToolMissing, `${bundle} holds no ${BUNDLE_GAME}`);
  const bwrap = ctx.env.GENEX_BWRAP ?? BWRAP_DEFAULT;
  if (process.platform !== "linux" || !existsSync(bwrap))
    fail(RustLinuxHostCode.ToolMissing, `the box needs Linux and bubblewrap (${bwrap})`);
  checkBoxBubblewrap(bubblewrapVersionText(bwrap));
  const run = await realpath(await mkdtemp(path.join(os.tmpdir(), "genex-rust-box-")));
  const runBundle = path.join(run, "bundle");
  const state = path.join(run, "state");
  await cp(bundle, runBundle, { recursive: true });
  await mkdir(state);
  const launched = await launchLinuxGameBox(
    bwrap,
    {
      stack: GameStack.RustWgpu,
      mode: NativeRunMode.Headless,
      bundle: runBundle,
      exe: path.join(runBundle, BUNDLE_GAME),
      state,
      nonce: BOX_NONCE,
      renderNodes: [],
      softwareIcd: path.join(runBundle, LinuxVulkanFile.SwiftShaderIcd),
      waylandContext: null,
      audio: LinuxBoxAudio.Muted,
      session: {},
    },
    { spawn: (file, args, options) => spawn(file, args, options) },
  );
  if (!launched.ok) {
    await rm(run, { recursive: true, force: true });
    return fail(RustLinuxHostCode.BoxRefused, `${launched.refusal}: ${launched.detail}`);
  }
  const child = boxedChild(launched.child);
  const port = new NativeGamePort({
    child,
    nonce: BOX_NONCE,
    mode: NativeRunMode.Headless,
    stateDir: state,
    timers: {
      now: () => Date.now(),
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
    encodeJpeg: async () => Buffer.from("jpeg"),
  });
  const stderr: string[] = [];
  port.onStderr((line) => {
    stderr.push(line);
    if (stderr.length > STDERR_TAIL_LINES) stderr.shift();
  });
  // When each phase ended, so a failure says whether the game was slow to start or to capture.
  const started = Date.now();
  let readyMs: number | null = null;
  try {
    const late = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new RustLinuxHostError(RustLinuxHostCode.BoxRefused, "no ready within the wait")),
        READY_WAIT_MS,
      ).unref();
    });
    const ready = await Promise.race([port.ready(), late]);
    readyMs = Date.now() - started;
    checkBoxReceipt(ready.receipt);
    const shot = await port.call(NativeOp.Capture, {});
    const captureMs = Date.now() - started - readyMs;
    const bytes = await readFile(path.join(state, "captures", `${shot.seq}.bgra`));
    const capture = checkBoxCapture(shot, bytes);
    const timing = { readyMs, captureMs };
    return {
      facts: {
        receipt: ready.receipt,
        capture,
        timing,
        sandboxed: true,
        headless: true,
        display: "none",
        network: "none",
      },
    };
  } catch (error) {
    const phase = readyMs === null ? "before ready" : `ready after ${readyMs} ms`;
    if (error instanceof RustLinuxHostError)
      return fail(error.code, boxFailureDetail(`${error.detail} (${phase})`, stderr));
    return fail(RustLinuxHostCode.StepFailed, boxFailureDetail(`${String(error)} (${phase})`, stderr));
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await rm(run, { recursive: true, force: true });
  }
}

const EXECUTORS: Record<StepId, (ctx: Context) => Promise<StepOutcome>> = {
  [StepId.BundlePins]: stepBundlePins,
  [StepId.FixtureCreation]: stepFixtureCreation,
  [StepId.AssembleBundle]: stepAssembleBundle,
  [StepId.HeadlessBox]: stepHeadlessBox,
};

async function writeRecord(ctx: Context, id: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(ctx.evidence, { recursive: true });
  await writeFile(
    path.join(ctx.evidence, `${id}.json`),
    `${JSON.stringify({ format: FORMAT, step: id, ...record }, null, 2)}\n`,
  );
}

/** Runs one step: its record is written whatever happens; a failure is rethrown typed after it. */
async function runStep(ctx: Context, spec: StepSpec): Promise<void> {
  const started = Date.now();
  const timer = setTimeout(() => {
    process.stderr.write(
      `${REFUSAL_PREFIX}${JSON.stringify({ code: RustLinuxHostCode.StepFailed, detail: `${spec.id} exceeded ${STEP_TIMEOUT_MS} ms` })}\n`,
    );
    process.exit(FAIL_EXIT);
  }, STEP_TIMEOUT_MS);
  timer.unref();
  try {
    const outcome = await EXECUTORS[spec.id](ctx);
    await writeRecord(ctx, spec.id, {
      status: StepStatus.Pass,
      title: spec.title,
      ms: Date.now() - started,
      ...outcome.facts,
    });
  } catch (error) {
    const typed =
      error instanceof RustLinuxHostError ? error : new RustLinuxHostError(RustLinuxHostCode.StepFailed, String(error));
    await writeRecord(ctx, spec.id, {
      status: StepStatus.Fail,
      title: spec.title,
      ms: Date.now() - started,
      code: typed.code,
      detail: typed.detail,
    });
    throw typed;
  } finally {
    clearTimeout(timer);
  }
}

// ---- command line ---------------------------------------------------------------------------

const VALUE_FLAGS = [
  "--step",
  "--check-workflow",
  "--check-windows",
  "--resources",
  "--templates",
  "--pond",
  "--bundle",
  "--evidence",
] as const;

interface Options {
  mode: "table" | "check-workflow" | "check-windows" | "step";
  value: string | null;
  flags: Partial<Record<(typeof VALUE_FLAGS)[number], string>>;
}

function parseArgs(args: string[]): Options {
  const options: Options = { mode: "table", value: null, flags: {} };
  let chosen = false;
  const choose = (mode: Options["mode"], value: string | null) => {
    if (chosen) fail(RustLinuxHostCode.Usage, "one of --table, --check-workflow, --check-windows, --step");
    chosen = true;
    options.mode = mode;
    options.value = value;
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i] ?? "";
    if (flag === "--table") {
      choose("table", null);
      continue;
    }
    const known = VALUE_FLAGS.find((candidate) => candidate === flag);
    if (!known) return fail(RustLinuxHostCode.Usage, `unknown argument ${flag}`);
    const value = args[++i] ?? fail(RustLinuxHostCode.Usage, `${flag} needs a value`);
    if (known === "--step") choose("step", value);
    else if (known === "--check-workflow") choose("check-workflow", value);
    else if (known === "--check-windows") choose("check-windows", value);
    else options.flags[known] = value;
  }
  if (!chosen) fail(RustLinuxHostCode.Usage, "one of --table, --check-workflow, --check-windows, --step");
  return options;
}

function contextOf(options: Options): Context {
  const resolved = (flag: (typeof VALUE_FLAGS)[number]) =>
    options.flags[flag] ? path.resolve(String(options.flags[flag])) : null;
  return {
    evidence: path.resolve(options.flags["--evidence"] ?? DEFAULT_EVIDENCE),
    resources: resolved("--resources"),
    templates: resolved("--templates"),
    pond: resolved("--pond"),
    bundle: resolved("--bundle"),
    env: process.env,
  };
}

async function main(args: string[]): Promise<number> {
  const options = parseArgs(args);
  switch (options.mode) {
    case "table":
      process.stdout.write(`${JSON.stringify({ steps: STEP_TABLE, workflows: WORKFLOW_ROWS }, null, 2)}\n`);
      return 0;
    case "check-workflow": {
      const file = String(options.value);
      checkWorkflow(path.basename(file), await readFile(file, "utf8"));
      return 0;
    }
    case "check-windows":
      checkWindowsWorkflow(await readFile(String(options.value), "utf8"));
      return 0;
    default: {
      const spec =
        STEP_TABLE.find((step) => step.id === options.value) ??
        fail(RustLinuxHostCode.UnknownStep, String(options.value));
      await runStep(contextOf(options), spec);
      process.stderr.write(`rust-linux-host: ${spec.id}: ${StepStatus.Pass}\n`);
      return 0;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      const typed =
        error instanceof RustLinuxHostError
          ? error
          : new RustLinuxHostError(RustLinuxHostCode.StepFailed, String(error));
      process.stderr.write(`${REFUSAL_PREFIX}${JSON.stringify({ code: typed.code, detail: typed.detail })}\n`);
      process.exit(FAIL_EXIT);
    },
  );
}
