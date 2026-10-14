/**
 * The Rust web shell (`src/game-template-rust/web/shell.html`) after the WebGPU preflight passed.
 *
 * - When its boot throws (the module is missing, its wasm init throws, or `studio_boot` throws) it
 *   shows the "couldn't start" card with the typed code `boot-failed`, never an empty stage (a
 *   blank Live that looks like a working one), and the page contract's `state()` answers the code.
 * - Before `studio_boot` it fetches the game's staged assets by the build's asset map
 *   (`assets.json`) and hands each file to the module (`studio_assets_plan`, then
 *   `studio_assets_preload`), so a model draws its mesh, never the magenta checker. A map or file
 *   it cannot fetch, bytes the module refuses, a file larger than planned or a path that would
 *   leave `assets/` stops the boot with the same card; nothing outside the game's folder is asked.
 *
 * No Rust toolchain: the game's `game.js` is a few lines written here, and the preflight sees a
 * stand-in adapter at WebGPU's core limits. Launches Playwright's headless Chromium only with
 * `STUDIO_BROWSER_TESTS=1` and a Chromium already installed; nothing is downloaded.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "@playwright/test";
import { webShellPage } from "../../src/main/rust-build-web.ts";
import { SECOND_MS } from "../../src/shared/duration.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SHELL = path.join(REPO, "src", "game-template-rust", "web", "shell.html");
const BOOT_TIMEOUT_MS = 20 * SECOND_MS;
const BOOT_FAILED = "boot-failed";
/** The shell's status states (shell.html). Wire values. */
const ShellState = { Starting: "starting", Running: "running", Failed: "failed" } as const;
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
};

/** A WebGPU adapter at core limits (every maximum huge, every alignment 1), so the preflight passes. */
const CORE_ADAPTER = `{
  const limits = new Proxy({}, { get: (_t, key) => (String(key).startsWith("min") ? 1 : 1e9) });
  const gpu = { requestAdapter: async () => ({ limits }) };
  Object.defineProperty(Navigator.prototype, "gpu", { configurable: true, get: () => gpu });
}`;

/** One broken boot: the `game.js` it serves (null: none at all) and what broke. */
const BROKEN: ReadonlyArray<{ name: string; module: string | null; reason: RegExp }> = [
  { name: "the game's module is missing", module: null, reason: /game\.js|module|fetch/i },
  {
    name: "the wasm init throws",
    module: 'export default async function init() { throw new Error("wasm init exploded"); }\n',
    reason: /wasm init exploded/,
  },
  {
    name: "studio_boot throws",
    module: [
      "export default async function init() {}",
      'export function studio_saves_database() { return "genex-shell-boot-test"; }',
      "export function studio_saves_preload() {}",
      "export function studio_saves_unavailable() {}",
      'export function studio_saves_status() { return "{}"; }',
      'export async function studio_boot() { throw new Error("boot exploded"); }',
      "",
    ].join("\n"),
    reason: /boot exploded/,
  },
];

const browserSkip = (): string | false => {
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

/** A static server over `root`: any regular file under it (never through a link), 404 otherwise; every path asked is recorded. */
async function serve(root: string): Promise<{ origin: string; requests: string[]; close: () => void }> {
  const requests: string[] = [];
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    requests.push(pathname);
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
  return { origin, requests, close: () => server.close() };
}

interface ShellWindow {
  GenexShell: { status: { state: string; code: string | null; reason: string | null } };
  __studio: { state(): { error: string }; step?: unknown };
}

describe("the Rust web shell when its boot throws", { skip: browserSkip() }, () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  for (const row of BROKEN) {
    it(`${row.name}: the couldn't-start card with boot-failed, never an empty stage`, async () => {
      const root = await tmpDir("rust-shell-boot-");
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, "index.html"), webShellPage(await readFile(SHELL, "utf8"), "Broken"));
      if (row.module !== null) await writeFile(path.join(root, "game.js"), row.module);
      const served = await serve(root);
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.addInitScript(CORE_ADAPTER);
        await page.goto(`${served.origin}/index.html?paused`);
        await page.waitForFunction(
          (starting) => (window as unknown as ShellWindow).GenexShell?.status.state !== starting,
          ShellState.Starting,
          { timeout: BOOT_TIMEOUT_MS },
        );
        const status = await page.evaluate(() => (window as unknown as ShellWindow).GenexShell.status);
        assert.equal(status.state, ShellState.Failed);
        assert.equal(status.code, BOOT_FAILED);
        assert.match(status.reason ?? "", row.reason);
        const card = page.locator('#unsupported [data-genex-card="failed"]');
        assert.ok(await card.isVisible(), "the couldn't-start card is shown");
        assert.ok(await page.locator("#game").isHidden(), "no empty canvas");
        const text = await card.innerText();
        assert.match(text, /This game couldn’t start/);
        assert.match(text, new RegExp(BOOT_FAILED));
        const state = await page.evaluate(() => (window as unknown as ShellWindow).__studio.state());
        assert.equal(state.error, BOOT_FAILED, "the page contract answers the typed code");
      } finally {
        await context.close();
        served.close();
      }
    });
  }
});

// ── the game's staged assets ──

/** A real GLB from the showcase game's staged assets. */
const SPHERE_GLB = path.join(REPO, "native", "genex-rust", "examples", "showcase", "game", "assets", "sphere.glb");
/** What a GLB starts with: `glTF`. */
const GLB_MAGIC = [0x67, 0x6c, 0x54, 0x46];

/**
 * A stand-in for the game's module that records what the shell hands it, in order: the asset map
 * it planned (answering `plan`, `[[path, bytes]]`), each file preloaded (its path, length and first
 * bytes) and the boot. `refuse` makes `studio_assets_preload` throw as the module does for bytes
 * that are not what the map recorded.
 */
function assetModule(plan: ReadonlyArray<readonly [string, number]>, refuse = false): string {
  return [
    "window.__assetLog = [];",
    "const log = (...entry) => window.__assetLog.push(entry);",
    "export default async function init() {}",
    'export function studio_saves_database() { return "genex-shell-assets-test"; }',
    "export function studio_saves_preload() {}",
    "export function studio_saves_unavailable() {}",
    'export function studio_saves_status() { return "{}"; }',
    "export function studio_saves_pending() { return 0; }",
    "export function studio_saves_take() { return []; }",
    "export function studio_saves_flushed() {}",
    `export function studio_assets_plan(map) { log("plan", JSON.parse(map).files.length); return ${JSON.stringify(plan)}; }`,
    "export function studio_assets_preload(name, bytes) {",
    '  log("preload", name, bytes.length, Array.from(bytes.subarray(0, 4)));',
    refuse ? '  throw new Error("digest-mismatch: " + name);' : "",
    "}",
    'export async function studio_boot() { log("boot"); return JSON.stringify({ ok: true, receipt: {}, world: [64, 64] }); }',
    "export function studio_call(op) { return JSON.stringify({ id: null, ok: true, op, result: {} }); }",
    "export function studio_frame() { return 0; }",
    "",
  ].join("\n");
}

type AssetLog = Array<[string, ...unknown[]]>;

/** One served game: its files, the module's plan, and the outcome the shell must reach. */
interface AssetRow {
  name: string;
  /** Files under `assets/` by path (bytes), beside the map. */
  files: Record<string, Uint8Array>;
  /** The asset map (`assets.json`); null serves none. */
  map: unknown;
  plan: ReadonlyArray<readonly [string, number]>;
  refuse?: boolean;
  /** The failure reason the card shows; absent, the game runs. */
  reason?: RegExp;
}

async function bootServed(browser: Browser, row: AssetRow) {
  const root = await tmpDir("rust-shell-assets-");
  await mkdir(path.join(root, "assets"), { recursive: true });
  await writeFile(path.join(root, "index.html"), webShellPage(await readFile(SHELL, "utf8"), "Assets"));
  await writeFile(path.join(root, "game.js"), assetModule(row.plan, row.refuse));
  if (row.map !== null) await writeFile(path.join(root, "assets.json"), JSON.stringify(row.map));
  for (const [name, bytes] of Object.entries(row.files)) {
    await mkdir(path.dirname(path.join(root, "assets", name)), { recursive: true });
    await writeFile(path.join(root, "assets", name), bytes);
  }
  const served = await serve(root);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.addInitScript(CORE_ADAPTER);
    await page.goto(`${served.origin}/index.html?paused`);
    await page.waitForFunction(
      (starting) => (window as unknown as ShellWindow).GenexShell?.status.state !== starting,
      ShellState.Starting,
      { timeout: BOOT_TIMEOUT_MS },
    );
    const status = await page.evaluate(() => (window as unknown as ShellWindow).GenexShell.status);
    const log = await page.evaluate(() => (window as unknown as { __assetLog: AssetLog }).__assetLog);
    const cardShown = await page.locator('#unsupported [data-genex-card="failed"]').isVisible();
    return { status, log, cardShown, requests: [...served.requests] };
  } finally {
    await context.close();
    served.close();
  }
}

/** The paths a page may ask for: the page, its module, the asset map and files under `assets/`. */
const insideTheGame = (request: string) =>
  ["/index.html", "/game.js", "/assets.json"].includes(request) || request.startsWith("/assets/");

describe("the Rust web shell loads the game's staged assets before the first frame", { skip: browserSkip() }, () => {
  let browser: Browser;
  let glb: Uint8Array;
  before(async () => {
    browser = await chromium.launch({ headless: true });
    glb = new Uint8Array(await readFile(SPHERE_GLB));
  });
  after(async () => {
    await browser?.close();
  });

  it("hands a GLB the asset map names to the module, then boots", async () => {
    const map = { version: 1, files: [{ path: "models/sphere.glb", bytes: glb.length, fnv1a64: "0" }] };
    const result = await bootServed(browser, {
      name: "a GLB",
      files: { "models/sphere.glb": glb },
      map,
      plan: [["models/sphere.glb", glb.length]],
    });
    assert.equal(result.status.state, ShellState.Running, JSON.stringify(result.status));
    assert.deepEqual(result.log, [["plan", 1], ["preload", "models/sphere.glb", glb.length, GLB_MAGIC], ["boot"]]);
    assert.ok(result.requests.includes("/assets/models/sphere.glb"));
  });

  const failing: ReadonlyArray<AssetRow & { reason: RegExp }> = [
    {
      name: "the build has no asset map",
      files: {},
      map: null,
      plan: [],
      reason: /asset-fetch-failed: assets\.json/,
    },
    {
      name: "an asset the map names is not served",
      files: {},
      map: { version: 1, files: [] },
      plan: [["missing.glb", 10]],
      reason: /asset-fetch-failed: missing\.glb/,
    },
    {
      name: "the module refuses the bytes (not what the map recorded)",
      files: { "sphere.glb": new Uint8Array(GLB_MAGIC) },
      map: { version: 1, files: [] },
      plan: [["sphere.glb", GLB_MAGIC.length]],
      refuse: true,
      reason: /digest-mismatch: sphere\.glb/,
    },
  ];
  for (const row of failing) {
    it(`${row.name}: the couldn't-start card with boot-failed, and the game never boots`, async () => {
      const result = await bootServed(browser, row);
      assert.equal(result.status.state, ShellState.Failed);
      assert.equal(result.status.code, BOOT_FAILED);
      assert.match(result.status.reason ?? "", row.reason);
      assert.ok(result.cardShown, "the couldn't-start card is shown");
      assert.ok(!result.log.some(([what]) => what === "boot"), "studio_boot never ran");
    });
  }

  const hostile: ReadonlyArray<{ name: string; plan: ReadonlyArray<readonly [string, number]>; serve?: string }> = [
    { name: "a climbing path", plan: [["../index.html", 10]] },
    { name: "a deeper climb", plan: [["models/../../game.js", 10]] },
    { name: "an absolute path", plan: [["/game.js", 10]] },
    { name: "another origin", plan: [["//example.com/x.glb", 10]] },
    { name: "a file larger than the map recorded", plan: [["big.glb", 4]], serve: "big.glb" },
  ];
  for (const row of hostile) {
    it(`never fetches or hands over ${row.name}, and the game never boots`, async () => {
      const files = row.serve ? { [row.serve]: new Uint8Array(1024 * 1024) } : {};
      const result = await bootServed(browser, {
        name: row.name,
        files,
        map: { version: 1, files: [] },
        plan: row.plan,
      });
      assert.equal(result.status.state, ShellState.Failed, JSON.stringify(result.status));
      assert.equal(result.status.code, BOOT_FAILED);
      assert.ok(!result.log.some(([what]) => what === "preload"), "nothing reached the module");
      assert.ok(!result.log.some(([what]) => what === "boot"), "studio_boot never ran");
      assert.deepEqual(
        result.requests.filter((request) => !insideTheGame(request)),
        [],
        "every request stayed inside the game's folder",
      );
      const outside = result.requests.filter((request) => request.startsWith("/assets/") && request.includes(".."));
      assert.deepEqual(outside, []);
    });
  }
});

// ── the page pointer through the letterbox ──

/** The world the stand-in game boots with: 16:9, as the template's. */
const POINTER_WORLD = [960, 540] as const;

/** A booting stand-in for the game's module that records every `input` verb the shell sends. */
const POINTER_MODULE = [
  "window.__inputs = [];",
  "export default async function init() {}",
  'export function studio_saves_database() { return "genex-shell-pointer-test"; }',
  "export function studio_saves_preload() {}",
  "export function studio_saves_unavailable() {}",
  'export function studio_saves_status() { return "{}"; }',
  "export function studio_saves_pending() { return 0; }",
  "export function studio_saves_take() { return []; }",
  "export function studio_saves_flushed() {}",
  "export function studio_assets_plan() { return []; }",
  "export function studio_assets_preload() {}",
  `export async function studio_boot() { return JSON.stringify({ ok: true, receipt: {}, world: ${JSON.stringify(POINTER_WORLD)} }); }`,
  'export function studio_call(op, arg) { if (op === "input") window.__inputs.push(JSON.parse(arg)); return JSON.stringify({ id: null, ok: true, op, result: {} }); }',
  "export function studio_frame() { return 0; }",
  "",
].join("\n");

/** One click on a page of `viewport` CSS pixels: where, and the world fraction it must reach (null: none, a bar). */
interface PointerRow {
  name: string;
  viewport: { width: number; height: number };
  at: { x: number; y: number };
  world: { x: number; y: number } | null;
}

/** The world fraction a 600×600 page's square canvas maps to: the 16:9 picture is 600×337 at y 131. */
const POINTER_ROWS: readonly PointerRow[] = [
  {
    name: "the centre of a square page",
    viewport: { width: 600, height: 600 },
    at: { x: 300, y: 300 },
    world: { x: 0.5, y: (300 - 131) / 337 },
  },
  {
    name: "the picture's top-left corner",
    viewport: { width: 600, height: 600 },
    at: { x: 1, y: 132 },
    world: { x: 1 / 600, y: 1 / 337 },
  },
  { name: "the bar above the picture", viewport: { width: 600, height: 600 }, at: { x: 300, y: 60 }, world: null },
  { name: "the bar below the picture", viewport: { width: 600, height: 600 }, at: { x: 300, y: 590 }, world: null },
  {
    name: "the bar beside the picture on a wide page",
    viewport: { width: 1000, height: 300 },
    at: { x: 100, y: 150 },
    world: null,
  },
  {
    name: "the centre of a wide page",
    viewport: { width: 1000, height: 300 },
    at: { x: 500, y: 150 },
    world: { x: 0.5, y: 0.5 },
  },
];

describe("the Rust web shell maps a click through the letterbox the presenter draws", { skip: browserSkip() }, () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  // Pass-1 gate: the shell sent the pointer as a fraction of the whole canvas while the world is
  // letterboxed inside it, so on a page that is not 16:9 a click on a drawn button missed it.
  for (const row of POINTER_ROWS) {
    it(`${row.name}: ${row.world ? "the world point under it" : "no input at all"}`, async () => {
      const root = await tmpDir("rust-shell-pointer-");
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, "index.html"), webShellPage(await readFile(SHELL, "utf8"), "Pointer"));
      await writeFile(path.join(root, "assets.json"), JSON.stringify({ version: 1, files: [] }));
      await writeFile(path.join(root, "game.js"), POINTER_MODULE);
      const served = await serve(root);
      const context = await browser.newContext({ viewport: row.viewport, deviceScaleFactor: 1 });
      try {
        const page = await context.newPage();
        await page.addInitScript(CORE_ADAPTER);
        await page.goto(`${served.origin}/index.html?paused`);
        await page.waitForFunction(
          (running) => (window as unknown as ShellWindow).GenexShell?.status.state === running,
          ShellState.Running,
          { timeout: BOOT_TIMEOUT_MS },
        );
        await page.mouse.click(row.at.x, row.at.y);
        const inputs = await page.evaluate(
          () => (window as unknown as { __inputs: Array<{ pointer?: { x: number; y: number } }> }).__inputs,
        );
        if (!row.world) {
          assert.deepEqual(inputs, [], "a click on a bar reaches the game as nothing");
          return;
        }
        assert.equal(inputs.length, 1, JSON.stringify(inputs));
        const pointer = inputs[0]?.pointer;
        assert.ok(pointer, "the click carries a pointer");
        assert.ok(Math.abs(pointer.x - row.world.x) < 0.003, `x ${pointer.x} vs ${row.world.x}`);
        assert.ok(Math.abs(pointer.y - row.world.y) < 0.003, `y ${pointer.y} vs ${row.world.y}`);
      } finally {
        await context.close();
        served.close();
      }
    });
  }
});

// ── renderSettings on the page ──

/** The frame budget the stand-in game refuses, as a game refuses one outside 1..=100 ms. */
const REFUSED_BUDGET_MS = 0.5;

/** A booting stand-in that records every `renderSettings` the shell sends and answers it as a game does. */
const SETTINGS_MODULE = [
  "window.__settings = [];",
  "export default async function init() {}",
  'export function studio_saves_database() { return "genex-shell-settings-test"; }',
  "export function studio_saves_preload() {}",
  "export function studio_saves_unavailable() {}",
  'export function studio_saves_status() { return "{}"; }',
  "export function studio_saves_pending() { return 0; }",
  "export function studio_saves_take() { return []; }",
  "export function studio_saves_flushed() {}",
  "export function studio_assets_plan() { return []; }",
  "export function studio_assets_preload() {}",
  "export async function studio_boot() { return JSON.stringify({ ok: true, receipt: {}, world: [960, 540] }); }",
  "export function studio_call(op, arg) {",
  '  if (op !== "renderSettings") return JSON.stringify({ id: null, ok: true, op, result: {} });',
  "  const parsed = JSON.parse(arg);",
  "  window.__settings.push(parsed);",
  `  if (parsed?.set?.frameBudgetMs === ${REFUSED_BUDGET_MS}) return JSON.stringify({ id: null, ok: false, op, error: "invalid-frame-budget" });`,
  '  return JSON.stringify({ id: null, ok: true, op, result: { preset: "medium", frameBudgetMs: parsed?.set?.frameBudgetMs ?? null } });',
  "}",
  "export function studio_frame() { return 0; }",
  "",
].join("\n");

describe("the Rust web shell binds renderSettings, as a native game serves it", { skip: browserSkip() }, () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  // Pass-1 gate: the shell's verb table had no renderSettings, so dev control's game.renderSettings
  // answered {__missing: true} on Web and frameBudgetMs could not be reached there.
  it("forwards a read and a change to the game, and hands back a refusal by its code", async () => {
    const root = await tmpDir("rust-shell-settings-");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "index.html"), webShellPage(await readFile(SHELL, "utf8"), "Settings"));
    await writeFile(path.join(root, "assets.json"), JSON.stringify({ version: 1, files: [] }));
    await writeFile(path.join(root, "game.js"), SETTINGS_MODULE);
    const served = await serve(root);
    const context = await browser.newContext({ viewport: { width: 640, height: 360 }, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage();
      await page.addInitScript(CORE_ADAPTER);
      await page.goto(`${served.origin}/index.html?paused`);
      await page.waitForFunction(
        (running) => (window as unknown as ShellWindow).GenexShell?.status.state === running,
        ShellState.Running,
        { timeout: BOOT_TIMEOUT_MS },
      );
      const answers = await page.evaluate((refused) => {
        const studio = (window as unknown as { __studio: { renderSettings?: (arg?: unknown) => unknown } }).__studio;
        if (typeof studio.renderSettings !== "function") return null;
        return {
          read: studio.renderSettings(),
          change: studio.renderSettings({ set: { frameBudgetMs: 4 } }),
          refused: studio.renderSettings({ set: { frameBudgetMs: refused } }),
          sent: (window as unknown as { __settings: unknown[] }).__settings,
        };
      }, REFUSED_BUDGET_MS);
      assert.ok(answers, "window.__studio.renderSettings is bound");
      assert.deepEqual(answers.read, { preset: "medium", frameBudgetMs: null });
      assert.deepEqual(answers.change, { preset: "medium", frameBudgetMs: 4 });
      assert.deepEqual(answers.refused, { __refused: "invalid-frame-budget" });
      assert.deepEqual(answers.sent, [
        {},
        { set: { frameBudgetMs: 4 } },
        { set: { frameBudgetMs: REFUSED_BUDGET_MS } },
      ]);
    } finally {
      await context.close();
      served.close();
    }
  });
});

// ── the canvas follows the page's size from before the boot ──

/** A stand-in whose `studio_boot` waits until the test releases it (`window.__releaseBoot`). */
const HELD_BOOT_MODULE = [
  "export default async function init() {}",
  'export function studio_saves_database() { return "genex-shell-resize-test"; }',
  "export function studio_saves_preload() {}",
  "export function studio_saves_unavailable() {}",
  'export function studio_saves_status() { return "{}"; }',
  "export function studio_saves_pending() { return 0; }",
  "export function studio_saves_take() { return []; }",
  "export function studio_saves_flushed() {}",
  "export function studio_assets_plan() { return []; }",
  "export function studio_assets_preload() {}",
  "export async function studio_boot() {",
  "  await new Promise((release) => { window.__releaseBoot = release; });",
  "  return JSON.stringify({ ok: true, receipt: {}, world: [960, 540] });",
  "}",
  "export function studio_call(op) { return JSON.stringify({ id: null, ok: true, op, result: {} }); }",
  "export function studio_frame() { return 0; }",
  "",
].join("\n");

describe("the Rust web shell sizes its canvas to the page, whenever the page gets its size", {
  skip: browserSkip(),
}, () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  // Pass-1 gate: Live keeps the view at no size until the page has settled. A boot that began
  // first fitted the canvas to 1×1, the view's real size arrived while studio_boot was still
  // running (the resize listener was only added after it), and the game drew into a 1×1 canvas:
  // Web Live's first open after the app started was black until "Reload game".
  it("refits a canvas whose page was resized while studio_boot ran", async () => {
    const root = await tmpDir("rust-shell-resize-");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "index.html"), webShellPage(await readFile(SHELL, "utf8"), "Resize"));
    await writeFile(path.join(root, "assets.json"), JSON.stringify({ version: 1, files: [] }));
    await writeFile(path.join(root, "game.js"), HELD_BOOT_MODULE);
    const served = await serve(root);
    const context = await browser.newContext({ viewport: { width: 64, height: 36 }, deviceScaleFactor: 1 });
    try {
      const page = await context.newPage();
      await page.addInitScript(CORE_ADAPTER);
      await page.goto(`${served.origin}/index.html?paused`);
      await page.waitForFunction(
        () => typeof (window as unknown as { __releaseBoot?: unknown }).__releaseBoot === "function",
        null,
        {
          timeout: BOOT_TIMEOUT_MS,
        },
      );
      await page.setViewportSize({ width: 640, height: 360 });
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      await page.evaluate(() => (window as unknown as { __releaseBoot: () => void }).__releaseBoot());
      await page.waitForFunction(
        (running) => (window as unknown as ShellWindow).GenexShell?.status.state === running,
        ShellState.Running,
        { timeout: BOOT_TIMEOUT_MS },
      );
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      const size = await page.evaluate(() => {
        const canvas = document.getElementById("game") as HTMLCanvasElement;
        return { width: canvas.width, height: canvas.height };
      });
      assert.deepEqual(size, { width: 640, height: 360 }, "the canvas has the page's size, not the size at boot");
    } finally {
      await context.close();
      served.close();
    }
  });
});

// ── the shell's display frames on a jittery browser clock ──

/**
 * A stand-in whose `studio_frame` keeps the sim's fixed 60 Hz clock as genex-core's `FrameClock`
 * does (carry the frame's ms, a tick per whole 1000/60 ms) and records each frame's ms and ticks.
 */
const PACED_MODULE = [
  "window.__paced = [];",
  "let carry = 0;",
  "const STEP_MS = 1000 / 60;",
  "export default async function init() {}",
  'export function studio_saves_database() { return "genex-shell-pacing-test"; }',
  "export function studio_saves_preload() {}",
  "export function studio_saves_unavailable() {}",
  'export function studio_saves_status() { return "{}"; }',
  "export function studio_saves_pending() { return 0; }",
  "export function studio_saves_take() { return []; }",
  "export function studio_saves_flushed() {}",
  "export function studio_assets_plan() { return []; }",
  "export function studio_assets_preload() {}",
  "export async function studio_boot() { return JSON.stringify({ ok: true, receipt: {}, world: [960, 540] }); }",
  "export function studio_call(op) { return JSON.stringify({ id: null, ok: true, op, result: {} }); }",
  "export function studio_frame(ms) {",
  "  carry += Math.min(ms, 250);",
  "  let ticks = 0;",
  "  while (carry + 1e-6 >= STEP_MS) { carry -= STEP_MS; ticks++; }",
  "  window.__paced.push([ms, ticks]);",
  "  return ticks;",
  "}",
  "",
].join("\n");

/** The page's animation frames, fired by the test: `__fire(time)` runs the callbacks queued for one frame. */
const MANUAL_FRAMES = `{
  const queued = [];
  window.requestAnimationFrame = (callback) => queued.push(callback);
  window.__fire = (time) => { for (const callback of queued.splice(0)) callback(time); };
}`;

/** A deterministic jitter in ±`spread` ms (a 32-bit LCG), as a busy main thread stamps frames. */
function jitter(count: number, spread: number): number[] {
  let state = 12345;
  return Array.from({ length: count }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 2 ** 32 - 0.5) * 2 * spread;
  });
}

/** Frames between ticks once the shell has measured the display. */
function tickGaps(paced: ReadonlyArray<[number, number]>, from: number): number[] {
  const ticked = paced.flatMap(([, ticks], index) => (index >= from && ticks > 0 ? [index] : []));
  return ticked.slice(1).map((index, i) => index - (ticked[i] ?? 0));
}

describe("the Rust web shell paces the sim on the display's own refresh", { skip: browserSkip() }, () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  /** Frames a warm-up the shell may spend measuring the refresh before its pacing is judged. */
  const WARM_UP_FRAMES = 60;
  const FRAMES = 720;
  // Pass-1 gate: Web Live on a 120 Hz display drew 7-8 frames per 8 s 25 ms after the one before
  // (and others 8 ms after): the page's frame times jitter by ±2 ms, so whether two refreshes
  // added up to a 16.7 ms tick was a coin toss near the tick's boundary.
  /** Where the sim's tick falls between two refreshes depends on when the game started: every eighth of one is tried. */
  const PHASES = 8;
  for (const row of [
    { hz: 120, spread: 2, gaps: [2] },
    { hz: 60, spread: 2, gaps: [1] },
    { hz: 144, spread: 1.5, gaps: [2, 3] },
  ]) {
    it(`${row.hz} Hz with frame times ±${row.spread} ms: a tick every ${row.gaps.join(" or ")} refreshes, no time lost`, async () => {
      const root = await tmpDir("rust-shell-pacing-");
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, "index.html"), webShellPage(await readFile(SHELL, "utf8"), "Pacing"));
      await writeFile(path.join(root, "assets.json"), JSON.stringify({ version: 1, files: [] }));
      await writeFile(path.join(root, "game.js"), PACED_MODULE);
      const served = await serve(root);
      const context = await browser.newContext({ viewport: { width: 320, height: 180 }, deviceScaleFactor: 1 });
      try {
        for (let phase = 0; phase < PHASES; phase++) {
          const page = await context.newPage();
          await page.addInitScript(CORE_ADAPTER);
          await page.addInitScript(MANUAL_FRAMES);
          await page.goto(`${served.origin}/index.html?paused`);
          await page.waitForFunction(
            (running) => (window as unknown as ShellWindow).GenexShell?.status.state === running,
            ShellState.Running,
            // Polled on a timer: this page's animation frames run only when the test fires them.
            { timeout: BOOT_TIMEOUT_MS, polling: 50 },
          );
          const refresh = 1000 / row.hz;
          const start = (await page.evaluate(() => performance.now())) + (phase * refresh) / PHASES;
          const times = jitter(FRAMES, row.spread).map((wobble, i) => start + (i + 1) * refresh + wobble);
          const paced = await page.evaluate((stamps) => {
            const fire = (window as unknown as { __fire: (time: number) => void }).__fire;
            for (const time of stamps) fire(time);
            return (window as unknown as { __paced: Array<[number, number]> }).__paced;
          }, times);
          await page.close();
          const label = `phase ${phase}/${PHASES}`;
          assert.equal(paced.length, FRAMES, `${label}: every animation frame reached the game`);
          const gaps = [...new Set(tickGaps(paced, WARM_UP_FRAMES))].sort();
          assert.deepEqual(gaps, row.gaps, `${label}: frames between ticks ${gaps.join(", ")}`);
          const fed = paced.slice(1).reduce((sum, [ms]) => sum + ms, 0);
          const elapsed = (times.at(-1) ?? 0) - (times[0] ?? 0);
          assert.ok(
            Math.abs(fed - elapsed) <= refresh,
            `${label}: the sim was fed ${fed.toFixed(2)} ms of ${elapsed.toFixed(2)}`,
          );
        }
      } finally {
        await context.close();
        served.close();
      }
    });
  }
});
