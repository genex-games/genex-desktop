/**
 * The Rust GXF wire v1 sender (`native/genex-rust/crates/genex-frames`) against the real
 * receive-only addon: `native/genex-frames/build.sh` builds `genex-frames.node`, the spike
 * toolchain builds the Rust test sender (`gxf-rust-test-sender`, the C test sender's JSON-lines
 * fd-3 protocol), and the frames host (`createNativeFrames`, loading the addon itself) takes its
 * frames. Each frame is drawn by wgpu on Metal into an IOSurface adopted through
 * `create_texture_from_hal`, waited for on the GPU and only then sent as one 80-byte Mach message.
 *
 * macOS only. Needs Apple clang, `node_api.h` and the spike toolchain (`setup-toolchain.sh`);
 * without them the rows skip, and `GENEX_REQUIRE_METAL=1` turns any skip, a missing tool or a
 * non-Metal adapter, into a failure.
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
  NATIVE_FRAMES_SERVICE_PREFIX,
  type NativeRefusal,
  type NativeTimers,
} from "../../src/shared/native-contract.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { metalRequired } from "../helpers/gpu-games.ts";

const run = promisify(execFile);
const REPO = fileURLToPath(new URL("../..", import.meta.url));
const BUILD_SCRIPT = path.join(REPO, "native", "genex-frames", "build.sh");
/** The cargo env helper: the pinned sysroot, the vendored crates and the genex workspace manifest. */
const RUST_ENV = path.join(REPO, "scripts", "toolchains", "rust-env.ts");
const SPIKE_TOOLCHAIN = path.join(REPO, ".studio-dev", "spike-toolchain");
const CARGO_TARGET = process.env.CARGO_TARGET_DIR ?? path.join(REPO, ".studio-dev", "cargo-target");
const SENDER_BIN = "gxf-rust-test-sender";
/** How long the addon build and the Rust build may take (a cold wgpu build is minutes). */
const BUILD_TIMEOUT_MS = 15 * 60_000;
/** How long one sender step may take before the row fails. */
const STEP_TIMEOUT_MS = 20_000;
/** How long a row waits for the addon to account for every frame sent, and how often it looks. */
const STATS_SETTLE_MS = 5_000;
const STATS_POLL_MS = 10;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** The rings the rows ask for, in device pixels. */
const FIRST_RING = { width: 320, height: 180 };
const SECOND_RING = { width: 256, height: 144 };
const NODE_API_INCLUDE = path.join(path.dirname(path.dirname(process.execPath)), "include", "node");
const REQUIRED = metalRequired();

/** `{}` when both builds can run here; a skip naming what is absent, or a throw when required. */
function needsTools(): { skip?: string } {
  if (process.platform !== "darwin") {
    if (REQUIRED) throw new Error("GENEX_REQUIRE_METAL=1 off macOS");
    return { skip: "not run: the GXF sender is macOS only" };
  }
  const developer = spawnSync("/usr/bin/xcode-select", ["-p"], { encoding: "utf8" });
  const clang =
    developer.status === 0 && existsSync(developer.stdout.trim())
      ? spawnSync("/usr/bin/xcrun", ["--find", "clang"], { encoding: "utf8" })
      : null;
  const absent = [
    clang?.status === 0 ? null : "Apple clang (xcrun)",
    existsSync(path.join(NODE_API_INCLUDE, "node_api.h")) ? null : `node_api.h in ${NODE_API_INCLUDE}`,
    existsSync(path.join(SPIKE_TOOLCHAIN, "sysroot")) ? null : "the spike toolchain (setup-toolchain.sh)",
  ].find((tool) => tool !== null);
  if (!absent) return {};
  if (REQUIRED) throw new Error(`GENEX_REQUIRE_METAL=1: ${absent} absent`);
  return { skip: `not run: ${absent} absent` };
}

const tools = needsTools();

const TIMERS: NativeTimers = {
  now: () => Date.now(),
  setTimeout: (fire, ms) => setTimeout(fire, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Waits until the receive-only addon has accepted and released `count` frames (it takes Mach
 * messages asynchronously), polling under `STATS_SETTLE_MS`; the row then asserts the exact stats.
 */
async function settled(host: NativeFramesHost, runId: string, count: number): Promise<void> {
  for (let waited = 0; waited < STATS_SETTLE_MS; waited += STATS_POLL_MS) {
    const stats = host.stats(runId);
    if (stats && stats.accepted >= count && stats.released >= count) return;
    await sleep(STATS_POLL_MS);
  }
}

/** Electron's `sharedTexture` with a renderer that draws at once and gives each import back. */
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

type SenderLine = Record<string, unknown>;

/** The Rust test sender on fd 3, unsandboxed (the sandboxed look-up rows are the game profile's). */
function startSender(binary: string, service: string) {
  const child: ChildProcess = spawn(binary, ["--service", service, "--fd", "3"], {
    stdio: ["ignore", "ignore", "pipe", "pipe"],
    env: { PATH: "/usr/bin:/bin" },
  });
  const control = child.stdio[3];
  assert.ok(control instanceof Duplex, "fd 3 is a pipe both ways");
  const lines: SenderLine[] = [];
  let stderr = "";
  let buffered = "";
  control.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
      lines.push(JSON.parse(buffered.slice(0, end)) as SenderLine);
      buffered = buffered.slice(end + 1);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4096);
  });
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
        assert.ok(Date.now() < deadline, `the sender never said it: ${JSON.stringify(lines.slice(-3))} ${stderr}`);
        await sleep(20);
      }
    },
    kill: () => void child.kill("SIGKILL"),
  };
}

type Sender = ReturnType<typeof startSender>;

const started: Sender[] = [];
/** Channels a row opened: closed even when the row fails, or the addon's thread keeps Node alive. */
const opened: Array<() => void> = [];
after(async () => {
  for (const close of opened) close();
  for (const sender of started) sender.kill();
  await Promise.all(started.map((sender) => sender.exited));
});

/** Asks the sender for the ring `host.ring` announces and waits for its answer. */
async function announceRing(host: NativeFramesHost, runId: string, sender: Sender, size: typeof FIRST_RING) {
  const ring = host.ring(runId, size);
  const id = sender.send("surface", { w: ring.width, h: ring.height, generation: ring.generation, slots: ring.slots });
  const answer = await sender.waitFor((line) => line.id === id);
  assert.equal(answer.ok, true, JSON.stringify(answer));
  return { ring, answer };
}

/** Starts `frames` frames at `fps` and waits until every one was sent and given back. */
async function sendFrames(sender: Sender, frames: number, fps: number) {
  const before = sender.lines.length;
  sender.send("start", { frames, fps });
  const done = await sender.waitFor(
    (line) => sender.lines.indexOf(line) >= before && (line.op === "done" || line.op === "error"),
  );
  assert.equal(done.op, "done", JSON.stringify(done));
  return sender.lines.slice(before).filter((line) => line.op === "frame");
}

/** A frames host on the real addon with one run open and the Rust sender started and peered. */
async function openRun(resources: string, senderBinary: string) {
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
  const runId = randomBytes(6).toString("hex");
  const holder: { sender: Sender | null } = { sender: null };
  const { service } = host.open({
    runId,
    project: "rust-frames-test",
    release: (slot) => holder.sender?.send("release", slot),
  });
  opened.push(() => host.close(runId));
  assert.equal(service, `${NATIVE_FRAMES_SERVICE_PREFIX}${runId}`);
  assert.ok(senderBinary, "the Rust test sender was built");
  const sender = startSender(senderBinary, service);
  started.push(sender);
  holder.sender = sender;
  host.peer(runId, sender.pid);
  const ready = await sender.waitFor((line) => line.op === "ready" || line.op === "error");
  return { host, runId, sender, ready, imports, killed };
}

describe("the Rust GXF sender against the real receive-only addon", tools, () => {
  let resources = "";
  let senderBinary = "";

  it("builds the addon and the Rust test sender", async () => {
    const build = await tmpDir("rust-frames-addon-");
    await run("/bin/bash", [BUILD_SCRIPT], {
      env: { ...process.env, OUT: build, NODE_API_INCLUDE },
      timeout: BUILD_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    resources = await tmpDir("rust-frames-resources-");
    await mkdir(path.join(resources, "native"));
    await copyFile(path.join(build, "genex-frames.node"), path.join(resources, "native", "genex-frames.node"));
    await run(
      process.execPath,
      [RUST_ENV, "--", "cargo", "build", "-p", "genex-frames", "--bin", SENDER_BIN, "--offline", "--locked"],
      {
        env: { ...process.env, CARGO_TARGET_DIR: CARGO_TARGET },
        timeout: BUILD_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
      },
    );
    senderBinary = path.join(CARGO_TARGET, "debug", SENDER_BIN);
    assert.ok(existsSync(senderBinary), senderBinary);
  });

  it("accepts Rust-built frames: three slots cycle, every slot comes back, a new generation follows", async (t) => {
    const { host, runId, sender, ready, imports, killed } = await openRun(resources, senderBinary);
    if (ready.op === "error" && !REQUIRED) {
      t.skip(`no Metal device: ${JSON.stringify(ready)}`);
      return;
    }
    assert.equal(ready.op, "ready", JSON.stringify(ready));
    assert.equal(ready.lookup, 0, "the sender found the run's service");
    assert.equal(ready.backend, "metal");

    const first = await announceRing(host, runId, sender, FIRST_RING);
    assert.equal(first.answer.adopted, true, "create_texture_from_hal adopted every IOSurface");
    const frames = await sendFrames(sender, 60, 60);
    await settled(host, runId, 60);
    assert.deepEqual(
      frames.map((frame) => frame.kr),
      frames.map(() => 0),
    );
    assert.deepEqual([...new Set(frames.map((frame) => frame.slot))].sort(), [0, 1, 2], "the three slots cycle");
    const stats = host.stats(runId);
    assert.deepEqual(
      [stats?.accepted, stats?.released, stats?.heldMask, stats?.refused],
      [60, 60, 0, 0],
      JSON.stringify(stats),
    );

    const second = await announceRing(host, runId, sender, SECOND_RING);
    assert.ok(second.ring.generation > first.ring.generation);
    await sendFrames(sender, 12, 0);
    await settled(host, runId, 72);
    // The addon refuses a payload whose generation is not the announced ring's: none was refused.
    const later = host.stats(runId);
    assert.deepEqual(
      [later?.accepted, later?.released, later?.heldMask, later?.refused],
      [72, 72, 0, 0],
      JSON.stringify(later),
    );
    assert.equal(imports(), 72);
    assert.deepEqual(killed, []);
    sender.send("quit");
    await sender.exited;
  });
});
