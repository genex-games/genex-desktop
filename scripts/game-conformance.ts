/**
 * `npm run conformance:game -- --game <game> [--target macos|web] [--demo <name>] [--seed <n>] [--json] [--unsandboxed]`:
 * the game conformance suite (`src/main/core/game-conformance.ts`) on one built Rust · wgpu game,
 * from a developer's checkout. `<game>` is:
 *
 * - `rust-game` (or `tests/fixtures/rust-game`): the `rust-game` fixture's dev-flavour game, the
 *   fd-3 game its stub cargo admits (`tests/fixtures/rust-fd3-stub-game.mjs`); nothing is built;
 * - a Rust · wgpu game folder (its `genex.toml` and `src/main.rs`: the template, the showcase's
 *   `game/`): its dev flavour is built here through the cargo env helper
 *   (`scripts/toolchains/rust-env.ts`) into the developer's cargo target, as the lane builds it (one
 *   binary on the facade with its `studio` feature, the workspace lock, its `[crates]`, its `[render]`
 *   compiled in as `GENEX_RENDER_TOML`), from a staged copy of the folder under
 *   `.studio-dev/conformance-builds/`; the game runs with `CARGO_MANIFEST_DIR` naming that copy, so
 *   it reads its `genex.toml`, shaders and assets there (the facade's dev fallback). A folder outside
 *   this repository's own games (or under `.studio-dev`) is built only with `--unsandboxed`;
 * - an executable: a dev-flavour build that serves the studio on fd 3, from the developer's own cargo
 *   target (`$CARGO_TARGET_DIR`, `.studio-dev/cargo-target`, which `scripts/toolchains/rust-env.ts`
 *   uses, or `target/`): the pond from `cargo build -p pond`.
 *
 * The game runs as `spawnGame` starts one on fd 3 in a process group of its own, but outside
 * ProcessSandbox, with the developer's rights: so the script runs only the fixture and the
 * developer's own builds. Any other executable (the lane's `out/game` of a generated game, a download)
 * is refused unless `--unsandboxed` says the developer accepts running it unconfined, and then a
 * warning is printed. On a Mac a built game's Live ring is watched through the frames host on the
 * built app's addon (`dist/resources`, from `npm run build`; `scripts/game-conformance-ring.ts`);
 * without that addon, and for the fixture, it is `unavailable`. Each failing or unavailable check
 * is printed with its typed problem's words.
 *
 * Exit status: 0 when no check failed, 1 when one did, 2 for a usage error, a missing game or an
 * executable outside the developer's builds without `--unsandboxed`.
 * `GENEX_REQUIRE_METAL=1` also fails a Mac run of an executable whose Live ring could not be watched.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { accessSync, constants as FS, existsSync, realpathSync, statSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type ConformanceLaunch, runGameConformance, stopGameChild } from "../src/main/core/game-conformance.ts";
import {
  ConformanceCheck,
  ConformanceOutcome,
  ConformanceProblem,
  type GameConformanceReport,
} from "../src/shared/game-conformance.ts";
import { BuildTarget } from "../src/shared/game-project.ts";
import { NativeEnv, NativeRunMode, type NativeTimers } from "../src/shared/native-contract.ts";
import { type GenexToml, readGenexToml, renderTomlFragment } from "../src/substrate/genex-toml.ts";
import { NativeGamePort } from "../src/substrate/native-game-port.ts";
import type { GameChild, GameExit } from "../src/substrate/spawn.ts";
import { scriptRingProbe } from "./game-conformance-ring.ts";

const REPO = fileURLToPath(new URL("..", import.meta.url));
/** The fixture kit whose game this script can run with nothing built. */
const FIXTURE_NAME = "rust-game";
const FIXTURE_GAME = path.join(REPO, "tests", "fixtures", "rust-fd3-stub-game.mjs");
const NONCE_BYTES = 16;
/** The destinations this script judges. */
const TARGETS: Readonly<Record<string, BuildTarget>> = { macos: BuildTarget.Mac, web: BuildTarget.Web };
const ExitCode = { Green: 0, Red: 1, Usage: 2 } as const;
const USAGE =
  "usage: npm run conformance:game -- --game <rust-game | executable> [--target macos|web] [--demo NAME] [--seed N] [--json] [--unsandboxed]";
/** The cargo target the env helper builds into when `$CARGO_TARGET_DIR` names none. */
const SHARED_TARGET = path.join(REPO, ".studio-dev", "cargo-target");
/** The developer's own cargo targets, besides `$CARGO_TARGET_DIR`: the only builds run without `--unsandboxed`. */
const DEVELOPER_TARGETS = [SHARED_TARGET, path.join(REPO, "target")];
/** Where a game folder's dev flavour is staged as a crate (ignored by Git). */
const STAGED_BUILDS = path.join(REPO, ".studio-dev", "conformance-builds");
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");
/** The built app's resources (`npm run build`): the Live ring's frames addon is `native/genex-frames.node` in it. */
const BUILT_RESOURCES = path.join(REPO, "dist", "resources");
const FACADE = path.join(REPO, "native", "genex-rust", "crates", "genex");
const WORKSPACE_LOCK = path.join(REPO, "native", "genex-rust", "Cargo.lock");
/** What a Rust · wgpu game folder holds: the manifest and the entry. */
const GAME_MANIFEST = "genex.toml";
const GAME_ENTRY = path.join("src", "main.rs");
/** The variable the facade reads `[render]` from at compile time, and the one its dev flavour finds the game folder by. */
const RENDER_TOML_ENV = "GENEX_RENDER_TOML";
const MANIFEST_DIR_ENV = "CARGO_MANIFEST_DIR";
/** Hex characters of a folder's path hash in its staged crate's name: two folders of one name stay apart. */
const STAGE_HASH_CHARS = 8;
/** What a staged copy of a game folder leaves out. */
const STAGE_SKIPPED: ReadonlySet<string> = new Set([
  ".git",
  "target",
  "node_modules",
  "Cargo.toml",
  "Cargo.lock",
  ".cargo",
]);
/** A staged crate's name: the folder's name in cargo's alphabet. */
const CRATE_NAME_UNSAFE = /[^a-z0-9_-]+/g;

const MESSAGE = {
  noGame: (game: string) =>
    `${game}: not the rust-game fixture, a Rust · wgpu game folder (${GAME_MANIFEST} and ${GAME_ENTRY}) or an executable`,
  badTarget: (target: string) => `--target ${target}: macos or web`,
  badSeed: (seed: string) => `--seed ${seed}: a whole number`,
  outsideBuilds: (game: string) =>
    `${game}: not in the developer's cargo target; it would run outside ProcessSandbox with your rights. Pass --unsandboxed to run it anyway`,
  outsideRepository: (game: string) =>
    `${game}: a game folder outside this repository's own games; building it runs its code and the game runs outside ProcessSandbox with your rights. Pass --unsandboxed to build and run it anyway`,
  unsandboxed: (game: string) => `warning: running ${game} outside ProcessSandbox, with your rights (--unsandboxed)`,
  metal: "GENEX_REQUIRE_METAL=1: the Live ring could not be watched on this Mac",
  line: (check: string, outcome: string, code: string | null, detail: string | null) =>
    `${outcome.padEnd(11)} ${check.padEnd(17)} ${code ?? ""}${detail ? `  ${detail}` : ""}`,
  problem: (words: string) => `${" ".repeat(30)}${words}`,
  verdict: (passed: boolean) => (passed ? "conformance: green" : "conformance: red"),
  manifest: (folder: string, why: string) => `${folder}: its ${GAME_MANIFEST} is refused: ${why}`,
  building: (folder: string, crate: string) =>
    `building ${folder}'s dev flavour (${crate}) through the cargo env helper`,
  buildFailed: (folder: string, code: number | null) => `${folder}: the build failed (exit ${code ?? "signal"})`,
} as const;

/** What each typed problem means, for the report's reader. Every problem has its words. */
const PROBLEM_WORDS: Readonly<Record<ConformanceProblem, string>> = {
  [ConformanceProblem.LaunchFailed]: "the game did not start or never said it was ready",
  [ConformanceProblem.GameEnded]: "the game ended while the check spoke to it",
  [ConformanceProblem.VerbMissing]: "a contract verb answered unknown-op",
  [ConformanceProblem.VerbInvalid]: "a verb answered outside its contract",
  [ConformanceProblem.VerbFailed]: "a verb was refused or did not answer in time",
  [ConformanceProblem.DemoMissing]: "the named demo is not one the game lists",
  [ConformanceProblem.ChecksumMissing]: "state() carries no checksum",
  [ConformanceProblem.Nondeterministic]: "the same state gave two different results",
  [ConformanceProblem.BuildChanged]: "the two runs started different builds",
  [ConformanceProblem.CaptureDigest]: "the capture file is not the one its digest names",
  [ConformanceProblem.CaptureFile]: "the capture file is missing, outside the run's folder or not its declared size",
  [ConformanceProblem.LiveNotMac]: "Live embeds Mac builds only",
  [ConformanceProblem.LiveNoFramesHost]: "no frames host here to watch Live's ring",
  [ConformanceProblem.RingNoFrames]: "too few frames arrived on Live's ring",
  [ConformanceProblem.RingSeq]: "a frame's seq on Live's ring did not increase",
  [ConformanceProblem.RingGeneration]: "a frame came on another generation than its ring's",
  [ConformanceProblem.StopIgnored]: "the game did not end on quit: its group was signalled",
  [ConformanceProblem.StopDeadline]: "the game was not reaped within the stop budget",
  [ConformanceProblem.Orphan]: "a process the game started outlived it",
  [ConformanceProblem.TargetUnsupported]: "this destination's suite does not run here yet",
  [ConformanceProblem.RenderSettingsUnsupported]: "the game's receipt does not advertise renderSettings (not judged)",
  [ConformanceProblem.RenderStatusInvalid]: "state().volatile.render is missing or outside its shape",
  [ConformanceProblem.LookInconsistent]: "the low and high presets do not keep one look",
  [ConformanceProblem.CaptureUnpinned]: "captures are not on one pinned profile across cold boots",
  [ConformanceProblem.CustomPassRefused]: "a custom GPU pass was refused under a preset or class",
  [ConformanceProblem.DegradeNotAllowed]: "a degrade reason the game's receipt does not allow",
  [ConformanceProblem.ExtensionRefused]: "a Level-2 [[wgsl]] source was refused under a preset or class",
};

const isTimeout = (handle: unknown): handle is NodeJS.Timeout => typeof handle === "object" && handle !== null;
const TIMERS: NativeTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => {
    if (isTimeout(handle)) clearTimeout(handle);
  },
};

/** What the script runs: a command, its arguments and the game folder a built one reads (null: none). */
interface GameCommand {
  file: string;
  args: string[];
  fixture: boolean;
  gameDir: string | null;
}

/** A game folder the script builds: its real path. */
interface GameFolder {
  folder: string;
}

/** Whether this user may execute `file`. */
function isExecutable(file: string): boolean {
  try {
    accessSync(file, FS.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Whether `dir` is a Rust · wgpu game folder: a `genex.toml` and a `src/main.rs`. */
function isGameFolder(dir: string): boolean {
  const holds = (rel: string) => existsSync(path.join(dir, rel)) && statSync(path.join(dir, rel)).isFile();
  return existsSync(dir) && statSync(dir).isDirectory() && holds(GAME_MANIFEST) && holds(GAME_ENTRY);
}

/** The game `--game` names, by its real path: a command to run, a folder to build first, or null. */
function gameCommand(game: string): GameCommand | GameFolder | null {
  const resolved = path.resolve(game);
  const isFixture = game === FIXTURE_NAME || (path.basename(resolved) === FIXTURE_NAME && !existsSync(resolved));
  if (isFixture) return { file: process.execPath, args: [FIXTURE_GAME], fixture: true, gameDir: null };
  if (isGameFolder(resolved)) return { folder: realpathSync(resolved) };
  const isFile = existsSync(resolved) && statSync(resolved).isFile();
  return isFile && isExecutable(resolved)
    ? { file: realpathSync(resolved), args: [], fixture: false, gameDir: null }
    : null;
}

/** Whether a staged copy leaves `from` out: a VCS folder, a build output or cargo inputs the host writes itself. */
function isSkipped(from: string): boolean {
  return STAGE_SKIPPED.has(path.basename(from));
}

/** The staged crate's name for `folder`: its name (its parent's for a `game/` folder) and a hash of its path. */
function crateName(folder: string): string {
  const named = path.basename(folder) === "game" ? path.basename(path.dirname(folder)) : path.basename(folder);
  const slug =
    named
      .toLowerCase()
      .replace(CRATE_NAME_UNSAFE, "-")
      .replace(/^-+|-+$/g, "") || "game";
  const hash = createHash("sha256").update(folder).digest("hex").slice(0, STAGE_HASH_CHARS);
  return `conformance-${slug}-${hash}`;
}

/** The cargo manifest the host would write for `manifest`'s game: one binary on the facade's dev flavour. */
function stagedManifest(name: string, manifest: GenexToml): string {
  const crates = manifest.crates.map((crate) => `${crate.name} = ${JSON.stringify(crate.version)}`);
  return [
    "[package]",
    `name = ${JSON.stringify(name)}`,
    'version = "0.0.0"',
    'edition = "2024"',
    "publish = false",
    "",
    "[[bin]]",
    `name = ${JSON.stringify(name)}`,
    'path = "src/main.rs"',
    "",
    "[dependencies]",
    `genex = { path = ${JSON.stringify(FACADE)}, features = ["studio"] }`,
    ...crates,
    "",
    // The workspace's release profile, so the shared target's compiled crates are reused.
    "[profile.release]",
    "codegen-units = 1",
    'lto = "thin"',
    "",
    "[workspace]",
    "",
  ].join("\n");
}

/** Builds a game folder's dev flavour into the shared cargo target; its executable, or the problem. */
async function buildGameFolder(folder: string): Promise<GameCommand | { problem: string }> {
  const parsed = await readGenexToml(folder);
  if (!parsed.ok) return { problem: MESSAGE.manifest(folder, `${parsed.code}: ${parsed.detail}`) };
  const name = crateName(folder);
  const crate = path.join(STAGED_BUILDS, name);
  // The whole folder, as the lane stages it (sources may include_str! its shaders); timestamps kept,
  // so an unchanged game is not rebuilt.
  await rm(crate, { recursive: true, force: true });
  await cp(folder, crate, { recursive: true, preserveTimestamps: true, filter: (from) => !isSkipped(from) });
  await writeFile(path.join(crate, "Cargo.toml"), stagedManifest(name, parsed.manifest));
  await writeFile(path.join(crate, "Cargo.lock"), await readFile(WORKSPACE_LOCK));
  const render = parsed.manifest.render;
  const env: NodeJS.ProcessEnv = { ...process.env, GENEX_RUST_WORKSPACE: crate };
  if (render) env[RENDER_TOML_ENV] = renderTomlFragment(render);
  console.error(MESSAGE.building(folder, name));
  const cargo = spawn(process.execPath, [RUST_ENV, "--", "cargo", "build", "--release", "--offline", "--quiet"], {
    cwd: REPO,
    env,
    stdio: ["ignore", process.stderr, process.stderr],
  });
  const [code] = (await once(cargo, "exit")) as [number | null];
  if (code !== 0) return { problem: MESSAGE.buildFailed(folder, code) };
  const target = process.env.CARGO_TARGET_DIR || SHARED_TARGET;
  return { file: path.join(target, "release", name), args: [], fixture: false, gameDir: crate };
}

/** Whether `file` (a real path) lies strictly inside `root` (a real path). */
function isInside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Whether `file` (a real path) is a build in one of the developer's own cargo targets. */
function inDeveloperBuilds(file: string): boolean {
  const named = process.env.CARGO_TARGET_DIR ? [process.env.CARGO_TARGET_DIR] : [];
  const roots = [...named, ...DEVELOPER_TARGETS].flatMap((root) => {
    try {
      return [realpathSync(root)];
    } catch {
      return [];
    }
  });
  return roots.some((root) => isInside(root, file));
}

/**
 * Whether `folder` (a real path) is one of this repository's own games (the template, the showcase,
 * a fixture): inside the repository and not under `.studio-dev`, where generated games live. Only
 * those are built and run unconfined without `--unsandboxed`.
 */
function isRepositoryGame(folder: string): boolean {
  const repo = realpathSync(REPO);
  return isInside(repo, folder) && !isInside(path.join(repo, ".studio-dev"), folder);
}

/**
 * Starts the game once on fd 3, in a group of its own, with only the studio's variables; ready or
 * rejects. `framesService` names the Live ring's channel for the ring's own run.
 */
async function launch(command: GameCommand, scratches: string[], framesService?: string): Promise<ConformanceLaunch> {
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), "genex-conformance-")));
  scratches.push(scratch);
  const stateDir = path.join(scratch, "state");
  const home = path.join(scratch, "home");
  await Promise.all([stateDir, home].map((dir) => mkdir(dir, { recursive: true })));
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(NONCE_BYTES))).toString("hex");
  // A built game folder reads its genex.toml, shaders and assets from the folder (the dev fallback).
  const gameDir = command.gameDir ? { [MANIFEST_DIR_ENV]: command.gameDir } : {};
  const frames = framesService ? { [NativeEnv.FramesService]: framesService } : {};
  const proc = spawn(command.file, command.args, {
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    detached: true,
    cwd: scratch,
    env: {
      GENEX_STUDIO_FD: "3",
      GENEX_STUDIO_NONCE: nonce,
      GENEX_STATE_DIR: stateDir,
      HOME: home,
      GENEX_HEADLESS: "1",
      ...gameDir,
      ...frames,
    },
  });
  const exited = new Promise<GameExit>((resolve) => proc.once("exit", (code, signal) => resolve({ code, signal })));
  await once(proc, "spawn");
  proc.on("error", () => {});
  const { pid, stdout, stderr } = proc;
  const fd3 = proc.stdio[3];
  if (!(fd3 instanceof Duplex) || pid === undefined || !stdout || !stderr) throw new Error("no protocol pipe");
  const kill = (signal: NodeJS.Signals) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      process.kill(-pid, signal);
    } catch {
      // Already gone.
    }
  };
  const child: GameChild = { pid, fd3, stdout, stderr, exited, kill };
  const port = new NativeGamePort({
    child,
    nonce,
    mode: NativeRunMode.Headless,
    stateDir,
    timers: TIMERS,
    encodeJpeg: async (bgra) => bgra,
  });
  try {
    await port.ready();
  } catch (error) {
    kill("SIGKILL");
    throw error;
  }
  return { port, pid, stateDir, buildDigest: null, stop: () => stopGameChild(child, port) };
}

function print(report: GameConformanceReport): void {
  for (const { check, outcome, code, detail } of report.checks) {
    console.log(MESSAGE.line(check, outcome, code, detail));
    if (code !== null) console.log(MESSAGE.problem(PROBLEM_WORDS[code]));
  }
  console.log(MESSAGE.verdict(report.passed));
}

/** Whether a Mac run must have watched Live's ring and could not. */
function metalMissing(report: GameConformanceReport, command: GameCommand): boolean {
  const ring = report.checks.find((each) => each.check === ConformanceCheck.LiveRing);
  const required = process.env.GENEX_REQUIRE_METAL === "1" && !command.fixture && report.target === BuildTarget.Mac;
  return required && ring?.outcome === ConformanceOutcome.Unavailable;
}

/** What the command line asks for, checked. */
interface Asked {
  game: string;
  command: GameCommand;
  target: BuildTarget;
  demo: string | null;
  seed: number | undefined;
  json: boolean;
}

/**
 * A folder's build runs its code and its game runs unconfined, so a folder outside this repository's
 * own games needs `--unsandboxed` first: the problem to print, or null (with a warning when allowed).
 */
function strangerFolderRefusal(
  named: GameCommand | GameFolder,
  game: string,
  unsandboxed: boolean,
): { problem: string } | null {
  if (!("folder" in named) || isRepositoryGame(named.folder)) return null;
  if (!unsandboxed) return { problem: MESSAGE.outsideRepository(game) };
  console.error(MESSAGE.unsandboxed(game));
  return null;
}

/** The checked command line, or the usage problem to print (exit 2); a game folder is built first. */
async function asked(): Promise<Asked | { problem: string }> {
  const { values } = parseArgs({
    options: {
      game: { type: "string" },
      target: { type: "string", default: "macos" },
      demo: { type: "string" },
      seed: { type: "string" },
      json: { type: "boolean", default: false },
      unsandboxed: { type: "boolean", default: false },
    },
  });
  if (!values.game) return { problem: USAGE };
  const target = TARGETS[values.target];
  if (!target) return { problem: MESSAGE.badTarget(values.target) };
  const seed = values.seed === undefined ? undefined : Number(values.seed);
  if (seed !== undefined && !Number.isSafeInteger(seed)) return { problem: MESSAGE.badSeed(String(values.seed)) };
  const named = gameCommand(values.game);
  if (!named) return { problem: MESSAGE.noGame(values.game) };
  const refused = strangerFolderRefusal(named, values.game, values.unsandboxed);
  if (refused) return refused;
  const command = "folder" in named ? await buildGameFolder(named.folder) : named;
  if ("problem" in command) return command;
  const confined = command.fixture || inDeveloperBuilds(command.file);
  if (!confined && !values.unsandboxed) return { problem: MESSAGE.outsideBuilds(values.game) };
  if (!confined) console.error(MESSAGE.unsandboxed(values.game));
  return { game: values.game, command, target, demo: values.demo ?? null, seed, json: values.json };
}

async function main(): Promise<number> {
  const ask = await asked();
  if ("problem" in ask) {
    console.error(ask.problem);
    return ExitCode.Usage;
  }
  const { command, seed } = ask;
  const scratches: string[] = [];
  // The fixture's stub game has no ring; a built game's ring is watched on a Mac.
  const ringLaunch = (service: string) => launch(command, scratches, service);
  const watchRing = process.platform === "darwin" && !command.fixture;
  const liveRing = watchRing
    ? scriptRingProbe(BUILT_RESOURCES, TIMERS, ringLaunch, (line) => console.error(line))
    : null;
  try {
    const report = await runGameConformance(
      { launch: () => launch(command, scratches), platform: process.platform, now: () => Date.now(), liveRing },
      { project: ask.game, target: ask.target, demo: ask.demo, ...(seed === undefined ? {} : { seed }) },
    );
    if (ask.json) console.log(JSON.stringify(report, null, 2));
    else print(report);
    if (metalMissing(report, command)) {
      console.error(MESSAGE.metal);
      return ExitCode.Red;
    }
    return report.passed ? ExitCode.Green : ExitCode.Red;
  } finally {
    for (const scratch of scratches) await rm(scratch, { recursive: true, force: true });
  }
}

process.exitCode = await main();
