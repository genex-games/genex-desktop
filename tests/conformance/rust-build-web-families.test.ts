/**
 * The web's per-adapter texture fetch (game systems C-16): the web package carries every compressed
 * family of a texture beside its source image (C-15), and the browser fetches only the one its
 * adapter samples.
 *
 * - The map rows: `webAssetMap` (`src/main/rust-build-web.ts`) writes map v2, each family file
 *   tagged with its `family` and the texture it is `of`. A texture's source image is tagged
 *   `source` (so the module may leave it out) only when the runtime never falls back to it: every
 *   texture's files cover every compressed family any texture ships (the renderer stores one family
 *   for all), none is RGBA8 (the runtime never reads that file, the image instead) and each is at
 *   least genex-render's smallest family class. Otherwise the image stays a plain entry, always
 *   fetched. A map without family files is the v1 map's entries as before.
 * - The shell rows (Chromium, `STUDIO_BROWSER_TESTS=1`): the shell hands `studio_assets_plan` the
 *   adapter's compressed texture features and whether the page is a phone's (the renderer's own
 *   rule), the dry boot gets the same, and the loading screen counts only the files planned.
 * - The module rows (`GENEX_WEB_PACKAGE_DIR` names a web package the lane built, its `game.js` and
 *   `game_bg.wasm`): the real module's plan over the map this host writes. A BC adapter fetches
 *   one of a texture's four files, an adapter without a compressed feature the source only, and a
 *   real WebGPU adapter in Chromium fetches the family its features pick.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "@playwright/test";
import {
  type WebAssetEntry,
  WebAssetFamily,
  type WebAssetMap,
  webAssetMap,
  webShellPage,
  WEB_ASSET_MAP_VERSION,
  WEB_FILES,
} from "../../src/main/rust-build-web.ts";
import { SECOND_MS } from "../../src/shared/duration.ts";
import { writeKtx2 } from "../../src/substrate/asset-import/ktx2-write.ts";
import { TextureCompression } from "../../src/substrate/asset-import/texture-table.ts";
import { fnv1a64Hex } from "../../src/substrate/native-game-port.ts";
import { playwrightHeadlessChromiumOnDisk } from "../helpers/playwright-chromium.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SHELL = path.join(REPO, "src", "game-template-rust", "web", "shell.html");
const BOOT_TIMEOUT_MS = 30 * SECOND_MS;
/** A real boot to the game's first frame (pipelines compile cold). */
const READY_TIMEOUT_MS = 90 * SECOND_MS;
/** genex-render's smallest family class (`TEXTURE_SIZE_CLASSES[1]`): a family file under it loads the image. */
const FAMILY_MIN_SIDE = 512;
/** The compressed families the web package carries (C-15). */
const WEB_FAMILIES = [TextureCompression.Bc, TextureCompression.Astc, TextureCompression.Etc2] as const;
/** The shell's status states (shell.html). Wire values. */
const ShellState = { Starting: "starting", Running: "running", Failed: "failed" } as const;
/** Chromium's WebGPU on the Mac's GPU (Metal) rather than SwiftShader. */
const WEBGPU_ARGS = ["--enable-unsafe-webgpu", "--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"];
/** A desktop's screen: the renderer's phone rule reads a short side of 900 CSS px or less as a phone. */
const DESKTOP_SCREEN = { width: 1920, height: 1080 };
/** genex-render's family orders (`texture_ktx2.rs` DESKTOP_ORDER, MOBILE_ORDER): the test's oracle. */
const FAMILY_ORDER = {
  desktop: ["bc", "astc", "etc2"],
  mobile: ["astc", "etc2", "bc"],
} as const;
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
};
/** A 1×1 PNG: a texture's source image. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

/** A family KTX2 of `side` texels (one stand-in level: the map reads only the header). */
function familyKtx2(compression: TextureCompression, side: number): Uint8Array {
  return writeKtx2({ compression, srgb: true, side, levels: [new Uint8Array(16).fill(side & 0xff)] });
}

/** A staged `assets/` folder holding `files` (path → bytes), and its map. */
async function mapOf(files: Record<string, Uint8Array>): Promise<{ assets: string; map: WebAssetMap }> {
  const root = await realpath(await tmpDir("rust-web-families-"));
  const assets = path.join(root, "assets");
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(assets, name)), { recursive: true });
    await writeFile(path.join(assets, name), bytes);
  }
  return { assets, map: await webAssetMap(assets) };
}

/** `stem`'s image and its family files in `families`, each `side` texels. */
function texture(
  stem: string,
  families: readonly TextureCompression[] = WEB_FAMILIES,
  side = FAMILY_MIN_SIDE,
): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = { [`${stem}.png`]: PNG };
  for (const family of families) files[`${stem}.${family}.ktx2`] = familyKtx2(family, side);
  return files;
}

/** The map's entries by path: `[family, of]`, or null for a plain entry. */
function tags(map: WebAssetMap): Record<string, [string, string] | null> {
  const found: Record<string, [string, string] | null> = {};
  for (const entry of map.files) found[entry.path] = entry.family ? [entry.family, entry.of ?? ""] : null;
  return found;
}

describe("the web asset map tags each texture's family files (C-16)", () => {
  it("writes a texture's three family files and its source as one choice of four", async () => {
    const { map } = await mapOf(texture("textures/rock"));
    assert.equal(map.version, WEB_ASSET_MAP_VERSION);
    assert.equal(map.version, 2);
    const of = "textures/rock.png";
    assert.deepEqual(tags(map), {
      "textures/rock.astc.ktx2": [WebAssetFamily.Astc, of],
      "textures/rock.bc.ktx2": [WebAssetFamily.Bc, of],
      "textures/rock.etc2.ktx2": [WebAssetFamily.Etc2, of],
      "textures/rock.png": [WebAssetFamily.Source, of],
    });
  });

  it("keeps every entry's path, length and FNV-1a 64 exactly as the v1 map wrote them", async () => {
    const files: Record<string, Uint8Array> = {
      ...texture("textures/rock"),
      "models/crate.glb": Buffer.from("glTF crate"),
    };
    const { map } = await mapOf(files);
    const plain = map.files.map(({ path: file, bytes, fnv1a64 }) => ({ path: file, bytes, fnv1a64 }));
    const expected = Object.keys(files)
      .sort()
      .map((file) => ({ path: file, bytes: files[file].length, fnv1a64: fnv1a64Hex(files[file]) }));
    assert.deepEqual(plain, expected);
    assert.equal(tags(map)["models/crate.glb"], null, "a model is never a family's file");
  });

  const kept: ReadonlyArray<{ name: string; files: Record<string, Uint8Array>; source: string; of: string }> = [
    {
      name: "a texture whose family files are under the smallest family class (the runtime loads the image)",
      files: texture("textures/leaf", WEB_FAMILIES, FAMILY_MIN_SIDE / 2),
      source: "textures/leaf.png",
      of: "textures/leaf.png",
    },
    {
      name: "a texture missing a family another texture ships (the renderer stores that one for all)",
      files: { ...texture("textures/rock"), ...texture("textures/moss", [TextureCompression.Bc]) },
      source: "textures/moss.png",
      of: "textures/moss.png",
    },
    {
      name: "a texture with an RGBA8 file (the runtime never reads it, the image instead)",
      files: texture("textures/sand", [...WEB_FAMILIES, TextureCompression.Rgba8]),
      source: "textures/sand.png",
      of: "textures/sand.png",
    },
    {
      name: "a texture whose family file is not a readable KTX2",
      files: { ...texture("textures/tile"), "textures/tile.astc.ktx2": Buffer.from("not a ktx2") },
      source: "textures/tile.png",
      of: "textures/tile.png",
    },
    {
      name: "a texture with two images of one stem",
      files: { ...texture("textures/bark"), "textures/bark.jpg": Buffer.from("jpeg bytes") },
      source: "textures/bark.png",
      of: "textures/bark",
    },
  ];
  for (const row of kept) {
    it(`keeps the image a plain entry, always fetched: ${row.name}`, async () => {
      const { map } = await mapOf(row.files);
      const found = tags(map);
      assert.equal(found[row.source], null, `${row.source} stays plain: ${JSON.stringify(found)}`);
      const stem = row.of.replace(/\.png$/, "");
      const familyFiles = Object.entries(found).filter(
        ([file]) => file.startsWith(`${stem}.`) && file.endsWith(".ktx2"),
      );
      assert.ok(familyFiles.length > 0);
      for (const [file, tag] of familyFiles) assert.equal(tag?.[1], row.of, `${file} is of ${row.of}`);
    });
  }

  const plain: ReadonlyArray<{ name: string; files: Record<string, Uint8Array> }> = [
    {
      name: "a model sharing a texture's stem",
      files: { "models/crate.glb": Buffer.from("glTF"), "models/crate.bc.ktx2": familyKtx2("bc", 512) },
    },
    { name: "an uppercase family tag", files: { "t/a.png": PNG, "t/a.BC.ktx2": familyKtx2("bc", 512) } },
    { name: "a tag that is no family", files: { "t/a.png": PNG, "t/a.source.ktx2": familyKtx2("bc", 512) } },
    {
      name: "an environment map beside a family file",
      files: { "sky.hdr": PNG, "sky.bc.ktx2": familyKtx2("bc", 512) },
    },
  ];
  for (const row of plain) {
    it(`never tags a file that is not a texture's image as its source: ${row.name}`, async () => {
      const { map } = await mapOf(row.files);
      const sources = map.files.filter((entry) => entry.family === WebAssetFamily.Source);
      assert.deepEqual(sources, []);
      for (const entry of map.files.filter((e) => !e.path.endsWith(".ktx2"))) assert.equal(entry.family, undefined);
    });
  }

  it("tags a GLB's image sidecars by their own stem, with no source to leave out", async () => {
    const files: Record<string, Uint8Array> = { "models/crate.glb": Buffer.from("glTF crate") };
    for (const family of WEB_FAMILIES) files[`models/crate.t0.${family}.ktx2`] = familyKtx2(family, 1024);
    const { map } = await mapOf(files);
    assert.deepEqual(tags(map), {
      "models/crate.glb": null,
      "models/crate.t0.astc.ktx2": [WebAssetFamily.Astc, "models/crate.t0"],
      "models/crate.t0.bc.ktx2": [WebAssetFamily.Bc, "models/crate.t0"],
      "models/crate.t0.etc2.ktx2": [WebAssetFamily.Etc2, "models/crate.t0"],
    });
  });

  it("writes no family member for a build without family files", async () => {
    const { map } = await mapOf({ "a.png": PNG, "models/sphere.glb": Buffer.from("glTF sphere") });
    for (const entry of map.files) {
      assert.equal(entry.family, undefined);
      assert.equal(entry.of, undefined);
    }
  });
});

// ── the browser ──

const browserSkip = (): string | false => {
  if (process.env.STUDIO_BROWSER_TESTS !== "1") return "launches Chromium; set STUDIO_BROWSER_TESTS=1 to run";
  return playwrightHeadlessChromiumOnDisk()
    ? false
    : "no Playwright Chromium is installed; this suite never downloads one";
};

const PACKAGE = process.env.GENEX_WEB_PACKAGE_DIR ?? "";
const moduleSkip = (): string | false => {
  const browser = browserSkip();
  if (browser) return browser;
  if (!PACKAGE) return "set GENEX_WEB_PACKAGE_DIR to a web package the lane built (game.js, game_bg.wasm)";
  const built = [WEB_FILES.module, WEB_FILES.wasm].every((name) => existsSync(path.join(PACKAGE, name)));
  return built ? false : `GENEX_WEB_PACKAGE_DIR has no ${WEB_FILES.module} and ${WEB_FILES.wasm}`;
};

/** A stand-in adapter at core limits offering `features`: the shell's preflight passes it. */
function standInAdapter(features: readonly string[]): string {
  return `{
    const limits = new Proxy({}, { get: (_t, key) => (String(key).startsWith("min") ? 1 : 1e9) });
    const adapter = { limits, features: new Set(${JSON.stringify(features)}) };
    const gpu = { requestAdapter: async () => adapter };
    Object.defineProperty(Navigator.prototype, "gpu", { configurable: true, get: () => gpu });
  }`;
}

/**
 * A stand-in module that answers the plan `plan` and records what the shell hands it: the
 * adapter's facts, each file preloaded, the boot.
 */
function recordingModule(plan: ReadonlyArray<readonly [string, number]>): string {
  return [
    "window.__assetLog = [];",
    "const log = (...entry) => window.__assetLog.push(entry);",
    "export default async function init() {}",
    'export function studio_saves_database() { return "genex-shell-families-test"; }',
    "export function studio_saves_preload() {}",
    "export function studio_saves_unavailable() {}",
    'export function studio_saves_status() { return "{}"; }',
    "export function studio_saves_pending() { return 0; }",
    "export function studio_saves_take() { return []; }",
    "export function studio_saves_flushed() {}",
    `export function studio_assets_plan(map, adapter) { log("plan", adapter ?? null); return ${JSON.stringify(plan)}; }`,
    'export function studio_assets_preload(name) { log("preload", name); }',
    'export async function studio_boot() { log("boot"); return JSON.stringify({ ok: true, receipt: {}, world: [64, 64] }); }',
    "export function studio_call(op) { return JSON.stringify({ id: null, ok: true, op, result: {} }); }",
    "export function studio_frame() { return 0; }",
    "",
  ].join("\n");
}

/** A static server over `root` that records every path asked; 404 for anything that is not a regular file under it. */
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

/** A served game folder: the shell, `module` (or the package's own module and wasm), the staged files and their map. */
async function gameFolder(files: Record<string, Uint8Array>, module: string | null): Promise<string> {
  const root = await realpath(await tmpDir("rust-web-families-page-"));
  await writeFile(path.join(root, WEB_FILES.page), webShellPage(await readFile(SHELL, "utf8"), "Families"));
  if (module === null) {
    for (const name of [WEB_FILES.module, WEB_FILES.wasm])
      await copyFile(path.join(PACKAGE, name), path.join(root, name));
  } else await writeFile(path.join(root, WEB_FILES.module), module);
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, WEB_FILES.assets, name)), { recursive: true });
    await writeFile(path.join(root, WEB_FILES.assets, name), bytes);
  }
  const map = await webAssetMap(path.join(root, WEB_FILES.assets));
  await writeFile(path.join(root, WEB_FILES.assetMap), JSON.stringify(map));
  return root;
}

interface ShellWindow {
  GenexShell: {
    status: { state: string; code: string | null; reason: string | null };
    adapter?: { features: string[]; mobile: boolean } | null;
  };
  __assetLog?: Array<[string, ...unknown[]]>;
  __progress?: Array<{ stage: string; done?: number; total?: number }>;
}

/** Records every loading-progress event the shell sends (`genex:progress`), before the page's script runs. */
const PROGRESS_RECORDER = `{
  window.__progress = [];
  window.addEventListener("genex:progress", (event) => window.__progress.push(event.detail));
}`;

/**
 * How long {@link openPage} waits: until the shell leaves `starting` (paused), until the loading
 * screen reaches the game's first frame (`ready`), or until the assets are in (`assetsIn`: a
 * stand-in adapter no real device opens on, so the boot itself never finishes).
 */
const Until = { Settled: "settled", Ready: "ready", AssetsIn: "assets-in" } as const;
type Until = (typeof Until)[keyof typeof Until];
/** The loading stages that come after the assets (shell.html LoadStage). */
const AFTER_ASSETS = ["device", "pipelines", "frame", "ready"];

/** Opens the served page until `until`; its status, log, progress and the asset requests. */
async function openPage(page: Page, origin: string, requests: string[], until: Until = Until.Settled) {
  await page.goto(`${origin}/index.html${until === Until.Ready ? "" : "?paused"}`);
  await page.waitForFunction(
    ([mode, starting, after]) => {
      const shell = (window as unknown as ShellWindow).GenexShell;
      const stage = (shell as { progress?: { stage: string } | null } | undefined)?.progress?.stage ?? "";
      if (shell && shell.status.state !== starting && mode !== "ready") return true;
      if (mode === "ready") return stage === "ready" || shell?.status.state === "failed";
      return mode === "assets-in" && after.includes(stage);
    },
    [until, ShellState.Starting, AFTER_ASSETS] as const,
    { timeout: until === Until.Ready ? READY_TIMEOUT_MS : BOOT_TIMEOUT_MS },
  );
  return page
    .evaluate(() => {
      const shell = window as unknown as ShellWindow;
      return {
        status: shell.GenexShell.status,
        adapter: shell.GenexShell.adapter ?? null,
        log: shell.__assetLog ?? [],
        progress: shell.__progress ?? [],
      };
    })
    .then((seen) => ({ ...seen, assets: requests.filter((r) => r.startsWith(`/${WEB_FILES.assets}/`)).sort() }));
}

/** Serves `root` and loads its page on a stand-in adapter offering `features` until its assets are in. */
async function loadOnStandIn(browser: Browser, root: string, features: readonly string[]) {
  const served = await serve(root);
  const context = await browser.newContext({ screen: DESKTOP_SCREEN });
  try {
    const page = await context.newPage();
    await page.addInitScript(standInAdapter(features));
    await page.addInitScript(PROGRESS_RECORDER);
    return await openPage(page, served.origin, served.requests, Until.AssetsIn);
  } finally {
    await context.close();
    served.close();
  }
}

/** The staged files of the module rows: two full textures and a GLB beside them. */
const twoTexturesAndAModel = (): Record<string, Uint8Array> => ({
  ...texture("textures/rock"),
  ...texture("textures/moss"),
  "models/crate.glb": Buffer.from("glTF crate"),
});

/** The files of `map` the texture `of` names. */
const filesOf = (map: WebAssetMap, of: string): WebAssetEntry[] => map.files.filter((entry) => entry.of === of);

describe("the Rust web shell hands the plan its adapter's texture families (C-16)", { skip: browserSkip() }, () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  it("passes the compressed texture features and the phone flag, and counts only the planned files", async () => {
    const files = texture("textures/rock");
    const bc = files["textures/rock.bc.ktx2"];
    const root = await gameFolder(files, recordingModule([["textures/rock.bc.ktx2", bc.length]]));
    const served = await serve(root);
    const context = await browser.newContext({ screen: DESKTOP_SCREEN });
    try {
      const page = await context.newPage();
      await page.addInitScript(
        standInAdapter(["texture-compression-bc", "timestamp-query", "texture-compression-etc2"]),
      );
      await page.addInitScript(PROGRESS_RECORDER);
      const seen = await openPage(page, served.origin, served.requests);
      assert.equal(seen.status.state, ShellState.Running, JSON.stringify(seen.status));
      const [plan] = seen.log;
      assert.equal(plan?.[0], "plan");
      assert.deepEqual(JSON.parse(String(plan?.[1])), {
        features: ["texture-compression-bc", "texture-compression-etc2"],
        mobile: false,
      });
      assert.deepEqual(seen.adapter, {
        features: ["texture-compression-bc", "texture-compression-etc2"],
        mobile: false,
      });
      assert.deepEqual(seen.assets, ["/assets/textures/rock.bc.ktx2"], "only the planned file is fetched");
      const totals = seen.progress.filter((p) => p.stage === "assets").map((p) => p.total);
      assert.ok(totals.length > 0 && totals.every((total) => total === 1), `assets progress ${JSON.stringify(totals)}`);
    } finally {
      await context.close();
      served.close();
    }
  });

  it("reads a phone by the renderer's own rule (a short screen side of 900 CSS px or less)", async () => {
    const root = await gameFolder({}, recordingModule([]));
    const served = await serve(root);
    const context = await browser.newContext({ screen: { width: 390, height: 844 } });
    try {
      const page = await context.newPage();
      await page.addInitScript(standInAdapter(["texture-compression-astc"]));
      const seen = await openPage(page, served.origin, served.requests);
      const [plan] = seen.log;
      assert.deepEqual(JSON.parse(String(plan?.[1])), { features: ["texture-compression-astc"], mobile: true });
    } finally {
      await context.close();
      served.close();
    }
  });

  it("passes no features for an adapter that lists none", async () => {
    const root = await gameFolder({}, recordingModule([]));
    const served = await serve(root);
    const context = await browser.newContext({ screen: DESKTOP_SCREEN });
    try {
      const page = await context.newPage();
      await page.addInitScript(`{
        const limits = new Proxy({}, { get: (_t, key) => (String(key).startsWith("min") ? 1 : 1e9) });
        const gpu = { requestAdapter: async () => ({ limits }) };
        Object.defineProperty(Navigator.prototype, "gpu", { configurable: true, get: () => gpu });
      }`);
      const seen = await openPage(page, served.origin, served.requests);
      assert.equal(seen.status.state, ShellState.Running, JSON.stringify(seen.status));
      assert.deepEqual(JSON.parse(String(seen.log[0]?.[1])), { features: [], mobile: false });
    } finally {
      await context.close();
      served.close();
    }
  });
});

describe("the real module plans one family file per texture from this host's map (C-16)", {
  skip: moduleSkip(),
}, () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch({ headless: true, args: WEBGPU_ARGS });
  });
  after(async () => {
    await browser?.close();
  });

  const adapters: ReadonlyArray<{ name: string; features: string[]; picked: string }> = [
    { name: "a BC adapter fetches 1 of a texture's 4 files", features: ["texture-compression-bc"], picked: "bc" },
    { name: "an adapter with no compressed feature fetches the source only", features: [], picked: "png" },
    {
      name: "an ASTC and ETC2 adapter on a desktop fetches ASTC",
      features: ["texture-compression-etc2", "texture-compression-astc"],
      picked: "astc",
    },
  ];
  for (const row of adapters) {
    it(row.name, async () => {
      const root = await gameFolder(twoTexturesAndAModel(), null);
      const map = JSON.parse(await readFile(path.join(root, WEB_FILES.assetMap), "utf8")) as WebAssetMap;
      const seen = await loadOnStandIn(browser, root, row.features);
      const ext = row.picked === "png" ? "png" : `${row.picked}.ktx2`;
      assert.deepEqual(seen.assets, [
        "/assets/models/crate.glb",
        `/assets/textures/moss.${ext}`,
        `/assets/textures/rock.${ext}`,
      ]);
      assert.equal(filesOf(map, "textures/rock.png").length, 4, "the texture's four files are one choice");
      const totals = seen.progress.filter((p) => p.stage === "assets").map((p) => p.total);
      assert.ok(totals.length > 0 && totals.every((total) => total === 3), `assets progress ${JSON.stringify(totals)}`);
    });
  }

  it("still plans every entry of a v1 map (no family members) for a BC adapter", async () => {
    const root = await gameFolder(texture("textures/rock"), null);
    const map = JSON.parse(await readFile(path.join(root, WEB_FILES.assetMap), "utf8")) as WebAssetMap;
    const v1 = {
      version: 1,
      files: map.files.map(({ path: file, bytes, fnv1a64 }) => ({ path: file, bytes, fnv1a64 })),
    };
    await writeFile(path.join(root, WEB_FILES.assetMap), JSON.stringify(v1));
    const seen = await loadOnStandIn(browser, root, ["texture-compression-bc"]);
    assert.deepEqual(seen.assets, v1.files.map((file) => `/${WEB_FILES.assets}/${file.path}`).sort());
    assert.equal(seen.assets.length, 4);
  });

  it("fetches the family a real WebGPU adapter's features pick, then runs", async (t) => {
    const root = await gameFolder(twoTexturesAndAModel(), null);
    const served = await serve(root);
    const context = await browser.newContext({ screen: DESKTOP_SCREEN, viewport: { width: 960, height: 540 } });
    try {
      const page = await context.newPage();
      // WebGPU is a secure context's: ask from the served origin, not about:blank.
      await page.goto(`${served.origin}/${WEB_FILES.assetMap}`);
      const hasGpu = await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter()));
      if (!hasGpu) {
        t.skip("this Chromium has no WebGPU adapter");
        return;
      }
      const seen = await openPage(page, served.origin, served.requests, Until.Ready);
      assert.equal(seen.status.state, ShellState.Running, JSON.stringify(seen.status));
      const adapter = seen.adapter;
      assert.ok(adapter, "the shell exposes the adapter's texture facts");
      const order = adapter.mobile ? FAMILY_ORDER.mobile : FAMILY_ORDER.desktop;
      const family = order.find((name) => adapter.features.includes(`texture-compression-${name}`));
      const ext = family ? `${family}.ktx2` : "png";
      assert.deepEqual(seen.assets, [
        "/assets/models/crate.glb",
        `/assets/textures/moss.${ext}`,
        `/assets/textures/rock.${ext}`,
      ]);
      const shot = process.env.GENEX_C16_EVIDENCE;
      if (shot) {
        // The loading screen fades out after the first frame; the shot is of the game.
        await page.waitForFunction(() => document.getElementById("loading")?.hidden === true, null, {
          timeout: BOOT_TIMEOUT_MS,
        });
        await page.screenshot({ path: shot });
      }
      t.diagnostic(`adapter ${JSON.stringify(adapter)} fetched ${ext}`);
    } finally {
      await context.close();
      served.close();
    }
  });
});
