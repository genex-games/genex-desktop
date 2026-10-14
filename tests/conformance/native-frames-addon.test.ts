/**
 * The real genex-frames addon under Node 24: `native/genex-frames/build.sh test` builds it and runs
 * its C tests (validator table, a short fuzz, the real-kernel channel), the module is loaded with
 * `process.dlopen` and held to the TypeScript tables (`NativeFramesCode`, the ABI and wire versions:
 * the TS table cannot drift from the C table), and the frames host (`createNativeFrames`, loading
 * the addon itself) takes 60 frames at 60 fps from the built test sender, unsandboxed, giving every
 * slot back. A hostile sender is refused with its typed code, and a closed channel's service name is
 * gone. macOS only; required where Apple clang and `node_api.h` are present (skipped otherwise,
 * failed under `GENEX_REQUIRE_TOOLCHAINS=1`). The sandboxed look-up rows are the game profile's.
 */
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { Duplex } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import { createNativeFrames, type NativeFramesHost } from "../../src/main/native-frames.ts";
import {
  NATIVE_FRAMES_ABI_VERSION,
  NATIVE_FRAMES_DROPPED,
  NATIVE_FRAMES_SERVICE_PREFIX,
  NATIVE_FRAMES_WIRE_VERSION,
  NATIVE_FRAME_SLOTS,
  NativeFramesCode,
  NativeRefusal,
  type NativeTimers,
  nativeRefusalOfFrames,
} from "../../src/shared/native-contract.ts";
import { tmpDir } from "../helpers/tmp.ts";

const run = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const BUILD_SCRIPT = path.join(REPO, "native", "genex-frames", "build.sh");
/** Fuzz iterations for this run: the full 100,000 are the addon's own `build.sh test`. */
const FUZZ_ITERATIONS = "2000";
/** How long the build and its C tests may take. */
const BUILD_TIMEOUT_MS = 5 * 60_000;
/** How long one sender step may take before the row fails. */
const STEP_TIMEOUT_MS = 15_000;
/** The ring the rows ask for, in device pixels. */
const RING = { width: 320, height: 180 };

/** Node's own N-API headers, beside the running node. */
const NODE_API_INCLUDE = path.join(path.dirname(path.dirname(process.execPath)), "include", "node");

/** `{}` when the addon can be built here; a skip naming what is absent, or a throw when required. */
function needsAddonTools(): { skip?: string } {
  if (process.platform !== "darwin") return { skip: "not run: genex-frames is macOS only" };
  // xcode-select -p never opens an installer; xcrun is asked only once a developer folder exists.
  const developer = spawnSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8" });
  const clang =
    developer.status === 0 && existsSync(developer.stdout.trim())
      ? spawnSync("/usr/bin/xcrun", ["--find", "clang"], { encoding: "utf8" })
      : null;
  const absent = [
    clang?.status === 0 ? null : "Apple clang (xcrun)",
    existsSync(path.join(NODE_API_INCLUDE, "node_api.h")) ? null : `node_api.h in ${NODE_API_INCLUDE}`,
  ].find((tool) => tool !== null);
  if (!absent) return {};
  if (process.env.GENEX_REQUIRE_TOOLCHAINS === "1") throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${absent} absent`);
  return { skip: `not run: ${absent} absent` };
}

const tools = needsAddonTools();

/** `process.dlopen` into a fresh module object, as main loads it. */
function dlopen(file: string): Record<string, unknown> {
  const module = { exports: {} };
  process.dlopen(module, file);
  return module.exports;
}

const TIMERS: NativeTimers = {
  now: () => Date.now(),
  setTimeout: (fire, ms) => setTimeout(fire, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Electron's `sharedTexture` with a renderer that draws at once: each send resolves, and once main
 * releases the import its `allReferencesReleased` fires on the next turn.
 */
function drawingTexture() {
  let imports = 0;
  const texture = {
    importSharedTexture(options: {
      textureInfo: { handle: { ioSurface: Buffer } };
      allReferencesReleased: () => void;
    }) {
      assert.equal(options.textureInfo.handle.ioSurface.length, 8, "an IOSurfaceRef");
      imports += 1;
      return { release: () => void setImmediate(options.allReferencesReleased) };
    },
    sendSharedTexture: async () => {},
  };
  return { texture, imports: () => imports };
}

/** One line the test sender wrote on fd 3. */
type SenderLine = Record<string, unknown>;

/** The built test sender on fd 3 (its JSON-lines protocol: `gxf_test_sender.c`), unsandboxed. */
function startSender(build: string, service: string, hostile?: string) {
  const args = ["--service", service, "--fd", "3", ...(hostile ? ["--hostile", hostile] : [])];
  const child: ChildProcess = spawn(path.join(build, "gxf_test_sender"), args, {
    stdio: ["ignore", "ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin" },
  });
  const control = child.stdio[3];
  assert.ok(control instanceof Duplex, "fd 3 is a pipe both ways");
  const lines: SenderLine[] = [];
  const waiters = new Set<() => void>();
  let buffered = "";
  control.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
      lines.push(JSON.parse(buffered.slice(0, end)) as SenderLine);
      buffered = buffered.slice(end + 1);
    }
    for (const wake of waiters) wake();
  });
  child.stderr?.resume();
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  let nextId = 1;
  return {
    pid: child.pid ?? 0,
    lines,
    exited,
    send(op: string, arg?: unknown): number {
      const id = nextId++;
      control.write(`${JSON.stringify(arg === undefined ? { id, op } : { id, op, arg })}\n`);
      return id;
    },
    async waitFor(match: (line: SenderLine) => boolean): Promise<SenderLine> {
      const deadline = Date.now() + STEP_TIMEOUT_MS;
      for (;;) {
        const found = lines.find(match);
        if (found) return found;
        assert.ok(Date.now() < deadline, `the sender never said it: ${JSON.stringify(lines.slice(-3))}`);
        await Promise.race([new Promise<void>((wake) => waiters.add(wake)), sleep(50)]);
        waiters.clear();
      }
    },
    kill: () => void child.kill("SIGKILL"),
  };
}

type Sender = ReturnType<typeof startSender>;

const started: Sender[] = [];
after(async () => {
  for (const sender of started) sender.kill();
  await Promise.all(started.map((sender) => sender.exited));
});

/** Opens a run on `host` and starts a sender peered with it; the run's slots go back to that sender. */
async function openRun(host: NativeFramesHost, build: string, hostile?: string) {
  const runId = randomBytes(6).toString("hex");
  const holder: { sender: Sender | null } = { sender: null };
  const { service } = host.open({
    runId,
    project: "addon-test",
    release: (slot) => holder.sender?.send("release", slot),
  });
  assert.equal(service, `${NATIVE_FRAMES_SERVICE_PREFIX}${runId}`);
  const sender = startSender(build, service, hostile);
  started.push(sender);
  holder.sender = sender;
  host.peer(runId, sender.pid);
  const ready = await sender.waitFor((line) => line.op === "ready");
  assert.equal(ready.lookup, 0, "the sender found the run's service");
  const ring = host.ring(runId, RING);
  const surface = sender.send("surface", {
    w: ring.width,
    h: ring.height,
    generation: ring.generation,
    slots: ring.slots,
  });
  await sender.waitFor((line) => line.id === surface);
  return { runId, service, sender };
}

describe("the genex-frames addon, built and loaded", tools, () => {
  let build = "";
  let resources = "";

  it("builds with its C tests passing (validator, fuzz, real channel)", async () => {
    build = await tmpDir("genex-frames-build-");
    await run("/bin/bash", [BUILD_SCRIPT, "test"], {
      env: { ...process.env, OUT: build, NODE_API_INCLUDE, FUZZ_ITERATIONS },
      timeout: BUILD_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.ok(existsSync(path.join(build, "genex-frames.node")));
    resources = await tmpDir("genex-frames-resources-");
    await mkdir(path.join(resources, "native"));
    await copyFile(path.join(build, "genex-frames.node"), path.join(resources, "native", "genex-frames.node"));
  });

  it("is the addon the TypeScript side expects: ABI, wire version, slots and the same 26 codes", () => {
    const addon = dlopen(path.join(build, "genex-frames.node"));
    assert.equal(addon.abiVersion, NATIVE_FRAMES_ABI_VERSION);
    assert.equal(addon.wireVersion, NATIVE_FRAMES_WIRE_VERSION);
    assert.equal(addon.maxSlots, NATIVE_FRAME_SLOTS);
    assert.equal(addon.servicePrefix, NATIVE_FRAMES_SERVICE_PREFIX);
    const codes = addon.errorCodes;
    assert.ok(codes && typeof codes === "object");
    assert.deepEqual(Object.keys(codes).sort(), Object.values(NativeFramesCode).sort());
    for (const [code, fatal] of Object.entries(codes)) {
      const dropped = NATIVE_FRAMES_DROPPED.some((one) => one === code);
      assert.equal(fatal, !dropped, `${code}: fatal unless the addon drops it`);
    }
  });

  it("takes 60 frames at 60 fps through the frames host and gives every slot back", async () => {
    const killed: NativeRefusal[] = [];
    const { texture, imports } = drawingTexture();
    const host = createNativeFrames({
      resources,
      electronMajor: 43,
      sharedTexture: texture,
      target: () => ({ frame: "the studio" }),
      timers: TIMERS,
      kill: (_runId, refusal) => void killed.push(refusal),
      log: () => {},
    });
    assert.equal(host.available(), null, "the real addon passes the host's checks");
    const { runId, sender } = await openRun(host, build);
    sender.send("start", { frames: 60, fps: 60 });
    const done = await sender.waitFor((line) => line.op === "done" || line.op === "error");
    assert.equal(done.op, "done", JSON.stringify(done));
    await sleep(100);
    const stats = host.stats(runId);
    assert.deepEqual(
      [stats?.accepted, stats?.released, stats?.heldMask, stats?.refused],
      [60, 60, 0, 0],
      JSON.stringify(stats),
    );
    assert.equal(imports(), 60);
    assert.deepEqual(killed, []);
    sender.send("quit");
    await sender.exited;
    host.close(runId);

    const reused = startSender(build, `${NATIVE_FRAMES_SERVICE_PREFIX}${runId}`);
    started.push(reused);
    const ready = await reused.waitFor((line) => line.op === "ready" || line.op === "error");
    assert.notEqual(ready.lookup ?? ready.kr, 0, "a closed run's service name is gone");
    reused.kill();
  });

  it("a hostile sender (an RGBA surface) is refused format-mismatch: the run is ended slot-mismatch", async () => {
    const killed: NativeRefusal[] = [];
    const host = createNativeFrames({
      resources,
      electronMajor: 43,
      sharedTexture: drawingTexture().texture,
      target: () => ({ frame: "the studio" }),
      timers: TIMERS,
      kill: (_runId, refusal) => void killed.push(refusal),
      log: () => {},
    });
    const { runId, sender } = await openRun(host, build, "rgba");
    sender.send("start", { frames: 8, fps: 0 });
    const deadline = Date.now() + STEP_TIMEOUT_MS;
    while (killed.length === 0 && Date.now() < deadline) await sleep(20);
    assert.deepEqual(killed, [nativeRefusalOfFrames(NativeFramesCode.FormatMismatch)]);
    assert.equal(killed[0], NativeRefusal.SlotMismatch);
    assert.equal(host.stats(runId), null, "the channel closed after the kill");
    sender.kill();
  });
});
