/**
 * A rust-wgpu game on the web (M2.9): the lane's web branch (`src/main/rust-build-web.ts`:
 * wasm-bindgen 0.2.129, wasm-opt, the template shell as `index.html`, the gzip budget in the
 * receipt) and the template shell (`src/game-template-rust/web/shell.html`) around the build.
 *
 * - Packaging rows run everywhere: a scripted runner stands in for wasm-bindgen and wasm-opt, so
 *   the commands, the page, the receipt and the hostile rows (a link in the output, a title that
 *   would close the page's tags, a tool of another version, a wasm over budget) need no toolchain.
 * - Browser rows launch Playwright's headless Chromium (only with `STUDIO_BROWSER_TESTS=1` and a
 *   Chromium already installed; nothing is downloaded) on the pond and the `web_saves` example,
 *   each built for wasm32 with the pinned toolchain and packaged by `packageWeb` with the real
 *   tools. They prove the shell awaits `studio_capture` (BGRA plus its digest from the world
 *   target, never the canvas), the web and native self-tests agree within the parity tolerance, a
 *   browser below WebGPU core gets the designed page, the typed `gpu-unsupported` in
 *   `__studio.state()` and never fetches the game, the IndexedDB saves mirror survives a reload,
 *   and a quota error surfaces as `save-quota` in `state()` and on the page.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { type Browser, type BrowserContext, chromium, type Page } from "@playwright/test";
import {
  BINARYEN_VERSION,
  packageWeb,
  RUST_WEB_BUILDER,
  RustWebRefusal,
  RustWebStep,
  WASM_BINDGEN_VERSION,
  WEB_ASSET_MAP_VERSION,
  WEB_FILES,
  type WebRun,
  webAssetMap,
  type WebRunResult,
  webShellPage,
  writeWebAssetMap,
} from "../../src/main/rust-build-web.ts";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import {
  ExportWarningCode,
  WEB_BUDGET_MB_BYTES,
  WEB_WASM_BUDGET_DEFAULT_BYTES,
  WEB_WASM_CEILING_BYTES,
  WEB_WASM_CEILING_MB,
} from "../../src/shared/game-export-contract.ts";
import { NativeOp } from "../../src/shared/native-contract.ts";
import {
  EFFECTIVE_PRESETS,
  type EffectivePreset,
  FormFactor,
  parseRenderStatus,
  RenderFeature,
} from "../../src/shared/render-quality.ts";
import { playwrightHeadlessChromiumOnDisk } from "../helpers/playwright-chromium.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { metalRequired } from "../helpers/gpu-games.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SHELL = path.join(REPO, "src", "game-template-rust", "web", "shell.html");
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");
const TOOLCHAIN = process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev", "spike-toolchain");
const CARGO = path.join(TOOLCHAIN, "sysroot", "bin", "cargo");
const WASM_BINDGEN = path.join(TOOLCHAIN, "tools", "bin", "wasm-bindgen");
const WASM_OPT = path.join(TOOLCHAIN, "tools", "binaryen", "bin", "wasm-opt");
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? path.join(REPO, ".studio-dev", "cargo-target");
const WASM_DIR = path.join(TARGET_DIR, "wasm32-unknown-unknown", "release");
const NATIVE_POND = path.join(TARGET_DIR, "debug", "pond");
/** Cold builds compile wgpu, Rapier, egui and kira for the host and for wasm32. */
const BUILD_TIMEOUT_MS = 30 * MINUTE_MS;
const RUN_TIMEOUT_MS = 3 * MINUTE_MS;
const BOOT_TIMEOUT_MS = 60 * SECOND_MS;
const FLUSH_TIMEOUT_MS = 10 * SECOND_MS;
const OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
const PARITY_TICKS = 600;
const PARITY_SEED = 1;
const PARITY_DEMO = "cast";
/** Named probe fields agree within this across targets (plan "Determinism"). */
const PROBE_TOLERANCE = 1e-3;
/** Pixels: the mean channel difference, and the share of pixels off by more than a step. */
const PIXEL_MEAN_TOLERANCE = 1.5;
const PIXEL_STEP = 24;
const PIXEL_OFF_SHARE = 0.01;
const NONBLANK_MIN_COLOURS = 16;
const POND_WORLD = { width: 960, height: 540 };
/** The template's world (`src/game-template-rust/src/main.rs`). */
const TEMPLATE_WORLD = { width: 960, height: 540 };
const GPU_UNSUPPORTED = "gpu-unsupported";
/**
 * The turning block's self-shadow row (owner report 2026-10-11), the web twin of template-web's
 * `metal_the_turning_block_carries_no_shadow_of_its_own_at_any_preset`: the ticks it is drawn at,
 * how a block pixel is told apart (red over blue), how far inside its outline it is measured, the
 * contact rows left out above its floor line, and the darkening and floor-shadow limits.
 */
const SELF_SHADOW_STEPS_MS = [133, 500, 500, 500];
const BLOCK_RED_OVER_BLUE = 50;
const BLOCK_ERODE = 3;
const CONTACT_ROWS = 8;
const SELF_SHADOW_RATIO = 0.65;
const SELF_SHADOW_SHARE_MAX = 0.01;
const BLOCK_MEAN_RATIO_MIN = 0.85;
const FLOOR_SHADOW_RATIO = 0.6;
const FLOOR_SHADOW_PIXELS_MIN = 4000;
/** The switches the unshadowed reference turns off. */
const UNSHADOWED = { [RenderFeature.Shadows]: false, [RenderFeature.ContactShadows]: false, [RenderFeature.Ao]: false };
const SAVE_QUOTA = "save-quota";
/** The shell's status states and refusal reasons (shell.html). Wire values. */
const ShellState = { Running: "running", Unsupported: "unsupported" } as const;
const Reason = { NoWebGpu: "no-webgpu", NoAdapter: "no-adapter", LimitBelowCore: "limit-below-core" } as const;
/** Chromium's WebGPU on the Mac's GPU (Metal) rather than SwiftShader. */
const CHROMIUM_ARGS: Record<string, string[]> = {
  darwin: ["--enable-unsafe-webgpu", "--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
};
const DEFAULT_CHROMIUM_ARGS = ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"];
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

interface CaptureRecord {
  tick: number;
  width: number;
  height: number;
  digest: string;
}

interface SelfTestRecord {
  format: string;
  frame: number;
  checksum: string;
  probes: Record<string, unknown>;
  captures: CaptureRecord[];
}

// ── packaging, scripted tools ──

/** A wasm module's bytes: the magic and version, then filler that compresses as asked. */
function fakeWasm(bytes: number, random = false): Buffer {
  const body = random ? randomBytes(bytes) : Buffer.alloc(bytes);
  body.set([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
  return body;
}

interface Scripted {
  run: WebRun;
  commands: string[];
}

/** A runner that answers like the real tools: a version line, and the files each step writes. */
function scriptedTools(
  out: string,
  options: { version?: string; wasmBytes?: number; random?: boolean } = {},
): Scripted {
  const commands: string[] = [];
  const run: WebRun = async (command, step): Promise<WebRunResult> => {
    commands.push(command);
    if (step === RustWebStep.BindgenVersion) {
      return { code: 0, stdout: `wasm-bindgen ${options.version ?? WASM_BINDGEN_VERSION}\n`, stderr: "" };
    }
    if (step === RustWebStep.Bindgen) {
      await writeFile(path.join(out, WEB_FILES.module), "export default async function init() {}\n");
      await writeFile(path.join(out, WEB_FILES.wasm), fakeWasm(options.wasmBytes ?? 4096, options.random));
    }
    if (step === RustWebStep.WasmOpt) {
      await writeFile(path.join(out, WEB_FILES.optimizing), fakeWasm(options.wasmBytes ?? 2048, options.random));
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, commands };
}

async function packagingInput(name: string) {
  const home = await realpath(await tmpDir(`rust-web-${name}-`));
  const wasm = path.join(home, "in dir 'quoted'", "game.wasm");
  await mkdir(path.dirname(wasm), { recursive: true });
  await writeFile(wasm, fakeWasm(1024));
  const out = path.join(home, "out");
  return { home, wasm, out };
}

const MINIMAL_SHELL = "<title>__GAME_TITLE__</title>";
const SCRIPTED_TOOLS = { wasmBindgen: "/t/wasm-bindgen", wasmOpt: "/t/wasm-opt" };

/** An export's packaging of `wasm` into `out` with the scripted tools (the run is the caller's). */
const optimizedInput = (wasm: string, out: string) => ({
  wasm,
  out,
  shell: MINIMAL_SHELL,
  title: "x",
  optimize: true,
  tools: SCRIPTED_TOOLS,
});

describe("the web branch's packaging", () => {
  it("is a ready wasm32 builder whose served folder holds the assets", () => {
    assert.equal(RUST_WEB_BUILDER.ready, true);
    assert.equal(RUST_WEB_BUILDER.triple, "wasm32-unknown-unknown");
    assert.equal(RUST_WEB_BUILDER.macSdk, false);
    assert.equal(RUST_WEB_BUILDER.assets, true);
  });

  it("runs the pinned wasm-bindgen then wasm-opt on quoted paths and writes the page and the receipt", async () => {
    const { wasm, out } = await packagingInput("ok");
    const tools = scriptedTools(out);
    const result = await packageWeb({
      wasm,
      out,
      shell: await readFile(SHELL, "utf8"),
      title: "Pond",
      optimize: true,
      tools: { wasmBindgen: "/tools/wasm bindgen", wasmOpt: "/tools/wasm-opt" },
      run: tools.run,
    });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(tools.commands.length, 3);
    assert.equal(tools.commands[0], "'/tools/wasm bindgen' --version");
    assert.ok(tools.commands[1].includes("--target web"), tools.commands[1]);
    assert.ok(tools.commands[1].includes(`'${wasm.replaceAll("'", "'\\''")}'`), "the wasm path is shell-quoted");
    assert.ok(tools.commands[2].startsWith("'/tools/wasm-opt' -Oz"), tools.commands[2]);
    const files = (await readdir(out)).sort();
    assert.deepEqual(files, [WEB_FILES.module, WEB_FILES.wasm, WEB_FILES.page, WEB_FILES.size].sort());
    const page = await readFile(path.join(out, WEB_FILES.page), "utf8");
    assert.match(page, /<title>Pond<\/title>/);
    const optimized = await readFile(path.join(out, WEB_FILES.wasm));
    const { receipt } = result;
    assert.equal(receipt.wasmBindgen, WASM_BINDGEN_VERSION);
    assert.equal(receipt.binaryen, BINARYEN_VERSION);
    assert.equal(receipt.optimized, true);
    assert.equal(receipt.wasmBytes, optimized.length, "the receipt measures the optimized module");
    assert.equal(receipt.gzipBytes, gzipSync(optimized, { level: 9 }).length);
    assert.equal(receipt.gzipBudgetBytes, WEB_WASM_BUDGET_DEFAULT_BYTES);
    assert.equal(receipt.withinBudget, true);
    assert.equal(receipt.warning, null);
    assert.deepEqual(Object.keys(receipt.files).sort(), [WEB_FILES.module, WEB_FILES.wasm, WEB_FILES.page].sort());
    const size = JSON.parse(await readFile(path.join(out, WEB_FILES.size), "utf8"));
    assert.equal(size.gzipBytes, receipt.gzipBytes);
  });

  it("escapes a title that would close the page's tags", () => {
    const page = webShellPage(
      "<title>__GAME_TITLE__</title><h1>__GAME_TITLE__</h1>",
      `</title><script>x("&")</script>`,
    );
    const escaped = "&lt;/title&gt;&lt;script&gt;x(&quot;&amp;&quot;)&lt;/script&gt;";
    assert.equal(page, `<title>${escaped}</title><h1>${escaped}</h1>`);
  });

  it("refuses a wasm-bindgen of another version before it writes anything", async () => {
    const { wasm, out } = await packagingInput("version");
    const tools = scriptedTools(out, { version: "0.2.100" });
    const result = await packageWeb({
      wasm,
      out,
      shell: MINIMAL_SHELL,
      title: "x",
      optimize: true,
      tools: SCRIPTED_TOOLS,
      run: tools.run,
    });
    assert.equal(!result.ok && result.refusal, RustWebRefusal.BindgenVersion);
    assert.equal(tools.commands.length, 1, "nothing ran after the version check");
    assert.equal(existsSync(out), false, "no output folder");
  });

  // Flipped (pass-1 gate, owner decision 2026-10-11): past the 4 MB default the export warns
  // (slower first load on phones and weak devices) instead of being refused; only the 32 MB
  // ceiling refuses.
  it("warns, never refuses, an optimized wasm past the default 4 MB budget, and records the sizes", async () => {
    const { wasm, out } = await packagingInput("budget");
    const tools = scriptedTools(out, { wasmBytes: WEB_WASM_BUDGET_DEFAULT_BYTES + 64 * 1024, random: true });
    const result = await packageWeb({ ...optimizedInput(wasm, out), run: tools.run });
    assert.ok(result.ok, JSON.stringify(result));
    const { receipt } = result;
    assert.equal(receipt.warning, ExportWarningCode.WasmOverTarget);
    assert.equal(
      receipt.gzipBudgetBytes,
      WEB_WASM_BUDGET_DEFAULT_BYTES,
      "a game that names no budget gets the default",
    );
    assert.equal(receipt.gzipCeilingBytes, WEB_WASM_CEILING_BYTES);
    assert.equal(receipt.withinBudget, false);
    assert.ok(receipt.gzipBytes > WEB_WASM_BUDGET_DEFAULT_BYTES);
    const size = JSON.parse(await readFile(path.join(out, WEB_FILES.size), "utf8"));
    assert.equal(size.warning, ExportWarningCode.WasmOverTarget);
  });

  it("admits the same wasm without a warning under the game's own raised budget", async () => {
    const { wasm, out } = await packagingInput("raised");
    const tools = scriptedTools(out, { wasmBytes: WEB_WASM_BUDGET_DEFAULT_BYTES + 64 * 1024, random: true });
    const result = await packageWeb({ ...optimizedInput(wasm, out), budgetMb: 8, run: tools.run });
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.receipt.warning, null);
    assert.equal(result.receipt.gzipBudgetBytes, 8 * WEB_BUDGET_MB_BYTES);
    assert.equal(result.receipt.withinBudget, true);
  });

  it("refuses an optimized wasm past the 32 MB ceiling, naming the game's budget and the ceiling", async () => {
    const { wasm, out } = await packagingInput("ceiling");
    const tools = scriptedTools(out, { wasmBytes: WEB_WASM_CEILING_BYTES + 64 * 1024, random: true });
    const result = await packageWeb({ ...optimizedInput(wasm, out), budgetMb: WEB_WASM_CEILING_MB, run: tools.run });
    assert.ok(!result.ok);
    assert.equal(result.refusal, RustWebRefusal.WasmOverBudget);
    assert.match(result.detail, new RegExp(`${WEB_WASM_CEILING_MB} MB ceiling`));
    assert.match(result.detail, new RegExp(`this game's budget is ${WEB_WASM_CEILING_MB} MB`));
    assert.ok(result.receipt, "the receipt is still written");
    assert.ok(result.receipt.gzipBytes > WEB_WASM_CEILING_BYTES);
  });

  it("serves an unoptimized (Live) build past the ceiling with no warning, and still records its sizes", async () => {
    const { wasm, out } = await packagingInput("debug-budget");
    const tools = scriptedTools(out, { wasmBytes: WEB_WASM_CEILING_BYTES + 64 * 1024, random: true });
    const result = await packageWeb({
      wasm,
      out,
      shell: MINIMAL_SHELL,
      title: "x",
      optimize: false,
      tools: { wasmBindgen: "/t/wasm-bindgen", wasmOpt: null },
      run: tools.run,
    });
    assert.ok(result.ok, "a debug build is served whatever its size");
    assert.equal(result.receipt.optimized, false);
    assert.equal(result.receipt.warning, null, "Live builds never warn");
    assert.equal(result.receipt.withinBudget, false, "the receipt still measures it against the budget");
    const size = JSON.parse(await readFile(path.join(out, WEB_FILES.size), "utf8"));
    assert.equal(size.optimized, false);
    assert.equal(size.gzipBytes, result.receipt.gzipBytes);
    assert.ok(size.gzipBytes > WEB_WASM_CEILING_BYTES);
  });

  it("refuses an output folder that is a link, and a link the tools left in the output", async () => {
    const { home, wasm, out } = await packagingInput("links");
    const elsewhere = path.join(home, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, out);
    const linkedOut = await packageWeb({
      wasm,
      out,
      shell: MINIMAL_SHELL,
      title: "x",
      optimize: false,
      tools: { wasmBindgen: "/t/wasm-bindgen", wasmOpt: null },
      run: scriptedTools(out).run,
    });
    assert.equal(!linkedOut.ok && linkedOut.refusal, RustWebRefusal.OutputRefused);
    assert.deepEqual(await readdir(elsewhere), [], "nothing was written through the link");

    const planted = await packagingInput("planted");
    const secret = path.join(planted.home, "secret.txt");
    await writeFile(secret, "secret");
    const planting: WebRun = async (command, step) => {
      const answer = await scriptedTools(planted.out).run(command, step);
      if (step === RustWebStep.Bindgen) await symlink(secret, path.join(planted.out, "snippet.js"));
      return answer;
    };
    const result = await packageWeb({
      wasm: planted.wasm,
      out: planted.out,
      shell: MINIMAL_SHELL,
      title: "x",
      optimize: false,
      tools: { wasmBindgen: "/t/wasm-bindgen", wasmOpt: null },
      run: planting,
    });
    assert.equal(!result.ok && result.refusal, RustWebRefusal.OutputRefused);
    assert.equal(existsSync(path.join(planted.out, WEB_FILES.page)), false, "no page for a refused output");
  });

  it("answers a failed tool with its own refusal and its first lines", async () => {
    const { wasm, out } = await packagingInput("failed");
    const failing: WebRun = async (command, step) => {
      if (step === RustWebStep.Bindgen) return { code: 1, stdout: "", stderr: "error: bad wasm\nmore\n" };
      return scriptedTools(out).run(command, step);
    };
    const result = await packageWeb({
      wasm,
      out,
      shell: MINIMAL_SHELL,
      title: "x",
      optimize: true,
      tools: SCRIPTED_TOOLS,
      run: failing,
    });
    assert.equal(!result.ok && result.refusal, RustWebRefusal.BindgenFailed);
    assert.match(!result.ok ? result.detail : "", /bad wasm/);
  });
});

describe("the asset map a web build serves beside its staged assets", () => {
  /** The map of a folder written by `plant`, with a tiny per-file cap so an oversized row is cheap. */
  async function mapOf(plant: (assets: string, outside: string) => Promise<void>) {
    const root = await realpath(await tmpDir("rust-web-asset-map-"));
    const assets = path.join(root, "assets");
    const outside = path.join(root, "outside");
    await mkdir(path.join(assets, "models"), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "secret.glb"), "secret bytes outside assets");
    await plant(assets, outside);
    return webAssetMap(assets, { maxFileBytes: 64, maxTotalBytes: 1024, maxFiles: 16 });
  }

  it("lists every staged regular file with its length and FNV-1a 64, sorted", async () => {
    const map = await mapOf(async (assets) => {
      await writeFile(path.join(assets, "models", "sphere.glb"), "glTF sphere");
      await writeFile(path.join(assets, "a.png"), "png");
    });
    assert.equal(map.version, WEB_ASSET_MAP_VERSION);
    assert.deepEqual(map.files, [
      { path: "a.png", bytes: 3, fnv1a64: fnv1a64(Buffer.from("png")) },
      { path: "models/sphere.glb", bytes: 11, fnv1a64: fnv1a64(Buffer.from("glTF sphere")) },
    ]);
  });

  const hostile: ReadonlyArray<{ name: string; plant: (assets: string, outside: string) => Promise<void> }> = [
    {
      name: "a link to a file outside assets",
      plant: (a, o) => symlink(path.join(o, "secret.glb"), path.join(a, "x.glb")),
    },
    { name: "a linked folder", plant: (a, o) => symlink(o, path.join(a, "linked")) },
    { name: "a file over the per-file cap", plant: (a) => writeFile(path.join(a, "huge.glb"), Buffer.alloc(65)) },
    { name: "a device name", plant: (a) => writeFile(path.join(a, "con.glb"), "x") },
    { name: "a trailing dot", plant: (a) => writeFile(path.join(a, "dot.glb."), "x") },
    { name: "a backslash in the name", plant: (a) => writeFile(path.join(a, "back\\slash.glb"), "x") },
    { name: "a name outside the asset alphabet", plant: (a) => writeFile(path.join(a, "q?.glb"), "x") },
  ];
  for (const row of hostile) {
    it(`leaves out ${row.name}: nothing the shell could fetch, never the bytes behind it`, async () => {
      const map = await mapOf(async (assets, outside) => {
        await writeFile(path.join(assets, "models", "ok.glb"), "ok");
        await row.plant(assets, outside);
      });
      assert.deepEqual(
        map.files.map((file) => file.path),
        ["models/ok.glb"],
      );
    });
  }

  it("stops at the file count and the total byte caps", async () => {
    const map = await mapOf(async (assets) => {
      for (let i = 0; i < 40; i++)
        await writeFile(path.join(assets, `f${String(i).padStart(2, "0")}.bin`), Buffer.alloc(60));
    });
    assert.ok(map.files.length <= 16, `${map.files.length} files`);
    const total = map.files.reduce((sum, file) => sum + file.bytes, 0);
    assert.ok(total <= 1024, `${total} bytes`);
  });

  it("is an empty map for a build with no assets folder", async () => {
    const root = await realpath(await tmpDir("rust-web-asset-map-none-"));
    assert.deepEqual(await webAssetMap(path.join(root, "assets")), { version: WEB_ASSET_MAP_VERSION, files: [] });
  });
});

// ── the browser ──

const toolchainSkip = (): string | false => {
  if (process.platform === "win32") return "not run: the Rust web rows are POSIX-only";
  if (existsSync(CARGO) && existsSync(WASM_BINDGEN) && existsSync(WASM_OPT)) return false;
  if (process.env.GENEX_REQUIRE_TOOLCHAINS === "1") {
    throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: no Rust toolchain at ${TOOLCHAIN}`);
  }
  return "not run: the Rust toolchain with wasm-bindgen and wasm-opt is not installed";
};

const browserSkip = (): string | false => {
  const toolchain = toolchainSkip();
  if (toolchain) return toolchain;
  if (process.env.STUDIO_BROWSER_TESTS !== "1") return "launches Chromium; set STUDIO_BROWSER_TESTS=1 to run";
  return playwrightHeadlessChromiumOnDisk()
    ? false
    : "no Playwright Chromium is installed; this suite never downloads one";
};

function fnv1a64(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, "0");
}

function distinctColours(bgra: Uint8Array): number {
  const colours = new Set<number>();
  for (let i = 0; i < bgra.length && colours.size < NONBLANK_MIN_COLOURS; i += 4) {
    colours.add((bgra[i] << 16) | (bgra[i + 1] << 8) | bgra[i + 2]);
  }
  return colours.size;
}

async function cargo(args: string[]): Promise<void> {
  await execFileAsync(process.execPath, [RUST_ENV, "--", "cargo", ...args, "--offline", "--locked"], {
    timeout: BUILD_TIMEOUT_MS,
    maxBuffer: OUTPUT_MAX_BYTES,
    cwd: REPO,
  });
}

/** The real tools, run by bash with the command line `packageWeb` quoted. */
const realRun: WebRun = async (command) => {
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: OUTPUT_MAX_BYTES,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string; stderr?: string };
    const code = typeof failed.code === "number" ? failed.code : 1;
    return { code, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
};

async function packaged(wasm: string, out: string, title: string) {
  const result = await packageWeb({
    wasm,
    out,
    shell: await readFile(SHELL, "utf8"),
    title,
    optimize: true,
    tools: { wasmBindgen: WASM_BINDGEN, wasmOpt: WASM_OPT },
    run: realRun,
  });
  assert.ok(result.ok, `packageWeb refused: ${JSON.stringify(result)}`);
  // The lane writes the asset map beside every web package (an empty map for a game without assets):
  // the page fetches it at boot, so a package without it is refused at asset-fetch.
  await writeWebAssetMap(out);
  return result.receipt;
}

async function nativeSelfTest(stateDir: string): Promise<{ record: SelfTestRecord } | null> {
  const args = ["--self-test", String(PARITY_TICKS), "--seed", String(PARITY_SEED), "--demo", PARITY_DEMO];
  try {
    const { stdout } = await execFileAsync(NATIVE_POND, [...args, "--state-dir", stateDir], {
      timeout: RUN_TIMEOUT_MS,
      maxBuffer: OUTPUT_MAX_BYTES,
    });
    return { record: JSON.parse(stdout) as SelfTestRecord };
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    if (stderr.includes(`"code":"${GPU_UNSUPPORTED}"`) && !metalRequired()) return null;
    throw error;
  }
}

function skipWithoutGpu(t: TestContext, run: unknown): boolean {
  if (run !== null) return false;
  t.skip("not run: no GPU the renderer accepts (GENEX_REQUIRE_METAL=1 makes this a failure)");
  return true;
}

function assertNear(web: unknown, native: unknown, where: string): void {
  if (typeof native === "number") {
    assert.equal(typeof web, "number", `${where} is a number on the web`);
    assert.ok(Math.abs((web as number) - native) <= PROBE_TOLERANCE, `${where}: web ${web} vs native ${native}`);
    return;
  }
  if (native !== null && typeof native === "object") {
    assert.ok(web !== null && typeof web === "object", `${where} is an object on the web`);
    const keys = Object.keys(native);
    assert.deepEqual(Object.keys(web as object), keys, `${where} has the same fields`);
    for (const key of keys) {
      assertNear((web as Record<string, unknown>)[key], (native as Record<string, unknown>)[key], `${where}.${key}`);
    }
    return;
  }
  assert.deepEqual(web, native, where);
}

function pixelDifference(a: Uint8Array, b: Uint8Array): { mean: number; offShare: number } {
  assert.equal(a.length, b.length, "captures of one size");
  let total = 0;
  let off = 0;
  for (let i = 0; i < a.length; i += 4) {
    let worst = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a[i + c] - b[i + c]);
      if (c < 3) total += d;
      worst = Math.max(worst, d);
    }
    if (worst > PIXEL_STEP) off++;
  }
  const pixels = a.length / 4;
  return { mean: total / (pixels * 3), offShare: off / pixels };
}

interface Served {
  origin: string;
  requests: string[];
  close: () => void;
}

/** A static server over one packaged folder, recording every path asked for. */
async function serve(root: string): Promise<Served> {
  const requests: string[] = [];
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    requests.push(pathname);
    const file = path.join(root, path.normalize(pathname));
    const stat = await lstat(file).catch(() => null);
    if (!file.startsWith(`${root}${path.sep}`) || !stat?.isFile()) {
      res.writeHead(404).end();
      return;
    }
    const type = CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, requests, close: () => server.close() };
}

interface RawCapture {
  width: number;
  height: number;
  digest: string;
  bgra: Uint8Array;
}

type Studio = Record<string, (arg?: unknown) => unknown>;
interface ShellWindow {
  GenexShell: {
    status: Record<string, unknown>;
    module: {
      studio_capture(): Promise<RawCapture>;
      studio_self_test(ticks: number, seed: number, demo: string): Promise<string>;
      studio_call(op: string, arg: string): string;
    };
    flushSaves(): Promise<void>;
  };
  __studio: Studio;
}

async function waitBooted(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const state = (window as unknown as { GenexShell?: { status: { state: string } } }).GenexShell?.status.state;
      return state !== undefined && state !== "starting";
    },
    undefined,
    { timeout: BOOT_TIMEOUT_MS },
  );
}

/** Every console warning and error `page` logs from now on (Chromium logs WebGPU validation there). */
function consoleProblems(page: Page): string[] {
  const seen: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning" || message.type() === "error") seen.push(message.text());
  });
  return seen;
}

async function openShell(context: BrowserContext, origin: string, init?: string): Promise<Page> {
  const page = await context.newPage();
  if (init) await page.addInitScript(init);
  await page.goto(`${origin}/index.html?paused`);
  await waitBooted(page);
  return page;
}

const status = (page: Page) => page.evaluate(() => (window as unknown as ShellWindow).GenexShell.status);
const verb = (page: Page, name: string, arg?: unknown) =>
  page.evaluate(([n, a]) => (window as unknown as ShellWindow).__studio[n as string](a), [name, arg] as const);

/** The module's capture, base64 across the page boundary. */
const rawCapture = (page: Page) =>
  page.evaluate(async () => {
    const pending = (window as unknown as ShellWindow).GenexShell.module.studio_capture();
    if (!(pending instanceof Promise)) throw new Error("studio_capture did not return a promise");
    const taken = await pending;
    let binary = "";
    for (let i = 0; i < taken.bgra.length; i += 0x8000) {
      binary += String.fromCharCode(...taken.bgra.subarray(i, i + 0x8000));
    }
    return { width: taken.width, height: taken.height, digest: taken.digest, base64: btoa(binary) };
  });

/** `renderSettings` through the module's one verb export (the shell binds no page verb for it). */
async function renderSettings(page: Page, set: { preset: EffectivePreset; features: Record<string, boolean> | null }) {
  const reply = await page.evaluate(
    ([op, arg]) => JSON.parse((window as unknown as ShellWindow).GenexShell.module.studio_call(op, arg)),
    [NativeOp.RenderSettings, JSON.stringify({ set })] as const,
  );
  assert.equal(reply.ok, true, `renderSettings refused: ${JSON.stringify(reply)}`);
  assert.equal(reply.result.preset, set.preset);
}

/** A capture's BGRA bytes and size. */
async function decodedCapture(page: Page): Promise<{ bgra: Uint8Array; width: number; height: number }> {
  const capture = await rawCapture(page);
  return { bgra: new Uint8Array(Buffer.from(capture.base64, "base64")), width: capture.width, height: capture.height };
}

/** A `data:image/png;base64,` URL's bytes. */
function pngBytes(url: unknown): Buffer {
  return Buffer.from(String(url).replace(/^data:image\/png;base64,/, ""), "base64");
}

const lumaAt = (bgra: Uint8Array, i: number) =>
  0.0722 * bgra[i * 4] + 0.7152 * bgra[i * 4 + 1] + 0.2126 * bgra[i * 4 + 2];
const isBlock = (bgra: Uint8Array, i: number) => bgra[i * 4 + 2] - bgra[i * 4] >= BLOCK_RED_OVER_BLUE;

/** Whether pixel (x, y) and every pixel within BLOCK_ERODE of it belong to the block. */
function insideBlock(bgra: Uint8Array, width: number, height: number, x: number, y: number): boolean {
  for (let dy = -BLOCK_ERODE; dy <= BLOCK_ERODE; dy++) {
    for (let dx = -BLOCK_ERODE; dx <= BLOCK_ERODE; dx++) {
      const [px, py] = [x + dx, y + dy];
      if (px < 0 || py < 0 || px >= width || py >= height || !isBlock(bgra, py * width + px)) return false;
    }
  }
  return true;
}

/** Each column's lowest block pixel in `bgra` (-1 without one): where the block meets the floor. */
function floorLine(bgra: Uint8Array, width: number, height: number): number[] {
  return Array.from({ length: width }, (_, x) => {
    for (let y = height - 1; y >= 0; y--) if (isBlock(bgra, y * width + x)) return y;
    return -1;
  });
}

/** The floor pixels of the lower half `capture` darkens below FLOOR_SHADOW_RATIO of `reference`. */
function floorShadowPixels(
  capture: { bgra: Uint8Array; width: number; height: number },
  reference: { bgra: Uint8Array },
) {
  const { width, height } = capture;
  let count = 0;
  for (let i = Math.ceil(height / 2) * width; i < width * height; i++) {
    const floor = !isBlock(reference.bgra, i);
    if (floor && lumaAt(capture.bgra, i) < FLOOR_SHADOW_RATIO * lumaAt(reference.bgra, i)) count++;
  }
  return count;
}

/**
 * The block's pixels a capture darkens below SELF_SHADOW_RATIO of its unshadowed reference (above
 * the contact rows), its mean luma ratio, and the floor pixels in its shadow (lower half).
 */
function selfShadow(
  capture: { bgra: Uint8Array; width: number; height: number },
  reference: { bgra: Uint8Array },
): { darkShare: number; meanRatio: number; floorShadow: number } {
  const { width, height } = capture;
  const bottom = floorLine(reference.bgra, width, height);
  let [block, dark, sum, sumReference] = [0, 0, 0, 0];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!insideBlock(reference.bgra, width, height, x, y)) continue;
      const [lit, unshadowed] = [lumaAt(capture.bgra, y * width + x), lumaAt(reference.bgra, y * width + x)];
      block++;
      sum += lit;
      sumReference += unshadowed;
      if (y + CONTACT_ROWS < bottom[x] && lit < SELF_SHADOW_RATIO * unshadowed) dark++;
    }
  }
  assert.ok(block > 1000, `the block covers ${block} measured pixels`);
  const meanRatio = Number((sum / Math.max(sumReference, 1)).toFixed(3));
  return { darkShare: dark / block, meanRatio, floorShadow: floorShadowPixels(capture, reference) };
}

/** What one capture's {@link selfShadow} measures says is wrong, labelled. */
function selfShadowProblems(label: string, measured: ReturnType<typeof selfShadow>): string[] {
  const problems: string[] = [];
  if (measured.darkShare > SELF_SHADOW_SHARE_MAX || measured.meanRatio < BLOCK_MEAN_RATIO_MIN) {
    const share = (measured.darkShare * 100).toFixed(1);
    problems.push(`${label}: ${share}% self-shadowed, mean ${measured.meanRatio}`);
  }
  if (measured.floorShadow < FLOOR_SHADOW_PIXELS_MIN)
    problems.push(`${label}: floor shadow ${measured.floorShadow} px`);
  return problems;
}

/** Instruments the game canvas: any `toDataURL` or `toBlob` of it is recorded. */
const CANVAS_READS = `{
  window.__canvasReads = [];
  const record = (name, original) => function (...args) {
    if (this.id === "game") window.__canvasReads.push(name);
    return original.apply(this, args);
  };
  HTMLCanvasElement.prototype.toDataURL = record("toDataURL", HTMLCanvasElement.prototype.toDataURL);
  HTMLCanvasElement.prototype.toBlob = record("toBlob", HTMLCanvasElement.prototype.toBlob);
}`;

/** IndexedDB puts throw the quota error a full origin raises. */
const QUOTA_FULL = `{
  IDBObjectStore.prototype.put = function () {
    throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
  };
}`;

const BELOW_CORE: ReadonlyArray<{ name: string; init: string; reason: string; limit?: string }> = [
  { name: "navigator.gpu absent", init: "delete Navigator.prototype.gpu;", reason: Reason.NoWebGpu },
  { name: "no adapter", init: "GPU.prototype.requestAdapter = async () => null;", reason: Reason.NoAdapter },
  {
    name: "an adapter below core",
    init: `{
      const real = GPU.prototype.requestAdapter;
      GPU.prototype.requestAdapter = async function (options) {
        const adapter = await real.call(this, options);
        if (!adapter) return adapter;
        const limits = new Proxy(adapter.limits, {
          get: (target, key) => (key === "maxComputeInvocationsPerWorkgroup" ? 128 : Reflect.get(target, key)),
        });
        return new Proxy(adapter, { get: (target, key) => (key === "limits" ? limits : Reflect.get(target, key)) });
      };
    }`,
    reason: Reason.LimitBelowCore,
    limit: "maxComputeInvocationsPerWorkgroup",
  },
];

describe("a rust-wgpu game in Chromium's WebGPU, packaged by the web branch", { skip: browserSkip() }, () => {
  let browser: Browser;
  let pond: Served;
  let saves: Served;
  let template: Served;
  let pondReceipt: Awaited<ReturnType<typeof packaged>>;

  before(
    async () => {
      const home = await realpath(await tmpDir("rust-web-browser-"));
      const wasm32 = ["--target", "wasm32-unknown-unknown", "--release"];
      await cargo(["build", "-p", "pond", "--lib", ...wasm32]);
      await cargo(["build", "-p", "genex-platform-web", "--example", "web_saves", ...wasm32]);
      await cargo(["build", "-p", "template-web", "--bin", "template-web", ...wasm32]);
      await cargo(["build", "-p", "pond", "--bin", "pond"]);
      pondReceipt = await packaged(path.join(WASM_DIR, "pond_game.wasm"), path.join(home, "pond"), "Pond");
      await packaged(path.join(WASM_DIR, "examples", "web_saves.wasm"), path.join(home, "saves"), "Saves");
      await packaged(path.join(WASM_DIR, "template-web.wasm"), path.join(home, "template"), "Template");
      pond = await serve(path.join(home, "pond"));
      saves = await serve(path.join(home, "saves"));
      template = await serve(path.join(home, "template"));
      const args = CHROMIUM_ARGS[process.platform] ?? DEFAULT_CHROMIUM_ARGS;
      browser = await chromium.launch({ headless: true, args });
    },
    { timeout: BUILD_TIMEOUT_MS },
  );
  after(async () => {
    await browser?.close();
    pond?.close();
    saves?.close();
    template?.close();
  });

  it("keeps the pond's wasm within the default 4 MB gzip budget with no warning, asserted in the receipt", (t) => {
    t.diagnostic(`pond wasm ${pondReceipt.wasmBytes} bytes, gzip -9 ${pondReceipt.gzipBytes} bytes`);
    assert.equal(pondReceipt.withinBudget, true);
    assert.ok(pondReceipt.gzipBytes <= WEB_WASM_BUDGET_DEFAULT_BYTES, `gzip ${pondReceipt.gzipBytes}`);
    assert.equal(pondReceipt.warning, null);
    assert.equal(pondReceipt.optimized, true);
  });

  it("runs the template's own main.rs: genex::install hands the game to the page, which ticks it and captures it", {
    timeout: 2 * BOOT_TIMEOUT_MS,
  }, async (t) => {
    const context = await browser.newContext();
    const page = await openShell(context, template.origin);
    const shell = await status(page);
    assert.equal(shell.state, ShellState.Running, `the shell refused: ${JSON.stringify(shell)}`);
    const before = (await verb(page, "state")) as { frame: number; volatile?: { render?: unknown } };
    t.diagnostic(`the browser's class and the preset it drew: ${JSON.stringify(before.volatile?.render ?? null)}`);
    // Owner decision 2026-10-12 (b): a phone below scale 1 upscales with EASU + RCAS at every
    // preset, never the plain bilinear stretch (headless Chromium sends no hints: a phone class).
    const drawn = parseRenderStatus(before.volatile?.render);
    assert.ok(drawn, "the page reports what it drew");
    const phoneBelowOne = drawn.deviceClass.startsWith(`${FormFactor.Mobile}-`) && drawn.scale < 1;
    assert.ok(phoneBelowOne, `the premise: a phone class below scale 1 (${drawn.deviceClass} at ${drawn.scale})`);
    assert.equal(
      drawn.features[RenderFeature.Upscaler],
      true,
      `${drawn.deviceClass} at ${drawn.preset} upscales with EASU + RCAS`,
    );
    const stepped = (await verb(page, "step", 1000)) as { frame: number; steppedFrames: number };
    assert.equal(stepped.steppedFrames, 60, "the installed game ticks");
    const after = (await verb(page, "state")) as { frame: number };
    assert.equal(after.frame, before.frame + 60);
    const capture = await rawCapture(page);
    const bytes = new Uint8Array(Buffer.from(capture.base64, "base64"));
    assert.deepEqual([capture.width, capture.height], [TEMPLATE_WORLD.width, TEMPLATE_WORLD.height]);
    assert.equal(fnv1a64(bytes), capture.digest);
    assert.ok(distinctColours(bytes) >= NONBLANK_MIN_COLOURS, "the starter's floor and block are drawn");
    await context.close();
  });

  it("draws the turning block with no shadow of its own at every preset, and its floor shadow stays", {
    timeout: 4 * BOOT_TIMEOUT_MS,
  }, async (t) => {
    const context = await browser.newContext();
    const page = await openShell(context, template.origin);
    assert.equal((await status(page)).state, ShellState.Running);
    // Every preset's pipelines are valid WebGPU: an invalid one (G0: the background motion's
    // written normals target) rejects the frame and leaves the canvas black at TAA presets.
    const logged = consoleProblems(page);
    const out = process.env.GENEX_TEMPLATE_WEB_OUT;
    if (out) await mkdir(out, { recursive: true });
    const problems: string[] = [];
    for (const [pose, ms] of SELF_SHADOW_STEPS_MS.entries()) {
      await verb(page, "step", ms);
      for (const preset of EFFECTIVE_PRESETS) {
        await renderSettings(page, { preset, features: UNSHADOWED });
        const reference = await decodedCapture(page);
        await renderSettings(page, { preset, features: null });
        const capture = await decodedCapture(page);
        const label = `${preset}-pose${pose}`;
        if (out) await writeFile(path.join(out, `block-${label}.png`), pngBytes(await verb(page, "capture")));
        const measured = selfShadow(capture, reference);
        t.diagnostic(`${label}: ${JSON.stringify(measured)}`);
        problems.push(...selfShadowProblems(label, measured));
      }
    }
    assert.deepEqual(problems, []);
    assert.deepEqual(logged, [], "no WebGPU validation warning or error at any preset");
    await context.close();
  });

  it("awaits studio_capture from the world target and never reads the canvas", {
    timeout: 2 * BOOT_TIMEOUT_MS,
  }, async () => {
    const context = await browser.newContext();
    const page = await openShell(context, pond.origin, CANVAS_READS);
    const shell = await status(page);
    assert.equal(shell.state, ShellState.Running, `the shell refused: ${JSON.stringify(shell)}`);
    const capture = await rawCapture(page);
    const bytes = new Uint8Array(Buffer.from(capture.base64, "base64"));
    assert.deepEqual([capture.width, capture.height], [POND_WORLD.width, POND_WORLD.height]);
    assert.equal(fnv1a64(bytes), capture.digest, "the digest is FNV-1a 64 of the BGRA bytes");
    assert.ok(distinctColours(bytes) >= NONBLANK_MIN_COLOURS, "the capture is not blank");
    await page.evaluate(() => {
      const notes: unknown[] = [];
      Object.assign(window, {
        __captureNotes: notes,
        __studioCapture: { note: (record: unknown) => notes.push(record) },
      });
    });
    const png = (await verb(page, "capture")) as string;
    assert.match(png, /^data:image\/png;base64,/);
    // The capture shim gets the world target's digest and size, so provenance and the parity row can carry them.
    const notes = await page.evaluate(() => (window as unknown as { __captureNotes: unknown[] }).__captureNotes);
    assert.deepEqual(
      notes.map((note) => {
        const { digest, width, height } = note as { digest?: unknown; width?: unknown; height?: unknown };
        return { digest, width, height };
      }),
      [{ digest: capture.digest, width: capture.width, height: capture.height }],
    );
    const reads = await page.evaluate(() => (window as unknown as { __canvasReads: string[] }).__canvasReads);
    assert.deepEqual(reads, [], "the game canvas is never read");
    await context.close();
  });

  it("agrees with the native pond's digests within the parity tolerance", {
    timeout: 2 * RUN_TIMEOUT_MS,
  }, async (t) => {
    const home = await realpath(await tmpDir("rust-web-parity-"));
    const native = await nativeSelfTest(home);
    if (skipWithoutGpu(t, native) || !native) return;
    const context = await browser.newContext();
    const page = await openShell(context, pond.origin);
    const text = await page.evaluate(
      ([ticks, seed, demo]) => (window as unknown as ShellWindow).GenexShell.module.studio_self_test(ticks, seed, demo),
      [PARITY_TICKS, PARITY_SEED, PARITY_DEMO] as const,
    );
    const web = JSON.parse(text) as SelfTestRecord;
    assert.equal(web.frame, native.record.frame);
    assertNear(web.probes, native.record.probes, "probes");
    const last = native.record.captures.length;
    const capture = await rawCapture(page);
    const nativeBytes = new Uint8Array(await readFile(path.join(home, "captures", `${last}.bgra`)));
    const difference = pixelDifference(new Uint8Array(Buffer.from(capture.base64, "base64")), nativeBytes);
    const equal = web.captures.filter((c, i) => c.digest === native.record.captures[i].digest).length;
    t.diagnostic(
      `parity: digests ${equal}/${last} equal, mean ${difference.mean.toFixed(4)}, ` +
        `off ${(difference.offShare * 100).toFixed(3)}%`,
    );
    assert.ok(difference.mean <= PIXEL_MEAN_TOLERANCE, `mean channel difference ${difference.mean}`);
    assert.ok(difference.offShare <= PIXEL_OFF_SHARE, `share of pixels off ${difference.offShare}`);
    await context.close();
  });

  for (const row of BELOW_CORE) {
    it(`shows the designed page, reports gpu-unsupported and never loads the wasm: ${row.name}`, {
      timeout: 2 * BOOT_TIMEOUT_MS,
    }, async () => {
      const context = await browser.newContext();
      pond.requests.length = 0;
      const page = await openShell(context, pond.origin, row.init);
      const shell = await status(page);
      assert.equal(shell.state, ShellState.Unsupported);
      assert.equal(shell.code, GPU_UNSUPPORTED);
      assert.equal(shell.reason, row.reason);
      assert.equal(shell.limit, row.limit ?? null);
      assert.ok(await page.locator("#unsupported").isVisible(), "the designed page is shown");
      assert.ok(await page.locator("#game").isHidden(), "no canvas");
      const text = await page.locator("#unsupported").innerText();
      assert.match(text, /This game needs WebGPU/);
      assert.match(text, /Safari 26/);
      assert.match(text, new RegExp(GPU_UNSUPPORTED));
      // The host's and the prober's read: the page contract answers the typed code.
      const state = (await verb(page, "state")) as { error: string; volatile: { gpu: { reason: string } } };
      assert.equal(state.error, GPU_UNSUPPORTED);
      assert.equal(state.volatile.gpu.reason, row.reason);
      const stepBound = await page.evaluate(() => typeof (window as unknown as ShellWindow).__studio.step);
      assert.equal(stepBound, "undefined", "no verb drives a game that never started");
      assert.deepEqual(
        pond.requests.filter((r) => r !== "/index.html"),
        [],
        "the game's module and wasm are never fetched",
      );
      await context.close();
    });
  }

  async function savedCount(page: Page): Promise<{ count: number; loaded: number }> {
    const state = (await verb(page, "state")) as { saves: { count: number; loaded: number } };
    return state.saves;
  }

  async function pressSpace(page: Page): Promise<void> {
    await verb(page, "injectInput", { down: ["Space"] });
    await verb(page, "step", 17);
    await verb(page, "injectInput", { up: ["Space"] });
    await verb(page, "step", 17);
  }

  it("keeps a save across a reload through the IndexedDB mirror, loaded before the first reset", {
    timeout: 2 * BOOT_TIMEOUT_MS,
  }, async () => {
    const context = await browser.newContext();
    const page = await openShell(context, saves.origin);
    assert.equal((await status(page)).state, ShellState.Running);
    assert.deepEqual(await savedCount(page), { count: 0, loaded: 0 });
    await pressSpace(page);
    await pressSpace(page);
    assert.equal((await savedCount(page)).count, 2);
    // Hidden: the shell flushes the mirror write-behind.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(
      () => {
        const state = (window as unknown as ShellWindow).__studio.state() as {
          volatile?: { saves?: { pending: number; inFlight: number } };
        };
        return state.volatile?.saves?.pending === 0 && state.volatile?.saves?.inFlight === 0;
      },
      undefined,
      { timeout: FLUSH_TIMEOUT_MS },
    );
    await page.reload();
    await waitBooted(page);
    assert.deepEqual(await savedCount(page), { count: 2, loaded: 2 }, "the reset hook read the saved count");
    const state = (await verb(page, "state")) as { error: unknown };
    assert.equal(state.error, null);
    await context.close();
  });

  it("surfaces a quota error as save-quota in state() and on the page, and keeps the save pending", {
    timeout: 2 * BOOT_TIMEOUT_MS,
  }, async () => {
    const context = await browser.newContext();
    const page = await openShell(context, saves.origin, QUOTA_FULL);
    await pressSpace(page);
    await page.evaluate(() => (window as unknown as ShellWindow).GenexShell.flushSaves());
    const state = (await verb(page, "state")) as {
      error: string;
      volatile: { saves: { error: string; pending: number } };
    };
    assert.equal(state.error, SAVE_QUOTA);
    assert.equal(state.volatile.saves.error, SAVE_QUOTA);
    assert.equal(state.volatile.saves.pending, 1, "the refused write waits for the next flush");
    assert.ok(await page.locator("#save-notice").isVisible(), "the page tells the player");
    assert.equal(await page.locator("#save-notice").getAttribute("data-genex-code"), SAVE_QUOTA);
    await context.close();
  });
});
