/**
 * The Rust · wgpu performance row on the Mac (M2.12c; plan "Renderer scope", performance
 * acceptance): a matched scene, not the pond. `tests/fixtures/bench-scene/scene.json` is one
 * fishing scene in numbers (world size, frames, fish, planks, camera); `rust/bench.rs` draws it on
 * the genex facade and `raylib/bench.cpp` on raylib, each echoing the scene it read, so the row
 * can check the pair drew the same thing before it compares them.
 *
 * - The genex half is compiled with rustc against the pond's release build (the dependency rlibs
 *   Cargo reported for genex, genex-platform-web, genex-render, wgpu and serde_json) through
 *   `scripts/toolchains/rust-env.ts`, and run on the host GPU: its p95 frame time (CPU work plus
 *   GPU completion, no vsync) must be within the Mac budget in `budgets.json`.
 * - The raylib half is the C++ · raylib v1 baseline. Nothing here builds it (its toolchain store is
 *   the person's): `GENEX_RAYLIB_BENCH_RECORD` names the record it printed, and the genex p95 may
 *   be at most `raylibRegressionMax` above the raylib p95. Without the record the row is
 *   `not run`; `GENEX_REQUIRE_RAYLIB_BASELINE=1` makes its absence a failure. M6.4's default
 *   switch is gated on this row with a ratified budget (`budgets.json` `ratified`).
 *
 * Apple silicon with the pinned toolchain only; skipped without them unless
 * `GENEX_REQUIRE_TOOLCHAINS=1`. The record goes to `.studio-dev/evidence/rust-performance/`.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MINUTE_MS } from "../../src/shared/duration.ts";
// Starts real games on the GPU: the runners run this file one at a time (gpu-games.ts).
import "../helpers/gpu-games.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const BENCH = path.join(REPO, "tests", "fixtures", "bench-scene");
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");
const TOOLCHAIN_DIR = process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev", "spike-toolchain");
const EVIDENCE = path.join(REPO, ".studio-dev", "evidence", "rust-performance");
const REQUIRED = process.env.GENEX_REQUIRE_TOOLCHAINS === "1";
const RAYLIB_RECORD = process.env.GENEX_RAYLIB_BENCH_RECORD;
const RAYLIB_REQUIRED = process.env.GENEX_REQUIRE_RAYLIB_BASELINE === "1";
/** A release build of the pond's dependency graph, cold. */
const BUILD_TIMEOUT_MS = 30 * MINUTE_MS;
const RUN_TIMEOUT_MS = 5 * MINUTE_MS;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
/** The record both halves print. */
const RECORD_FORMAT = "genex-bench/1";

/** The crates bench.rs names, with the version line where the pond's graph holds two. */
const BENCH_EXTERNS: Record<string, string> = {
  genex: "",
  genex_platform_web: "",
  genex_render: "",
  wgpu: "@30.",
  serde_json: "",
};

interface BenchRecord {
  format: string;
  stack: string;
  scene: Record<string, unknown>;
  adapter: string;
  frames: number;
  frameMs: { p50: number; p95: number; max: number };
  captureMs: { p50: number; p95: number };
  firstFrameMs: number;
  pipelineCompileMs: number;
}

interface Budgets {
  ratified: boolean;
  macFrameP95Ms: number;
  raylibRegressionMax: number;
}

interface CargoMessage {
  reason: string;
  package_id?: string;
  target?: { name: string };
  filenames?: string[];
  linked_libs?: string[];
  linked_paths?: string[];
}

/** Why the genex half cannot run here, or null. */
function absent(): string | null {
  if (process.platform !== "darwin" || process.arch !== "arm64") return "an Apple silicon Mac";
  if (!existsSync(path.join(TOOLCHAIN_DIR, "sysroot", "bin", "cargo"))) return `the Rust toolchain (${TOOLCHAIN_DIR})`;
  return null;
}

function needsToolchain(): { skip?: string } {
  const missing = absent();
  if (!missing) return {};
  if (REQUIRED) throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${missing} absent`);
  return { skip: `not run: ${missing} absent` };
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T;
}

/** `node rust-env.ts -- <argv>`: the pinned toolchain over the genex workspace. */
async function rustEnv(argv: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.execPath, [RUST_ENV, "--", ...argv], {
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: BUILD_TIMEOUT_MS,
  });
  return stdout;
}

function rlibOf(messages: readonly CargoMessage[], crate: string, version: string): string {
  const hit = messages.find(
    (m) =>
      m.reason === "compiler-artifact" &&
      m.target?.name.replaceAll("-", "_") === crate &&
      (m.package_id ?? "").includes(version) &&
      m.filenames?.some((f) => f.endsWith(".rlib")),
  );
  const rlib = hit?.filenames?.find((f) => f.endsWith(".rlib"));
  if (!rlib) throw new Error(`cargo reported no rlib for ${crate}${version}`);
  return rlib;
}

/** The pond's release build, then bench.rs compiled against its rlibs: the genex half's executable. */
async function buildGenexHalf(out: string): Promise<string> {
  const build = ["cargo", "build", "-p", "pond", "--bin", "pond", "--release", "--offline", "--locked"];
  const stdout = await rustEnv([...build, "--message-format=json"]);
  const messages = stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as CargoMessage);
  const externs = Object.entries(BENCH_EXTERNS).map(
    ([crate, version]) => `--extern=${crate}=${rlibOf(messages, crate, version)}`,
  );
  const deps = path.dirname(rlibOf(messages, "genex", ""));
  const scripts = messages.filter((m) => m.reason === "build-script-executed");
  const libs = scripts.flatMap((m) => (m.linked_libs ?? []).map((lib) => `-l${lib}`));
  const libPaths = scripts.flatMap((m) => (m.linked_paths ?? []).map((dir) => `-L${dir}`));
  const exe = path.join(out, "genex-bench");
  await rustEnv([
    "rustc",
    "--edition=2024",
    "--crate-type=bin",
    "--crate-name=genex_bench",
    "-Copt-level=3",
    `-Ldependency=${deps}`,
    ...externs,
    ...libPaths,
    ...libs,
    "-o",
    exe,
    path.join(BENCH, "rust", "bench.rs"),
  ]);
  return exe;
}

/** The record a bench printed: its one JSON line. */
function recordOf(stdout: string): BenchRecord {
  const line = stdout.split("\n").find((l) => l.startsWith("{"));
  assert.ok(line, `the bench printed no record: ${stdout.slice(0, 400)}`);
  return JSON.parse(line) as BenchRecord;
}

describe("the Rust performance row on the Mac (matched bench scene)", () => {
  const options = needsToolchain();

  it("draws the matched scene within the Mac p95 budget, and within the raylib baseline's when its record is given", {
    ...options,
    timeout: BUILD_TIMEOUT_MS + RUN_TIMEOUT_MS,
  }, async (t) => {
    const scene = await readJson<Record<string, unknown>>(path.join(BENCH, "scene.json"));
    const budgets = await readJson<Budgets>(path.join(BENCH, "budgets.json"));
    await mkdir(EVIDENCE, { recursive: true });
    const exe = await buildGenexHalf(EVIDENCE);
    const { stdout } = await execFileAsync(exe, [path.join(BENCH, "scene.json")], {
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: RUN_TIMEOUT_MS,
    });
    const genex = recordOf(stdout);
    await writeFile(path.join(EVIDENCE, "genex-record.json"), `${JSON.stringify(genex, null, 2)}\n`);
    assert.equal(genex.format, RECORD_FORMAT);
    assert.deepEqual(genex.scene, scene, "the genex half drew the matched scene");
    assert.equal(genex.frames, scene.frames);
    t.diagnostic(
      `genex p50 ${genex.frameMs.p50.toFixed(3)} ms, p95 ${genex.frameMs.p95.toFixed(3)} ms on ${genex.adapter}` +
        ` (budget ${budgets.macFrameP95Ms} ms, ratified: ${budgets.ratified})`,
    );
    assert.ok(
      genex.frameMs.p95 <= budgets.macFrameP95Ms,
      `p95 ${genex.frameMs.p95} ms is over the Mac budget of ${budgets.macFrameP95Ms} ms`,
    );

    if (!RAYLIB_RECORD) {
      assert.ok(!RAYLIB_REQUIRED, "GENEX_REQUIRE_RAYLIB_BASELINE=1: no GENEX_RAYLIB_BENCH_RECORD given");
      t.diagnostic("raylib comparison not run: GENEX_RAYLIB_BENCH_RECORD names no raylib/bench.cpp record");
      return;
    }
    const raylib = await readJson<BenchRecord>(RAYLIB_RECORD);
    assert.equal(raylib.format, RECORD_FORMAT);
    assert.deepEqual(raylib.scene, scene, "the raylib half drew the matched scene");
    const ceiling = raylib.frameMs.p95 * (1 + budgets.raylibRegressionMax);
    t.diagnostic(`raylib p95 ${raylib.frameMs.p95.toFixed(3)} ms; the genex ceiling is ${ceiling.toFixed(3)} ms`);
    assert.ok(genex.frameMs.p95 <= ceiling, `genex p95 ${genex.frameMs.p95} ms regresses past ${ceiling} ms`);
  });
});
