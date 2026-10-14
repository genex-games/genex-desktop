/**
 * The Rust spike's CI steps (M0a.13). `.github/workflows/rust-spike.yml` only calls
 * `node scripts/ci/rust-spike.ts --step <id>`; every check lives here so `tests/conformance/
 * rust-spike-ci.test.ts` can drive it on any host with fake binaries.
 *
 *   node scripts/ci/rust-spike.ts --table                     the step table as JSON
 *   node scripts/ci/rust-spike.ts --check-workflow <file>     the workflow calls each step once, on its job
 *   node scripts/ci/rust-spike.ts --step <id> [flags]         one CI step (typed refusal, exit 1, on failure)
 *   node scripts/ci/rust-spike.ts --local [--only a,b] [--skip a,b] [flags]
 *                                                             every step this machine can run, on its own GPU
 *
 * Flags: `--evidence <dir>` (records, default `.studio-dev/evidence/rust-spike-ci`), `--artifacts <dir>`
 * (cross outputs, default `.studio-dev/ci/artifacts`), `--pond <binary>`, `--ticks <n>`,
 * `--profile debug|release`, `--vulkan software|host`, `--windows-dir <dir>`.
 *
 * Every step writes `<evidence>/<id>.json`; a failure prints one typed line on stderr and exits 1:
 *   genex-spike-ci: {"code":"<code>","detail":"<text>"}
 *
 * The Linux job runs the pond headless on software Vulkan (SwiftShader from the pinned ANGLE
 * bundle, lavapipe as the CI-only alternative: the plan's KILL is neither giving wgpu a
 * WebGPU-compliant adapter), the web build on Chrome's WebGPU and in Firefox's unsupported page,
 * the Electron WebGPU probe, and the cross builds. The Windows job (dispatch only) runs the
 * gnullvm binary on D3D12 WARP with a decoy `dxcompiler.dll` first on PATH: FXC must still be
 * the shader compiler, so the decoy must never be loaded.
 *
 * The Windows job installs no npm packages: this file imports only `src/shared/duration.ts`, and
 * the browser rows load Playwright on demand.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const RUST_ENV = path.join(REPO, "scripts", "spike", "rust-wgpu", "rust-env.sh");
const WEB_SH = path.join(REPO, "scripts", "spike", "rust-wgpu", "web.sh");
const SETUP_TOOLCHAIN = path.join(REPO, "scripts", "spike", "rust-wgpu", "setup-toolchain.sh");
const SPIKE_TOOLCHAIN = path.join(REPO, ".studio-dev", "spike-toolchain");
const FORMAT = "genex-spike-ci/1";
const REFUSAL_PREFIX = "genex-spike-ci: ";
const POND_REFUSAL_PREFIX = "pond: ";
const SELF_TEST_FORMAT = "genex-self-test/1";
const ELECTRON_FORMAT = "genex-electron-webgpu/1";
const FAIL_EXIT = 1;

const BUILD_TIMEOUT_MS = 90 * MINUTE_MS;
const RUN_TIMEOUT_MS = 10 * MINUTE_MS;
const BOOT_TIMEOUT_MS = 60 * SECOND_MS;
const ELECTRON_TIMEOUT_MS = 90 * SECOND_MS;
const OUTPUT_MAX_BYTES = 256 * 1024 * 1024;

const DEFAULT_TICKS_CI = 600;
const DEFAULT_TICKS_LOCAL = 200;
const SELF_TEST_SEED = 1;
const SELF_TEST_DEMO = "cast";
/** A capture with fewer distinct colours than this is blank (a clear and nothing drawn). */
const NONBLANK_MIN_COLOURS = 16;
/** Named probe fields agree within this across targets (plan "Determinism"). */
const PROBE_TOLERANCE = 1e-3;
const POND_WORLD = { width: 960, height: 540 };
const ELECTRON_PINNED_FROM = "package.json devDependencies.electron";

/** The software adapters a CI row accepts: SwiftShader, lavapipe (llvmpipe), WARP. */
const SOFTWARE_ADAPTER = /swiftshader|llvmpipe|lavapipe|softpipe|basic render|warp/i;
const DEFAULT_LAVAPIPE_ICDS = ["/usr/share/vulkan/icd.d/lvp_icd.json", "/usr/share/vulkan/icd.d/lvp_icd.x86_64.json"];
const SWIFTSHADER_ICD_NAME = "vk_swiftshader_icd.json";
const DECOY_DLL = "dxcompiler.dll";
const DECOY_MARKER_SUFFIX = ".loaded";
const WINDOWS_TARGET = "x86_64-pc-windows-gnullvm";
const WINDOWS_RUSTFLAGS = "-C target-feature=+crt-static";
const ANDROID_TARGET = "aarch64-linux-android";
const ANDROID_PAGE_BYTES = 16384;
const ANDROID_LINK_ARGS = `-C link-arg=-Wl,-z,max-page-size=${ANDROID_PAGE_BYTES} -C link-arg=-Wl,-z,common-page-size=${ANDROID_PAGE_BYTES}`;

/** How a step run ended, in its evidence record (wire values). */
export const StepStatus = {
  Pass: "pass",
  Fail: "fail",
  NotRun: "not-run",
} as const;
export type StepStatus = (typeof StepStatus)[keyof typeof StepStatus];

/** The cargo profile the pond is built with. */
export const BuildProfile = {
  Debug: "debug",
  Release: "release",
} as const;
export type BuildProfile = (typeof BuildProfile)[keyof typeof BuildProfile];

/** Where the headless row's Vulkan comes from: the pinned software ICDs, or the host's own GPU driver. */
export const VulkanSource = {
  Software: "software",
  Host: "host",
} as const;
export type VulkanSource = (typeof VulkanSource)[keyof typeof VulkanSource];

/** The refusal codes this script prints (wire values). */
export const SpikeCiCode = {
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
  /** KILL: neither SwiftShader nor lavapipe gives wgpu a WebGPU-compliant Vulkan adapter. */
  NoCompliantSoftwareVulkan: "no-compliant-software-vulkan",
  /** KILL: the gnullvm binary does not run D3D12 under WARP. */
  WarpNotCompliant: "warp-not-compliant",
  FxcNotExplicit: "fxc-not-explicit",
  DecoyLoaded: "decoy-loaded",
  UnsupportedPageMissing: "unsupported-page-missing",
  WebGpuUnavailable: "webgpu-unavailable",
  ProbesDiffer: "probes-differ",
  ElectronMismatch: "electron-mismatch",
} as const;
export type SpikeCiCode = (typeof SpikeCiCode)[keyof typeof SpikeCiCode];

/** A typed failure of a step. */
export class SpikeCiError extends Error {
  code: SpikeCiCode;
  detail: string;

  constructor(code: SpikeCiCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "SpikeCiError";
    this.code = code;
    this.detail = detail;
  }
}

/** A step this machine cannot run: recorded as not-run, never as a pass. */
class NotRun extends Error {}

function fail(code: SpikeCiCode, detail: string): never {
  throw new SpikeCiError(code, detail);
}

/** The two workflow jobs. */
export const Job = { Linux: "linux", Windows: "windows" } as const;
export type Job = (typeof Job)[keyof typeof Job];

/** Step ids (wire values: the workflow's `--step` argument and the record file names). */
export const StepId = {
  Toolchain: "toolchain",
  BuildPond: "build-pond",
  FxcExplicit: "fxc-explicit",
  HeadlessSoftwareVulkan: "headless-software-vulkan",
  WebBuild: "web-build",
  WebChrome: "web-chrome",
  WebFirefox: "web-firefox",
  ElectronProbe: "electron-webgpu-probe",
  CrossBuilds: "cross-builds",
  LinuxGlibcFloor: "linux-glibc-floor",
  WindowsWarp: "windows-warp",
} as const;
export type StepId = (typeof StepId)[keyof typeof StepId];

/** One row of the step table. */
export interface StepSpec {
  id: StepId;
  job: Job;
  title: string;
  /** Whether `--local` runs it on this machine (otherwise it is recorded as not-run, with why). */
  local: boolean;
  /** Why the row is not wired yet (it is then not called by the workflow). */
  deferred?: string;
  /** Why `--local` does not run it. */
  localNotRun?: string;
}

/** The plan's rows, in run order. */
export const STEP_TABLE: readonly StepSpec[] = [
  {
    id: StepId.Toolchain,
    job: Job.Linux,
    title: "Install the pinned spike toolchain (official sources, sha256-pinned)",
    local: false,
    localNotRun: "this machine has the spike toolchain from M0a.17",
  },
  { id: StepId.BuildPond, job: Job.Linux, title: "Build the pond for the host", local: true },
  {
    id: StepId.FxcExplicit,
    job: Job.Linux,
    title: "The D3D12 instance names FXC explicitly (genex-render dx12_compiler)",
    local: true,
  },
  {
    id: StepId.HeadlessSoftwareVulkan,
    job: Job.Linux,
    title: "Headless run on software Vulkan: non-blank capture, tier core, a WebGPU-compliant adapter in the receipt",
    local: true,
  },
  {
    id: StepId.WebBuild,
    job: Job.Linux,
    title: "Build the pond for the web (wasm-bindgen, wasm-opt, 4 MB gzip budget)",
    local: true,
  },
  {
    id: StepId.WebChrome,
    job: Job.Linux,
    title: "The pond web build on Chrome's WebGPU over SwiftShader (switches recorded)",
    local: true,
  },
  {
    id: StepId.WebFirefox,
    job: Job.Linux,
    title: "Firefox on Linux gets the typed unsupported page and never starts the game",
    local: true,
  },
  {
    id: StepId.ElectronProbe,
    job: Job.Linux,
    title: "WebGPU in the Electron binary the .deb ships, without then with the Chromium switches",
    local: true,
  },
  {
    id: StepId.CrossBuilds,
    job: Job.Linux,
    title: "Cross builds: Windows gnullvm (+ decoy dxcompiler.dll), Android aarch64",
    local: false,
    localNotRun: "the Mac's cross rows are M0a.8's cross-all.sh",
  },
  {
    id: StepId.LinuxGlibcFloor,
    job: Job.Linux,
    title: "x86_64-unknown-linux-gnu.2.28 build and run on the glibc 2.28 floor",
    local: false,
    deferred:
      "cross-linux.sh and cross-lib.sh are written for the Mac host (df -g, Apple llvm-tools path); porting them to the Linux runner is M0a.8-owned work",
  },
  {
    id: StepId.WindowsWarp,
    job: Job.Windows,
    title: "The gnullvm binary on D3D12 WARP with a decoy dxcompiler.dll on PATH (FXC still used)",
    local: false,
    localNotRun: "runs only on the owner-dispatched Windows job",
  },
];

// ---- pure checks ---------------------------------------------------------------------------

/** FNV-1a 64 of bytes, 16 hex digits (the capture digest the renderer writes). */
export function fnv1a64(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, "0");
}

/** Distinct colours (alpha ignored) of BGRA bytes, counting no further than `limit`. */
export function distinctColours(bgra: Uint8Array, limit: number): number {
  const colours = new Set<number>();
  for (let i = 0; i < bgra.length && colours.size < limit; i += 4) {
    colours.add((bgra[i] << 16) | (bgra[i + 1] << 8) | bgra[i + 2]);
  }
  return colours.size;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** What a row expects of the receipt's backend and adapter. */
export interface ReceiptExpectation {
  backends: string[];
  /** The adapter must be a software rasteriser (SwiftShader, lavapipe, WARP). */
  software: boolean;
  /** The adapter's name may be empty: a browser's WebGPU hides it. */
  anonymousAdapter?: boolean;
}

/** The capability receipt of a GPU the floor accepted: tier core, an expected backend, a named adapter. */
export function checkReceipt(receipt: unknown, expectation: ReceiptExpectation): void {
  if (!isObject(receipt)) fail(SpikeCiCode.BadRecord, "the capability receipt is not a JSON object");
  const { tier, backend, adapter } = receipt as Record<string, unknown>;
  if (tier !== "core") fail(SpikeCiCode.NotCoreTier, `the receipt says tier ${JSON.stringify(tier)}, not "core"`);
  const unnamed = typeof adapter !== "string" || (adapter === "" && !expectation.anonymousAdapter);
  if (unnamed) fail(SpikeCiCode.BadRecord, "the receipt names no adapter");
  if (typeof backend !== "string" || !expectation.backends.includes(backend)) {
    fail(
      SpikeCiCode.WrongBackend,
      `backend ${JSON.stringify(backend)} is not one of ${expectation.backends.join(", ")}`,
    );
  }
  if (expectation.software && !SOFTWARE_ADAPTER.test(adapter as string)) {
    fail(SpikeCiCode.NotSoftwareAdapter, `adapter ${JSON.stringify(adapter)} is not a software rasteriser`);
  }
}

/** The facts of one checked capture. */
export interface CaptureFacts {
  seq: number;
  tick: number;
  width: number;
  height: number;
  digest: string;
  colours: number;
}

async function readCapture(dir: string, seq: number, capture: Record<string, unknown>): Promise<CaptureFacts> {
  const { tick, width, height, digest } = capture;
  if (![tick, width, height].every((n) => Number.isInteger(n)) || typeof digest !== "string") {
    return fail(SpikeCiCode.BadRecord, `capture ${seq} of the record has no tick, size and digest`);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path.join(dir, `${seq}.bgra`)));
  } catch {
    return fail(SpikeCiCode.BadRecord, `capture file ${seq}.bgra is missing from ${dir}`);
  }
  const expected = (width as number) * (height as number) * 4;
  if (bytes.length !== expected)
    fail(SpikeCiCode.BadRecord, `${seq}.bgra is ${bytes.length} bytes, ${expected} expected`);
  const actual = fnv1a64(bytes);
  if (actual !== digest)
    fail(SpikeCiCode.DigestMismatch, `${seq}.bgra digests to ${actual}, the record says ${digest}`);
  return {
    seq,
    tick: tick as number,
    width: width as number,
    height: height as number,
    digest,
    colours: distinctColours(bytes, NONBLANK_MIN_COLOURS),
  };
}

/** Every capture the self-test record lists exists, matches its digest, and the last one is not blank. */
export async function checkCaptures(record: unknown, capturesDir: string): Promise<CaptureFacts[]> {
  const captures = isObject(record) ? record.captures : undefined;
  if (!Array.isArray(captures) || captures.length === 0)
    fail(SpikeCiCode.BadRecord, "the self-test record lists no captures");
  const facts: CaptureFacts[] = [];
  for (const [index, capture] of (captures as unknown[]).entries()) {
    if (!isObject(capture)) fail(SpikeCiCode.BadRecord, `capture ${index + 1} of the record is not an object`);
    facts.push(await readCapture(capturesDir, index + 1, capture as Record<string, unknown>));
  }
  const last = facts[facts.length - 1];
  if (last.colours < NONBLANK_MIN_COLOURS) {
    fail(
      SpikeCiCode.BlankCapture,
      `the last capture has ${last.colours} distinct colours (blank: fewer than ${NONBLANK_MIN_COLOURS})`,
    );
  }
  return facts;
}

/** A cargo test run that ran and passed at least one test (a filter that matched nothing is not a pass). */
export function checkCargoTest(stdout: string): void {
  const ok = /test result: ok\. (\d+) passed/.exec(stdout);
  if (!ok || Number(ok[1]) < 1) {
    fail(
      SpikeCiCode.FxcNotExplicit,
      "genex-render's dx12_compiler test did not run and pass (D3D12 shaders must compile with FXC, set explicitly)",
    );
  }
}

/**
 * The package name in a cargo package id: `name ver (src)`, `src#name@ver`, or `src/name#ver` (a path
 * package named like its folder, which is how cargo spells the pond).
 */
export function cargoPackageName(id: string): string {
  const legacy = /^(\S+) \S+ \(/.exec(id);
  if (legacy) return legacy[1];
  const hash = id.lastIndexOf("#");
  if (hash < 0) return "";
  const fragment = id.slice(hash + 1);
  const at = fragment.lastIndexOf("@");
  if (at >= 0) return fragment.slice(0, at);
  const url = id.slice(0, hash).replace(/\/+$/, "");
  return url.slice(url.lastIndexOf("/") + 1);
}

/** The artifact cargo reported (`--message-format=json`) for a package's target. */
export function cargoArtifact(jsonLines: string, pkg: string, name: string, kind: string): string {
  let found = "";
  for (const line of jsonLines.split("\n")) {
    if (!line.startsWith("{")) continue;
    const message = JSON.parse(line) as Record<string, unknown>;
    const target = message.target as { name?: string; kind?: string[] } | undefined;
    if (message.reason !== "compiler-artifact" || target?.name !== name || !target.kind?.includes(kind)) continue;
    if (cargoPackageName(String(message.package_id)) !== pkg) continue;
    const files = (message.filenames as string[] | undefined) ?? [];
    found =
      kind === "cdylib" ? (files.find((f) => /\.(so|dylib|dll)$/.test(f)) ?? "") : String(message.executable ?? "");
  }
  return found || fail(SpikeCiCode.StepFailed, `cargo reported no ${kind} artifact ${name} of ${pkg}`);
}

/** Every numeric leaf within the tolerance, every other leaf equal. */
export function compareProbes(web: unknown, native: unknown, where = "probes"): void {
  if (typeof native === "number") {
    const close = typeof web === "number" && Math.abs(web - native) <= PROBE_TOLERANCE;
    if (!close) fail(SpikeCiCode.ProbesDiffer, `${where}: ${JSON.stringify(web)} vs ${native}`);
    return;
  }
  if (isObject(native)) {
    const keys = Object.keys(native);
    if (!isObject(web) || Object.keys(web).join() !== keys.join())
      fail(SpikeCiCode.ProbesDiffer, `${where} has other fields`);
    for (const key of keys) compareProbes((web as Record<string, unknown>)[key], native[key], `${where}.${key}`);
    return;
  }
  if (JSON.stringify(web) !== JSON.stringify(native))
    fail(SpikeCiCode.ProbesDiffer, `${where}: ${JSON.stringify(web)} vs ${JSON.stringify(native)}`);
}

/** The decoy `dxcompiler.dll` writes `<its path>.loaded` when Windows loads it: it must be absent. */
export function checkDecoyUnused(decoyDir: string): void {
  const marker = path.join(decoyDir, `${DECOY_DLL}${DECOY_MARKER_SUFFIX}`);
  if (existsSync(marker))
    fail(SpikeCiCode.DecoyLoaded, `${marker} exists: the game loaded the decoy dxcompiler.dll instead of using FXC`);
}

const GAME_FILES = ["/game.js", "/game_bg.wasm"];

/** Firefox on Linux: the designed unsupported page, with `gpu-unsupported`/`no-webgpu`, and no game fetched. */
export function checkUnsupportedShell(status: unknown, requests: readonly string[]): void {
  const shell = isObject(status) ? status : {};
  const designed = shell.state === "unsupported" && shell.code === "gpu-unsupported" && shell.reason === "no-webgpu";
  if (!designed) fail(SpikeCiCode.UnsupportedPageMissing, `the shell status is ${JSON.stringify(status)}`);
  const fetched = requests.filter((request) => GAME_FILES.includes(request));
  if (fetched.length > 0)
    fail(SpikeCiCode.UnsupportedPageMissing, `the unsupported page still fetched ${fetched.join(", ")}`);
}

const ElectronOutcome = { Core: "webgpu-core" } as const;
const ElectronResult = {
  Without: "webgpu-without-switches",
  NeedsSwitches: "webgpu-needs-switches",
  None: "no-webgpu",
} as const;
const ElectronAttempt = { Without: "without-switches", With: "with-switches" } as const;

function electronResultOf(attempts: Array<{ outcome: unknown }>): string {
  if (attempts[0].outcome === ElectronOutcome.Core) return ElectronResult.Without;
  return attempts[1].outcome === ElectronOutcome.Core ? ElectronResult.NeedsSwitches : ElectronResult.None;
}

/** The Electron probe record is complete and says what its attempts say. No WebGPU is a result, not a kill. */
export function checkElectronRecord(record: unknown, expectedVersion: string): void {
  if (!isObject(record) || record.format !== ELECTRON_FORMAT || !Array.isArray(record.attempts)) {
    fail(SpikeCiCode.BadRecord, "the Electron probe record is not genex-electron-webgpu/1");
  }
  if (record.electron !== expectedVersion) {
    fail(
      SpikeCiCode.ElectronMismatch,
      `the probe ran Electron ${String(record.electron)}, ${ELECTRON_PINNED_FROM} is ${expectedVersion}`,
    );
  }
  const attempts = record.attempts as Array<{ label?: unknown; outcome?: unknown }>;
  const labels = attempts.map((attempt) => attempt.label);
  if (labels.join() !== [ElectronAttempt.Without, ElectronAttempt.With].join()) {
    fail(SpikeCiCode.BadRecord, `the probe has attempts ${JSON.stringify(labels)}, not without then with the switches`);
  }
  const result = electronResultOf(attempts as Array<{ outcome: unknown }>);
  if (record.result !== result)
    fail(SpikeCiCode.BadRecord, `the probe says ${String(record.result)}, its attempts say ${result}`);
}

// ---- the workflow check --------------------------------------------------------------------

/** A job of the workflow as the check reads it. */
export interface WorkflowJob {
  name: string;
  ifCondition: string | null;
  stepIds: string[];
  /** Spike steps called from a workflow step whose own `if:` could skip them. */
  conditioned: Array<{ id: string; condition: string }>;
}

const STEP_CALL = /rust-spike\.ts --step ([A-Za-z0-9-]+)/g;
const JOB_HEADER = /^ {2}([A-Za-z0-9_-]+):\s*$/;
const JOB_IF = /^ {4}if:\s*(.*?)\s*$/;
/** A workflow step's first line (`- ` at the steps list's indent). */
const STEP_ITEM = /^( {6})- /;
/** A key of a step (`- key:` on its first line or `key:` below it) and its inline value. */
const STEP_KEY = /^ {6}(?:- | {2})([A-Za-z_-]+):\s*(.*?)\s*$/;
/** A step condition that never skips a call the job reached (it only keeps cancelled runs out). */
const ALWAYS_REACHED = new Set(["", "!cancelled()"]);

/** One workflow step while it is read: its `if:` and the text of its `run:`. */
interface StepText {
  condition: string;
  run: string[];
}

const normalCondition = (condition: string | null) => (condition ?? "").replace(/\$\{\{|\}\}|\s/g, "");

/** Fold one finished step's calls into its job. */
function closeStep(job: WorkflowJob | undefined, step: StepText | null): void {
  if (!job || !step) return;
  for (const call of step.run.join("\n").matchAll(STEP_CALL)) {
    job.stepIds.push(call[1]);
    const condition = normalCondition(step.condition);
    if (!ALWAYS_REACHED.has(condition)) job.conditioned.push({ id: call[1], condition: step.condition });
  }
}

/** What the workflow reader holds between lines. */
interface WorkflowReader {
  jobs: WorkflowJob[];
  inJobs: boolean;
  step: StepText | null;
  /** The indentation a block-scalar `run:` continues beyond; -1 outside one. */
  runIndent: number;
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const BLOCK_SCALAR = /^[|>][-+]?$/;

/** A continuation line of a block `run:`: taken into the step, true. */
function takeRunBlock(reader: WorkflowReader, line: string): boolean {
  if (reader.runIndent < 0) return false;
  if (line.trim() !== "" && indentOf(line) <= reader.runIndent) {
    reader.runIndent = -1;
    return false;
  }
  reader.step?.run.push(line);
  return true;
}

/** A job header or a step's first line ends the step being read. */
function startJobOrStep(reader: WorkflowReader, line: string): void {
  const header = JOB_HEADER.exec(line);
  const item = STEP_ITEM.test(line);
  if (header || item) {
    closeStep(reader.jobs.at(-1), reader.step);
    reader.step = item ? { condition: "", run: [] } : null;
  }
  if (header) reader.jobs.push({ name: header[1], ifCondition: null, stepIds: [], conditioned: [] });
}

/** A step key: `if:` is noted, `run:` taken inline or as the start of a block. */
function readStepKey(reader: WorkflowReader, line: string): void {
  const key = reader.step ? STEP_KEY.exec(line) : null;
  if (!reader.step || !key) return;
  if (key[1] === "if") reader.step.condition = key[2];
  if (key[1] !== "run") return;
  if (!BLOCK_SCALAR.test(key[2])) {
    reader.step.run.push(key[2]);
    return;
  }
  reader.runIndent = indentOf(line) + (line.trimStart().startsWith("- ") ? 2 : 0);
}

function readWorkflowLine(reader: WorkflowReader, line: string): void {
  if (takeRunBlock(reader, line) || line.trimStart().startsWith("#")) return;
  if (/^\S/.test(line)) reader.inJobs = line.startsWith("jobs:");
  if (!reader.inJobs) return;
  startJobOrStep(reader, line);
  const job = reader.jobs.at(-1);
  if (!job) return;
  const condition = JOB_IF.exec(line);
  if (condition) job.ifCondition = condition[1];
  readStepKey(reader, line);
}

/**
 * The jobs under `jobs:` with their `if:`, the step ids their steps' `run:` values call, and the
 * calls a step-level `if:` could skip. Only `run:` text counts: a step's name, a comment or any
 * other key never does. Block scalars (`run: |`) are read to the end of their indentation.
 */
export function workflowJobs(text: string): WorkflowJob[] {
  const reader: WorkflowReader = { jobs: [], inJobs: false, step: null, runIndent: -1 };
  for (const line of text.split("\n")) readWorkflowLine(reader, line);
  closeStep(reader.jobs.at(-1), reader.step);
  return reader.jobs;
}

const DISPATCH_ONLY = "github.event_name=='workflow_dispatch'";

/** Every call names a known step, and no step-level `if:` can skip one. */
function checkCalls(jobs: readonly WorkflowJob[]): void {
  const known = new Set<string>(STEP_TABLE.map((step) => step.id));
  for (const job of jobs) {
    for (const id of job.stepIds) if (!known.has(id)) fail(SpikeCiCode.UnknownStep, `${job.name} calls --step ${id}`);
    for (const { id, condition } of job.conditioned)
      fail(SpikeCiCode.WorkflowDrift, `${job.name} calls --step ${id} under \`if: ${condition}\`, which can skip it`);
  }
}

/** Each non-deferred step is called exactly once, on its job; the Windows job runs only on dispatch. */
export function checkWorkflow(text: string): void {
  const jobs = workflowJobs(text);
  checkCalls(jobs);
  for (const step of STEP_TABLE.filter((s) => !s.deferred)) {
    const calls = jobs.flatMap((job) => job.stepIds.filter((id) => id === step.id).map(() => job.name));
    if (calls.length !== 1 || calls[0] !== step.job) {
      fail(
        SpikeCiCode.WorkflowDrift,
        `${step.id} must be called once on the ${step.job} job, it is called on: ${calls.join(", ") || "no job"}`,
      );
    }
  }
  const windows = jobs.find((job) => job.name === Job.Windows);
  if (!windows || normalCondition(windows.ifCondition) !== DISPATCH_ONLY) {
    fail(
      SpikeCiCode.WorkflowDrift,
      `the windows job must have \`if: ${DISPATCH_ONLY.replace("==", " == ")}\`, it has ${windows?.ifCondition ?? "no if"}`,
    );
  }
}

// ---- running things ------------------------------------------------------------------------

/** What a step run knows. */
interface Context {
  evidence: string;
  artifacts: string;
  targetDir: string;
  pond: string | null;
  ticks: number;
  profile: BuildProfile;
  vulkan: VulkanSource;
  windowsDir: string | null;
  local: boolean;
  env: NodeJS.ProcessEnv;
}

interface Collected {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface CollectOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  /** Pass stderr through to this process's stderr (build logs) instead of collecting it. */
  inheritStderr?: boolean;
}

/** Run a process to its end, collecting stdout (and stderr unless inherited); never rejects on a non-zero exit. */
function collect(command: string, args: string[], options: CollectOptions = {}): Promise<Collected> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(command, args, {
      cwd: options.cwd ?? REPO,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", options.inheritStderr ? "inherit" : "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? RUN_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > OUTPUT_MAX_BYTES) child.kill("SIGKILL");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** `cargo <args>` through rust-env.sh (pinned sysroot, vendored crates), offline and locked. */
async function cargo(ctx: Context, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<Collected> {
  const env = { ...ctx.env, CARGO_TARGET_DIR: ctx.targetDir, ...extraEnv };
  return collect("bash", [RUST_ENV, "cargo", ...args, "--offline", "--locked"], {
    env,
    timeoutMs: BUILD_TIMEOUT_MS,
    inheritStderr: true,
  });
}

async function requireCargo(ctx: Context, args: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<Collected> {
  const run = await cargo(ctx, args, extraEnv);
  if (run.code !== 0) fail(SpikeCiCode.StepFailed, `cargo ${args.join(" ")} exited ${run.code}`);
  return run;
}

const HOST_BACKENDS: Partial<Record<NodeJS.Platform, string>> = { darwin: "metal", win32: "d3d12" };
const hostBackend = (): string => HOST_BACKENDS[process.platform] ?? "vulkan";

const exeName = (name: string) => (process.platform === "win32" ? `${name}.exe` : name);

function pondPath(ctx: Context): string {
  return ctx.pond ?? path.join(ctx.targetDir, ctx.profile, exeName("pond"));
}

function requireFile(file: string, what: string): string {
  return existsSync(file) ? file : fail(SpikeCiCode.ToolMissing, `${what} is not at ${file}`);
}

// ---- the pond self-test --------------------------------------------------------------------

/** A way to give wgpu a Vulkan adapter: the environment that selects it. */
interface Provider {
  id: string;
  env: NodeJS.ProcessEnv;
}

const HOST_PROVIDER: Provider = { id: "host-gpu", env: {} };

function findFile(root: string, name: string): string | null {
  if (!existsSync(root)) return null;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    const inside = entry.isDirectory() ? findFile(full, name) : null;
    if (inside) return inside;
  }
  return null;
}

function icdProvider(id: string, icd: string, libraryDir: string | null): Provider {
  const env: NodeJS.ProcessEnv = { VK_DRIVER_FILES: icd, VK_ICD_FILENAMES: icd };
  if (libraryDir) env.LD_LIBRARY_PATH = [libraryDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  return { id, env };
}

/** SwiftShader first (the pinned ANGLE bundle's Vulkan ICD), then lavapipe; only those that are installed. */
function softwareProviders(env: NodeJS.ProcessEnv): Provider[] {
  const providers: Provider[] = [];
  const angle = env.GENEX_SPIKE_ANGLE_DIR;
  const swiftshader = env.GENEX_SPIKE_SWIFTSHADER_ICD ?? (angle ? findFile(angle, SWIFTSHADER_ICD_NAME) : null);
  if (swiftshader && existsSync(swiftshader))
    providers.push(icdProvider("swiftshader", swiftshader, path.dirname(swiftshader)));
  const lavapipe = env.GENEX_SPIKE_LAVAPIPE_ICD ?? DEFAULT_LAVAPIPE_ICDS.find((icd) => existsSync(icd));
  if (lavapipe && existsSync(lavapipe)) providers.push(icdProvider("lavapipe", lavapipe, null));
  return providers;
}

interface SelfTestFiles {
  dir: string;
  record: Record<string, unknown>;
  receipt: unknown;
  capturesDir: string;
}

type SelfTestOutcome = { ok: true; files: SelfTestFiles } | { ok: false; refusal: string; detail: string };

function pondRefusal(stderr: string): { code: string; detail: string } | null {
  const line = stderr
    .split("\n")
    .reverse()
    .find((l) => l.startsWith(POND_REFUSAL_PREFIX));
  if (!line) return null;
  try {
    const parsed = JSON.parse(line.slice(POND_REFUSAL_PREFIX.length)) as { code?: unknown; detail?: unknown };
    return { code: String(parsed.code), detail: String(parsed.detail) };
  } catch {
    return null;
  }
}

/** Run `pond --self-test` with a provider's environment; a `gpu-unsupported` refusal is an outcome, any other failure throws. */
async function runSelfTest(
  ctx: Context,
  pond: string,
  provider: Provider,
  dir: string,
  cwd?: string,
): Promise<SelfTestOutcome> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const out = path.join(dir, "record.json");
  const receiptFile = path.join(dir, "receipt.json");
  const args = [
    "--self-test",
    String(ctx.ticks),
    "--seed",
    String(SELF_TEST_SEED),
    "--demo",
    SELF_TEST_DEMO,
    "--out",
    out,
    "--state-dir",
    dir,
    "--receipt",
    receiptFile,
  ];
  const options = { env: { ...ctx.env, ...provider.env }, timeoutMs: RUN_TIMEOUT_MS, cwd };
  const run = await collect(pond, args, options).catch((error: Error) =>
    fail(SpikeCiCode.ToolMissing, `${pond} did not start: ${error.message}`),
  );
  if (run.code !== 0) {
    const refusal = pondRefusal(run.stderr);
    if (refusal?.code === "gpu-unsupported") return { ok: false, refusal: refusal.code, detail: refusal.detail };
    return fail(SpikeCiCode.StepFailed, `${pond} exited ${run.code}: ${(run.stderr || run.stdout).trim().slice(-600)}`);
  }
  const record = JSON.parse(await readFile(out, "utf8")) as Record<string, unknown>;
  const receipt = JSON.parse(await readFile(receiptFile, "utf8")) as unknown;
  if (record.format !== SELF_TEST_FORMAT)
    fail(SpikeCiCode.BadRecord, `the self-test record's format is ${String(record.format)}`);
  return { ok: true, files: { dir, record, receipt, capturesDir: path.join(dir, "captures") } };
}

interface StepOutcome {
  facts: Record<string, unknown>;
}

async function checkedFacts(files: SelfTestFiles, expectation: ReceiptExpectation) {
  checkReceipt(files.receipt, expectation);
  const captures = await checkCaptures(files.record, files.capturesDir);
  const { ticks, frame, checksum, seed, demo } = files.record;
  return {
    receipt: files.receipt,
    captures,
    selfTest: { ticks, frame, checksum, seed, demo },
    recordPath: path.join(files.dir, "record.json"),
  };
}

async function stepHeadless(ctx: Context): Promise<StepOutcome> {
  const pond = requireFile(pondPath(ctx), "the pond binary");
  const software = ctx.vulkan === VulkanSource.Software;
  const providers = software ? softwareProviders(ctx.env) : [HOST_PROVIDER];
  if (providers.length === 0)
    fail(
      SpikeCiCode.ToolMissing,
      "no software Vulkan: neither SwiftShader (GENEX_SPIKE_ANGLE_DIR) nor lavapipe (mesa-vulkan-drivers) is installed",
    );
  const expectation = { backends: software ? ["vulkan"] : [hostBackend()], software };
  const attempts: Array<{ provider: string; refusal?: string; detail?: string }> = [];
  for (const provider of providers) {
    const outcome = await runSelfTest(ctx, pond, provider, path.join(ctx.evidence, `headless-${provider.id}`));
    if (outcome.ok) {
      attempts.push({ provider: provider.id });
      return { facts: { provider: provider.id, attempts, ...(await checkedFacts(outcome.files, expectation)) } };
    }
    attempts.push({ provider: provider.id, refusal: outcome.refusal, detail: outcome.detail });
  }
  if (!software)
    throw new NotRun(
      `no GPU the renderer accepts here: ${attempts[0].detail} (GENEX_REQUIRE_METAL=1 makes this a failure)`,
    );
  return fail(
    SpikeCiCode.NoCompliantSoftwareVulkan,
    `KILL: no WebGPU-compliant software Vulkan adapter: ${JSON.stringify(attempts)}`,
  );
}

// ---- build, FXC, web -----------------------------------------------------------------------

async function stepBuildPond(ctx: Context): Promise<StepOutcome> {
  const args = ["build", "-p", "pond", "--bin", "pond", ...(ctx.profile === BuildProfile.Release ? ["--release"] : [])];
  await requireCargo(ctx, args);
  const pond = requireFile(pondPath(ctx), "the built pond");
  return { facts: { profile: ctx.profile, bytes: (await stat(pond)).size } };
}

async function stepFxc(ctx: Context): Promise<StepOutcome> {
  const run = await cargo(ctx, ["test", "-p", "genex-render", "--test", "dx12_compiler"]);
  if (run.code !== 0) fail(SpikeCiCode.FxcNotExplicit, `genex-render's dx12_compiler test exited ${run.code}`);
  checkCargoTest(run.stdout);
  return { facts: { dx12Compiler: "Fxc", test: "genex-render dx12_compiler" } };
}

const webDir = (ctx: Context) => path.join(ctx.targetDir, "genex-web", "pond-ci");

async function stepWebBuild(ctx: Context): Promise<StepOutcome> {
  const args = [WEB_SH, "--out", webDir(ctx), ...(ctx.profile === BuildProfile.Debug ? ["--debug"] : [])];
  const run = await collect("bash", args, {
    env: { ...ctx.env, CARGO_TARGET_DIR: ctx.targetDir },
    timeoutMs: BUILD_TIMEOUT_MS,
    inheritStderr: true,
  });
  if (run.code !== 0) fail(SpikeCiCode.StepFailed, `web.sh exited ${run.code} (3 is over the gzip budget)`);
  const size = JSON.parse(await readFile(path.join(webDir(ctx), "size.json"), "utf8")) as Record<string, unknown>;
  return { facts: { size } };
}

const SERVED: Record<string, { file: string; type: string }> = {
  "/index.html": { file: "index.html", type: "text/html" },
  "/game.js": { file: "game.js", type: "text/javascript" },
  "/game_bg.wasm": { file: "game_bg.wasm", type: "application/wasm" },
};

interface Served {
  origin: string;
  requests: string[];
  close(): Promise<void>;
}

async function serveFolder(dir: string): Promise<Served> {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(pathname);
    const entry = SERVED[pathname];
    if (!entry) {
      res.writeHead(404).end();
      return;
    }
    readFile(path.join(dir, entry.file)).then(
      (body) => res.writeHead(200, { "content-type": entry.type, "cache-control": "no-store" }).end(body),
      () => res.writeHead(404).end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type Playwright = Pick<typeof import("@playwright/test"), "chromium" | "firefox">;
type Page = import("@playwright/test").Page;
type Browser = import("@playwright/test").Browser;

async function loadPlaywright(): Promise<Playwright> {
  const { chromium, firefox } = await import("@playwright/test");
  return { chromium, firefox };
}

interface ChromiumCandidate {
  label: string;
  channel?: string;
  args: string[];
}

const SOFTWARE_CHROMIUM_ARGS = [
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--use-angle=swiftshader",
  "--use-vulkan=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
];

/** Chromium switch sets to try in order; the one that gets WebGPU is recorded. */
function chromiumCandidates(platform: NodeJS.Platform): ChromiumCandidate[] {
  if (platform === "darwin") {
    return [
      {
        label: "metal",
        args: ["--enable-unsafe-webgpu", "--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
      },
    ];
  }
  return [
    { label: "swiftshader-vulkan", args: SOFTWARE_CHROMIUM_ARGS },
    { label: "swiftshader-webgpu-adapter", args: [...SOFTWARE_CHROMIUM_ARGS, "--use-webgpu-adapter=swiftshader"] },
    { label: "new-headless-swiftshader", channel: "chromium", args: SOFTWARE_CHROMIUM_ARGS },
  ];
}

async function shellStatus(page: Page): Promise<Record<string, unknown>> {
  await page.waitForFunction(
    () => {
      const state = (window as unknown as { GenexShell?: { status: { state: string } } }).GenexShell?.status.state;
      return state !== undefined && state !== "starting";
    },
    undefined,
    { timeout: BOOT_TIMEOUT_MS },
  );
  return page.evaluate(
    () => (window as unknown as { GenexShell: { status: Record<string, unknown> } }).GenexShell.status,
  );
}

async function openShell(browser: Browser, origin: string): Promise<{ page: Page; status: Record<string, unknown> }> {
  const page = await browser.newPage();
  await page.goto(`${origin}/index.html?paused`);
  return { page, status: await shellStatus(page) };
}

interface RawCapture {
  width: number;
  height: number;
  digest: string;
  base64: string;
}

async function captureRaw(page: Page): Promise<RawCapture> {
  return page.evaluate(async () => {
    const studio = (
      window as unknown as {
        __studio: { captureRaw(): Promise<{ width: number; height: number; digest: string; bgra: Uint8Array }> };
      }
    ).__studio;
    const capture = await studio.captureRaw();
    let binary = "";
    for (let i = 0; i < capture.bgra.length; i += 0x8000)
      binary += String.fromCharCode(...capture.bgra.subarray(i, i + 0x8000));
    return { width: capture.width, height: capture.height, digest: capture.digest, base64: btoa(binary) };
  });
}

interface WebAttempt {
  candidate: string;
  state?: unknown;
  error?: string;
}

/** Launch each Chromium candidate until the shell reaches `running`; every attempt is kept. */
async function bootChromium(
  pw: Playwright,
  origin: string,
  attempts: WebAttempt[],
): Promise<{ browser: Browser; page: Page; status: Record<string, unknown>; candidate: ChromiumCandidate } | null> {
  for (const candidate of chromiumCandidates(process.platform)) {
    let browser: Browser | null = null;
    try {
      browser = await pw.chromium.launch({ headless: true, channel: candidate.channel, args: candidate.args });
      const { page, status } = await openShell(browser, origin);
      attempts.push({ candidate: candidate.label, state: status.state });
      if (status.state === "running") return { browser, page, status, candidate };
    } catch (error) {
      attempts.push({ candidate: candidate.label, error: String(error).slice(0, 300) });
    }
    await browser?.close().catch(() => undefined);
  }
  return null;
}

async function nativeRecordOf(ctx: Context): Promise<Record<string, unknown> | null> {
  const headless = path.join(ctx.evidence, `${StepId.HeadlessSoftwareVulkan}.json`);
  if (!existsSync(headless)) return null;
  const facts = JSON.parse(await readFile(headless, "utf8")) as { recordPath?: string };
  return facts.recordPath && existsSync(facts.recordPath)
    ? (JSON.parse(await readFile(facts.recordPath, "utf8")) as Record<string, unknown>)
    : null;
}

async function webProbesMatch(page: Page, native: Record<string, unknown>): Promise<boolean> {
  const web = await page.evaluate(
    ([ticks, seed, demo]) =>
      (
        window as unknown as { __studio: { selfTest(t: number, s: number, d: string): Promise<{ probes: unknown }> } }
      ).__studio.selfTest(ticks as number, seed as number, demo as string),
    [native.ticks, native.seed, native.demo] as const,
  );
  compareProbes(web.probes, native.probes);
  return true;
}

async function stepWebChrome(ctx: Context): Promise<StepOutcome> {
  requireFile(path.join(webDir(ctx), "index.html"), "the web build (web-build runs first)");
  const pw = await loadPlaywright();
  const served = await serveFolder(webDir(ctx));
  const attempts: WebAttempt[] = [];
  try {
    const booted = await bootChromium(pw, served.origin, attempts).catch((error: Error) =>
      fail(SpikeCiCode.ToolMissing, error.message),
    );
    if (!booted)
      return fail(SpikeCiCode.WebGpuUnavailable, `no Chromium switch set got WebGPU: ${JSON.stringify(attempts)}`);
    try {
      checkReceipt(booted.status.receipt, { backends: ["webgpu"], software: false, anonymousAdapter: true });
      const capture = await captureRaw(booted.page);
      const bytes = new Uint8Array(Buffer.from(capture.base64, "base64"));
      if (capture.width !== POND_WORLD.width || capture.height !== POND_WORLD.height)
        fail(SpikeCiCode.BadRecord, `the web capture is ${capture.width}x${capture.height}`);
      if (fnv1a64(bytes) !== capture.digest)
        fail(SpikeCiCode.DigestMismatch, "the web capture's digest is not FNV-1a 64 of its bytes");
      const colours = distinctColours(bytes, NONBLANK_MIN_COLOURS);
      if (colours < NONBLANK_MIN_COLOURS)
        fail(SpikeCiCode.BlankCapture, `the web capture has ${colours} distinct colours`);
      const native = await nativeRecordOf(ctx);
      const parity = native ? await webProbesMatch(booted.page, native) : null;
      return {
        facts: {
          switches: booted.candidate,
          attempts,
          receipt: booted.status.receipt,
          colours,
          digest: capture.digest,
          probeParityWithNative: parity,
        },
      };
    } finally {
      await booted.browser.close();
    }
  } finally {
    await served.close();
  }
}

async function stepWebFirefox(ctx: Context): Promise<StepOutcome> {
  requireFile(path.join(webDir(ctx), "index.html"), "the web build (web-build runs first)");
  const pw = await loadPlaywright();
  let browser: Browser;
  try {
    browser = await pw.firefox.launch({ headless: true });
  } catch (error) {
    if (ctx.local) throw new NotRun(`no Playwright Firefox is installed (${String(error).split("\n")[0]})`);
    return fail(SpikeCiCode.ToolMissing, `Firefox did not start: ${String(error).slice(0, 300)}`);
  }
  const served = await serveFolder(webDir(ctx));
  try {
    const { status } = await openShell(browser, served.origin);
    if (process.platform !== "linux" && status.state === "running") {
      throw new NotRun("this host's Firefox has WebGPU; the unsupported-page row is for Firefox on Linux");
    }
    checkUnsupportedShell(status, served.requests);
    return {
      facts: { browser: browser.version(), platform: process.platform, shellStatus: status, requests: served.requests },
    };
  } finally {
    await browser.close();
    await served.close();
  }
}

// ---- the Electron probe --------------------------------------------------------------------

/** WebGPU's default limits the probe checks the adapter against (a subset that matters to the pond). */
const WEBGPU_DEFAULT_LIMITS: Record<string, number> = {
  maxTextureDimension2D: 8192,
  maxBindGroups: 4,
  maxVertexBuffers: 8,
  maxColorAttachments: 8,
  maxStorageBuffersPerShaderStage: 8,
  maxUniformBufferBindingSize: 65536,
  maxStorageBufferBindingSize: 134217728,
  maxBufferSize: 268435456,
  maxComputeWorkgroupStorageSize: 16384,
  maxComputeInvocationsPerWorkgroup: 256,
};

const ELECTRON_SOFTWARE_SWITCHES = [
  "enable-unsafe-webgpu",
  "enable-features=Vulkan",
  "use-vulkan=swiftshader",
  "use-angle=swiftshader",
  "enable-unsafe-swiftshader",
  "ignore-gpu-blocklist",
];

const electronSwitches = (platform: NodeJS.Platform): string[] =>
  platform === "linux" ? ELECTRON_SOFTWARE_SWITCHES : ["enable-unsafe-webgpu"];

/** The page script: classify navigator.gpu (no-webgpu, no-adapter, below-core, webgpu-core, error). */
const ELECTRON_PAGE_PROBE = `(async () => {
  const defaults = ${JSON.stringify(WEBGPU_DEFAULT_LIMITS)};
  if (!("gpu" in navigator)) return { outcome: "no-webgpu" };
  let adapter = null;
  try { adapter = await navigator.gpu.requestAdapter(); } catch (error) { return { outcome: "error", error: String(error) }; }
  if (!adapter) return { outcome: "no-adapter" };
  const info = adapter.info || {};
  const below = Object.keys(defaults).filter((key) => !(adapter.limits[key] >= defaults[key]));
  const limits = {};
  for (const key of Object.keys(defaults)) limits[key] = adapter.limits[key];
  try { const device = await adapter.requestDevice(); device.destroy(); } catch (error) { return { outcome: "error", error: "requestDevice: " + String(error) }; }
  return {
    outcome: below.length ? "below-core" : "webgpu-core",
    adapter: { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description },
    isFallbackAdapter: adapter.isFallbackAdapter === true,
    limits, below, features: [...adapter.features],
  };
})()`;

/** The Electron main script: apply the switches, open a hidden window, run the page probe, write the JSON. */
const ELECTRON_MAIN = `const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const out = process.env.GENEX_PROBE_OUT;
const switches = JSON.parse(process.env.GENEX_PROBE_SWITCHES);
app.setPath("userData", process.env.GENEX_PROBE_USERDATA);
for (const entry of switches) {
  const at = entry.indexOf("=");
  if (at < 0) app.commandLine.appendSwitch(entry);
  else app.commandLine.appendSwitch(entry.slice(0, at), entry.slice(at + 1));
}
const finish = (result) => {
  fs.writeFileSync(out, JSON.stringify({ ...result, electron: process.versions.electron, chrome: process.versions.chrome }));
  app.exit(0);
};
setTimeout(() => finish({ outcome: "error", error: "the probe timed out" }), ${ELECTRON_TIMEOUT_MS - 15 * SECOND_MS});
app.whenReady().then(async () => {
  try {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
    await window.loadFile(process.env.GENEX_PROBE_PAGE);
    const probe = await window.webContents.executeJavaScript(${JSON.stringify(ELECTRON_PAGE_PROBE)}, true);
    finish({ ...probe, gpuFeatureStatus: app.getGPUFeatureStatus() });
  } catch (error) {
    finish({ outcome: "error", error: String(error) });
  }
});
`;

async function electronAttempt(
  electron: string,
  work: string,
  label: string,
  switches: string[],
  ctx: Context,
): Promise<Record<string, unknown>> {
  const out = path.join(work, `${label}.json`);
  const env: NodeJS.ProcessEnv = {
    ...ctx.env,
    GENEX_PROBE_OUT: out,
    GENEX_PROBE_SWITCHES: JSON.stringify(switches),
    GENEX_PROBE_USERDATA: path.join(work, `userdata-${label}`),
    GENEX_PROBE_PAGE: path.join(work, "probe.html"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  // The runner's chrome-sandbox is not setuid; the .deb's is. The probe judges WebGPU, not the sandbox.
  const noSandbox = process.platform === "linux" ? ["--no-sandbox"] : [];
  const run = await collect(electron, [...noSandbox, path.join(work, "main.cjs")], {
    env,
    timeoutMs: ELECTRON_TIMEOUT_MS,
  });
  if (!existsSync(out))
    return { label, switches, outcome: "error", error: `no result (exit ${run.code}): ${run.stderr.slice(-300)}` };
  const result = JSON.parse(await readFile(out, "utf8")) as Record<string, unknown>;
  return { label, switches, noSandbox: noSandbox.length > 0, ...result };
}

async function pinnedElectronVersion(): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(REPO, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  return String(manifest.devDependencies?.electron ?? "").replace(/^[\^~]/, "");
}

async function stepElectronProbe(ctx: Context): Promise<StepOutcome> {
  const electron = createRequire(import.meta.url)("electron") as unknown;
  if (typeof electron !== "string" || !existsSync(electron)) {
    return fail(
      SpikeCiCode.ToolMissing,
      "the Electron binary is not installed (node node_modules/electron/install.js)",
    );
  }
  const work = await mkdtemp(path.join(os.tmpdir(), "genex-electron-probe-"));
  try {
    await writeFile(path.join(work, "main.cjs"), ELECTRON_MAIN);
    await writeFile(path.join(work, "probe.html"), "<!doctype html><title>probe</title>");
    const attempts = [
      await electronAttempt(electron, work, ElectronAttempt.Without, [], ctx),
      await electronAttempt(electron, work, ElectronAttempt.With, electronSwitches(process.platform), ctx),
    ];
    const result = electronResultOf(attempts as Array<{ outcome: unknown }>);
    const switches = result === ElectronResult.NeedsSwitches ? electronSwitches(process.platform) : [];
    const first = attempts[0] as { electron?: unknown };
    const record = {
      format: ELECTRON_FORMAT,
      electron: first.electron ?? "unknown",
      platform: process.platform,
      attempts,
      result,
      switches,
    };
    checkElectronRecord(record, await pinnedElectronVersion());
    await writeFile(path.join(ctx.evidence, "electron-webgpu.json"), `${JSON.stringify(record, null, 2)}\n`);
    return { facts: { result, switches, record } };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// ---- toolchain, cross builds, Windows ------------------------------------------------------

/** The decoy: Windows loading it writes `<path>.loaded`; wgpu on FXC never loads a dxcompiler.dll. */
const DECOY_SOURCE = `#include <windows.h>
BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID reserved) {
  (void)reserved;
  if (reason == DLL_PROCESS_ATTACH) {
    char path[MAX_PATH + 16];
    DWORD n = GetModuleFileNameA(h, path, MAX_PATH);
    if (n > 0 && n < MAX_PATH) {
      lstrcatA(path, "${DECOY_MARKER_SUFFIX}");
      HANDLE f = CreateFileA(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
      if (f != INVALID_HANDLE_VALUE) CloseHandle(f);
    }
  }
  return TRUE;
}
__declspec(dllexport) long __stdcall DxcCreateInstance(const void *clsid, const void *iid, void **out) {
  (void)clsid; (void)iid; (void)out;
  return (long)0x80004005;
}
`;

const TOOLCHAIN_GROUPS = "wasm,mingw";
/** The reviewed pins table setup-toolchain.sh installs from. */
const COMMITTED_PINS = path.join(REPO, "scripts", "spike", "rust-wgpu", "pins.md");

/**
 * Installs and verifies against the committed pins (`scripts/spike/rust-wgpu/pins.md`) only: CI
 * never pins, so an archive without a reviewed pin, or one whose upstream bytes changed, fails here.
 */
async function stepToolchain(ctx: Context): Promise<StepOutcome> {
  if (ctx.env.GENEX_SPIKE_APPROVALS)
    fail(SpikeCiCode.Usage, "CI installs from the committed pins: unset GENEX_SPIKE_APPROVALS");
  const approvals = COMMITTED_PINS;
  for (const mode of [["--with", TOOLCHAIN_GROUPS], ["--verify"]]) {
    const run = await collect("bash", [SETUP_TOOLCHAIN, ...mode], {
      env: ctx.env,
      timeoutMs: BUILD_TIMEOUT_MS,
      inheritStderr: true,
    });
    if (run.code !== 0) fail(SpikeCiCode.StepFailed, `setup-toolchain.sh ${mode.join(" ")} exited ${run.code}`);
  }
  return { facts: { groups: `rust,${TOOLCHAIN_GROUPS}`, approvals } };
}

async function keep(file: string, destination: string): Promise<{ path: string; bytes: number }> {
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(file, destination);
  return { path: destination, bytes: (await stat(destination)).size };
}

async function buildDecoy(ctx: Context, dir: string): Promise<{ path: string; bytes: number }> {
  const clang = path.join(SPIKE_TOOLCHAIN, "tools", "llvm-mingw", "bin", "x86_64-w64-mingw32-clang");
  requireFile(clang, "llvm-mingw's clang (setup-toolchain.sh --with mingw)");
  await mkdir(dir, { recursive: true });
  const source = path.join(dir, "decoy.c");
  await writeFile(source, DECOY_SOURCE);
  const dll = path.join(dir, DECOY_DLL);
  const run = await collect(
    clang,
    ["-shared", "-O1", "-nostdlib", "-Wl,--entry,DllMain", "-o", dll, source, "-lkernel32"],
    { env: ctx.env },
  );
  await rm(source, { force: true });
  if (run.code !== 0) fail(SpikeCiCode.StepFailed, `the decoy dxcompiler.dll did not build: ${run.stderr.slice(-300)}`);
  return { path: dll, bytes: (await stat(dll)).size };
}

/** Test executables cargo built for the Windows target (the pipe channel's rows, run on the Windows job). */
async function buildWindowsTests(ctx: Context, dir: string, rustflags: NodeJS.ProcessEnv): Promise<string[]> {
  const run = await cargo(
    ctx,
    [
      "test",
      "-p",
      "genex-studio",
      "--release",
      "--no-run",
      "--target",
      WINDOWS_TARGET,
      "--message-format=json-render-diagnostics",
    ],
    rustflags,
  );
  if (run.code !== 0) return [];
  const kept: string[] = [];
  for (const line of run.stdout.split("\n").filter((l) => l.startsWith("{"))) {
    const message = JSON.parse(line) as { reason?: string; executable?: string | null; profile?: { test?: boolean } };
    if (message.reason === "compiler-artifact" && message.executable && message.profile?.test) {
      kept.push((await keep(message.executable, path.join(dir, "tests", path.basename(message.executable)))).path);
    }
  }
  return kept;
}

async function stepCrossBuilds(ctx: Context): Promise<StepOutcome> {
  const windows = path.join(ctx.artifacts, "windows");
  const rustflags = {
    [`CARGO_TARGET_${WINDOWS_TARGET.toUpperCase().replaceAll("-", "_")}_RUSTFLAGS`]: WINDOWS_RUSTFLAGS,
  };
  const windowsBuild = await requireCargo(
    ctx,
    [
      "build",
      "-p",
      "pond",
      "--bin",
      "pond",
      "--release",
      "--target",
      WINDOWS_TARGET,
      "--message-format=json-render-diagnostics",
    ],
    rustflags,
  );
  const pondExe = await keep(cargoArtifact(windowsBuild.stdout, "pond", "pond", "bin"), path.join(windows, "pond.exe"));
  const decoy = await buildDecoy(ctx, path.join(windows, "decoy"));
  const tests = await buildWindowsTests(ctx, windows, rustflags);
  const androidFlags = { CARGO_TARGET_AARCH64_LINUX_ANDROID_RUSTFLAGS: ANDROID_LINK_ARGS };
  const androidBuild = await requireCargo(
    ctx,
    [
      "build",
      "-p",
      "pond",
      "--lib",
      "--bin",
      "pond",
      "--release",
      "--target",
      ANDROID_TARGET,
      "--message-format=json-render-diagnostics",
    ],
    androidFlags,
  );
  const library = cargoArtifact(androidBuild.stdout, "pond", "pond_game", "cdylib");
  const android = await keep(library, path.join(ctx.artifacts, "android", path.basename(library)));
  return {
    facts: {
      windows: {
        target: WINDOWS_TARGET,
        rustflags: WINDOWS_RUSTFLAGS,
        pond: pondExe,
        decoy,
        protocolTestExecutables: tests.length,
      },
      android: { target: ANDROID_TARGET, library: android, ndk: path.basename(ctx.env.ANDROID_NDK_HOME ?? "unknown") },
    },
  };
}

/** The protocol test executables the linux job cross-built, run here (recorded, not blocking: the pipe channel has never run). */
async function runWindowsTests(dir: string, ctx: Context): Promise<Array<{ exe: string; exit: number | null }>> {
  const testsDir = path.join(dir, "tests");
  if (!existsSync(testsDir)) return [];
  const results: Array<{ exe: string; exit: number | null }> = [];
  for (const exe of readdirSync(testsDir).filter((name) => name.endsWith(".exe"))) {
    const run = await collect(path.join(testsDir, exe), [], { env: ctx.env, timeoutMs: RUN_TIMEOUT_MS });
    results.push({ exe, exit: run.code });
  }
  return results;
}

function withPathFront(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  return { ...env, [key]: [dir, env[key]].filter(Boolean).join(path.delimiter) };
}

async function stepWindowsWarp(ctx: Context): Promise<StepOutcome> {
  const dir =
    ctx.windowsDir ??
    ctx.env.GENEX_SPIKE_WINDOWS_DIR ??
    fail(SpikeCiCode.Usage, "--windows-dir (the downloaded cross-build artifact) is required");
  const pond = requireFile(path.join(dir, "pond.exe"), "the gnullvm pond.exe");
  const decoyDir = path.join(dir, "decoy");
  const decoy = requireFile(path.join(decoyDir, DECOY_DLL), "the decoy dxcompiler.dll");
  if ((await stat(decoy)).size === 0)
    fail(SpikeCiCode.ToolMissing, `${decoy} is empty: there is no decoy to test FXC against`);
  await rm(`${decoy}${DECOY_MARKER_SUFFIX}`, { force: true });
  // The application directory comes first in LoadLibrary's search order, then System32, then the
  // working folder, and PATH last: the decoy sits in the first, is the working folder and is first
  // on PATH, so a dxcompiler.dll loaded from any of them marks itself.
  const besideExe = path.join(dir, DECOY_DLL);
  await copyFile(decoy, besideExe);
  await rm(`${besideExe}${DECOY_MARKER_SUFFIX}`, { force: true });
  const env = withPathFront(ctx.env, decoyDir);
  const outcome = await runSelfTest(
    { ...ctx, env },
    pond,
    { id: "warp", env: {} },
    path.join(ctx.evidence, "windows-warp"),
    decoyDir,
  );
  if (!outcome.ok)
    fail(
      SpikeCiCode.WarpNotCompliant,
      `KILL: the gnullvm binary has no WebGPU-compliant D3D12 adapter on this runner: ${outcome.detail}`,
    );
  const facts = await checkedFacts(outcome.files, { backends: ["d3d12"], software: true });
  checkDecoyUnused(decoyDir);
  checkDecoyUnused(dir);
  await rm(besideExe, { force: true });
  const protocolTests = await runWindowsTests(dir, ctx);
  const placed = { dll: decoy, onPath: "first", besideExe, workingFolder: decoyDir };
  return { facts: { ...facts, decoyLoaded: false, decoy: placed, protocolTests } };
}

async function stepLinuxFloor(): Promise<StepOutcome> {
  const reason = STEP_TABLE.find((step) => step.id === StepId.LinuxGlibcFloor)?.deferred ?? "deferred";
  throw new NotRun(`deferred: ${reason}`);
}

// ---- running steps -------------------------------------------------------------------------

const EXECUTORS: Record<StepId, (ctx: Context) => Promise<StepOutcome>> = {
  [StepId.Toolchain]: stepToolchain,
  [StepId.BuildPond]: stepBuildPond,
  [StepId.FxcExplicit]: stepFxc,
  [StepId.HeadlessSoftwareVulkan]: stepHeadless,
  [StepId.WebBuild]: stepWebBuild,
  [StepId.WebChrome]: stepWebChrome,
  [StepId.WebFirefox]: stepWebFirefox,
  [StepId.ElectronProbe]: stepElectronProbe,
  [StepId.CrossBuilds]: stepCrossBuilds,
  [StepId.LinuxGlibcFloor]: stepLinuxFloor,
  [StepId.WindowsWarp]: stepWindowsWarp,
};

interface StepRow {
  id: StepId;
  status: StepStatus;
  code?: SpikeCiCode;
  detail?: string;
}

async function writeRecord(ctx: Context, id: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(ctx.evidence, { recursive: true });
  await writeFile(
    path.join(ctx.evidence, `${id}.json`),
    `${JSON.stringify({ format: FORMAT, step: id, ...record }, null, 2)}\n`,
  );
}

/** Run one step: its record is written whatever happens; a failure is a row, not a throw. */
async function runStep(ctx: Context, spec: StepSpec): Promise<StepRow> {
  const started = Date.now();
  try {
    const outcome = await EXECUTORS[spec.id](ctx);
    await writeRecord(ctx, spec.id, {
      status: StepStatus.Pass,
      title: spec.title,
      ms: Date.now() - started,
      ...outcome.facts,
    });
    return { id: spec.id, status: StepStatus.Pass };
  } catch (error) {
    if (error instanceof NotRun) {
      await writeRecord(ctx, spec.id, { status: StepStatus.NotRun, title: spec.title, detail: error.message });
      return { id: spec.id, status: StepStatus.NotRun, detail: error.message };
    }
    const typed = error instanceof SpikeCiError ? error : new SpikeCiError(SpikeCiCode.StepFailed, String(error));
    await writeRecord(ctx, spec.id, {
      status: StepStatus.Fail,
      title: spec.title,
      ms: Date.now() - started,
      code: typed.code,
      detail: typed.detail,
    });
    return { id: spec.id, status: StepStatus.Fail, code: typed.code, detail: typed.detail };
  }
}

// ---- command line --------------------------------------------------------------------------

interface Options {
  mode: "table" | "check-workflow" | "step" | "local";
  value: string | null;
  only: string[] | null;
  skip: string[];
  evidence: string | null;
  artifacts: string | null;
  pond: string | null;
  ticks: number | null;
  profile: BuildProfile | null;
  vulkan: VulkanSource | null;
  windowsDir: string | null;
}

const VALUE_FLAGS = [
  "--step",
  "--check-workflow",
  "--only",
  "--skip",
  "--evidence",
  "--artifacts",
  "--pond",
  "--ticks",
  "--profile",
  "--vulkan",
  "--windows-dir",
];

function parseArgs(args: string[]): Options {
  const options: Options = {
    mode: "local",
    value: null,
    only: null,
    skip: [],
    evidence: null,
    artifacts: null,
    pond: null,
    ticks: null,
    profile: null,
    vulkan: null,
    windowsDir: null,
  };
  let chosen = false;
  const choose = (mode: Options["mode"]) => {
    if (chosen) fail(SpikeCiCode.Usage, "one of --table, --check-workflow, --step, --local");
    chosen = true;
    options.mode = mode;
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--table") choose("table");
    else if (flag === "--local") choose("local");
    else if (VALUE_FLAGS.includes(flag)) {
      const value = args[++i] ?? fail(SpikeCiCode.Usage, `${flag} needs a value`);
      assignValue(options, flag, value, choose);
    } else fail(SpikeCiCode.Usage, `unknown argument ${flag}`);
  }
  if (!chosen) fail(SpikeCiCode.Usage, "one of --table, --check-workflow, --step, --local");
  return options;
}

function assignValue(options: Options, flag: string, value: string, choose: (mode: Options["mode"]) => void): void {
  const list = () => value.split(",").filter(Boolean);
  const oneOf = <T extends string>(allowed: readonly T[]): T =>
    (allowed as readonly string[]).includes(value)
      ? (value as T)
      : fail(SpikeCiCode.Usage, `${flag} is one of ${allowed.join(", ")}`);
  switch (flag) {
    case "--step":
      choose("step");
      options.value = value;
      break;
    case "--check-workflow":
      choose("check-workflow");
      options.value = value;
      break;
    case "--only":
      options.only = list();
      break;
    case "--skip":
      options.skip = list();
      break;
    case "--evidence":
      options.evidence = value;
      break;
    case "--artifacts":
      options.artifacts = value;
      break;
    case "--pond":
      options.pond = value;
      break;
    case "--ticks": {
      const ticks = Number(value);
      options.ticks =
        Number.isInteger(ticks) && ticks > 0 ? ticks : fail(SpikeCiCode.Usage, "--ticks needs a whole number");
      break;
    }
    case "--profile":
      options.profile = oneOf<BuildProfile>(Object.values(BuildProfile));
      break;
    case "--vulkan":
      options.vulkan = oneOf<VulkanSource>(Object.values(VulkanSource));
      break;
    default:
      options.windowsDir = value;
  }
}

function contextOf(options: Options): Context {
  const local = options.mode === "local";
  const targetDir = process.env.CARGO_TARGET_DIR ?? path.join(REPO, ".studio-dev", "cargo-target");
  return {
    evidence: path.resolve(options.evidence ?? path.join(REPO, ".studio-dev", "evidence", "rust-spike-ci")),
    artifacts: path.resolve(options.artifacts ?? path.join(REPO, ".studio-dev", "ci", "artifacts")),
    targetDir,
    pond: options.pond ? path.resolve(options.pond) : null,
    ticks: options.ticks ?? (local ? DEFAULT_TICKS_LOCAL : DEFAULT_TICKS_CI),
    profile: options.profile ?? (local ? BuildProfile.Debug : BuildProfile.Release),
    vulkan: options.vulkan ?? (local ? VulkanSource.Host : VulkanSource.Software),
    windowsDir: options.windowsDir ? path.resolve(options.windowsDir) : null,
    local,
    env: process.env,
  };
}

function selectSteps(options: Options): StepSpec[] {
  const known = new Set<string>(STEP_TABLE.map((step) => step.id));
  for (const id of [...(options.only ?? []), ...options.skip]) if (!known.has(id)) fail(SpikeCiCode.UnknownStep, id);
  return STEP_TABLE.filter(
    (step) =>
      (options.only ? options.only.includes(step.id) : step.job === Job.Linux) && !options.skip.includes(step.id),
  );
}

async function runLocal(options: Options): Promise<number> {
  const ctx = contextOf(options);
  const rows: StepRow[] = [];
  for (const spec of selectSteps(options)) {
    if (!spec.local) {
      const detail = spec.localNotRun ?? "not run locally";
      await writeRecord(ctx, spec.id, { status: StepStatus.NotRun, title: spec.title, detail });
      rows.push({ id: spec.id, status: StepStatus.NotRun, detail });
    } else {
      rows.push(await runStep(ctx, spec));
    }
    const row = rows[rows.length - 1];
    process.stderr.write(`rust-spike: ${row.id}: ${row.status}${row.detail ? ` (${row.detail})` : ""}\n`);
  }
  const failed = rows.some((row) => row.status === StepStatus.Fail);
  await writeRecord(ctx, "summary", { status: failed ? StepStatus.Fail : StepStatus.Pass, rows });
  return failed ? FAIL_EXIT : 0;
}

async function runOneStep(options: Options): Promise<number> {
  const spec =
    STEP_TABLE.find((step) => step.id === options.value) ?? fail(SpikeCiCode.UnknownStep, String(options.value));
  const row = await runStep(contextOf(options), spec);
  if (row.status === StepStatus.Fail) fail(row.code ?? SpikeCiCode.StepFailed, row.detail ?? "");
  process.stderr.write(`rust-spike: ${row.id}: ${row.status}${row.detail ? ` (${row.detail})` : ""}\n`);
  return 0;
}

async function main(args: string[]): Promise<number> {
  const options = parseArgs(args);
  switch (options.mode) {
    case "table":
      process.stdout.write(`${JSON.stringify(STEP_TABLE, null, 2)}\n`);
      return 0;
    case "check-workflow":
      checkWorkflow(await readFile(String(options.value), "utf8"));
      return 0;
    case "step":
      return runOneStep(options);
    default:
      return runLocal(options);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      const typed = error instanceof SpikeCiError ? error : new SpikeCiError(SpikeCiCode.StepFailed, String(error));
      process.stderr.write(`${REFUSAL_PREFIX}${JSON.stringify({ code: typed.code, detail: typed.detail })}\n`);
      process.exit(FAIL_EXIT);
    },
  );
}
