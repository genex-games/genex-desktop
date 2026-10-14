/**
 * Live's embedded frames, main's half (`main/native-frames.ts`, `main/electron-gate.ts`) and the
 * embedded runs the registry starts with them (`NativeRuns.embed`). The addon is a fake with the
 * README's API, Electron's `sharedTexture` a fake that keeps references as RESULTS §5 measured
 * them, and time a fake clock: no row waits out a NATIVE_* constant, and no game process runs.
 */
import assert from "node:assert/strict";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Duplex, PassThrough } from "node:stream";
import { setImmediate as tick } from "node:timers/promises";
import { describe, it } from "node:test";
import { nativeOnRendererGone } from "../../src/main/core/native-lifecycle.ts";
import { NativeRuns } from "../../src/main/core/native-runs.ts";
import { ELECTRON_TESTED_MAJORS, electronSupportsFrames } from "../../src/main/electron-gate.ts";
import { createNativeFrames } from "../../src/main/native-frames.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import {
  NATIVE_FRAME_SLOT_WATCHDOG_MS,
  NATIVE_FRAMES_DROPPED,
  NATIVE_FRAMES_SERVICE_PREFIX,
  NATIVE_RESIZE_DEBOUNCE_MS,
  NativeError,
  NativeEvent,
  NativeFramesCode,
  NativeRefusal,
  NativeRunMode,
  NativeRunState,
  type NativeRunStatus,
  type NativeTimers,
  nativeRefusalOfFrames,
} from "../../src/shared/native-contract.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { NativeGamePort } from "../../src/substrate/native-game-port.ts";
import type { GameChild, GameSpawnRequest } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

function fakeClock() {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  const timers: NativeTimers = {
    now: () => now,
    setTimeout: (run, ms) => {
      seq += 1;
      due.set(seq, { at: now + ms, run });
      return seq;
    },
    clearTimeout: (handle) => {
      if (typeof handle === "number") due.delete(handle);
    },
  };
  const settle = async () => {
    for (let round = 0; round < 12; round++) await tick();
  };
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      await settle();
      const next = [...due.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      const first = next[0];
      if (!first) break;
      due.delete(first[0]);
      now = first[1].at;
      first[1].run();
    }
    now = until;
    await settle();
  };
  return { timers, advance, settle, now: () => now };
}

/** Every fatal flag the addon reports, as `gxf_code_is_fatal` has it: all but the two dropped codes. */
function errorCodes(): Record<string, boolean> {
  return Object.fromEntries(
    Object.values(NativeFramesCode).map((code) => [code, !NATIVE_FRAMES_DROPPED.includes(code)]),
  );
}

/** One run's fake channel: what it was told, and the frames the row has the game send through it. */
interface FakeChannel {
  runId: string;
  options: unknown;
  rings: Array<{ generation: number; width: number; height: number; slots: number }>;
  /** The addon accepted a frame in `slot` of the current ring. */
  frame(slot: number, seq: number): void;
  /** The addon refused a message: the one fatal event of the run. */
  fail(code: string): void;
  /** `expectRing` throws this ring error from now on. */
  refuseRings(code: string): void;
  closed(): boolean;
}

/** The genex-frames addon as its README describes it; every call lands in `calls`, in order. */
function fakeAddon(calls: string[]) {
  const channels = new Map<string, FakeChannel>();
  const open = (runId: string, onEvent: (event: unknown) => void, options: unknown) => {
    calls.push(`open ${runId}`);
    const rings: FakeChannel["rings"] = [];
    let closed = false;
    let ringError: string | null = null;
    const ring = () => rings.at(-1) ?? { generation: 0, width: 1, height: 1, slots: 3 };
    const channel: FakeChannel = {
      runId,
      options,
      rings,
      frame: (slot, seq) => {
        const { generation, width, height } = ring();
        onEvent({
          type: "frame",
          generation,
          slot,
          seq,
          ts: seq * 16_667,
          receivedAt: seq * 16_667 + 30,
          width,
          height,
          pixelFormat: "bgra",
          surfaceId: 100 + slot,
          ioSurface: Buffer.alloc(8, slot + 1),
        });
      },
      fail: (code) => onEvent({ type: "error", code, fatal: true }),
      refuseRings: (code) => {
        ringError = code;
      },
      closed: () => closed,
    };
    channels.set(runId, channel);
    return {
      serviceName: `${NATIVE_FRAMES_SERVICE_PREFIX}${runId}`,
      setPeer: (pid: number) => {
        calls.push(`setPeer ${pid}`);
        return true;
      },
      expectRing: (asked: { generation: number; width: number; height: number; slots: number }) => {
        calls.push(`expectRing ${asked.generation} ${asked.width}x${asked.height}/${asked.slots}`);
        if (ringError) throw Object.assign(new Error("ring refused"), { code: ringError });
        rings.push({ ...asked });
      },
      release: (generation: number, slot: number, seq: number) => {
        calls.push(`release ${generation}/${slot}/${seq}`);
        return true;
      },
      stats: () => ({
        received: 9,
        accepted: 8,
        refused: 1,
        dropped: 2,
        released: 7,
        generation: ring().generation,
        heldMask: 1,
        retiredHeld: 0,
        peer: 0,
        open: !closed,
        fault: null,
      }),
      close: () => {
        calls.push("close");
        closed = true;
      },
    };
  };
  const addon = { abiVersion: 1, wireVersion: 1, maxSlots: 3, servicePrefix: NATIVE_FRAMES_SERVICE_PREFIX };
  return { addon: { ...addon, errorCodes: errorCodes(), open }, channels };
}

/** One import the fake `sharedTexture` made. */
interface FakeImport {
  info: Record<string, unknown>;
  handle: { release(): void };
  mainReleases: number;
  /** The renderer still holds the frame it was sent. */
  rendererHolds: boolean;
  fired: number;
  fire(): void;
}

/** One send the fake `sharedTexture` is answering. */
interface FakeSend {
  frame: unknown;
  meta: unknown;
  imported: FakeImport;
  /** The renderer imported the frame: the send resolves, and the renderer holds it until `drawn`. */
  resolve(): void;
  /** No receiver answered in Electron's 1000 ms: the send rejects and the renderer holds nothing. */
  timeOut(): void;
  /** The renderer drew the frame and gave it back. */
  drawn(): void;
}

/**
 * Electron's main-process `sharedTexture` as RESULTS §5 measured it: an import is held by main and
 * by the renderer it was sent to; `allReferencesReleased` fires on a later turn, once, when both let go.
 */
function fakeTexture() {
  const imports: FakeImport[] = [];
  const sends: FakeSend[] = [];
  const texture = {
    importSharedTexture(options: { textureInfo: Record<string, unknown>; allReferencesReleased: () => void }) {
      const imported: FakeImport = {
        info: options.textureInfo,
        handle: { release: () => {} },
        mainReleases: 0,
        rendererHolds: false,
        fired: 0,
        fire: () => {
          if (imported.mainReleases === 0 || imported.rendererHolds || imported.fired > 0) return;
          imported.fired += 1;
          setImmediate(options.allReferencesReleased);
        },
      };
      imported.handle = {
        release: () => {
          imported.mainReleases += 1;
          imported.fire();
        },
      };
      imports.push(imported);
      return imported.handle;
    },
    sendSharedTexture(options: { frame: unknown; importedSharedTexture: unknown }, meta: unknown) {
      const imported = imports.find((one) => one.handle === options.importedSharedTexture);
      assert.ok(imported, "the send carries the import main made");
      let resolve: () => void = () => {};
      let reject: (error: Error) => void = () => {};
      const answer = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      sends.push({
        frame: options.frame,
        meta,
        imported,
        resolve: () => {
          imported.rendererHolds = true;
          resolve();
        },
        timeOut: () =>
          reject(
            new Error(
              "transfer shared texture timed out after 1000ms, ensure you have registered receiver at renderer process.",
            ),
          ),
        drawn: () => {
          imported.rendererHolds = false;
          imported.fire();
        },
      });
      return answer;
    },
  };
  return { texture, imports, sends };
}

/** The studio window's main frame, as `target()` hands it over. */
const STUDIO_FRAME = { name: "the studio window's main frame" };

/** A resources folder holding a (placeholder) addon where the app looks for it. */
async function resourcesWithAddon(): Promise<string> {
  const resources = await tmpDir("native-frames-resources-");
  await mkdir(path.join(resources, "native"));
  await writeFile(path.join(resources, "native", "genex-frames.node"), "a placeholder: the fake load reads nothing");
  return resources;
}

interface FramesRigOptions {
  electronMajor?: number;
  addon?: unknown;
  sharedTexture?: unknown;
  resources?: string;
  load?: (file: string) => unknown;
  /** Kills a run as the registry would (the rig records the kill either way). */
  kill?: (runId: string, refusal: NativeRefusal) => void;
}

/** The frames host over the fakes: what it loaded, killed and recorded, and the calls the addon saw. */
async function framesRig(options: FramesRigOptions = {}) {
  const resources = options.resources ?? (await resourcesWithAddon());
  const calls: string[] = [];
  const fake = fakeAddon(calls);
  const clock = fakeClock();
  const textures = fakeTexture();
  const loaded: string[] = [];
  const killed: Array<[string, NativeRefusal]> = [];
  const recorded: string[] = [];
  const logs: string[] = [];
  const show = { target: STUDIO_FRAME as unknown };
  const host = createNativeFrames({
    resources,
    electronMajor: options.electronMajor ?? 43,
    sharedTexture: options.sharedTexture === undefined ? textures.texture : options.sharedTexture,
    target: () => show.target,
    timers: clock.timers,
    kill: (runId, refusal) => {
      calls.push(`kill ${refusal}`);
      killed.push([runId, refusal]);
      options.kill?.(runId, refusal);
    },
    load:
      options.load ??
      ((file) => {
        loaded.push(file);
        return options.addon ?? fake.addon;
      }),
    performance: { now: clock.now, record: (channel) => void recorded.push(channel) },
    log: (line) => void logs.push(line),
  });
  return { host, resources, calls, fake, clock, textures, loaded, killed, recorded, logs, show };
}

type FramesRig = Awaited<ReturnType<typeof framesRig>>;

/** Opens `runId` on the rig's host with one 1280x720 ring, peered with pid 4242: the channel and the game's release ops. */
function openRun(rig: FramesRig, runId = "0123456789ab") {
  const gameReleases: Array<{ slot: number; generation: number }> = [];
  const opened = rig.host.open({ runId, project: "pong", release: (op) => void gameReleases.push({ ...op }) });
  rig.host.peer(runId, 4242);
  const ring = rig.host.ring(runId, { width: 1280, height: 720 });
  const channel = rig.fake.channels.get(runId);
  assert.ok(channel, "the run opened a channel");
  return { opened, ring, channel, gameReleases, runId };
}

describe("one frame's way: import, send, release", () => {
  it("is imported as the IOSurface it names, sent to the studio frame with its meta, and given back once every reference is released", async () => {
    const rig = await framesRig();
    const { opened, ring, channel, gameReleases, runId } = openRun(rig);
    assert.deepEqual(opened, { service: `${NATIVE_FRAMES_SERVICE_PREFIX}${runId}` });
    assert.deepEqual(ring, { generation: 1, width: 1280, height: 720, slots: 3 });
    channel.frame(0, 1);
    const [imported] = rig.textures.imports;
    assert.ok(imported, "the frame was imported at once, inside the event");
    assert.deepEqual(
      { ...imported.info, handle: null },
      {
        pixelFormat: "bgra",
        colorSpace: { primaries: "bt709", transfer: "srgb", matrix: "rgb", range: "full" },
        codedSize: { width: 1280, height: 720 },
        visibleRect: { x: 0, y: 0, width: 1280, height: 720 },
        timestamp: 16_667,
        handle: null,
      },
    );
    assert.deepEqual(imported.info.handle, { ioSurface: Buffer.alloc(8, 1) }, "the IOSurfaceRef the addon handed over");
    const [send] = rig.textures.sends;
    assert.ok(send);
    assert.equal(send.frame, STUDIO_FRAME);
    assert.deepEqual(send.meta, { project: "pong", runId, generation: 1, seq: 1, slot: 0, width: 1280, height: 720 });
    send.resolve();
    await rig.clock.settle();
    assert.equal(imported.mainReleases, 1, "main lets go once the send settled");
    assert.ok(!rig.calls.some((call) => call.startsWith("release")), "the renderer still holds it: the slot stays");
    assert.deepEqual(gameReleases, []);
    send.drawn();
    await rig.clock.settle();
    assert.deepEqual(
      rig.calls.filter((call) => call.startsWith("release")),
      ["release 1/0/1"],
    );
    assert.deepEqual(gameReleases, [{ slot: 0, generation: 1 }]);
    assert.deepEqual(rig.recorded, ["native:frame"]);
  });

  it("releases its import exactly once, whether the send resolves or rejects", async () => {
    const rig = await framesRig();
    const { channel } = openRun(rig);
    channel.frame(0, 1);
    channel.frame(1, 2);
    const [resolved, rejected] = rig.textures.sends;
    assert.ok(resolved && rejected);
    resolved.resolve();
    rejected.timeOut();
    await rig.clock.settle();
    resolved.drawn();
    await rig.clock.settle();
    assert.deepEqual(
      rig.textures.imports.map((one) => one.mainReleases),
      [1, 1],
    );
    assert.deepEqual(
      rig.textures.imports.map((one) => one.fired),
      [1, 1],
      "each allReferencesReleased once",
    );
  });

  it("a send Electron times out (no receiver in 1000 ms) neither hangs the run nor keeps its slot", async () => {
    const rig = await framesRig();
    const { channel, gameReleases } = openRun(rig);
    channel.frame(2, 1);
    rig.textures.sends[0]?.timeOut();
    await rig.clock.settle();
    assert.deepEqual(gameReleases, [{ slot: 2, generation: 1 }], "the slot went back to the game");
    assert.ok(rig.calls.includes("release 1/2/1"));
    channel.frame(2, 2);
    assert.equal(rig.textures.sends.length, 2, "later frames are still sent");
    await rig.clock.advance(NATIVE_FRAME_SLOT_WATCHDOG_MS * 2);
    assert.deepEqual(rig.killed, [], "a rejected send is no stalled slot");
  });

  it("a paused run, or one with no studio frame to show it, imports nothing and gives the slot back at once", async () => {
    const rig = await framesRig();
    const { channel, gameReleases, runId } = openRun(rig);
    rig.host.pause(runId);
    channel.frame(0, 1);
    rig.host.resume(runId);
    rig.show.target = null;
    channel.frame(1, 2);
    assert.equal(rig.textures.imports.length, 0, "nothing imported");
    assert.deepEqual(
      rig.calls.filter((call) => call.startsWith("release")),
      ["release 1/0/1", "release 1/1/2"],
    );
    assert.deepEqual(gameReleases, [
      { slot: 0, generation: 1 },
      { slot: 1, generation: 1 },
    ]);
    rig.show.target = STUDIO_FRAME;
    channel.frame(2, 3);
    assert.equal(rig.textures.sends.length, 1, "shown again: sent");
  });
});

describe("a run whose frames fail", () => {
  it("a slot still held 2 s after its send resolved ends the run frames-stalled, not before", async () => {
    const rig = await framesRig();
    const { channel, runId } = openRun(rig);
    channel.frame(0, 1);
    rig.textures.sends[0]?.resolve();
    await rig.clock.advance(NATIVE_FRAME_SLOT_WATCHDOG_MS - 1);
    assert.deepEqual(rig.killed, [], "not before the watchdog");
    await rig.clock.advance(1);
    assert.deepEqual(rig.killed, [[runId, NativeRefusal.FramesStalled]]);
    assert.deepEqual(rig.calls.slice(-2), [`kill ${NativeRefusal.FramesStalled}`, "close"], "killed, then closed");
    assert.ok(
      rig.logs.some((line) => line.includes(runId) && line.includes("heldMask")),
      "the log says why, with the stats",
    );
    channel.frame(1, 2);
    assert.equal(rig.textures.sends.length, 1, "nothing more is sent");
    assert.equal(rig.host.stats(runId), null, "the channel is gone");
  });

  it("a slot given back in time keeps the run", async () => {
    const rig = await framesRig();
    const { channel } = openRun(rig);
    channel.frame(0, 1);
    const [send] = rig.textures.sends;
    send?.resolve();
    await rig.clock.advance(NATIVE_FRAME_SLOT_WATCHDOG_MS - 1);
    send?.drawn();
    await rig.clock.advance(NATIVE_FRAME_SLOT_WATCHDOG_MS * 2);
    assert.deepEqual(rig.killed, []);
  });

  it("every fatal code ends the run with its typed refusal, kills the game and closes the channel", async () => {
    const fatal = Object.values(NativeFramesCode).filter((code) => !NATIVE_FRAMES_DROPPED.includes(code));
    assert.equal(fatal.length, 24);
    for (const code of fatal) {
      const rig = await framesRig();
      const { channel, runId } = openRun(rig);
      channel.fail(code);
      assert.deepEqual(rig.killed, [[runId, nativeRefusalOfFrames(code)]], code);
      assert.deepEqual(rig.calls.slice(-2), [`kill ${nativeRefusalOfFrames(code)}`, "close"], code);
      assert.ok(channel.closed(), code);
      channel.frame(0, 1);
      assert.equal(rig.textures.imports.length, 0, `${code}: nothing after the fatal event`);
    }
    const unknown = await framesRig();
    const run = openRun(unknown);
    run.channel.fail("a-code-from-a-newer-addon");
    assert.deepEqual(unknown.killed, [[run.runId, NativeRefusal.FramesInvalid]]);
  });

  it("each ring is the next generation from 1; too many retired slots held ends the run frames-stalled", async () => {
    const rig = await framesRig();
    const { channel, runId } = openRun(rig);
    assert.deepEqual(rig.host.ring(runId, { width: 640, height: 360 }), {
      generation: 2,
      width: 640,
      height: 360,
      slots: 3,
    });
    channel.refuseRings("too-many-held");
    assert.throws(
      () => rig.host.ring(runId, { width: 320, height: 180 }),
      (error: unknown) => error instanceof NativeError && error.refusal === NativeRefusal.FramesStalled,
    );
    assert.deepEqual(rig.killed, [[runId, NativeRefusal.FramesStalled]]);
    assert.deepEqual(
      rig.calls.filter((call) => call.startsWith("expectRing")),
      ["expectRing 1 1280x720/3", "expectRing 2 640x360/3", "expectRing 3 320x180/3"],
    );
  });

  it("stats are the addon's counters for leak checks; a closed run has none", async () => {
    const rig = await framesRig();
    const { runId } = openRun(rig);
    assert.deepEqual(rig.host.stats(runId), {
      heldMask: 1,
      retiredHeld: 0,
      accepted: 8,
      released: 7,
      dropped: 2,
      refused: 1,
    });
    rig.host.close(runId);
    rig.host.close(runId);
    assert.equal(rig.calls.filter((call) => call === "close").length, 1, "close is idempotent");
    assert.equal(rig.host.stats(runId), null);
  });

  it("opens each run with the rate cap and burst, on the run's own service name", async () => {
    const rig = await framesRig();
    const { channel } = openRun(rig, "abcdef012345");
    assert.deepEqual(channel.options, { maxFps: 240, burst: 16 });
  });
});

describe("what the app loads, and where it refuses to", () => {
  it("only resources/native/genex-frames.node, by its real path, loaded once", async () => {
    const rig = await framesRig();
    assert.equal(rig.host.available(), null);
    assert.equal(rig.host.available(), null);
    const real = path.join(await realResources(rig.resources), "native", "genex-frames.node");
    assert.deepEqual(rig.loaded, [real]);
  });

  it("a missing addon, a folder, a link, or a linked native folder is never loaded: embed-unsupported", async () => {
    const outside = await tmpDir("native-frames-outside-");
    await writeFile(path.join(outside, "genex-frames.node"), "elsewhere");
    const rows: Array<[string, (resources: string) => Promise<void>]> = [
      ["no addon", async () => {}],
      ["a folder named as the addon", async (r) => mkdir(path.join(r, "native", "genex-frames.node"))],
      [
        "a link to an addon elsewhere",
        async (r) => symlink(path.join(outside, "genex-frames.node"), path.join(r, "native", "genex-frames.node")),
      ],
    ];
    for (const [label, plant] of rows) {
      const resources = await tmpDir("native-frames-hostile-");
      await mkdir(path.join(resources, "native"));
      await plant(resources);
      const rig = await framesRig({ resources });
      assert.equal(rig.host.available(), NativeRefusal.EmbedUnsupported, label);
      assert.deepEqual(rig.loaded, [], `${label}: nothing loaded`);
      assert.throws(
        () => rig.host.open({ runId: "0123456789ab", project: "pong", release: () => {} }),
        (error: unknown) => error instanceof NativeError && error.refusal === NativeRefusal.EmbedUnsupported,
        label,
      );
      assert.deepEqual(rig.calls, [], `${label}: no channel`);
    }
    const linked = await tmpDir("native-frames-linked-");
    await mkdir(path.join(outside, "native"));
    await writeFile(path.join(outside, "native", "genex-frames.node"), "elsewhere");
    await symlink(path.join(outside, "native"), path.join(linked, "native"));
    const rig = await framesRig({ resources: linked });
    assert.equal(rig.host.available(), NativeRefusal.EmbedUnsupported, "a native folder that is a link out");
    assert.deepEqual(rig.loaded, []);
  });

  it("an addon of another ABI, wire version or code table is not used: embed-unsupported", async () => {
    const good = fakeAddon([]).addon;
    const codes = errorCodes();
    const { [NativeFramesCode.Rate]: _rate, ...missing } = codes;
    const rows: Array<[string, unknown]> = [
      ["abiVersion 2", { ...good, abiVersion: 2 }],
      ["wireVersion 2", { ...good, wireVersion: 2 }],
      ["a code missing", { ...good, errorCodes: missing }],
      ["a code added", { ...good, errorCodes: { ...codes, "new-code": true } }],
      ["a dropped code made fatal", { ...good, errorCodes: { ...codes, [NativeFramesCode.StaleGeneration]: true } }],
      ["no open", { ...good, open: undefined }],
      ["not an object", 7],
    ];
    for (const [label, addon] of rows) {
      const rig = await framesRig({ addon });
      assert.equal(rig.host.available(), NativeRefusal.EmbedUnsupported, label);
    }
    const throwing = await framesRig({
      load: () => {
        throw new Error("dlopen(genex-frames.node): code signature not valid");
      },
    });
    assert.equal(throwing.host.available(), NativeRefusal.EmbedUnsupported, "a load that throws does not crash");
    assert.ok(throwing.logs.some((line) => line.includes("code signature")));
  });

  it("an untested Electron is refused electron-untested before anything is loaded", async () => {
    assert.deepEqual([...ELECTRON_TESTED_MAJORS], [43]);
    for (const major of [41, 42, 44]) {
      assert.equal(electronSupportsFrames(major), NativeRefusal.ElectronUntested, String(major));
      const rig = await framesRig({ electronMajor: major });
      assert.equal(rig.host.available(), NativeRefusal.ElectronUntested, String(major));
      assert.deepEqual(rig.loaded, [], `${major}: nothing loaded`);
    }
    assert.equal(electronSupportsFrames(43), null);
  });

  it("an Electron without sharedTexture embeds nothing", async () => {
    const rig = await framesRig({ sharedTexture: {} });
    assert.equal(rig.host.available(), NativeRefusal.EmbedUnsupported);
  });
});

async function realResources(resources: string): Promise<string> {
  return realpath(resources);
}

// ── embedded runs through the registry ──────────────────────────────────────────────────────

/** How the scripted game answers `surface`. */
interface GameBehaviour {
  /** A game made before embedding has no `surface` op: it answers `unknown-op`, as every template game does. */
  predatesEmbedding?: boolean;
  /** A game with the ring answers `surface` with this refusal (`surface-failed`, `no-frames-service`, …). */
  surfaceRefusal?: string;
}

/** A game in memory that speaks the protocol: ready, then state, surface, release, pause/start, audio, input, quit. */
function embeddedGame(request: GameSpawnRequest, pid: number, calls: string[], behaviour: GameBehaviour) {
  const toGame = new PassThrough();
  const fromGame = new PassThrough();
  let reap: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  let reaped = false;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    reap = (exit) => {
      if (reaped) return;
      reaped = true;
      calls.push("exited");
      done(exit);
    };
  });
  const send = (value: unknown) => fromGame.write(`${JSON.stringify(value)}\n`);
  const releases: unknown[] = [];
  const inputs: unknown[] = [];
  const answer = (id: number, op: string, arg: Record<string, unknown>) => {
    if (op === "surface") {
      calls.push(`op surface ${String(arg.generation)} ${String(arg.w)}x${String(arg.h)} dpr ${String(arg.dpr)}`);
      if (behaviour.predatesEmbedding) return send({ id, ok: false, op, error: "unknown-op" });
      if (behaviour.surfaceRefusal) return send({ id, ok: false, op, error: behaviour.surfaceRefusal });
      const result = { generation: arg.generation, width: arg.w, height: arg.h, slots: arg.slots };
      return send({ id, ok: true, op, result });
    }
    calls.push(`op ${op}`);
    if (op === "release") releases.push(arg);
    if (op === "input") inputs.push(arg);
    const results: Record<string, unknown> = {
      state: { tick: 1 },
      release: {},
      pause: { running: false },
      start: { running: true },
      audio: { muted: arg.muted === true },
      input: { held: [] },
      quit: { quitting: true },
    };
    if (op === "quit") setImmediate(() => reap({ code: 0, signal: null }));
    if (op in results) send({ id, ok: true, op, result: results[op] });
  };
  let buffered = "";
  toGame.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
      const { id, op, arg } = JSON.parse(buffered.slice(0, end)) as { id: number; op: string; arg?: object };
      buffered = buffered.slice(end + 1);
      answer(id, op, { ...arg });
    }
  });
  const child: GameChild = {
    pid,
    fd3: Duplex.from({ readable: fromGame, writable: toGame }),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exited,
    kill: (signal) => {
      calls.push(`signal ${signal}`);
      if (signal === "SIGTERM" || signal === "SIGKILL") setImmediate(() => reap({ code: null, signal }));
    },
  };
  setImmediate(() =>
    send({
      event: NativeEvent.Ready,
      nonce: request.nonce,
      protocol: 1,
      contractVersion: 1,
      build: "test",
      backend: { api: "metal-angle", device: "Apple M4" },
      size: { width: 320, height: 180 },
      seed: 0,
    }),
  );
  return { child, releases, inputs };
}

/** The frames service a spawn request carries (`GameSpawnRequest.frames`), or null. */
function framesServiceOf(request: GameSpawnRequest): string | null {
  return "frames" in request && typeof request.frames === "string" ? request.frames : null;
}

/** The real registry over a scripted game and the frames host over the fakes; `frames: null` stands in no host. */
async function embeddedRig(options: { behaviour?: GameBehaviour; frames?: null; electronMajor?: number } = {}) {
  const root = await tmpDir("native-frames-runs-");
  const holder: { runs: NativeRuns | null } = { runs: null };
  const rig = await framesRig({
    electronMajor: options.electronMajor,
    kill: (runId, refusal) => holder.runs?.kill(runId, refusal),
  });
  const games: Array<ReturnType<typeof embeddedGame>> = [];
  const statuses: NativeRunStatus[] = [];
  const prepared: string[] = [];
  const runs = new NativeRuns({
    root,
    timers: rig.clock.timers,
    prepare: async (request) => {
      prepared.push(request.mode);
      const runDir = path.join(root, request.runId);
      await mkdir(path.join(runDir, "state"), { recursive: true });
      return {
        runId: request.runId,
        runDir,
        exe: path.join(runDir, "bundle", "Game.app", "Contents", "MacOS", "game"),
        bundle: path.join(runDir, "bundle"),
        state: path.join(runDir, "state"),
        bundleId: "games.genex.game.0123456789ab",
      };
    },
    spawn: async (request) => {
      rig.calls.push(`spawn ${request.mode} ${framesServiceOf(request) ?? "no frames"}`);
      const game = embeddedGame(request, 6000 + games.length, rig.calls, options.behaviour ?? {});
      games.push(game);
      return game.child;
    },
    connect: (child, io) => new NativeGamePort({ ...io, child, encodeJpeg: async () => Buffer.alloc(0) }),
    emit: (event) => {
      if (event.type === UiEvent.NativeStatus) statuses.push(event.payload);
    },
    sampleFootprint: async () => 1024,
    descendants: async () => [],
    startedAt: async () => null,
    signal: () => {},
    log: () => {},
    frames: options.frames === null ? null : rig.host,
  });
  holder.runs = runs;
  return { ...rig, runs, games, statuses, prepared };
}

type EmbeddedRig = Awaited<ReturnType<typeof embeddedRig>>;

const SURFACE = { width: 1280, height: 720, dpr: 2 };

/** Embeds pong and lets its first ring land; answers the run's status. */
async function embedded(rig: EmbeddedRig): Promise<NativeRunStatus> {
  const embedding = rig.runs.embed({ project: "pong", target: BuildTarget.Mac, surface: SURFACE });
  await rig.clock.settle();
  return embedding;
}

/** The calls about the run's frames and its game, in order, without the heartbeat. */
const lifecycle = (calls: string[]) =>
  calls.filter((call) => !call.startsWith("op state")).map((call) => call.replace(/[0-9a-f]{12}/g, "<run>"));

describe("an embedded run", () => {
  it("opens its frames channel before the game is spawned, peers it right after, rings after ready, and closes after the game is gone", async () => {
    const rig = await embeddedRig();
    const status = await embedded(rig);
    assert.deepEqual(
      [status.mode, status.state, status.target],
      [NativeRunMode.Embedded, NativeRunState.Ready, "macos"],
    );
    assert.deepEqual(rig.prepared, [NativeRunMode.Embedded]);
    assert.deepEqual(lifecycle(rig.calls), [
      "open <run>",
      `spawn ${NativeRunMode.Embedded} ${NATIVE_FRAMES_SERVICE_PREFIX}<run>`,
      "setPeer 6000",
      "expectRing 1 1280x720/3",
      "op surface 1 1280x720 dpr 2",
    ]);
    await rig.runs.stop(status.runId);
    const after = lifecycle(rig.calls).slice(5);
    assert.ok(after.indexOf("close") > after.indexOf("exited"), `closed after the game ended: ${after.join(", ")}`);
    assert.equal(rig.statuses.at(-1)?.state, NativeRunState.Stopped);
  });

  it("its frames reach the studio frame as the run's, and each slot goes back to its game", async () => {
    const rig = await embeddedRig();
    const status = await embedded(rig);
    const channel = rig.fake.channels.get(status.runId);
    channel?.frame(1, 1);
    const [send] = rig.textures.sends;
    assert.deepEqual(send?.meta, {
      project: "pong",
      runId: status.runId,
      generation: 1,
      seq: 1,
      slot: 1,
      width: 1280,
      height: 720,
    });
    send?.resolve();
    send?.drawn();
    await rig.clock.settle();
    assert.deepEqual(rig.games[0]?.releases, [{ slot: 1, generation: 1 }]);
    await rig.runs.stop(status.runId);
  });

  it("a resize storm (10 within 80 ms) is one new ring: one expectRing and one surface op, the next generation", async () => {
    const rig = await embeddedRig();
    const status = await embedded(rig);
    for (let step = 0; step < 10; step++) {
      if (step > 0) await rig.clock.advance(5);
      assert.equal(rig.runs.resize("pong", { width: 1000 + step, height: 500, dpr: 2 }), true);
    }
    await rig.clock.advance(NATIVE_RESIZE_DEBOUNCE_MS - 1);
    const rings = () => lifecycle(rig.calls).filter((call) => /expectRing|surface/.test(call));
    assert.equal(rings().length, 2, "nothing until the canvas held still");
    await rig.clock.advance(1);
    assert.deepEqual(rings(), [
      "expectRing 1 1280x720/3",
      "op surface 1 1280x720 dpr 2",
      "expectRing 2 1009x500/3",
      "op surface 2 1009x500 dpr 2",
    ]);
    assert.equal(rig.runs.resize("tetris", SURFACE), false, "no embedded run of that game");
    await rig.runs.stop(status.runId);
  });

  it("hidden Live sends nothing until it is shown: the game is paused and each slot goes back at once", async () => {
    const rig = await embeddedRig();
    const status = await embedded(rig);
    const channel = rig.fake.channels.get(status.runId);
    rig.runs.showEmbedded("pong", false);
    await rig.clock.settle();
    channel?.frame(0, 1);
    await rig.clock.settle();
    assert.equal(rig.textures.sends.length, 0, "no send while hidden");
    assert.deepEqual(rig.games[0]?.releases, [{ slot: 0, generation: 1 }]);
    rig.runs.showEmbedded("pong", true);
    await rig.clock.settle();
    channel?.frame(1, 2);
    assert.equal(rig.textures.sends.length, 1, "shown: sent again");
    const ops = lifecycle(rig.calls).filter((call) => call === "op pause" || call === "op start");
    assert.deepEqual(ops, ["op pause", "op start"], "the game's clock rests with Live");
    await rig.runs.stop(status.runId);
  });

  it("the studio page gone ends the embedded runs, and their frames stop at once", async () => {
    const rig = await embeddedRig();
    const status = await embedded(rig);
    const channel = rig.fake.channels.get(status.runId);
    const ending = nativeOnRendererGone(rig.runs);
    channel?.frame(0, 1);
    assert.equal(rig.textures.sends.length, 0, "no send once the page is gone");
    await ending;
    assert.equal(rig.statuses.at(-1)?.state, NativeRunState.Stopped);
    assert.ok(channel?.closed());
  });

  it("a fatal frames code kills the game with its typed refusal; the channel closes once it is gone", async () => {
    const rig = await embeddedRig();
    const status = await embedded(rig);
    rig.fake.channels.get(status.runId)?.fail(NativeFramesCode.SizeMismatch);
    await rig.clock.settle();
    const last = rig.statuses.at(-1);
    assert.deepEqual([last?.state, last?.refusal], [NativeRunState.Killed, NativeRefusal.SlotMismatch]);
    assert.ok(lifecycle(rig.calls).includes("signal SIGKILL"));
  });

  it("forwards checked input to its game, and answers false where no embedded run is ready", async () => {
    const rig = await embeddedRig();
    const status = await embedded(rig);
    assert.equal(await rig.runs.input("pong", [{ type: "tap", keys: ["Space"] }]), true);
    assert.deepEqual(rig.games[0]?.inputs, [{ actions: [{ type: "tap", keys: ["Space"] }] }]);
    assert.equal(await rig.runs.input("tetris", [{ type: "tap", keys: ["Space"] }]), false);
    await rig.runs.stop(status.runId);
  });

  it("a second embed of the same game ends the first", async () => {
    const rig = await embeddedRig();
    const first = await embedded(rig);
    const second = await embedded(rig);
    assert.notEqual(first.runId, second.runId);
    const ended = rig.statuses.filter((one) => one.runId === first.runId).at(-1);
    assert.equal(ended?.state, NativeRunState.Stopped);
    assert.equal(rig.runs.state("pong", NativeRunMode.Embedded)?.runId, second.runId);
    await rig.runs.stop(second.runId);
  });

  it("a game made before embedding answers surface unsupported: the run ends refused game-predates-embedding", async () => {
    const rig = await embeddedRig({ behaviour: { predatesEmbedding: true } });
    await assert.rejects(
      rig.runs.embed({ project: "pong", target: BuildTarget.Mac, surface: SURFACE }),
      (error: unknown) => error instanceof NativeError && error.refusal === NativeRefusal.GamePredatesEmbedding,
    );
    await rig.clock.settle();
    const last = rig.statuses.at(-1);
    assert.deepEqual([last?.state, last?.refusal], [NativeRunState.Refused, NativeRefusal.GamePredatesEmbedding]);
    assert.ok(lifecycle(rig.calls).includes("signal SIGKILL"), "the game is ended");
    assert.ok(lifecycle(rig.calls).at(-1) === "close", "and its channel closed after it");
  });

  it("a game with the ring whose surface fails is not called old: the run ends refused unsupported, and Try again can help", async () => {
    for (const code of ["surface-failed", "no-frames-service", "bad-argument", "stale-generation"]) {
      const rig = await embeddedRig({ behaviour: { surfaceRefusal: code } });
      await assert.rejects(
        rig.runs.embed({ project: "pong", target: BuildTarget.Mac, surface: SURFACE }),
        (error: unknown) => error instanceof NativeError && error.refusal === NativeRefusal.Unsupported,
        code,
      );
      await rig.clock.settle();
      const last = rig.statuses.at(-1);
      assert.deepEqual([last?.state, last?.refusal], [NativeRunState.Refused, NativeRefusal.Unsupported], code);
    }
  });

  it("where Live cannot embed (no frames host, an untested Electron) the embed is refused: nothing built, spawned or announced", async () => {
    for (const [label, options, refusal] of [
      ["no frames host", { frames: null }, NativeRefusal.EmbedUnsupported],
      ["Electron 41", { electronMajor: 41 }, NativeRefusal.ElectronUntested],
    ] as const) {
      const rig = await embeddedRig(options);
      await assert.rejects(
        rig.runs.embed({ project: "pong", target: BuildTarget.Mac, surface: SURFACE }),
        (error: unknown) => error instanceof NativeError && error.refusal === refusal,
        label,
      );
      assert.deepEqual(rig.prepared, [], `${label}: nothing built`);
      assert.deepEqual(rig.calls, [], `${label}: nothing opened or spawned`);
      assert.deepEqual(rig.statuses, [], `${label}: no run announced`);
    }
  });
});
