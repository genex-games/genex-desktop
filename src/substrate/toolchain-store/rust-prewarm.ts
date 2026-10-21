/**
 * Prewarming a Rust · wgpu lock: the dependency closure of a warm project built once per (lock,
 * destination) so a game's build compiles only its own crate. The host's own destination and the
 * web are prewarmed eagerly, the rest when first wanted ({@link rustPrewarmPlan}).
 *
 * - Every cargo run is `--offline --locked` (a lock-less warm project is resolved once with
 *   `generate-lockfile --offline` against the vendored tree), under the injected sandbox `run`
 *   with the network off and only its staging folder writable ({@link rustPrewarmPolicy}), with
 *   its own CARGO_HOME and TMPDIR in staging and the store's sysroot (`rustEnv`).
 * - A step is held to the plan's kill line, {@link RUST_PREWARM_STEP_TIMEOUT_MS}, on the injected
 *   clock: one that ran longer fails the receipt even when cargo finished, and one the sandbox
 *   timed out fails too. Nothing is swapped in after a failure.
 * - What was built is located through Cargo's JSON messages (`cargoOutputs`), never the target
 *   folder's layout: an artifact outside the target folder, or one Cargo named but that is not
 *   there, refuses the prewarm. The record (`rust-prewarm.json`) lists them, with each step's time
 *   and the flags the dependencies were built with.
 * - Builds and worktrees never write the prewarmed folder: each gets a copy-on-write clone
 *   ({@link cloneRustTarget}), every file its own inode with its timestamps, so cargo reads the
 *   dependencies as fresh and a write to the clone never reaches the store.
 * - The host's prewarm can also build the naga validator ({@link NAGA_CHECK_MAIN_RS}) from the
 *   vendored naga, wgpu-types and wgpu-naga-bridge: WGSL is validated host-side as a sandboxed
 *   store tool against WebGPU core plus the declared native-enhanced features ({@link validateWgsl}).
 *   It stands in for naga-cli, which is not in the vendored closure. The same step builds the
 *   crash symbolicator ({@link SYMBOLICATE_MAIN_RS}) from the vendored addr2line, object, gimli
 *   and rustc-demangle (`core/crash-symbolicate.ts` runs it).
 * - {@link recordRustSizes} writes the size receipt, each file's bytes counted once.
 */
import { constants as FS } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { BuildTarget } from "../../shared/game-project.ts";
import type { NativeEnhancedFeature } from "../../shared/native-contract.ts";
import {
  ToolchainError,
  ToolchainHost,
  ToolchainId,
  type ToolchainLock,
  ToolchainProblem,
} from "../../shared/toolchain.ts";
import { atomicWriteJson, isJsonObject } from "../fsx.ts";
import { isInside } from "../paths.ts";
import { type RunRequest, type RunResult, type SandboxPolicy, shellQuote } from "../spawn.ts";
import { STAGING_FOLDER, removeEmptyStaging } from "./install.ts";
import { componentFolder, lockFolder } from "./locate.ts";
import { isToolchainLock, LOCKS_FOLDER, storeLockPaths } from "./lock.ts";
import {
  CargoReason,
  type CargoMessage,
  cargoOutputs,
  type LocatedRust,
  locateRust,
  NAGA_CHECK_TOOL,
  parseCargoMessages,
  RUST_PREWARM_FILE,
  RUST_SIZES_FILE,
  RUST_TARGET_DIR,
  RUST_TRIPLE,
  RUST_WARM_LOCK_FILE,
  type RustPrewarmRecord,
  type RustPrewarmStepRecord,
  readRustBase,
  readRustPrewarm,
  RUST_DEV_PROFILE_SETTINGS,
  rustCargoHome,
  rustEnv,
  rustPrewarmedTargetDir,
  rustSysroot,
  rustTargetFolder,
  rustToolsFolder,
  SYMBOLICATE_TOOL,
} from "./rust-locate.ts";

const MESSAGE = {
  NoStore: (store: string) => `The toolchain store ${store} does not exist.`,
  BadLock: "The lock is malformed, or its digest is not its entries'.",
  NoBase: "The Rust sysroot for this lock is not installed; install the Rust base first.",
  NoStd: (triple: string) => `The lock's sysroot has no standard library for ${triple}.`,
  Missing: (ids: readonly string[]) => `The store is missing ${ids.join(", ")} for this lock.`,
  BadSource: (rel: string) => `The warm project names ${rel}, which is not a plain relative path.`,
  TooSlow: (label: string, ms: number) =>
    `${label} took ${Math.ceil(ms / SECOND_MS)} s, past the ${RUST_PREWARM_STEP_TIMEOUT_MS / MINUTE_MS} minutes a cold prewarm step may take.`,
  TimedOut: (label: string) =>
    `${label} did not finish within the ${RUST_PREWARM_STEP_TIMEOUT_MS / MINUTE_MS} minutes a cold prewarm step may take.`,
  StepFailed: (label: string, code: number | null, detail: string) => `${label} failed (exit ${code}): ${detail}`,
  MissingOutput: (rel: string) => `Cargo reported ${rel}, but the prewarm did not leave it in the target folder.`,
  NoTool: "The naga validator was not built.",
  NoSymbolicate: "The crash symbolicator was not built.",
  NotPrewarmed: (target: string) => `The ${target} dependency build is not prewarmed for this lock.`,
  Exists: (to: string) => `${to} already exists; a clone goes to a new folder.`,
  NoParent: (to: string) => `The folder ${path.dirname(to)} a clone goes into does not exist.`,
  InStore: (to: string) => `${to} is inside the toolchain store; a clone goes to a build's or a worktree's own folder.`,
  NotRegular: (rel: string) => `${rel} in the prewarmed target folder is a link or a special file; it is never cloned.`,
} as const;

/** The plan's kill line: a cold prewarm step that takes longer fails the receipt (and M0a's gate). */
export const RUST_PREWARM_STEP_TIMEOUT_MS = 10 * MINUTE_MS;
/** The plan's budget for the eager store of one profile: the Rust components, base, tools and eager prewarms. */
export const RUST_EAGER_STORE_BUDGET_BYTES = 6 * 1000 ** 3;
/** One naga validation of one WGSL file. */
const NAGA_TIMEOUT_MS = 30 * SECOND_MS;
const STEP_DETAIL_MAX_CHARS = 2000;

/** The labels of the sandbox runs a Rust prewarm makes, in order. */
export const RustPrewarmStep = {
  Lockfile: "rust-prewarm:lockfile",
  Check: "rust-prewarm:check",
  Build: "rust-prewarm:build",
  NagaLockfile: "rust-prewarm:naga-lockfile",
  NagaBuild: "rust-prewarm:naga-build",
  SymbolicateLockfile: "rust-prewarm:symbolicate-lockfile",
  SymbolicateBuild: "rust-prewarm:symbolicate-build",
} as const;
export type RustPrewarmStep = (typeof RustPrewarmStep)[keyof typeof RustPrewarmStep];

/** The label of a naga validation run. */
export const RustToolStep = {
  NagaValidate: "rust-tool:naga-validate",
  Symbolicate: "rust-tool:symbolicate",
} as const;
export type RustToolStep = (typeof RustToolStep)[keyof typeof RustToolStep];

/** The cargo modes a prewarm warms, in order: the agents' `cargo check` and the lane's build. */
const WARM_MODES = [
  { label: RustPrewarmStep.Check, subcommand: "check" },
  { label: RustPrewarmStep.Build, subcommand: "build" },
] as const;

/** The project whose dependency closure is prewarmed: what a game's build will ask for. */
export interface RustWarmProject {
  /** `Cargo.toml`, as the lane's writer (`rust-manifest.ts` `cargoManifest`) writes a game's. */
  manifest: string;
  /** `Cargo.lock`, or null to resolve it offline against the vendored tree. */
  lock: string | null;
  /** Project-relative source files (`src/main.rs` at least). */
  sources: Readonly<Record<string, string>>;
}

/** What a Rust prewarm is given: the sandbox, what it must never write, the clock and the flags. */
export interface RustPrewarmDeps {
  run: (request: RunRequest) => Promise<RunResult>;
  /** Folders no prewarm command may write besides the store: the games root, scratch and runs. */
  denyWrite: readonly string[];
  now?: () => number;
  signal?: AbortSignal;
  onStep?: (label: string, result: RunResult) => void;
  /**
   * The compiler flags of every build that will clone this prewarm (`CARGO_ENCODED_RUSTFLAGS`):
   * other flags are another dependency build. Default: none.
   */
  rustflags?: readonly string[];
  /** Also build the store's host tools (the naga validator, the crash symbolicator); the host's own destination does. Default: false. */
  tools?: boolean;
}

/** The staging subfolders of one prewarm. */
const Staged = {
  /** What is swapped in as the destination's folder: `target/`, `Cargo.lock`, the record. */
  Out: "out",
  Warm: "warm",
  CargoHome: "cargo-home",
  Tmp: ".tmp",
  ToolsBuild: "tools-build",
  Tools: "tools",
} as const;

// ---------- plan and policy ----------

/** Per store host: the destinations prewarmed at setup and those prewarmed when first wanted. */
const RUST_PREWARM_BY_HOST = {
  [ToolchainHost.MacArm64]: {
    eager: [BuildTarget.Mac, BuildTarget.Web],
    lazy: [BuildTarget.Ios, BuildTarget.Android, BuildTarget.Windows, BuildTarget.Linux],
  },
  [ToolchainHost.LinuxX64]: {
    eager: [BuildTarget.Linux, BuildTarget.Web],
    lazy: [BuildTarget.Windows, BuildTarget.Android],
  },
  // Windows x64 builds no Rust game until a per-run sandbox write grant exists (plan: cross-compile).
  [ToolchainHost.WindowsX64]: { eager: [], lazy: [] },
} as const satisfies Record<ToolchainHost, { eager: readonly BuildTarget[]; lazy: readonly BuildTarget[] }>;

/** The destinations `host` prewarms eagerly (its own and the web) and lazily; none off a store host. */
export function rustPrewarmPlan(host: ToolchainHost | null): { eager: BuildTarget[]; lazy: BuildTarget[] } {
  if (!host) return { eager: [], lazy: [] };
  const plan = RUST_PREWARM_BY_HOST[host];
  return { eager: [...plan.eager], lazy: [...plan.lazy] };
}

/**
 * The sandbox overlay of every Rust prewarm and base probe: no network, write only `staging`,
 * never `denyWrite`, the store's installs, its lock folders, any stack's current lock or the lock
 * records. The store itself is not denied whole: a deny beats the staging allow beneath it, so a
 * caller's deny that holds the staging (the checkout around a developer's dev store) is dropped.
 */
export function rustPrewarmPolicy(
  store: string,
  staging: string,
  denyWrite: readonly string[],
): Partial<SandboxPolicy> {
  return {
    allowedDomains: [],
    allowWrite: [staging],
    denyWrite: [
      ...denyWrite.filter((deny) => !isInside(deny, staging)),
      ...Object.values(ToolchainId).map((id) => path.join(store, id)),
      path.join(store, LOCKS_FOLDER),
      ...storeLockPaths(store),
    ],
  };
}

// ---------- one prewarm ----------

interface RustPrewarming {
  root: string;
  lock: ToolchainLock;
  target: BuildTarget;
  located: LocatedRust;
  staging: string;
  deps: RustPrewarmDeps;
  steps: RustPrewarmStepRecord[];
}

/** Everything checked before a step runs: the store, the lock, the base and its standard library, the components. */
async function prepare(
  store: string,
  lock: ToolchainLock,
  target: BuildTarget,
  deps: RustPrewarmDeps,
): Promise<RustPrewarming> {
  const root = await realpath(store).catch(() => {
    throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoStore(store));
  });
  if (!isToolchainLock(lock)) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.BadLock);
  const base = await readRustBase(root, lock);
  if (!base) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoBase);
  const triple = RUST_TRIPLE[target];
  if (!base.triples.includes(triple)) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoStd(triple));
  const found = await locateRust(root, lock, target, { prewarm: false, components: PREWARM_COMPONENTS });
  if (!found.ok) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.Missing(found.missing));
  const staging = path.join(root, STAGING_FOLDER, `${lock.digest}-${target}`);
  return { root, lock, target, located: found.located, staging, deps, steps: [] };
}

/** What a dependency build needs beyond the base's standard libraries: the browser's glue tools come later. */
const PREWARM_COMPONENTS = [ToolchainId.Rust, ToolchainId.RustVendor] as const;

/** A command that keeps its temporary files in `tmp` (the sandbox's own `TMPDIR` is denied here). */
function withTmp(tmp: string, argv: readonly string[]): string {
  const dir = shellQuote(tmp);
  return `export TMPDIR=${dir} TMP=${dir} TEMP=${dir}; ${argv.map(shellQuote).join(" ")}`;
}

/** The environment of a cargo run in staging: the store's sysroot, the run's own CARGO_HOME, target folder and flags. */
function cargoEnv(context: RustPrewarming, targetDir: string, rustflags: readonly string[]): Record<string, string> {
  return {
    ...rustEnv(context.located),
    CARGO_HOME: path.join(context.staging, Staged.CargoHome),
    CARGO_TARGET_DIR: targetDir,
    CARGO_ENCODED_RUSTFLAGS: rustflags.join("\u001f"),
  };
}

/** The last characters of what cargo said on a failure: its rendered diagnostics, then stdout. */
function failureDetail(result: RunResult): string {
  const said = result.stderr.trim() || result.stdout.trim();
  return said.slice(-STEP_DETAIL_MAX_CHARS);
}

/** Runs one cargo step under the sandbox, timed on the injected clock and held to the kill line. */
async function runCargo(
  context: RustPrewarming,
  label: RustPrewarmStep,
  args: readonly string[],
  env: Record<string, string>,
): Promise<CargoMessage[]> {
  const { deps, staging } = context;
  const now = deps.now ?? Date.now;
  const started = now();
  const result = await deps.run({
    label,
    command: withTmp(path.join(staging, Staged.Tmp), [context.located.cargo, ...args]),
    cwd: staging,
    env,
    timeoutMs: RUST_PREWARM_STEP_TIMEOUT_MS,
    policy: rustPrewarmPolicy(context.root, staging, deps.denyWrite),
    signal: deps.signal,
    reapGroup: true,
  });
  const ms = now() - started;
  deps.onStep?.(label, result);
  deps.signal?.throwIfAborted();
  if (result.timedOut) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.TimedOut(label));
  if (ms > RUST_PREWARM_STEP_TIMEOUT_MS) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.TooSlow(label, ms));
  if (result.code !== 0)
    throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.StepFailed(label, result.code, failureDetail(result)));
  context.steps.push({ label, ms });
  return parseCargoMessages(result.stdout);
}

/** Writes a project's files under `folder`, refusing a path that is not plain and relative. */
async function writeProject(folder: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [rel, text] of Object.entries(files)) {
    const segments = rel.split("/");
    const plain = segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
    if (!plain || path.isAbsolute(rel) || rel.includes("\\"))
      throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.BadSource(rel));
    const file = path.join(folder, ...segments);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}

/** The arguments of one warm cargo mode for the destination's triple. */
function modeArgs(subcommand: string, manifest: string, triple: string): string[] {
  const json = "--message-format=json-render-diagnostics";
  const profile = RUST_DEV_PROFILE_SETTINGS.flatMap((setting) => ["--config", setting]);
  return [subcommand, "--offline", "--locked", "--manifest-path", manifest, "--target", triple, json, ...profile];
}

/** Every output Cargo named is in the staged target folder. */
async function assertOutputs(targetDir: string, outputs: readonly string[]): Promise<void> {
  for (const rel of outputs) {
    const info = await lstat(path.join(targetDir, ...rel.split("/"))).catch(() => null);
    if (!info) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.MissingOutput(rel));
  }
}

/** Builds the warm project's dependency closure in staging; answers its located outputs and unit count. */
async function warmBuild(context: RustPrewarming, project: RustWarmProject) {
  const warm = path.join(context.staging, Staged.Warm);
  const manifest = path.join(warm, "Cargo.toml");
  const targetDir = path.join(context.staging, Staged.Out, RUST_TARGET_DIR);
  const env = cargoEnv(context, targetDir, context.deps.rustflags ?? []);
  await writeProject(warm, { ...project.sources, "Cargo.toml": project.manifest });
  if (project.lock === null)
    await runCargo(
      context,
      RustPrewarmStep.Lockfile,
      ["generate-lockfile", "--offline", "--manifest-path", manifest],
      env,
    );
  else await writeFile(path.join(warm, RUST_WARM_LOCK_FILE), project.lock);
  const messages: CargoMessage[] = [];
  for (const mode of WARM_MODES)
    messages.push(
      ...(await runCargo(context, mode.label, modeArgs(mode.subcommand, manifest, context.located.triple), env)),
    );
  const warmPackage = `path+${pathUrl(warm)}`;
  const located = cargoOutputs(messages, targetDir, (id) => id.startsWith(warmPackage));
  await assertOutputs(targetDir, located.outputs);
  await copyFile(path.join(warm, RUST_WARM_LOCK_FILE), path.join(context.staging, Staged.Out, RUST_WARM_LOCK_FILE));
  return { ...located, targetDir };
}

/** A folder as the `file://` URL cargo's package ids spell it. */
function pathUrl(folder: string): string {
  return `file://${folder.split(path.sep).join("/")}`;
}

/** Renames staging's `from` over `to`, putting a previous one back if the rename fails. */
async function swapFolder(from: string, to: string): Promise<void> {
  await mkdir(path.dirname(to), { recursive: true });
  const previous = `${from}.previous`;
  const had = await lstat(to).then(
    () => true,
    () => false,
  );
  if (had) await rename(to, previous);
  try {
    await rename(from, to);
  } catch (error) {
    if (had) await rename(previous, to);
    throw error;
  }
  if (had) await rm(previous, { recursive: true, force: true });
}

/**
 * Prewarms `lock`'s dependency build for `target` from `project` and swaps it in as the
 * destination's folder (`targets/<target>/`), leaving other destinations as they are; with
 * `tools`, also builds the naga validator into the lock's tools folder. Answers the record.
 * A refusal (`prewarm`) leaves the store as it was.
 */
export async function prewarmRust(
  store: string,
  lock: ToolchainLock,
  target: BuildTarget,
  project: RustWarmProject,
  deps: RustPrewarmDeps,
): Promise<RustPrewarmRecord> {
  const context = await prepare(store, lock, target, deps);
  const { staging, root } = context;
  await rm(staging, { recursive: true, force: true });
  await mkdir(path.join(staging, Staged.Tmp), { recursive: true });
  try {
    await mkdir(path.join(staging, Staged.CargoHome), { recursive: true });
    await copyFile(
      path.join(rustCargoHome(root, lock), "config.toml"),
      path.join(staging, Staged.CargoHome, "config.toml"),
    );
    const built = await warmBuild(context, project);
    if (deps.tools) for (const tool of HOST_TOOLS) await buildTool(context, tool);
    const record: RustPrewarmRecord = {
      schema: 1,
      lock: lock.digest,
      target,
      triple: context.located.triple,
      rustflags: [...(deps.rustflags ?? [])],
      steps: context.steps,
      outputs: built.outputs,
      units: built.units,
      bytes: await diskBytes([built.targetDir], new Set()),
      at: new Date((deps.now ?? Date.now)()).toISOString(),
    };
    await writeFile(path.join(staging, Staged.Out, RUST_PREWARM_FILE), `${JSON.stringify(record, null, 2)}\n`);
    if (deps.tools) await swapFolder(path.join(staging, Staged.Tools), rustToolsFolder(root, lock));
    await swapFolder(path.join(staging, Staged.Out), rustTargetFolder(root, lock, target));
    return record;
  } catch (error) {
    deps.signal?.throwIfAborted();
    if (error instanceof ToolchainError) throw error;
    throw new ToolchainError(ToolchainProblem.Prewarm, String(error));
  } finally {
    await rm(staging, { recursive: true, force: true });
    await removeEmptyStaging(root);
  }
}

// ---------- the naga validator ----------

/**
 * The naga validator's source: one WGSL file validated by naga 30 against WebGPU core
 * (`DownlevelFlags::compliant()`, no native features) plus the native-enhanced features named
 * with `--feature` (the `NativeEnhancedFeature` wire names), through wgpu's own mapping
 * (`wgpu_naga_bridge::create_validator`), so it refuses what wgpu would. It prints one JSON line:
 * `{"ok":true}`, or `{"ok":false,"stage":…,"message":…,"line":…,"column":…}`.
 */
export const NAGA_CHECK_MAIN_RS = `//! Written by Genex (rust-prewarm.ts). Do not edit: the store rebuilds it.
use std::process::ExitCode;

use wgpu_types::{DownlevelFlags, Features};

fn feature(name: &str) -> Option<Features> {
    let features = match name {
        "shader-int64-atomic-min-max" => Features::SHADER_INT64 | Features::SHADER_INT64_ATOMIC_MIN_MAX,
        "shader-int64-atomic-all-ops" => Features::SHADER_INT64 | Features::SHADER_INT64_ATOMIC_ALL_OPS,
        "subgroup" => Features::SUBGROUP | Features::SUBGROUP_BARRIER,
        "ray-query" => Features::EXPERIMENTAL_RAY_QUERY,
        "mesh-shader" => Features::EXPERIMENTAL_MESH_SHADER,
        "texture-binding-array" => {
            Features::TEXTURE_BINDING_ARRAY | Features::SAMPLED_TEXTURE_AND_STORAGE_BUFFER_ARRAY_NON_UNIFORM_INDEXING
        }
        "multi-draw-indirect-count" => Features::MULTI_DRAW_INDIRECT_COUNT,
        _ => return None,
    };
    Some(features)
}

fn quoted(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\\\\""),
            '\\\\' => out.push_str("\\\\\\\\"),
            '\\n' => out.push_str("\\\\n"),
            '\\r' => out.push_str("\\\\r"),
            '\\t' => out.push_str("\\\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn refuse(stage: &str, message: &str, at: Option<(u32, u32)>) -> ExitCode {
    let (line, column) = match at {
        Some((line, column)) => (line.to_string(), column.to_string()),
        None => ("null".to_string(), "null".to_string()),
    };
    println!(
        "{{\\"ok\\":false,\\"stage\\":{},\\"message\\":{},\\"line\\":{},\\"column\\":{}}}",
        quoted(stage),
        quoted(message),
        line,
        column
    );
    ExitCode::from(1)
}

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let Some(file) = args.next() else {
        return refuse("usage", "genex-naga-check <file.wgsl> [--feature <name>]...", None);
    };
    let mut features = Features::empty();
    while let Some(arg) = args.next() {
        let named = if arg == "--feature" { args.next().as_deref().and_then(feature) } else { None };
        match named {
            Some(found) => features |= found,
            None => return refuse("usage", &format!("unknown argument or feature after {arg}"), None),
        }
    }
    let source = match std::fs::read_to_string(&file) {
        Ok(source) => source,
        Err(error) => return refuse("read", &error.to_string(), None),
    };
    let module = match naga::front::wgsl::parse_str(&source) {
        Ok(module) => module,
        Err(error) => {
            let at = error.location(&source).map(|at| (at.line_number, at.line_position));
            return refuse("parse", &error.emit_to_string(&source), at);
        }
    };
    let flags = naga::valid::ValidationFlags::all();
    let mut validator = wgpu_naga_bridge::create_validator(features, DownlevelFlags::compliant(), flags);
    match validator.validate(&module) {
        Ok(_) => {
            println!("{{\\"ok\\":true}}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            let at = error.location(&source).map(|at| (at.line_number, at.line_position));
            refuse("validate", &error.emit_to_string(&source), at)
        }
    }
}
`;

/** The naga validator's manifest: the vendored crates wgpu 30 validates with, nothing else. */
const NAGA_CHECK_MANIFEST = `[package]
name = "${NAGA_CHECK_TOOL}"
version = "0.0.0"
edition = "2024"
publish = false

[dependencies]
naga = { version = "=30.0.1", features = ["wgsl-in"] }
wgpu-naga-bridge = "=30.0.1"
wgpu-types = { version = "=30.0.1", default-features = false, features = ["std"] }

[profile.release]
debug = false
`;

/** The executable a build's messages name for `name`'s binary. */
function executableNamed(messages: readonly CargoMessage[], name: string): string | null {
  for (const message of messages) {
    const ours = message.reason === CargoReason.CompilerArtifact && message.packageId.includes(name);
    if (ours && message.executable) return message.executable;
  }
  return null;
}

// ---------- the crash symbolicator ----------

/**
 * The crash symbolicator's source: a crash record's raw frames named from the build's own debug
 * files (addr2line over object and gimli), the image's slide found from the anchor symbol, a
 * Mach-O Live build followed through its debug map into its object files, and a web export's
 * function indexes named from its symbol map. It reads only files under the roots the request
 * names and prints one JSON line.
 */
export const SYMBOLICATE_MAIN_RS = `//! Written by Genex (rust-prewarm.ts). Do not edit: the store rebuilds it.
//!
//! genex-symbolicate: names a crash record's raw frames from the build's own debug files. The
//! request comes on stdin, one directive per line (the host writes it; nothing in it comes from
//! the record but numbers):
//!   root <path>            a folder the tool may read under (every file it opens must be inside one)
//!   debug <path>           a debug file: the executable, its unstripped copy or a dSYM's DWARF file
//!   anchor <symbol> <hex>  the anchor function's demangled path and its runtime address
//!   frame <hex>            a frame's runtime address (a return address), top first
//!   map <path>             a web export's symbol map (wasm-opt --symbolmap: index:name lines)
//!   func <index>           a wasm frame's function index
//! It prints one JSON line: {"ok":true,"frames":[…],"funcs":[…]}, or
//! {"ok":false,"stage":…,"message":…}. A Mach-O executable whose DWARF stayed in the object
//! files (a Live build) is followed through its debug map (N_OSO) into those object files,
//! each read only when it is under a root.
use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use addr2line::gimli;
use object::{Object, ObjectSection, ObjectSymbol, SectionKind};

type Reader = gimli::EndianSlice<'static, gimli::RunTimeEndian>;
type Context = addr2line::Context<Reader>;

/// The most frames and wasm functions one request may name.
const FRAMES_MAX: usize = 256;
/// The most inlined functions one frame lists.
const INLINED_MAX: usize = 16;
/// The biggest file the tool reads.
const FILE_MAX_BYTES: u64 = 1 << 31;
/// The biggest request the tool reads from stdin.
const REQUEST_MAX_BYTES: u64 = 64 * 1024;

#[derive(Default)]
struct Request {
    roots: Vec<PathBuf>,
    debug: Vec<PathBuf>,
    anchor: Option<(String, u64)>,
    frames: Vec<u64>,
    map: Option<PathBuf>,
    funcs: Vec<u32>,
}

fn quoted(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\\\\""),
            '\\\\' => out.push_str("\\\\\\\\"),
            '\\n' => out.push_str("\\\\n"),
            '\\r' => out.push_str("\\\\r"),
            '\\t' => out.push_str("\\\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn optional_text(text: Option<&str>) -> String {
    text.map_or_else(|| "null".to_string(), quoted)
}

fn optional_number(number: Option<u32>) -> String {
    number.map_or_else(|| "null".to_string(), |n| n.to_string())
}

fn refuse(stage: &str, message: &str) -> ExitCode {
    println!("{{\\"ok\\":false,\\"stage\\":{},\\"message\\":{}}}", quoted(stage), quoted(message));
    ExitCode::from(1)
}

fn hex(text: &str) -> Option<u64> {
    u64::from_str_radix(text.strip_prefix("0x")?, 16).ok()
}

/// The request, or why it is not one.
fn parse_request(text: &str) -> Result<Request, String> {
    let mut request = Request::default();
    for line in text.lines().filter(|line| !line.is_empty()) {
        let (directive, rest) = line.split_once(' ').ok_or_else(|| format!("no argument: {line}"))?;
        match directive {
            "root" => {
                let root = std::fs::canonicalize(rest).map_err(|error| format!("root {rest}: {error}"))?;
                request.roots.push(root);
            }
            "debug" => request.debug.push(PathBuf::from(rest)),
            "map" => request.map = Some(PathBuf::from(rest)),
            "anchor" => {
                let (symbol, ip) = rest.rsplit_once(' ').ok_or("anchor needs a symbol and an address")?;
                let ip = hex(ip).ok_or_else(|| format!("anchor address {ip} is not hex"))?;
                request.anchor = Some((symbol.to_string(), ip));
            }
            "frame" => request.frames.push(hex(rest).ok_or_else(|| format!("frame {rest} is not hex"))?),
            "func" => request.funcs.push(rest.parse().map_err(|_| format!("func {rest} is not an index"))?),
            _ => return Err(format!("unknown directive {directive}")),
        }
    }
    if request.frames.len() > FRAMES_MAX || request.funcs.len() > FRAMES_MAX {
        return Err(format!("more than {FRAMES_MAX} frames"));
    }
    Ok(request)
}

/// path by real path when it is a regular file under one of roots; never anything else.
fn inside(path: &Path, roots: &[PathBuf]) -> Option<PathBuf> {
    let real = std::fs::canonicalize(path).ok()?;
    let ours = roots.iter().any(|root| real.starts_with(root));
    let info = std::fs::metadata(&real).ok()?;
    (ours && info.is_file() && info.len() <= FILE_MAX_BYTES).then_some(real)
}

/// A file's bytes for the rest of the run (the tool runs once and exits).
fn load(path: &Path, roots: &[PathBuf]) -> Option<&'static [u8]> {
    let real = inside(path, roots)?;
    let bytes = std::fs::read(real).ok()?;
    Some(Box::leak(bytes.into_boxed_slice()))
}

fn leak(data: Cow<'static, [u8]>) -> &'static [u8] {
    match data {
        Cow::Borrowed(bytes) => bytes,
        Cow::Owned(bytes) => Box::leak(bytes.into_boxed_slice()),
    }
}

/// The DWARF of file as a lookup context, or None when it carries none.
fn dwarf_of(file: &object::File<'static>) -> Option<Context> {
    file.section_by_name(".debug_info")?;
    let endian = if file.is_little_endian() { gimli::RunTimeEndian::Little } else { gimli::RunTimeEndian::Big };
    let dwarf = gimli::Dwarf::load(|id| -> Result<Reader, ()> {
        let data = file.section_by_name(id.name()).and_then(|section| section.uncompressed_data().ok());
        Ok(gimli::EndianSlice::new(data.map_or(&[][..], leak), endian))
    })
    .ok()?;
    Context::from_dwarf(dwarf).ok()
}

/// A symbol's demangled path without its hash (genex_crash::frames::anchor).
fn demangled(name: &str) -> String {
    format!("{:#}", rustc_demangle::demangle(name))
}

/// One object file a Mach-O debug map names: its DWARF and its symbols by name.
struct ObjectDwarf {
    context: Context,
    symbols: HashMap<&'static [u8], u64>,
}

/// The game's image: the file the anchor is in, where its DWARF is, and its text ranges.
struct Image {
    symbols: object::SymbolMap<object::SymbolMapName<'static>>,
    dwarf: Option<Context>,
    text: Vec<(u64, u64)>,
    objects: object::ObjectMap<'static>,
    object_dwarf: HashMap<usize, Option<ObjectDwarf>>,
    roots: Vec<PathBuf>,
}

/// A frame's function: its name and place, innermost first when inlined.
struct Function {
    name: Option<String>,
    file: Option<String>,
    line: Option<u32>,
    column: Option<u32>,
}

fn anchor_address(file: &object::File<'static>, symbol: &str) -> Option<u64> {
    file.symbols()
        .chain(file.dynamic_symbols())
        .find(|candidate| candidate.name().is_ok_and(|name| demangled(name) == symbol))
        .map(|found| found.address())
}

fn text_ranges(file: &object::File<'static>) -> Vec<(u64, u64)> {
    file.sections()
        .filter(|section| section.kind() == SectionKind::Text)
        .map(|section| (section.address(), section.address().saturating_add(section.size())))
        .collect()
}

/// The debug file holding the anchor, with the DWARF that describes it: its own, a dSYM's with
/// the same UUID, or (none of those) the object files its debug map names.
fn image_of(mut files: Vec<object::File<'static>>, symbol: &str, roots: &[PathBuf]) -> Option<(Image, u64)> {
    let (at, address) = files.iter().enumerate().find_map(|(at, file)| Some((at, anchor_address(file, symbol)?)))?;
    let file = files.swap_remove(at);
    let uuid = file.mach_uuid().ok().flatten();
    let paired = |other: &&object::File<'static>| uuid.is_some() && other.mach_uuid().ok().flatten() == uuid;
    let dwarf = dwarf_of(&file).or_else(|| files.iter().find(paired).and_then(dwarf_of));
    let text = text_ranges(&file);
    let objects = file.object_map();
    let symbols = file.symbol_map();
    let image = Image { symbols, dwarf, text, objects, object_dwarf: HashMap::new(), roots: roots.to_vec() };
    Some((image, address))
}

impl Image {
    fn holds(&self, probe: u64) -> bool {
        self.text.iter().any(|&(start, end)| probe >= start && probe < end)
    }

    fn object_file(&self, index: usize) -> Option<ObjectDwarf> {
        let named = &self.objects.objects()[index];
        let path = Path::new(std::str::from_utf8(named.path()).ok()?);
        let data = load(path, &self.roots)?;
        let bytes = match named.member() {
            Some(member) => {
                let archive = object::read::archive::ArchiveFile::parse(data).ok()?;
                let found = archive.members().filter_map(Result::ok).find(|entry| entry.name() == member)?;
                found.data(data).ok()?
            }
            None => data,
        };
        let file = object::File::parse(bytes).ok()?;
        let context = dwarf_of(&file)?;
        let symbols = file.symbols().filter_map(|symbol| Some((symbol.name_bytes().ok()?, symbol.address()))).collect();
        Some(ObjectDwarf { context, symbols })
    }

    /// The context and address probe is looked up at: the image's own DWARF, or an object file's.
    fn context_for(&mut self, probe: u64) -> Option<(&Context, u64)> {
        if self.dwarf.is_some() {
            return self.dwarf.as_ref().map(|context| (context, probe));
        }
        let entry = self.objects.get(probe)?;
        let (index, name, start) = (entry.object_index(), entry.name(), entry.address());
        if !self.object_dwarf.contains_key(&index) {
            let loaded = self.object_file(index);
            self.object_dwarf.insert(index, loaded);
        }
        let object = self.object_dwarf.get(&index)?.as_ref()?;
        let base = *object.symbols.get(name)?;
        Some((&object.context, base + (probe - start)))
    }

    fn functions(&mut self, probe: u64) -> Vec<Function> {
        let mut functions = Vec::new();
        let found = self.context_for(probe).map(|(context, at)| context.find_frames(at).skip_all_loads());
        if let Some(Ok(mut frames)) = found {
            while let Ok(Some(frame)) = frames.next() {
                let name = frame.function.as_ref().and_then(|f| f.raw_name().ok()).map(|raw| demangled(&raw));
                let place = frame.location.as_ref();
                functions.push(Function {
                    name,
                    file: place.and_then(|l| l.file).map(str::to_string),
                    line: place.and_then(|l| l.line),
                    column: place.and_then(|l| l.column),
                });
                if functions.len() == INLINED_MAX {
                    break;
                }
            }
        }
        // Line tables name a function by its short name only: the outermost one gets its full
        // path from the symbol table (inlined ones keep the short name).
        let symbol = self.symbols.get(probe).map(|symbol| demangled(symbol.name()));
        match functions.last_mut() {
            None => functions.push(Function { name: symbol, file: None, line: None, column: None }),
            Some(outer) if symbol.is_some() && !outer.name.as_deref().is_some_and(|name| name.contains("::")) => {
                outer.name = symbol;
            }
            Some(_) => {}
        }
        functions
    }
}

fn frame_json(image: &mut Image, slide: u64, ip: u64) -> String {
    // A return address is one past its call: look the call itself up.
    let probe = ip.wrapping_sub(slide).wrapping_sub(1);
    if !image.holds(probe) {
        return "{\\"foreign\\":true}".to_string();
    }
    let functions: Vec<String> = image
        .functions(probe)
        .iter()
        .map(|f| {
            format!(
                "{{\\"function\\":{},\\"file\\":{},\\"line\\":{},\\"column\\":{}}}",
                optional_text(f.name.as_deref()),
                optional_text(f.file.as_deref()),
                optional_number(f.line),
                optional_number(f.column)
            )
        })
        .collect();
    format!("{{\\"foreign\\":false,\\"functions\\":[{}]}}", functions.join(","))
}

/// The wasm functions' names from the symbol map, each demangled.
fn funcs_json(request: &Request) -> Result<Vec<String>, String> {
    if request.funcs.is_empty() {
        return Ok(Vec::new());
    }
    let path = request.map.as_ref().ok_or("wasm functions need a symbol map")?;
    let data = load(path, &request.roots).ok_or("the symbol map is not a file under a root")?;
    let text = std::str::from_utf8(data).map_err(|_| "the symbol map is not UTF-8")?;
    let names: HashMap<u32, &str> = text
        .lines()
        .filter_map(|line| line.split_once(':'))
        .filter_map(|(index, name)| Some((index.parse().ok()?, name)))
        .collect();
    let named = request.funcs.iter().map(|func| {
        let name = names.get(func).map(|name| demangled(name));
        format!("{{\\"func\\":{func},\\"name\\":{}}}", optional_text(name.as_deref()))
    });
    Ok(named.collect())
}

fn frames_json(request: &Request) -> Result<Vec<String>, (&'static str, String)> {
    if request.frames.is_empty() {
        return Ok(Vec::new());
    }
    let (symbol, anchor_ip) = request.anchor.as_ref().ok_or(("usage", "frames need an anchor".to_string()))?;
    let mut files = Vec::new();
    for path in &request.debug {
        let data = load(path, &request.roots).ok_or(("debug", format!("{} is not a file under a root", path.display())))?;
        files.push(object::File::parse(data).map_err(|error| ("debug", format!("{}: {error}", path.display())))?);
    }
    let (mut image, anchor) = image_of(files, symbol, &request.roots).ok_or(("anchor", format!("no debug file names {symbol}")))?;
    let slide = anchor_ip.wrapping_sub(anchor);
    Ok(request.frames.iter().map(|&ip| frame_json(&mut image, slide, ip)).collect())
}

fn main() -> ExitCode {
    let mut text = String::new();
    if std::io::stdin().take(REQUEST_MAX_BYTES).read_to_string(&mut text).is_err() {
        return refuse("usage", "the request is not UTF-8");
    }
    let request = match parse_request(&text) {
        Ok(request) => request,
        Err(message) => return refuse("usage", &message),
    };
    let frames = match frames_json(&request) {
        Ok(frames) => frames,
        Err((stage, message)) => return refuse(stage, &message),
    };
    let funcs = match funcs_json(&request) {
        Ok(funcs) => funcs,
        Err(message) => return refuse("map", &message),
    };
    println!("{{\\"ok\\":true,\\"frames\\":[{}],\\"funcs\\":[{}]}}", frames.join(","), funcs.join(","));
    ExitCode::SUCCESS
}
`;

/** The crash symbolicator's manifest: the versions backtrace 0.3.76 already brings, nothing else. */
const SYMBOLICATE_MANIFEST = `[package]
name = "${SYMBOLICATE_TOOL}"
version = "0.0.0"
edition = "2024"
publish = false

[dependencies]
addr2line = { version = "=0.25.1", default-features = false, features = ["std"] }
object = { version = "=0.37.3", default-features = false, features = ["read", "std"] }
rustc-demangle = "=0.1.28"

[profile.release]
debug = false
`;

/** A host tool the prewarm builds from an embedded crate: its name, sources and step labels. */
interface HostTool {
  name: string;
  manifest: string;
  main: string;
  lockfile: RustPrewarmStep;
  build: RustPrewarmStep;
  missing: string;
}

/** The host tools a `tools` prewarm builds, in order. */
const HOST_TOOLS: readonly HostTool[] = [
  {
    name: NAGA_CHECK_TOOL,
    manifest: NAGA_CHECK_MANIFEST,
    main: NAGA_CHECK_MAIN_RS,
    lockfile: RustPrewarmStep.NagaLockfile,
    build: RustPrewarmStep.NagaBuild,
    missing: MESSAGE.NoTool,
  },
  {
    name: SYMBOLICATE_TOOL,
    manifest: SYMBOLICATE_MANIFEST,
    main: SYMBOLICATE_MAIN_RS,
    lockfile: RustPrewarmStep.SymbolicateLockfile,
    build: RustPrewarmStep.SymbolicateBuild,
    missing: MESSAGE.NoSymbolicate,
  },
];

/** Builds one host tool in staging and stages it in the tools folder. */
async function buildTool(context: RustPrewarming, tool: HostTool): Promise<void> {
  const crate = path.join(context.staging, Staged.ToolsBuild, tool.name);
  const manifest = path.join(crate, "Cargo.toml");
  const targetDir = path.join(context.staging, Staged.ToolsBuild, RUST_TARGET_DIR);
  const env = cargoEnv(context, targetDir, []);
  await writeProject(crate, { "Cargo.toml": tool.manifest, "src/main.rs": tool.main });
  await runCargo(context, tool.lockfile, ["generate-lockfile", "--offline", "--manifest-path", manifest], env);
  const args = [
    "build",
    "--release",
    "--offline",
    "--locked",
    "--manifest-path",
    manifest,
    "--message-format=json-render-diagnostics",
  ];
  const built = executableNamed(await runCargo(context, tool.build, args, env), tool.name);
  if (!built || !isInside(targetDir, built)) throw new ToolchainError(ToolchainProblem.Prewarm, tool.missing);
  const tools = path.join(context.staging, Staged.Tools);
  await mkdir(tools, { recursive: true });
  const staged = path.join(tools, path.basename(built));
  await copyFile(built, staged);
  await chmod(staged, 0o755);
  await rm(crate, { recursive: true, force: true });
}

/** Where a naga validation failed. Wire values: the validator prints them. */
export const NagaStage = {
  Usage: "usage",
  Read: "read",
  Parse: "parse",
  Validate: "validate",
  /** The validator printed nothing it could read. */
  Tool: "tool",
} as const;
export type NagaStage = (typeof NagaStage)[keyof typeof NagaStage];

/** A WGSL file's verdict: valid against WebGPU core plus the declared features, or why not. */
export type WgslValidation =
  | { ok: true }
  | { ok: false; stage: NagaStage; message: string; line: number | null; column: number | null };

const NAGA_STAGES: ReadonlySet<string> = new Set(Object.values(NagaStage));
const isNagaStage = (value: unknown): value is NagaStage => typeof value === "string" && NAGA_STAGES.has(value);
const lineNumber = (value: unknown) => (Number.isSafeInteger(value) ? Number(value) : null);

/** The validator's verdict line, read whole; anything else is a `tool` failure naming what it said. */
function verdictOf(result: RunResult): WgslValidation {
  const last = result.stdout.trim().split("\n").pop() ?? "";
  let value: unknown = null;
  try {
    value = JSON.parse(last);
  } catch {
    value = null;
  }
  if (isJsonObject(value) && value.ok === true && result.code === 0) return { ok: true };
  if (isJsonObject(value) && value.ok === false && isNagaStage(value.stage) && typeof value.message === "string")
    return {
      ok: false,
      stage: value.stage,
      message: value.message,
      line: lineNumber(value.line),
      column: lineNumber(value.column),
    };
  const said = (result.stderr || result.stdout).trim().slice(-STEP_DETAIL_MAX_CHARS);
  return { ok: false, stage: NagaStage.Tool, message: said, line: null, column: null };
}

/**
 * Validates the WGSL file `file` (a host-staged copy: the caller resolves and checks it) with the
 * store's naga validator under the injected sandbox `run`, no network and nothing writable,
 * against WebGPU core plus `features`.
 */
export async function validateWgsl(
  located: LocatedRust,
  file: string,
  features: readonly NativeEnhancedFeature[],
  run: (request: RunRequest) => Promise<RunResult>,
): Promise<WgslValidation> {
  if (!located.nagaCheck) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoTool);
  const argv = [located.nagaCheck, file, ...features.flatMap((feature) => ["--feature", feature])];
  const result = await run({
    label: RustToolStep.NagaValidate,
    command: argv.map(shellQuote).join(" "),
    cwd: path.dirname(file),
    timeoutMs: NAGA_TIMEOUT_MS,
    policy: { allowedDomains: [], allowWrite: [] },
  });
  return verdictOf(result);
}

// ---------- clones ----------

/** Clones `from` into the existing empty folder `to`, `rel` deep; answers the files and bytes cloned. */
async function cloneTree(from: string, to: string, rel = ""): Promise<{ files: number; bytes: number }> {
  const totals = { files: 0, bytes: 0 };
  const at = rel ? path.join(from, ...rel.split("/")) : from;
  for (const entry of await readdir(at, { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    const source = path.join(at, entry.name);
    const target = path.join(to, ...child.split("/"));
    if (entry.isDirectory()) {
      await mkdir(target);
      const inner = await cloneTree(from, to, child);
      totals.files += inner.files;
      totals.bytes += inner.bytes;
      continue;
    }
    if (!entry.isFile()) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NotRegular(child));
    await copyFile(source, target, FS.COPYFILE_EXCL | FS.COPYFILE_FICLONE);
    const info = await lstat(source);
    await utimes(target, info.atime, info.mtime);
    totals.files += 1;
    totals.bytes += info.size;
  }
  return totals;
}

/** The real path `to` will have, refused when it exists, its folder does not, or it lies in the store. */
async function cloneDestination(root: string, store: string, to: string): Promise<string> {
  const dest = path.resolve(to);
  if (await lstat(dest).catch(() => null)) throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.Exists(dest));
  const parent = await realpath(path.dirname(dest)).catch(() => {
    throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoParent(dest));
  });
  const real = path.join(parent, path.basename(dest));
  if (isInside(root, real) || isInside(path.resolve(store), dest))
    throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.InStore(dest));
  return real;
}

/**
 * Clones `target`'s prewarmed target folder to `to` (a build's or a worktree's own new
 * `CARGO_TARGET_DIR`, outside the store): every file a copy-on-write clone where the disk can
 * (APFS, btrfs, XFS; a copy elsewhere) with its own inode and the source's timestamps. A link or
 * special file in the prewarm refuses the clone, which then leaves nothing at `to`.
 */
export async function cloneRustTarget(
  store: string,
  lock: ToolchainLock,
  target: BuildTarget,
  to: string,
): Promise<{ files: number; bytes: number }> {
  const root = await realpath(store).catch(() => {
    throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NoStore(store));
  });
  if (!(await readRustPrewarm(root, lock, target)))
    throw new ToolchainError(ToolchainProblem.Prewarm, MESSAGE.NotPrewarmed(target));
  const dest = await cloneDestination(root, store, to);
  await mkdir(dest);
  try {
    return await cloneTree(rustPrewarmedTargetDir(root, lock, target), dest);
  } catch (error) {
    await rm(dest, { recursive: true, force: true });
    if (error instanceof ToolchainError) throw error;
    throw new ToolchainError(ToolchainProblem.Prewarm, String(error));
  }
}

// ---------- sizes ----------

/** `rust-sizes.json`: what one profile's Rust store takes on disk. */
export interface RustSizes {
  lock: string;
  /** The installed Rust components the lock names. */
  componentBytes: number;
  /** The sysroot's own bytes beyond the components it shares. */
  sysrootBytes: number;
  cargoHomeBytes: number;
  toolsBytes: number;
  /** Each prewarmed destination's folder. */
  targets: Partial<Record<BuildTarget, number>>;
  /** Components, base, tools and the eager destinations' prewarms. */
  eagerBytes: number;
  budgetBytes: number;
  withinBudget: boolean;
  at: string;
}

/** Bytes under `folders`, each file counted once however many links name it (`seen` carries across calls). */
async function diskBytes(folders: readonly string[], seen: Set<string>): Promise<number> {
  let total = 0;
  for (const folder of folders) {
    const info = await lstat(folder).catch(() => null);
    if (!info) continue;
    if (info.isDirectory()) {
      const names = await readdir(folder);
      total += await diskBytes(
        names.map((name) => path.join(folder, name)),
        seen,
      );
      continue;
    }
    const key = `${info.dev}:${info.ino}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total += info.size;
  }
  return total;
}

/** The Rust stack's components a lock names, as install folders. */
function rustComponentFolders(root: string, lock: ToolchainLock): string[] {
  const ids = [
    ToolchainId.Rust,
    ToolchainId.RustStdWasm,
    ToolchainId.WasmBindgen,
    ToolchainId.Binaryen,
    ToolchainId.RustVendor,
  ];
  return ids.flatMap((id) => {
    const pin = lock.entries[id];
    return pin ? [componentFolder(root, id, pin)] : [];
  });
}

/**
 * Writes `rust-sizes.json` for `lock`: the components, the sysroot beyond them (hard links count
 * once), CARGO_HOME, the tools and each prewarmed destination, and whether the eager store (the
 * `eager` destinations' prewarms with everything else) is within the plan's budget. A clone shares
 * blocks the count cannot see, so it overstates rather than understates.
 */
export async function recordRustSizes(
  store: string,
  lock: ToolchainLock,
  eager: readonly BuildTarget[],
  options: { budgetBytes?: number; now?: () => number } = {},
): Promise<RustSizes> {
  const root = await realpath(store);
  const seen = new Set<string>();
  const componentBytes = await diskBytes(rustComponentFolders(root, lock), seen);
  const sysrootBytes = await diskBytes([rustSysroot(root, lock)], seen);
  const cargoHomeBytes = await diskBytes([rustCargoHome(root, lock)], seen);
  const toolsBytes = await diskBytes([rustToolsFolder(root, lock)], seen);
  const targets: Partial<Record<BuildTarget, number>> = {};
  for (const target of Object.values(BuildTarget)) {
    const folder = rustTargetFolder(root, lock, target);
    if (await lstat(folder).catch(() => null)) targets[target] = await diskBytes([folder], seen);
  }
  const eagerTargets = eager.reduce((sum, target) => sum + (targets[target] ?? 0), 0);
  const eagerBytes = componentBytes + sysrootBytes + cargoHomeBytes + toolsBytes + eagerTargets;
  const budgetBytes = options.budgetBytes ?? RUST_EAGER_STORE_BUDGET_BYTES;
  const sizes: RustSizes = {
    lock: lock.digest,
    componentBytes,
    sysrootBytes,
    cargoHomeBytes,
    toolsBytes,
    targets,
    eagerBytes,
    budgetBytes,
    withinBudget: eagerBytes <= budgetBytes,
    at: new Date((options.now ?? Date.now)()).toISOString(),
  };
  await atomicWriteJson(path.join(lockFolder(root, lock), RUST_SIZES_FILE), sizes);
  return sizes;
}

/** The warm project's lock a destination was prewarmed with: a game's build resolves the same versions from it. */
export async function readWarmLock(store: string, lock: ToolchainLock, target: BuildTarget): Promise<string | null> {
  return readFile(path.join(rustTargetFolder(store, lock, target), RUST_WARM_LOCK_FILE), "utf8").catch(() => null);
}
