/**
 * A `[net]` game's web build (game systems MP-5a): the relay client's JS bridge beside the page.
 *
 * - Packaging rows (scripted tools, everywhere): `packageWeb` with `net` copies the pinned
 *   `bridge.global.js` to `mp/bridge.global.js` and the build's shim to `mp/bridge.mjs`, the page
 *   gains the import map and the classic script tag in its head, and the receipt records
 *   `mpBridgeBytes` and `mpBridgeGzip`. A build without `net` is the build it was before: the same
 *   files, receipt keys and page. A bridge that is a link, missing, not a regular file, or not the
 *   pinned size and sha256 is refused `mp-bridge-refused` before anything runs or is written. The
 *   rows hand `packageWeb` a fixture pin; the real one is `MULTIPLAYER_BRIDGE_PIN`.
 * - The shim re-exports every bridge call the vendored genex-multiplayer crate imports, and fails
 *   with `mp-bridge-missing` when the bridge did not load first.
 * - Browser rows (Chromium, `STUDIO_BROWSER_TESTS=1`): a stand-in game.js that imports the bare
 *   specifier boots on a net page (the map resolves it to the shim, the bridge's global is set) and
 *   fails to boot on the page every other build gets, which has no import map. Every request the
 *   net page makes is on its own origin, inside its folder.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { type Browser, chromium } from "@playwright/test";
import {
  MP_BRIDGE_SPECIFIER,
  packageWeb,
  RustWebRefusal,
  RustWebStep,
  WASM_BINDGEN_VERSION,
  type WebBridgePin,
  WEB_FILES,
  WEB_NET_FILES,
  type WebPackageInput,
  type WebRun,
  webShellPage,
} from "../../src/main/rust-build-web.ts";
import { MP_BRIDGE_SHIM } from "../../src/main/mp-bridge-shim.ts";
import { SECOND_MS } from "../../src/shared/duration.ts";
import { MULTIPLAYER_BRIDGE_PIN } from "../../src/shared/toolchain.ts";
import { playwrightHeadlessChromiumOnDisk } from "../helpers/playwright-chromium.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SHELL = path.join(REPO, "src", "game-template-rust", "web", "shell.html");
const CRATE_WEB = path.join(REPO, "native", "genex-rust", "crates", "genex-multiplayer", "src", "web.rs");
const BOOT_TIMEOUT_MS = 30 * SECOND_MS;
const SCRIPTED_TOOLS = { wasmBindgen: "/t/wasm-bindgen", wasmOpt: "/t/wasm-opt" };
/** The receipt's keys before MP-5a: a build without `net` has exactly these. */
const PLAIN_RECEIPT_KEYS = [
  "binaryen",
  "files",
  "gzipBudgetBytes",
  "gzipBytes",
  "gzipCeilingBytes",
  "optimized",
  "version",
  "warning",
  "wasmBindgen",
  "wasmBytes",
  "withinBudget",
];
/** The shell's status states (shell.html). Wire values. */
const ShellState = { Running: "running", Failed: "failed" } as const;

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** A fixture bridge: a classic script setting the global with `names` as calls (each answers its name), and `version()`. */
function fixtureBridge(names: readonly string[] = []): Buffer {
  const calls = names.map((name) => `${JSON.stringify(name)}: () => ${JSON.stringify(name)}`).join(", ");
  return Buffer.from(
    `"use strict";(()=>{globalThis.GenexMultiplayerBridge=Object.freeze({${calls}${calls ? ", " : ""}version: () => "fixture-bridge"});})();\n`,
  );
}

const pinOf = (bytes: Uint8Array): WebBridgePin => ({ version: "fixture", bytes: bytes.length, sha256: sha256(bytes) });

/** A runner that answers like the real tools: a version line, and the files each step writes. */
function scriptedTools(out: string): { run: WebRun; commands: string[] } {
  const commands: string[] = [];
  const run: WebRun = async (command, step) => {
    commands.push(command);
    if (step === RustWebStep.BindgenVersion)
      return { code: 0, stdout: `wasm-bindgen ${WASM_BINDGEN_VERSION}\n`, stderr: "" };
    if (step === RustWebStep.Bindgen) {
      await writeFile(path.join(out, WEB_FILES.module), "export default async function init() {}\n");
      await writeFile(path.join(out, WEB_FILES.wasm), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { run, commands };
}

/** A packaging of a fake module into a fresh `out`, with the real shell and the scripted tools. */
async function packagingInput(name: string, net?: WebPackageInput["net"]) {
  const home = await realpath(await tmpDir(`rust-web-net-${name}-`));
  const wasm = path.join(home, "game.wasm");
  await writeFile(wasm, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
  const out = path.join(home, "out");
  const tools = scriptedTools(out);
  const shell = await readFile(SHELL, "utf8");
  const input: WebPackageInput = {
    wasm,
    out,
    shell,
    title: "Net game",
    optimize: false,
    tools: SCRIPTED_TOOLS,
    run: tools.run,
    ...(net ? { net } : {}),
  };
  return { home, out, input, commands: tools.commands, shell };
}

/** The served folder's files, `/`-separated and sorted. */
async function listing(dir: string, rel = ""): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) names.push(...(await listing(dir, child)));
    else names.push(child);
  }
  return names.sort();
}

describe("a [net] game's web build serves the pinned bridge beside the page (MP-5a)", () => {
  it("pins @genex-ai/multiplayer 0.17.0's bridge.global.js by size and sha256", () => {
    assert.equal(MULTIPLAYER_BRIDGE_PIN.version, "0.17.0");
    assert.equal(MULTIPLAYER_BRIDGE_PIN.file, "dist/bridge.global.js");
    assert.match(MULTIPLAYER_BRIDGE_PIN.sha256, /^[0-9a-f]{64}$/);
    assert.ok(MULTIPLAYER_BRIDGE_PIN.bytes > 0);
  });

  it("copies the bridge and the shim, puts the map and script in the page's head, and records their sizes", async () => {
    const bridgeBytes = fixtureBridge(["connect"]);
    const home = await realpath(await tmpDir("rust-web-net-store-"));
    const bridge = path.join(home, "bridge.global.js");
    await writeFile(bridge, bridgeBytes);
    // The lane hands over the shim's text; any text is copied byte for byte.
    const shim = "export default globalThis.GenexMultiplayerBridge;\n";
    const { out, input } = await packagingInput("net", { bridge, shim, pin: pinOf(bridgeBytes) });
    const result = await packageWeb(input);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.deepEqual(
      await listing(out),
      [
        WEB_FILES.module,
        WEB_FILES.wasm,
        WEB_FILES.page,
        WEB_NET_FILES.bridge,
        WEB_NET_FILES.shim,
        WEB_FILES.size,
      ].sort(),
    );
    assert.deepEqual(await readFile(path.join(out, WEB_NET_FILES.bridge)), bridgeBytes);
    assert.equal(await readFile(path.join(out, WEB_NET_FILES.shim), "utf8"), shim);
    const page = await readFile(path.join(out, WEB_FILES.page), "utf8");
    const head = page.slice(0, page.indexOf("</head>"));
    const map = /<script type="importmap">(.*?)<\/script>/.exec(head);
    assert.ok(map, "the import map is in the head");
    assert.deepEqual(JSON.parse(map[1]), { imports: { [MP_BRIDGE_SPECIFIER]: `./${WEB_NET_FILES.shim}` } });
    const classic = head.indexOf(`<script src="${WEB_NET_FILES.bridge}"></script>`);
    assert.ok(classic > 0, "the bridge's classic script is in the head");
    assert.ok(classic < page.indexOf('<script type="module">'), "the bridge loads before any module");
    assert.ok(!page.includes("__NET_BRIDGE__"));
    const { receipt } = result;
    const shimBytes = Buffer.from(shim);
    assert.equal(receipt.mpBridgeBytes, bridgeBytes.length + shimBytes.length);
    assert.equal(
      receipt.mpBridgeGzip,
      gzipSync(bridgeBytes, { level: 9 }).length + gzipSync(shimBytes, { level: 9 }).length,
    );
    assert.equal(receipt.files[WEB_NET_FILES.bridge], sha256(bridgeBytes));
    assert.equal(receipt.files[WEB_NET_FILES.shim], sha256(shimBytes));
    assert.equal(receipt.files[WEB_FILES.page], sha256(page));
  });

  it("builds a game without [net] exactly as before: no mp files, receipt keys or page tags", async () => {
    const { out, input, shell } = await packagingInput("plain");
    const result = await packageWeb(input);
    assert.equal(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.deepEqual(await listing(out), [WEB_FILES.module, WEB_FILES.wasm, WEB_FILES.page, WEB_FILES.size].sort());
    assert.deepEqual(Object.keys(result.receipt).sort(), PLAIN_RECEIPT_KEYS);
    assert.deepEqual(
      Object.keys(result.receipt.files).sort(),
      [WEB_FILES.module, WEB_FILES.wasm, WEB_FILES.page].sort(),
    );
    const page = await readFile(path.join(out, WEB_FILES.page), "utf8");
    assert.equal(page, webShellPage(shell.replace("<!--__NET_BRIDGE__-->", ""), "Net game"));
    for (const text of ['<script type="importmap">', `<script src="${WEB_NET_FILES.bridge}">`, "__NET_BRIDGE__"]) {
      assert.ok(!page.includes(text), text);
    }
    assert.ok(page.includes('    <link rel="icon" href="data:," />\n'), "the head line is the one it was");
  });

  const hostile: ReadonlyArray<{ name: string; make: (home: string, good: Buffer) => Promise<string> }> = [
    {
      name: "a bridge whose sha256 is not the pin's",
      make: async (home, good) => {
        const bad = Buffer.from(good);
        bad[bad.length - 2] ^= 1;
        await writeFile(path.join(home, "bridge.global.js"), bad);
        return path.join(home, "bridge.global.js");
      },
    },
    {
      name: "a link to the pinned bridge",
      make: async (home, good) => {
        await writeFile(path.join(home, "real.js"), good);
        await symlink(path.join(home, "real.js"), path.join(home, "bridge.global.js"));
        return path.join(home, "bridge.global.js");
      },
    },
    {
      name: "a missing bridge",
      make: async (home) => path.join(home, "bridge.global.js"),
    },
    {
      name: "a folder in the bridge's place",
      make: async (home) => {
        await mkdir(path.join(home, "bridge.global.js"));
        return path.join(home, "bridge.global.js");
      },
    },
    {
      name: "a bridge longer than the pin",
      make: async (home, good) => {
        await writeFile(path.join(home, "bridge.global.js"), Buffer.concat([good, Buffer.from("\n")]));
        return path.join(home, "bridge.global.js");
      },
    },
  ];
  for (const row of hostile) {
    it(`refuses ${row.name} before anything runs or is written`, async () => {
      const good = fixtureBridge();
      const store = await realpath(await tmpDir("rust-web-net-hostile-"));
      const bridge = await row.make(store, good);
      const fresh = await packagingInput("hostile", { bridge, shim: "export {};\n", pin: pinOf(good) });
      const result = await packageWeb(fresh.input);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.refusal, RustWebRefusal.MpBridgeRefused);
      assert.equal(result.receipt, null);
      assert.deepEqual(fresh.commands, [], "no tool ran");
      assert.equal(await lstat(fresh.out).catch(() => null), null, "no output folder was made");
      // An earlier build's folder is left as it was.
      const earlier = await packagingInput("hostile-earlier", { bridge, shim: "export {};\n", pin: pinOf(good) });
      await mkdir(earlier.out);
      await writeFile(path.join(earlier.out, WEB_FILES.page), "earlier");
      assert.equal((await packageWeb(earlier.input)).ok, false);
      assert.deepEqual(await listing(earlier.out), [WEB_FILES.page]);
      assert.equal(await readFile(path.join(earlier.out, WEB_FILES.page), "utf8"), "earlier");
    });
  }

  it("refuses a bridge that is not the real pin's when no fixture pin is handed over", async () => {
    const store = await realpath(await tmpDir("rust-web-net-unpinned-"));
    const bridge = path.join(store, "bridge.global.js");
    await writeFile(bridge, fixtureBridge());
    const { input, commands } = await packagingInput("unpinned", { bridge, shim: "export {};\n" });
    const result = await packageWeb(input);
    assert.equal(result.ok ? null : result.refusal, RustWebRefusal.MpBridgeRefused);
    assert.deepEqual(commands, []);
  });
});

/** The bridge calls the vendored crate imports from the specifier (its `js_name`s). */
async function crateBridgeCalls(): Promise<string[]> {
  const text = await readFile(CRATE_WEB, "utf8");
  const start = text.indexOf(`#[wasm_bindgen(module = "${MP_BRIDGE_SPECIFIER}")]`);
  assert.ok(start >= 0, "the crate imports the specifier");
  const block = text.slice(start, text.indexOf("\n}\n", start));
  return [...block.matchAll(/js_name = (\w+)/g)].map((match) => match[1]);
}

/** The shim's exports, imported afresh with `bridge` as the global (absent: none). */
async function shimExports(bridge: Record<string, unknown> | undefined): Promise<Record<string, unknown>> {
  const copy = path.join(await realpath(await tmpDir("rust-web-net-shim-")), "bridge.mjs");
  await writeFile(copy, MP_BRIDGE_SHIM);
  const scope = globalThis as { GenexMultiplayerBridge?: unknown };
  scope.GenexMultiplayerBridge = bridge;
  try {
    return await import(pathToFileURL(copy).href);
  } finally {
    delete scope.GenexMultiplayerBridge;
  }
}

describe("the bridge shim (MP-5a)", () => {
  it("re-exports every bridge call the vendored genex-multiplayer crate imports", async () => {
    const calls = await crateBridgeCalls();
    assert.ok(calls.length >= 20, calls.join(" "));
    const bridge = Object.fromEntries(calls.map((name) => [name, () => name]));
    const shim = await shimExports(bridge);
    for (const name of calls) {
      assert.equal(typeof shim[name], "function", name);
      assert.equal((shim[name] as () => string)(), name);
    }
    assert.equal(shim.default, bridge);
  });

  it("fails with mp-bridge-missing when the bridge did not load first", async () => {
    await assert.rejects(shimExports(undefined), /mp-bridge-missing/);
  });
});

// ── the page (Chromium) ──

const PLAYWRIGHT_CHROMIUM = playwrightHeadlessChromiumOnDisk();
const browserSkip = () => {
  if (process.env.STUDIO_BROWSER_TESTS !== "1") return "set STUDIO_BROWSER_TESTS=1 to run the page rows";
  return PLAYWRIGHT_CHROMIUM ? false : "no Playwright Chromium on disk (nothing is downloaded)";
};

/** A stand-in adapter at core limits: the shell's preflight passes it. */
const STAND_IN_ADAPTER = `{
  const limits = new Proxy({}, { get: (_t, key) => (String(key).startsWith("min") ? 1 : 1e9) });
  const gpu = { requestAdapter: async () => ({ limits, features: new Set() }) };
  Object.defineProperty(Navigator.prototype, "gpu", { configurable: true, get: () => gpu });
}`;

/** A stand-in net game.js: imports the bare specifier as the crate's glue does, and plans one asset. */
function netModule(asset: readonly [string, number]): string {
  return [
    `import { connect, version } from ${JSON.stringify(MP_BRIDGE_SPECIFIER)};`,
    "window.__netLog = [];",
    "export default async function init() {}",
    'export function studio_saves_database() { return "genex-shell-net-test"; }',
    "export function studio_saves_preload() {}",
    "export function studio_saves_unavailable() {}",
    'export function studio_saves_status() { return "{}"; }',
    "export function studio_saves_pending() { return 0; }",
    "export function studio_saves_take() { return []; }",
    "export function studio_saves_flushed() {}",
    `export function studio_assets_plan() { return [${JSON.stringify(asset)}]; }`,
    'export function studio_assets_preload(name) { window.__netLog.push(["preload", name]); }',
    'export async function studio_boot() { window.__netLog.push(["boot", version(), connect()]); return JSON.stringify({ ok: true, receipt: {}, world: [64, 64] }); }',
    "export function studio_call(op) { return JSON.stringify({ id: null, ok: true, op, result: {} }); }",
    "export function studio_frame() { return 0; }",
    "",
  ].join("\n");
}

/** A static server over `root` recording every request's path. */
async function serve(root: string): Promise<{ origin: string; seen: string[]; close: () => void }> {
  const seen: string[] = [];
  const types: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
  };
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    seen.push(pathname);
    const file = path.join(root, path.normalize(pathname));
    const body = file.startsWith(`${root}${path.sep}`) ? await readFile(file).catch(() => null) : null;
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "content-type": types[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => server.close() };
}

/** A served net game: the page (`net` or the plain page), the stand-in module, the bridge, the shim and one asset. */
async function netFolder(net: boolean): Promise<string> {
  const root = await realpath(await tmpDir("rust-web-net-page-"));
  const asset = Buffer.from("glTF crate");
  await writeFile(path.join(root, WEB_FILES.page), webShellPage(await readFile(SHELL, "utf8"), "Net", {}, net));
  await writeFile(path.join(root, WEB_FILES.module), netModule(["models/crate.glb", asset.length]));
  await mkdir(path.join(root, "mp"));
  await writeFile(path.join(root, WEB_NET_FILES.bridge), fixtureBridge(["connect"]));
  await writeFile(path.join(root, WEB_NET_FILES.shim), MP_BRIDGE_SHIM);
  await mkdir(path.join(root, WEB_FILES.assets, "models"), { recursive: true });
  await writeFile(path.join(root, WEB_FILES.assets, "models", "crate.glb"), asset);
  await writeFile(path.join(root, WEB_FILES.assetMap), JSON.stringify({ version: 2, files: [] }));
  return root;
}

interface NetWindow {
  GenexShell?: { status: { state: string; code: string | null; reason: string | null } };
  __netLog?: unknown[];
}

describe("a [net] game's page resolves the bridge through its import map (MP-5a)", { skip: browserSkip() }, () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  /** Opens `root`'s page until the shell runs or fails: its status, the module's log and the requests. */
  async function open(root: string) {
    const served = await serve(root);
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.addInitScript(STAND_IN_ADAPTER);
      await page.goto(`${served.origin}/index.html?paused`);
      await page.waitForFunction(
        (states) => states.includes((window as unknown as NetWindow).GenexShell?.status.state ?? ""),
        [ShellState.Running, ShellState.Failed] as string[],
        { timeout: BOOT_TIMEOUT_MS },
      );
      const seen = await page.evaluate(() => {
        const shell = window as unknown as NetWindow;
        return { status: shell.GenexShell?.status, log: shell.__netLog ?? null };
      });
      return { ...seen, requests: [...served.seen], origin: served.origin };
    } finally {
      await context.close();
      served.close();
    }
  }

  it("boots a game.js that imports the bridge's bare name, its calls answered by the pinned bridge", async () => {
    const seen = await open(await netFolder(true));
    assert.equal(seen.status?.state, ShellState.Running, JSON.stringify(seen.status));
    assert.deepEqual(seen.log, [
      ["preload", "models/crate.glb"],
      ["boot", "fixture-bridge", "connect"],
    ]);
    assert.equal(seen.requests.filter((request) => request === `/${WEB_NET_FILES.bridge}`).length, 1);
    assert.equal(seen.requests.filter((request) => request === `/${WEB_NET_FILES.shim}`).length, 1);
    const known = new Set([
      `/${WEB_FILES.page}`,
      `/${WEB_FILES.module}`,
      `/${WEB_FILES.wasm}`,
      `/${WEB_FILES.assetMap}`,
      `/${WEB_NET_FILES.bridge}`,
      `/${WEB_NET_FILES.shim}`,
      "/assets/models/crate.glb",
    ]);
    for (const request of seen.requests) assert.ok(known.has(request), `an unexpected request ${request}`);
  });

  it("fails to boot the same game.js on the page every other build gets (no import map)", async () => {
    const seen = await open(await netFolder(false));
    assert.equal(seen.status?.state, ShellState.Failed, JSON.stringify(seen.status));
    assert.match(String(seen.status?.reason), /@genex-ai\/multiplayer\/bridge/);
    assert.equal(seen.log, null, "the module never ran");
    assert.ok(!seen.requests.includes(`/${WEB_NET_FILES.bridge}`), "the plain page never loads the bridge");
  });
});
