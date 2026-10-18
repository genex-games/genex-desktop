/**
 * The Rust web shell's loading state (renderer pass 2, owner decision D11): from the first paint
 * until the game's first lit frame the page shows a lit, animated loading screen with real progress
 * (the wasm's bytes, the staged assets, the device, the pipelines n of m, the first frame), styled
 * by the game's `[render.loading]` table, and a boot that stops progressing ends in a typed
 * `boot-timeout` card naming the stage, never a black, blank or frozen page.
 *
 * - Stand-in rows (no Rust toolchain): the game's `game.js` is written here. The first-paint and
 *   timeout rows use a stand-in adapter at core limits; the progress row draws with the browser's
 *   real WebGPU (skipped where this Chromium has none), so the pipelines it creates are recorded
 *   by the shell's dry boot and compiled with `create*PipelineAsync` before its own boot runs.
 * - Lakeside rows (with the toolchain): the showcase built by `web-showcase.sh` starts cold (every
 *   page's WGSL perturbed, so no shader cache answers) and the compositor must keep producing
 *   frames, each lit, from the first paint to the game's first frame. `GENEX_LAKESIDE_WEB_DIR`
 *   names a package the script wrote earlier instead (its page rewritten from this shell), and
 *   `GENEX_LOADING_EVIDENCE` a file the row writes its screenshot timings and events to.
 *
 * Browser rows launch Playwright's headless Chromium only with `STUDIO_BROWSER_TESTS=1` and a
 * Chromium already installed; nothing is downloaded.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type Browser, chromium, type Page } from "@playwright/test";
import { webShellPage } from "../../src/main/rust-build-web.ts";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import { BootStage } from "../../src/shared/native-contract.ts";
import { playwrightHeadlessChromiumOnDisk } from "../helpers/playwright-chromium.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SHELL = path.join(REPO, "src", "game-template-rust", "web", "shell.html");
const WEB_SHOWCASE = path.join(REPO, "scripts", "spike", "rust-wgpu", "web-showcase.sh");
const TOOLCHAIN = process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev", "spike-toolchain");
const CARGO = path.join(TOOLCHAIN, "sysroot", "bin", "cargo");
const BOOT_TIMEOUT_MS = 30 * SECOND_MS;
const LAKESIDE_BOOT_TIMEOUT_MS = 120 * SECOND_MS;
const BUILD_TIMEOUT_MS = 30 * MINUTE_MS;
const OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
const BOOT_TIMEOUT_CODE = "boot-timeout";
/** The shell's status states (shell.html). Wire values. */
const ShellState = { Starting: "starting", Running: "running", Failed: "failed" } as const;
/** Chromium's WebGPU on the Mac's GPU (Metal) rather than SwiftShader. */
const WEBGPU_ARGS = ["--enable-unsafe-webgpu", "--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"];
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".png": "image/png",
};
/** The smallest valid wasm module: the magic and version 1. */
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
/** A 1×1 PNG, the logo the styled row names. */
const LOGO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);
/** Pipelines the drawing stand-in creates at boot (each its own override constant: its own compile). */
const STAND_IN_PIPELINES = 12;
/** While the pipelines compile, the compositor hands back a screenshot within this (4.2 s before D11). */
const FROZEN_MS = 500;
/**
 * Across the whole boot, no frame takes longer than this. The game's first frame and uploads run
 * on the browser's GPU thread too: Lakeside's renderer writes its whole vertex buffer again for
 * every model it adds (528 MB through `writeBuffer` at boot), which holds one frame 0.35-0.65 s
 * until the renderer writes only what it appends.
 */
const BOOT_FRAME_MAX_MS = 1000;
/** A screenshot is lit when at least this share of its pixels is brighter than LIT_LUMA. */
const LIT_SHARE = 0.005;
const LIT_LUMA = 60;
/** Lakeside creates at least this many pipelines at boot (40 render and 24 compute in A.12). */
const LAKESIDE_PIPELINES_MIN = 30;

/** A WebGPU adapter at core limits (every maximum huge, every alignment 1), so the preflight passes. */
const CORE_ADAPTER = `{
  const limits = new Proxy({}, { get: (_t, key) => (String(key).startsWith("min") ? 1 : 1e9) });
  const gpu = { requestAdapter: async () => ({ limits }) };
  Object.defineProperty(Navigator.prototype, "gpu", { configurable: true, get: () => gpu });
}`;

/** Every progress event the page dispatches, and its `GenexShell.progress`, recorded from the first script. */
const PROGRESS_LOG = `{
  window.__progress = [];
  addEventListener("genex:progress", (event) => window.__progress.push({ ...event.detail, at: performance.now() }));
}`;

const browserSkip = (): string | false => {
  if (process.env.STUDIO_BROWSER_TESTS !== "1") return "launches Chromium; set STUDIO_BROWSER_TESTS=1 to run";
  return playwrightHeadlessChromiumOnDisk()
    ? false
    : "no Playwright Chromium is installed; this suite never downloads one";
};

const lakesideSkip = (): string | false => {
  if (process.platform === "win32") return "not run: the Rust web rows are POSIX-only";
  if (!existsSync(CARGO)) {
    if (process.env.GENEX_REQUIRE_TOOLCHAINS === "1")
      throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: no toolchain at ${TOOLCHAIN}`);
    return "not run: the Rust toolchain is not installed";
  }
  return browserSkip();
};

/** A static server over `root`; `hold` names paths answered only once `release(path)` is called. */
async function serve(root: string, hold: readonly string[] = []) {
  const waiting = new Map<string, () => void>();
  const held = new Map(hold.map((name) => [name, new Promise<void>((done) => waiting.set(name, done))]));
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    await held.get(pathname);
    const file = path.join(root, path.normalize(pathname));
    const found = await lstat(file).catch(() => null);
    const body = file.startsWith(`${root}${path.sep}`) && found?.isFile() ? await readFile(file) : null;
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    const type = CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, release: (name: string) => waiting.get(name)?.(), close: () => server.close() };
}

/** The exports every stand-in shares (saves and assets accepted, nothing kept). */
const STAND_IN_COMMON = [
  "export default async function init() {}",
  'export function studio_saves_database() { return "genex-shell-loading-test"; }',
  "export function studio_saves_preload() {}",
  "export function studio_saves_unavailable() {}",
  'export function studio_saves_status() { return "{}"; }',
  "export function studio_saves_pending() { return 0; }",
  "export function studio_saves_take() { return []; }",
  "export function studio_saves_flushed() {}",
  "export function studio_call(op) { return JSON.stringify({ id: null, ok: true, op, result: {} }); }",
];

/** A stand-in that boots at once (no GPU) and draws nothing. */
const QUIET_MODULE = [
  ...STAND_IN_COMMON,
  "export function studio_assets_plan(map) { return JSON.parse(map).files.map((file) => [file.path, file.bytes]); }",
  "export function studio_assets_preload() {}",
  "export async function studio_boot() { return JSON.stringify({ ok: true, receipt: {}, world: [64, 64] }); }",
  "export function studio_frame() { return 1; }",
  "",
].join("\n");

/** A stand-in whose boot never answers. */
const STUCK_MODULE = [
  ...STAND_IN_COMMON,
  "export function studio_assets_plan() { return []; }",
  "export function studio_assets_preload() {}",
  "export function studio_boot() { return new Promise(() => {}); }",
  "export function studio_frame() { return 0; }",
  "",
].join("\n");

/**
 * A stand-in that draws with the browser's WebGPU as wgpu does: its boot opens a device, creates
 * {@link STAND_IN_PIPELINES} render pipelines with the synchronous call (one compile each) and
 * configures the canvas; each frame clears it to a lit orange with the first pipeline bound. It runs
 * in a worker too (the shell's dry boot), so it never touches `window`.
 */
const DRAWING_MODULE = [
  ...STAND_IN_COMMON,
  "export function studio_assets_plan(map) { return JSON.parse(map).files.map((file) => [file.path, file.bytes]); }",
  "export function studio_assets_preload() {}",
  "const WGSL = `override k: f32 = 0.0;",
  "@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {",
  "  let p = array(vec2f(-1.0, -3.0), vec2f(3.0, 1.0), vec2f(-1.0, 1.0));",
  "  return vec4f(p[i], 0.0, 1.0);",
  "}",
  "@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0, 0.55 + k * 0.001, 0.1, 1.0); }`;",
  "let gpu = null;",
  "export async function studio_boot(canvas) {",
  "  const adapter = await navigator.gpu.requestAdapter();",
  "  const device = await adapter.requestDevice();",
  "  const format = navigator.gpu.getPreferredCanvasFormat();",
  "  const module = device.createShaderModule({ code: WGSL });",
  "  const pipelines = [];",
  `  for (let k = 0; k < ${STAND_IN_PIPELINES}; k++) {`,
  "    pipelines.push(device.createRenderPipeline({",
  '      layout: "auto",',
  '      vertex: { module, entryPoint: "vs" },',
  '      fragment: { module, entryPoint: "fs", targets: [{ format }], constants: { k } },',
  "    }));",
  "  }",
  '  const context = canvas ? canvas.getContext("webgpu") : null;',
  '  context?.configure({ device, format, alphaMode: "opaque" });',
  "  gpu = { device, context, pipelines };",
  "  return JSON.stringify({ ok: true, receipt: {}, world: [64, 64] });",
  "}",
  "export function studio_frame() {",
  "  if (!gpu?.context) return 0;",
  "  const encoder = gpu.device.createCommandEncoder();",
  "  const pass = encoder.beginRenderPass({ colorAttachments: [{",
  "    view: gpu.context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store',",
  "    clearValue: { r: 1, g: 0.55, b: 0.1, a: 1 },",
  "  }] });",
  "  pass.setPipeline(gpu.pipelines[0]);",
  "  pass.draw(3);",
  "  pass.end();",
  "  gpu.device.queue.submit([encoder.finish()]);",
  "  return 1;",
  "}",
  "",
].join("\n");

/**
 * On the page's real devices, the order of pipeline creation: `async` for each
 * `create*PipelineAsync`, `sync` for each synchronous call (installed before the shell's script).
 */
const CREATION_LOG = `{
  window.__creations = [];
  const device = globalThis.GPUDevice?.prototype;
  if (device) {
    for (const [name, kind] of [["createRenderPipeline", "sync"], ["createRenderPipelineAsync", "async"]]) {
      const original = device[name];
      device[name] = function (...args) { window.__creations.push(kind); return original.apply(this, args); };
    }
  }
}`;

interface ProgressEvent {
  stage: string;
  done: number | null;
  total: number | null;
  at: number;
}

interface LoadingWindow {
  GenexShell: {
    status: { state: string; code: string | null; reason: string | null };
    progress: { stage: string; done: number | null; total: number | null } | null;
  };
  __progress: ProgressEvent[];
  __creations: string[];
}

/** A game folder with the shell (and `style`), the stand-in module, an empty wasm and its staged assets. */
async function gameFolder(module: string, assets: Record<string, Uint8Array> = {}, page?: string): Promise<string> {
  const root = await tmpDir("rust-web-loading-");
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(path.join(root, "index.html"), page ?? webShellPage(await readFile(SHELL, "utf8"), "Loading row"));
  await writeFile(path.join(root, "game.js"), module);
  await writeFile(path.join(root, "game_bg.wasm"), EMPTY_WASM);
  await writeFile(path.join(root, "blank.html"), "<!doctype html><title>blank</title>");
  const files = Object.entries(assets).map(([name, bytes]) => ({ path: name, bytes: bytes.length, fnv1a64: "0" }));
  await writeFile(path.join(root, "assets.json"), JSON.stringify({ version: 1, files }));
  for (const [name, bytes] of Object.entries(assets)) await writeFile(path.join(root, "assets", name), bytes);
  return root;
}

/** The first index of each stage in `events`, in order of first appearance. */
function stageOrder(events: readonly ProgressEvent[]): string[] {
  const seen: string[] = [];
  for (const event of events) if (!seen.includes(event.stage)) seen.push(event.stage);
  return seen;
}

/** The last event of `stage`. */
const lastOf = (events: readonly ProgressEvent[], stage: string) => events.filter((e) => e.stage === stage).at(-1);

/** Whether this Chromium's WebGPU gives the page an adapter. */
async function hasWebGpu(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    return Boolean(gpu && (await gpu.requestAdapter().catch(() => null)));
  });
}

/** The share of `png`'s pixels brighter than {@link LIT_LUMA}, decoded in the page (no image library here). */
async function litShare(page: Page, png: Buffer): Promise<number> {
  return page.evaluate(
    async ({ data, luma }) => {
      const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))]));
      const board = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = board.getContext("2d") as OffscreenCanvasRenderingContext2D;
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let lit = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2] > luma) lit++;
      }
      return lit / (pixels.length / 4);
    },
    { data: png.toString("base64"), luma: LIT_LUMA },
  );
}

describe("the Rust web shell's loading state", { skip: browserSkip() }, () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch({ headless: true, args: WEBGPU_ARGS });
  });
  after(async () => {
    await browser?.close();
  });

  it("is lit and animated from the first paint, before the game's module has arrived", async () => {
    const root = await gameFolder(QUIET_MODULE);
    const served = await serve(root, ["/game.js"]);
    const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
    try {
      const page = await context.newPage();
      await page.addInitScript(CORE_ADAPTER);
      await page.goto(`${served.origin}/index.html?paused`, { waitUntil: "domcontentloaded" });
      const loading = page.locator("#loading");
      assert.ok(await loading.isVisible(), "the loading screen is on the page before the module");
      assert.equal(await loading.getAttribute("role"), "status");
      assert.match(await loading.innerText(), /Loading row/, "it names the game");
      const motion = await page.evaluate(() =>
        document
          .getAnimations()
          .filter((animation) => animation.playState === "running")
          .map((animation) => {
            const effect = animation.effect as KeyframeEffect | null;
            return effect?.getKeyframes().some((frame) => "transform" in frame) ?? false;
          }),
      );
      assert.ok(motion.includes(true), "a transform animation (the compositor's own) is running");
      const shot = await page.screenshot();
      assert.ok((await litShare(page, shot)) >= LIT_SHARE, "the first paint is lit, never a black page");
      served.release("/game.js");
      await page.waitForFunction(
        (running) => (window as unknown as LoadingWindow).GenexShell?.status.state === running,
        ShellState.Running,
        { timeout: BOOT_TIMEOUT_MS },
      );
      await page.waitForFunction(() => document.getElementById("loading")?.hidden === true, null, {
        timeout: BOOT_TIMEOUT_MS,
      });
    } finally {
      await context.close();
      served.close();
    }
  });

  it("reports wasm, assets, device, pipelines n of m and the first frame, in order, then leaves", async (t) => {
    const assets = { "a.bin": new Uint8Array(1000), "b.bin": new Uint8Array(3000) };
    const root = await gameFolder(DRAWING_MODULE, assets);
    const served = await serve(root);
    const context = await browser.newContext({ viewport: { width: 320, height: 180 } });
    try {
      const page = await context.newPage();
      // A secure context of the game's own origin (about:blank has no navigator.gpu).
      await page.goto(`${served.origin}/blank.html`);
      if (!(await hasWebGpu(page))) {
        if (process.env.GENEX_REQUIRE_METAL === "1") assert.fail("GENEX_REQUIRE_METAL=1: no WebGPU adapter");
        t.skip("not run: this Chromium gives the page no WebGPU adapter");
        return;
      }
      await page.addInitScript(PROGRESS_LOG);
      await page.addInitScript(CREATION_LOG);
      await page.goto(`${served.origin}/index.html`);
      await page.waitForFunction(() => document.getElementById("loading")?.hidden === true, null, {
        timeout: BOOT_TIMEOUT_MS,
      });
      const shell = await page.evaluate(() => {
        const w = window as unknown as LoadingWindow;
        return {
          status: w.GenexShell.status,
          progress: w.GenexShell.progress,
          events: w.__progress,
          creations: w.__creations,
        };
      });
      assert.equal(shell.status.state, ShellState.Running, JSON.stringify(shell.status));
      const order = stageOrder(shell.events);
      assert.deepEqual(
        order,
        [BootStage.Wasm, BootStage.Assets, BootStage.Device, BootStage.Pipelines, BootStage.Frame, BootStage.Ready],
        JSON.stringify(shell.events),
      );
      const wasm = lastOf(shell.events, BootStage.Wasm);
      assert.deepEqual(
        [wasm?.done, wasm?.total],
        [EMPTY_WASM.length, EMPTY_WASM.length],
        "the wasm's bytes, all of them",
      );
      const staged = lastOf(shell.events, BootStage.Assets);
      assert.deepEqual([staged?.done, staged?.total], [2, 2], "both staged files");
      const pipelines = shell.events.filter((event) => event.stage === BootStage.Pipelines && event.total !== null);
      assert.equal(pipelines.at(-1)?.total, STAND_IN_PIPELINES, "m is the pipelines the boot creates");
      assert.equal(pipelines.at(-1)?.done, STAND_IN_PIPELINES, "n reaches m");
      const counts = pipelines.map((event) => event.done ?? 0);
      assert.deepEqual(
        counts,
        [...counts].sort((a, b) => a - b),
        "n only grows",
      );
      assert.equal(shell.progress?.stage, BootStage.Ready);
      // The boot's synchronous creations find the pipelines compiled off the browser's GPU thread.
      const firstSync = shell.creations.indexOf("sync");
      const asyncBefore = shell.creations.slice(0, firstSync).filter((kind) => kind === "async").length;
      assert.equal(
        asyncBefore,
        STAND_IN_PIPELINES,
        `every pipeline was asked for asynchronously first: ${shell.creations}`,
      );
      const shot = await page.screenshot();
      assert.ok((await litShare(page, shot)) > 0.5, "the game's first frame is on screen (the orange clear)");
    } finally {
      await context.close();
      served.close();
    }
  });

  it("ends a boot that stops progressing with boot-timeout naming the stage, never a frozen loader", async () => {
    const root = await gameFolder(STUCK_MODULE);
    const served = await serve(root);
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.addInitScript(CORE_ADAPTER);
      await page.addInitScript("window.GenexShellConfig = { stallMs: 400 };");
      await page.goto(`${served.origin}/index.html?paused`);
      await page.waitForFunction(
        (starting) => (window as unknown as LoadingWindow).GenexShell?.status.state !== starting,
        ShellState.Starting,
        { timeout: BOOT_TIMEOUT_MS },
      );
      const status = await page.evaluate(() => (window as unknown as LoadingWindow).GenexShell.status);
      assert.equal(status.state, ShellState.Failed);
      assert.equal(status.code, BOOT_TIMEOUT_CODE);
      const stages: string[] = Object.values(BootStage);
      assert.ok(stages.includes(String(status.reason).split(/[: ]/)[0]), `the reason names a stage: ${status.reason}`);
      assert.ok(await page.locator('#unsupported [data-genex-card="failed"]').isVisible(), "the card is shown");
      assert.match(await page.locator("#unsupported").innerText(), new RegExp(BOOT_TIMEOUT_CODE));
      assert.ok(await page.locator("#loading").isHidden(), "the loader is gone");
      const state = await page.evaluate(() =>
        (window as unknown as { __studio: { state(): { error: string } } }).__studio.state(),
      );
      assert.equal(state.error, BOOT_TIMEOUT_CODE, "the page contract answers the typed code");
    } finally {
      await context.close();
      served.close();
    }
  });

  it("takes the game's [render.loading] title, colours and logo", async () => {
    const style = {
      title: "Harbour Nights",
      background: "#203040",
      accent: "#ff8800",
      text: "#f0e0d0",
      logo: "ui/logo.png",
    };
    const page = webShellPage(await readFile(SHELL, "utf8"), "Harbour", style);
    const root = await gameFolder(QUIET_MODULE, {}, page);
    await mkdir(path.join(root, "assets", "ui"), { recursive: true });
    await writeFile(path.join(root, "assets", "ui", "logo.png"), LOGO_PNG);
    const served = await serve(root, ["/game.js"]);
    const context = await browser.newContext();
    try {
      const browserPage = await context.newPage();
      await browserPage.addInitScript(CORE_ADAPTER);
      await browserPage.goto(`${served.origin}/index.html?paused`, { waitUntil: "domcontentloaded" });
      const seen = await browserPage.evaluate(() => {
        const loading = document.getElementById("loading") as HTMLElement;
        const logo = document.getElementById("loading-logo") as HTMLImageElement | null;
        const fill = loading.querySelector("[data-genex-bar]") as HTMLElement | null;
        return {
          background: getComputedStyle(loading).backgroundColor,
          text: getComputedStyle(loading).color,
          accent: fill ? getComputedStyle(fill).backgroundColor : null,
          title: document.getElementById("loading-title")?.textContent,
          logo: logo?.getAttribute("src") ?? null,
        };
      });
      served.release("/game.js");
      assert.equal(seen.background, "rgb(32, 48, 64)");
      assert.equal(seen.text, "rgb(240, 224, 208)");
      assert.equal(seen.accent, "rgb(255, 136, 0)");
      assert.equal(seen.title, "Harbour Nights");
      assert.equal(seen.logo, "assets/ui/logo.png");
    } finally {
      await context.close();
      served.close();
    }
  });
});

describe("the Rust web shell's loading page as the build writes it", () => {
  it("fills the defaults when the game sets no [render.loading]", async () => {
    const page = webShellPage(await readFile(SHELL, "utf8"), "Pond <&>");
    assert.ok(!page.includes("__LOADING_"), "no placeholder is left");
    assert.match(page, /id="loading-title">Pond &lt;&amp;&gt;</);
    assert.ok(!page.includes('id="loading-logo"'), "no logo without one");
  });

  const hostile: ReadonlyArray<{ name: string; style: Record<string, string> }> = [
    { name: "a colour that closes the style", style: { background: "#000;}</style><script>x()</script>" } },
    { name: "a colour by name", style: { accent: "red" } },
    { name: "a logo outside assets/", style: { logo: "../index.html" } },
    { name: "a logo by URL", style: { logo: "https://example.com/logo.png" } },
    { name: "a logo with a quote", style: { logo: 'a".png' } },
  ];
  for (const row of hostile) {
    it(`refuses ${row.name} and writes nothing of it`, async () => {
      const shell = await readFile(SHELL, "utf8");
      assert.throws(() => webShellPage(shell, "Hostile", row.style), /loading-style/);
    });
  }
});

// ── Lakeside, cold ──

const LAKESIDE_HOOKS = (nonce: string) => `{
  const device = globalThis.GPUDevice?.prototype;
  if (device) {
    const original = device.createShaderModule;
    device.createShaderModule = function (desc) {
      const code = desc && typeof desc.code === "string" ? desc.code.replaceAll("0.5", "${nonce}") : undefined;
      return original.call(this, code === undefined ? desc : { ...desc, code });
    };
  }
}`;

describe("Lakeside's cold first start in Chromium keeps a lit, moving page", { skip: lakesideSkip() }, () => {
  let browser: Browser;
  let out: string;
  before(async () => {
    out = path.join(await tmpDir("rust-web-loading-lakeside-"), "web");
    const prebuilt = process.env.GENEX_LAKESIDE_WEB_DIR;
    if (prebuilt) {
      // A package web-showcase.sh wrote earlier, its page written again from this shell.
      await cp(prebuilt, out, { recursive: true });
      await writeFile(path.join(out, "index.html"), webShellPage(await readFile(SHELL, "utf8"), "Lakeside"));
    } else {
      await execFileAsync("bash", [WEB_SHOWCASE, "--out", out], {
        timeout: BUILD_TIMEOUT_MS,
        maxBuffer: OUTPUT_MAX_BYTES,
        cwd: REPO,
      });
    }
    browser = await chromium.launch({ headless: true, args: WEBGPU_ARGS });
  });
  after(async () => {
    await browser?.close();
  });

  it("never freezes the page or shows a black frame while its pipelines compile, and counts them n of m", async () => {
    const served = await serve(out);
    const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
    try {
      const page = await context.newPage();
      // A first-ever start: every page's WGSL is perturbed, so no shader cache answers it.
      await page.addInitScript(LAKESIDE_HOOKS((0.5 + randomInt(1, 2000) * 1e-7).toFixed(7)));
      await page.addInitScript(PROGRESS_LOG);
      const started = Date.now();
      await page.goto(`${served.origin}/index.html`, { waitUntil: "commit" });
      // The shots start at the first paint: before it Chromium has no frame to capture and answers
      // "Unable to capture screenshot" (GA round 2, red in 2 of 3 runs at the first shot).
      await page.waitForFunction(() => performance.getEntriesByType("paint").length > 0, null, { polling: "raf" });
      const shots: Array<{ at: number; took: number; lit: number }> = [];
      for (;;) {
        const from = Date.now();
        const png = await page.screenshot();
        shots.push({ at: from - started, took: Date.now() - from, lit: await litShare(page, png) });
        const gone = await page.evaluate(() => document.getElementById("loading")?.hidden === true);
        if (gone || Date.now() - started > LAKESIDE_BOOT_TIMEOUT_MS) break;
      }
      const shell = await page.evaluate(() => {
        const w = window as unknown as LoadingWindow;
        return { status: w.GenexShell.status, events: w.__progress, origin: performance.timeOrigin };
      });
      const evidence = process.env.GENEX_LOADING_EVIDENCE;
      if (evidence) await writeFile(evidence, `${JSON.stringify({ shots, events: shell.events }, null, 2)}\n`);
      assert.equal(shell.status.state, ShellState.Running, JSON.stringify(shell.status));
      const counted = shell.events.filter((event) => event.stage === BootStage.Pipelines && event.total !== null);
      // Both on the wall clock: a screenshot's start, and an event's page time past the page's origin.
      const [from, to] = [counted[0]?.at ?? 0, counted.at(-1)?.at ?? 0].map((at) => shell.origin + at - started);
      const compiling = shots.filter((shot) => shot.at >= from && shot.at + shot.took <= to);
      assert.ok(compiling.length > 0, "screenshots were taken while the pipelines compiled");
      const frozen = compiling.filter((shot) => shot.took > FROZEN_MS);
      assert.deepEqual(frozen, [], `frames kept coming while the pipelines compiled: ${JSON.stringify(compiling)}`);
      const held = shots.filter((shot) => shot.took > BOOT_FRAME_MAX_MS);
      assert.deepEqual(held, [], `no frame was held for a second: ${JSON.stringify(shots.map((s) => s.took))}`);
      const dark = shots.filter((shot) => shot.lit < LIT_SHARE);
      assert.deepEqual(dark, [], "every frame from the first paint to the game's is lit");
      const pipelines = shell.events.filter((event) => event.stage === BootStage.Pipelines && event.total !== null);
      const last = pipelines.at(-1);
      assert.ok((last?.total ?? 0) >= LAKESIDE_PIPELINES_MIN, `m is the boot's pipelines: ${JSON.stringify(last)}`);
      assert.equal(last?.done, last?.total, "n reaches m");
    } finally {
      await context.close();
      served.close();
    }
  });
});
