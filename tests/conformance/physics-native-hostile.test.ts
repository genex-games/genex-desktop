/**
 * The native core's failure boundary (`@genex-ai/physics-native`, `crates/genex-physics-sidecar`):
 * what a malformed host, a slow frame, a killed or vanished process and a bad binary do, and that
 * each ends one core only.
 *
 * - The hostile frame table writes raw frames to a `genex-physics-room` process (no client in
 *   between): each malformed or out-of-order frame ends it with exit 3 and no reply, after the
 *   frames before it were answered.
 * - The process's own watchdog ends a frame past its deadline with exit 4.
 * - Through the client: a process SIGKILLed mid-tick, gone before a call (EPIPE) or past its
 *   deadline fails its own world with `internal`, for good, while a sibling core steps on; nothing
 *   is thrown and the core's folder is removed.
 * - Starting refuses bad options, a binary whose sha256 is not the one given, and a binary that
 *   never opens its FIFOs or answers `Hello` with garbage, within the start's deadline.
 *
 * Runs on the test build `node scripts/physics-native.ts --test` writes; without it the rows skip
 * (`GENEX_REQUIRE_TOOLCHAINS=1` makes its absence a failure).
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type * as Physics from "../../native/genex-rust/crates/genex-physics/js/index.d.ts";
import type * as Native from "../../native/genex-rust/crates/genex-physics/js/native.d.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = path.resolve(import.meta.dirname, "../..");
const PACKAGE = process.env.GENEX_PHYSICS_NATIVE_PACKAGE ?? path.join(REPO, ".studio-dev/build/physics-native-test");
/** Exit codes (crates/genex-physics-sidecar/src/lib.rs `exit`). */
const EXIT_PROTOCOL = 3;
const EXIT_DEADLINE = 4;
/** Request kinds and `Call` methods (protocol.rs). */
const Kind = { Hello: 1, Create: 2, AddStatic: 3, Tick: 4, Call: 5, Shutdown: 6 } as const;
const REPLY_BIT = 0x80;
const METHOD_COMMAND = 4;
const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 512 * 1024 * 1024 + 1024 * 1024;
/** A deadline no row's legal frame comes near. */
const ROOMY_MS = 20_000;
/** A deadline the heaviest legal frame (a default-limit heightfield) runs past. */
const TIGHT_MS = 25;
/** How long a process gets to exit after its fault. */
const EXIT_WAIT_MS = 10_000;
const START_MS = 300;
/** How far past a deadline a failure may land (watchdog wake-up, a loaded machine). */
const SLACK_MS = 2_000;
const HEIGHTFIELD_SIDE = 1024;
const IDENTITY: Physics.Quat = [0, 0, 0, 1];
const DESC: Physics.WorldDesc = {
  contract: "1.0",
  dt: 1 / 60,
  substeps: 1,
  gravity: [0, -9.81, 0],
  upAxis: "y",
  lengthUnit: 1,
};

type NativeModule = typeof Native;

function needsBuild(): { skip?: string } {
  if (existsSync(path.join(PACKAGE, "native.js"))) return {};
  const missing = `the native physics test build (${PACKAGE}; node scripts/physics-native.ts --test)`;
  if (process.env.GENEX_REQUIRE_TOOLCHAINS === "1") throw new Error(`GENEX_REQUIRE_TOOLCHAINS=1: ${missing} absent`);
  return { skip: `not run: ${missing} absent` };
}

const gate = needsBuild();
const native: NativeModule | undefined = gate.skip
  ? undefined
  : await import(pathToFileURL(path.join(PACKAGE, "native.js")).href);
const rooms = await tmpDir("gxph-hostile-");

function lib(): NativeModule {
  assert.ok(native, "the package loaded");
  return native;
}

function binary(): { binaryPath: string; sha256: string } {
  const found = lib().packagedBinary();
  assert.ok(found, "the package has this host's binary");
  return found;
}

after(() => assert.equal(native?.liveCores() ?? 0, 0, "every core this file started has ended"));

// ---------------------------------------------------------------------------------------------
// Raw frames.

const u8 = (value: number) => Buffer.of(value);
const u32 = (value: number) => {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value, 0);
  return out;
};
const f64 = (value: number) => {
  const out = Buffer.alloc(8);
  out.writeDoubleLE(value, 0);
  return out;
};
const text = (value: string | Buffer) => {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return Buffer.concat([u32(bytes.length), bytes]);
};
/** A frame: its length (kind byte and payload), the kind, the payload. */
const frame = (kind: number, ...payload: Buffer[]) => {
  const body = Buffer.concat([u8(kind), ...payload]);
  return Buffer.concat([u32(body.length), body]);
};
const hello = () => frame(Kind.Hello, u32(PROTOCOL_VERSION));
const create = () => frame(Kind.Create, text(JSON.stringify(DESC)));

/** A process driven by hand: its FIFOs open, its exit awaited. */
interface Raw {
  child: ChildProcess;
  input: number;
  output: number;
  exit: Promise<number | null>;
}

async function rawProcess(deadlineMs: number): Promise<Raw> {
  const folder = await tmpDir("gxph-raw-");
  const child = spawn(binary().binaryPath, [folder, String(deadlineMs)], { stdio: "ignore" });
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  while (!existsSync(path.join(folder, "out"))) await sleep(1);
  const input = openSync(path.join(folder, "in"), constants.O_WRONLY);
  const output = openSync(path.join(folder, "out"), constants.O_RDONLY);
  return { child, input, output, exit };
}

/** Writes `bytes`; a process that already exited makes it EPIPE, which the row does not judge. */
function send(raw: Raw, bytes: Buffer): void {
  try {
    writeSync(raw.input, bytes);
  } catch {
    // The process ended mid-write: its exit code says why.
  }
}

/** Reads one reply and returns its kind; 0 for EOF. */
function reply(raw: Raw): number {
  const head = Buffer.alloc(4);
  if (readSync(raw.output, head, 0, 4, null) === 0) return 0;
  const body = Buffer.alloc(head.readUInt32LE(0));
  let got = 0;
  while (got < body.length) got += readSync(raw.output, body, got, body.length - got, null);
  return body[0];
}

/** Everything left to read before EOF. */
function rest(raw: Raw): number {
  const buffer = Buffer.alloc(4096);
  let total = 0;
  for (let read = readSync(raw.output, buffer, 0, buffer.length, null); read > 0; ) {
    total += read;
    read = readSync(raw.output, buffer, 0, buffer.length, null);
  }
  return total;
}

async function exited(raw: Raw): Promise<number | null> {
  const code = await Promise.race([raw.exit, sleep(EXIT_WAIT_MS).then(() => "timeout" as const)]);
  if (code === "timeout") raw.child.kill("SIGKILL");
  closeSync(raw.input);
  closeSync(raw.output);
  assert.notEqual(code, "timeout", "the process ended");
  return code as number | null;
}

/** A row: the valid frames before it (each answered), then the hostile bytes. */
interface FrameRow {
  name: string;
  before: Buffer[];
  hostile: Buffer;
}

const NAN_TICK = frame(Kind.Tick, u32(0), u8(0), f64(Number.NaN), u8(0));
const frameRows: FrameRow[] = [
  { name: "half a length", before: [], hostile: Buffer.of(3, 0) },
  { name: "a zero length", before: [], hostile: u32(0) },
  { name: "a length past the cap", before: [], hostile: u32(MAX_FRAME_BYTES + 1) },
  { name: "an unknown kind", before: [], hostile: frame(0x42) },
  { name: "a reply's kind sent as a request", before: [], hostile: frame(Kind.Hello | REPLY_BIT, u32(1)) },
  { name: "a frame before Hello", before: [], hostile: create() },
  { name: "a second Hello (replayed)", before: [hello()], hostile: hello() },
  { name: "a tick before Create", before: [hello()], hostile: frame(Kind.Tick, u32(0), u8(1), f64(-1), u8(0)) },
  {
    name: "a description that is not UTF-8",
    before: [hello()],
    hostile: frame(Kind.Create, text(Buffer.of(0xc3, 0x28))),
  },
  { name: "a second Create", before: [hello(), create()], hostile: create() },
  {
    name: "a payload cut short",
    before: [hello(), create()],
    hostile: Buffer.concat([u32(100), u8(Kind.Call), Buffer.alloc(10)]),
  },
  {
    name: "a tick claiming more batches than it carries",
    before: [hello(), create()],
    hostile: frame(Kind.Tick, u32(1_000_000), text("[]")),
  },
  { name: "a tick exporting since NaN", before: [hello(), create()], hostile: NAN_TICK },
  { name: "a step flag of 2", before: [hello(), create()], hostile: frame(Kind.Tick, u32(0), u8(2), f64(-1), u8(0)) },
  { name: "an unknown method", before: [hello(), create()], hostile: frame(Kind.Call, u8(0)) },
  { name: "a call with a byte left over", before: [hello(), create()], hostile: frame(Kind.Call, u8(17), u8(0)) },
  {
    name: "a static world whose counts run past the frame",
    before: [hello(), create()],
    hostile: frame(Kind.AddStatic, u32(1), u32(6), u32(9_999)),
  },
  {
    name: "a valid spawn whose frame then runs short",
    before: [hello(), create()],
    hostile: frame(Kind.Tick, u32(1), text('[{"wake":{"key":"a"}}]'), u8(1), f64(0)),
  },
  {
    name: "a string length past the payload",
    before: [hello(), create()],
    hostile: frame(Kind.Call, u8(METHOD_COMMAND), u32(64), Buffer.from("{}")),
  },
];

describe("@genex-ai/physics-native: the hostile frame table, raw on the process", gate, () => {
  for (const row of frameRows) {
    it(`${row.name} ends the process with exit 3 and no reply`, async () => {
      const raw = await rawProcess(ROOMY_MS);
      for (const valid of row.before) {
        send(raw, valid);
        assert.equal(reply(raw) & ~REPLY_BIT, valid[4], "a valid frame before it was answered");
      }
      send(raw, row.hostile);
      closeSync(raw.input);
      raw.input = openSync("/dev/null", constants.O_WRONLY);
      assert.equal(rest(raw), 0, "nothing of the hostile frame was answered");
      assert.equal(await exited(raw), EXIT_PROTOCOL);
    });
  }

  it("a frame past the process's own deadline ends it with exit 4 and no reply", async () => {
    const raw = await rawProcess(TIGHT_MS);
    for (const valid of [hello(), create()]) {
      send(raw, valid);
      assert.notEqual(reply(raw), 0);
    }
    send(raw, frame(Kind.Call, u8(METHOD_COMMAND), text(JSON.stringify({ spawn: heightfield("ground") }))));
    assert.equal(rest(raw), 0);
    assert.equal(await exited(raw), EXIT_DEADLINE);
  });
});

// ---------------------------------------------------------------------------------------------
// Through the client.

function heightfield(key: string): Physics.BodyDesc {
  const side = HEIGHTFIELD_SIDE;
  const heights = Array.from({ length: side * side }, (_, i) => Math.fround(Math.sin(i) * 0.37));
  const shape: Physics.Shape = { kind: "heightfield", rows: side, cols: side, heights, size: [1000, 10, 1000] };
  return { key, type: "fixed", pose: { p: [0, 0, 0], q: IDENTITY }, colliders: [{ key: "hf", shape }] };
}

function crate(key: string, x: number, y: number): Physics.BodyDesc {
  return {
    key,
    type: "dynamic",
    pose: { p: [x, y, 0], q: IDENTITY },
    colliders: [{ key: "c", shape: { kind: "box", half: [0.4, 0.4, 0.4] } }],
  };
}

/** A started core with a world of a floor and 64 crates. */
function world(deadlineMs = ROOMY_MS): { core: Native.NativeCore; world: Physics.World } {
  const started = lib().createNativeCore({ ...binary(), dir: rooms, deadlineMs });
  assert.ok(started.ok, JSON.stringify(started));
  const made = started.core.createWorld(DESC);
  assert.ok(made.ok, JSON.stringify(made));
  const floor = { ...crate("floor", 0, -1), type: "fixed" as const };
  floor.colliders = [{ key: "c", shape: { kind: "box", half: [50, 1, 50] } }];
  const spawns = [floor, ...Array.from({ length: 64 }, (_, i) => crate(`c${i}`, (i % 8) - 4, 1 + Math.floor(i / 8)))];
  const applied = made.world.apply(
    spawns.map((desc) => ({ spawn: desc })),
    "each",
  );
  assert.ok(Array.isArray(applied) && applied.every((result) => result.ok));
  return { core: started.core, world: made.world };
}

function code(result: unknown): string {
  const failed = result as Physics.Failure;
  assert.equal(failed.ok, false, JSON.stringify(result));
  return failed.code;
}

/** The world answers `internal` with a result and empty reads, for good; its folder is gone. */
function assertGone(core: Native.NativeCore, w: Physics.World): void {
  assert.equal(core.alive(), false);
  assert.equal(code(w.step()), "internal");
  assert.equal(code(core.runTick({ step: true })), "internal");
  assert.deepEqual([w.body("c0"), w.stateHash(), w.tick, w.snapshot().length], [null, "", 0, 0]);
}

function roomsLeft(): string[] {
  return readdirSync(rooms).filter((name) => name.startsWith("room-"));
}

describe("@genex-ai/physics-native: a failed process fails its own world only", gate, () => {
  it("a process killed with SIGKILL mid-tick answers internal, and a sibling steps on", async () => {
    const victim = world();
    const sibling = world();
    const killer = spawn("/bin/sh", ["-c", `sleep 0.2; kill -9 ${victim.core.pid}`], { stdio: "ignore" });
    const killed = new Promise((resolve) => killer.on("exit", resolve));
    await sleep(0);
    const until = performance.now() + EXIT_WAIT_MS;
    let last: ReturnType<Native.NativeCore["runTick"]> | undefined;
    while (performance.now() < until) {
      last = victim.core.runTick({
        step: true,
        exportSince: 0,
        queries: [{ overlap: { shape: { kind: "sphere", radius: 20 }, pose: { p: [0, 0, 0], q: IDENTITY } } }],
      });
      if (!last.ok) break;
      await sleep(0);
    }
    await killed;
    assert.equal(code(last), "internal", "the tick in flight, or the next, answered internal");
    assertGone(victim.core, victim.world);
    for (let i = 0; i < 30; i += 1) assert.ok(sibling.world.step().ok);
    assert.equal(sibling.core.alive(), true);
    victim.world.free();
    sibling.world.free();
  });

  it("a call to a process that is already gone (EPIPE) answers internal and throws nothing", async () => {
    const victim = world();
    const pid = victim.core.pid;
    process.kill(pid, "SIGKILL");
    while (running(pid)) await sleep(5);
    let stepped: unknown;
    assert.doesNotThrow(() => {
      stepped = victim.world.step();
    });
    assert.equal(code(stepped), "internal");
    assertGone(victim.core, victim.world);
    victim.world.free();
  });

  it("a frame past the deadline ends the process and answers internal near the deadline", () => {
    const slow = world(TIGHT_MS);
    const sibling = world();
    const start = performance.now();
    assert.equal(code(slow.world.spawn(heightfield("ground"))), "internal");
    const took = performance.now() - start;
    assert.ok(took < TIGHT_MS + SLACK_MS + 1_500, `it answered after ${took} ms`);
    assertGone(slow.core, slow.world);
    assert.ok(sibling.world.step().ok, "the sibling never noticed");
    slow.world.free();
    sibling.world.free();
    assert.deepEqual(roomsLeft(), [], "every ended core removed its folder");
  });
});

describe("@genex-ai/physics-native: starting refuses what it must, starting nothing", gate, () => {
  const badOptions: [string, (good: Native.NativeCoreOptions) => unknown][] = [
    ["no options", () => undefined],
    ["null", () => null],
    ["a relative binary path", (good) => ({ ...good, binaryPath: "genex-physics-room" })],
    ["an uppercase sha256", (good) => ({ ...good, sha256: good.sha256.toUpperCase() })],
    ["a short sha256", (good) => ({ ...good, sha256: good.sha256.slice(1) })],
    ["a deadline of 0", (good) => ({ ...good, deadlineMs: 0 })],
    ["a fractional deadline", (good) => ({ ...good, deadlineMs: 1.5 })],
    ["a deadline as a string", (good) => ({ ...good, deadlineMs: "16" })],
    ["a deadline past ten minutes", (good) => ({ ...good, deadlineMs: 600_001 })],
    ["a relative folder", (good) => ({ ...good, dir: "rooms" })],
    ["a folder that does not exist", (good) => ({ ...good, dir: path.join(rooms, "missing") })],
    ["a stderr of pipe", (good) => ({ ...good, stderr: "pipe" })],
    ["a sha256 that is not the binary's", (good) => ({ ...good, sha256: "0".repeat(64) })],
    ["a binary that does not exist", (good) => ({ ...good, binaryPath: path.join(rooms, "nothing") })],
  ];
  for (const [name, options] of badOptions) {
    it(`refuses ${name} with internal, starting no process and making no folder`, () => {
      const good = { ...binary(), dir: rooms, deadlineMs: ROOMY_MS };
      const before = [roomsLeft(), lib().liveCores()];
      const started = lib().createNativeCore(options(good) as Native.NativeCoreOptions);
      assert.equal(code(started), "internal");
      assert.deepEqual([roomsLeft(), lib().liveCores()], before);
    });
  }

  /** A shell script as a binary, with its own sha256. */
  async function script(body: string): Promise<{ binaryPath: string; sha256: string }> {
    const dir = await tmpDir("gxph-script-");
    const binaryPath = path.join(dir, "fake-room");
    writeFileSync(binaryPath, `#!/bin/sh\n${body}\n`);
    chmodSync(binaryPath, 0o755);
    return { binaryPath, sha256: createHash("sha256").update(readFileSync(binaryPath)).digest("hex") };
  }

  const fakes: [string, string][] = [
    ["never makes its FIFOs", "exec sleep 30"],
    ["makes its FIFOs and never opens them", 'mkfifo "$1/in" "$1/out"; exec sleep 30'],
    [
      "answers Hello with garbage",
      'mkfifo "$1/in" "$1/out"; exec 3<"$1/in" 4>"$1/out"; printf "garbage!" >&4; exec sleep 30',
    ],
  ];
  for (const [name, body] of fakes) {
    it(`gives up on a binary that ${name} within the start's deadline, leaving nothing`, async () => {
      const fake = await script(body);
      const start = performance.now();
      const started = lib().createNativeCore({ ...fake, dir: rooms, deadlineMs: ROOMY_MS, startMs: START_MS });
      const took = performance.now() - start;
      assert.equal(code(started), "internal");
      assert.ok(took < START_MS + SLACK_MS, `it gave up after ${took} ms`);
      assert.deepEqual(roomsLeft(), []);
      assert.equal(lib().liveCores(), 0);
    });
  }
});

/** A full garbage collection, with time for finalizers to run. */
async function collect(): Promise<void> {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  for (let i = 0; i < 5; i += 1) {
    gc();
    await sleep(20);
  }
}

describe("@genex-ai/physics-native: a process lives as long as its core or its world", gate, () => {
  it("keeps the process of a world whose core was dropped, and ends one whose core and world were", async () => {
    const made = lib().nativePhysics({ ...binary(), dir: rooms, deadlineMs: ROOMY_MS });
    assert.ok(made.ok, JSON.stringify(made));
    let kept: Physics.World | undefined = ok(made.physics.World.create(DESC));
    const before = lib().liveCores();
    let dropped: Physics.World | undefined = ok(made.physics.World.create(DESC));
    assert.equal(lib().liveCores(), before + 1);
    dropped = undefined;
    await collect();
    assert.equal(dropped, undefined);
    assert.equal(lib().liveCores(), before, "the dropped world's process ended");
    assert.ok(kept.step().ok, "the kept world's process, its core long dropped, still answers");
    kept.free();
    kept = undefined;
    assert.equal(lib().liveCores(), before - 1);
  });
});

function ok(result: Physics.Result<{ world: Physics.World }>): Physics.World {
  assert.ok(result.ok, JSON.stringify(result));
  return result.world;
}
