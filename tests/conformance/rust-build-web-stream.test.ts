/**
 * The web's lazy fetch (game systems STR-14b): the host's map writer puts each staged file in its
 * fetch group, and the shell fetches the streamed ones while playing.
 *
 * - The map rows: `webAssetMap` (`src/main/rust-build-web.ts`) writes a cell pack's `world.json`
 *   and terrain index in `sim` (a reset reads them), its cell bodies and terrain tiles in `stream`,
 *   and each named group's files (C-30, read from the package step's asset index) in `named` with
 *   the group's name. A streamed KTX2 lists its pieces as ranges: its head, then its levels smallest
 *   first. A game with none of these gets the entries it got before.
 * - The shell rows (Chromium, `STUDIO_BROWSER_TESTS=1`): a stand-in module plans the boot and sim
 *   files and wants streamed pieces from its frames. The shell preloads only the planned files
 *   before the first frame, fetches each wanted piece with a `Range` request (at most
 *   `ASSET_FETCHES` at once, a server that ignores `Range` sliced), hands the bytes over at the
 *   next frame, and refuses a piece that lands outside `assets/` on the page's origin (a
 *   cross-origin redirect) or is over the streamed fetch cap without admitting anything.
 *
 * The module's own rules (a ranged entry only in a streamed group, a reset reading a streamed file
 * refused `not-preloaded`) are genex-platform-web's (`tests/web_assets_v2.rs`).
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "@playwright/test";
import {
  type WebAssetMap,
  WebAssetGroup,
  WEB_ASSET_MAP_VERSION,
  WEB_FILES,
  WEB_STREAM_LIMITS,
  webAssetMap,
  webAssetMapLoad,
  webShellPage,
} from "../../src/main/rust-build-web.ts";
import { packageAssets } from "../../src/main/rust-package-assets.ts";
import { SECOND_MS } from "../../src/shared/duration.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { writeKtx2 } from "../../src/substrate/asset-import/ktx2-write.ts";
import { TextureCompression } from "../../src/substrate/asset-import/texture-table.ts";
import { fnv1a64Hex } from "../../src/substrate/native-game-port.ts";
import { playwrightHeadlessChromiumOnDisk } from "../helpers/playwright-chromium.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SHELL = path.join(REPO, "src", "game-template-rust", "web", "shell.html");
const PACK_FIXTURE = path.join(REPO, "tests", "fixtures", "stream", "cell-pack-v1.json");
const BOOT_TIMEOUT_MS = 30 * SECOND_MS;
/** The shell's fetches made at once (shell.html ASSET_FETCHES). */
const ASSET_FETCHES = 6;
/** The shell's status states (shell.html). Wire values. */
const ShellState = { Starting: "starting", Running: "running", Failed: "failed" } as const;
const DESKTOP_SCREEN = { width: 1920, height: 1080 };
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
};
/** A 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

interface PackFixture {
  world: string;
  cells: Array<{ file: string; hex: string }>;
}

/** The shared cell pack v1 fixture's files, under `folder`. */
async function packFiles(folder: string): Promise<Record<string, Uint8Array>> {
  const fixture = JSON.parse(await readFile(PACK_FIXTURE, "utf8")) as PackFixture;
  const files: Record<string, Uint8Array> = { [`${folder}/world.json`]: Buffer.from(fixture.world) };
  for (const cell of fixture.cells) files[`${folder}/${cell.file}`] = Buffer.from(cell.hex, "hex");
  return files;
}

/** A BC KTX2 of `side` texels with its full chain of levels, each filled with its level number. */
function chainKtx2(side: number): Uint8Array {
  const levels: Uint8Array[] = [];
  for (let px = side, level = 0; px >= 4; px >>= 1, level++)
    levels.push(new Uint8Array((px / 4) ** 2 * 16).fill(level));
  return writeKtx2({ compression: TextureCompression.Bc, srgb: true, side, levels });
}

/** Writes `files` (path → bytes) under `dir`. */
async function writeFiles(dir: string, files: Record<string, Uint8Array>): Promise<void> {
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), bytes);
  }
}

/** A staged `assets/` folder holding `files`, and its map. */
async function mapOf(files: Record<string, Uint8Array>): Promise<{ assets: string; map: WebAssetMap }> {
  const assets = path.join(await realpath(await tmpDir("rust-web-stream-")), "assets");
  await writeFiles(assets, files);
  return { assets, map: await webAssetMap(assets) };
}

/** `files` packaged for the web by the package step with `groups` (its index names them), and the map of the package. */
async function packagedMapOf(
  files: Record<string, Uint8Array>,
  groups: Array<{ name: string; paths: string[] }>,
): Promise<WebAssetMap> {
  const root = await realpath(await tmpDir("rust-web-stream-package-"));
  await writeFiles(path.join(root, "stage"), files);
  const to = path.join(root, "out", "assets");
  await packageAssets({ from: path.join(root, "stage"), to, target: BuildTarget.Web, groups });
  return webAssetMap(to);
}

/** The map's entries by path: `[group, name]` (group absent for the default). */
function groupsOf(map: WebAssetMap): Record<string, [string | undefined, string | undefined]> {
  return Object.fromEntries(map.files.map((entry) => [entry.path, [entry.group, entry.name]]));
}

describe("the web asset map puts each file in its fetch group (STR-14b)", () => {
  it("lists a pack's world.json and terrain index in sim, its cells and terrain tiles in stream", async () => {
    const files = {
      ...(await packFiles("world")),
      "world/terrain/terrain.json": Buffer.from('{"format":"genex-terrain-tiles"}'),
      "world/terrain/0_0.r16": new Uint8Array(32),
      "models/crate.glb": Buffer.from("glTF crate"),
    };
    const { map } = await mapOf(files);
    assert.equal(map.version, WEB_ASSET_MAP_VERSION);
    const groups = groupsOf(map);
    assert.deepEqual(groups["world/world.json"], [WebAssetGroup.Sim, undefined]);
    assert.deepEqual(groups["world/terrain/terrain.json"], [WebAssetGroup.Sim, undefined]);
    assert.deepEqual(groups["world/terrain/0_0.r16"], [WebAssetGroup.Stream, undefined]);
    const cells = map.files.filter((entry) => entry.path.startsWith("world/cells/"));
    assert.ok(cells.length >= 2, `cells ${cells.length}`);
    for (const cell of cells) {
      assert.equal(cell.group, WebAssetGroup.Stream, cell.path);
      assert.equal(cell.ranges, undefined, "a cell body is fetched whole");
    }
    assert.deepEqual(groups["models/crate.glb"], [undefined, undefined], "a file in no group is the v1 entry");
  });

  it("leaves a world.json that is not a cell pack's, and cells beside it, as plain entries", async () => {
    const { map } = await mapOf({
      "levels/world.json": Buffer.from('{"format":"my-own-level"}'),
      "levels/cells/0_0.cell": new Uint8Array(8),
      "elsewhere/cells/0_0.cell": new Uint8Array(8),
    });
    for (const entry of map.files) assert.equal(entry.group, undefined, entry.path);
  });

  it("puts each named group's files in its own group, a texture's family files with it", async () => {
    const map = await packagedMapOf(
      {
        "interiors/castle.glb": Buffer.from("glTF castle"),
        "interiors/rug.png": PNG,
        "interiors/rug.bc.ktx2": chainKtx2(512),
        "music/theme.ogg": Buffer.from("OggS theme"),
        "hero.png": PNG,
      },
      [
        { name: "castle", paths: ["interiors/**"] },
        { name: "audio", paths: ["music/*.ogg"] },
      ],
    );
    const groups = groupsOf(map);
    assert.deepEqual(groups["interiors/castle.glb"], [WebAssetGroup.Named, "castle"]);
    assert.deepEqual(groups["interiors/rug.png"], [WebAssetGroup.Named, "castle"]);
    assert.deepEqual(groups["interiors/rug.bc.ktx2"], [WebAssetGroup.Named, "castle"]);
    assert.deepEqual(groups["music/theme.ogg"], [WebAssetGroup.Named, "audio"]);
    assert.deepEqual(groups["hero.png"], [undefined, undefined]);
    assert.deepEqual(groups["genex-asset-index.json"], [undefined, undefined], "the index itself is preloaded");
  });

  it("names the first group (by name) for a file two groups list", async () => {
    const map = await packagedMapOf({ "props/barrel.glb": Buffer.from("glTF barrel") }, [
      { name: "town", paths: ["props/*"] },
      { name: "docks", paths: ["props/barrel.glb"] },
    ]);
    assert.deepEqual(groupsOf(map)["props/barrel.glb"], [WebAssetGroup.Named, "docks"]);
  });

  it("lists a streamed KTX2's head and then its levels smallest first, each with its own digest", async () => {
    const ktx2 = chainKtx2(256);
    const map = await packagedMapOf({ "interiors/rug.bc.ktx2": ktx2, "interiors/rug.png": PNG }, [
      { name: "castle", paths: ["interiors/**"] },
    ]);
    const entry = map.files.find((file) => file.path === "interiors/rug.bc.ktx2");
    const ranges = entry?.ranges ?? [];
    assert.ok(ranges.length >= 3, `ranges ${JSON.stringify(ranges)}`);
    assert.equal(ranges[0].offset, 0, "the head comes first");
    const levels = ranges.slice(1);
    for (let i = 1; i < levels.length; i++) assert.ok(levels[i].bytes > levels[i - 1].bytes, "smallest first");
    const sorted = [...ranges].sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i - 1].offset + sorted[i - 1].bytes <= sorted[i].offset);
    for (const range of ranges) {
      assert.ok(range.offset + range.bytes <= ktx2.length);
      assert.equal(range.fnv1a64, fnv1a64Hex(ktx2.subarray(range.offset, range.offset + range.bytes)));
    }
    assert.equal(levels.at(-1)?.bytes, (256 / 4) ** 2 * 16, "the largest level is last");
  });

  it("fetches a preloaded KTX2 whole (the module refuses ranges outside a streamed group)", async () => {
    const { map } = await mapOf({ "textures/rock.bc.ktx2": chainKtx2(512), "textures/rock.png": PNG });
    for (const entry of map.files) assert.equal(entry.ranges, undefined, entry.path);
  });

  it("writes a game without packs or named groups exactly as before: no group, name or ranges", async () => {
    const { map } = await mapOf({
      "models/crate.glb": Buffer.from("glTF crate"),
      "textures/rock.png": PNG,
      "textures/rock.bc.ktx2": chainKtx2(512),
      "sounds/hit.wav": Buffer.from("RIFF hit"),
    });
    for (const entry of map.files) {
      assert.deepEqual(
        Object.keys(entry).filter((key) => ["group", "name", "ranges"].includes(key)),
        [],
        entry.path,
      );
    }
  });

  const hostileIndexes: ReadonlyArray<{ name: string; index: string | null }> = [
    { name: "not JSON", index: "{ not json" },
    { name: "the wrong shape", index: '{"assets":{},"groups":"castle"}' },
    {
      name: "a group with no name",
      index: '{"assets":[{"path":"a.glb","files":[{"path":"a.glb"}]}],"groups":[{"assets":["a.glb"]}]}',
    },
    { name: "a link", index: null },
  ];
  for (const { name, index } of hostileIndexes) {
    it(`reads an asset index that is ${name} as naming no group, and still writes the map`, async () => {
      const assets = path.join(await realpath(await tmpDir("rust-web-stream-hostile-")), "assets");
      await writeFiles(assets, { "a.glb": Buffer.from("glTF a") });
      const index_ = path.join(assets, "genex-asset-index.json");
      if (index === null) {
        const outside = path.join(path.dirname(assets), "outside.json");
        await writeFile(
          outside,
          '{"assets":[{"path":"a.glb","files":[{"path":"a.glb"}]}],"groups":[{"name":"g","assets":["a.glb"]}]}',
        );
        await symlink(outside, index_);
      } else await writeFile(index_, index);
      const map = await webAssetMap(assets);
      assert.deepEqual(groupsOf(map)["a.glb"], [undefined, undefined]);
    });
  }

  it("measures the boot and sim bytes against 64 MiB and the largest streamed fetch against 64 MiB", async () => {
    const { map } = await mapOf({ ...(await packFiles("world")), "models/crate.glb": Buffer.from("glTF crate") });
    const load = webAssetMapLoad(map);
    const preloaded = map.files.filter((entry) => entry.group !== WebAssetGroup.Stream);
    assert.equal(
      load.preloadBytes,
      preloaded.reduce((sum, entry) => sum + entry.bytes, 0),
    );
    const cells = map.files.filter((entry) => entry.group === WebAssetGroup.Stream);
    assert.equal(load.largestFetchBytes, Math.max(...cells.map((entry) => entry.bytes)));
    assert.equal(load.withinLimits, true);
    assert.equal(WEB_STREAM_LIMITS.preloadBytes, 64 * 1024 * 1024);
    assert.equal(WEB_STREAM_LIMITS.fetchBytes, 64 * 1024 * 1024);
    const over = webAssetMapLoad({
      version: WEB_ASSET_MAP_VERSION,
      files: [
        {
          path: "big.cell",
          bytes: WEB_STREAM_LIMITS.fetchBytes + 1,
          fnv1a64: "0".repeat(16),
          group: WebAssetGroup.Stream,
        },
      ],
    });
    assert.equal(over.withinLimits, false);
  });
});

// ── the shell (Chromium) ──

const PLAYWRIGHT_CHROMIUM = playwrightHeadlessChromiumOnDisk();
const browserSkip = () => {
  if (process.env.STUDIO_BROWSER_TESTS !== "1") return "set STUDIO_BROWSER_TESTS=1 to run the shell rows";
  return PLAYWRIGHT_CHROMIUM ? false : "no Playwright Chromium on disk (nothing is downloaded)";
};

/** A stand-in adapter at core limits: the shell's preflight passes it. */
const STAND_IN_ADAPTER = `{
  const limits = new Proxy({}, { get: (_t, key) => (String(key).startsWith("min") ? 1 : 1e9) });
  const gpu = { requestAdapter: async () => ({ limits, features: new Set() }) };
  Object.defineProperty(Navigator.prototype, "gpu", { configurable: true, get: () => gpu });
}`;

/** One piece the stand-in wants: its path, offset and length, and from which frame on. */
type Want = readonly [string, number, number];

/**
 * A stand-in module that plans `plan`, wants `wants` from its `wantFrom`th frame on (all at once),
 * refuses the paths in `refuse`, and records every call: plan, preload, frame, wanted, arrived
 * (with the bytes' FNV-1a 64).
 */
function streamingModule(
  plan: ReadonlyArray<readonly [string, number]>,
  wants: readonly Want[],
  refuse: readonly string[] = [],
): string {
  return [
    "window.__assetLog = [];",
    "const log = (...entry) => window.__assetLog.push(entry);",
    "let frames = 0; let wanted = false;",
    `const WANTS = ${JSON.stringify(wants)};`,
    `const REFUSE = new Set(${JSON.stringify(refuse)});`,
    "const fnv = (bytes) => { let h = 0xcbf29ce484222325n; for (const b of bytes) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; } return h.toString(16).padStart(16, '0'); };",
    "export default async function init() {}",
    'export function studio_saves_database() { return "genex-shell-stream-test"; }',
    "export function studio_saves_preload() {}",
    "export function studio_saves_unavailable() {}",
    'export function studio_saves_status() { return "{}"; }',
    "export function studio_saves_pending() { return 0; }",
    "export function studio_saves_take() { return []; }",
    "export function studio_saves_flushed() {}",
    `export function studio_assets_plan() { log("plan"); return ${JSON.stringify(plan)}; }`,
    'export function studio_assets_preload(name) { log("preload", name); }',
    "export function studio_assets_wanted() { if (frames < 1 || wanted) return []; wanted = true; log('wanted'); return WANTS.map((w) => [...w]); }",
    "export function studio_assets_arrived(name, offset, bytes) { log('arrived', name, offset, bytes.length, fnv(bytes), frames); if (REFUSE.has(name)) throw new Error('asset-digest-mismatch: ' + name); }",
    'export async function studio_boot() { log("boot"); return JSON.stringify({ ok: true, receipt: {}, world: [64, 64] }); }',
    "export function studio_call(op) { return JSON.stringify({ id: null, ok: true, op, result: {} }); }",
    "export function studio_frame() { frames += 1; log('frame', frames); return 0; }",
    "",
  ].join("\n");
}

/** One request the server saw: its path, its `Range` header, and how many of its requests were open with it. */
interface Seen {
  path: string;
  range: string | null;
  open: number;
}

interface ServeOptions {
  /** Answer `Range` requests whole (200), as a server that ignores the header. */
  ignoreRange?: boolean;
  /** Paths answered with a redirect to this origin's same path. */
  redirect?: { paths: readonly string[]; to: string };
  /** Hold each asset response this long, to see how many are open at once. */
  holdMs?: number;
}

/** A static server over `root` that honours single `Range` requests and records each request. */
async function serve(
  root: string,
  options: ServeOptions = {},
): Promise<{ origin: string; seen: Seen[]; close: () => void }> {
  const seen: Seen[] = [];
  let open = 0;
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    const range = typeof req.headers.range === "string" ? req.headers.range : null;
    open += 1;
    seen.push({ path: pathname, range, open });
    try {
      if (options.redirect?.paths.includes(pathname)) {
        res.writeHead(302, { location: `${options.redirect.to}${pathname}`, "cache-control": "no-store" }).end();
        return;
      }
      if (options.holdMs && pathname.startsWith("/assets/"))
        await new Promise((held) => setTimeout(held, options.holdMs));
      const file = path.join(root, path.normalize(pathname));
      const body = file.startsWith(`${root}${path.sep}`) ? await readFile(file).catch(() => null) : null;
      if (!body) {
        res.writeHead(404).end();
        return;
      }
      const type = CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream";
      const parsed = range && !options.ignoreRange ? /^bytes=(\d+)-(\d+)$/.exec(range) : null;
      if (parsed) {
        const [start, end] = [Number(parsed[1]), Math.min(Number(parsed[2]), body.length - 1)];
        res.writeHead(206, {
          "content-type": type,
          "content-range": `bytes ${start}-${end}/${body.length}`,
          // A cross-origin server that allows the page: only the shell's own check refuses its bytes.
          "access-control-allow-origin": "*",
          "cache-control": "no-store",
        });
        res.end(body.subarray(start, end + 1));
        return;
      }
      res
        .writeHead(200, { "content-type": type, "cache-control": "no-store", "access-control-allow-origin": "*" })
        .end(body);
    } finally {
      open -= 1;
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, seen, close: () => server.close() };
}

/** A served game folder: the shell, the stand-in `module` and the staged `files`. */
async function gameFolder(files: Record<string, Uint8Array>, module: string): Promise<string> {
  const root = await realpath(await tmpDir("rust-web-stream-page-"));
  await writeFile(path.join(root, WEB_FILES.page), webShellPage(await readFile(SHELL, "utf8"), "Stream"));
  await writeFile(path.join(root, WEB_FILES.module), module);
  await writeFiles(path.join(root, WEB_FILES.assets), files);
  await writeFile(
    path.join(root, WEB_FILES.assetMap),
    JSON.stringify(await webAssetMap(path.join(root, WEB_FILES.assets))),
  );
  return root;
}

type LogEntry = [string, ...unknown[]];

interface StreamWindow {
  GenexShell: { status: { state: string; code: string | null; reason: string | null } };
  __assetLog?: LogEntry[];
}

/** Opens the page and waits until `done` holds over the stand-in's log (or the shell failed); the status and log. */
async function runUntil(page: Page, origin: string, done: string) {
  await page.goto(`${origin}/index.html?paused`);
  await page.waitForFunction(
    ([body, failed]) => {
      const shell = window as unknown as StreamWindow;
      if (shell.GenexShell?.status.state === failed) return true;
      return new Function("log", body)(shell.__assetLog ?? []);
    },
    [done, ShellState.Failed] as const,
    { timeout: BOOT_TIMEOUT_MS },
  );
  return page.evaluate(() => {
    const shell = window as unknown as StreamWindow;
    return { status: shell.GenexShell.status, log: shell.__assetLog ?? [] };
  });
}

/** The arrivals in a log: path, offset, length, FNV-1a 64, and the frame count when handed over. */
const arrivals = (log: LogEntry[]) =>
  log
    .filter((entry) => entry[0] === "arrived")
    .map(([, name, offset, length, fnv, frame]) => ({ name, offset, length, fnv, frame }));

describe("the Rust web shell fetches streamed pieces while playing (STR-14b)", { skip: browserSkip() }, () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  /** Serves `root` with `options` and runs its page on the stand-in adapter until `done`. */
  async function load(root: string, done: string, options: ServeOptions = {}, consoleLines: string[] = []) {
    const served = await serve(root, options);
    const context = await browser.newContext({ screen: DESKTOP_SCREEN });
    try {
      const page = await context.newPage();
      page.on("console", (message) => consoleLines.push(message.text()));
      await page.addInitScript(STAND_IN_ADAPTER);
      const result = await runUntil(page, served.origin, done);
      return { ...result, seen: served.seen.filter((request) => request.path.startsWith("/assets/")) };
    } finally {
      await context.close();
      served.close();
    }
  }

  it("needs only the boot and sim files before the first frame, then fetches a cell by Range", async () => {
    const files: Record<string, Uint8Array> = {
      ...(await packFiles("world")),
      "models/crate.glb": Buffer.from("glTF crate"),
    };
    const { map } = await mapOf(files);
    const preload = map.files
      .filter((entry) => entry.group !== WebAssetGroup.Stream)
      .map((e) => [e.path, e.bytes] as const);
    const cell = map.files.find((entry) => entry.group === WebAssetGroup.Stream);
    assert.ok(cell);
    const root = await gameFolder(files, streamingModule(preload, [[cell.path, 0, cell.bytes]]));
    const seen = await load(root, "return log.some((e) => e[0] === 'arrived');");
    assert.equal(seen.status.state, ShellState.Running, JSON.stringify(seen.status));
    const firstFrame = seen.log.findIndex((entry) => entry[0] === "frame");
    const preloaded = seen.log
      .slice(0, firstFrame)
      .filter((entry) => entry[0] === "preload")
      .map((entry) => entry[1]);
    assert.deepEqual(
      preloaded.sort(),
      preload.map(([name]) => name).sort(),
      "frame 1 needs the boot and sim files only",
    );
    assert.ok(!seen.log.slice(0, firstFrame).some((entry) => entry[0] === "arrived"));
    const cellRequests = seen.seen.filter((request) => request.path === `/assets/${cell.path}`);
    assert.deepEqual(
      cellRequests.map((request) => request.range),
      [`bytes=0-${cell.bytes - 1}`],
      "the cell arrives by one Range request",
    );
    const bytes = files[cell.path];
    assert.deepEqual(
      arrivals(seen.log).map(({ name, offset, length, fnv }) => ({ name, offset, length, fnv })),
      [{ name: cell.path, offset: 0, length: bytes.length, fnv: fnv1a64Hex(bytes) }],
    );
  });

  it("fetches a KTX2's level by its range, and slices it from a server that ignores Range", async () => {
    const ktx2 = chainKtx2(256);
    const files = { "interiors/rug.bc.ktx2": ktx2 };
    const level = { offset: ktx2.length - (256 / 4) ** 2 * 16, bytes: (256 / 4) ** 2 * 16 };
    const want: Want = ["interiors/rug.bc.ktx2", level.offset, level.bytes];
    const slice = ktx2.subarray(level.offset, level.offset + level.bytes);
    for (const ignoreRange of [false, true]) {
      const root = await gameFolder(files, streamingModule([], [want]));
      const seen = await load(root, "return log.some((e) => e[0] === 'arrived');", { ignoreRange });
      assert.equal(seen.status.state, ShellState.Running, JSON.stringify(seen.status));
      assert.deepEqual(
        seen.seen.map((request) => request.range),
        [`bytes=${level.offset}-${level.offset + level.bytes - 1}`],
      );
      const [arrived] = arrivals(seen.log);
      assert.deepEqual(
        { offset: arrived?.offset, length: arrived?.length, fnv: arrived?.fnv },
        { offset: level.offset, length: level.bytes, fnv: fnv1a64Hex(slice) },
        ignoreRange ? "sliced from the whole body" : "the 206 body",
      );
    }
  });

  it("keeps at most ASSET_FETCHES fetches open at once", async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 20; i++) files[`cells/${i}.bin`] = new Uint8Array(64).fill(i);
    const wants: Want[] = Object.keys(files).map((name) => [name, 0, 64]);
    const root = await gameFolder(files, streamingModule([], wants));
    const seen = await load(root, "return log.filter((e) => e[0] === 'arrived').length === 20;", { holdMs: 60 });
    assert.equal(arrivals(seen.log).length, 20);
    const most = Math.max(...seen.seen.map((request) => request.open));
    assert.ok(most <= ASSET_FETCHES, `${most} open at once`);
    assert.ok(most > 1, "fetches run in parallel");
  });

  it("refuses a piece redirected to another origin, admitting nothing, and keeps the game running", async () => {
    const files = { "cells/a.cell": new Uint8Array(16).fill(7), "cells/b.cell": new Uint8Array(16).fill(8) };
    const other = await serve(await gameFolder(files, streamingModule([], [])));
    try {
      const lines: string[] = [];
      const root = await gameFolder(
        files,
        streamingModule(
          [],
          [
            ["cells/a.cell", 0, 16],
            ["cells/b.cell", 0, 16],
          ],
        ),
      );
      const seen = await load(
        root,
        "return log.some((e) => e[0] === 'arrived') && log.filter((e) => e[0] === 'frame').length > 30;",
        { redirect: { paths: ["/assets/cells/a.cell"], to: other.origin } },
        lines,
      );
      assert.equal(seen.status.state, ShellState.Running, JSON.stringify(seen.status));
      assert.deepEqual(
        arrivals(seen.log).map((arrival) => arrival.name),
        ["cells/b.cell"],
        "only the piece on the page's origin",
      );
      assert.ok(
        lines.some((line) => line.includes("asset-outside") && line.includes("cells/a.cell")),
        lines.join("\n"),
      );
    } finally {
      other.close();
    }
  });

  it("stops the boot when a planned file is redirected to another origin, and never preloads it", async () => {
    const files = { "models/crate.glb": Buffer.from("glTF crate") };
    const other = await serve(await gameFolder(files, streamingModule([], [])));
    try {
      const root = await gameFolder(files, streamingModule([["models/crate.glb", 10]], []));
      const seen = await load(root, "return false;", {
        redirect: { paths: ["/assets/models/crate.glb"], to: other.origin },
      });
      assert.equal(seen.status.state, ShellState.Failed);
      assert.match(String(seen.status.reason), /asset-outside/);
      assert.ok(!seen.log.some((entry) => entry[0] === "preload"));
    } finally {
      other.close();
    }
  });

  it("never fetches a piece over the streamed fetch cap, and keeps going after a refused piece", async () => {
    const files = { "cells/ok.cell": new Uint8Array(16).fill(1), "cells/bad.cell": new Uint8Array(16).fill(2) };
    const lines: string[] = [];
    const wants: Want[] = [
      ["cells/huge.cell", 0, WEB_STREAM_LIMITS.fetchBytes + 1],
      ["cells/bad.cell", 0, 16],
      ["cells/ok.cell", 0, 16],
    ];
    const root = await gameFolder(files, streamingModule([], wants, ["cells/bad.cell"]));
    const seen = await load(
      root,
      "return log.filter((e) => e[0] === 'arrived').length === 2 && log.filter((e) => e[0] === 'frame').length > 30;",
      {},
      lines,
    );
    assert.equal(seen.status.state, ShellState.Running, JSON.stringify(seen.status));
    assert.ok(!seen.seen.some((request) => request.path.includes("huge")), "the oversized piece is never requested");
    assert.ok(
      lines.some((line) => line.includes("asset-too-large") && line.includes("cells/huge.cell")),
      lines.join("\n"),
    );
    assert.ok(
      lines.some((line) => line.includes("asset-digest-mismatch")),
      "the module's refusal is logged",
    );
    assert.deepEqual(
      arrivals(seen.log)
        .map((arrival) => arrival.name)
        .sort(),
      ["cells/bad.cell", "cells/ok.cell"],
    );
  });
});
