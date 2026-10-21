/**
 * The netcode-bench conformance run for the Rust drivers (multiplayer MP-6c). genex-demo's bench
 * (`packages/netcode-bench/test/conformance.test.ts`, DRIVER.md contract 1) runs every
 * conformance fixture and the feel gates against a driver named by `GENEX_CONFORMANCE_DRIVERS=rust`
 * and `GENEX_DRIVER_RUST`. This runs it twice: with the vendored crate's own driver
 * (`genex-multiplayer/examples/driver.rs`), then with the facade driver (`examples/net-driver`), so
 * the facade's wiring is tested and not only the crate. It writes each run's TAP and a
 * `summary.json` under `.studio-dev/evidence/netcode-conformance/<stamp>/` (or `--out`).
 *
 *   GENEX_DEMO_DIR=<genex-demo checkout> node scripts/netcode/rust-conformance.ts [--build] [--out <dir>]
 *
 * Admission comes first, and a refusal starts nothing and writes nothing (one typed line on stderr,
 * exit 78):
 * - GENEX_DEMO_DIR is a clean git checkout at the commit the vendored crate is pinned to
 *   (`crates/genex-multiplayer/PROVENANCE.toml`), so the fixtures are the ones the crate was
 *   vendored against.
 * - Its bench and relay resolve their packages inside it. A checkout without its own
 *   `node_modules` would load them from any folder above it.
 * - Each driver (`GENEX_NET_CRATE_DRIVER`, `GENEX_NET_FACADE_DRIVER`, by default the debug builds
 *   in the cargo target folder) resolves, through links, to an executable inside this repository or
 *   the cargo target folder (`CARGO_TARGET_DIR`, as rust-env.ts names it).
 *
 * Green means both drivers pass every test with no skip: the bench itself says a skip is not a
 * pass. A live relay, impaired networks and the feel gates on them stay owner rows.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";

const execute = promisify(execFile);

/** The exit of a refusal, as rust-env.ts's. */
export const CONFORMANCE_REFUSAL_EXIT = 78;
/** The exit when a run finished and a driver is not green. */
const RED_EXIT = 1;
/** One driver's whole bench run: about 2.5 minutes on a Mac, with room for a loaded machine. */
const SUITE_TIMEOUT_MS = 20 * MINUTE_MS;
/** How long a `git` question about the checkout may take. */
const GIT_TIMEOUT_MS = 30 * SECOND_MS;
/** The most of a failure's message the summary keeps. */
const ERROR_CHARS = 600;
const REFUSAL_PREFIX = "genex-netcode-conformance-refusal: ";
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const PROVENANCE = path.join("native", "genex-rust", "crates", "genex-multiplayer", "PROVENANCE.toml");
const PIN_LINE = /^commit = "([0-9a-f]{40})"$/m;
const BENCH = path.join("packages", "netcode-bench");
const RELAY = path.join("apps", "colyseus");
/** The folders the conformance run reads from the checkout; a local change in one is refused. */
const WATCHED = [BENCH, path.join("packages", "multiplayer"), RELAY, path.join("sdks", "rust")];
/** Each package the bench or the relay loads, from the folder that loads it. */
const RESOLVED: ReadonlyArray<readonly [string, string]> = [
  [BENCH, "@colyseus/core"],
  [RELAY, "@colyseus/core"],
  [RELAY, "@genex-ai/multiplayer"],
];
/** The bench's own test command (its `test:conformance` script), with a TAP report. */
const BENCH_ARGS = [
  "--conditions=@genex-ai/source",
  "--import=./src/env/stdout-guard.ts",
  "--test",
  "--test-concurrency=1",
  "--test-force-exit",
  "--test-reporter=tap",
  "test/conformance.test.ts",
];
/** The bench splits `GENEX_DRIVER_<NAME>` on blanks and honours quotes; a driver path has neither. */
const UNQUOTABLE = /[\s"'\\]/;

/** Why the runner refused to start. Wire values: tests match them. */
export const ConformanceRefusal = {
  Usage: "usage",
  PinMissing: "pin-missing",
  DemoUnset: "demo-unset",
  DemoNotCheckout: "demo-not-checkout",
  DemoWrongCommit: "demo-wrong-commit",
  DemoDirty: "demo-dirty",
  DemoNotInstalled: "demo-not-installed",
  DriverMissing: "driver-missing",
  DriverNotExecutable: "driver-not-executable",
  DriverOutside: "driver-outside",
  DriverUnquotable: "driver-unquotable",
  BuildFailed: "build-failed",
} as const;
export type ConformanceRefusal = (typeof ConformanceRefusal)[keyof typeof ConformanceRefusal];

/** The two drivers, in the order they run. */
export const DriverName = {
  /** The vendored crate's own `examples/driver.rs`. */
  Crate: "crate",
  /** `examples/net-driver`, DRIVER.md over `genex::net`. */
  Facade: "facade",
} as const;
export type DriverName = (typeof DriverName)[keyof typeof DriverName];

/** The rows this command cannot measure: the owner runs them. */
export const OwnerRow = {
  LiveRelay: "live-relay",
  ImpairedNetwork: "impaired-network",
  LiveFeel: "live-feel-gates",
} as const;
export type OwnerRow = (typeof OwnerRow)[keyof typeof OwnerRow];

const MESSAGE = {
  Usage: "usage: GENEX_DEMO_DIR=<genex-demo checkout> rust-conformance.ts [--build] [--out <dir>]",
  PinMissing: (file: string) => `no genex-demo commit in ${file}`,
  DemoUnset: "GENEX_DEMO_DIR names no genex-demo checkout",
  NotCheckout: (dir: string) => `${dir} is not a git checkout`,
  WrongCommit: (dir: string, head: string, pin: string) =>
    `${dir} is at ${head}; the vendored genex-multiplayer is pinned to genex-demo ${pin}`,
  Dirty: (dir: string, changes: string) => `${dir} has local changes the run would read:\n${changes}`,
  NotInstalled: (from: string, name: string, found: string | null) =>
    found === null
      ? `${name} is not installed for ${from}: run pnpm install in the checkout`
      : `${name} for ${from} resolves to ${found}, outside the checkout: run pnpm install in the checkout`,
  DriverMissing: (name: string, file: string) => `the ${name} driver ${file} is not a file: build it first (--build)`,
  NotExecutable: (name: string, file: string) => `the ${name} driver ${file} is not executable`,
  Outside: (name: string, file: string, roots: readonly string[]) =>
    `the ${name} driver ${file} is outside ${roots.join(" and ")}`,
  Unquotable: (name: string, file: string) => `the ${name} driver path ${file} has a blank or a quote`,
  BuildFailed: (step: string) => `the driver build failed: ${step}`,
  Running: (name: string, file: string) => `conformance: the ${name} driver (${file})`,
  Result: (name: string, counts: SuiteCounts, ms: number) =>
    `conformance: ${name} ${counts.green ? "green" : "RED"}: ${counts.pass} pass, ${counts.fail} fail, ${counts.skipped} skipped of ${counts.tests} (${Math.round(ms / SECOND_MS)} s)`,
  Evidence: (dir: string) => `conformance: evidence in ${dir}`,
  OwnerRows: "owner rows (not measured here): a live relay, impaired networks, the feel gates on them",
} as const;

/** Each owner row, with what it asks for. */
const OWNER_ROWS: ReadonlyArray<{ row: OwnerRow; what: string }> = [
  { row: OwnerRow.LiveRelay, what: "both drivers against the hosted protocol-3 relay, two machines" },
  { row: OwnerRow.ImpairedNetwork, what: "the bench's impair.ts profiles (loss, jitter, reorder) on both drivers" },
  { row: OwnerRow.LiveFeel, what: "the feel gates as sender and observer on the live relay" },
];

/** One admitted driver. */
export interface PlannedDriver {
  name: DriverName;
  /** Its real path, links resolved: what was checked is what runs. */
  path: string;
}

/** What an admitted run reads and runs. */
export interface RunPlan {
  /** The checkout's real path. */
  demo: string;
  commit: string;
  drivers: PlannedDriver[];
}

/** Admission: the plan, or the first refusal. */
export type PlanResult = { ok: true; plan: RunPlan } | { ok: false; code: ConformanceRefusal; detail: string };

/** What admission looks at. */
export interface PlanInput {
  env: NodeJS.ProcessEnv;
  /** This repository's root. */
  repo: string;
  /** The genex-demo commit the checkout must be at. */
  pin: string;
}

/** One bench run: the command, its folder and its environment. */
export interface SuiteRun {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

/** How a bench run ended. */
export interface SuiteOutput {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;
}

/** One failing test and the start of its message. */
export interface SuiteFailure {
  name: string;
  error: string;
}

/** A TAP report's top-level tests, counted. */
export interface SuiteCounts {
  tests: number;
  pass: number;
  fail: number;
  skipped: number;
  todo: number;
  failures: SuiteFailure[];
  /** Every test passed, none skipped or todo, and there was at least one. */
  green: boolean;
}

/** What `main` reaches, injectable for tests. */
export interface MainDeps {
  repo: string;
  pin: string | null;
  runSuite(run: SuiteRun): Promise<SuiteOutput>;
  build(repo: string, env: NodeJS.ProcessEnv): Promise<string | null>;
  now(): Date;
  log(line: string): void;
  error(line: string): void;
}

/** The genex-demo commit the vendored genex-multiplayer is pinned to, or null. */
export function readPin(repo: string): string | null {
  const file = path.join(repo, PROVENANCE);
  if (!existsSync(file)) return null;
  return PIN_LINE.exec(readFileSync(file, "utf8"))?.[1] ?? null;
}

const refuse = (code: ConformanceRefusal, detail: string): PlanResult => ({ ok: false, code, detail });

/** Admit a run: the checkout, its installed packages and both drivers, or the first refusal. */
export async function planRun(input: PlanInput): Promise<PlanResult> {
  const demo = await checkDemo(input.env.GENEX_DEMO_DIR, input.pin);
  if (!demo.ok) return demo;
  const roots = allowedRoots(input.repo, input.env);
  const drivers: PlannedDriver[] = [];
  for (const [name, file] of driverPaths(input.repo, input.env)) {
    const driver = checkDriver(name, file, roots);
    if (!driver.ok) return driver;
    drivers.push(driver.driver);
  }
  const installed = checkInstalled(demo.plan.demo);
  if (installed !== null) return installed;
  return { ok: true, plan: { ...demo.plan, drivers } };
}

/** The checkout: real, a git work tree at `pin`, with no local change the run reads. */
async function checkDemo(value: string | undefined, pin: string): Promise<PlanResult> {
  if (!value) return refuse(ConformanceRefusal.DemoUnset, MESSAGE.DemoUnset);
  const dir = realOrNull(path.resolve(value));
  const top = dir === null ? null : await git(dir, ["rev-parse", "--show-toplevel"]);
  if (dir === null || top === null || realOrNull(top) !== dir) {
    return refuse(ConformanceRefusal.DemoNotCheckout, MESSAGE.NotCheckout(value));
  }
  const head = await git(dir, ["rev-parse", "HEAD"]);
  if (head !== pin)
    return refuse(ConformanceRefusal.DemoWrongCommit, MESSAGE.WrongCommit(dir, head ?? "no commit", pin));
  const changes = await git(dir, ["status", "--porcelain", "--", ...WATCHED]);
  if (changes === null || changes !== "") {
    return refuse(ConformanceRefusal.DemoDirty, MESSAGE.Dirty(dir, changes ?? "git status failed"));
  }
  return { ok: true, plan: { demo: dir, commit: head, drivers: [] } };
}

/** Each package the run loads must resolve inside the checkout, as Node would look for it. */
function checkInstalled(demo: string): PlanResult | null {
  for (const [from, name] of RESOLVED) {
    const found = findPackage(path.join(demo, from), name);
    if (found === null || !inside(found, demo)) {
      return refuse(ConformanceRefusal.DemoNotInstalled, MESSAGE.NotInstalled(from, name, found));
    }
  }
  return null;
}

/** The real folder of `name` that Node's lookup from `from` finds first, or null. */
function findPackage(from: string, name: string): string | null {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = realOrNull(path.join(dir, "node_modules", name, "package.json"));
    if (candidate !== null) return path.dirname(candidate);
    if (path.dirname(dir) === dir) return null;
  }
}

/** This repository and the cargo target folder, real. */
function allowedRoots(repo: string, env: NodeJS.ProcessEnv): string[] {
  const roots = [repo, cargoTarget(repo, env)].map((dir) => realOrNull(dir) ?? path.resolve(dir));
  return [...new Set(roots)];
}

/** The cargo target folder rust-env.ts builds into. */
function cargoTarget(repo: string, env: NodeJS.ProcessEnv): string {
  return env.CARGO_TARGET_DIR || path.join(repo, ".studio-dev", "cargo-target");
}

/** Each driver's path: its override, else the debug build in the cargo target folder. */
function driverPaths(repo: string, env: NodeJS.ProcessEnv): Array<[DriverName, string]> {
  const debug = path.join(cargoTarget(repo, env), "debug");
  return [
    [DriverName.Crate, env.GENEX_NET_CRATE_DRIVER || path.join(debug, "examples", "driver")],
    [DriverName.Facade, env.GENEX_NET_FACADE_DRIVER || path.join(debug, "net-driver")],
  ];
}

type DriverCheck = { ok: true; driver: PlannedDriver } | { ok: false; code: ConformanceRefusal; detail: string };

/** A driver: a real executable file inside one of `roots`, with a path the bench can split. */
function checkDriver(name: DriverName, file: string, roots: readonly string[]): DriverCheck {
  const real = realOrNull(path.resolve(file));
  if (real === null || !statSync(real).isFile()) {
    return { ok: false, code: ConformanceRefusal.DriverMissing, detail: MESSAGE.DriverMissing(name, file) };
  }
  if (!roots.some((root) => inside(real, root))) {
    return { ok: false, code: ConformanceRefusal.DriverOutside, detail: MESSAGE.Outside(name, real, roots) };
  }
  if (!isExecutable(real)) {
    return { ok: false, code: ConformanceRefusal.DriverNotExecutable, detail: MESSAGE.NotExecutable(name, real) };
  }
  if (UNQUOTABLE.test(real)) {
    return { ok: false, code: ConformanceRefusal.DriverUnquotable, detail: MESSAGE.Unquotable(name, real) };
  }
  return { ok: true, driver: { name, path: real } };
}

function inside(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function realOrNull(file: string): string | null {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** A `git` answer in `dir`, trimmed, or null when git fails. */
async function git(dir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execute("git", ["-C", dir, ...args], { timeout: GIT_TIMEOUT_MS, encoding: "utf8" });
    return stdout.trim();
  } catch {
    return null;
  }
}

const TEST_LINE = /^(not )?ok \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/i;

/** Count a TAP report's top-level tests; a skip, a todo or an empty report is not green. */
export function parseTap(tap: string): SuiteCounts {
  const counts: SuiteCounts = { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0, failures: [], green: false };
  const lines = tap.split("\n");
  lines.forEach((line, index) => {
    const match = TEST_LINE.exec(line);
    if (match === null) return;
    counts.tests += 1;
    const directive = match[3]?.toUpperCase();
    if (directive === "SKIP") counts.skipped += 1;
    else if (directive === "TODO") counts.todo += 1;
    else if (match[1]) {
      counts.fail += 1;
      counts.failures.push({ name: match[2], error: failureMessage(lines, index + 1) });
    } else counts.pass += 1;
  });
  counts.green = counts.tests > 0 && counts.pass === counts.tests;
  return counts;
}

/** The `error` of the YAML block that follows a failing test line, cut to {@link ERROR_CHARS}. */
function failureMessage(lines: readonly string[], start: number): string {
  const block: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith("  ") || line.trim() === "...") break;
    block.push(line);
  }
  const at = block.findIndex((line) => /^ {2}error:/.test(line));
  if (at < 0) return "";
  const inline = block[at].replace(/^ {2}error:\s*/, "");
  const folded = inline === "|-" || inline === "|" ? block.slice(at + 1).filter((line) => line.startsWith("    ")) : [];
  const text = folded.length > 0 ? folded.map((line) => line.trim()).join("\n") : inline.replace(/^'|'$/g, "");
  return text.slice(0, ERROR_CHARS);
}

/** The bench run for one driver: its environment names only that driver. */
function suiteRun(plan: RunPlan, driver: PlannedDriver, env: NodeJS.ProcessEnv): SuiteRun {
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    GENEX_CONFORMANCE_DRIVERS: "rust",
    GENEX_DRIVER_RUST: driver.path,
    GENEX_DRIVER_CWD: plan.demo,
  };
  // A runner started from a test must not hand its child-test markers to the bench's runner.
  delete childEnv.NODE_TEST_CONTEXT;
  return {
    command: process.execPath,
    args: BENCH_ARGS,
    cwd: path.join(plan.demo, BENCH),
    env: childEnv,
    timeoutMs: SUITE_TIMEOUT_MS,
  };
}

/** Run one bench process to its end or its deadline, collecting both streams. */
export function runSuite(run: SuiteRun): Promise<SuiteOutput> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(run.command, run.args, { cwd: run.cwd, env: run.env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, run.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        ms: Date.now() - started,
      });
    });
  });
}

/** Build both drivers through rust-env.ts; the failing step, or null. */
export async function buildDrivers(repo: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const helper = path.join(repo, "scripts", "toolchains", "rust-env.ts");
  const steps = [
    ["cargo", "build", "-p", "genex-multiplayer", "--example", "driver", "--offline"],
    ["cargo", "build", "-p", "net-driver", "--offline"],
  ];
  for (const step of steps) {
    const output = await runSuite({
      command: process.execPath,
      args: [helper, "--", ...step],
      cwd: repo,
      env,
      timeoutMs: SUITE_TIMEOUT_MS,
    });
    if (output.exitCode !== 0) return `${step.join(" ")}\n${output.stderr.slice(-ERROR_CHARS)}`;
  }
  return null;
}

/** The sha256 of a driver binary, so the evidence names the exact build. */
async function sha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

/** Parse `--build` and `--out <dir>`; null on anything else. */
function parseArgs(argv: readonly string[]): { build: boolean; out: string | null } | null {
  const parsed: { build: boolean; out: string | null } = { build: false, out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--build") parsed.build = true;
    else if (arg === "--out" && argv[index + 1]) {
      parsed.out = argv[index + 1];
      index += 1;
    } else return null;
  }
  return parsed;
}

/** The evidence folder: `--out`, else a stamped folder under `.studio-dev/evidence`. */
function evidenceDir(repo: string, out: string | null, now: Date): string {
  if (out !== null) return path.resolve(out);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return path.join(repo, ".studio-dev", "evidence", "netcode-conformance", stamp);
}

/** Run both drivers' conformance and write the evidence; the process exit. */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: Partial<MainDeps> = {},
): Promise<number> {
  const d: MainDeps = {
    repo: REPO,
    pin: readPin(deps.repo ?? REPO),
    runSuite,
    build: buildDrivers,
    now: () => new Date(),
    log: (line) => process.stdout.write(`${line}\n`),
    error: (line) => process.stderr.write(`${line}\n`),
    ...deps,
  };
  const refused = (code: ConformanceRefusal, detail: string) => {
    d.error(`${REFUSAL_PREFIX}${JSON.stringify({ code, detail })}`);
    return CONFORMANCE_REFUSAL_EXIT;
  };
  const args = parseArgs(argv);
  if (args === null) return refused(ConformanceRefusal.Usage, MESSAGE.Usage);
  if (d.pin === null) return refused(ConformanceRefusal.PinMissing, MESSAGE.PinMissing(PROVENANCE));
  if (args.build) {
    const failed = await d.build(d.repo, env);
    if (failed !== null) return refused(ConformanceRefusal.BuildFailed, MESSAGE.BuildFailed(failed));
  }
  const result = await planRun({ env, repo: d.repo, pin: d.pin });
  if (!result.ok) return refused(result.code, result.detail);
  const out = evidenceDir(d.repo, args.out, d.now());
  const green = await runAll(result.plan, out, env, d);
  return green ? 0 : RED_EXIT;
}

/** Each driver's run, its TAP and logs, then `summary.json`; whether both are green. */
async function runAll(plan: RunPlan, out: string, env: NodeJS.ProcessEnv, d: MainDeps): Promise<boolean> {
  await mkdir(out, { recursive: true });
  const drivers = [];
  for (const driver of plan.drivers) {
    d.log(MESSAGE.Running(driver.name, driver.path));
    const output = await d.runSuite(suiteRun(plan, driver, env));
    await writeFile(path.join(out, `${driver.name}.tap`), output.stdout);
    await writeFile(path.join(out, `${driver.name}.stderr.log`), output.stderr);
    const counts = parseTap(output.stdout);
    const green = counts.green && output.exitCode === 0 && !output.timedOut;
    d.log(MESSAGE.Result(driver.name, { ...counts, green }, output.ms));
    drivers.push({
      name: driver.name,
      path: driver.path,
      sha256: await sha256(driver.path),
      exitCode: output.exitCode,
      timedOut: output.timedOut,
      ms: output.ms,
      ...counts,
      green,
    });
  }
  const summary = {
    schema: 1,
    at: d.now().toISOString(),
    demo: plan.demo,
    commit: plan.commit,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    drivers,
    ownerRows: OWNER_ROWS.map((row) => ({ ...row, status: "not-measured" })),
  };
  await writeFile(path.join(out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  d.log(MESSAGE.Evidence(out));
  d.log(MESSAGE.OwnerRows);
  return drivers.every((driver) => driver.green);
}

if (process.argv[1] && realOrNull(process.argv[1]) === realOrNull(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
