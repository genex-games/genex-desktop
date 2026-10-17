/**
 * The pond on the web (M0a.7 spike): the WebGPU-only shell (`native/genex-rust/web/shell.html`),
 * its async capture from the world target, the designed "this game needs WebGPU" page, and the
 * self-test record the native build and the web build both write.
 *
 * - Native rows build the pond (`native/genex-rust/examples/pond`) with the pinned spike toolchain
 *   and run its spike-only `--self-test` mode on the host GPU: two runs of one seed write identical
 *   bytes and non-blank captures. They skip without the toolchain (`GENEX_REQUIRE_SPIKE_TOOLCHAIN=1`
 *   fails instead) and without a GPU the renderer accepts (`GENEX_REQUIRE_METAL=1` fails instead).
 * - Browser rows launch Playwright's headless Chromium (only with `STUDIO_BROWSER_TESTS=1` and a
 *   Chromium already installed; nothing is downloaded) on the output of
 *   `scripts/spike/rust-wgpu/web.sh`, served from 127.0.0.1. On the Mac Chromium's WebGPU runs on
 *   Metal. The rows prove the shell awaits `studio_capture` (BGRA plus its FNV-1a-64 digest), the
 *   web and native self-test records agree within the parity tolerance, the wasm stays within its
 *   gzip budget, and a browser below WebGPU core (no `navigator.gpu`, no adapter, an adapter double
 *   with a limit below the defaults) gets the unsupported page with `gpu-unsupported` and never
 *   fetches or starts the game.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type Browser, chromium, type Page } from "@playwright/test";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import { witnessOf } from "../../src/main/harness-rpc/preview.ts";
import { playwrightHeadlessChromiumOnDisk } from "../helpers/playwright-chromium.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { metalRequired } from "../helpers/gpu-games.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
/** The cargo env helper: the pinned sysroot, the vendored crates and the genex workspace manifest. */
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");
const WEB_SH = path.join(REPO, "scripts", "spike", "rust-wgpu", "web.sh");
const SPIKE_CARGO = path.join(REPO, ".studio-dev", "spike-toolchain", "sysroot", "bin", "cargo");
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? path.join(REPO, ".studio-dev", "cargo-target");
const NATIVE_POND = path.join(TARGET_DIR, "debug", "pond");
const WEB_OUT = path.join(TARGET_DIR, "genex-web", "pond-test");
/** Cold builds compile wgpu, Rapier, egui and kira for the host and for wasm32. */
const BUILD_TIMEOUT_MS = 30 * MINUTE_MS;
const RUN_TIMEOUT_MS = 3 * MINUTE_MS;
const BOOT_TIMEOUT_MS = 60 * SECOND_MS;
const OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
/** The plan's parity run: 600 ticks of the `cast` demo's seed. */
const PARITY_TICKS = 600;
const PARITY_SEED = 1;
const PARITY_DEMO = "cast";
/** Named probe fields agree within this across targets (plan "Determinism"). */
const PROBE_TOLERANCE = 1e-3;
/** Pixels: the mean channel difference, and the share of pixels off by more than a step. */
const PIXEL_MEAN_TOLERANCE = 1.5;
const PIXEL_STEP = 24;
const PIXEL_OFF_SHARE = 0.01;
/** A capture with fewer distinct colours than this is blank (a clear and nothing drawn). */
const NONBLANK_MIN_COLOURS = 16;
const POND_WORLD = { width: 960, height: 540 };
const GPU_UNSUPPORTED = "gpu-unsupported";
const SELF_TEST_FORMAT = "genex-self-test/1";
/** The shell's status states and refusal reasons (shell.html). Wire values. */
const ShellState = { Running: "running", Unsupported: "unsupported" } as const;
const Reason = { NoWebGpu: "no-webgpu", NoAdapter: "no-adapter", LimitBelowCore: "limit-below-core" } as const;
/** Chromium's WebGPU on the Mac's GPU (Metal) rather than SwiftShader. */
const CHROMIUM_ARGS: Record<string, string[]> = {
  darwin: ["--enable-unsafe-webgpu", "--enable-gpu", "--use-angle=metal", "--ignore-gpu-blocklist"],
};
const DEFAULT_CHROMIUM_ARGS = ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"];
const SERVED: Record<string, { file: string; type: string }> = {
  "/index.html": { file: "index.html", type: "text/html" },
  "/game.js": { file: "game.js", type: "text/javascript" },
  "/game_bg.wasm": { file: "game_bg.wasm", type: "application/wasm" },
};

interface CaptureRecord {
  tick: number;
  width: number;
  height: number;
  digest: string;
}

interface SelfTestRecord {
  format: string;
  game: string;
  seed: number;
  demo: string;
  ticks: number;
  frame: number;
  checksum: string;
  probes: Record<string, unknown>;
  captures: CaptureRecord[];
}

interface RawCapture {
  width: number;
  height: number;
  digest: string;
  base64: string;
}

const toolchainSkip = (): string | false => {
  if (process.platform === "win32") return "not run: the spike lane is POSIX-only";
  if (existsSync(SPIKE_CARGO)) return false;
  if (process.env.GENEX_REQUIRE_SPIKE_TOOLCHAIN === "1") {
    throw new Error(`GENEX_REQUIRE_SPIKE_TOOLCHAIN=1: no spike toolchain at ${SPIKE_CARGO}`);
  }
  return "not run: the spike toolchain is not installed";
};

const browserSkip = (): string | false => {
  const toolchain = toolchainSkip();
  if (toolchain) return toolchain;
  if (process.env.STUDIO_BROWSER_TESTS !== "1") return "launches Chromium; set STUDIO_BROWSER_TESTS=1 to run";
  return playwrightHeadlessChromiumOnDisk()
    ? false
    : "no Playwright Chromium is installed; this suite never downloads one";
};

/** FNV-1a 64 of bytes, 16 hex digits (the capture digest). */
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

async function buildNative(): Promise<void> {
  const args = [RUST_ENV, "--", "cargo", "build", "-p", "pond", "--bin", "pond", "--offline", "--locked"];
  await execFileAsync(process.execPath, args, { timeout: BUILD_TIMEOUT_MS, maxBuffer: OUTPUT_MAX_BYTES, cwd: REPO });
}

/** Run the native self-test; `null` when the host has no GPU the renderer accepts. */
async function nativeSelfTest(stateDir: string): Promise<{ text: string; record: SelfTestRecord } | null> {
  const args = [
    "--self-test",
    String(PARITY_TICKS),
    "--seed",
    String(PARITY_SEED),
    "--demo",
    PARITY_DEMO,
    "--state-dir",
    stateDir,
  ];
  try {
    const { stdout } = await execFileAsync(NATIVE_POND, args, { timeout: RUN_TIMEOUT_MS, maxBuffer: OUTPUT_MAX_BYTES });
    return { text: stdout, record: JSON.parse(stdout) as SelfTestRecord };
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

/** Every numeric leaf within the tolerance, every other leaf equal. */
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

function pixelDifference(
  a: Uint8Array,
  b: Uint8Array,
): { mean: number; offShare: number; differing: number; worst: number } {
  assert.equal(a.length, b.length, "captures of one size");
  let total = 0;
  let off = 0;
  let differing = 0;
  let worst = 0;
  for (let i = 0; i < a.length; i += 4) {
    let pixelWorst = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(a[i + c] - b[i + c]);
      if (c < 3) total += d;
      pixelWorst = Math.max(pixelWorst, d);
    }
    if (pixelWorst > 0) differing++;
    if (pixelWorst > PIXEL_STEP) off++;
    worst = Math.max(worst, pixelWorst);
  }
  const pixels = a.length / 4;
  return { mean: total / (pixels * 3), offShare: off / pixels, differing, worst };
}

describe("the pond self-test, native", { skip: toolchainSkip() }, () => {
  before(buildNative, { timeout: BUILD_TIMEOUT_MS });

  it("writes byte-identical records from two runs of one seed, with non-blank captures", {
    timeout: 2 * RUN_TIMEOUT_MS,
  }, async (t) => {
    const home = await realpath(await tmpDir("pond-self-test-"));
    const first = await nativeSelfTest(path.join(home, "a"));
    if (skipWithoutGpu(t, first) || !first) return;
    const second = await nativeSelfTest(path.join(home, "b"));
    assert.ok(second);
    assert.equal(second.text, first.text, "the record holds nothing from the clock or the adapter");
    const { record } = first;
    assert.equal(record.format, SELF_TEST_FORMAT);
    assert.equal(record.ticks, PARITY_TICKS);
    assert.deepEqual(
      record.captures.map((c) => c.tick - record.captures[0].tick),
      [0, 200, 400, 600],
    );
    const fishing = record.probes.fishing as { casts: number };
    assert.equal(fishing.casts, 1, "the cast demo cast once");
    const last = record.captures.length;
    const bytes = new Uint8Array(await readFile(path.join(home, "a", "captures", `${last}.bgra`)));
    assert.equal(bytes.length, POND_WORLD.width * POND_WORLD.height * 4);
    assert.equal(fnv1a64(bytes), record.captures[last - 1].digest, "the record's digest is the file's");
    assert.ok(distinctColours(bytes) >= NONBLANK_MIN_COLOURS, "the capture is not blank");
  });
});

describe("the pond in Chromium's WebGPU", { skip: browserSkip() }, () => {
  let server: http.Server;
  let origin = "";
  let browser: Browser;
  const requests: string[] = [];

  before(
    async () => {
      await execFileAsync("bash", [WEB_SH, "--out", WEB_OUT], {
        timeout: BUILD_TIMEOUT_MS,
        maxBuffer: OUTPUT_MAX_BYTES,
        cwd: REPO,
      });
      await buildNative();
      server = http.createServer((req, res) => {
        const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
        requests.push(pathname);
        const entry = SERVED[pathname];
        if (!entry) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "content-type": entry.type, "cache-control": "no-store" });
        createReadStream(path.join(WEB_OUT, entry.file)).pipe(res);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      browser = await chromium.launch({
        headless: true,
        args: CHROMIUM_ARGS[process.platform] ?? DEFAULT_CHROMIUM_ARGS,
      });
    },
    { timeout: BUILD_TIMEOUT_MS },
  );
  after(async () => {
    await browser?.close();
    server?.close();
  });

  async function openShell(init?: string): Promise<Page> {
    const page = await browser.newPage();
    if (init) await page.addInitScript(init);
    await page.goto(`${origin}/index.html?paused`);
    await page.waitForFunction(
      () => {
        const state = (window as unknown as { GenexShell?: { status: { state: string } } }).GenexShell?.status.state;
        return state !== undefined && state !== "starting";
      },
      undefined,
      { timeout: BOOT_TIMEOUT_MS },
    );
    return page;
  }

  const status = (page: Page) =>
    page.evaluate(() => (window as unknown as { GenexShell: { status: Record<string, unknown> } }).GenexShell.status);

  async function captureRaw(page: Page): Promise<RawCapture> {
    return page.evaluate(async () => {
      const studio = (
        window as unknown as {
          __studio: { captureRaw(): Promise<{ width: number; height: number; digest: string; bgra: Uint8Array }> };
        }
      ).__studio;
      const pending = studio.captureRaw();
      // The export is async: the shell gets a promise, never pixels in the same turn.
      if (!(pending instanceof Promise)) throw new Error("studio_capture did not return a promise");
      const capture = await pending;
      let binary = "";
      for (let i = 0; i < capture.bgra.length; i += 0x8000) {
        binary += String.fromCharCode(...capture.bgra.subarray(i, i + 0x8000));
      }
      return { width: capture.width, height: capture.height, digest: capture.digest, base64: btoa(binary) };
    });
  }

  it("keeps the wasm within its 4 MB gzip budget", async () => {
    const size = JSON.parse(await readFile(path.join(WEB_OUT, "size.json"), "utf8")) as {
      gzipBytes: number;
      gzipBudgetBytes: number;
    };
    assert.ok(size.gzipBytes <= size.gzipBudgetBytes, `gzip ${size.gzipBytes} > ${size.gzipBudgetBytes}`);
  });

  it("boots on WebGPU core and awaits an async capture of BGRA and its digest", {
    timeout: 2 * BOOT_TIMEOUT_MS,
  }, async () => {
    const page = await openShell();
    const shell = await status(page);
    assert.equal(shell.state, ShellState.Running, `the shell refused: ${JSON.stringify(shell)}`);
    const receipt = shell.receipt as { tier: string; backend: string };
    assert.equal(receipt.tier, "core");
    assert.equal(receipt.backend, "webgpu");
    const capture = await captureRaw(page);
    const bytes = new Uint8Array(Buffer.from(capture.base64, "base64"));
    assert.deepEqual([capture.width, capture.height], [POND_WORLD.width, POND_WORLD.height]);
    assert.equal(bytes.length, capture.width * capture.height * 4);
    assert.equal(fnv1a64(bytes), capture.digest, "the digest is FNV-1a 64 of the BGRA bytes");
    assert.ok(distinctColours(bytes) >= NONBLANK_MIN_COLOURS, "the capture is not blank");
    const png = await page.evaluate(() =>
      (window as unknown as { __studio: { capture(): Promise<string> } }).__studio.capture(),
    );
    assert.match(png, /^data:image\/png;base64,/);
    await page.close();
  });

  it("agrees with the native self-test within the parity tolerance", { timeout: 2 * RUN_TIMEOUT_MS }, async (t) => {
    const home = await realpath(await tmpDir("pond-parity-"));
    const native = await nativeSelfTest(home);
    if (skipWithoutGpu(t, native) || !native) return;
    const page = await openShell();
    const web = await page.evaluate(
      ([ticks, seed, demo]) =>
        (
          window as unknown as { __studio: { selfTest(t: number, s: number, d: string): Promise<SelfTestRecord> } }
        ).__studio.selfTest(ticks, seed, demo),
      [PARITY_TICKS, PARITY_SEED, PARITY_DEMO] as const,
    );
    assert.equal(web.frame, native.record.frame);
    assert.deepEqual(
      web.captures.map((c) => c.tick),
      native.record.captures.map((c) => c.tick),
    );
    assertNear(web.probes, native.record.probes, "probes");
    // The record's last checkpoint is the paused runtime's current frame: capture it again for pixels.
    const capture = await captureRaw(page);
    const webBytes = new Uint8Array(Buffer.from(capture.base64, "base64"));
    const last = native.record.captures.length;
    const nativeBytes = new Uint8Array(await readFile(path.join(home, "captures", `${last}.bgra`)));
    assert.equal(capture.digest, web.captures[last - 1].digest, "a second capture of a paused frame is the same");
    const difference = pixelDifference(webBytes, nativeBytes);
    t.diagnostic(
      `parity: checksum ${web.checksum === native.record.checksum ? "equal" : "differs"}, ` +
        `digests ${web.captures.filter((c, i) => c.digest === native.record.captures[i].digest).length}/${last} equal, ` +
        `pixel mean ${difference.mean.toFixed(4)}, ${difference.differing} pixels differ (largest ${difference.worst}), ` +
        `off ${(difference.offShare * 100).toFixed(3)}%`,
    );
    assert.ok(difference.mean <= PIXEL_MEAN_TOLERANCE, `mean channel difference ${difference.mean}`);
    assert.ok(difference.offShare <= PIXEL_OFF_SHARE, `share of pixels off ${difference.offShare}`);
    await page.close();
  });

  it("answers the C++ page's verb shapes and the host's preview.witness", {
    timeout: 2 * BOOT_TIMEOUT_MS,
  }, async () => {
    const page = await openShell();
    type Studio = Record<string, (arg?: unknown) => unknown>;
    const verb = (name: string, arg?: unknown) =>
      page.evaluate(([n, a]) => (window as unknown as { __studio: Studio }).__studio[n as string](a), [
        name,
        arg,
      ] as const);
    const port = {
      studioState: () => verb("state"),
      studioCall: (method: string, arg?: unknown) => verb(method, arg),
    };
    assert.equal(await verb("seed", 7), 7, "seed answers the seed");
    const witness = await witnessOf(port, 1000);
    assert.deepEqual([witness.frameBefore, witness.frameAfter], [0, 60]);
    assert.ok(witness.drawCalls > 0, "step answers the draw calls");
    const stepped = (await verb("step", 100)) as Record<string, unknown>;
    assert.equal(stepped.steppedFrames, 6);
    assert.deepEqual(await verb("demo", "fly"), { ok: false, available: ["cast", "shop"] });
    const cast = (await verb("demo", "cast")) as Record<string, unknown>;
    assert.deepEqual([cast.ok, cast.demo], [true, "cast"]);
    assert.deepEqual(await verb("injectInput", { down: ["Space"], look: { dx: 2, dy: 0 } }), {
      keys: ["Space"],
      look: { x: 2, y: 0 },
      wheel: { x: 0, y: 0 },
    });
    assert.deepEqual(await verb("cameras"), ["default"]);
    assert.deepEqual(await verb("eyes"), []);
    assert.deepEqual(await verb("audio"), { available: false, rms: 0, centroid: 0 });
    assert.equal(await verb("capture", "sky"), null, "an unknown camera is refused");
    const shot = await page.evaluate(async () => {
      const notes: unknown[] = [];
      (window as unknown as { __studioCapture: unknown }).__studioCapture = { note: (r: unknown) => notes.push(r) };
      const url = await (window as unknown as { __studio: { capture(): Promise<string> } }).__studio.capture();
      return { url, notes };
    });
    assert.match(shot.url, /^data:image\/png;base64,/);
    assert.equal(shot.notes.length, 1, "the capture went through the studio's capture shim");
    assert.ok(((shot.notes[0] as { drawCalls: number }).drawCalls ?? 0) > 0);
    for (const nativeOnly of ["quit", "timing", "audioLevel", "front", "visible"]) {
      assert.equal(
        await page.evaluate((n) => n in (window as unknown as { __studio: object }).__studio, nativeOnly),
        false,
      );
    }
    await page.close();
  });

  const BELOW_CORE: ReadonlyArray<{ name: string; init: string; reason: string; limit?: string }> = [
    {
      name: "no navigator.gpu",
      init: "delete Navigator.prototype.gpu;",
      reason: Reason.NoWebGpu,
    },
    {
      name: "no adapter",
      init: "GPU.prototype.requestAdapter = async () => null;",
      reason: Reason.NoAdapter,
    },
    {
      name: "an adapter double with a limit below WebGPU's defaults",
      init: `{
        const real = GPU.prototype.requestAdapter;
        GPU.prototype.requestAdapter = async function (options) {
          const adapter = await real.call(this, options);
          if (!adapter) return adapter;
          const limits = new Proxy(adapter.limits, {
            get: (target, key) => (key === "maxStorageBuffersPerShaderStage" ? 4 : Reflect.get(target, key)),
          });
          return new Proxy(adapter, { get: (target, key) => (key === "limits" ? limits : Reflect.get(target, key)) });
        };
      }`,
      reason: Reason.LimitBelowCore,
      limit: "maxStorageBuffersPerShaderStage",
    },
  ];

  for (const row of BELOW_CORE) {
    it(`shows the unsupported page and never starts the game: ${row.name}`, {
      timeout: 2 * BOOT_TIMEOUT_MS,
    }, async () => {
      requests.length = 0;
      const page = await openShell(row.init);
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
      assert.deepEqual(
        requests.filter((r) => r !== "/index.html"),
        [],
        "the game's module and wasm are never fetched",
      );
      assert.equal(await page.evaluate(() => "__studio" in window), false, "no studio API: the game never started");
      await page.close();
    });
  }
});
