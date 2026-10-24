/**
 * A real streamed world on the web (gate GR's web streaming row): genex-platform-web's
 * `web_stream` example, a genex game built for wasm32 with the pinned toolchain and packaged by
 * `packageWeb` with the real tools, played in Playwright's headless Chromium through the template
 * shell (only with `STUDIO_BROWSER_TESTS=1` and a Chromium already installed; nothing is
 * downloaded). Beside the page: a cell pack (`valley/`, cells (0, 0) and (10, 0) with a terrain
 * tile each) and a named group (`interior`), put in their fetch groups by `writeWebAssetMap`.
 *
 * The row proves the module asks for what the game streams while playing: the start cell's body
 * and tile and the required group arrive (the group's hold ends and the game reads its level
 * file on the tick a native run does), the far cell is not fetched until the player teleports,
 * then arrives by `Range` and reaches the sim's reads (`state().volatile.webStream.cells`, and a
 * reseed's `gfx.assets().info` of its body), and the start cell is dropped. The module's own rules
 * are genex-platform-web's `tests/web_streaming.rs`.
 *
 * Not measured here: a game that reads a cell's body while playing (no facade call does; a game
 * reads its pack from its compiled table or a named group), throughput or memory under a large
 * world, Safari and Firefox.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type Browser, chromium, type Page } from "@playwright/test";
import {
  packageWeb,
  type WebAssetMap,
  WebAssetGroup,
  WEB_FILES,
  type WebRun,
  writeWebAssetMap,
} from "../../src/main/rust-build-web.ts";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import {
  CELL_PACK_FORMAT,
  CELL_PACK_VERSION,
  CELL_PACK_WORLD_FILE,
  TERRAIN_TILES_DIR,
  TERRAIN_TILES_FILE,
  TERRAIN_TILES_FORMAT,
  TERRAIN_TILES_VERSION,
} from "../../src/shared/world-cells.ts";
import { fnv1a64Hex } from "../../src/substrate/native-game-port.ts";
import { playwrightHeadlessChromiumOnDisk } from "../helpers/playwright-chromium.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SHELL = path.join(REPO, "src", "game-template-rust", "web", "shell.html");
const PACK_FIXTURE = path.join(REPO, "tests", "fixtures", "stream", "cell-pack-v1.json");
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");
const TOOLCHAIN = process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev", "spike-toolchain");
const CARGO = path.join(TOOLCHAIN, "sysroot", "bin", "cargo");
const WASM_BINDGEN = path.join(TOOLCHAIN, "tools", "bin", "wasm-bindgen");
const WASM_OPT = path.join(TOOLCHAIN, "tools", "binaryen", "bin", "wasm-opt");
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? path.join(REPO, ".studio-dev", "cargo-target");
const WASM = path.join(TARGET_DIR, "wasm32-unknown-unknown", "release", "examples", "web_stream.wasm");
/** A cold build compiles wgpu, Rapier, egui and kira for wasm32. */
const BUILD_TIMEOUT_MS = 30 * MINUTE_MS;
const RUN_TIMEOUT_MS = 3 * MINUTE_MS;
const BOOT_TIMEOUT_MS = 60 * SECOND_MS;
/** How long a streamed file may take to arrive while the page plays. */
const ARRIVAL_TIMEOUT_MS = 20 * SECOND_MS;
const OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
/** The sample's teleport key and its named group's level file (examples/web_stream.rs). */
const TELEPORT_KEY = "KeyT";
const ROOM = { doors: 2 };
/** The tick the sample requires its group on, and the ticks a group takes to be ready (genex's STREAM_GROUP_PREFETCH_TICKS). */
const REQUIRE_TICK = 2;
const GROUP_PREFETCH_TICKS = 2;
/** The staged pack's folder under `assets/`. */
const PACK = "valley";
/** The streamed files of the start cell and of the far one. */
const HOME = { cell: [0, 0], body: "valley/cells/0_0.cell", tile: "valley/terrain/0_0.r16" } as const;
const FAR = { cell: [10, 0], body: "valley/cells/10_0.cell", tile: "valley/terrain/10_0.r16" } as const;
/** A 65-sample tile's `.r16` bytes. */
const TILE_BYTES = 65 * 65 * 2;
/** The shell's status states (shell.html). Wire values. */
const ShellState = { Starting: "starting", Running: "running" } as const;
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

/** One request the server answered: the page-relative path and its `Range` header. */
interface Served {
  path: string;
  range: string | null;
}

interface Site {
  origin: string;
  requests: Served[];
  close: () => void;
}

/** The byte range a `Range: bytes=a-b` header names inside a file of `size` bytes, or null. */
function rangeOf(header: string | undefined, size: number): [number, number] | null {
  const match = /^bytes=(\d+)-(\d+)$/.exec(header ?? "");
  if (!match) return null;
  const [start, end] = [Number(match[1]), Number(match[2])];
  return start <= end && end < size ? [start, end] : null;
}

/** A static server over one packaged folder that answers `Range` with 206 and logs every request. */
async function serve(root: string): Promise<Site> {
  const requests: Served[] = [];
  const server = http.createServer(async (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
    const file = path.join(root, path.normalize(pathname));
    const stat = await lstat(file).catch(() => null);
    requests.push({ path: pathname.replace(/^\//, ""), range: req.headers.range ?? null });
    if (!file.startsWith(`${root}${path.sep}`) || !stat?.isFile()) {
      res.writeHead(404).end();
      return;
    }
    const type = CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream";
    const bytes = await readFile(file);
    const range = rangeOf(req.headers.range, bytes.length);
    if (range) {
      const [start, end] = range;
      res.writeHead(206, {
        "content-type": type,
        "content-range": `bytes ${start}-${end}/${bytes.length}`,
        "cache-control": "no-store",
      });
      res.end(bytes.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(bytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, requests, close: () => server.close() };
}

interface PackFixture {
  cells: Array<{ file: string; hex: string }>;
}

/** The staged assets: the pack (two cells, a tile each), the named group and the package step's index. */
async function stageAssets(assets: string): Promise<Record<string, Uint8Array>> {
  const fixture = JSON.parse(await readFile(PACK_FIXTURE, "utf8")) as PackFixture;
  const body = (file: string) => Buffer.from(fixture.cells.find((cell) => cell.file === file)?.hex ?? "", "hex");
  const bodies = { [HOME.body]: body("cells/0_0.cell"), [FAR.body]: body("cells/-1_0.cell") };
  const tile = (salt: number) => Buffer.from(Array.from({ length: TILE_BYTES }, (_, at) => (at * 7 + salt) % 256));
  const row = (cell: readonly number[], bytes: Uint8Array) => ({
    x: cell[0],
    z: cell[1],
    bytes: bytes.length,
    fnv: fnv1a64Hex(bytes),
  });
  const world = {
    format: CELL_PACK_FORMAT,
    version: CELL_PACK_VERSION,
    cellSize: 64,
    min: { x: 0, z: 0 },
    max: { x: FAR.cell[0], z: 0 },
    cells: [row(HOME.cell, bodies[HOME.body]), row(FAR.cell, bodies[FAR.body])],
  };
  const room = "interior/room.json";
  const index = {
    version: 1,
    assets: [{ path: room, files: [{ path: room }] }],
    groups: [{ name: "interior", assets: [room] }],
  };
  const files: Record<string, Uint8Array> = {
    [`${PACK}/${CELL_PACK_WORLD_FILE}`]: Buffer.from(JSON.stringify(world)),
    [`${PACK}/${TERRAIN_TILES_DIR}/${TERRAIN_TILES_FILE}`]: Buffer.from(
      JSON.stringify({ format: TERRAIN_TILES_FORMAT, version: TERRAIN_TILES_VERSION }),
    ),
    ...bodies,
    [HOME.tile]: tile(1),
    [FAR.tile]: tile(2),
    [room]: Buffer.from(JSON.stringify(ROOM)),
    "genex-asset-index.json": Buffer.from(JSON.stringify(index)),
  };
  for (const [rel, bytes] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(assets, rel)), { recursive: true });
    await writeFile(path.join(assets, rel), bytes);
  }
  return files;
}

interface StreamWindow {
  GenexShell: { status: { state: string; code: string | null; reason?: string } };
  __studio: Record<string, (arg?: unknown) => unknown>;
}

/** What the row reads of `state()`: the sample's probe (probes sit at the top) and the shell's delivered files. */
interface StreamState {
  stream?: StreamProbe;
  volatile?: { webStream?: { files: number; inFlight: number; cells: number[][] } };
}

interface StreamProbe {
  ticks: number;
  far: boolean;
  anchor: number[][];
  readyTick: number | null;
  doors: number | null;
  farAtReset: { bytes: number; group: string } | null;
}

const verb = (page: Page, name: string, arg?: unknown) =>
  page.evaluate(([n, a]) => (window as unknown as StreamWindow).__studio[n as string](a), [name, arg] as const);

const state = async (page: Page) => (await verb(page, "state")) as StreamState;

async function waitBooted(page: Page): Promise<string> {
  await page.waitForFunction(
    () => (window as unknown as Partial<StreamWindow>).GenexShell?.status.state !== "starting",
    undefined,
    { timeout: BOOT_TIMEOUT_MS },
  );
  return page.evaluate(() => JSON.stringify((window as unknown as StreamWindow).GenexShell.status));
}

/** Polls `state()` until `done` holds (or the arrival timeout), and answers the last state. */
async function until(page: Page, done: (seen: StreamState) => boolean): Promise<StreamState> {
  const deadline = Date.now() + ARRIVAL_TIMEOUT_MS;
  for (;;) {
    const seen = await state(page);
    if (done(seen) || Date.now() > deadline) return seen;
    await page.waitForTimeout(50);
  }
}

const hasCell = (seen: StreamState, cell: readonly number[]) =>
  (seen.volatile?.webStream?.cells ?? []).some(([x, z]) => x === cell[0] && z === cell[1]);

describe("a real streamed world on the web fetches what the game streams while playing", {
  skip: browserSkip(),
}, () => {
  let browser: Browser;
  let site: Site;
  let map: WebAssetMap;

  before(
    async () => {
      const home = await realpath(await tmpDir("rust-web-streamed-world-"));
      await cargo([
        "build",
        "-p",
        "genex-platform-web",
        "--example",
        "web_stream",
        "--target",
        "wasm32-unknown-unknown",
        "--release",
      ]);
      const out = path.join(home, "stream");
      const result = await packageWeb({
        wasm: WASM,
        out,
        shell: await readFile(SHELL, "utf8"),
        title: "Web stream",
        optimize: true,
        tools: { wasmBindgen: WASM_BINDGEN, wasmOpt: WASM_OPT },
        run: realRun,
      });
      assert.ok(result.ok, `packageWeb refused: ${JSON.stringify(result)}`);
      await stageAssets(path.join(out, WEB_FILES.assets));
      await writeWebAssetMap(out);
      map = JSON.parse(await readFile(path.join(out, WEB_FILES.assetMap), "utf8")) as WebAssetMap;
      site = await serve(out);
      browser = await chromium.launch({
        headless: true,
        args: CHROMIUM_ARGS[process.platform] ?? DEFAULT_CHROMIUM_ARGS,
      });
    },
    { timeout: BUILD_TIMEOUT_MS },
  );
  after(async () => {
    await browser?.close();
    site?.close();
  });

  it("puts the pack's cells and tiles in stream and the group's file in named", () => {
    const group = (rel: string) => map.files.find((file) => file.path === rel)?.group;
    for (const rel of [HOME.body, HOME.tile, FAR.body, FAR.tile]) assert.equal(group(rel), WebAssetGroup.Stream, rel);
    assert.equal(group("interior/room.json"), WebAssetGroup.Named);
  });

  it("fetches the start cell and the required group, then the far cell after a teleport, into the sim's reads", {
    timeout: BOOT_TIMEOUT_MS + 4 * ARRIVAL_TIMEOUT_MS,
  }, async () => {
    const context = await browser.newContext({ viewport: { width: 640, height: 360 } });
    try {
      const page = await context.newPage();
      await page.goto(`${site.origin}/index.html`);
      const status = await waitBooted(page);
      assert.equal(JSON.parse(status).state, ShellState.Running, status);

      // At home: the start cell's body and tile, and the interior, arrive while playing.
      const settled = await until(page, (seen) => hasCell(seen, HOME.cell) && seen.stream?.doors === ROOM.doors);
      const probe = settled.stream;
      assert.ok(
        hasCell(settled, HOME.cell),
        `the start cell's files reached the sim: ${JSON.stringify(settled.volatile)}`,
      );
      assert.equal(probe?.doors, ROOM.doors, `the group's level file was read: ${JSON.stringify(probe)}`);
      assert.equal(
        probe?.readyTick,
        REQUIRE_TICK + GROUP_PREFETCH_TICKS,
        "ready on the tick a native run makes it ready",
      );
      assert.equal(probe?.farAtReset, null, "the first reset ran before anything streamed");
      const asked = (rel: string) => site.requests.filter((request) => request.path === `${WEB_FILES.assets}/${rel}`);
      for (const rel of [HOME.body, HOME.tile, "interior/room.json"]) {
        assert.equal(asked(rel).length, 1, `${rel} fetched once`);
        assert.ok(asked(rel)[0].range?.startsWith("bytes=0-"), `${rel} fetched by Range while playing`);
      }
      assert.deepEqual(asked(FAR.body), [], "the far cell is not fetched while the player is home");

      // The teleport: the far cell arrives, the start cell leaves.
      await verb(page, "injectInput", { down: [TELEPORT_KEY] });
      const far = await until(page, (seen) => hasCell(seen, FAR.cell));
      await verb(page, "injectInput", { up: [TELEPORT_KEY] });
      assert.ok(hasCell(far, FAR.cell), `the far cell's files reached the sim: ${JSON.stringify(far.volatile)}`);
      assert.deepEqual(far.stream?.anchor, [FAR.cell], "the player is in the far cell");
      assert.ok(!hasCell(far, HOME.cell), "the start cell's files were dropped");
      for (const rel of [FAR.body, FAR.tile])
        assert.equal(asked(rel).length, 1, `${rel} fetched once, after the teleport`);

      // The sim's own reads see the far body: a reseed's reset asks the asset folder about it.
      await verb(page, "seed", 7);
      const seeded = (await state(page)).stream;
      const body = map.files.find((file) => file.path === FAR.body);
      assert.deepEqual(seeded?.farAtReset, { bytes: body?.bytes, group: WebAssetGroup.Stream }, JSON.stringify(seeded));
    } finally {
      await context.close();
    }
  });
});
