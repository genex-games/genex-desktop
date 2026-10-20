/**
 * Crash reports on a rust-wgpu web page (game systems CRASH-3): genex-crash's hook in the module,
 * chained in front of our port of console_error_panic_hook, and the template shell's trap
 * catcher, device watch and IndexedDB records (`src/game-template-rust/web/shell.html`).
 *
 * Browser rows launch Playwright's headless Chromium (only with `STUDIO_BROWSER_TESTS=1` and a
 * Chromium already installed; nothing is downloaded) on the `web_crash` example, built for wasm32
 * with the pinned toolchain and packaged by `packageWeb` with the real tools. They prove a Rust
 * panic gives exactly one `panic` record readable from `__studio.crashes()` and the console text
 * console_error_panic_hook logged; a trap with no panic gives one shell-made `wasm-trap` record
 * with the engine's `wasm-function` frames; the records survive a reload and the 17th prunes the
 * oldest; and a lost device gives one `device-lost` record beside the existing `device-lost` card.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { type Browser, chromium, type Page } from "@playwright/test";
import { packageWeb, type WebRun, writeWebAssetMap } from "../../src/main/rust-build-web.ts";
import {
  CRASH_RECORD_FORMAT,
  CrashKind,
  type CrashRecordV1,
  CrashSource,
  parseCrashRecord,
  WasmTrap,
} from "../../src/shared/crash-record.ts";
import { MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import { FrameProfileAction } from "../../src/shared/frame-profile.ts";
import { NativeOpError } from "../../src/shared/native-contract.ts";
import { playwrightHeadlessChromiumOnDisk } from "../helpers/playwright-chromium.ts";
import { tmpDir } from "../helpers/tmp.ts";

const execFileAsync = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const SHELL = path.join(REPO, "src", "game-template-rust", "web", "shell.html");
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");
const TOOLCHAIN = process.env.GENEX_RUST_TOOLCHAIN_DIR ?? path.join(REPO, ".studio-dev", "spike-toolchain");
const CARGO = path.join(TOOLCHAIN, "sysroot", "bin", "cargo");
const WASM_BINDGEN = path.join(TOOLCHAIN, "tools", "bin", "wasm-bindgen");
const WASM_OPT = path.join(TOOLCHAIN, "tools", "binaryen", "bin", "wasm-opt");
const TARGET_DIR = process.env.CARGO_TARGET_DIR ?? path.join(REPO, ".studio-dev", "cargo-target");
const WASM = path.join(TARGET_DIR, "wasm32-unknown-unknown", "release", "examples", "web_crash.wasm");
/** A cold build compiles wgpu, Rapier, egui and kira for wasm32. */
const BUILD_TIMEOUT_MS = 30 * MINUTE_MS;
const RUN_TIMEOUT_MS = 3 * MINUTE_MS;
const BOOT_TIMEOUT_MS = 60 * SECOND_MS;
const RECORD_TIMEOUT_MS = 10 * SECOND_MS;
const OUTPUT_MAX_BYTES = 64 * 1024 * 1024;
/** One tick of the sample, in ms (a step of it runs one update). */
const TICK_MS = 17;
/** How many records the shell keeps (shell.html CRASH_RECORDS_KEPT). */
const CRASH_RECORDS_KEPT = 16;
/** The frame refusal the shell's status names after a trap, and the device-lost card's code (shell.html). */
const FRAME_FAILED = "frame-failed";
const DEVICE_LOST = "device-lost";
/** What the page answers a refused verb with (shell.html REFUSED). */
const REFUSED = "__refused";
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
/** console_error_panic_hook's text for the sample's panic: the panic, the stack in the message, whitespace. */
const PANIC_CONSOLE_TEXT =
  /^panicked at [^\n]*web_crash\.rs:\d+:\d+:\nforced panic at tick \d+\n\nStack:\n\n[\s\S]*\n\n$/;

/**
 * The game's device with a `lost` the test settles (`window.__loseDevice(reason)`), installed
 * before the shell wraps `requestDevice`, so the shell and the renderer both read it.
 */
const LOSABLE_DEVICE = `{
  const request = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (...args) {
    const device = await request.apply(this, args);
    if (!window.__loseDevice) {
      const lost = new Promise((resolve) => {
        window.__loseDevice = (reason) => resolve({ reason, message: "the test lost the device" });
      });
      Object.defineProperty(device, "lost", { configurable: true, get: () => lost });
    }
    return device;
  };
}`;

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

interface Served {
  origin: string;
  close: () => void;
}

/** A static server over one packaged folder. */
async function serve(root: string): Promise<Served> {
  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
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

interface CrashWindow {
  GenexShell: { status: { state: string; code: string | null }; crash(json: string): void };
  __studio: Record<string, (arg?: unknown) => unknown>;
}

async function waitBooted(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const state = (window as unknown as { GenexShell?: { status: { state: string } } }).GenexShell?.status.state;
      return state !== undefined && state !== "starting";
    },
    undefined,
    { timeout: BOOT_TIMEOUT_MS },
  );
}

const verb = (page: Page, name: string, arg?: unknown) =>
  page.evaluate(([n, a]) => (window as unknown as CrashWindow).__studio[n as string](a), [name, arg] as const);

/** `__studio.crashes()`, newest first. */
const crashes = (page: Page) =>
  page.evaluate(() => (window as unknown as CrashWindow).__studio.crashes() as Promise<CrashRecordV1[]>);

/** Waits until `__studio.crashes()` holds `count` records, and answers them. */
async function crashesWhen(page: Page, count: number): Promise<CrashRecordV1[]> {
  const deadline = Date.now() + RECORD_TIMEOUT_MS;
  for (;;) {
    const records = await crashes(page);
    if (records.length >= count || Date.now() > deadline) return records;
    await page.waitForTimeout(100);
  }
}

/** Every `console.error` text `page` logs from now on. */
function consoleErrors(page: Page): string[] {
  const seen: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") seen.push(message.text());
  });
  return seen;
}

/** A record as a game's hook writes one, with this message (for the keep and prune rows). */
const syntheticRecord = (message: string) =>
  JSON.stringify({
    format: CRASH_RECORD_FORMAT,
    kind: CrashKind.Panic,
    source: CrashSource.Game,
    fatal: false,
    handled: true,
    message,
  });

describe("crash reports on a rust-wgpu web page", { skip: browserSkip() }, () => {
  let browser: Browser;
  let site: Served;

  before(
    async () => {
      const home = await realpath(await tmpDir("rust-web-crash-"));
      await cargo([
        "build",
        "-p",
        "genex-platform-web",
        "--example",
        "web_crash",
        "--target",
        "wasm32-unknown-unknown",
        "--release",
      ]);
      const out = path.join(home, "crash");
      const result = await packageWeb({
        wasm: WASM,
        out,
        shell: await readFile(SHELL, "utf8"),
        title: "Crash",
        optimize: true,
        tools: { wasmBindgen: WASM_BINDGEN, wasmOpt: WASM_OPT },
        run: realRun,
      });
      assert.ok(result.ok, `packageWeb refused: ${JSON.stringify(result)}`);
      await writeWebAssetMap(out);
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

  it("gives one panic record for a Rust panic and logs console_error_panic_hook's text", {
    timeout: 2 * BOOT_TIMEOUT_MS,
  }, async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = consoleErrors(page);
    await page.goto(`${site.origin}/index.html?paused`);
    await waitBooted(page);
    assert.deepEqual(await crashes(page), [], "no record before the crash");
    await verb(page, "injectInput", { down: ["KeyP"] });
    await assert.rejects(verb(page, "step", TICK_MS), "the step that panicked throws the trap");
    const [record, ...more] = await crashesWhen(page, 1);
    assert.equal(more.length, 0, "one record: the trap that ended the panic is not recorded again");
    assert.ok(parseCrashRecord(record), `the host's parser takes it: ${JSON.stringify(record)}`);
    assert.equal(record.kind, CrashKind.Panic);
    assert.equal(record.source, CrashSource.Game);
    assert.equal(record.fatal, true);
    assert.match(record.message, /^forced panic at tick \d+$/);
    assert.match(record.location?.file ?? "", /web_crash\.rs$/);
    assert.equal(record.context.destination, "web");
    const panics = errors.filter((text) => text.startsWith("panicked at"));
    assert.equal(panics.length, 1, `one console line: ${JSON.stringify(errors)}`);
    assert.match(panics[0], PANIC_CONSOLE_TEXT);
    // The dead module is never called again: a verb answers nothing and records nothing.
    assert.equal(await verb(page, "state"), undefined);
    assert.equal((await crashes(page)).length, 1);
    await context.close();
  });

  it("gives one shell-made wasm-trap record with the engine's wasm-function frames for a trap with no panic", {
    timeout: 2 * BOOT_TIMEOUT_MS,
  }, async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = consoleErrors(page);
    await page.goto(`${site.origin}/index.html`);
    await waitBooted(page);
    await page.focus("#game");
    await page.keyboard.press("KeyU");
    const [record, ...more] = await crashesWhen(page, 1);
    assert.equal(more.length, 0);
    assert.ok(parseCrashRecord(record), JSON.stringify(record));
    assert.equal(record.kind, CrashKind.WasmTrap);
    assert.equal(record.source, CrashSource.Shell);
    assert.equal(record.fatal, true);
    assert.equal(record.wasm?.trap, WasmTrap.Unreachable);
    assert.ok((record.wasm?.stack.length ?? 0) >= 1, `wasm-function frames: ${JSON.stringify(record.wasm)}`);
    for (const frame of record.wasm?.stack ?? [])
      assert.ok(Number.isSafeInteger(frame.func) && Number.isSafeInteger(frame.offset));
    const status = await page.evaluate(() => (window as unknown as CrashWindow).GenexShell.status);
    assert.equal(status.code, FRAME_FAILED, "the frame refusal stays as it was");
    assert.equal(errors.filter((text) => text.startsWith("panicked at")).length, 0, "no panic text: no panic ran");
    await context.close();
  });

  it("keeps the records across a reload and prunes the oldest past sixteen", {
    timeout: 2 * BOOT_TIMEOUT_MS,
  }, async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${site.origin}/index.html?paused`);
    await waitBooted(page);
    const total = CRASH_RECORDS_KEPT + 1;
    await page.evaluate(
      ([records]) => {
        for (const json of records) (window as unknown as CrashWindow).GenexShell.crash(json);
      },
      [Array.from({ length: total }, (_, i) => syntheticRecord(`synthetic ${i + 1}`))] as const,
    );
    const expected = Array.from({ length: CRASH_RECORDS_KEPT }, (_, i) => `synthetic ${total - i}`);
    const kept = await crashesWhen(page, CRASH_RECORDS_KEPT);
    assert.deepEqual(
      kept.map((record) => record.message),
      expected,
      "newest first, the first one pruned",
    );
    await page.reload();
    await waitBooted(page);
    const reloaded = await crashes(page);
    assert.deepEqual(
      reloaded.map((record) => record.message),
      expected,
      "IndexedDB kept them",
    );
    assert.ok(reloaded.every((record) => parseCrashRecord(record) !== null));
    await context.close();
  });

  it("gives one device-lost record beside the existing device-lost card", {
    timeout: 2 * BOOT_TIMEOUT_MS,
  }, async (t) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.addInitScript(LOSABLE_DEVICE);
    await page.goto(`${site.origin}/index.html`);
    await waitBooted(page);
    await page.evaluate(() => (window as unknown as { __loseDevice(reason: string): void }).__loseDevice("unknown"));
    await page.waitForFunction(
      (code) => (window as unknown as CrashWindow).GenexShell.status.code === code,
      DEVICE_LOST,
      { timeout: RECORD_TIMEOUT_MS },
    );
    const records = await crashesWhen(page, 1);
    const lost = records.filter((record) => record.kind === CrashKind.DeviceLost);
    assert.equal(lost.length, 1, JSON.stringify(records));
    assert.ok(parseCrashRecord(lost[0]), JSON.stringify(lost[0]));
    assert.equal(lost[0].gpu?.reason, "unknown");
    t.diagnostic(`device-lost written by the ${lost[0].source}, fatal ${lost[0].fatal}`);
    await context.close();
  });

  it("answers the profile verb through the page, refused unknown-op on the web", {
    timeout: 2 * BOOT_TIMEOUT_MS,
  }, async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${site.origin}/index.html?paused`);
    await waitBooted(page);
    const answer = await verb(page, "profile", { action: FrameProfileAction.Summary });
    assert.deepEqual(answer, { [REFUSED]: NativeOpError.UnknownOp });
    await context.close();
  });
});
