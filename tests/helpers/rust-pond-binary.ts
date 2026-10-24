/**
 * The Rust pond (`native/genex-rust/examples/pond`, dev flavour: it serves the studio's verbs on
 * fd 3) built through the cargo env helper and handed to `prepareNativeRun` through its injectable
 * deps, so the real wgpu admission and run-directory assembly, the real registry, the real game box
 * and the M1.13 Seatbelt profile run it. The library lists it as the Rust · wgpu game it is; only
 * the Rust lane's `ensure` is stood in (it answers the prebuilt pond's `out/`), and the store
 * answers a stand-in Rust lock that nothing reads. The stand-in reports the digests of `out/` as it
 * answers, as the lane records them at admission (a Rust run is assembled only from those bytes).
 *
 * macOS on Apple silicon with the spike toolchain (`scripts/spike/rust-wgpu/setup-toolchain.sh`)
 * only; `GENEX_REQUIRE_METAL=1` turns its absence into a failure.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { NativePrepareDeps } from "../../src/main/core/native-prepare.ts";
import { execHost } from "../../src/main/core/toolchains.ts";
import { type BuildOutcome, GameBuildLanes } from "../../src/main/game-build.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { BuildTarget, type GameProject, GameStack, ProjectKind } from "../../src/shared/game-project.ts";
import type { ToolchainLock } from "../../src/shared/toolchain.ts";
import { admittedReport } from "./rust-admitted.ts";
import { metalRequired } from "./gpu-games.ts";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { factsOfEngine } from "../../src/shared/project-facts.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");
const SPIKE_SYSROOT = path.join(REPO, ".studio-dev", "spike-toolchain", "sysroot");
const CARGO_TARGET = process.env.CARGO_TARGET_DIR ?? path.join(REPO, ".studio-dev", "cargo-target");
/** A warm pond build is seconds; a cold one compiles the whole wgpu graph. */
const POND_BUILD_TIMEOUT_MS = 15 * MINUTE_MS;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** The executable a Mac build's `out/` holds for a headless (and embedded) run. */
export const HEADLESS_EXECUTABLE = "game-headless";
const REQUIRED = metalRequired();

/** The bundle id the pond's runs are signed with: a game's once-chosen id, as the library keeps it. */
export const POND_BUNDLE_ID = "games.genex.game.0123456789ab";
/** The pond's name in the fixture library. */
export const POND_PROJECT = "pond";

/** The Rust lock the stand-in store answers: prepare hands it to the stand-in lane, which ignores it. */
const STAND_IN_LOCK: ToolchainLock = { version: 1, entries: {}, digest: "0".repeat(64) };

/** What is missing here for the pond's rows, or null. */
function pondAbsent(): string | null {
  if (process.platform !== "darwin" || process.arch !== "arm64") return "an Apple silicon Mac";
  return existsSync(SPIKE_SYSROOT) ? null : "the spike toolchain (scripts/spike/rust-wgpu/setup-toolchain.sh)";
}

/** `{}` when the pond can be built and run here; a skip naming what is absent, or a throw when required. */
export function needsPond(): { skip?: string } {
  const absent = pondAbsent();
  if (!absent) return {};
  if (REQUIRED) throw new Error(`GENEX_REQUIRE_METAL=1: ${absent} absent`);
  return { skip: `not run: ${absent} absent` };
}

/**
 * Builds the pond's dev flavour through the cargo env helper (the shared target folder) and copies
 * it at once into `out/game-headless`: another check may rebuild the same target path with other
 * features. Answers the `out` folder, as a lane's build output names it.
 */
export async function buildPond(out: string): Promise<string> {
  await execFileAsync(
    process.execPath,
    [RUST_ENV, "--", "cargo", "build", "-p", "pond", "--bin", "pond", "--offline", "--locked"],
    {
      env: { ...process.env, CARGO_TARGET_DIR: CARGO_TARGET },
      timeout: POND_BUILD_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    },
  );
  await mkdir(out, { recursive: true });
  const exe = path.join(out, HEADLESS_EXECUTABLE);
  await copyFile(path.join(CARGO_TARGET, "debug", "pond"), exe);
  await chmod(exe, 0o755);
  return out;
}

/** The pond as the library lists it: a Rust · wgpu game naming the browser and the Mac. */
export function pondGame(dir: string): GameProject {
  return {
    name: POND_PROJECT,
    dir,
    title: "Pond",
    createdAt: new Date(0).toISOString(),
    pathLabel: "~/AI Games/pond",
    library: true,
    facts: factsOfEngine(GameEngine.Web),
    built: false,
    shape: {
      entry: "index.html",
      main: "src/lib.rs",
      build: null,
      install: null,
      own: false,
      kind: ProjectKind.RustWgpu,
      serve: ".",
    },
    destinations: { stack: GameStack.RustWgpu, targets: [BuildTarget.Web, BuildTarget.Mac] },
  };
}

/** The stand-in lane, as a row counts and holds it. */
export interface PondLane {
  /** How many builds were asked for. */
  builds(): number;
  /** Holds the next build until the returned release is called (a Stop mid-build). */
  hold(): () => void;
}

/**
 * `prepareNativeRun`'s deps over the prebuilt pond: the library lists `game`, the Rust lane answers
 * `out`, the store answers a stand-in Rust lock and is never asked for ANGLE; admission, assembly,
 * the host, its game box and `exec` (`codesign`) are real.
 */
export function pondPrepareDeps(options: { root: string; out: string; game: GameProject; gameBox: () => boolean }): {
  deps: NativePrepareDeps;
  lane: PondLane;
} {
  let builds = 0;
  let held: Promise<void> | null = null;
  const lane: PondLane = {
    builds: () => builds,
    hold: () => {
      let release = () => {};
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => release();
    },
  };
  const ensure = async (): Promise<BuildOutcome> => {
    builds += 1;
    const waiting = held;
    held = null;
    if (waiting) await waiting;
    const rust = await admittedReport(options.out, POND_PROJECT);
    return { ok: true, output: options.out, lastGood: options.out, problem: null, ran: false, rust };
  };
  const deps: NativePrepareDeps = {
    root: options.root,
    host: StudioPlatform.Mac,
    gameBox: options.gameBox,
    games: { list: async () => [options.game], bundleIdFor: async () => POND_BUNDLE_ID },
    gameBuilds: new GameBuildLanes({
      [GameStack.RustWgpu]: { ensure, cancelAll: () => {}, cancelGame: () => {}, sweep: async () => 0 },
    }),
    toolchains: {
      currentLock: async () => STAND_IN_LOCK,
      locate: async () => {
        throw new Error("a wgpu game's run never asks the store for ANGLE");
      },
    },
    exec: execHost,
  };
  return { deps, lane };
}
