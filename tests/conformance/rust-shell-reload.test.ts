/**
 * The Rust web shell's side of Live's asset swap (game systems C-19a): `window.__studio.reloadAssets`
 * fetches again only the files the host names (never the asset map, never another file), hands each
 * to the module in place of its old bytes (`studio_assets_replace`, which checks the host's
 * FNV-1a 64), then sends the `reloadAssets` op with the files it swapped. A file the module refuses,
 * one that is gone and a path that would leave `assets/` are answered refused with their codes; a
 * module without `studio_assets_replace` binds no verb, so Studio reloads the page instead.
 *
 * New behaviour (the verb did not exist). No Rust toolchain: the module is a stand-in written here.
 * Launches Playwright's headless Chromium only with `STUDIO_BROWSER_TESTS=1` and a Chromium already
 * installed; nothing is downloaded.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type Browser, chromium } from "@playwright/test";
import { webShellPage } from "../../src/main/rust-build-web.ts";
import { SECOND_MS } from "../../src/shared/duration.ts";
import { playwrightHeadlessChromiumOnDisk } from "../helpers/playwright-chromium.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SHELL = path.join(REPO, "src", "game-template-rust", "web", "shell.html");
const BOOT_TIMEOUT_MS = 20 * SECOND_MS;
const RUNNING = "running";
const CONTENT_TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript" };

/** A WebGPU adapter at core limits, so the preflight passes (as rust-shell-boot's). */
const CORE_ADAPTER = `{
  const limits = new Proxy({}, { get: (_t, key) => (String(key).startsWith("min") ? 1 : 1e9) });
  const gpu = { requestAdapter: async () => ({ limits }) };
  Object.defineProperty(Navigator.prototype, "gpu", { configurable: true, get: () => gpu });
}`;

const browserSkip = (): string | false => {
  if (process.env.STUDIO_BROWSER_TESTS !== "1") return "launches Chromium; set STUDIO_BROWSER_TESTS=1 to run";
  return playwrightHeadlessChromiumOnDisk()
    ? false
    : "no Playwright Chromium is installed; this suite never downloads one";
};

/** A static server over `root`; every path asked is recorded. */
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

/**
 * The module stand-in: plans and preloads the map's files, and (with `replace`) swaps a file's bytes
 * unless the digest is `bad`; `studio_call("reloadAssets")` answers every file it was named.
 */
function reloadModule(plan: ReadonlyArray<readonly [string, number]>, replace: boolean): string {
  return [
    "window.__log = [];",
    "const log = (...entry) => window.__log.push(entry);",
    "export default async function init() {}",
    'export function studio_saves_database() { return "genex-shell-reload-test"; }',
    "export function studio_saves_preload() {}",
    "export function studio_saves_unavailable() {}",
    'export function studio_saves_status() { return "{}"; }',
    "export function studio_saves_pending() { return 0; }",
    "export function studio_saves_take() { return []; }",
    "export function studio_saves_flushed() {}",
    `export function studio_assets_plan() { return ${JSON.stringify(plan)}; }`,
    "export function studio_assets_preload() {}",
    replace
      ? [
          "export function studio_assets_replace(name, bytes, digest) {",
          '  if (digest === "bad") throw new Error("asset-digest-mismatch: " + name);',
          '  log("replace", name, new TextDecoder().decode(bytes), digest);',
          "}",
        ].join("\n")
      : "",
    "export async function studio_boot() { return JSON.stringify({ ok: true, receipt: {}, world: [64, 64] }); }",
    "export function studio_call(op, arg) {",
    '  if (op !== "reloadAssets") return JSON.stringify({ id: null, ok: true, op, result: {} });',
    "  const files = JSON.parse(arg).files;",
    '  log("op", files.map((file) => file.path));',
    "  return JSON.stringify({ id: null, ok: true, op, result: { reloaded: files.map((file) => file.path), refused: [], pending: files.length } });",
    "}",
    "export function studio_frame() { return 0; }",
    "",
  ].join("\n");
}

const FILES: Record<string, string> = {
  "levels/one.json": "{}",
  "levels/two.json": "[]",
  "textures/bark.png": "old bark",
};

async function servedGame(replace: boolean) {
  const root = await tmpDir("rust-shell-reload-");
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "index.html"), webShellPage(await readFile(SHELL, "utf8"), "Reload"));
  const plan = Object.entries(FILES).map(([name, text]) => [name, text.length] as const);
  await writeFile(path.join(root, "game.js"), reloadModule(plan, replace));
  const map = { version: 1, files: plan.map(([name, bytes]) => ({ path: name, bytes, fnv1a64: "0" })) };
  await writeFile(path.join(root, "assets.json"), JSON.stringify(map));
  for (const [name, text] of Object.entries(FILES)) {
    await mkdir(path.dirname(path.join(root, "assets", name)), { recursive: true });
    await writeFile(path.join(root, "assets", name), text);
  }
  return { root, served: await serve(root) };
}

interface ReloadWindow {
  GenexShell: { status: { state: string } };
  __studio: { reloadAssets?: (arg: unknown) => Promise<unknown> };
  __log: unknown[];
}

describe("the Rust web shell's reloadAssets verb", { skip: browserSkip() }, () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  async function booted(replace: boolean) {
    const game = await servedGame(replace);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(CORE_ADAPTER);
    await page.goto(`${game.served.origin}/index.html?paused`);
    await page.waitForFunction(
      (running) => (window as unknown as ReloadWindow).GenexShell?.status.state === running,
      RUNNING,
      { timeout: BOOT_TIMEOUT_MS },
    );
    const close = async () => {
      await context.close();
      game.served.close();
    };
    return { ...game, page, close };
  }

  it("fetches again only the changed entry, swaps it into the module, then sends the op", async () => {
    const t = await booted(true);
    try {
      await writeFile(path.join(t.root, "assets", "textures", "bark.png"), "new bark");
      const before = t.served.requests.length;
      const answer = await t.page.evaluate(() =>
        (window as unknown as ReloadWindow).__studio.reloadAssets?.({
          files: [{ path: "textures/bark.png", digest: "00000000000000aa" }],
        }),
      );
      assert.deepEqual(answer, { reloaded: ["textures/bark.png"], refused: [], pending: 1 });
      assert.deepEqual(t.served.requests.slice(before), ["/assets/textures/bark.png"], "nothing else was fetched");
      const log = await t.page.evaluate(() => (window as unknown as ReloadWindow).__log);
      assert.deepEqual(log, [
        ["replace", "textures/bark.png", "new bark", "00000000000000aa"],
        ["op", ["textures/bark.png"]],
      ]);
    } finally {
      await t.close();
    }
  });

  it("a refused digest, a gone file and a path leaving assets/ are refused with their codes; the rest still swap", async () => {
    const t = await booted(true);
    try {
      const before = t.served.requests.length;
      const answer = await t.page.evaluate(() =>
        (window as unknown as ReloadWindow).__studio.reloadAssets?.({
          files: [
            { path: "levels/one.json", digest: "bad" },
            { path: "levels/gone.json", digest: "00" },
            { path: "../index.html", digest: "00" },
            { path: "levels/two.json", digest: "01" },
          ],
        }),
      );
      assert.deepEqual(answer, {
        reloaded: ["levels/two.json"],
        refused: [
          { path: "levels/one.json", code: "digest-mismatch" },
          { path: "levels/gone.json", code: "missing" },
          { path: "../index.html", code: "unsafe-path" },
        ],
        pending: 1,
      });
      const asked = t.served.requests.slice(before);
      assert.ok(!asked.includes("/index.html"), "the path leaving assets/ was never fetched");
      assert.ok(
        asked.every((request) => request.startsWith("/assets/levels/")),
        JSON.stringify(asked),
      );
    } finally {
      await t.close();
    }
  });

  it("a module that cannot swap a file binds no verb (Studio reloads the page instead)", async () => {
    const t = await booted(false);
    try {
      const bound = await t.page.evaluate(() => typeof (window as unknown as ReloadWindow).__studio.reloadAssets);
      assert.equal(bound, "undefined");
    } finally {
      await t.close();
    }
  });
});
