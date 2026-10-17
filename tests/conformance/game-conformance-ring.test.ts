/**
 * Live's ring for `npm run conformance:game` (`scripts/game-conformance-ring.ts`): the script
 * watches a game's frames through the frames host with its own recorder in place of Electron's
 * `sharedTexture`. With no usable frames host the ring is `unavailable` and no game is started;
 * otherwise the probe opens the run's channel, starts the game with that channel's service, names
 * its pid, announces a ring and asks for it with `surface`, and returns the frames the recorder took
 * for that run only. The game is stopped and the channel closed whatever happens. The real addon
 * and a real game are the script's own run (`GENEX_REQUIRE_METAL=1 npm run conformance:game`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConformanceLaunch } from "../../src/main/core/game-conformance.ts";
import type { FramesRing, FramesRunOpen, NativeFramesHost } from "../../src/main/native-frames.ts";
import { ConformanceProblem } from "../../src/shared/game-conformance.ts";
import { NATIVE_FRAMES_SERVICE_PREFIX, NativeOp, NativeRefusal } from "../../src/shared/native-contract.ts";
import {
  framesRingProbe,
  RING_DPR,
  RING_SIZE,
  recordingTexture,
  type RingProbeDeps,
} from "../../scripts/game-conformance-ring.ts";

const RUN_ID = "a1b2c3d4e5f6";
const SERVICE = `${NATIVE_FRAMES_SERVICE_PREFIX}${RUN_ID}`;
const PID = 4242;
const WANTED = { frames: 3, withinMs: 1000 };
const POLL_STEP_MS = 20;

type Call = { op: string; arg: unknown };

/** A frames host that records what the probe asked of it. */
function fakeHost(refusal: NativeRefusal | null = null) {
  const asked: string[] = [];
  const opened: FramesRunOpen[] = [];
  let generation = 0;
  const host: NativeFramesHost = {
    available: () => refusal,
    open: (run) => {
      asked.push(`open ${run.runId}`);
      opened.push(run);
      return { service: SERVICE };
    },
    peer: (runId, pid) => void asked.push(`peer ${runId} ${pid}`),
    ring: (runId, size): FramesRing => {
      generation += 1;
      asked.push(`ring ${runId} ${size.width}x${size.height}`);
      return { generation, width: size.width, height: size.height, slots: 3 };
    },
    pause: () => {},
    resume: () => {},
    close: (runId) => void asked.push(`close ${runId}`),
    stats: () => null,
  };
  return { host, asked, opened };
}

/** A launched game whose `surface` answer is `surface` and whose calls and stop are recorded. */
function fakeGame(surface: () => Promise<unknown> = async () => ({ ok: true })) {
  const calls: Call[] = [];
  const services: string[] = [];
  let stopped = 0;
  const launch = async (service: string): Promise<ConformanceLaunch> => {
    services.push(service);
    const port = {
      call: async (op: string, arg?: unknown) => {
        calls.push({ op, arg });
        return op === NativeOp.Surface ? surface() : {};
      },
      screenshotWithStats: async () => {
        throw new Error("not used");
      },
      ready: async () => {
        throw new Error("not used");
      },
    } as unknown as ConformanceLaunch["port"];
    return {
      port,
      pid: PID,
      stateDir: null,
      buildDigest: null,
      stop: async () => {
        stopped += 1;
        return { escalated: false };
      },
    };
  };
  return { launch, calls, services, stopped: () => stopped };
}

/** The probe's dependencies on a test clock that advances by each sleep. */
function deps(host: NativeFramesHost, launch: RingProbeDeps["launch"], onSleep: (atMs: number) => void = () => {}) {
  const recorder = recordingTexture();
  let clock = 0;
  const probeDeps: RingProbeDeps = {
    host,
    recorder,
    launch,
    runId: () => RUN_ID,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      onSleep(clock);
    },
  };
  return { probeDeps, recorder };
}

/** Sends one frame through the recorder as the frames host sends it. */
async function sendFrame(recorder: ReturnType<typeof recordingTexture>, runId: string, seq: number, generation = 1) {
  const texture = recorder.texture as {
    importSharedTexture(options: { allReferencesReleased: () => void }): { release(): void };
    sendSharedTexture(options: unknown, meta: unknown): Promise<unknown>;
  };
  let released = false;
  const imported = texture.importSharedTexture({ allReferencesReleased: () => (released = true) });
  await texture.sendSharedTexture(
    { frame: {}, importedSharedTexture: imported },
    { project: "p", runId, generation, seq, slot: seq % 3, width: 320, height: 180 },
  );
  imported.release();
  await new Promise((done) => setImmediate(done));
  return released;
}

describe("the conformance script's Live ring", () => {
  it("is unavailable with no usable frames host, and starts no game", async () => {
    const { host, asked } = fakeHost(NativeRefusal.EmbedUnsupported);
    const game = fakeGame();
    const { probeDeps } = deps(host, game.launch);
    const observed = await framesRingProbe(probeDeps).observe(WANTED);
    assert.deepEqual(observed, { available: false, code: ConformanceProblem.LiveNoFramesHost });
    assert.deepEqual(game.services, []);
    assert.deepEqual(asked, []);
  });

  it("opens the channel, starts the game on its service, rings it and returns that run's frames", async () => {
    const { host, asked } = fakeHost();
    const game = fakeGame();
    const { probeDeps, recorder } = deps(host, game.launch, (atMs) => {
      // Frames arrive while the probe waits: this run's, and another run's it must not count.
      if (atMs === POLL_STEP_MS) {
        void sendFrame(recorder, RUN_ID, 1);
        void sendFrame(recorder, "ffffffffffff", 9);
      }
      if (atMs === POLL_STEP_MS * 2) {
        void sendFrame(recorder, RUN_ID, 2);
        void sendFrame(recorder, RUN_ID, 3);
      }
    });
    const observed = await framesRingProbe(probeDeps).observe(WANTED);
    assert.deepEqual(observed, {
      available: true,
      generation: 1,
      frames: [
        { seq: 1, generation: 1 },
        { seq: 2, generation: 1 },
        { seq: 3, generation: 1 },
      ],
    });
    assert.deepEqual(game.services, [SERVICE]);
    assert.deepEqual(asked, [
      `open ${RUN_ID}`,
      `peer ${RUN_ID} ${PID}`,
      `ring ${RUN_ID} ${RING_SIZE.width}x${RING_SIZE.height}`,
      `close ${RUN_ID}`,
    ]);
    const surface = game.calls.find((call) => call.op === NativeOp.Surface);
    assert.deepEqual(surface?.arg, {
      w: RING_SIZE.width,
      h: RING_SIZE.height,
      dpr: RING_DPR,
      slots: 3,
      generation: 1,
    });
    assert.equal(game.stopped(), 1);
  });

  it("gives a released slot back to the game with `release`", async () => {
    const { host, opened } = fakeHost();
    const game = fakeGame();
    const { probeDeps } = deps(host, game.launch, () => {
      opened[0]?.release({ slot: 2, generation: 1 });
    });
    await framesRingProbe(probeDeps).observe({ frames: 1, withinMs: POLL_STEP_MS });
    const releases = game.calls.filter((call) => call.op === NativeOp.Release);
    assert.deepEqual(releases[0]?.arg, { slot: 2, generation: 1 });
  });

  it("returns what arrived within the window when too few frames came", async () => {
    const { host } = fakeHost();
    const game = fakeGame();
    const { probeDeps, recorder } = deps(host, game.launch, (atMs) => {
      if (atMs === POLL_STEP_MS) void sendFrame(recorder, RUN_ID, 1);
    });
    const observed = await framesRingProbe(probeDeps).observe(WANTED);
    assert.ok(observed.available);
    assert.deepEqual(observed.frames, [{ seq: 1, generation: 1 }]);
    assert.equal(game.stopped(), 1);
  });

  it("stops the game and closes the channel when the game refuses `surface`", async () => {
    const { host, asked } = fakeHost();
    const game = fakeGame(async () => {
      throw new Error("no-frames-service");
    });
    const { probeDeps } = deps(host, game.launch);
    await assert.rejects(framesRingProbe(probeDeps).observe(WANTED), /no-frames-service/);
    assert.equal(game.stopped(), 1);
    assert.equal(asked.at(-1), `close ${RUN_ID}`);
  });

  it("closes the channel when the game never starts", async () => {
    const { host, asked } = fakeHost();
    const { probeDeps } = deps(host, async () => {
      throw new Error("launch-failed");
    });
    await assert.rejects(framesRingProbe(probeDeps).observe(WANTED), /launch-failed/);
    assert.deepEqual(asked, [`open ${RUN_ID}`, `close ${RUN_ID}`]);
  });

  it("the recorder releases each import once its reference is let go", async () => {
    const recorder = recordingTexture();
    assert.equal(await sendFrame(recorder, RUN_ID, 1), true);
    assert.deepEqual(recorder.framesOf(RUN_ID), [{ seq: 1, generation: 1 }]);
    assert.deepEqual(recorder.framesOf("ffffffffffff"), []);
  });
});
