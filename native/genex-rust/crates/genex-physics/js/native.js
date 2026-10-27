// @genex-ai/physics-native: Genex Physics in a process of its own per world (contract 1.0; §
// numbers are CONTRACT.md's), for the authority server's rooms on Node 24, Linux and macOS.
//
// `createNativeCore` starts one `genex-physics-room` process (crates/genex-physics-sidecar) after
// checking its binary's sha256, and speaks its frame protocol over the two FIFOs it makes:
// blocking `writeSync`/`readSync` round trips, about 0.01 ms each, so a room's synchronous tick
// stays synchronous. The core makes one world (`createWorld`), a `World` of `@genex-ai/physics`
// itself (its `core.js`, through `bindWire`), so the API, the encoding, the budgets and every
// result form are the WASM package's own; `runTick` runs a whole room tick in one round trip.
//
// - Isolation: a crash, hang or protocol fault of the process ends that core alone. Its world then
//   answers `internal` to every call with a result and its reads their empty forms, for good, as a
//   trapped WASM instance does (§11.3); nothing is thrown. Other cores never notice.
// - Deadline: every round trip has `deadlineMs`. The process ends itself past it (exit 4), and a
//   watchdog thread here (one `worker_thread` per JS thread, waiting on a SharedArrayBuffer at no
//   CPU) SIGKILLs it, which ends the blocked read with EOF. Opening the FIFOs has `startMs`.
// - A malformed frame or reply is a fault: the process exits 3 before running any of it; a reply
//   this side cannot read kills the process. Either way the core is dead.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { endianness } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { bindWire, PhysicsError, tickWorld } from "@genex-ai/physics/binding";

/** The frame protocol's version (crates/genex-physics-sidecar/src/protocol.rs). */
const PROTOCOL_VERSION = 2;
/** Request kinds; a reply's kind is its request's with `REPLY_BIT` set. */
const Kind = Object.freeze({ Hello: 1, Create: 2, AddStatic: 3, Tick: 4, Call: 5, Shutdown: 6 });
const REPLY_BIT = 0x80;
/** `Call` method bytes (protocol.rs `Method`). */
const Method = Object.freeze({
  Check: 1,
  Desc: 2,
  TickCount: 3,
  Command: 4,
  Apply: 5,
  Step: 6,
  Body: 7,
  Bodies: 8,
  ExportChanged: 9,
  ExportBodyState: 10,
  ImportBodyState: 11,
  ImportStates: 12,
  QueryMany: 13,
  Query: 14,
  Snapshot: 15,
  Restore: 16,
  StateHash: 17,
  PhysicsHash: 18,
  Stats: 19,
  MemoryIsMeasured: 20,
});
/** The largest frame either side sends, kind byte included (frame.rs `MAX_FRAME_BYTES`). */
export const MAX_FRAME_BYTES = 512 * 1024 * 1024 + 1024 * 1024;
const LENGTH_BYTES = 4;
/** A reply's head after its length: the kind byte and `u64 cpuNs`. */
const REPLY_HEAD_BYTES = 9;
/** A request's head: its length and its kind byte. */
const FRAME_HEAD_BYTES = LENGTH_BYTES + 1;
/** The deadline's range in milliseconds, inclusive (lib.rs `DEADLINE_MS`). */
const DEADLINE_MS_MIN = 1;
const DEADLINE_MS_MAX = 600_000;
/** The request buffer a process's ticks are framed in, grown as a tick needs. */
const FRAME_BUFFER_BYTES = 4096;
const FRAME_BUFFER_KEPT = 1024 * 1024;
/** How long starting a process (spawn, FIFOs, opening them, `Hello`) may take by default. */
const START_MS = 5_000;
/** How often the start looks for the FIFOs. */
const POLL_MS = 1;
const SHA256 = /^[0-9a-f]{64}$/;
/** What `world_record_step_ms` answers: the process timed its own step (§11.4). */
const OK_TEXT = '{"ok":true}';
/** The FIFOs the process makes in its folder. */
const FIFO_IN = "in";
const FIFO_OUT = "out";
/** The prefix of each core's folder under the caller's `dir`. */
const ROOM_PREFIX = "room-";

const Detail = Object.freeze({
  Poisoned: "this world's physics process ended or failed (§11.3): make a new core for a new world",
  Stale: "this world's physics process ended (§11.3)",
  BadOptions:
    "options are { binaryPath, sha256, dir, deadlineMs, startMs? }: absolute paths, a lowercase sha256, whole milliseconds 1-600000",
  BigEndian: "the frame protocol is little-endian; this host is not",
  Sha: "the binary's sha256 is not the one given: nothing was started",
  Unreadable: "the binary could not be read: nothing was started",
  Spawn: "the physics process could not be started",
  Start: "the physics process did not open its FIFOs in time",
  Hello: "the physics process did not answer Hello as this protocol version",
  OneWorld: "a native core makes one world (one process per room); make another core",
  NoWorld: "this core has no world yet: createWorld first",
});

/** A failure value (§14). */
function failure(code, detail) {
  return { ok: false, code, detail };
}

/** Thrown inside a round trip only: the binding catches it and poisons the core (core.js `guarded`). */
class SidecarGone extends Error {}

// ---------------------------------------------------------------------------------------------
// The watchdog.

/** Slots of the watchdog's shared Int32Array. */
const Slot = Object.freeze({ State: 0, DeadlineMs: 1, Pid: 2, Fired: 3, Sequence: 4, RescueLength: 5 });
const WatchState = Object.freeze({ Idle: 0, Armed: 1 });
const WATCH_SLOTS = 16;
const RESCUE_AT = WATCH_SLOTS * Int32Array.BYTES_PER_ELEMENT;
const RESCUE_BYTES = 4096;
/** How often a fired watchdog opens the FIFOs' other ends while a start still waits on them. */
const RESCUE_EVERY_MS = 2;

/**
 * The watchdog thread (CommonJS, run with `eval`). Armed, it waits the deadline on the State slot;
 * if the same call is still armed then, it SIGKILLs the process, which ends the main thread's
 * blocked read with EOF and its write with EPIPE. While the main thread waits to open the FIFOs it
 * names their folder: opening each FIFO's other end without blocking releases a blocked open, and
 * the dead process's FIFOs then answer EOF and EPIPE too.
 */
const WATCHDOG_SOURCE = `
const { workerData } = require("node:worker_threads");
const fs = require("node:fs");
const flags = new Int32Array(workerData.sab, 0, ${WATCH_SLOTS});
const rescueBytes = new Uint8Array(workerData.sab, ${RESCUE_AT}, ${RESCUE_BYTES});
const { O_RDONLY, O_WRONLY, O_NONBLOCK } = fs.constants;
const armed = (sequence) => Atomics.load(flags, ${Slot.State}) === ${WatchState.Armed} && Atomics.load(flags, ${Slot.Sequence}) === sequence;
const release = (folder) => {
  for (const [name, mode] of [["${FIFO_IN}", O_RDONLY | O_NONBLOCK], ["${FIFO_OUT}", O_WRONLY | O_NONBLOCK]]) {
    try { fs.closeSync(fs.openSync(folder + "/" + name, mode)); } catch {}
  }
};
for (;;) {
  Atomics.wait(flags, ${Slot.State}, ${WatchState.Idle});
  const sequence = Atomics.load(flags, ${Slot.Sequence});
  if (Atomics.wait(flags, ${Slot.State}, ${WatchState.Armed}, Atomics.load(flags, ${Slot.DeadlineMs})) !== "timed-out") continue;
  if (!armed(sequence)) continue;
  try { process.kill(Atomics.load(flags, ${Slot.Pid}), "SIGKILL"); } catch {}
  Atomics.add(flags, ${Slot.Fired}, 1);
  const length = Atomics.load(flags, ${Slot.RescueLength});
  const folder = length > 0 ? Buffer.from(rescueBytes.subarray(0, length)).toString("utf8") : "";
  while (armed(sequence)) {
    if (folder !== "") release(folder);
    Atomics.wait(flags, ${Slot.State}, ${WatchState.Armed}, ${RESCUE_EVERY_MS});
  }
}
`;

/** This JS thread's watchdog, started on first use. */
let watchdog;

function watch() {
  if (watchdog !== undefined) return watchdog;
  const sab = new SharedArrayBuffer(RESCUE_AT + RESCUE_BYTES);
  const worker = new Worker(WATCHDOG_SOURCE, { eval: true, workerData: { sab } });
  worker.unref();
  watchdog = { flags: new Int32Array(sab, 0, WATCH_SLOTS), rescue: new Uint8Array(sab, RESCUE_AT, RESCUE_BYTES) };
  return watchdog;
}

/** Arms the watchdog for one call on `pid`; `folder` names the FIFOs while they are being opened. */
function arm(pid, deadlineMs, folder) {
  const { flags, rescue } = watch();
  const named = folder === undefined ? 0 : rescue.byteLength;
  const written = folder === undefined ? 0 : Buffer.from(rescue.buffer, RESCUE_AT, named).write(folder, "utf8");
  Atomics.store(flags, Slot.RescueLength, written);
  Atomics.store(flags, Slot.DeadlineMs, deadlineMs);
  Atomics.store(flags, Slot.Pid, pid);
  Atomics.add(flags, Slot.Sequence, 1);
  Atomics.store(flags, Slot.State, WatchState.Armed);
  Atomics.notify(flags, Slot.State);
}

function disarm() {
  const { flags } = watch();
  Atomics.store(flags, Slot.State, WatchState.Idle);
  Atomics.notify(flags, Slot.State);
}

/** How many processes the watchdog has killed (for this package's tests). */
export function watchdogKills() {
  return watchdog === undefined ? 0 : Atomics.load(watchdog.flags, Slot.Fired);
}

/** Blocks this thread for `ms` (the start's wait for the FIFOs is synchronous). */
const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
function sleepSync(ms) {
  Atomics.wait(sleeper, 0, 0, ms);
}

// ---------------------------------------------------------------------------------------------
// Frames.

/** A frame being written: its parts, and its size after the length prefix. */
class FrameWriter {
  constructor(kind) {
    this.parts = [];
    this.size = 0;
    this.u8(kind);
  }

  push(buffer) {
    this.parts.push(buffer);
    this.size += buffer.length;
    return this;
  }

  u8(value) {
    return this.push(Buffer.of(value));
  }

  bool(value) {
    return this.u8(value ? 1 : 0);
  }

  u32(value) {
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeUInt32LE(value, 0);
    return this.push(buffer);
  }

  f64(value) {
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeDoubleLE(value, 0);
    return this.push(buffer);
  }

  /** A typed array's bytes as they lie in memory (little-endian: `createNativeCore` checks). */
  view(array) {
    return this.push(Buffer.from(array.buffer, array.byteOffset, array.byteLength));
  }

  bytes(array) {
    return this.u32(array.byteLength).view(array);
  }

  str(text) {
    const buffer = Buffer.from(text, "utf8");
    return this.u32(buffer.length).push(buffer);
  }

  optStr(text) {
    this.bool(text !== undefined);
    return text === undefined ? this : this.str(text);
  }

  /** A counted array of numbers in `array`'s own element type. */
  array(array) {
    return this.u32(array.length).view(array);
  }

  /** The frame's bytes, or `undefined` past `MAX_FRAME_BYTES`. */
  finish() {
    if (this.size > MAX_FRAME_BYTES) return undefined;
    const head = Buffer.allocUnsafe(LENGTH_BYTES);
    head.writeUInt32LE(this.size, 0);
    return Buffer.concat([head, ...this.parts], LENGTH_BYTES + this.size);
  }
}

/** A cursor over a reply; a field it cannot read whole is a protocol fault. */
class ReplyReader {
  constructor(buffer, at) {
    this.buffer = buffer;
    this.at = at;
  }

  need(count) {
    if (this.at + count > this.buffer.length) throw new SidecarGone("a reply ran short");
    const at = this.at;
    this.at += count;
    return at;
  }

  u8() {
    return this.buffer[this.need(1)];
  }

  bool() {
    const value = this.u8();
    if (value > 1) throw new SidecarGone("a reply flag is not 0 or 1");
    return value === 1;
  }

  u32() {
    return this.buffer.readUInt32LE(this.need(4));
  }

  f64() {
    return this.buffer.readDoubleLE(this.need(8));
  }

  bytes() {
    const length = this.u32();
    const at = this.need(length);
    return Uint8Array.prototype.slice.call(this.buffer, at, at + length);
  }

  str() {
    const length = this.u32();
    const at = this.need(length);
    return this.buffer.toString("utf8", at, at + length);
  }

  optStr() {
    return this.bool() ? this.str() : undefined;
  }

  /** A counted f32 array, copied out bit for bit into an aligned Float32Array. */
  f32s() {
    const count = this.u32();
    const at = this.need(count * Float32Array.BYTES_PER_ELEMENT);
    const out = new Float32Array(count);
    new Uint8Array(out.buffer).set(this.buffer.subarray(at, at + out.byteLength));
    return out;
  }

  /** Refuses bytes left over. */
  done() {
    if (this.at !== this.buffer.length) throw new SidecarGone("a reply has bytes left over");
  }
}

// ---------------------------------------------------------------------------------------------
// One process.

/** Cores whose process may still run, for `liveCores` and the exit sweep. */
const live = new Set();

/** How many cores of this JS thread still hold a process (for this package's tests). */
export function liveCores() {
  return live.size;
}

/** Writes all of `buffer`; a pipe may take it in parts. */
function writeAll(fd, buffer) {
  let written = 0;
  while (written < buffer.length) written += writeSync(fd, buffer, written, buffer.length - written);
}

/** Reads into `buffer` from `got` until it holds `length` bytes, taking whatever each read gives up to its end; EOF first is the process gone. */
function readUntil(fd, buffer, got, length) {
  let have = got;
  while (have < length) {
    const read = readSync(fd, buffer, have, buffer.length - have, null);
    if (read === 0) throw new SidecarGone("the physics process closed its end");
    have += read;
  }
  return have;
}

/**
 * Reads one reply into `proc.buffer` (its length prefix at 0) and returns its length. Each read takes
 * all the FIFO holds, so a reply that has arrived is one read; the process never writes before it is
 * asked, so a read cannot take a later reply's bytes, and bytes past this reply are a fault.
 */
function readReply(proc) {
  const got = readUntil(proc.output, proc.buffer, 0, LENGTH_BYTES);
  const length = proc.buffer.readUInt32LE(0);
  if (length < REPLY_HEAD_BYTES || length > MAX_FRAME_BYTES) throw new SidecarGone("a reply of a bad length");
  const total = LENGTH_BYTES + length;
  if (proc.buffer.length < total) {
    const grown = Buffer.allocUnsafe(total);
    proc.buffer.copy(grown, 0, 0, got);
    proc.buffer = grown;
  }
  if (readUntil(proc.output, proc.buffer, got, total) !== total) throw new SidecarGone("a reply ran past its length");
  return length;
}

/** Ends a core's process and removes its folder; idempotent. */
function end(proc) {
  if (proc.dead) return;
  proc.dead = true;
  live.delete(proc);
  try {
    process.kill(proc.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  for (const fd of [proc.input, proc.output]) {
    if (fd === undefined) continue;
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
  }
  rmSync(proc.folder, { recursive: true, force: true });
}

/**
 * A process whose core was dropped without `close()` and whose world (if any) was dropped too: its
 * world keeps the core reachable (`owners`), so a caller holding only the world keeps its process.
 */
const reaper = new FinalizationRegistry((proc) => end(proc));
/** Each world's core, so the world keeps it (and its process) alive. */
const owners = new WeakMap();

/**
 * One round trip: writes `frame` and reads the reply of `kind`, under the watchdog. Returns the
 * reply's reader past its head. Throws `SidecarGone` (after ending the process) on EOF, EPIPE, a
 * deadline, an oversize or wrong reply, or a frame too large to send.
 */
function roundTrip(proc, frame, kind, deadlineMs = proc.deadlineMs) {
  if (proc.dead) throw new SidecarGone("the physics process has ended");
  if (frame === undefined) {
    end(proc);
    throw new SidecarGone("a frame over the protocol's size");
  }
  arm(proc.pid, deadlineMs, undefined);
  try {
    writeAll(proc.input, frame);
    const length = readReply(proc);
    const reply = proc.buffer.subarray(LENGTH_BYTES, LENGTH_BYTES + length);
    if (reply[0] !== (kind | REPLY_BIT)) throw new SidecarGone("a reply of the wrong kind");
    const cpuNs = Number(reply.readBigUInt64LE(1));
    proc.cpuNs += cpuNs;
    proc.lastCpuNs = cpuNs;
    proc.frames += 1;
    return new ReplyReader(reply, REPLY_HEAD_BYTES);
  } catch (error) {
    end(proc);
    throw error instanceof SidecarGone ? error : new SidecarGone(String(error?.code ?? error));
  } finally {
    disarm();
  }
}

/** A `Call` of `method` with `args` written by `write`, its reply read by `read`. */
function call(proc, method, write, read) {
  const frame = new FrameWriter(Kind.Call).u8(method);
  write?.(frame);
  const reply = roundTrip(proc, frame.finish(), Kind.Call);
  const value = read(reply);
  reply.done();
  return value;
}

const readText = (reply) => reply.str();

/** A frame of `kind` whose reply is one string. */
function textFrame(proc, kind, write) {
  const frame = new FrameWriter(kind);
  write(frame);
  const reply = roundTrip(proc, frame.finish(), kind);
  const text = reply.str();
  reply.done();
  return text;
}

/**
 * The wire `core.js` drives: the glue's exports, each one round trip (the world id is implicit:
 * the process holds one world). `world_tick_frame` is `runTick`'s: the binary tick in one `Tick`
 * frame (crates/genex-physics-binding/src/tick.rs), `tick_cpu_ns` its process CPU.
 */
function wireOf(proc) {
  const text = (method) => () => call(proc, method, undefined, readText);
  const withText = (method) => (_id, value) => call(proc, method, (f) => f.str(value), readText);
  return {
    build_id: () => proc.buildId,
    live_worlds: () => (proc.world && !proc.dead ? 1 : 0),
    world_create: (desc) => textFrame(proc, Kind.Create, (f) => f.str(desc)),
    world_free: () => close(proc),
    world_check: text(Method.Check),
    world_desc: text(Method.Desc),
    world_tick: () => call(proc, Method.TickCount, undefined, (r) => r.f64()),
    world_command: withText(Method.Command),
    world_apply: (_id, commands, atomic) => call(proc, Method.Apply, (f) => f.str(commands).bool(atomic), readText),
    world_add_static: (_id, boxLengths, boxes, rampLengths, ramps) =>
      textFrame(proc, Kind.AddStatic, (f) => f.array(boxLengths).array(boxes).array(rampLengths).array(ramps)),
    world_step: text(Method.Step),
    world_record_step_ms: () => OK_TEXT,
    world_body: withText(Method.Body),
    world_bodies: (_id, kinds, awakeOnly, since) =>
      call(proc, Method.Bodies, (f) => f.optStr(kinds).bool(awakeOnly).f64(since), readText),
    world_export_changed: (_id, since) =>
      call(
        proc,
        Method.ExportChanged,
        (f) => f.f64(since),
        (r) => {
          const keys = r.str();
          proc.changed = r.f32s();
          return keys;
        },
      ),
    take_changed_data: () => {
      const data = proc.changed;
      proc.changed = new Float32Array(0);
      return data;
    },
    world_export_body_state: withText(Method.ExportBodyState),
    world_import_body_state: (_id, key, state) =>
      call(proc, Method.ImportBodyState, (f) => f.str(key).str(state), readText),
    world_import_states: (_id, keys, data) => call(proc, Method.ImportStates, (f) => f.str(keys).array(data), readText),
    world_query_many: withText(Method.QueryMany),
    world_query: withText(Method.Query),
    world_snapshot: () => call(proc, Method.Snapshot, undefined, (r) => (r.bool() ? r.bytes() : undefined)),
    world_restore: (_id, bytes) => call(proc, Method.Restore, (f) => f.bytes(bytes), readText),
    world_state_hash: text(Method.StateHash),
    world_physics_hash: text(Method.PhysicsHash),
    world_stats: text(Method.Stats),
    world_memory_is_measured: () => call(proc, Method.MemoryIsMeasured, undefined, (r) => r.bool()),
    world_tick_frame: (_id, request) => tickFrame(proc, request),
    tick_cpu_ns: () => proc.lastCpuNs,
  };
}

/**
 * A tick in one `Tick` frame: the request's bytes in (core.js `encodeTick`), the reply's out as a
 * view of this process's reply buffer, read by core.js before the next round trip. `undefined` past
 * the frame cap: core.js then makes the separate calls.
 */
function tickFrame(proc, request) {
  const size = 1 + request.length;
  if (size > MAX_FRAME_BYTES) return undefined;
  const frame = tickBuffer(proc, LENGTH_BYTES + size);
  frame.writeUInt32LE(size, 0);
  frame[LENGTH_BYTES] = Kind.Tick;
  frame.set(request, FRAME_HEAD_BYTES);
  const reply = roundTrip(proc, frame.subarray(0, LENGTH_BYTES + size), Kind.Tick);
  return reply.buffer.subarray(reply.at);
}

/** A buffer of at least `bytes` for a tick's frame: the process's own, grown up to `FRAME_BUFFER_KEPT`. */
function tickBuffer(proc, bytes) {
  if (bytes <= proc.frame.length) return proc.frame;
  const grown = Buffer.allocUnsafe(Math.max(bytes, proc.frame.length * 2));
  if (grown.length <= FRAME_BUFFER_KEPT) proc.frame = grown;
  return grown;
}

/** Sends `Shutdown` (the process frees its world and exits 0) and removes the folder; idempotent. */
function close(proc) {
  if (proc.dead) return false;
  try {
    roundTrip(proc, new FrameWriter(Kind.Shutdown).finish(), Kind.Shutdown);
  } catch {
    // The process was already gone; `end` below cleans up either way.
  }
  end(proc);
  return true;
}

/** Whether `value` is an absolute path string. */
function isAbsolutePath(value) {
  return typeof value === "string" && path.isAbsolute(value);
}

function isWholeMs(value) {
  return Number.isInteger(value) && value >= DEADLINE_MS_MIN && value <= DEADLINE_MS_MAX;
}

/** `options` read once, or `undefined` when they are not `createNativeCore`'s. */
function readOptions(options) {
  if (options === null || typeof options !== "object") return undefined;
  const { binaryPath, sha256, dir, deadlineMs, startMs = START_MS, stderr = "ignore" } = options;
  const pathsOk = isAbsolutePath(binaryPath) && isAbsolutePath(dir);
  const timesOk = isWholeMs(deadlineMs) && isWholeMs(startMs);
  const stderrOk = stderr === "ignore" || stderr === "inherit";
  if (!pathsOk || !timesOk || !stderrOk || typeof sha256 !== "string" || !SHA256.test(sha256)) return undefined;
  return { binaryPath, sha256, dir, deadlineMs, startMs, stderr };
}

/** Whether the file at `binaryPath` has sha256 `sha256`; `undefined` when it cannot be read. */
function binaryMatches(binaryPath, sha256) {
  try {
    return createHash("sha256").update(readFileSync(binaryPath)).digest("hex") === sha256;
  } catch {
    return undefined;
  }
}

/** Starts the process in a new folder under `options.dir`: the proc record, or a failure. */
function startProcess(options) {
  let folder;
  try {
    if (!statSync(options.dir).isDirectory()) return failure(PhysicsError.Internal, Detail.BadOptions);
    folder = mkdtempSync(path.join(options.dir, ROOM_PREFIX));
  } catch {
    return failure(PhysicsError.Internal, Detail.BadOptions);
  }
  const child = spawn(options.binaryPath, [folder, String(options.deadlineMs)], {
    stdio: ["ignore", "ignore", options.stderr],
    env: {},
  });
  child.on("error", () => {});
  child.unref();
  if (child.pid === undefined) {
    rmSync(folder, { recursive: true, force: true });
    return failure(PhysicsError.Internal, Detail.Spawn);
  }
  const proc = {
    pid: child.pid,
    folder,
    deadlineMs: options.deadlineMs,
    input: undefined,
    output: undefined,
    dead: false,
    world: false,
    buildId: "",
    cpuNs: 0,
    lastCpuNs: 0,
    frames: 0,
    changed: new Float32Array(0),
    buffer: Buffer.allocUnsafe(64 * 1024),
    frame: Buffer.allocUnsafe(FRAME_BUFFER_BYTES),
  };
  live.add(proc);
  return proc;
}

/** Waits for the FIFOs, opens them under the watchdog and says `Hello`: true when the process answered. */
function connect(proc, startMs) {
  const until = performance.now() + startMs;
  const outbound = path.join(proc.folder, FIFO_OUT);
  while (!existsSync(outbound)) {
    if (performance.now() > until) return false;
    sleepSync(POLL_MS);
  }
  arm(proc.pid, startMs, proc.folder);
  try {
    proc.input = openSync(path.join(proc.folder, FIFO_IN), constants.O_WRONLY);
    proc.output = openSync(outbound, constants.O_RDONLY);
  } catch {
    return false;
  } finally {
    disarm();
  }
  try {
    const reply = roundTrip(proc, new FrameWriter(Kind.Hello).u32(PROTOCOL_VERSION).finish(), Kind.Hello, startMs);
    const version = reply.u32();
    proc.buildId = reply.str();
    reply.done();
    return version === PROTOCOL_VERSION;
  } catch {
    return false;
  }
}

/**
 * Starts one physics process for one world (see the header). `options`: `binaryPath` (absolute)
 * and its `sha256` (checked before anything starts), `dir` (an existing folder: each core makes
 * its own `room-*` folder in it and removes it when it ends), `deadlineMs` (each round trip's
 * deadline), `startMs` (the start's, default 5000) and `stderr` (`"ignore"` or `"inherit"`).
 * Never throws: `{ ok: true, core }` or `{ ok: false, code: "internal", detail }`.
 */
export function createNativeCore(options) {
  const read = readOptions(options);
  if (read === undefined) return failure(PhysicsError.Internal, Detail.BadOptions);
  if (endianness() !== "LE") return failure(PhysicsError.Internal, Detail.BigEndian);
  const matches = binaryMatches(read.binaryPath, read.sha256);
  if (matches === undefined) return failure(PhysicsError.Internal, Detail.Unreadable);
  if (!matches) return failure(PhysicsError.Internal, Detail.Sha);
  const proc = startProcess(read);
  if (proc.ok === false) return proc;
  if (!connect(proc, read.startMs)) {
    end(proc);
    return failure(PhysicsError.Internal, Detail.Start);
  }
  const wire = wireOf(proc);
  const binding = bindWire(wire, { poisoned: Detail.Poisoned, stale: Detail.Stale, onPoison: () => end(proc) });
  if (binding === undefined) {
    end(proc);
    return failure(PhysicsError.Internal, Detail.Hello);
  }
  const core = coreOf(proc, binding, wire);
  reaper.register(core, proc, core);
  return { ok: true, core };
}

/** The core object `createNativeCore` hands out. */
function coreOf(proc, binding, wire) {
  let world;
  const core = {
    pid: proc.pid,
    buildId: () => binding.buildId(),
    createWorld(desc) {
      if (proc.world) return failure(PhysicsError.Internal, Detail.OneWorld);
      const made = binding.createWorld(desc);
      if (made.ok) {
        proc.world = true;
        world = made.world;
        owners.set(world, core);
      }
      return made;
    },
    runTick(input) {
      if (world === undefined) return failure(PhysicsError.Internal, Detail.NoWorld);
      return tickWorld(world, input);
    },
    alive: () => !proc.dead,
    /** Whether the process's counting allocator measures the world's memory (§11.1). */
    memoryIsMeasured() {
      if (proc.dead || !proc.world) return false;
      try {
        return wire.world_memory_is_measured();
      } catch {
        return false;
      }
    },
    /**
     * Sets this side's deadline for every later round trip (whole ms, 1-600000; false and unchanged
     * otherwise). The process keeps the start's own deadline, so a deadline above it changes nothing
     * the process does: a server starts cores with a generous deadline for setup frames (create,
     * restore, a heavy spawn) and sets a tick's before its ticks.
     */
    setDeadline(ms) {
      if (!isWholeMs(ms)) return false;
      proc.deadlineMs = ms;
      return true;
    },
    deadlineMs: () => proc.deadlineMs,
    cpuNs: () => proc.cpuNs,
    lastCpuNs: () => proc.lastCpuNs,
    frames: () => proc.frames,
    close() {
      reaper.unregister(core);
      close(proc);
    },
  };
  return core;
}

// ---------------------------------------------------------------------------------------------
// The package's own binaries.

/** This host's binary folder name, or `undefined` where none is built. */
export function platformKey() {
  if (process.platform === "darwin" && process.arch === "arm64") return "darwin-arm64";
  const glibc = process.platform === "linux" ? process.report?.getReport()?.header?.glibcVersionRuntime : undefined;
  if (process.platform === "linux" && process.arch === "x64" && glibc !== undefined) return "linux-x64-gnu";
  return undefined;
}

/**
 * This package's binary for this host and the sha256 its `binaries.json` records:
 * `{ binaryPath, sha256 }`, or `undefined` where the package has none. A server pins its own
 * sha256 instead of trusting this file.
 */
export function packagedBinary() {
  const key = platformKey();
  if (key === undefined) return undefined;
  try {
    const listed = JSON.parse(readFileSync(new URL("./binaries.json", import.meta.url), "utf8"))[key];
    const binaryPath = fileURLToPath(new URL(`./native/${key}/genex-physics-room`, import.meta.url));
    if (typeof listed?.sha256 !== "string" || !existsSync(binaryPath)) return undefined;
    return { binaryPath, sha256: listed.sha256 };
  } catch {
    return undefined;
  }
}

/**
 * `@genex-ai/physics`'s shape over native cores, one process per world, for code written against
 * the package (`World.create`, `buildId`, the conformance runner): `World.create(desc)` starts a
 * core and makes its world, and the world's `free()` ends the process. `options` are
 * `createNativeCore`'s; a probe core reads the buildId first. `{ ok: true, physics }` or a failure.
 */
export function nativePhysics(options) {
  const probe = createNativeCore(options);
  if (!probe.ok) return probe;
  const buildId = probe.core.buildId();
  probe.core.close();
  const create = (desc) => {
    const started = createNativeCore(options);
    if (!started.ok) return started;
    const made = started.core.createWorld(desc);
    if (!made.ok) started.core.close();
    return made;
  };
  return { ok: true, physics: { buildId: () => buildId, PhysicsError, World: { create } } };
}

export { PhysicsError };
