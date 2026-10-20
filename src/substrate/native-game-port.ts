/**
 * A C++ · raylib game's own run, as a preview port: the senses the harness and Live use, over the
 * game's fd-3 protocol (NDJSON both ways, `NATIVE_LINE_MAX_BYTES` per line) instead of a page.
 * Every reply is untrusted: a line too long, one that fails `isNativeResult`, or a `ready` without
 * the run's nonce ends the game with its typed refusal; a game that exits on its own ends its
 * calls with `NativeExitError`. Captures are read from the run's `state/captures/<seq>.bgra` after
 * the declared size is checked, their digest recomputed before any JPEG exists. The game writes in
 * `state/`, so the host reads a capture only when `state` and `captures` are real folders, and
 * removes nothing there: the run dir goes when the run ends. `NativeLeasePort` is the pool's
 * lease: it starts a headless run through the native registry on `load` and stops it (or cancels
 * it while it starts) on `dispose`.
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { type BuildIdentity, type CaptureProvenance, renderProvenanceCopy } from "../shared/build-preview.ts";
import { type CrashRecordV1, isGameMadeRecord } from "../shared/crash-record.ts";
import { SECOND_MS } from "../shared/duration.ts";
import type { BuildTarget } from "../shared/game-project.ts";
import {
  NATIVE_CALL_TIMEOUT_MS,
  NATIVE_LINE_MAX_BYTES,
  NATIVE_PROTOCOL_V1,
  NATIVE_PROTOCOL_VERSION,
  NATIVE_READY_TIMEOUT_MS,
  NATIVE_START_MAX_MS,
  NATIVE_STDERR_LINE_MAX_CHARS,
  type NativeCaptureReply,
  type NativeCaptureSize,
  NativeError,
  NativeEvent,
  type NativeEventMessage,
  NativeInputKind,
  NativeOp,
  checkRenderSettingsArg,
  type NativeOpArgs,
  type NativeOpResults,
  type NativeProtocolVersion,
  type NativeReadyEvent,
  NativeRefusal,
  NativeRunMode,
  type NativeRunStatus,
  type NativeTimers,
  isNativeCaptureSize,
  isNativeProtocolVersion,
  isNativeResult,
  parseNativeEvent,
  parseNativeInput,
} from "../shared/native-contract.ts";
import {
  CaptureSurface,
  type PreviewConsoleEntry,
  type PreviewPixelStats,
  type PreviewPortStatus,
  type PreviewTouchAction,
  ReadyPhase,
  ReadyVia,
} from "../shared/preview-contract.ts";
import { NotARegularFileError, readRegularFile } from "./fsx.ts";
import { computePixelStats } from "./pixel-stats.ts";
import { planNativeInput } from "./native-input-plan.ts";
import type { PreviewInputAction } from "./preview-input.ts";
import type { PreviewPort } from "./preview-port.ts";
import type { ReadySnapshot } from "./preview-ready.ts";
import type { GameChild } from "./spawn.ts";

/** What the host and the game say when a native run cannot do what was asked. */
const MESSAGE = {
  readyTimeout: "the game did not say it was ready in time",
  badHandshake: "the game's ready named another run or protocol",
  replyTooLarge: "the game sent a line over the protocol's limit",
  replyInvalid: "the game sent a line outside the protocol",
  callTimeout: (op: string) => `the game did not answer ${op} in time`,
  exited: (code: number | null, signal: string | null) =>
    `the game is not running (exit ${code ?? "none"}${signal ? `, ${signal}` : ""})`,
  exitedBeforeReady: (code: number | null, signal: string | null) =>
    `the game exited before it said it was ready (exit ${code ?? "none"}${signal ? `, ${signal}` : ""})`,
  refusedOp: (op: string, error: string) => `the game refused ${op}: ${error}`,
  requestTooLarge: "the request is over the protocol's line limit",
  noJavaScript: "a native game runs no JavaScript: evaluate is unsupported",
  loadedByRegistry: "a native run is started by the native registry, not loaded",
  inputRefused: "the input is outside the native input shape",
  touchNeedsV2: "a touch reaches only a contract v2 game: this game's protocol has no touch",
  captureTooLarge: "the capture file is larger than the game declared",
  captureDigest: "the capture's bytes are not the ones the game declared",
  captureFolder: "the capture is not a file in the run's own captures folder",
  captureSizeRefused: "a capture size is whole pixels, each side 64 to 4096",
  captureSizeIgnored: (asked: NativeCaptureSize, drawn: NativeCaptureSize) =>
    `the game drew ${drawn.width}x${drawn.height}, not the ${asked.width}x${asked.height} asked for: it captures at its world size only`,
  noRun: "this native lease has no game loaded",
  repeated: (count: number, line: string) => `(repeated ${count} times) ${line}`,
  released: "this native lease was given back",
  superseded: "a newer load of this native lease replaced this one",
} as const;

/** The most console entries a port keeps (oldest dropped first). */
const CONSOLE_ENTRIES_MAX = 500;
/**
 * How long repeats of one stderr line are counted before their count is written: a line the game
 * writes over and over (an AppKit service it may not reach, ~120 a second) costs one line per
 * interval instead of evicting everything else from the console and the run's log.
 */
export const NATIVE_LOG_REPEAT_FLUSH_MS = 5 * SECOND_MS;
/**
 * NSLog's prefix on every line: date, time with milliseconds, process name and `[pid:thread]`. Set
 * aside when lines are compared, so a repeat differs only in its time.
 */
const NSLOG_PREFIX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} .+?\[\d+:[0-9a-fx]+\] /;
/** How deeply a reply may nest: deeper is `reply-invalid` before anything walks it. */
const REPLY_DEPTH_MAX = 64;
/** The longest error text a game's refusal of an op is quoted with. */
const REFUSAL_TEXT_MAX_CHARS = 512;
/**
 * The ops a contract v2 (Rust · wgpu) game does GPU work inside: one that misses its deadline is
 * taken for a GPU hang (`gpu-hang`), not a wedged loop. A raylib game's run keeps `unresponsive`.
 */
const GPU_DEADLINE_OPS: ReadonlySet<string> = new Set([NativeOp.Step, NativeOp.Capture]);
/** The camera a game shows until a `debugCamera` names another (`studio::DEFAULT_CAMERA`, genex's too). */
const DEFAULT_CAMERA = "default";
/** A capture's JPEG quality when the caller names none. */
const DEFAULT_CAPTURE_QUALITY = 80;
/** The folder under the run's `state/` the game writes captures into. */
const CAPTURES_FOLDER = "captures";
/** A capture file's extension: raw BGRA, rows top-down. */
const CAPTURE_EXTENSION = ".bgra";
/** What a lease's `load` answers: the run, named. */
const RUN_URL = (project: string, runId: string) => `native://${encodeURIComponent(project)}/${runId}`;

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
/** FNV-1a 64, as two 32-bit halves (`studio::fnv1a64` in the C++ template). */
const FNV_OFFSET_HI = 0xcbf29ce4;
const FNV_OFFSET_LO = 0x84222325;
const FNV_PRIME_LO = 0x1b3;
const TWO_32 = 4294967296;

/** A console level a native run reports: stderr carries the template's warnings and worse. */
const ConsoleLevel = { Warning: "warning", Error: "error" } as const;

/** FNV-1a 64 of `bytes` as 16 lowercase hex: the digest a capture declares (`studio::hex64`). */
export function fnv1a64Hex(bytes: Uint8Array): string {
  let hi = FNV_OFFSET_HI;
  let lo = FNV_OFFSET_LO;
  for (const byte of bytes) {
    lo = (lo ^ byte) >>> 0;
    // (hi:lo) * (2^40 + 0x1b3) mod 2^64, in halves: lo << 40 lands in hi as lo << 8.
    const low = lo * FNV_PRIME_LO;
    const carry = Math.floor(low / TWO_32);
    hi = (hi * FNV_PRIME_LO + carry + ((lo << 8) >>> 0)) >>> 0;
    lo = low >>> 0;
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

/**
 * The renderer's codes a contract v2 game answers a step or capture it could not do with
 * (CONTRACT.md): each is the refusal itself, so the caller can tell a device being re-created
 * (`device-lost`: retry) from an op the game does not have.
 */
const GAME_GPU_REFUSALS: ReadonlySet<string> = new Set<NativeRefusal>([
  NativeRefusal.DeviceLost,
  NativeRefusal.GpuHang,
  NativeRefusal.GpuPassInvalid,
]);

/** Whether a game's error code is one of the renderer's (`GAME_GPU_REFUSALS`). */
const isGameGpuRefusal = (gameError: string): gameError is NativeRefusal => GAME_GPU_REFUSALS.has(gameError);

/**
 * The refusal behind a game's `{ok: false, error}` to `op`: its renderer code when a step or
 * capture (the ops it does GPU work inside) answers one, else `unsupported`.
 */
function opRefusal(op: string, gameError: string): NativeRefusal {
  return GPU_DEADLINE_OPS.has(op) && isGameGpuRefusal(gameError) ? gameError : NativeRefusal.Unsupported;
}

/**
 * A game's `{ok: false}` answer to one op: a step or capture refused with its renderer code
 * (`device-lost`, `gpu-hang`, `gpu-pass-invalid`) is that refusal, anything else `unsupported`; the code the game answered
 * is kept as it came (`gameError`, read against `NativeOpError`, never out of the sentence).
 */
export class NativeOpRefusedError extends NativeError {
  readonly gameError: string;
  constructor(op: string, gameError: string) {
    const said = gameError.slice(0, REFUSAL_TEXT_MAX_CHARS);
    super(opRefusal(op, said), MESSAGE.refusedOp(op, said));
    this.gameError = said;
  }
}

/** A game that exited on its own: what its handshake, or a call, rejects with. No refusal: the host ended nothing. */
export class NativeExitError extends Error {
  readonly exit: { code: number | null; signal: string | null };
  /** Whether the game had said it was ready before it exited. */
  readonly ready: boolean;
  constructor(exit: { code: number | null; signal: string | null }, ready: boolean) {
    super(ready ? MESSAGE.exited(exit.code, exit.signal) : MESSAGE.exitedBeforeReady(exit.code, exit.signal));
    this.name = "NativeExitError";
    this.exit = exit;
    this.ready = ready;
  }
}

/** What one port drives: the started game, its run's facts and the injected clock and encoder. */
export interface NativePortIo {
  child: GameChild;
  nonce: string;
  mode: NativeRunMode;
  /** The run's `state/`: where the game writes its captures. */
  stateDir: string;
  timers: NativeTimers;
  /** BGRA → JPEG, injected (Electron's nativeImage in production; a stub in tests). */
  encodeJpeg(bgra: Buffer, width: number, height: number, quality: number): Promise<Buffer>;
  /** The game the run is of, for `status()`; absent reads as none. */
  project?: string;
  /** How a capture file is read (default: `readRegularFile`, no-follow, regular only, capped). */
  readCapture?(file: string, maxBytes: number): Promise<Buffer>;
  /** The registry's run id, carried in each capture's provenance; absent reads as unknown. */
  runId?: string;
  /** The admitted build the run started, carried in each capture's provenance; absent or null reads as unknown. */
  build?: BuildIdentity | null;
  /** Told once when the host ends the game (`kill`), after its group got SIGKILL: the registry watches the reap. */
  onKill?(refusal: NativeRefusal): void;
}

/** One capture as the port answers it: the JPEG, its stats, the surface, and where it came from. */
export interface NativeCapture {
  jpeg: Buffer;
  stats: PreviewPixelStats;
  surface: CaptureSurface;
  provenance: CaptureProvenance;
}

/** The argument an op takes, or none. */
type OpArg<K extends keyof NativeOpResults> = K extends keyof NativeOpArgs ? NativeOpArgs[K] : never;

/** A call waiting for its reply: `settle` answers false for a result outside the op's shape. */
interface PendingCall {
  op: NativeOp;
  settle(result: unknown): boolean;
  reject(error: Error): void;
  timer: unknown;
}

/** One promise and its two ends. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether `value` nests deeper than `max` arrays or objects: walked without recursion. */
function nestsDeeperThan(value: unknown, max: number): boolean {
  const stack: Array<[unknown, number]> = [[value, 0]];
  for (let next = stack.pop(); next; next = stack.pop()) {
    const [item, depth] = next;
    if (typeof item !== "object" || item === null) continue;
    if (depth >= max) return true;
    for (const child of Object.values(item)) stack.push([child, depth + 1]);
  }
  return false;
}

/** One untrusted line as JSON, or undefined when it is not JSON or nests too deeply. */
function parseLine(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return nestsDeeperThan(value, REPLY_DEPTH_MAX) ? undefined : value;
  } catch {
    return undefined;
  }
}

/** What a page-style `studioCall(method, arg)` becomes on the native protocol. */
type PageCall = (port: NativeGamePort, arg: unknown) => Promise<unknown>;

const numberArg = (arg: unknown, key: string): number | undefined => {
  if (typeof arg === "number") return arg;
  return isRecord(arg) && typeof arg[key] === "number" ? arg[key] : undefined;
};
const textArg = (arg: unknown, key: string): string | null => {
  if (typeof arg === "string") return arg;
  return isRecord(arg) && typeof arg[key] === "string" ? arg[key] : null;
};

/**
 * The page verbs (`PageMethod` in the seed: the same names as their ops) and how each argument is
 * carried. `audio({muted})` mutes; `audio()` is the level probe, as the web shell has it.
 */
const PAGE_CALLS: Readonly<Record<string, PageCall>> = {
  [NativeOp.Seed]: (port, arg) => port.call(NativeOp.Seed, { seed: numberArg(arg, "seed") ?? 0 }),
  [NativeOp.Start]: (port) => port.call(NativeOp.Start),
  [NativeOp.Pause]: (port) => port.call(NativeOp.Pause),
  [NativeOp.Step]: (port, arg) => {
    const ms = numberArg(arg, "ms");
    return port.call(NativeOp.Step, ms === undefined ? undefined : { ms });
  },
  [NativeOp.DebugCamera]: (port, arg) => port.call(NativeOp.DebugCamera, { camera: textArg(arg, "camera") }),
  [NativeOp.Cameras]: (port) => port.call(NativeOp.Cameras),
  [NativeOp.Eyes]: (port) => port.call(NativeOp.Eyes),
  [NativeOp.Demos]: (port) => port.call(NativeOp.Demos),
  [NativeOp.Demo]: (port, arg) => port.call(NativeOp.Demo, { name: textArg(arg, "name") ?? "" }),
  [NativeOp.Audio]: (port, arg) =>
    isRecord(arg) && typeof arg.muted === "boolean"
      ? port.call(NativeOp.Audio, { muted: arg.muted })
      : port.call(NativeOp.AudioLevel),
  /** Checked as the game checks it, so a refusal carries the code a web page's answers. */
  [NativeOp.RenderSettings]: (port, arg) => {
    const checked = checkRenderSettingsArg(arg);
    if (!checked.ok) return Promise.reject(new NativeOpRefusedError(NativeOp.RenderSettings, checked.error));
    return port.call(NativeOp.RenderSettings, checked.arg);
  },
};

/** What a native run's `input` takes: the preview's actions and contract v2's `touch`. */
export type NativeInputList = ReadonlyArray<PreviewInputAction | PreviewTouchAction>;

/**
 * `port` as a native run's (a lease or the run itself), whose `input` takes a touch and refuses one
 * `unsupported` for a protocol 1 game; null for a browser page, whose input driver takes none.
 */
export function touchPort(port: PreviewPort): NativeGamePort | NativeLeasePort | null {
  return port instanceof NativeGamePort || port instanceof NativeLeasePort ? port : null;
}

/** Whether an input action is a finger's step (contract v2). */
const isTouch = (action: { type: string }): boolean => action.type === NativeInputKind.Touch;

/** One native run, spoken to over fd 3. */
export class NativeGamePort implements PreviewPort {
  readonly #io: NativePortIo;
  #nextId = 1;
  readonly #pending = new Map<number, PendingCall>();
  /** The line still arriving: its pieces and their bytes. */
  #pieces: Buffer[] = [];
  #pieceBytes = 0;
  readonly #listeners = new Set<(event: NativeEventMessage) => void>();
  readonly #stderrListeners = new Set<(line: string, cut: boolean) => void>();
  readonly #console: PreviewConsoleEntry[] = [];
  #stderrLine = "";
  #stderrCut = false;
  /** The last stderr line written, its NSLog prefix set aside, and the repeats of it not yet written. */
  #lastStderr: string | null = null;
  #repeats = 0;
  #repeatsCut = false;
  #repeatTimer: unknown = null;
  readonly #handshake = deferred<NativeReadyEvent>();
  #readyEvent: NativeReadyEvent | null = null;
  #readyTimer: unknown = null;
  /** When the start began, on the injected clock: `starting` never holds it past `NATIVE_START_MAX_MS`. */
  #startedAt = 0;
  /** Why the host ended the game, once it did. */
  #failure: NativeRefusal | null = null;
  #exit: { code: number | null; signal: string | null } | null = null;
  /** The game's own clock, as the last `start`/`pause`/`seed` left it (null: never told). */
  #running: boolean | null = null;
  /** The host paused the clock because nobody can see the game; showing it starts it again. */
  #pausedForSight = false;
  #visible = true;
  #observed = false;
  /** The camera the last answered `debugCamera` left the game on. */
  #camera: string = DEFAULT_CAMERA;
  /** The last crash record the game sent (CRASH-5): the registry hands it to the crash store as the run ends. */
  #lastCrash: CrashRecordV1 | null = null;
  /** The tick the game's last answered `state` named, for a host-made hang record; null before one. */
  #lastTick: number | null = null;

  constructor(io: NativePortIo) {
    this.#io = io;
    // Nobody may ever ask for the handshake (a run stopped while starting): its failure is no crash.
    this.#handshake.promise.catch(() => {});
    io.child.fd3.on("data", (chunk: Buffer) => this.#receive(chunk));
    io.child.fd3.on("error", () => {});
    // One decoder for the stream: a character split across two pipe chunks reaches the console whole.
    const stderr = new StringDecoder("utf8");
    io.child.stderr.on("data", (chunk: Buffer | string) =>
      this.#stderr(typeof chunk === "string" ? chunk : stderr.write(chunk)),
    );
    io.child.stderr.on("error", () => {});
    io.child.stdout.on("error", () => {});
    io.child.stdout.resume();
    void io.child.exited.then(
      (exit) => this.#exited(exit),
      () => this.#exited({ code: null, signal: null }),
    );
    this.#startedAt = io.timers.now();
    this.#armReady(NATIVE_READY_TIMEOUT_MS);
  }

  /** The ready deadline `ms` from now: a start that misses it is killed `ready-timeout`. */
  #armReady(ms: number): void {
    this.#io.timers.clearTimeout(this.#readyTimer);
    this.#readyTimer = this.#io.timers.setTimeout(
      () => this.kill(NativeRefusal.ReadyTimeout, MESSAGE.readyTimeout),
      ms,
    );
  }

  /** A v2 game finished a boot step: the ready deadline again from now, never past the start's cap. */
  #stillStarting(): void {
    const left = this.#startedAt + NATIVE_START_MAX_MS - this.#io.timers.now();
    this.#armReady(Math.min(NATIVE_READY_TIMEOUT_MS, Math.max(0, left)));
  }

  /**
   * The handshake: resolves with `ready`, or rejects `NativeError(ReadyTimeout | BadHandshake | …)`
   * when the host ended the game, or `NativeExitError` when the game exited before it was ready.
   */
  ready(): Promise<NativeReadyEvent> {
    return this.#handshake.promise;
  }

  /** Why the host ended this game (a protocol violation, a timeout, the memory cap), or null. */
  get failure(): NativeRefusal | null {
    return this.#failure;
  }

  /**
   * Whether a contract v2 game owes the answer to a step or capture, the ops it does GPU work
   * inside: a game that goes silent then is taken for a GPU hang, whichever deadline notices first.
   */
  get awaitingGpu(): boolean {
    if (this.#protocol() !== NATIVE_PROTOCOL_VERSION) return false;
    for (const call of this.#pending.values()) if (GPU_DEADLINE_OPS.has(call.op)) return true;
    return false;
  }

  /** How the game ended, once it was reaped; null while it runs. */
  get exit(): { code: number | null; signal: string | null } | null {
    return this.#exit;
  }

  /** The last crash record the game sent this run, or null. */
  get lastCrash(): CrashRecordV1 | null {
    return this.#lastCrash;
  }

  /** The tick the game's last answered `state` named, or null. */
  get lastTick(): number | null {
    return this.#lastTick;
  }

  /** Ends the game for `refusal` (SIGKILL to its group); every waiting call rejects with it. Idempotent. */
  kill(refusal: NativeRefusal, message: string = refusal): void {
    if (this.#failure !== null || this.#exit !== null) return;
    this.#failure = refusal;
    try {
      this.#io.child.kill("SIGKILL");
    } catch {
      // Already gone: the exit settles everything the same way.
    }
    this.#fail(new NativeError(refusal, message));
    this.#io.onKill?.(refusal);
  }

  /** One op and its checked result; a reply outside its shape ends the game (`reply-invalid`). */
  call<K extends keyof NativeOpResults>(op: K, arg?: OpArg<K>): Promise<NativeOpResults[K]> {
    const gone = this.#gone();
    if (gone) return Promise.reject(gone);
    // The game answers nothing before its `ready` (requests wait in its queue): a call made while it
    // starts is sent at the ready, so its deadline counts from there and the start's own deadline
    // decides a start that never ends.
    if (this.#readyEvent === null) return this.#handshake.promise.then(() => this.call(op, arg));
    const id = this.#nextId++;
    const line = JSON.stringify(arg === undefined ? { id, op } : { id, op, arg });
    if (Buffer.byteLength(line) > NATIVE_LINE_MAX_BYTES) return Promise.reject(new Error(MESSAGE.requestTooLarge));
    return new Promise<NativeOpResults[K]>((resolve, reject) => {
      const timer = this.#io.timers.setTimeout(
        () => this.kill(this.#deadlineRefusal(op), MESSAGE.callTimeout(op)),
        NATIVE_CALL_TIMEOUT_MS,
      );
      const settle = (result: unknown): boolean => {
        if (!isNativeResult(op, result, this.#protocol())) return false;
        this.#noteClock(op, result);
        this.#noteCamera(op, arg, result);
        resolve(result);
        return true;
      };
      this.#pending.set(id, { op, settle, reject, timer });
      this.#io.child.fd3.write(`${line}\n`);
    });
  }

  /** Every checked event the game sends (`focus`, `fatal`, `frame`); returns the unsubscribe. */
  onEvent(listener: (event: NativeEventMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Every stderr line, cut at `NATIVE_STDERR_LINE_MAX_CHARS` (`cut` says so); returns the unsubscribe. */
  onStderr(listener: (line: string, cut: boolean) => void): () => void {
    this.#stderrListeners.add(listener);
    return () => this.#stderrListeners.delete(listener);
  }

  /** Readiness from the `ready` event, never a page probe; never throws. */
  async readySnapshot(): Promise<ReadySnapshot | null> {
    const failed = this.#failure !== null || (this.#exit !== null && this.#readyEvent === null);
    const ready = this.#readyEvent !== null && !failed;
    let phase: ReadyPhase = ready ? ReadyPhase.Ready : ReadyPhase.Boot;
    if (failed) phase = ReadyPhase.Failed;
    return {
      via: ReadyVia.Contract,
      ready,
      phase,
      attached: this.#readyEvent !== null,
      frames: 0,
      drawCalls: 0,
      pageMs: null,
      timedOut: false,
      reason: this.#failure,
      gesture: { needed: false, done: false, reasons: [] },
    };
  }

  /** A run is started by the native registry; the raw port loads nothing. */
  async load(): Promise<string> {
    throw new NativeError(NativeRefusal.Unsupported, MESSAGE.loadedByRegistry);
  }

  /** A run is restarted by its lease (`NativeLeasePort.reload`); the raw port reloads nothing. */
  async reload(): Promise<void> {
    throw new NativeError(NativeRefusal.Unsupported, MESSAGE.loadedByRegistry);
  }

  /** One capture, as a JPEG (see {@link NativeGamePort.screenshotWithStats}). */
  async screenshot(quality?: number): Promise<Buffer> {
    return (await this.screenshotWithStats(quality)).jpeg;
  }

  /**
   * One capture: the game writes `state/captures/<seq>.bgra` and declares its size and digest; the
   * host reads exactly that many bytes from the path it derives itself, recomputes the digest on
   * the BGRA, measures it, and only then encodes the JPEG. The file stays: the run dir goes with the run.
   * Its provenance is the game's sequence number, the digest the host recomputed, the camera the
   * game says it drew from (else the one it was last placed on), the run, the build, the render
   * settings the game answered with and the capture's size, so a saved frame is never taken for
   * another build's or another preset's.
   */
  async screenshotWithStats(quality = DEFAULT_CAPTURE_QUALITY): Promise<NativeCapture> {
    return this.#capture({}, quality);
  }

  /**
   * One capture drawn at `size` (renderer pass 2, the 4K/1440p capture plan: `capture --size`), as
   * {@link NativeGamePort.screenshotWithStats}. A size outside whole pixels in 64..4096 is refused
   * `unsupported` before anything is sent; a game that answers another size (a C++ game draws its
   * world size only) is refused `unsupported` before its file is read.
   */
  async screenshotAt(size: NativeCaptureSize, quality = DEFAULT_CAPTURE_QUALITY): Promise<NativeCapture> {
    if (!isNativeCaptureSize(size)) throw new NativeError(NativeRefusal.Unsupported, MESSAGE.captureSizeRefused);
    return this.#capture({ size: { width: size.width, height: size.height } }, quality);
  }

  async #capture(arg: NativeOpArgs[typeof NativeOp.Capture], quality: number): Promise<NativeCapture> {
    const camera = this.#camera;
    const reply = await this.call(NativeOp.Capture, arg);
    const asked = arg.size;
    if (asked && (reply.width !== asked.width || reply.height !== asked.height))
      throw new NativeError(NativeRefusal.Unsupported, MESSAGE.captureSizeIgnored(asked, reply));
    const bgra = await this.#readCapture(reply);
    const stats = computePixelStats(bgra, reply.width, reply.height);
    const jpeg = await this.#io.encodeJpeg(bgra, reply.width, reply.height, quality);
    const provenance: CaptureProvenance = {
      seq: reply.seq,
      // `#readCapture` refused any bytes whose digest is not this one.
      digest: reply.digest,
      // The game's own word on the camera it drew from; else the one the host last placed it on.
      camera: reply.camera ?? camera,
      runId: this.#io.runId ?? null,
      build: this.#io.build ? { ...this.#io.build } : null,
      // The settings the game says it drew the frame with (a `renderSettings` change still in force
      // reads `settingsSource: "verb"`), and the size the host read.
      render: reply.render ? renderProvenanceCopy(reply.render) : null,
      outputSize: { width: reply.width, height: reply.height },
    };
    return { jpeg, stats: { ...stats, canvas: true }, surface: CaptureSurface.Canvas, provenance };
  }

  /** A native game runs no JavaScript: always `NativeError(Unsupported)`, and the game keeps running. */
  async evaluate(): Promise<unknown> {
    throw new NativeError(NativeRefusal.Unsupported, MESSAGE.noJavaScript);
  }

  /** The game's `state` op. */
  studioState(): Promise<unknown> {
    return this.call(NativeOp.State);
  }

  /** A page verb on its op (`PageMethod` names); `{__missing: true}` for anything else, as a page answers. */
  async studioCall(method: string, arg?: unknown): Promise<unknown> {
    const verb = Object.hasOwn(PAGE_CALLS, method) ? PAGE_CALLS[method] : undefined;
    if (!verb) return { __missing: true };
    return verb(this, arg);
  }

  /**
   * The preview's actions (and the native-only kinds), checked as a whole, then the `input` op. A
   * touch to a game whose `ready` stated protocol 1 is refused `unsupported` and nothing is sent.
   */
  async input(actions: NativeInputList): Promise<{ ok: boolean; applied: number; width: number; height: number }> {
    const checked = parseNativeInput(actions);
    if (!checked) throw new Error(MESSAGE.inputRefused);
    const touchless = this.#protocol() !== NATIVE_PROTOCOL_VERSION;
    if (touchless && checked.some(isTouch)) throw new NativeError(NativeRefusal.TouchNotTaken, MESSAGE.touchNeedsV2);
    // The runtime applies one message at its next tick and leaves timed kinds to the host.
    for (const step of planNativeInput(checked)) {
      if ("waitMs" in step) await this.#pause(step.waitMs);
      else await this.call(NativeOp.Input, { actions: step.send });
    }
    const size = this.#readyEvent?.size ?? { width: 0, height: 0 };
    return { ok: true, applied: checked.length, width: size.width, height: size.height };
  }

  /** A pause on the port's own clock (a fake one in tests). */
  #pause(ms: number): Promise<void> {
    return new Promise((done) => {
      this.#io.timers.setTimeout(done, ms);
    });
  }

  /** The game's stderr lines and `fatal` events since `sinceMs`. */
  consoleEntries(sinceMs = 0): PreviewConsoleEntry[] {
    return this.#console.filter((entry) => entry.at >= sinceMs);
  }

  /** The run from its exit, its signal and the host's own refusal (a heartbeat unanswered is `unresponsive`). */
  status(): PreviewPortStatus {
    const exit = this.#exit;
    const crashed = exit !== null && this.#failure === null && (exit.signal !== null || exit.code !== 0);
    return {
      project: this.#io.project ?? null,
      url: null,
      crashed,
      unresponsive: this.#failure === NativeRefusal.Unresponsive,
      loadError: this.#failure,
      consoleErrors: this.#console.filter((entry) => entry.level === ConsoleLevel.Error).length,
      consoleAvailable: true,
    };
  }

  /** Headless runs pause while nobody can see or observe them; a window run is shown or hidden. */
  setVisible(visible: boolean): void {
    this.#visible = visible;
    if (this.#io.mode === NativeRunMode.Window) {
      void this.call(NativeOp.Visible, { visible }).catch(() => {});
      return;
    }
    this.#applySight();
  }

  /** An agent watching keeps a hidden headless run's clock going. */
  setObserved(observed: boolean): void {
    this.#observed = observed;
    if (this.#io.mode !== NativeRunMode.Window) this.#applySight();
  }

  /** The game's master volume (`audio {muted}`). */
  setAudioMuted(muted: boolean): void {
    void this.call(NativeOp.Audio, { muted }).catch(() => {});
  }

  /** Nothing outside the frame: a native game has no page UI to probe. */
  async pageUi(): Promise<null> {
    return null;
  }

  /** No page, so no attach report: the studio's own instrumentation never ran in a native game. */
  async attachReport(): Promise<null> {
    return null;
  }

  /** The registry stops the run; the port itself holds nothing to release. */
  async dispose(): Promise<void> {}

  /** Pause a hidden, unobserved clock the game was running, and start only a clock the host paused. */
  #applySight(): void {
    const seen = this.#visible || this.#observed;
    if (!seen && this.#running !== false && !this.#pausedForSight) {
      this.#pausedForSight = true;
      void this.call(NativeOp.Pause).catch(() => {});
      return;
    }
    if (seen && this.#pausedForSight) {
      this.#pausedForSight = false;
      void this.call(NativeOp.Start).catch(() => {});
    }
  }

  /** What the last clock op left running, so a hidden run never starts a clock its harness paused. */
  #noteClock(op: NativeOp, result: unknown): void {
    if (!isRecord(result)) return;
    if (op === NativeOp.Seed) this.#running = false;
    if (op === NativeOp.State && Number.isSafeInteger(result.tick)) this.#lastTick = Number(result.tick);
    const clockOp = op === NativeOp.Start || op === NativeOp.Pause;
    if (clockOp && typeof result.running === "boolean") this.#running = result.running;
  }

  /** The camera an answered `debugCamera` moved the game to (its answer's name, else the one asked; null asks the default). */
  #noteCamera(op: NativeOp, arg: unknown, result: unknown): void {
    if (op !== NativeOp.DebugCamera || !isRecord(result) || result.ok !== true) return;
    const answered = typeof result.camera === "string" ? result.camera : null;
    const asked = isRecord(arg) && typeof arg.camera === "string" ? arg.camera : null;
    this.#camera = answered ?? asked ?? DEFAULT_CAMERA;
  }

  /**
   * Exactly `width × height × 4` bytes from the host-derived path, digest checked. The game can
   * write in `state/`: a link at `state`, `captures` or the file (a parent link would redirect even
   * a no-follow open) refuses the read, and the host removes nothing there while the game runs, so
   * a link it plants between the check and the read changes nothing outside the run; the digest
   * still vouches for every byte that is encoded.
   */
  async #readCapture(reply: NativeCaptureReply): Promise<Buffer> {
    const expected = reply.width * reply.height * 4;
    const folder = path.join(this.#io.stateDir, CAPTURES_FOLDER);
    if (!(await realFolders([this.#io.stateDir, folder]))) {
      throw new NativeError(NativeRefusal.CaptureDigest, MESSAGE.captureFolder);
    }
    const read = this.#io.readCapture ?? readRegularFile;
    const bytes = await read(path.join(folder, `${reply.seq}${CAPTURE_EXTENSION}`), expected).catch(
      (error: unknown) => {
        const tooLarge = error instanceof NotARegularFileError && error.code === "EFBIG";
        if (tooLarge) throw new NativeError(NativeRefusal.CaptureTooLarge, MESSAGE.captureTooLarge);
        throw new NativeError(NativeRefusal.CaptureDigest, MESSAGE.captureDigest);
      },
    );
    if (bytes.length > expected) throw new NativeError(NativeRefusal.CaptureTooLarge, MESSAGE.captureTooLarge);
    const matches = bytes.length === expected && fnv1a64Hex(bytes) === reply.digest;
    if (!matches) throw new NativeError(NativeRefusal.CaptureDigest, MESSAGE.captureDigest);
    return bytes;
  }

  /** Bytes from fd 3, cut into lines; a line past the limit ends the game before it is ever parsed. */
  #receive(chunk: Buffer): void {
    let start = 0;
    for (let end = chunk.indexOf(NEWLINE); end !== -1; end = chunk.indexOf(NEWLINE, start)) {
      if (!this.#take(chunk.subarray(start, end))) return;
      const line = Buffer.concat(this.#pieces, this.#pieceBytes);
      this.#pieces = [];
      this.#pieceBytes = 0;
      start = end + 1;
      this.#line(line);
      if (this.#ended()) return;
    }
    this.#take(chunk.subarray(start));
  }

  /** Adds a piece of the current line; false (and the game ended) when the line would pass the limit. */
  #take(piece: Buffer): boolean {
    if (this.#ended()) return false;
    if (this.#pieceBytes + piece.length > NATIVE_LINE_MAX_BYTES) {
      this.#pieces = [];
      this.#pieceBytes = 0;
      this.kill(NativeRefusal.ReplyTooLarge, MESSAGE.replyTooLarge);
      return false;
    }
    if (piece.length > 0) this.#pieces.push(piece);
    this.#pieceBytes += piece.length;
    return true;
  }

  /** One whole line: an event, a reply, or a violation. Blank lines (a stray CRLF) are nothing. */
  #line(bytes: Buffer): void {
    const end = bytes.at(-1) === CARRIAGE_RETURN ? bytes.length - 1 : bytes.length;
    const text = bytes.subarray(0, end).toString("utf8");
    if (text.trim() === "") return;
    const value = parseLine(text);
    if (isRecord(value) && Object.hasOwn(value, "event")) {
      this.#event(value);
      return;
    }
    if (isRecord(value) && Object.hasOwn(value, "id")) {
      this.#reply(value);
      return;
    }
    this.kill(NativeRefusal.ReplyInvalid, MESSAGE.replyInvalid);
  }

  #event(raw: Record<string, unknown>): void {
    const event = parseNativeEvent(raw);
    if (!event) {
      this.kill(NativeRefusal.ReplyInvalid, MESSAGE.replyInvalid);
      return;
    }
    if (event.event === NativeEvent.Ready) {
      this.#handshakeEvent(event);
      return;
    }
    if (this.#outOfTurn(event)) {
      this.kill(NativeRefusal.ReplyInvalid, MESSAGE.replyInvalid);
      return;
    }
    if (event.event === NativeEvent.Starting) {
      this.#stillStarting();
      // Where the boot is goes on to the run (Live's card shows it); a bare `starting` says nothing new.
      if (event.progress) for (const listener of this.#listeners) listener(event);
      return;
    }
    if (event.event === NativeEvent.Crash && !this.#keepCrash(event.record)) return;
    if (event.event === NativeEvent.Fatal) this.#note(ConsoleLevel.Error, event.reason);
    for (const listener of this.#listeners) listener(event);
  }

  /**
   * A game's own record is kept as the run's last; one naming a kind or writer only the host, the
   * shell or a platform reader makes (a forged `hang`, a `source: "host"`) ends the game `reply-invalid`.
   */
  #keepCrash(record: CrashRecordV1): boolean {
    if (!isGameMadeRecord(record)) {
      this.kill(NativeRefusal.ReplyInvalid, MESSAGE.replyInvalid);
      return false;
    }
    this.#lastCrash = record;
    return true;
  }

  /** The one `ready`: this run's nonce and protocol, or the game ends `bad-handshake`. A second is a violation. */
  #handshakeEvent(event: NativeReadyEvent): void {
    if (this.#readyEvent) {
      this.kill(NativeRefusal.ReplyInvalid, MESSAGE.replyInvalid);
      return;
    }
    // Contract v2 negotiation: a raylib game states protocol 1, a Rust game 2; any other is not ours.
    const ours = event.nonce === this.#io.nonce && isNativeProtocolVersion(event.protocol);
    if (!ours) {
      this.kill(NativeRefusal.BadHandshake, MESSAGE.badHandshake);
      return;
    }
    this.#readyEvent = event;
    this.#io.timers.clearTimeout(this.#readyTimer);
    this.#handshake.resolve(event);
    for (const listener of this.#listeners) listener(event);
  }

  /**
   * An event the game cannot honestly send now: a frame before its ready (no ring was announced
   * yet), a restored device from anything but a ready protocol 2 game (only contract v2 has one),
   * or `starting` once it is ready.
   */
  #outOfTurn(event: NativeEventMessage): boolean {
    if (event.event === NativeEvent.Frame) return this.#readyEvent === null;
    if (event.event === NativeEvent.Starting) return this.#readyEvent !== null;
    if (event.event === NativeEvent.DeviceRestored) return this.#protocol() !== NATIVE_PROTOCOL_VERSION;
    return false;
  }

  /** Why a call that missed its deadline ends the run: `gpu-hang` for a v2 game's GPU op, else `unresponsive`. */
  #deadlineRefusal(op: string): NativeRefusal {
    const gpuWork = this.#protocol() === NATIVE_PROTOCOL_VERSION && GPU_DEADLINE_OPS.has(op);
    return gpuWork ? NativeRefusal.GpuHang : NativeRefusal.Unresponsive;
  }

  /** The protocol the game's `ready` negotiated; protocol 1 until it has sent one. */
  #protocol(): NativeProtocolVersion {
    const stated = this.#readyEvent?.protocol;
    return isNativeProtocolVersion(stated) ? stated : NATIVE_PROTOCOL_V1;
  }

  #reply(raw: Record<string, unknown>): void {
    const id = raw.id;
    const call = typeof id === "number" ? this.#pending.get(id) : undefined;
    if (typeof id !== "number" || !call || raw.op !== call.op) {
      this.kill(NativeRefusal.ReplyInvalid, MESSAGE.replyInvalid);
      return;
    }
    // Still pending while it is checked: a result outside its shape rejects it with the rest.
    const settled = raw.ok === true && call.settle(raw.result);
    const refused = raw.ok === false && typeof raw.error === "string";
    if (!settled && !refused) {
      this.kill(NativeRefusal.ReplyInvalid, MESSAGE.replyInvalid);
      return;
    }
    this.#pending.delete(id);
    this.#io.timers.clearTimeout(call.timer);
    if (!refused) return;
    call.reject(new NativeOpRefusedError(call.op, String(raw.error)));
  }

  /** stderr as whole lines, each cut at the limit; a line that never ends is cut, then dropped to its end. */
  #stderr(text: string): void {
    const parts = text.split("\n");
    const last = parts.pop() ?? "";
    for (const part of parts) {
      this.#appendStderr(part);
      this.#emitStderr(this.#stderrLine.replace(/\r$/, ""), this.#stderrCut);
      this.#stderrLine = "";
      this.#stderrCut = false;
    }
    this.#appendStderr(last);
  }

  #appendStderr(part: string): void {
    const room = NATIVE_STDERR_LINE_MAX_CHARS - this.#stderrLine.length;
    if (part.length > room) this.#stderrCut = true;
    this.#stderrLine += part.slice(0, Math.max(0, room));
  }

  /** One whole line: written, or counted when it repeats the line before it (`#flushRepeats` writes the count). */
  #emitStderr(line: string, cut: boolean): void {
    const text = line.replace(NSLOG_PREFIX, "");
    if (text === this.#lastStderr) {
      this.#repeats += 1;
      this.#repeatsCut = cut;
      if (this.#repeatTimer === null) {
        this.#repeatTimer = this.#io.timers.setTimeout(() => {
          this.#repeatTimer = null;
          this.#flushRepeats();
        }, NATIVE_LOG_REPEAT_FLUSH_MS);
      }
      return;
    }
    this.#flushRepeats();
    this.#lastStderr = text;
    this.#writeStderr(line, cut);
  }

  /** Writes how often the last line repeated since it was last written, if it did. */
  #flushRepeats(): void {
    if (this.#repeatTimer !== null) this.#io.timers.clearTimeout(this.#repeatTimer);
    this.#repeatTimer = null;
    if (this.#repeats === 0) return;
    const counted = MESSAGE.repeated(this.#repeats, this.#lastStderr ?? "");
    this.#repeats = 0;
    const cut = this.#repeatsCut || counted.length > NATIVE_STDERR_LINE_MAX_CHARS;
    this.#writeStderr(counted.slice(0, NATIVE_STDERR_LINE_MAX_CHARS), cut);
  }

  #writeStderr(line: string, cut: boolean): void {
    this.#note(ConsoleLevel.Warning, line);
    for (const listener of this.#stderrListeners) listener(line, cut);
  }

  #note(level: string, message: string): void {
    this.#console.push({ at: this.#io.timers.now(), level, message, source: "native" });
    if (this.#console.length > CONSOLE_ENTRIES_MAX) this.#console.shift();
  }

  /** The game was reaped: nothing it owed will come. */
  #exited(exit: { code: number | null; signal: string | null }): void {
    const settled = this.#ended();
    this.#exit = exit;
    if (this.#stderrLine) this.#emitStderr(this.#stderrLine, this.#stderrCut);
    this.#stderrLine = "";
    this.#flushRepeats();
    if (settled) return;
    this.#fail(new NativeExitError(exit, this.#readyEvent !== null));
  }

  /** Rejects every waiting call, and an unanswered handshake, with `error`. */
  #fail(error: Error): void {
    this.#io.timers.clearTimeout(this.#readyTimer);
    if (!this.#readyEvent) this.#handshake.reject(error);
    for (const call of this.#pending.values()) {
      this.#io.timers.clearTimeout(call.timer);
      call.reject(error);
    }
    this.#pending.clear();
  }

  #ended(): boolean {
    return this.#failure !== null || this.#exit !== null;
  }

  /** Why a call cannot be made now, or null while the game runs. */
  #gone(): Error | null {
    if (this.#failure !== null) return new NativeError(this.#failure, this.#failure);
    if (this.#exit !== null) return new NativeExitError(this.#exit, this.#readyEvent !== null);
    return null;
  }
}

/** Whether every one of `dirs` is a real folder: not a link (`lstat`), not missing, not a file. */
async function realFolders(dirs: readonly string[]): Promise<boolean> {
  for (const dir of dirs) {
    const info = await lstat(dir).catch(() => null);
    if (!info?.isDirectory()) return false;
  }
  return true;
}

/** A run the registry started: its live status and its port. */
export interface NativeLeaseRun {
  readonly status: NativeRunStatus;
  port: NativeGamePort;
}

/** What a native lease starts its run with: the native registry's `start` and `stop`, structurally. */
export interface NativeLeaseOptions {
  /** The registry's `start`: `signal` aborts the start as Stop does (the registry links it to `stop`). */
  start(request: {
    project: string;
    target: BuildTarget;
    mode: typeof NativeRunMode.Headless;
    root?: string;
    owner?: string;
    signal: AbortSignal;
  }): Promise<NativeLeaseRun>;
  stop(runId: string): Promise<void>;
  target: BuildTarget;
  /** The harness lease owner, so harness death ends the run. */
  owner?: string;
}

const noop = (): void => {};

/** The status of a lease that holds no run. */
const IDLE_STATUS: PreviewPortStatus = {
  project: null,
  url: null,
  crashed: false,
  unresponsive: false,
  loadError: null,
  consoleErrors: null,
};

/** A load whose run is still building or starting: its game, how to cancel it, and when it is over. */
interface StartingLoad {
  project: string;
  controller: AbortController;
  /** Settles once the load kept its run, or stopped it, or was refused. */
  done: Promise<void>;
}

/** Why a load ends without a run: the lease was given back, or a newer load replaced it. */
const abortError = (message: string) => new DOMException(message, "AbortError");

/**
 * A pooled native lease: `load(project, entry?, root?)` starts a headless run through the registry;
 * every other member delegates to that run's port; `dispose` stops it. A load still starting is
 * cancelled by `dispose`, `stopRun` and a newer load (it rejects `AbortError`): a run the registry
 * answers for a cancelled load is stopped, never kept, so no game runs that no lease holds.
 */
export class NativeLeasePort implements PreviewPort {
  readonly #options: NativeLeaseOptions;
  #run: NativeLeaseRun | null = null;
  #starting: StartingLoad | null = null;
  #last: { project: string; root: string | undefined } | null = null;
  /** The last load's build failed: the lease holds no run, and a capture says why (`build-failed`). */
  #failed: NativeError | null = null;
  /** Counts loads, so one that waited for an older run to stop knows whether a newer load came since. */
  #loads = 0;
  /** Given back: the lease loads nothing more. */
  #disposed = false;

  constructor(options: NativeLeaseOptions) {
    this.#options = options;
  }

  /** The build this lease judges. */
  get target(): BuildTarget {
    return this.#options.target;
  }

  /** The game of the run this lease holds or is starting, or null. */
  get project(): string | null {
    return this.#run?.status.project ?? this.#starting?.project ?? null;
  }

  /** The run this lease holds now, or null. */
  get run(): NativeLeaseRun | null {
    return this.#run;
  }

  /**
   * Starts a headless run of `project` (or of the checked worktree `root`); a run already held is
   * stopped, and one still starting cancelled, first. Rejects `AbortError` when the lease is given
   * back or a newer load comes while this one starts.
   */
  async load(project: string, _entry?: string, root?: string): Promise<string> {
    this.#loads += 1;
    const load = this.#loads;
    await this.stopRun();
    if (this.#disposed) throw abortError(MESSAGE.released);
    if (load !== this.#loads) throw abortError(MESSAGE.superseded);
    this.#last = { project, root };
    const controller = new AbortController();
    const started = this.#start(project, root, controller.signal);
    const starting: StartingLoad = { project, controller, done: started.then(noop, noop) };
    this.#starting = starting;
    try {
      const run = await started;
      return RUN_URL(project, run.status.runId);
    } catch (error) {
      if (error instanceof NativeError && error.refusal === NativeRefusal.BuildFailed) this.#failed = error;
      throw error;
    } finally {
      if (this.#starting === starting) this.#starting = null;
    }
  }

  /** The registry's run for one load, kept only while that load stands; a cancelled load's run is stopped. */
  async #start(project: string, root: string | undefined, signal: AbortSignal): Promise<NativeLeaseRun> {
    const run = await this.#options.start({
      project,
      target: this.#options.target,
      mode: NativeRunMode.Headless,
      signal,
      ...(root ? { root } : {}),
      ...(this.#options.owner ? { owner: this.#options.owner } : {}),
    });
    if (signal.aborted) {
      await this.#options.stop(run.status.runId);
      signal.throwIfAborted();
    }
    this.#run = run;
    return run;
  }

  /** What is on disk now: the same game built and started again. */
  async reload(): Promise<void> {
    const last = this.#last;
    if (!last) throw new Error(MESSAGE.noRun);
    await this.load(last.project, undefined, last.root);
  }

  /** Stops the run this lease holds and cancels one still starting, keeping the lease; true when there was either. */
  async stopRun(): Promise<boolean> {
    const starting = this.#starting;
    const run = this.#run;
    this.#starting = null;
    this.#run = null;
    this.#failed = null;
    starting?.controller.abort();
    await Promise.all([starting?.done, run ? this.#options.stop(run.status.runId) : undefined]);
    return starting !== null || run !== null;
  }

  screenshot(quality?: number): Promise<Buffer> {
    return this.#port().screenshot(quality);
  }

  screenshotWithStats(quality?: number): Promise<NativeCapture> {
    return this.#port().screenshotWithStats(quality);
  }

  screenshotAt(size: NativeCaptureSize, quality?: number): Promise<NativeCapture> {
    return this.#port().screenshotAt(size, quality);
  }

  evaluate(): Promise<unknown> {
    return this.#port().evaluate();
  }

  async readySnapshot(): Promise<ReadySnapshot | null> {
    return this.#run ? this.#run.port.readySnapshot() : null;
  }

  studioState(): Promise<unknown> {
    return this.#port().studioState();
  }

  studioCall(method: string, arg?: unknown): Promise<unknown> {
    return this.#port().studioCall(method, arg);
  }

  input(actions: NativeInputList): Promise<{ ok: boolean; applied: number; width: number; height: number }> {
    return this.#port().input(actions);
  }

  consoleEntries(sinceMs?: number): PreviewConsoleEntry[] {
    return this.#run ? this.#run.port.consoleEntries(sinceMs) : [];
  }

  status(): PreviewPortStatus {
    if (this.#run) return this.#run.port.status();
    // A load whose build failed left no run: the lease says so until the next load or stop.
    return { ...IDLE_STATUS, buildFailed: this.#failed?.message ?? null };
  }

  setVisible(visible: boolean): void {
    this.#run?.port.setVisible(visible);
  }

  setObserved(observed: boolean): void {
    this.#run?.port.setObserved(observed);
  }

  setAudioMuted(muted: boolean): void {
    this.#run?.port.setAudioMuted(muted);
  }

  async pageUi(): Promise<null> {
    return null;
  }

  async attachReport(): Promise<null> {
    return null;
  }

  /** The lease is given back: its run ends (or stops starting), and it loads nothing more. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.stopRun();
  }

  #port(): NativeGamePort {
    if (this.#run) return this.#run.port;
    // A load whose build failed left no run: what is asked of it is refused as that build.
    const failed = this.#failed;
    if (failed) throw new NativeError(NativeRefusal.BuildFailed, failed.message, failed.problem);
    throw new NativeError(NativeRefusal.Unsupported, MESSAGE.noRun);
  }
}
