/**
 * Live's ring for `npm run conformance:game` on a Mac: the frames host (`createNativeFrames`) on
 * the built app's receive-only addon (`dist/resources/native/genex-frames.node`, from
 * `npm run build`), with the script's own recorder in place of Electron's `sharedTexture`, so the
 * `live-ring` check watches a game's frames outside the app. The recorder keeps each frame's seq
 * and generation and gives every import back at once, as a renderer that drew it would.
 *
 * The probe starts a run of its own: it opens the run's channel, starts the game with the channel's
 * service (`GENEX_FRAMES_SERVICE`), names its pid, announces a ring and asks the game for it with
 * `surface`, as Live does (`native-runs.ts`). It waits until enough frames came or the window
 * closed, then stops the game and closes the channel whatever happened. With no usable frames host
 * (no addon, another build of it) the ring is `unavailable` and no game is started.
 */
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { ConformanceLaunch, LiveRingFrame, LiveRingProbe } from "../src/main/core/game-conformance.ts";
import { ELECTRON_TESTED_MAJORS } from "../src/main/electron-gate.ts";
import { createNativeFrames, type NativeFramesHost } from "../src/main/native-frames.ts";
import { ConformanceProblem } from "../src/shared/game-conformance.ts";
import { isNativeFrameMeta, NativeOp, type NativeTimers } from "../src/shared/native-contract.ts";

/** The ring the probe asks for, in device pixels: small, so the game's letterbox blit is cheap. */
export const RING_SIZE = { width: 320, height: 180 } as const;
/** The device pixel ratio the `surface` op names. */
export const RING_DPR = 1;
/** How often the probe looks at the frames that came. */
const POLL_MS = 20;
/** The project name the run's channel is opened for. */
const RING_PROJECT = "conformance";
/** Bytes of a run id: twelve hex characters, as a studio run's. */
const RUN_ID_BYTES = 6;

/** The two calls of Electron's `sharedTexture` the frames host makes, as the recorder answers them. */
interface RecordingTexture {
  importSharedTexture(options: { allReferencesReleased: () => void }): { release(): void };
  sendSharedTexture(options: unknown, meta: unknown): Promise<void>;
}

/** The recorder: the `sharedTexture` the frames host is given, and the frames it sent per run. */
export interface RingRecorder {
  texture: RecordingTexture;
  framesOf(runId: string): LiveRingFrame[];
}

/** A `sharedTexture` that records each frame's seq and generation and gives every import back at once. */
export function recordingTexture(): RingRecorder {
  const sent = new Map<string, LiveRingFrame[]>();
  const texture: RecordingTexture = {
    importSharedTexture: ({ allReferencesReleased }) => ({ release: () => void setImmediate(allReferencesReleased) }),
    sendSharedTexture: async (_options, meta) => {
      if (!isNativeFrameMeta(meta)) return;
      const frames = sent.get(meta.runId) ?? [];
      frames.push({ seq: meta.seq, generation: meta.generation });
      sent.set(meta.runId, frames);
    },
  };
  return { texture, framesOf: (runId) => [...(sent.get(runId) ?? [])] };
}

/** What the probe reaches, injected. */
export interface RingProbeDeps {
  host: NativeFramesHost;
  recorder: RingRecorder;
  /** Starts the game once with the run's frames service; ready, or rejects. */
  launch(framesService: string): Promise<ConformanceLaunch>;
  runId(): string;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Waits until `wanted.frames` frames of `runId` came or `wanted.withinMs` passed. */
async function framesWithin(deps: RingProbeDeps, runId: string, wanted: { frames: number; withinMs: number }) {
  const started = deps.now();
  while (deps.recorder.framesOf(runId).length < wanted.frames && deps.now() - started < wanted.withinMs) {
    await deps.sleep(POLL_MS);
  }
  return deps.recorder.framesOf(runId);
}

/** Live's ring watched through `deps.host` (see the module docs). */
export function framesRingProbe(deps: RingProbeDeps): LiveRingProbe {
  return {
    async observe(wanted) {
      if (deps.host.available() !== null) return { available: false, code: ConformanceProblem.LiveNoFramesHost };
      const runId = deps.runId();
      const holder: { port: ConformanceLaunch["port"] | null } = { port: null };
      const release = (slot: { slot: number; generation: number }) =>
        void holder.port?.call(NativeOp.Release, slot).catch(() => {});
      const { service } = deps.host.open({ runId, project: RING_PROJECT, release });
      try {
        const run = await deps.launch(service);
        holder.port = run.port;
        try {
          if (run.pid !== null) deps.host.peer(runId, run.pid);
          const ring = deps.host.ring(runId, RING_SIZE);
          const surface = {
            w: ring.width,
            h: ring.height,
            dpr: RING_DPR,
            slots: ring.slots,
            generation: ring.generation,
          };
          await run.port.call(NativeOp.Surface, surface);
          const frames = await framesWithin(deps, runId, wanted);
          return { available: true, generation: ring.generation, frames };
        } finally {
          await run.stop();
        }
      } finally {
        deps.host.close(runId);
      }
    },
  };
}

/**
 * The script's ring on the addon under `resources` (`dist/resources` of a build). Electron is not
 * here: the host's Electron gate is given a measured major because the recorder, not Electron's
 * `sharedTexture`, takes the frames.
 */
export function scriptRingProbe(
  resources: string,
  timers: NativeTimers,
  launch: RingProbeDeps["launch"],
  log: (line: string) => void,
): LiveRingProbe {
  const recorder = recordingTexture();
  const host = createNativeFrames({
    resources,
    electronMajor: ELECTRON_TESTED_MAJORS[0],
    sharedTexture: recorder.texture,
    target: () => ({}),
    timers,
    kill: (runId, refusal) => log(`live-ring: the frames host ended run ${runId}: ${refusal}`),
    log,
  });
  return framesRingProbe({
    host,
    recorder,
    launch,
    runId: () => randomBytes(RUN_ID_BYTES).toString("hex"),
    now: () => Date.now(),
    sleep: (ms) => sleep(ms),
  });
}
