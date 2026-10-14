/**
 * Live's embedded frames, main's half: the one native addon the app loads
 * (`dist/resources/native/genex-frames.node`, receive-only), wrapped per run. A run's channel is
 * opened before its game is spawned (the service name is the game profile's `FRAMES` parameter),
 * told the game's pid, asked for a ring per generation, paused while Live cannot show it, and
 * closed after the game is gone. Each frame is imported and sent to the studio window
 * synchronously, inside the addon's event; Electron's `allReferencesReleased` gives the slot back
 * to the addon and the game. Frames are untrusted pixels the compositor draws: nothing here maps or
 * reads them, and the addon checked every message before it reached JavaScript.
 *
 * What a run's frames end it for: a fatal addon code (`nativeRefusalOfFrames`), and a slot the
 * renderer still holds `NATIVE_FRAME_SLOT_WATCHDOG_MS` after its send resolved (`frames-stalled`:
 * no receiver drew it). Either kills the game through the injected `kill`, then closes the channel;
 * the studio window is never reloaded for it. Facts this follows: `.studio-dev` m5a RESULTS §5–§6.
 */
import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { errorMessage } from "../shared/errors.ts";
import {
  NATIVE_FRAME_BURST,
  NATIVE_FRAME_RATE_MAX_PER_S,
  NATIVE_FRAME_SLOT_WATCHDOG_MS,
  NATIVE_FRAME_SLOTS,
  NATIVE_FRAMES_ABI_VERSION,
  NATIVE_FRAMES_DROPPED,
  NATIVE_FRAMES_SERVICE_PREFIX,
  NATIVE_FRAMES_WIRE_VERSION,
  NativeError,
  type NativeFrameMeta,
  NativeFramesCode,
  NativeRefusal,
  type NativeTimers,
  isNativeFramesCode,
  nativeRefusalOfFrames,
} from "../shared/native-contract.ts";
import { electronSupportsFrames } from "./electron-gate.ts";

/** Where the addon is, inside the resources folder, and the only file main loads as native code. */
const ADDON_FOLDER = "native";
const ADDON_FILE = "genex-frames.node";
/** The performance channel each frame's import-to-sent time is recorded on (`PerformanceRecorder`). */
const FRAME_CHANNEL = "native:frame";
/** The ring error `expectRing` throws when too many retired slots are still held. */
const TOO_MANY_HELD = "too-many-held";

/** The two shapes the addon's `onEvent` receives. Wire values (README "JavaScript API"). */
const AddonEvent = { Frame: "frame", Error: "error" } as const;

/** Every code the addon's `errorCodes` must name, in one order. */
const CODES = Object.values(NativeFramesCode).sort();

/** The channel methods the host calls; an object without every one is no channel. */
const CHANNEL_METHODS = ["setPeer", "expectRing", "release", "stats", "close"] as const;

/** How each frame is described to Electron: BGRA, sRGB full range (exact on WebGPU and WebGL2, RESULTS §4). */
const COLOR_SPACE = { primaries: "bt709", transfer: "srgb", matrix: "rgb", range: "full" } as const;

const MESSAGE = {
  unavailable: (refusal: NativeRefusal) => `Live cannot show a Mac build here (${refusal})`,
  loadFailed: (file: string, error: string) => `genex-frames: ${file} was not loaded: ${error}`,
  notTheAddon: (file: string) => `genex-frames: ${file} is not the addon this build expects; Live embeds nothing`,
  openFailed: (runId: string, error: string) => `genex-frames: run ${runId}'s channel did not open: ${error}`,
  wrongService: (runId: string) => `genex-frames: run ${runId}'s channel is not on its own service name`,
  noRun: (runId: string) => `genex-frames: no open channel for run ${runId}`,
  peerRefused: (runId: string, error: string) => `genex-frames: run ${runId}'s game was not made its peer: ${error}`,
  ringRefused: (runId: string, error: string) => `genex-frames: run ${runId}'s ring was refused: ${error}`,
  importFailed: (runId: string, error: string) => `genex-frames: run ${runId}'s frame was not imported: ${error}`,
  sendFailed: (runId: string, error: string) => `genex-frames: run ${runId}'s frame was not sent: ${error}`,
  releaseFailed: (runId: string, error: string) => `genex-frames: run ${runId}'s slot was not given back: ${error}`,
  stalled: (runId: string, stats: string) =>
    `genex-frames: run ${runId}: a slot stayed held past the watchdog; Live stopped taking its frames (${stats})`,
  ended: (runId: string, refusal: NativeRefusal) => `genex-frames: run ${runId} ended: ${refusal}`,
  killFailed: (runId: string, error: string) => `genex-frames: run ${runId}'s game was not ended: ${error}`,
  closeFailed: (runId: string, error: string) => `genex-frames: run ${runId}'s channel did not close: ${error}`,
  notAMethod: (name: string) => `${name} is not a function`,
  notImported: "importSharedTexture answered no imported texture",
} as const;

/** A run's frames counters, for leak checks: held slots, retired slots, and frames in and out. */
export interface FramesStats {
  /** Bit per slot of the current ring still held by the renderer. */
  heldMask: number;
  /** Slots of earlier generations still retained. */
  retiredHeld: number;
  accepted: number;
  released: number;
  /** Frames dropped without a fault (a foreign sender's, a stale generation's). */
  dropped: number;
  /** Messages the addon refused (each one fatal). */
  refused: number;
}

/** The ring a run's channel expects: the generation the host chose, its size and slot count. */
export interface FramesRing {
  generation: number;
  width: number;
  height: number;
  slots: number;
}

/** A slot the host gives back to the game (the `release` op's argument). */
export interface FramesSlot {
  slot: number;
  generation: number;
}

/** What a run's channel is opened with: whose run it is, and how a slot goes back to its game. */
export interface FramesRunOpen {
  runId: string;
  project: string;
  /** Sends the game its `release` op; called once a slot's references are all released. */
  release(slot: FramesSlot): void;
}

/** Main's frames host: one channel per embedded run. */
export interface NativeFramesHost {
  /** Why no run can be embedded here (no addon, an untested Electron, no `sharedTexture`), or null. */
  available(): NativeRefusal | null;
  /** Opens the run's channel before its game is spawned; the service name goes to the game profile. Throws `NativeError`. */
  open(run: FramesRunOpen): { service: string };
  /** The game's pid, right after it was spawned: frames from any other sender are dropped. */
  peer(runId: string, pid: number): void;
  /** The next ring generation for a canvas of `size` device pixels (before the `surface` op). Throws `NativeError`. */
  ring(runId: string, size: { width: number; height: number }): FramesRing;
  /** Live cannot show the run (hidden, renderer gone): import nothing, give each slot back at once. */
  pause(runId: string): void;
  resume(runId: string): void;
  /** Closes the run's channel, after its game was killed; idempotent. */
  close(runId: string): void;
  stats(runId: string): FramesStats | null;
}

/** The recorder a frame's timing goes to (`PerformanceRecorder`). */
export interface FramesPerformance {
  now(): number;
  record(channel: string, durationMs: number): void;
}

/** What the frames host is made from. */
export interface NativeFramesOptions {
  /** The app's resources folder: the addon is `native/genex-frames.node` in it, and nowhere else. */
  resources: string;
  /** The running Electron's major version; an untested one is refused `electron-untested`. */
  electronMajor: number;
  /** Electron's main-process `sharedTexture`, typed loosely: the host checks what it needs of it. */
  sharedTexture: unknown;
  /** The studio window's main frame to send frames to, or null while there is none. */
  target: () => unknown;
  timers: NativeTimers;
  /** Ends a run whose frames failed (a fatal addon code, a stalled slot), with the typed refusal. */
  kill(runId: string, refusal: NativeRefusal): void;
  /** Loads the addon at a checked real path (default: `process.dlopen` into a fresh module). */
  load?(file: string): unknown;
  performance?: FramesPerformance;
  /** Where a failure that changes no outcome is written (default: `console.warn`). */
  log?(line: string): void;
}

/** The addon as the host uses it: the one function it exports. */
interface FramesAddon {
  open(runId: string, onEvent: (event: unknown) => void, options: { maxFps: number; burst: number }): unknown;
}

/** One run's channel, checked and bound. */
interface FramesChannel {
  readonly serviceName: string;
  setPeer(pid: number): void;
  expectRing(ring: FramesRing): void;
  release(generation: number, slot: number, seq: number): void;
  stats(): unknown;
  close(): void;
}

/** Electron's main-process `sharedTexture`, the two calls the host makes. */
interface TextureMain {
  importSharedTexture(options: { textureInfo: TextureInfo; allReferencesReleased: () => void }): ImportedTexture;
  sendSharedTexture(
    options: { frame: unknown; importedSharedTexture: unknown },
    meta: NativeFrameMeta,
  ): Promise<unknown>;
}

/** An import: Electron's own object (what a send carries) and its release. */
interface ImportedTexture {
  readonly raw: unknown;
  release(): void;
}

/** What `importSharedTexture` is told about a frame. */
interface TextureInfo {
  pixelFormat: "bgra";
  colorSpace: typeof COLOR_SPACE;
  codedSize: { width: number; height: number };
  visibleRect: { x: number; y: number; width: number; height: number };
  timestamp: number;
  handle: { ioSurface: Buffer };
}

/** A frame event the addon delivered, checked. `ioSurface` is valid only inside the event. */
interface AddonFrame {
  generation: number;
  slot: number;
  seq: number;
  ts: number;
  width: number;
  height: number;
  ioSurface: Buffer;
}

/** One run's channel and what the host knows of it. */
interface FramesRun {
  readonly runId: string;
  readonly project: string;
  readonly channel: FramesChannel;
  readonly release: (slot: FramesSlot) => void;
  generation: number;
  paused: boolean;
  /** Nothing more is imported: the run's frames failed, or its channel closed. */
  done: boolean;
  closed: boolean;
  /** Frames sent and not yet given back, by `generation:slot:seq`, with the watchdog armed once each send resolved. */
  readonly held: Map<string, { watchdog: unknown }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Calls `object[name](...args)` with `object` as `this`; throws when it is no function. */
function invoke(object: Record<string, unknown>, name: string, args: unknown[]): unknown {
  const method = object[name];
  if (typeof method !== "function") throw new TypeError(MESSAGE.notAMethod(name));
  return Reflect.apply(method, object, args);
}

/** Whether `value` names exactly the addon's codes, each fatal unless it is one the addon drops. */
function sameCodes(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== CODES.length || keys.some((key, index) => key !== CODES[index])) return false;
  const dropped = (code: string) => isNativeFramesCode(code) && NATIVE_FRAMES_DROPPED.includes(code);
  return Object.entries(value).every(([code, fatal]) => fatal === !dropped(code));
}

/** The loaded module as the addon this build was made for, or null (another ABI, wire or code table). */
function addonOf(exports: unknown): FramesAddon | null {
  if (!isRecord(exports)) return null;
  const versions =
    exports.abiVersion === NATIVE_FRAMES_ABI_VERSION && exports.wireVersion === NATIVE_FRAMES_WIRE_VERSION;
  const shaped = sameCodes(exports.errorCodes) && typeof exports.open === "function";
  if (!versions || !shaped) return null;
  return { open: (runId, onEvent, options) => invoke(exports, "open", [runId, onEvent, options]) };
}

/** What `open` answered, as a channel bound to it, or null. */
function channelOf(value: unknown): FramesChannel | null {
  if (!isRecord(value) || typeof value.serviceName !== "string") return null;
  if (!CHANNEL_METHODS.every((name) => typeof value[name] === "function")) return null;
  return {
    serviceName: value.serviceName,
    setPeer: (pid) => void invoke(value, "setPeer", [pid]),
    expectRing: (ring) => void invoke(value, "expectRing", [ring]),
    release: (generation, slot, seq) => void invoke(value, "release", [generation, slot, seq]),
    stats: () => invoke(value, "stats", []),
    close: () => void invoke(value, "close", []),
  };
}

/** Electron's `sharedTexture` when it has the two calls, bound to it; null otherwise. */
function textureOf(value: unknown): TextureMain | null {
  if (!isRecord(value)) return null;
  if (typeof value.importSharedTexture !== "function" || typeof value.sendSharedTexture !== "function") return null;
  return {
    importSharedTexture: (options) => importedOf(invoke(value, "importSharedTexture", [options])),
    sendSharedTexture: (options, meta) => Promise.resolve(invoke(value, "sendSharedTexture", [options, meta])),
  };
}

function importedOf(value: unknown): ImportedTexture {
  if (!isRecord(value) || typeof value.release !== "function") throw new TypeError(MESSAGE.notImported);
  return { raw: value, release: () => void invoke(value, "release", []) };
}

/** A frame event, copied; null when a field is not what the addon sends. */
function frameOf(event: Record<string, unknown>): AddonFrame | null {
  const { generation, slot, seq, ts, width, height, ioSurface } = event;
  const counts = [generation, slot, seq, ts, width, height].every(isCount);
  if (!counts || !Buffer.isBuffer(ioSurface)) return null;
  return {
    generation: Number(generation),
    slot: Number(slot),
    seq: Number(seq),
    ts: Number(ts),
    width: Number(width),
    height: Number(height),
    ioSurface,
  };
}

/** The addon's stats as the host reports them; null when they are not its shape. */
function statsOf(value: unknown): FramesStats | null {
  if (!isRecord(value)) return null;
  const { heldMask, retiredHeld, accepted, released, dropped, refused } = value;
  const counts = [heldMask, retiredHeld, accepted, released, dropped, refused];
  if (!counts.every(isCount)) return null;
  return {
    heldMask: Number(heldMask),
    retiredHeld: Number(retiredHeld),
    accepted: Number(accepted),
    released: Number(released),
    dropped: Number(dropped),
    refused: Number(refused),
  };
}

/** The `code` an addon throw carries (`napi_create_error`'s code), or null. */
function codeOf(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

const slotKey = (frame: AddonFrame) => `${frame.generation}:${frame.slot}:${frame.seq}`;

function textureInfo(frame: AddonFrame): TextureInfo {
  const { width, height } = frame;
  return {
    pixelFormat: "bgra",
    colorSpace: COLOR_SPACE,
    codedSize: { width, height },
    visibleRect: { x: 0, y: 0, width, height },
    timestamp: frame.ts,
    handle: { ioSurface: frame.ioSurface },
  };
}

/**
 * The addon's real path when it is a regular file directly in `<resources>/native`, reached
 * through no link (the file and every folder between resources and it); null otherwise.
 */
function addonPath(resources: string): string | null {
  const file = path.join(resources, ADDON_FOLDER, ADDON_FILE);
  try {
    const expected = path.join(realpathSync(resources), ADDON_FOLDER, ADDON_FILE);
    return lstatSync(file).isFile() && realpathSync(file) === expected ? expected : null;
  } catch {
    return null;
  }
}

/** `process.dlopen` into a fresh module object: the one native load in the app (`check-boundaries`). */
function dlopen(file: string): unknown {
  const module = { exports: {} };
  process.dlopen(module, file);
  return module.exports;
}

/** The frames host: refuses with a reason where Live cannot embed, and loads the addon at the first need. */
class NativeFrames implements NativeFramesHost {
  readonly #options: NativeFramesOptions;
  readonly #texture: TextureMain | null;
  readonly #runs = new Map<string, FramesRun>();
  /** The addon once it was looked for: undefined before, null when it is absent or not this build's. */
  #addon: FramesAddon | null | undefined;

  constructor(options: NativeFramesOptions) {
    this.#options = options;
    this.#texture = textureOf(options.sharedTexture);
  }

  available(): NativeRefusal | null {
    const untested = electronSupportsFrames(this.#options.electronMajor);
    if (untested) return untested;
    if (!this.#texture) return NativeRefusal.EmbedUnsupported;
    return this.#loaded() ? null : NativeRefusal.EmbedUnsupported;
  }

  open(run: FramesRunOpen): { service: string } {
    const refusal = this.available();
    const addon = this.#loaded();
    if (refusal || !addon) {
      const why = refusal ?? NativeRefusal.EmbedUnsupported;
      throw new NativeError(why, MESSAGE.unavailable(why));
    }
    const holder: { run: FramesRun | null } = { run: null };
    const channel = this.#openChannel(addon, run.runId, (event) => {
      if (holder.run) this.#event(holder.run, event);
    });
    holder.run = {
      runId: run.runId,
      project: run.project,
      channel,
      release: run.release,
      generation: 0,
      paused: false,
      done: false,
      closed: false,
      held: new Map(),
    };
    this.#runs.set(run.runId, holder.run);
    return { service: channel.serviceName };
  }

  peer(runId: string, pid: number): void {
    const run = this.#run(runId);
    try {
      run.channel.setPeer(pid);
    } catch (error) {
      throw new NativeError(NativeRefusal.FramesInvalid, MESSAGE.peerRefused(runId, errorMessage(error)));
    }
  }

  ring(runId: string, size: { width: number; height: number }): FramesRing {
    const run = this.#run(runId);
    const ring: FramesRing = {
      generation: run.generation + 1,
      width: size.width,
      height: size.height,
      slots: NATIVE_FRAME_SLOTS,
    };
    try {
      run.channel.expectRing(ring);
    } catch (error) {
      const refusal = codeOf(error) === TOO_MANY_HELD ? NativeRefusal.FramesStalled : NativeRefusal.FramesInvalid;
      this.#end(run, refusal);
      throw new NativeError(refusal, MESSAGE.ringRefused(runId, errorMessage(error)));
    }
    run.generation = ring.generation;
    return { ...ring };
  }

  pause(runId: string): void {
    const run = this.#runs.get(runId);
    if (run) run.paused = true;
  }

  resume(runId: string): void {
    const run = this.#runs.get(runId);
    if (run) run.paused = false;
  }

  close(runId: string): void {
    const run = this.#runs.get(runId);
    if (!run) return;
    this.#runs.delete(runId);
    run.done = true;
    run.closed = true;
    for (const held of run.held.values()) this.#options.timers.clearTimeout(held.watchdog);
    run.held.clear();
    try {
      run.channel.close();
    } catch (error) {
      this.#log(MESSAGE.closeFailed(runId, errorMessage(error)));
    }
  }

  stats(runId: string): FramesStats | null {
    const run = this.#runs.get(runId);
    if (!run) return null;
    try {
      return statsOf(run.channel.stats());
    } catch {
      return null;
    }
  }

  // ── loading and opening ─────────────────────────────────────────────────────────────────────

  /** The addon, looked for once: only the checked file, only this build's ABI, wire and codes. */
  #loaded(): FramesAddon | null {
    if (this.#addon !== undefined) return this.#addon;
    this.#addon = null;
    const file = addonPath(this.#options.resources);
    if (!file) return null;
    try {
      this.#addon = addonOf((this.#options.load ?? dlopen)(file));
    } catch (error) {
      this.#log(MESSAGE.loadFailed(file, errorMessage(error)));
      return null;
    }
    if (!this.#addon) this.#log(MESSAGE.notTheAddon(file));
    return this.#addon;
  }

  /** A run's channel on its own service name (`games.genex.frames.<runId>`), with the rate cap; throws `NativeError`. */
  #openChannel(addon: FramesAddon, runId: string, onEvent: (event: unknown) => void): FramesChannel {
    let opened: unknown;
    try {
      opened = addon.open(runId, onEvent, { maxFps: NATIVE_FRAME_RATE_MAX_PER_S, burst: NATIVE_FRAME_BURST });
    } catch (error) {
      throw new NativeError(NativeRefusal.EmbedUnsupported, MESSAGE.openFailed(runId, errorMessage(error)));
    }
    const channel = channelOf(opened);
    if (channel?.serviceName === `${NATIVE_FRAMES_SERVICE_PREFIX}${runId}`) return channel;
    if (channel) channel.close();
    throw new NativeError(NativeRefusal.EmbedUnsupported, MESSAGE.wrongService(runId));
  }

  #run(runId: string): FramesRun {
    const run = this.#runs.get(runId);
    if (!run || run.done) throw new NativeError(NativeRefusal.FramesInvalid, MESSAGE.noRun(runId));
    return run;
  }

  // ── frames ──────────────────────────────────────────────────────────────────────────────────

  #event(run: FramesRun, event: unknown): void {
    if (!isRecord(event) || run.closed) return;
    if (event.type === AddonEvent.Error) {
      const code = event.code;
      this.#end(run, isNativeFramesCode(code) ? nativeRefusalOfFrames(code) : NativeRefusal.FramesInvalid);
      return;
    }
    if (event.type !== AddonEvent.Frame) return;
    const frame = frameOf(event);
    if (frame) this.#frame(run, frame);
    else this.#end(run, NativeRefusal.FramesInvalid);
  }

  /**
   * One frame, synchronously, while the addon's reference to its surface still holds: imported and
   * sent to the studio frame, or (paused, no studio frame, ended) given back at once.
   */
  #frame(run: FramesRun, frame: AddonFrame): void {
    const target = run.paused || run.done ? null : this.#options.target();
    const texture = this.#texture;
    if (!target || !texture) {
      this.#giveBack(run, frame);
      return;
    }
    const began = this.#options.performance?.now() ?? 0;
    let imported: ImportedTexture;
    try {
      imported = texture.importSharedTexture({
        textureInfo: textureInfo(frame),
        allReferencesReleased: () => this.#released(run, frame),
      });
    } catch (error) {
      this.#log(MESSAGE.importFailed(run.runId, errorMessage(error)));
      this.#giveBack(run, frame);
      return;
    }
    run.held.set(slotKey(frame), { watchdog: null });
    this.#send(run, frame, { texture, imported, target, began });
  }

  /** Sends the import; main's own reference is released exactly once, when the send settles either way. */
  #send(
    run: FramesRun,
    frame: AddonFrame,
    sending: { texture: TextureMain; imported: ImportedTexture; target: unknown; began: number },
  ): void {
    const { texture, imported, target, began } = sending;
    const meta: NativeFrameMeta = {
      project: run.project,
      runId: run.runId,
      generation: frame.generation,
      seq: frame.seq,
      slot: frame.slot,
      width: frame.width,
      height: frame.height,
    };
    let sent: Promise<unknown>;
    try {
      sent = texture.sendSharedTexture({ frame: target, importedSharedTexture: imported.raw }, meta);
    } catch (error) {
      sent = Promise.reject(error);
    }
    void sent.then(
      () => {
        this.#releaseImport(run, imported);
        this.#arm(run, slotKey(frame));
        const { performance } = this.#options;
        performance?.record(FRAME_CHANNEL, performance.now() - began);
      },
      (error: unknown) => {
        this.#releaseImport(run, imported);
        this.#log(MESSAGE.sendFailed(run.runId, errorMessage(error)));
      },
    );
  }

  #releaseImport(run: FramesRun, imported: ImportedTexture): void {
    try {
      imported.release();
    } catch (error) {
      this.#log(MESSAGE.releaseFailed(run.runId, errorMessage(error)));
    }
  }

  /** The send resolved: the renderer must give the frame back within the watchdog. */
  #arm(run: FramesRun, key: string): void {
    const held = run.held.get(key);
    if (!held || run.done) return;
    held.watchdog = this.#options.timers.setTimeout(() => this.#stalled(run), NATIVE_FRAME_SLOT_WATCHDOG_MS);
  }

  /** Every reference to the frame is released: the slot goes back to the addon, then to the game. */
  #released(run: FramesRun, frame: AddonFrame): void {
    const held = run.held.get(slotKey(frame));
    if (held) this.#options.timers.clearTimeout(held.watchdog);
    run.held.delete(slotKey(frame));
    this.#giveBack(run, frame);
  }

  #giveBack(run: FramesRun, frame: AddonFrame): void {
    if (run.closed) return;
    try {
      run.channel.release(frame.generation, frame.slot, frame.seq);
      run.release({ slot: frame.slot, generation: frame.generation });
    } catch (error) {
      this.#log(MESSAGE.releaseFailed(run.runId, errorMessage(error)));
    }
  }

  /** A slot outlived the watchdog: no receiver drew it. The run ends; the studio window is left alone. */
  #stalled(run: FramesRun): void {
    if (run.done) return;
    this.#log(MESSAGE.stalled(run.runId, JSON.stringify(this.stats(run.runId))));
    this.#end(run, NativeRefusal.FramesStalled);
  }

  /** The run's frames failed: nothing more is imported, the game is killed, then the channel closes. */
  #end(run: FramesRun, refusal: NativeRefusal): void {
    if (run.done) return;
    run.done = true;
    this.#log(MESSAGE.ended(run.runId, refusal));
    // Inside the addon's event: a throw here would reach Electron's main loop uncaught.
    try {
      this.#options.kill(run.runId, refusal);
    } catch (error) {
      this.#log(MESSAGE.killFailed(run.runId, errorMessage(error)));
    }
    this.close(run.runId);
  }

  #log(line: string): void {
    (this.#options.log ?? console.warn)(line);
  }
}

/**
 * The frames host. It always answers: where Live cannot embed (no addon, another build of it, an
 * untested Electron, no `sharedTexture`) `available()` says why and `open` refuses with it, so the
 * renderer offers Pop out. The addon is loaded at the first `available()` or `open`, never at boot.
 */
export function createNativeFrames(options: NativeFramesOptions): NativeFramesHost {
  return new NativeFrames(options);
}
