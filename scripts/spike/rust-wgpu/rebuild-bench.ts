/**
 * The K6 warm-rebuild bench (owner decision K6 = B: a template-sized game's warm rebuild+link
 * stays at or under 2 s p50 on the Mac). It builds the Rust template through the app's own lane
 * (`RustBuilds` with the shipped stager and the real Seatbelt build sandbox, as the core
 * configures it) for the Mac in the dev flavour, once to warm the build folder, then `--runs`
 * times after changing one constant in `src/game.rs`, and prints the lane's receipt steps
 * (identity, lock, clippy, build) and each `ensure`'s wall time as p50/p95.
 *
 *   node scripts/spike/rust-wgpu/rebuild-bench.ts [--runs 7] [--label before] [--no-sandbox]
 *     [--root <dir>] [--out <file.json>]
 *
 * - The toolchain is the spike folder (`.studio-dev/spike-toolchain/`, `GENEX_RUST_TOOLCHAIN_DIR`
 *   overrides it) and the crates the dev store's current vendored set (`.studio-dev/dev-store-rust-lock.json`;
 *   `GENEX_RUST_VENDOR_DIR` names another), the pair `rust-lane-real.test.ts` builds with.
 * - The build root defaults to `.studio-dev/cargo-target/k6-bench/<label>`, so a second run of the
 *   same label starts warm; a cold build there writes about 2.5 GB.
 * - `--no-sandbox` runs the same commands without Seatbelt, to separate the sandbox's cost from
 *   cargo's. The app never builds that way.
 *
 * A developer measurement (spike folder): the app never runs or imports it. Its evidence stays
 * under `.studio-dev/evidence/`.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { rustPayloadDir, shippedRustStage } from "../../../src/main/core/rust-lane.ts";
import type { GameBuildGame } from "../../../src/main/game-build.ts";
import type { RustBuildReceipt } from "../../../src/main/rust-build-diagnostics.ts";
import { RustBuilds, type RustToolchain, rustBuildSandboxes } from "../../../src/main/rust-build.ts";
import { CppBuildPurpose } from "../../../src/shared/build-problem.ts";
import { BuildTarget, GameStack, ProjectKind } from "../../../src/shared/game-project.ts";
import { lockOf } from "../../../src/substrate/toolchain-store/lock.ts";

const REPO = path.resolve(import.meta.dirname, "../../..");
const WORKSPACE = path.join(REPO, "native", "genex-rust");
const TEMPLATE = path.join(REPO, "src", "game-template-rust");
const DEV_STORE = path.join(REPO, ".studio-dev", "toolchains", "dev-store");
const DEV_STORE_LOCK = path.join(REPO, ".studio-dev", "dev-store-rust-lock.json");
const PROJECT = "bench";
/** The constant each run changes, so every warm build has something to compile. */
const EDIT = /SPIN_PER_SECOND: f32 = [0-9.]+/;
const DEFAULT_RUNS = 7;
/** How many distinct values the edit cycles through (0.1 … 0.9). */
const EDIT_VALUES = 9;
const PERCENT = 100;
const P95 = 95;
/** The lane's own dev-flavour lock: only the Rust entry is read for a Mac build. */
const LOCK = lockOf({ rust: { version: "1.99.0", sha12: "000000000000" } });

/** One warm build: the receipt's step times and the whole `ensure` on the host clock. */
interface Run {
  wallMs: number;
  steps: Record<string, number>;
}

/** The dev store's current vendored crate tree, from the lock the dev store last wrote. */
function devStoreVendor(): string {
  const named = process.env.GENEX_RUST_VENDOR_DIR;
  if (named) return named;
  const lock = JSON.parse(readFileSync(DEV_STORE_LOCK, "utf8")) as {
    entries: Record<string, { version: string; sha12: string }>;
  };
  const vendor = lock.entries["rust-vendor"];
  if (!vendor) throw new Error(`${DEV_STORE_LOCK} names no rust-vendor`);
  return path.join(DEV_STORE, "rust-vendor", `${vendor.version}-${vendor.sha12}`, "vendor");
}

/** The p-th percentile (nearest rank) of `values`. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / PERCENT) * sorted.length));
  return sorted[rank - 1] ?? Number.NaN;
}

/** The payload as the core ships it: the workspace's lock line and the determinism gate. */
async function payloadIn(resources: string): Promise<string> {
  const payload = rustPayloadDir(resources);
  await mkdir(payload, { recursive: true });
  for (const file of ["Cargo.lock", "clippy.toml"])
    await writeFile(path.join(payload, file), await readFile(path.join(WORKSPACE, file)));
  return payload;
}

/** The template as a created game (its title filled in), copied over the last run's. */
async function templateGame(games: string): Promise<string> {
  const dir = path.join(games, PROJECT);
  await cp(TEMPLATE, dir, { recursive: true, force: true });
  for (const file of [path.join(dir, "genex.toml"), path.join(dir, "src", "main.rs")])
    await writeFile(file, (await readFile(file, "utf8")).replaceAll("__GAME_TITLE__", "Bench"));
  return dir;
}

function gameOf(dir: string): GameBuildGame {
  return {
    project: PROJECT,
    dir,
    shape: {
      entry: "index.html",
      main: "src/main.rs",
      build: null,
      install: null,
      own: false,
      kind: ProjectKind.RustWgpu,
      serve: ".",
    },
    destinations: { stack: GameStack.RustWgpu, targets: [BuildTarget.Mac] },
  };
}

/** The lane over the spike toolchain and `vendor`, its build folders under `root`. */
async function lane(root: string, vendor: string, sandboxed: boolean): Promise<RustBuilds> {
  const toolchainDir = realpathSync(
    process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev", "spike-toolchain"),
  );
  const payload = await payloadIn(path.join(root, "resources"));
  const toolchain: RustToolchain = {
    bin: path.join(toolchainDir, "sysroot", "bin"),
    vendor,
    clippyConf: payload,
    reads: [toolchainDir, vendor, payload],
  };
  return new RustBuilds({
    root: path.join(root, "rust-builds"),
    sandbox: rustBuildSandboxes({ secretPaths: [], enabled: sandboxed, denyRead: [os.homedir()] }),
    locate: async () => ({ ok: true, toolchain }),
    currentLock: async () => LOCK,
    stage: shippedRustStage(payload),
    emit: () => {},
    platform: process.platform,
    cores: os.availableParallelism(),
    denyWrite: [],
    writeLock: async () => {},
  });
}

/** One build of the game after `edit` (when given) changed its constant; throws on a failed build. */
async function timedBuild(builds: RustBuilds, dir: string, edit: string | null): Promise<Run> {
  if (edit !== null) {
    const file = path.join(dir, "src", "game.rs");
    await writeFile(file, (await readFile(file, "utf8")).replace(EDIT, `SPIN_PER_SECOND: f32 = ${edit}`));
  }
  const started = performance.now();
  const outcome = await builds.ensure(gameOf(dir), BuildTarget.Mac, CppBuildPurpose.Live);
  const wallMs = Math.round(performance.now() - started);
  if (!outcome.ok) throw new Error(`build failed: ${JSON.stringify(outcome.problem)}`);
  const receipt: RustBuildReceipt | undefined = outcome.rust?.receipt ?? undefined;
  const steps = Object.fromEntries((receipt?.steps ?? []).map((step) => [step.step, step.ms]));
  return { wallMs, steps };
}

/** p50/p95 of each step and of the wall time over `runs`. */
export function summarize(runs: readonly Run[]): Record<string, { p50: number; p95: number }> {
  const names = [...new Set(runs.flatMap((run) => Object.keys(run.steps))), "wall"];
  const pick = (run: Run, name: string) => (name === "wall" ? run.wallMs : (run.steps[name] ?? 0));
  return Object.fromEntries(
    names.map((name) => {
      const values = runs.map((run) => pick(run, name));
      return [name, { p50: percentile(values, PERCENT / 2), p95: percentile(values, P95) }];
    }),
  );
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      runs: { type: "string", default: String(DEFAULT_RUNS) },
      label: { type: "string", default: "current" },
      root: { type: "string" },
      out: { type: "string" },
      "no-sandbox": { type: "boolean", default: false },
    },
  });
  const runs = Number.parseInt(values.runs, 10);
  const root = path.resolve(values.root ?? path.join(REPO, ".studio-dev", "cargo-target", "k6-bench", values.label));
  const vendor = devStoreVendor();
  if (!existsSync(path.join(vendor, "genex-0.1.0"))) throw new Error(`no vendored genex in ${vendor}`);
  await mkdir(path.join(root, "games"), { recursive: true });
  const dir = await templateGame(path.join(root, "games"));
  const builds = await lane(root, vendor, !values["no-sandbox"]);
  const first = await timedBuild(builds, dir, null);
  console.log(`first build: ${first.wallMs} ms ${JSON.stringify(first.steps)}`);
  const warm: Run[] = [];
  for (let index = 1; index <= runs; index++) {
    const run = await timedBuild(builds, dir, `0.${(index % EDIT_VALUES) + 1}`);
    console.log(`warm ${index}: ${run.wallMs} ms ${JSON.stringify(run.steps)}`);
    warm.push(run);
  }
  const summary = summarize(warm);
  console.log(JSON.stringify(summary));
  const record = { label: values.label, sandboxed: !values["no-sandbox"], vendor, first, warm, summary };
  if (values.out) await writeFile(values.out, `${JSON.stringify(record, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
