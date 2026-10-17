/**
 * What the harness captures of a game for a reviewer (`harness-seed/loop/observers.ts`): the
 * plugins' observers through the host and Genex's own web preview through the evidence pass, as one
 * evidence shape. A fake `ctx` (`ctx-recorder`) answers the host's calls; a scripted preview pass
 * stands in for the evidence pass.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OBSERVER_CAPTURE_EVENT,
  ObserverSource,
  PREVIEW_OBSERVER,
} from "../../src/harness-seed/loop/finish-contract.ts";
import {
  type Capture,
  captureImages,
  captureOfEvidence,
  observeGame,
  PLUGIN_OBSERVERS,
  RECORDING_FRAMES,
  recordCaptures,
} from "../../src/harness-seed/loop/observers.ts";
import type { Evidence } from "../../src/harness-seed/loop/evidence.ts";
import type { Run } from "../../src/harness-seed/types/harness.d.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { type CtxRecorder, ctxRecorder } from "../helpers/ctx-recorder.ts";

const RUN = { runId: "run_desk", project: "desk-game" } as unknown as Run;

/** A clock the test moves: a wait ends only once the test has moved the clock past it. */
function drivenClock() {
  let now = 0;
  const waits: Array<{ at: number; done: () => void }> = [];
  return {
    clock: {
      now: () => now,
      sleep: (ms: number) => new Promise<void>((done) => void waits.push({ at: now + ms, done })),
    },
    advance(ms: number) {
      now += ms;
      for (const wait of waits.filter((one) => one.at <= now)) wait.done();
    },
  };
}
/** A desk game with a web site in `site/`: the plugin's observer, and the preview of the site. */
const GAME = {
  name: "desk-game",
  dir: "/games/desk-game",
  facts: [
    { id: "hk-project", path: "." },
    { id: "web-game", path: "site" },
  ],
};

/** What the host's capture answers: one observer's stills and play frames. */
const PLUGIN_CAPTURE = {
  observer: "hk/still",
  label: "Hook demo: still",
  images: [
    { name: "front", file: "/runs/run_desk/observers/hk-still/1-front.png", mimeType: "image/png", data: "AAAA" },
  ],
  recording: [
    { name: "f1", file: "/runs/run_desk/observers/hk-still/1-play-1-f1.png", mimeType: "image/png", data: "BBBB" },
  ],
  note: "One view.",
};

/** An evidence pass's answer: four camera shots (one with no pixels) and eight motion frames, in order. */
function evidence(): Evidence {
  const shot = (camera: string, base64?: string) => ({
    camera,
    path: `/runs/run_desk/${camera}.png`,
    ...(base64 ? { base64 } : {}),
  });
  return {
    ok: true,
    problems: [],
    warnings: [],
    consoleErrors: [],
    shots: [shot("default", "S1"), shot("top"), shot("side", "S2"), shot("chase", "S3"), shot("demo:jump", "S4")],
    motion: Array.from({ length: 8 }, (_, i) => ({
      index: i + 1,
      camera: "current",
      path: `/runs/run_desk/finish/preview/motion/m${String(i + 1).padStart(2, "0")}.png`,
      base64: `M${i + 1}`,
    })),
  } as unknown as Evidence;
}

function recorder(handlers: Parameters<typeof ctxRecorder>[0] = {}): CtxRecorder {
  return ctxRecorder({ threadId: "chat-1", ...handlers });
}

describe("what the harness captures of a game", () => {
  it("one capture per observer: the plugins' through the host, the web preview from the evidence pass, stills and play frames apart", async () => {
    const r = recorder({ handlers: { [HostMethod.ObserversCapture]: () => [PLUGIN_CAPTURE] } });
    const passes: string[] = [];
    const captures = await observeGame(
      r.ctx as never,
      {
        run: RUN,
        threadId: "chat-1",
        game: GAME as never,
        previewPass: async (path) => {
          passes.push(path);
          return evidence();
        },
        clock: { now: () => 1_000 },
      },
      61_000,
    );
    assert.deepEqual(
      r.paramsOf(HostMethod.ObserversCapture),
      [{ project: "desk-game", runId: "run_desk", threadId: "chat-1", withinMs: 60_000 }],
      "the host is told how long the harness waits",
    );
    assert.deepEqual(passes, ["site"], "the preview of the folder the game is served from");
    assert.deepEqual(
      captures.map((one) => [one.observer, one.source]),
      [
        ["hk/still", ObserverSource.Plugin],
        [PREVIEW_OBSERVER, ObserverSource.Preview],
      ],
    );
    const [plugin, preview] = captures as [Capture, Capture];
    assert.deepEqual(
      plugin.images.map((image) => [image.name, image.file, image.data]),
      [["front", PLUGIN_CAPTURE.images[0]?.file, "AAAA"]],
    );
    assert.deepEqual(
      plugin.recording.map((frame) => frame.name),
      ["f1"],
    );
    assert.equal(plugin.note, "One view.");
    assert.deepEqual(
      preview.images.map((image) => image.data),
      ["S1", "S2", "S3"],
      "the camera shots with pixels, three at most",
    );
    assert.deepEqual(
      preview.recording.map((frame) => frame.data),
      ["M1", "M2", "M3", "M4", "M5", "M6"].slice(0, RECORDING_FRAMES),
      "the motion frames, in order",
    );
    assert.equal(preview.problem, undefined);
  });

  it("a preview pass that found problems keeps them as its capture's problem", () => {
    const broken = { ...evidence(), ok: false, problems: ["the canvas stayed black", "no camera answered"] };
    const capture = captureOfEvidence(broken as Evidence, "Preview");
    assert.match(String(capture.problem), /the canvas stayed black/);
    assert.match(String(capture.problem), /no camera answered/);
  });

  it("a host that cannot capture is a problem, never a throw", async () => {
    const older = recorder();
    const fromOlder = await observeGame(
      older.ctx as never,
      { run: RUN, threadId: "chat-1", game: GAME as never },
      Date.now() + 60_000,
    );
    const [plugins] = fromOlder;
    assert.equal(plugins?.observer, PLUGIN_OBSERVERS);
    assert.ok(plugins?.problem, "an older host that has no capture says so");

    const failing = recorder({
      handlers: {
        [HostMethod.ObserversCapture]: () => {
          throw new Error("the desk fell over");
        },
      },
    });
    const captures = await observeGame(
      failing.ctx as never,
      { run: RUN, threadId: "chat-1", game: GAME as never, previewPass: async () => null },
      Date.now() + 60_000,
    );
    assert.match(String(captures[0]?.problem), /the desk fell over/);
    assert.equal(captures[1]?.observer, PREVIEW_OBSERVER);
    assert.ok(captures[1]?.problem, "a pass that came back empty is a problem too");
  });

  it("records the captures it made with their files and never the picture data", async () => {
    const r = recorder({ handlers: { [HostMethod.EventsAppend]: () => "evt-1" } });
    const preview = captureOfEvidence(evidence(), "Preview of site");
    const plugin: Capture = { ...PLUGIN_CAPTURE, source: ObserverSource.Plugin };
    await recordCaptures(r.ctx as never, "chat-1", "run_desk", [plugin, preview]);
    const appended = r.paramsOf(HostMethod.EventsAppend);
    assert.equal(appended.length, 1, "the host records a plugin's capture itself");
    const [batch] = appended.map(
      (params) => params.batch as Array<{ event_type: string; payload: Record<string, unknown> }>,
    );
    assert.equal(batch?.[0]?.event_type, OBSERVER_CAPTURE_EVENT);
    const payload = batch?.[0]?.payload;
    assert.equal(payload?.runId, "run_desk");
    assert.equal(payload?.observer, PREVIEW_OBSERVER);
    assert.equal(payload?.source, ObserverSource.Preview);
    assert.deepEqual(payload?.images, [
      { name: "default", file: "/runs/run_desk/default.png" },
      { name: "side", file: "/runs/run_desk/side.png" },
      { name: "chase", file: "/runs/run_desk/chase.png" },
    ]);
    assert.equal((payload?.recording as unknown[] | undefined)?.length, RECORDING_FRAMES);
    assert.ok(!JSON.stringify(appended).match(/"S1"|"M1"/), "no picture data in the record");
  });

  it("past its time a look is skipped and says so", async () => {
    const r = recorder({ handlers: { [HostMethod.ObserversCapture]: () => [PLUGIN_CAPTURE] } });
    let passed = false;
    const captures = await observeGame(
      r.ctx as never,
      {
        run: RUN,
        threadId: "chat-1",
        game: GAME as never,
        previewPass: async () => {
          passed = true;
          return evidence();
        },
      },
      Date.now() - 1,
    );
    assert.deepEqual(r.paramsOf(HostMethod.ObserversCapture), [], "the host was asked for nothing");
    assert.equal(passed, false, "and nothing looked at the preview");
    assert.deepEqual(
      captures.map((one) => one.observer),
      [PLUGIN_OBSERVERS, PREVIEW_OBSERVER],
    );
    for (const capture of captures) assert.match(String(capture.problem), /no time to look/);
  });

  it("a look that runs past its time is abandoned and says so, on the scope's clock", async () => {
    // The preview starts (the host answered at once), hangs, and is abandoned when the clock passes.
    const hanging = drivenClock();
    let previewStarted = () => {};
    const started = new Promise<void>((resolve) => {
      previewStarted = resolve;
    });
    const r = recorder({ handlers: { [HostMethod.ObserversCapture]: () => [PLUGIN_CAPTURE] } as never });
    const pending = observeGame(
      r.ctx as never,
      {
        run: RUN,
        threadId: "chat-1",
        game: GAME as never,
        previewPass: () => {
          previewStarted();
          return new Promise(() => {});
        },
        clock: hanging.clock,
      },
      5_000,
    );
    await started;
    hanging.advance(5_000);
    const [plugin, preview] = await pending;
    assert.equal(plugin?.problem, undefined, "the host's capture answered in time");
    assert.equal(preview?.problem, "no time to look", "a preview pass that hangs is abandoned");

    // The host's capture fails only after its time: nobody waits for it then, and it says no time.
    const late = drivenClock();
    let fail = (_error: Error) => {};
    let asked = () => {};
    const askedHost = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const failing = recorder({
      handlers: {
        [HostMethod.ObserversCapture]: () =>
          new Promise((_resolve, reject) => {
            fail = reject;
            asked();
          }),
      } as never,
    });
    const lateLook = observeGame(
      failing.ctx as never,
      { run: RUN, threadId: "chat-1", game: GAME as never, previewPass: async () => evidence(), clock: late.clock },
      5_000,
    );
    await askedHost;
    late.advance(5_000);
    const captures = await lateLook;
    fail(new Error("late"));
    assert.deepEqual(
      captures.map((capture) => capture.problem),
      ["no time to look", "no time to look"],
      "the late failure is nobody's: both looks say there was no time",
    );
  });

  it("a fake clock past the deadline skips the looks still to come", async () => {
    let now = 0;
    const r = recorder({
      handlers: {
        [HostMethod.ObserversCapture]: () => {
          now = 10_000;
          return [PLUGIN_CAPTURE];
        },
      },
    });
    let passed = false;
    const captures = await observeGame(
      r.ctx as never,
      {
        run: RUN,
        threadId: "chat-1",
        game: GAME as never,
        previewPass: async () => {
          passed = true;
          return evidence();
        },
        clock: { now: () => now },
      },
      5_000,
    );
    assert.equal(captures[0]?.observer, "hk/still", "the plugin's capture came in time");
    assert.equal(passed, false, "the preview was not looked at past the deadline");
    assert.match(String(captures[1]?.problem), /no time to look/);
  });

  it("hands a reviewer the stills first, then the play frames, each labelled, at most as many as asked", () => {
    const plugin: Capture = { ...PLUGIN_CAPTURE, source: ObserverSource.Plugin };
    const preview = captureOfEvidence(evidence(), "Preview of site");
    const images = captureImages([plugin, preview], 6);
    assert.deepEqual(
      images.map((image) => image.label),
      [
        "Hook demo: still 1/1",
        "Preview of site 1/3",
        "Preview of site 2/3",
        "Preview of site 3/3",
        "Hook demo: still play 1/1",
        "Preview of site play 1/6",
      ],
    );
    assert.ok(images.every((image) => image.mimeType && image.data));
  });
});
