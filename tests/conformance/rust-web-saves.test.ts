/**
 * The Rust web shell's saves store (`src/game-template-rust/web/shell.html`): the IndexedDB side
 * of the module's in-memory saves mirror.
 *
 * - The game's database is at version 2: the `files` store keeps each saved file's bytes and the
 *   `sizes` store its byte length under the same name. A version-1 database (files only) upgrades
 *   in its one upgrade transaction, with every file kept and its size recorded.
 * - A module that keeps slot bodies lazily (it exports `studio_saves_index`) is preloaded with every
 *   file but the `.sav` ones, which it gets by name and size only; the shell then fetches a body
 *   only when the module asks for it (`studio_saves_requests` → `studio_saves_provide`). A module
 *   without that export is preloaded with every file, as before.
 * - A flush writes each file's bytes and size in one transaction and deletes removed files from
 *   both stores.
 * - The shell asks for persistent storage and tells the module whether it got it; a refused or
 *   rejected request is `false`.
 * - When the page is hidden or left, the module writes its suspend autosave
 *   (`studio_suspend_save`) once, before the flush that writes it.
 *
 * No Rust toolchain: the game's `game.js` is a stand-in written here that records every saves call,
 * and the preflight sees a stand-in adapter at WebGPU's core limits. Launches Playwright's headless
 * Chromium only with `STUDIO_BROWSER_TESTS=1` and a Chromium already installed; nothing is
 * downloaded.
 */
import assert from "node:assert/strict";
import { lstat, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "@playwright/test";
import { webShellPage } from "../../src/main/rust-build-web.ts";
import { SECOND_MS } from "../../src/shared/duration.ts";
import { playwrightHeadlessChromiumOnDisk } from "../helpers/playwright-chromium.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SHELL = path.join(REPO, "src", "game-template-rust", "web", "shell.html");
const BOOT_TIMEOUT_MS = 20 * SECOND_MS;
const CALL_TIMEOUT_MS = 5 * SECOND_MS;
/** The database the stand-in module names, as genex-platform-web's `genex-saves:<game>`. */
const DATABASE = "genex-saves:saves-test";
/** The shell's status states (shell.html). Wire values. */
const ShellState = { Starting: "starting", Running: "running" } as const;
/** The shell's IndexedDB layout (shell.html): its stores and the version that has both. */
const Store = { Files: "files", Sizes: "sizes" } as const;
const DATABASE_VERSION = 2;
const CONTENT_TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript" };

/** A WebGPU adapter at core limits (every maximum huge, every alignment 1), so the preflight passes. */
const CORE_ADAPTER = `{
  const limits = new Proxy({}, { get: (_t, key) => (String(key).startsWith("min") ? 1 : 1e9) });
  const gpu = { requestAdapter: async () => ({ limits }) };
  Object.defineProperty(Navigator.prototype, "gpu", { configurable: true, get: () => gpu });
}`;

/** `navigator.storage.persist()` rejects (as a browser that refuses the permission may). */
const PERSIST_REJECTS = `{
  StorageManager.prototype.persisted = async () => false;
  StorageManager.prototype.persist = () => Promise.reject(new DOMException("refused", "NotAllowedError"));
}`;
/** `navigator.storage.persist()` grants it. */
const PERSIST_GRANTS = `{
  StorageManager.prototype.persisted = async () => false;
  StorageManager.prototype.persist = async () => true;
}`;

/** The files a version-1 database holds before the shell opens it: a slot body, its sidecar and a settings file. */
const SEEDED: ReadonlyArray<readonly [string, readonly number[]]> = [
  ["genex-settings.json", [123, 125]],
  ["slots/one.meta.json", [123, 34, 116, 34, 125]],
  ["slots/one.sav", [1, 2, 3, 4, 5, 6, 7, 8, 9]],
];

const browserSkip = (): string | false => {
  if (process.env.STUDIO_BROWSER_TESTS !== "1") return "launches Chromium; set STUDIO_BROWSER_TESTS=1 to run";
  return playwrightHeadlessChromiumOnDisk()
    ? false
    : "no Playwright Chromium is installed; this suite never downloads one";
};

/**
 * A stand-in for the game's module that records the saves calls the shell makes, in order, in
 * `window.__saves.log`. `lazy` adds the exports of a module that keeps slot bodies lazily. The test
 * queues what the next take, removal or request answers in `window.__saves`.
 */
function savesModule(lazy: boolean): string {
  const lazyExports = [
    'export function studio_saves_index(index) { log("index", index.map(([name, size]) => [name, size])); }',
    "export function studio_saves_requests() { const asked = saves.requests; saves.requests = []; return asked; }",
    'export function studio_saves_provide(name, bytes) { log("provide", name, bytes ? Array.from(bytes) : null); }',
    'export function studio_saves_persistent(persistent) { log("persistent", persistent); }',
    'export function studio_suspend_save() { log("suspend"); }',
    "export function studio_saves_take_removed() { const removed = saves.removed; saves.removed = []; return removed; }",
  ];
  return [
    "const saves = { log: [], take: [], removed: [], requests: [] };",
    "window.__saves = saves;",
    "const log = (...entry) => saves.log.push(entry);",
    "export default async function init() {}",
    `export function studio_saves_database() { return ${JSON.stringify(DATABASE)}; }`,
    'export function studio_saves_preload(entries) { log("preload", entries.map(([name, bytes]) => [name, Array.from(bytes)])); }',
    'export function studio_saves_unavailable() { log("unavailable"); }',
    'export function studio_saves_status() { return "{}"; }',
    "export function studio_saves_pending() { return saves.take.length; }",
    'export function studio_saves_take() { log("take"); const taken = saves.take; saves.take = []; return taken; }',
    'export function studio_saves_flushed(error, names) { log("flushed", error ?? null, names); }',
    ...(lazy ? lazyExports : []),
    'export async function studio_boot() { log("boot"); return JSON.stringify({ ok: true, receipt: {}, world: [64, 64] }); }',
    "export function studio_call(op) { return JSON.stringify({ id: null, ok: true, op, result: {} }); }",
    "export function studio_frame() { return 0; }",
    "",
  ].join("\n");
}

type SavesLog = Array<[string, ...unknown[]]>;

interface ShellWindow {
  GenexShell: { status: { state: string }; flushSaves(): Promise<void> };
  __saves: {
    log: SavesLog;
    take: Array<[string, Uint8Array]>;
    removed: string[];
    requests: string[];
  };
}

/** A static server over `root`: any regular file under it (never through a link), 404 otherwise. */
async function serve(root: string): Promise<{ origin: string; close: () => void }> {
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    const file = path.join(root, path.normalize(pathname));
    const found = await lstat(file).catch(() => null);
    const body = file.startsWith(`${root}${path.sep}`) && found?.isFile() ? await readFile(file) : null;
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

/** Create the game's database at version 1 (the `files` store only) holding `entries`. */
async function seedVersionOne(page: Page, entries: ReadonlyArray<readonly [string, readonly number[]]>) {
  await page.evaluate(
    async ({ name, store, entries }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(store);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(store, "readwrite");
        for (const [key, bytes] of entries) transaction.objectStore(store).put(new Uint8Array(bytes), key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();
    },
    { name: DATABASE, store: Store.Files, entries },
  );
}

/** The database as the page sees it now: its version and both stores, `{name: [bytes]}` and `{name: size}`. */
async function readDatabase(page: Page) {
  return page.evaluate(
    async ({ name, stores }) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const all = (store: string) =>
        new Promise<Array<[string, unknown]>>((resolve, reject) => {
          if (!db.objectStoreNames.contains(store)) return resolve([]);
          const source = db.transaction(store, "readonly").objectStore(store);
          const keys = source.getAllKeys();
          const values = source.getAll();
          values.onsuccess = () => resolve(keys.result.map((key, i) => [String(key), values.result[i]]));
          values.onerror = () => reject(values.error);
        });
      const files = Object.fromEntries(
        (await all(stores.Files)).map(([key, bytes]) => [key, Array.from(bytes as Uint8Array)]),
      );
      const sizes = Object.fromEntries(await all(stores.Sizes));
      const version = db.version;
      db.close();
      return { version, files, sizes };
    },
    { name: DATABASE, stores: Store },
  );
}

/** A page of the served shell, booted to running with the stand-in module; `seed` first fills a version-1 database. */
async function bootShell(browser: Browser, options: { lazy: boolean; seed?: boolean; initScript?: string }) {
  const root = await tmpDir("rust-web-saves-");
  await writeFile(path.join(root, "index.html"), webShellPage(await readFile(SHELL, "utf8"), "Saves"));
  await writeFile(path.join(root, "seed.html"), "<!doctype html><title>seed</title>");
  await writeFile(path.join(root, "game.js"), savesModule(options.lazy));
  const served = await serve(root);
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript(CORE_ADAPTER);
  if (options.initScript) await page.addInitScript(options.initScript);
  if (options.seed) {
    await page.goto(`${served.origin}/seed.html`);
    await seedVersionOne(page, SEEDED);
  }
  await page.goto(`${served.origin}/index.html?paused`);
  await page.waitForFunction(
    (running) => (window as unknown as ShellWindow).GenexShell?.status.state === running,
    ShellState.Running,
    { timeout: BOOT_TIMEOUT_MS },
  );
  const close = async () => {
    await context.close();
    served.close();
  };
  return { page, close };
}

const savesLog = (page: Page) => page.evaluate(() => (window as unknown as ShellWindow).__saves.log);

/** Wait until the module's log has an entry named `what`, and answer the log. */
async function logWith(page: Page, what: string): Promise<SavesLog> {
  await page.waitForFunction(
    (name) => (window as unknown as ShellWindow).__saves.log.some(([entry]) => entry === name),
    what,
    { timeout: CALL_TIMEOUT_MS },
  );
  return savesLog(page);
}

const named = (log: SavesLog, what: string) => log.filter(([entry]) => entry === what);

/** One headless Chromium for the suite it is called in, launched before its rows and closed after. */
function suiteBrowser(): () => Browser {
  let browser: Browser | undefined;
  before(async () => {
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });
  return () => {
    assert.ok(browser, "the suite's browser is launched");
    return browser;
  };
}

describe("the Rust web shell's saves database", { skip: browserSkip() }, () => {
  const launched = suiteBrowser();

  it("upgrades a version-1 database to version 2: every file kept, each with its size", async () => {
    const shell = await bootShell(launched(), { lazy: true, seed: true });
    try {
      const database = await readDatabase(shell.page);
      assert.equal(database.version, DATABASE_VERSION);
      assert.deepEqual(database.files, Object.fromEntries(SEEDED.map(([name, bytes]) => [name, [...bytes]])));
      assert.deepEqual(database.sizes, Object.fromEntries(SEEDED.map(([name, bytes]) => [name, bytes.length])));
    } finally {
      await shell.close();
    }
  });

  it("preloads every file but the .sav ones, which the module gets by name and size only", async () => {
    const shell = await bootShell(launched(), { lazy: true, seed: true });
    try {
      const log = await savesLog(shell.page);
      const kept = SEEDED.filter(([name]) => !name.endsWith(".sav")).map(([name, bytes]) => [name, [...bytes]]);
      assert.deepEqual(named(log, "preload"), [["preload", kept]]);
      assert.deepEqual(named(log, "index"), [["index", [["slots/one.sav", 9]]]]);
      const order = log.map(([entry]) => entry).filter((entry) => ["preload", "index", "boot"].includes(entry));
      assert.deepEqual(order, ["preload", "index", "boot"], "the index is in before the first reset");
    } finally {
      await shell.close();
    }
  });

  it("preloads every file, .sav included, for a module without the lazy index", async () => {
    const shell = await bootShell(launched(), { lazy: false, seed: true });
    try {
      const log = await savesLog(shell.page);
      assert.deepEqual(named(log, "preload"), [["preload", SEEDED.map(([name, bytes]) => [name, [...bytes]])]]);
    } finally {
      await shell.close();
    }
  });

  it("fetches a lazy body only when the module asks, and answers a body it does not keep with none", async () => {
    const shell = await bootShell(launched(), { lazy: true, seed: true });
    try {
      assert.deepEqual(named(await savesLog(shell.page), "provide"), [], "nothing is fetched unasked");
      await shell.page.evaluate(() => {
        (window as unknown as ShellWindow).__saves.requests = ["slots/one.sav", "slots/gone.sav"];
      });
      await shell.page.waitForFunction(
        () => (window as unknown as ShellWindow).__saves.log.filter(([entry]) => entry === "provide").length === 2,
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      );
      const provided = named(await savesLog(shell.page), "provide");
      assert.deepEqual(provided, [
        ["provide", "slots/one.sav", [1, 2, 3, 4, 5, 6, 7, 8, 9]],
        ["provide", "slots/gone.sav", null],
      ]);
    } finally {
      await shell.close();
    }
  });

  it("writes a file's bytes and size together, and deletes a removed file from both stores", async () => {
    const shell = await bootShell(launched(), { lazy: true, seed: true });
    try {
      await shell.page.evaluate(async () => {
        const saves = (window as unknown as ShellWindow).__saves;
        saves.take = [["slots/two.sav", new Uint8Array([7, 7, 7, 7])]];
        saves.removed = ["slots/one.sav", "slots/one.meta.json"];
        await (window as unknown as ShellWindow).GenexShell.flushSaves();
      });
      const database = await readDatabase(shell.page);
      assert.deepEqual(database.files, { "genex-settings.json": [123, 125], "slots/two.sav": [7, 7, 7, 7] });
      assert.deepEqual(database.sizes, { "genex-settings.json": 2, "slots/two.sav": 4 });
      assert.deepEqual(named(await savesLog(shell.page), "flushed"), [["flushed", null, ["slots/two.sav"]]]);
    } finally {
      await shell.close();
    }
  });
});

describe("the Rust web shell's saves through the page's lifecycle", { skip: browserSkip() }, () => {
  const launched = suiteBrowser();

  it("pagehide has the module write its suspend autosave, then flushes it", async () => {
    const shell = await bootShell(launched(), { lazy: true });
    try {
      await shell.page.evaluate(() => {
        (window as unknown as ShellWindow).__saves.take = [["autosave/0.sav", new Uint8Array([1])]];
        window.dispatchEvent(new PageTransitionEvent("pagehide"));
      });
      const log = await logWith(shell.page, "flushed");
      const order = log.map(([entry]) => entry).filter((entry) => ["suspend", "take", "flushed"].includes(entry));
      assert.deepEqual(order, ["suspend", "take", "flushed"]);
    } finally {
      await shell.close();
    }
  });

  it("a page hidden and then left writes one suspend autosave, and another after it is shown again", async () => {
    const shell = await bootShell(launched(), { lazy: true });
    try {
      await shell.page.evaluate(() => {
        let visibility = "hidden";
        Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new PageTransitionEvent("pagehide"));
        visibility = "visible";
        document.dispatchEvent(new Event("visibilitychange"));
        visibility = "hidden";
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await logWith(shell.page, "suspend");
      assert.equal(named(await savesLog(shell.page), "suspend").length, 2);
    } finally {
      await shell.close();
    }
  });

  it("a rejected persist() reports persistent false", async () => {
    const shell = await bootShell(launched(), { lazy: true, initScript: PERSIST_REJECTS });
    try {
      assert.deepEqual(named(await logWith(shell.page, "persistent"), "persistent"), [["persistent", false]]);
    } finally {
      await shell.close();
    }
  });

  it("a granted persist() reports persistent true", async () => {
    const shell = await bootShell(launched(), { lazy: true, initScript: PERSIST_GRANTS });
    try {
      assert.deepEqual(named(await logWith(shell.page, "persistent"), "persistent"), [["persistent", true]]);
    } finally {
      await shell.close();
    }
  });
});
