/**
 * Web parity for the renderer (renderer follow-up RQ0.3): the lakeside showcase built for wasm32
 * (`scripts/spike/rust-wgpu/web-showcase.sh`: `examples/showcase-web`, packaged by the lane's
 * `packageWeb` with its staged assets) runs in Chromium's WebGPU on the one presenter native runs
 * draw with (genex's `present.rs`): its four Level-3 custom passes (what no built-in draws: the
 * clouds, grass, the lake, the light sprites) are installed at `studio_boot`,
 * listed in `state().volatile.customPasses` with no refusal, and change the picture; `state()`
 * carries the frame meter (`fps`) and the presenter's per-tag triangles; and every renderer
 * pipeline variant is created on the browser's device under error scopes, which report an
 * injected invalid variant.
 *
 * Browser rows only: they launch Playwright's headless Chromium (with `STUDIO_BROWSER_TESTS=1` and
 * a Chromium already installed; nothing is downloaded) on the Mac's GPU, and build the showcase
 * with the pinned toolchain. `GENEX_RENDER_EVIDENCE_DIR` keeps the captures as PNGs.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type Browser, type BrowserContext, chromium, type Page } from "@playwright/test";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const WEB_SHOWCASE = path.join(REPO, "scripts", "spike", "rust-wgpu", "web-showcase.sh");
const TOOLCHAIN = process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev", "spike-toolchain");
const CARGO = path.join(TOOLCHAIN, "sysroot", "bin", "cargo");
const WASM_BINDGEN = path.join(TOOLCHAIN, "tools", "bin", "wasm-bindgen");
const WASM_OPT = path.join(TOOLCHAIN, "tools", "binaryen", "bin", "wasm-opt");
/** A cold build compiles wgpu, Rapier, egui and kira for wasm32. */
const BUILD_TIMEOUT_MS = 30 * MINUTE_MS;
const BOOT_TIMEOUT_MS = 90 * SECOND_MS;
const FPS_TIMEOUT_MS = 20 * SECOND_MS;
const OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
/** The showcase's world (`examples/showcase/game/src/showcase.rs`) and its passes, in registration order. */
const WORLD = { width: 1280, height: 720 };
const PASSES = [
  { name: "clouds", stage: "after-opaque" },
  { name: "grass", stage: "after-opaque" },
  { name: "lake", stage: "after-transparent" },
  { name: "lights", stage: "after-transparent" },
] as const;
/** The shot the A/B is taken from, and its grass and lake in world pixels (x0, y0, x1, y1). */
const SHOT = "wide";
const MEADOW = { x0: 900, y0: 420, x1: 1240, y1: 700 };
const LAKE = { x0: 420, y0: 330, x1: 860, y1: 520 };
/** A pixel differs when a colour channel moved more than this; a region changes past this share. */
const CHANNEL_STEP = 8;
const REGION_CHANGED_SHARE = 0.05;
/**
 * Variants no other one reaches. R2 review: the meshlet path's (web.rs `meshlet_variant`: the cull,
 * the meshlet draws and, over one sample, the Hi-Z build) and its shader modules. RQ6 review: the
 * binned lights' and texture classes' (web.rs `lights_variant`, `textures_variant`).
 */
const MESHLET_VARIANTS: readonly string[] = [
  "meshlets-msaa",
  "meshlets-occlusion",
  "shader-meshlet-cull",
  "shader-meshlet-draw",
  "shader-hiz-build",
  // RQ6 review: the binned lights with shadowed spots on the HDR and the LDR scene (graph node 4's
  // dispatch, the spot casters, the binned walk), and texture size classes with Toksvig.
  "lights-hdr",
  "lights-ldr",
  "textures-classes",
  // RQ5 review: FSR1 below scale 1 (the iPhone class's medium at 0.75, desktop-high's high at its
  // lowest step after TAA) and the RQ5 shader modules.
  "upscale-medium-mobile-high",
  "upscale-high-desktop-high",
  "shader-taa",
  "shader-taa-reactive",
  "shader-easu",
  "shader-rcas",
];
/** The variant the browser row injects so its error scope must report it (web.rs). */
const INJECTED_VARIANT = "injected-invalid";
const ShellState = { Running: "running" } as const;
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

const browserSkip = (): string | false => {
  if (process.platform === "win32") return "not run: the Rust web rows are POSIX-only";
  if (!(existsSync(CARGO) && existsSync(WASM_BINDGEN) && existsSync(WASM_OPT))) {
    if (process.env.GENEX_REQUIRE_TOOLCHAINS === "1") {
      throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: no Rust toolchain at ${TOOLCHAIN}`);
    }
    return "not run: the Rust toolchain with wasm-bindgen and wasm-opt is not installed";
  }
  if (process.env.STUDIO_BROWSER_TESTS !== "1") return "launches Chromium; set STUDIO_BROWSER_TESTS=1 to run";
  let executable = "";
  try {
    executable = chromium.executablePath();
  } catch {
    executable = "";
  }
  const revision = /^(.*[/\\])chromium-(\d+)[/\\]/.exec(executable);
  const headlessShell = revision ? `${revision[1]}chromium_headless_shell-${revision[2]}` : "";
  const installed =
    (executable !== "" && existsSync(executable)) || (headlessShell !== "" && existsSync(headlessShell));
  return installed ? false : "no Playwright Chromium is installed; this suite never downloads one";
};

interface Served {
  origin: string;
  close: () => void;
}

/** A static server over one packaged folder. */
async function serve(root: string): Promise<Served> {
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
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
  return { origin, close: () => server.close() };
}

interface PassStatus {
  name: string;
  stage: string;
  running: boolean;
  code: string | null;
}

interface ShowcaseState {
  fps: number;
  __render: { drawCalls: number; triangles: number; tags: Record<string, { drawCalls: number; triangles: number }> };
  volatile: {
    customPasses?: PassStatus[];
    gpu?: { passes: number };
    render?: { deviceClass: string; preset: string; scale: number };
  };
}

/** A desktop monitor's screen, as headless Chromium reports it when told (CSS pixels). */
const DESKTOP_SCREEN = { width: 1920, height: 1080 };

interface PipelineVariant {
  variant: string;
  error: string | null;
}

interface RawCapture {
  width: number;
  height: number;
  digest: string;
  base64: string;
}

interface ShowcaseModule {
  studio_capture(): Promise<{ width: number; height: number; digest: string; bgra: Uint8Array }>;
  studio_custom_passes(enabled: boolean): void;
  studio_pipeline_check(injectInvalid: boolean): Promise<string>;
}

interface ShellWindow {
  GenexShell: { status: Record<string, unknown>; module: ShowcaseModule };
  __studio: Record<string, (arg?: unknown) => unknown>;
}

/** A fresh context's page on the booted shell (live play unless `paused`). */
async function openShell(
  browser: Browser,
  origin: string,
  paused: boolean,
  screen?: { width: number; height: number },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(screen ? { screen } : {});
  const page = await context.newPage();
  await page.goto(`${origin}/index.html${paused ? "?paused" : ""}`);
  await page.waitForFunction(
    () => {
      const state = (window as unknown as { GenexShell?: { status: { state: string } } }).GenexShell?.status.state;
      return state !== undefined && state !== "starting";
    },
    undefined,
    { timeout: BOOT_TIMEOUT_MS },
  );
  return { context, page };
}

const status = (page: Page) => page.evaluate(() => (window as unknown as ShellWindow).GenexShell.status);
const verb = (page: Page, name: string, arg?: unknown) =>
  page.evaluate(([n, a]) => (window as unknown as ShellWindow).__studio[n as string](a), [name, arg] as const);

/** The module's capture of the current view, base64 across the page boundary. */
const rawCapture = (page: Page) =>
  page.evaluate(async (): Promise<RawCapture> => {
    const taken = await (window as unknown as ShellWindow).GenexShell.module.studio_capture();
    let binary = "";
    for (let i = 0; i < taken.bgra.length; i += 0x8000) {
      binary += String.fromCharCode(...taken.bgra.subarray(i, i + 0x8000));
    }
    return { width: taken.width, height: taken.height, digest: taken.digest, base64: btoa(binary) };
  });

/** Share of a region's pixels whose colour moved more than {@link CHANNEL_STEP} in some channel. */
function changedShare(a: Uint8Array, b: Uint8Array, region: typeof MEADOW): number {
  let changed = 0;
  let total = 0;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const at = (y * WORLD.width + x) * 4;
      const moved = [0, 1, 2].some((c) => Math.abs(a[at + c] - b[at + c]) > CHANNEL_STEP);
      if (moved) changed++;
      total++;
    }
  }
  return changed / total;
}

/** Keep a PNG the page made (`__studio.capture`) in the evidence folder, when one is named. */
async function keepEvidence(name: string, dataUrl: unknown): Promise<void> {
  const dir = process.env.GENEX_RENDER_EVIDENCE_DIR;
  if (!dir || typeof dataUrl !== "string") return;
  await mkdir(dir, { recursive: true });
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  await writeFile(path.join(dir, `${name}.png`), Buffer.from(base64, "base64"));
}

describe("Lakeside on the web: the shared presenter runs Level-3 passes in Chromium's WebGPU", {
  skip: browserSkip(),
}, () => {
  let browser: Browser;
  let showcase: Served;

  before(
    async () => {
      const home = await realpath(await tmpDir("rust-web-render-"));
      const out = path.join(home, "showcase");
      await execFileAsync("bash", [WEB_SHOWCASE, "--out", out], {
        timeout: BUILD_TIMEOUT_MS,
        maxBuffer: OUTPUT_MAX_BYTES,
        cwd: REPO,
      });
      showcase = await serve(out);
      const args = CHROMIUM_ARGS[process.platform] ?? DEFAULT_CHROMIUM_ARGS;
      browser = await chromium.launch({ headless: true, args });
    },
    { timeout: BUILD_TIMEOUT_MS },
  );
  after(async () => {
    await browser?.close();
    showcase?.close();
  });

  it("installs all four passes at boot with no refusal, and state() counts fps and triangles", {
    timeout: 2 * BOOT_TIMEOUT_MS,
  }, async () => {
    const { context, page } = await openShell(browser, showcase.origin, false);
    const shell = await status(page);
    assert.equal(shell.state, ShellState.Running, `the shell refused: ${JSON.stringify(shell)}`);
    await page.waitForFunction(
      () => ((window as unknown as ShellWindow).__studio.state() as { fps: number }).fps > 0,
      undefined,
      { timeout: FPS_TIMEOUT_MS },
    );
    const state = (await verb(page, "state")) as ShowcaseState;
    const listed = state.volatile.customPasses ?? [];
    assert.deepEqual(
      listed.map((pass) => ({ name: pass.name, stage: pass.stage })),
      PASSES.map((pass) => ({ ...pass })),
      `volatile.customPasses: ${JSON.stringify(state.volatile)}`,
    );
    for (const pass of listed) assert.deepEqual([pass.running, pass.code], [true, null], `${pass.name} runs`);
    assert.ok(state.fps > 0, `fps ${state.fps}`);
    assert.ok(state.__render.triangles > 0, `triangles ${state.__render.triangles}`);
    assert.equal(state.__render.tags.custom?.drawCalls, PASSES.length, "one custom draw per pass");
    await context.close();
  });

  it("draws grass, lake and sprites over the built-in scene: > 5% of the meadow and the lake differ from the passes off", {
    timeout: 2 * BOOT_TIMEOUT_MS,
  }, async () => {
    const { context, page } = await openShell(browser, showcase.origin, true);
    await verb(page, "step", 500);
    assert.ok(await verb(page, "debugCamera", SHOT), `the ${SHOT} shot`);
    await keepEvidence("web-lakeside-wide", await verb(page, "capture", SHOT));
    const drawn = await rawCapture(page);
    await page.evaluate(() => (window as unknown as ShellWindow).GenexShell.module.studio_custom_passes(false));
    await keepEvidence("web-lakeside-wide-passes-off", await verb(page, "capture", SHOT));
    const plain = await rawCapture(page);
    await page.evaluate(() => (window as unknown as ShellWindow).GenexShell.module.studio_custom_passes(true));
    const again = await rawCapture(page);
    assert.deepEqual([drawn.width, drawn.height], [WORLD.width, WORLD.height]);
    const [a, b] = [drawn, plain].map((c) => new Uint8Array(Buffer.from(c.base64, "base64")));
    const meadow = changedShare(a, b, MEADOW);
    const lake = changedShare(a, b, LAKE);
    assert.ok(meadow > REGION_CHANGED_SHARE, `meadow changed ${(meadow * 100).toFixed(1)}%`);
    assert.ok(lake > REGION_CHANGED_SHARE, `lake changed ${(lake * 100).toFixed(1)}%`);
    assert.equal(again.digest, drawn.digest, "the passes draw the same tick identically once back on");
    await context.close();
  });

  it("classifies a desktop browser from the shell's device hints: a desktop class at render scale 1", {
    timeout: 2 * BOOT_TIMEOUT_MS,
  }, async () => {
    // Paused: no Live frame moves dynamic resolution, so the scale read is the class's nominal one.
    const { context, page } = await openShell(browser, showcase.origin, true, DESKTOP_SCREEN);
    await verb(page, "step", 100);
    await rawCapture(page);
    const state = (await verb(page, "state")) as ShowcaseState;
    const render = state.volatile.render;
    assert.ok(render, `volatile.render: ${JSON.stringify(state.volatile)}`);
    assert.match(render.deviceClass, /^desktop-/, "a page with desktop hints is a desktop, never a phone");
    assert.equal(render.scale, 1, "a desktop class draws at full scale");
    await context.close();
  });

  it("creates every renderer pipeline variant on the web device with no validation error", {
    timeout: 2 * BOOT_TIMEOUT_MS,
  }, async () => {
    const { context, page } = await openShell(browser, showcase.origin, true);
    const clean = JSON.parse(
      await page.evaluate(() => (window as unknown as ShellWindow).GenexShell.module.studio_pipeline_check(false)),
    ) as PipelineVariant[];
    assert.ok(clean.length > 2, `variants: ${JSON.stringify(clean)}`);
    assert.ok(
      clean.some((v) => v.variant.startsWith("effects-")),
      "RQ4 screen effects per preset row",
    );
    for (const name of MESHLET_VARIANTS) {
      assert.ok(
        clean.some((v) => v.variant === name),
        `the meshlet path's ${name} is created on the browser's device`,
      );
    }
    assert.deepEqual(
      clean.filter((variant) => variant.error !== null),
      [],
      "no variant fails on the browser's device",
    );
    const injected = JSON.parse(
      await page.evaluate(() => (window as unknown as ShellWindow).GenexShell.module.studio_pipeline_check(true)),
    ) as PipelineVariant[];
    const bad = injected.filter((variant) => variant.error !== null).map((variant) => variant.variant);
    assert.deepEqual(bad, [INJECTED_VARIANT], "the error scope reports the injected variant, and only it");
    await context.close();
  });
});
