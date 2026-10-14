/**
 * genex-core's characterization goldens, extracted from the C++ template itself (M0a.2): the
 * driver in tests/fixtures/genex-core-goldens/driver/ is compiled against
 * src/game-template-cpp/src, runs every scenario in scenarios/<unit>.json through the C++ units
 * (clock, PCG32, FNV-1a, JSON, input merger, session and checksum, safe paths, NDJSON framing)
 * and records what they answered in <unit>.golden.json. The Rust port's tests replay the same
 * cases and require the same answers bit for bit.
 *
 *   node scripts/spike/rust-wgpu/extract-goldens.ts          # rewrite the goldens
 *   node scripts/spike/rust-wgpu/extract-goldens.ts --check  # exit 1 when a golden drifted
 *
 * The compiler is the first usable of $CXX, c++, clang++, g++ (as tests/conformance/
 * cpp-runtime.test.ts picks it). The driver is built with the C++ lane's own compile flags from
 * src/substrate/toolchain-store/recipe.json (-ffp-contract=off: separate IEEE operations, as the
 * lane builds every game), not the compiler's default, under which Apple clang on arm64 fuses
 * `lo + (hi - lo) * unit()` into one FMA. The script also builds the driver with the default
 * contraction and names every unit whose answers differ, so that quirk stays visible.
 */
import { execFile, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { MINUTE_MS } from "../../../src/shared/duration.ts";

const execFileAsync = promisify(execFile);

const REPO = path.resolve(import.meta.dirname, "../../..");
const UNITS_DIR = path.join(REPO, "src/game-template-cpp/src");
const GOLDENS_DIR = path.join(REPO, "tests/fixtures/genex-core-goldens");
const DRIVER = path.join(GOLDENS_DIR, "driver/golden_driver.cpp");
const SCENARIOS_DIR = path.join(GOLDENS_DIR, "scenarios");
const RECIPE = path.join(REPO, "src/substrate/toolchain-store/recipe.json");

/** The template units the driver links; rng.h and digest.h are header-only. */
const SOURCES = ["json", "input", "clock", "session", "paths", "protocol"] as const;
/** The golden files, one per ported unit. */
const UNITS = ["clock", "rng", "fnv", "json", "input", "session", "paths", "protocol"] as const;
type Unit = (typeof UNITS)[number];

const FLAGS = ["-std=c++20", "-O1", "-Wall", "-Wextra", "-UNDEBUG", `-I${UNITS_DIR}`];
const COMPILE_TIMEOUT_MS = 2 * MINUTE_MS;
const RUN_TIMEOUT_MS = MINUTE_MS;
/** Driver output can hold a few megabytes (the 1 MiB framing rows are digested, not copied). */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const CANDIDATES = ["c++", "clang++", "g++"] as const;

/** Whether `compiler` answers `--version` (a Mac's /usr/bin shim without tools does not). */
function usable(compiler: string): boolean {
  return spawnSync(compiler, ["--version"], { stdio: "ignore" }).status === 0;
}

/** The first usable compiler of $CXX, c++, clang++, g++, or null. */
function cppCompiler(): string | null {
  const names = [process.env.CXX, ...CANDIDATES].filter((name): name is string => Boolean(name));
  return names.find(usable) ?? null;
}

async function buildDriver(compiler: string, output: string, extra: readonly string[]): Promise<void> {
  const sources = SOURCES.map((unit) => path.join(UNITS_DIR, `${unit}.cpp`));
  await execFileAsync(compiler, [...FLAGS, ...extra, DRIVER, ...sources, "-o", output], {
    timeout: COMPILE_TIMEOUT_MS,
  });
}

/** A list one compact case per line, so a diff names the case that changed and the file stays small. */
function caseLines(value: unknown, indent: string): string {
  if (!Array.isArray(value) || value.length === 0) return JSON.stringify(value);
  return `[\n${value.map((item) => `${indent} ${JSON.stringify(item)}`).join(",\n")}\n${indent}]`;
}

/** A golden's text: `{unit, cases}` with every case list written one case per line. */
function goldenText(golden: { unit: string; cases: unknown }): string {
  const cases = golden.cases;
  const body = Array.isArray(cases)
    ? caseLines(cases, " ")
    : `{\n${Object.entries(cases as Record<string, unknown>)
        .map(([key, value]) => `  ${JSON.stringify(key)}: ${caseLines(value, "  ")}`)
        .join(",\n")}\n }`;
  return `{\n "unit": ${JSON.stringify(golden.unit)},\n "cases": ${body}\n}\n`;
}

/** One unit's golden text, from the driver's answers. */
async function golden(driver: string, unit: Unit): Promise<string> {
  const scenario = path.join(SCENARIOS_DIR, `${unit}.json`);
  const { stdout } = await execFileAsync(driver, [unit, scenario], {
    timeout: RUN_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  // Every value the goldens hold survives a JS round trip: doubles and 64-bit integers are hex
  // strings, floats are their 32 bits, and bytes that may not be UTF-8 are hex.
  return goldenText(JSON.parse(stdout));
}

async function goldens(driver: string): Promise<Map<Unit, string>> {
  const entries = await Promise.all(UNITS.map(async (unit) => [unit, await golden(driver, unit)] as const));
  return new Map(entries);
}

async function main(): Promise<number> {
  const check = process.argv.includes("--check");
  const compiler = cppCompiler();
  if (compiler === null) {
    console.error("extract-goldens: no C++ compiler ($CXX, c++, clang++ or g++) on PATH");
    return 2;
  }
  const work = await mkdtemp(path.join(os.tmpdir(), "genex-core-goldens-"));
  try {
    const strict = path.join(work, "golden_driver");
    const contracted = path.join(work, "golden_driver_default");
    const recipe = JSON.parse(await readFile(RECIPE, "utf8")) as { flags: { compile: string[] } };
    await Promise.all([buildDriver(compiler, strict, recipe.flags.compile), buildDriver(compiler, contracted, [])]);
    const [reference, platform] = await Promise.all([goldens(strict), goldens(contracted)]);
    const fused = UNITS.filter((unit) => reference.get(unit) !== platform.get(unit));
    console.log(
      fused.length === 0
        ? `extract-goldens: ${compiler}'s default float contraction changes no golden`
        : `extract-goldens: ${compiler}'s default float contraction changes: ${fused.join(", ")} (goldens use the lane's ${recipe.flags.compile.join(" ")})`,
    );
    const drifted: Unit[] = [];
    for (const unit of UNITS) {
      const file = path.join(GOLDENS_DIR, `${unit}.golden.json`);
      const text = reference.get(unit) ?? "";
      const current = await readFile(file, "utf8").catch(() => "");
      if (current === text) continue;
      drifted.push(unit);
      if (!check) await writeFile(file, text);
    }
    if (check && drifted.length > 0) {
      console.error(`extract-goldens: drifted from the C++ template: ${drifted.join(", ")}`);
      return 1;
    }
    console.log(`extract-goldens: ${check ? "checked" : "wrote"} ${UNITS.length} goldens (${drifted.length} changed)`);
    return 0;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

process.exitCode = await main();
