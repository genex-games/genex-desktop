/**
 * The six-destination compile check of the Rust · wgpu runtime: `cargo check --offline --locked`
 * of the engine crates for every destination, through the `rust-env.ts` helper (pinned toolchain,
 * vendored crates, fixed manifest), so a renderer change that only compiles on the Mac is found
 * before a wave is integrated.
 *
 *   node scripts/toolchains/rust-destinations.ts [--crates a,b] [--out <dir>] [--list]
 *
 * - Seven rows for six destinations (the Mac, the web, iOS device and simulator, Android,
 *   Windows, Linux). Every row checks the engine crates; the platform crate of the destination's
 *   family is added (`genex-platform-ios` on the iOS rows, `-android` on Android, `-desktop` and
 *   the studio presenter `genex-studio` on desktop rows, `-web` on wasm32). `--crates` narrows
 *   every row to the named crates (a row left with none is not planned); an unknown name is
 *   refused.
 * - The vendored relay client `genex-multiplayer` is checked on the web row with its `web`
 *   feature (the JS bridge; nothing linked). Its native build links libcolyseus from a lib dir its
 *   build script is given, so the native rows take it once the env helper exports one.
 * - The Linux row is checked the way the Linux build lane builds: the target-scoped pkg-config
 *   variables point at the store's Linux sysroot (cpal links libasound, gilrs libudev), so no
 *   host library is consulted. Without a sysroot that row is `not-run`, never green.
 * - A row is `passed`, `failed` (cargo exited non-zero) or `not-run` (the env helper refused, for
 *   example for a missing Android NDK, or the Linux sysroot is absent). Every row runs; the exit
 *   code is 0 only when all of them passed.
 * - Disk: below 5 GiB free where cargo writes, nothing starts and the refusal is typed `disk`
 *   (the shared target is a rebuildable cache: `cargo clean` it below 8 GiB). `df` is injectable.
 * - Output: `<out>/<triple>.json` (one row), `<out>/<triple>.log` (cargo's output) and
 *   `<out>/summary.json`, by default under `.studio-dev/rust-destinations/`.
 *
 * A refusal is one line on stderr, `genex-rust-destinations-refusal: {"code":…,"detail":…}`, exit
 * 78, and nothing is written.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, statfs, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { RUST_ENV_REFUSAL_EXIT } from "./rust-env.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");
const GIB = 1024 ** 3;
/** Below this much free space nothing starts. */
export const MIN_FREE_BYTES = 5 * GIB;
/** Below this much free space the summary says the shared target should be cleaned. */
export const LOW_FREE_BYTES = 8 * GIB;
const REFUSAL_PREFIX = "genex-rust-destinations-refusal: ";
const ENV_REFUSAL_PREFIX = "genex-rust-env-refusal: ";
const DEFAULT_OUT = path.join(REPO, ".studio-dev", "rust-destinations");
const DEFAULT_TARGET_DIR = path.join(REPO, ".studio-dev", "cargo-target");
const LINUX_SYSROOT_FOLDER = "linux-sysroot-x64";
const SUMMARY_SCHEMA = 1;
const FAILURE_EXCERPT_LINES = 12;

/** The destination triples, in the order their rows run. Wire values: they name the output files. */
export const DestinationTriple = {
  MacArm: "aarch64-apple-darwin",
  Web: "wasm32-unknown-unknown",
  IosDevice: "aarch64-apple-ios",
  IosSimulator: "aarch64-apple-ios-sim",
  Android: "aarch64-linux-android",
  Windows: "x86_64-pc-windows-gnullvm",
  Linux: "x86_64-unknown-linux-gnu",
} as const;
export type DestinationTriple = (typeof DestinationTriple)[keyof typeof DestinationTriple];

/** The platform crate family a destination belongs to. */
const Family = { Desktop: "desktop", Web: "web", Ios: "ios", Android: "android" } as const;
type Family = (typeof Family)[keyof typeof Family];

/** The crates every destination compiles. */
const ENGINE_CRATES = [
  "genex-core",
  "genex-render",
  "genex-hud",
  "genex-frames",
  "genex-gpu-memory",
  "genex-assets",
  "genex-audio",
  "genex-anim",
  "genex-nav",
  "genex-stream",
  "genex-net",
  "genex",
] as const;

/** The crates added to the engine set by family (the studio presenter rides with the desktop shell). */
const FAMILY_CRATES = {
  [Family.Desktop]: ["genex-platform-desktop", "genex-studio"],
  [Family.Web]: ["genex-platform-web", "genex-multiplayer"],
  [Family.Ios]: ["genex-platform-ios"],
  [Family.Android]: ["genex-platform-android"],
} as const satisfies Record<Family, readonly string[]>;

/** The features a crate is checked with wherever a row names it (the relay client's web backend on wasm32). */
const CRATE_FEATURES: Readonly<Record<string, readonly string[]>> = { "genex-multiplayer": ["web"] };

const DESTINATIONS: readonly { triple: DestinationTriple; family: Family }[] = [
  { triple: DestinationTriple.MacArm, family: Family.Desktop },
  { triple: DestinationTriple.Web, family: Family.Web },
  { triple: DestinationTriple.IosDevice, family: Family.Ios },
  { triple: DestinationTriple.IosSimulator, family: Family.Ios },
  { triple: DestinationTriple.Android, family: Family.Android },
  { triple: DestinationTriple.Windows, family: Family.Desktop },
  { triple: DestinationTriple.Linux, family: Family.Desktop },
];

const KNOWN_CRATES: ReadonlySet<string> = new Set([...ENGINE_CRATES, ...Object.values(FAMILY_CRATES).flat()]);

/** Why the script refused to start. Wire values: scripts and tests match them. */
export const DestinationsRefusal = { Usage: "usage", UnknownCrate: "unknown-crate", Disk: "disk" } as const;
export type DestinationsRefusal = (typeof DestinationsRefusal)[keyof typeof DestinationsRefusal];

/** How one row ended. */
export const RowStatus = { Passed: "passed", Failed: "failed", NotRun: "not-run" } as const;
export type RowStatus = (typeof RowStatus)[keyof typeof RowStatus];

/** Why a row was not run, beyond a refusal of the env helper (whose code is kept as is). */
export const NotRunReason = { SysrootMissing: "sysroot-missing" } as const;

const MESSAGE = {
  Usage: "usage: rust-destinations.ts [--crates a,b] [--out <dir>] [--list]",
  UnknownCrate: (name: string) => `unknown crate ${JSON.stringify(name)}; known: ${[...KNOWN_CRATES].join(", ")}`,
  NoRows: "no destination compiles any of the named crates",
  Disk: (free: number, dir: string) =>
    `${(free / GIB).toFixed(1)} GiB free where cargo writes (${dir}); at least ${MIN_FREE_BYTES / GIB} GiB are needed: cargo clean the shared target`,
  NoSysroot: `no Linux sysroot with bin/pkg-config under $GENEX_DEV_TOOLCHAINS/${LINUX_SYSROOT_FOLDER} (or GENEX_LINUX_SYSROOT)`,
} as const;

/** A refusal on its way to the one typed stderr line. */
export class DestinationsRefused extends Error {
  readonly code: DestinationsRefusal;
  constructor(code: DestinationsRefusal, detail: string) {
    super(detail);
    this.code = code;
  }
}

/** One planned row: a destination and the crates cargo checks for it. */
export interface PlannedRow {
  triple: DestinationTriple;
  family: Family;
  crates: string[];
}

/** The rows for `crates` (all by default); an unknown crate name is refused. */
export function planRows(crates?: readonly string[]): PlannedRow[] {
  for (const name of crates ?? []) {
    if (!KNOWN_CRATES.has(name))
      throw new DestinationsRefused(DestinationsRefusal.UnknownCrate, MESSAGE.UnknownCrate(name));
  }
  const wanted = crates === undefined ? null : new Set(crates);
  const rows = DESTINATIONS.map(({ triple, family }) => {
    const all = [...ENGINE_CRATES, ...FAMILY_CRATES[family]];
    return { triple, family, crates: wanted === null ? all : all.filter((name) => wanted.has(name)) };
  }).filter((row) => row.crates.length > 0);
  if (rows.length === 0) throw new DestinationsRefused(DestinationsRefusal.UnknownCrate, MESSAGE.NoRows);
  return rows;
}

/** The cargo arguments (after `cargo`) of one row. */
export function cargoCheckArgs(row: PlannedRow): string[] {
  const features = row.crates.flatMap((name) => (CRATE_FEATURES[name] ?? []).map((feature) => `${name}/${feature}`));
  return [
    "check",
    "--offline",
    "--locked",
    "--target",
    row.triple,
    ...row.crates.flatMap((name) => ["-p", name]),
    ...(features.length > 0 ? ["--features", features.join(",")] : []),
  ];
}

/** One finished or skipped row, as written to `<triple>.json` and `summary.json`. */
export interface RowResult {
  target: DestinationTriple;
  crates: string[];
  status: RowStatus;
  /** cargo's exit code, when it ran. */
  exitCode?: number;
  durationMs: number;
  warnings: number;
  /** The env helper's refusal code, or a {@link NotRunReason}, for a `not-run` row. */
  reason?: string;
  /** The first lines of the failure, for a `failed` or `not-run` row. */
  excerpt?: string[];
  log: string;
}

/** What `runDestinations` writes to `summary.json` and returns. */
export interface Summary {
  schema: number;
  generatedAt: string;
  host: string;
  freeBytes: number;
  /** True below {@link LOW_FREE_BYTES}: the shared target wants a clean. */
  lowDisk: boolean;
  passed: boolean;
  rows: RowResult[];
}

/** One cargo run: the arguments and environment, handed to the injected runner. */
export interface CargoJob {
  args: string[];
  env: NodeJS.ProcessEnv;
}

/** What a cargo run produced. */
export interface CargoOutcome {
  exitCode: number;
  output: string;
}

/** The seams a test replaces. */
export interface DestinationsDeps {
  freeBytes: (dir: string) => Promise<number>;
  runCargo: (job: CargoJob) => Promise<CargoOutcome>;
  now: () => number;
  findLinuxSysroot: () => string | null;
}

/** What a run is told. */
export interface DestinationsOptions {
  crates?: readonly string[];
  outDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** The nearest existing folder at or above `dir`, where `statfs` can ask. */
function existingAncestor(dir: string): string {
  let at = dir;
  while (!existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  return at;
}

async function realFreeBytes(dir: string): Promise<number> {
  const disk = await statfs(existingAncestor(dir));
  return disk.bavail * disk.bsize;
}

/** Spawn the env helper's cargo, capturing stdout and stderr together. */
function realRunCargo(job: CargoJob): Promise<CargoOutcome> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUST_ENV, "--", "cargo", ...job.args], { env: job.env, cwd: REPO });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => resolve({ exitCode: 1, output: `${output}${error.message}\n` }));
    child.on("close", (code) => resolve({ exitCode: code ?? 1, output }));
  });
}

/** A Linux sysroot folder: the one named by GENEX_LINUX_SYSROOT, else a dev-toolchains one with a pkg-config. */
function realFindLinuxSysroot(env: NodeJS.ProcessEnv): string | null {
  const hasPkgConfig = (dir: string) => existsSync(path.join(dir, "bin", "pkg-config"));
  if (env.GENEX_LINUX_SYSROOT) return hasPkgConfig(env.GENEX_LINUX_SYSROOT) ? env.GENEX_LINUX_SYSROOT : null;
  const root = path.join(
    env.GENEX_DEV_TOOLCHAINS || path.join(REPO, ".studio-dev", "toolchains"),
    LINUX_SYSROOT_FOLDER,
  );
  if (!existsSync(root)) return null;
  const found = readdirSync(root)
    .sort()
    .reverse()
    .map((name) => path.join(root, name))
    .find(hasPkgConfig);
  return found ?? null;
}

/**
 * The target-scoped pkg-config variables the Linux build lane sets (`rustCrossEnv`): `LIBDIR` as
 * well as `PATH`, so the host's own `.pc` folders are never searched.
 */
export function linuxPkgConfigEnv(sysroot: string): Record<string, string> {
  const scoped = DestinationTriple.Linux.replaceAll("-", "_");
  const pcDirs = ["usr/lib64/pkgconfig", "usr/share/pkgconfig"].map((dir) => path.join(sysroot, dir)).join(":");
  return {
    [`PKG_CONFIG_SYSROOT_DIR_${scoped}`]: sysroot,
    [`PKG_CONFIG_PATH_${scoped}`]: pcDirs,
    [`PKG_CONFIG_LIBDIR_${scoped}`]: pcDirs,
    [`PKG_CONFIG_ALLOW_CROSS_${scoped}`]: "1",
    [`PKG_CONFIG_${scoped}`]: path.join(sysroot, "bin", "pkg-config"),
  };
}

const countWarnings = (output: string) =>
  output.split("\n").filter((line) => line.startsWith("warning:") && !line.includes("generated")).length;

/** The lines that explain a failure: the helper's refusal, else the first error lines. */
function failureExcerpt(output: string): string[] {
  const lines = output.split("\n");
  const errors = lines.filter((line) => line.startsWith("error") || line.startsWith(ENV_REFUSAL_PREFIX));
  return (errors.length > 0 ? errors : lines.filter((line) => line.trim() !== "").slice(-FAILURE_EXCERPT_LINES)).slice(
    0,
    FAILURE_EXCERPT_LINES,
  );
}

/** The env helper's refusal code in `output`, when it refused. */
function envRefusalCode(output: string): string | undefined {
  const line = output.split("\n").find((found) => found.startsWith(ENV_REFUSAL_PREFIX));
  if (line === undefined) return undefined;
  try {
    const parsed = JSON.parse(line.slice(ENV_REFUSAL_PREFIX.length));
    return typeof parsed.code === "string" ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

async function checkRow(
  row: PlannedRow,
  env: NodeJS.ProcessEnv,
  deps: DestinationsDeps,
  outDir: string,
): Promise<RowResult> {
  const log = `${row.triple}.log`;
  const base = { target: row.triple, crates: row.crates, warnings: 0, log };
  const started = deps.now();
  let rowEnv = env;
  if (row.triple === DestinationTriple.Linux) {
    const sysroot = deps.findLinuxSysroot();
    if (sysroot === null) {
      return {
        ...base,
        status: RowStatus.NotRun,
        durationMs: 0,
        reason: NotRunReason.SysrootMissing,
        excerpt: [MESSAGE.NoSysroot],
      };
    }
    rowEnv = { ...env, ...linuxPkgConfigEnv(sysroot) };
  }
  const { exitCode, output } = await deps.runCargo({ args: cargoCheckArgs(row), env: rowEnv });
  await writeFile(path.join(outDir, log), output);
  const durationMs = deps.now() - started;
  const warnings = countWarnings(output);
  if (exitCode === 0) return { ...base, status: RowStatus.Passed, exitCode, durationMs, warnings };
  const reason = envRefusalCode(output);
  const status = reason === undefined ? RowStatus.Failed : RowStatus.NotRun;
  return {
    ...base,
    status,
    exitCode,
    durationMs,
    warnings,
    excerpt: failureExcerpt(output),
    ...(reason ? { reason } : {}),
  };
}

/**
 * Check every planned row in turn and write the summary. Refuses (`disk`, `unknown-crate`) before
 * any cargo runs or any file is written.
 */
export async function runDestinations(
  options: DestinationsOptions = {},
  given: Partial<DestinationsDeps> = {},
): Promise<Summary> {
  const env = options.env ?? process.env;
  const deps: DestinationsDeps = {
    freeBytes: realFreeBytes,
    runCargo: realRunCargo,
    now: Date.now,
    findLinuxSysroot: () => realFindLinuxSysroot(env),
    ...given,
  };
  const rows = planRows(options.crates);
  const targetDir = env.CARGO_TARGET_DIR || DEFAULT_TARGET_DIR;
  const freeBytes = await deps.freeBytes(targetDir);
  if (freeBytes < MIN_FREE_BYTES)
    throw new DestinationsRefused(DestinationsRefusal.Disk, MESSAGE.Disk(freeBytes, targetDir));
  const outDir = options.outDir ?? DEFAULT_OUT;
  await mkdir(outDir, { recursive: true });
  const results: RowResult[] = [];
  for (const row of rows) {
    const result = await checkRow(row, env, deps, outDir);
    await writeFile(path.join(outDir, `${row.triple}.json`), `${JSON.stringify(result, null, 2)}\n`);
    results.push(result);
  }
  const summary: Summary = {
    schema: SUMMARY_SCHEMA,
    generatedAt: new Date(deps.now()).toISOString(),
    host: `${os.platform()}-${os.arch()}`,
    freeBytes,
    lowDisk: freeBytes < LOW_FREE_BYTES,
    passed: results.every((result) => result.status === RowStatus.Passed),
    rows: results,
  };
  await writeFile(path.join(outDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

function parseCrates(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
}

const CLI_OPTIONS = { crates: { type: "string" }, out: { type: "string" }, list: { type: "boolean" } } as const;

function parseCli(argv: readonly string[]) {
  try {
    return parseArgs({ args: [...argv], options: CLI_OPTIONS }).values;
  } catch {
    throw new DestinationsRefused(DestinationsRefusal.Usage, MESSAGE.Usage);
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const values = parseCli(argv);
  const crates = parseCrates(values.crates);
  if (values.list) {
    process.stdout.write(`${JSON.stringify(planRows(crates), null, 2)}\n`);
    return 0;
  }
  const out = values.out ? path.resolve(values.out) : undefined;
  const summary = await runDestinations({ crates, outDir: out });
  for (const row of summary.rows) {
    process.stdout.write(
      `${row.status.padEnd(8)} ${row.target} (${row.crates.length} crates, ${(row.durationMs / 1000).toFixed(1)} s)\n`,
    );
    for (const line of row.excerpt ?? []) process.stdout.write(`    ${line}\n`);
  }
  if (summary.lowDisk)
    process.stdout.write("note: under 8 GiB free; cargo clean the shared target before heavy builds\n");
  process.stdout.write(summary.passed ? "rust-destinations: passed\n" : "rust-destinations: FAILED\n");
  return summary.passed ? 0 : 1;
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof DestinationsRefused)) throw error;
    process.stderr.write(`${REFUSAL_PREFIX}${JSON.stringify({ code: error.code, detail: error.message })}\n`);
    process.exitCode = RUST_ENV_REFUSAL_EXIT;
  }
}
