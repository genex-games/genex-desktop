/**
 * The example games on the web (release R-3, owner call E11): each example declares only the game
 * systems it uses, in its genex.toml and as the genex features its Cargo.toml names, and each web
 * export, built alone in the export flavour, fits the default web budget of 4 MiB gzip.
 *
 * The manifest rows read files only. The export rows build every web example with the pinned
 * toolchain, one example per cargo run: one run over several packages unifies their genex features,
 * and each example would then link the systems of all of them (the GE row measured eight examples
 * over 4 MiB that way). They take about a minute and a half per example on a warm target, so they
 * run only when `GENEX_EXAMPLES_WEB=1` asks for them.
 *
 * Not in the tables: `net-driver` is the netcode bench's host tool, not a game, with no genex.toml
 * or web build. `frontier` and `stream-valley` are the streaming examples, measured by their own
 * work packages. `template-web`, `showcase` and `showcase-web` have their own size rows.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { packageWeb, RUST_WEB_EXPORT_PROFILE_SETTINGS, type WebRun } from "../../src/main/rust-build-web.ts";
import { cargoManifest } from "../../src/main/rust-manifest.ts";
import { checkToolchain, rustEnvironment, rustToolchainLayout } from "../../scripts/toolchains/rust-env.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { WEB_WASM_BUDGET_DEFAULT_BYTES } from "../../src/shared/game-export-contract.ts";
import { parseGenexToml, parseTomlDocument, type TomlValue } from "../../src/substrate/genex-toml.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const EXAMPLES = path.join(REPO, "native", "genex-rust", "examples");
const SHELL = path.join(REPO, "src", "game-template-rust", "web", "shell.html");
const TOOLCHAIN = process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev", "spike-toolchain");
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? path.join(REPO, ".studio-dev", "cargo-target");
const WASM_BINDGEN = path.join(TOOLCHAIN, "tools", "bin", "wasm-bindgen");
const WASM_OPT = path.join(TOOLCHAIN, "tools", "binaryen", "bin", "wasm-opt");
const WEB_TRIPLE = "wasm32-unknown-unknown";
/** The facade release the workspace builds (`native/genex-rust/Cargo.toml`). */
const GENEX_VERSION = "0.1.0";
/** A cold export build compiles wgpu, naga, egui and the game's systems for wasm32 with fat LTO. */
const BUILD_TIMEOUT_MS = 30 * MINUTE_MS;
/** wasm-bindgen, then wasm-opt -Oz over the release module. */
const PACKAGE_TIMEOUT_MS = 5 * MINUTE_MS;
const OUTPUT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * The game systems a genex.toml switches and the facade features of the same names (genex's and
 * genex-platform-web's `default`, release R-1 and R-2).
 */
const GameSystem = {
  Physics: "physics",
  Audio: "audio",
  Nav: "nav",
  Streaming: "streaming",
  Animation: "animation",
} as const;
type GameSystem = (typeof GameSystem)[keyof typeof GameSystem];
const GAME_SYSTEMS: readonly GameSystem[] = Object.values(GameSystem);

/** An example game with a web build, and the cargo features its export adds to `--no-default-features`. */
interface WebExample {
  name: string;
  exportFeatures: readonly string[];
}

/**
 * Every example game with a web build in this table's scope. input-twinstick's manifests belong to
 * the input work package; its switches are held to the same rule.
 */
const WEB_EXAMPLES: readonly WebExample[] = [
  { name: "audio-yard", exportFeatures: [] },
  { name: "characters", exportFeatures: [] },
  { name: "crash-lab", exportFeatures: [] },
  { name: "input-twinstick", exportFeatures: [] },
  { name: "menus-saves", exportFeatures: [] },
  { name: "nav-crowd", exportFeatures: [] },
  // A `[net]` game's export links the relay (`rust-manifest.ts`, RustNetFeature.Relay).
  { name: "net-tag", exportFeatures: ["net"] },
  { name: "pond", exportFeatures: [] },
  { name: "slice", exportFeatures: [] },
];

/** Examples with a genex.toml but no web build: their switches still match what they link. */
const NATIVE_ONLY_EXAMPLES: readonly string[] = ["custom-pass"];

/**
 * The line of one row in a section of an example's Cargo.toml, or undefined. The TOML subset the
 * host reads has no dotted keys or inline tables, which a Cargo.toml uses (`version.workspace =
 * true`, `genex = { workspace = true, features = [...] }`), so rows are found by line.
 */
async function cargoLine(example: string, section: string, key: string): Promise<string | undefined> {
  const text = await readFile(path.join(EXAMPLES, example, "Cargo.toml"), "utf8");
  let inSection = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("[")) inSection = line.trim() === `[${section}]`;
    else if (inSection && line.startsWith(`${key} =`)) return line;
  }
  return undefined;
}

/** The value of a single-line scalar or array row (no inline table), as the TOML subset reads it. */
async function cargoValue(example: string, section: string, key: string): Promise<TomlValue | undefined> {
  const line = await cargoLine(example, section, key);
  return line === undefined ? undefined : parseTomlDocument(line)[key];
}

/** The features a one-line dependency row names (`features = ["a", "b"]`); none without the key. */
function featuresOf(line: string | undefined): string[] {
  const list = line?.match(/\bfeatures = \[([^\]]*)\]/)?.[1] ?? "";
  return [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
}

/**
 * The game systems an example's Cargo.toml links: the genex features it names (the workspace's genex
 * has no default features), and audio when it links genex-audio's mixer itself (the pond plays its
 * splash through the mixer, not `ctx.audio`).
 */
async function linkedSystems(example: string): Promise<GameSystem[]> {
  const named = new Set(featuresOf(await cargoLine(example, "dependencies", "genex")));
  const mixer = featuresOf(await cargoLine(example, "dependencies", "genex-audio")).includes("mixer");
  if (mixer) named.add(GameSystem.Audio);
  return GAME_SYSTEMS.filter((system) => named.has(system));
}

/** The game systems the host would link for this genex.toml: the facade line it writes for an export. */
function switchedOnSystems(genexToml: string): GameSystem[] {
  const parsed = parseGenexToml(genexToml);
  assert.ok(parsed.ok, parsed.ok ? "" : `${parsed.code} ${parsed.detail}`);
  const facadeLine = cargoManifest(parsed.manifest, GENEX_VERSION)
    .split("\n")
    .find((line) => line.startsWith("genex = "));
  assert.ok(facadeLine, "the written manifest links the facade");
  const named = new Set<string>(featuresOf(facadeLine));
  // A line that keeps the facade's defaults (the bare requirement) links every system.
  if (!facadeLine.includes("default-features = false")) for (const system of GAME_SYSTEMS) named.add(system);
  return GAME_SYSTEMS.filter((system) => named.has(system));
}

/** The `[lib] name` cargo names the example's module after. */
async function libraryName(example: string): Promise<string> {
  const name = await cargoValue(example, "lib", "name");
  assert.ok(typeof name === "string", `${example} names its library`);
  return name;
}

describe("the example games declare only the game systems they use (release R-3)", () => {
  for (const example of [...WEB_EXAMPLES.map(({ name }) => name), ...NATIVE_ONLY_EXAMPLES]) {
    it(`${example}: its genex.toml switches on exactly the systems its Cargo.toml links`, async () => {
      const file = path.join(EXAMPLES, example, "genex.toml");
      assert.ok(existsSync(file), `${example} has a genex.toml`);
      const fromToml = switchedOnSystems(await readFile(file, "utf8"));
      assert.deepEqual(fromToml, await linkedSystems(example));
    });
  }

  for (const { name } of WEB_EXAMPLES) {
    it(`${name}: its library is a cdylib for the web shell`, async () => {
      const crateTypes = await cargoValue(name, "lib", "crate-type");
      assert.ok(Array.isArray(crateTypes) && crateTypes.includes("cdylib"), `${name}: ${JSON.stringify(crateTypes)}`);
    });
  }
});

/** Why the export rows do not run here, or false. */
function exportsSkip(): string | false {
  if (process.env.GENEX_EXAMPLES_WEB !== "1") return "builds every web example; set GENEX_EXAMPLES_WEB=1 to run";
  for (const tool of [path.join(TOOLCHAIN, "sysroot", "bin", "cargo"), WASM_BINDGEN, WASM_OPT])
    if (!existsSync(tool)) throw new Error(`GENEX_EXAMPLES_WEB=1: ${tool} absent`);
  return false;
}

/** The real tools, run by bash with the command line `packageWeb` quoted. */
const realRun: WebRun = async (command) => {
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
      timeout: PACKAGE_TIMEOUT_MS,
      maxBuffer: OUTPUT_MAX_BYTES,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string; stderr?: string };
    const code = typeof failed.code === "number" ? failed.code : 1;
    return { code, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
};

/**
 * Cargo from the pinned toolchain in its environment (`rust-env.ts`), in the workspace. Not through
 * `rust-env.ts -- cargo`, which refuses `--config`: the export's size profile is given as `--config`
 * settings, as the lane gives it.
 */
async function cargo(args: readonly string[]): Promise<void> {
  const layout = rustToolchainLayout({ ...process.env, GENEX_RUST_TOOLCHAIN_DIR: TOOLCHAIN });
  checkToolchain(layout);
  const env = rustEnvironment(layout, { ...process.env, CARGO_TARGET_DIR: TARGET_DIR });
  await execFileAsync(path.join(layout.sysroot, "bin", "cargo"), [...args, "--offline", "--locked"], {
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: OUTPUT_MAX_BYTES,
    cwd: layout.workspace,
    env,
  });
}

/** The export's cargo build of one example by itself: no default features, the lane's size profile. */
function exportBuildArgs({ name, exportFeatures }: WebExample): string[] {
  const features = exportFeatures.length > 0 ? ["--features", exportFeatures.join(",")] : [];
  const profile = RUST_WEB_EXPORT_PROFILE_SETTINGS.flatMap((setting) => ["--config", setting]);
  return [
    "build",
    "-p",
    name,
    "--lib",
    "--no-default-features",
    ...features,
    "--target",
    WEB_TRIPLE,
    "--release",
    ...profile,
  ];
}

describe("each example's web export fits 4 MiB gzip (release R-3)", { skip: exportsSkip() }, () => {
  for (const example of WEB_EXAMPLES) {
    it(`${example.name}: built alone, packaged as an export, ≤ 4 MiB gzip`, { timeout: BUILD_TIMEOUT_MS }, async () => {
      await cargo(exportBuildArgs(example));
      const library = await libraryName(example.name);
      const result = await packageWeb({
        wasm: path.join(TARGET_DIR, WEB_TRIPLE, "release", `${library}.wasm`),
        out: path.join(await tmpDir(`rust-examples-web-${example.name}-`), "web"),
        shell: await readFile(SHELL, "utf8"),
        title: example.name,
        optimize: true,
        tools: { wasmBindgen: WASM_BINDGEN, wasmOpt: WASM_OPT },
        run: realRun,
      });
      assert.ok(result.ok, `packageWeb refused: ${JSON.stringify(result)}`);
      const gzipBytes = result.receipt.gzipBytes;
      console.log(`${example.name} web export: ${result.receipt.wasmBytes} B, gzip -9 ${gzipBytes} B`);
      assert.ok(gzipBytes <= WEB_WASM_BUDGET_DEFAULT_BYTES, `${example.name}: ${gzipBytes} B gzip over 4 MiB`);
    });
  }
});
