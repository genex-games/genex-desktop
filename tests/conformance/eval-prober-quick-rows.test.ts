/**
 * The quick probe's rows computed straight from an observation, with no page: each row fails only on
 * positive evidence, says `unknown` when it could not look, and the input row's door demotions only
 * ever turn a fail into unknown. The evidence frames are gameplay frames on the game's origin only.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InstrumentSnapshot, PageEvents } from "../../scripts/evals/prober/driver.ts";
import type { LoggedFrame } from "../../scripts/evals/prober/frame-log.ts";
import type { RawFrame } from "../../scripts/evals/prober/png.ts";
import { BaselineName, buildBaseline } from "../../scripts/evals/prober/phases/baseline.ts";
import type { EntranceObservation } from "../../scripts/evals/prober/phases/entrance.ts";
import {
  assetsRow,
  evidenceFrames,
  inputRow,
  legibleRow,
  noErrorsRow,
  type QuickObservation,
  rendererDrewRow,
} from "../../scripts/evals/prober/quick-rows.ts";
import { type ProbePhase, EntranceVia } from "../../scripts/evals/vocabulary.ts";

const GAME = "http://127.0.0.1:4173";

function raw(value: number): RawFrame {
  const data = new Uint8Array(32 * 18 * 4);
  for (let i = 0; i < 32 * 18; i++) {
    const v = value < 0 ? 40 + ((i * 37) % 160) : value;
    data.set([v, v, v, 255], i * 4);
  }
  return { width: 32, height: 18, data };
}

function frame(atMs: number, phase: ProbePhase, value: number, origin = GAME): LoggedFrame {
  return {
    record: { file: `f-${atMs}.png`, atMs, phase, label: "l", source: "page" },
    ref: { path: `/evidence/f-${atMs}.png`, atMs, phase, origin, width: 32, height: 18 },
    raw: raw(value),
  };
}

const events = (over: Partial<PageEvents> = {}): PageEvents => ({
  console: [],
  pageErrors: [],
  network: [
    { url: `${GAME}/index.html`, method: "GET", status: 200, resourceType: "document", failure: null, startedAtMs: 0 },
    { url: `${GAME}/main.js`, method: "GET", status: 200, resourceType: "script", failure: null, startedAtMs: 5 },
  ],
  navigations: [{ atMs: 0, url: `${GAME}/index.html` }],
  documentStatus: 200,
  ...over,
});

const ranSnapshot = (over: Partial<InstrumentSnapshot> = {}): InstrumentSnapshot => ({
  href: `${GAME}/index.html`,
  raf: { calls: 900, distinctFrames: 900, firstT: 500, lastT: 30_000, intervals: [16] },
  errors: [],
  rejections: [],
  contextLost: [],
  ...over,
});

const confirmed = (over: Partial<EntranceObservation> = {}): EntranceObservation => ({
  signals: {
    startControl: { found: "PLAY", clicked: true, gone: true },
    pressAnyKey: null,
    cameraMoved: false,
    pointerLockEngaged: false,
    pointerLockRequested: false,
  },
  verdict: { confirmed: true, by: EntranceVia.StartControl, doorObserved: true, why: "the start control went away" },
  enterable: { result: "pass", why: "got in" },
  keysRefused: [],
  centreClicked: false,
  snapshot: null,
  ...over,
});

function observation(over: Partial<QuickObservation> = {}): QuickObservation {
  return {
    gameOrigin: GAME,
    endAtMs: 30_000,
    noErrorsMs: 20_000,
    firstRenderMs: 1_000,
    boot: { result: "pass", detail: "drew" },
    events: events(),
    snapshots: [ranSnapshot()],
    entrance: confirmed(),
    idleMoved: false,
    stillMoved: false,
    preBaseline: buildBaseline(BaselineName.PreGesture, [0.001, 0.001, 0.001, 0.001, 0.001, 0.001]),
    postBaseline: buildBaseline(BaselineName.PostEntrance, [0.001, 0.001, 0.001, 0.001, 0.001, 0.001]),
    bursts: [],
    frames: [],
    ...over,
  };
}

describe("quick rows", () => {
  it("assets: a same-origin failure fails, a favicon is ignored, and a page that never ran is unknown", () => {
    const missing = events({
      network: [
        ...events().network,
        {
          url: `${GAME}/assets/house.glb`,
          method: "GET",
          status: 404,
          resourceType: "fetch",
          failure: null,
          startedAtMs: 9,
        },
      ],
    });
    assert.equal(assetsRow(observation({ events: missing })).result, "fail");
    const favicon = events({
      network: [
        ...events().network,
        {
          url: `${GAME}/favicon.ico`,
          method: "GET",
          status: 404,
          resourceType: "other",
          failure: null,
          startedAtMs: 9,
        },
      ],
    });
    const ok = assetsRow(observation({ events: favicon }));
    assert.equal(ok.result, "pass");
    assert.match(ok.detail, /1 benign failure\(s\) were ignored/);
    assert.equal(assetsRow(observation({ snapshots: [ranSnapshot({ raf: undefined })] })).result, "unknown");
  });

  it("no_errors: an error inside the short window fails, one after it does not, and the window is named", () => {
    const inside = ranSnapshot({ errors: [{ t: 5_000, message: "boom", stack: null, source: "" }] });
    const fail = noErrorsRow(observation({ snapshots: [inside] }));
    assert.equal(fail.result, "fail");
    assert.match(fail.detail, /first 20s of page time \(a short-window variant of the 60 s row\)/);
    const later = ranSnapshot({ errors: [{ t: 25_000, message: "late", stack: null, source: "" }] });
    assert.equal(noErrorsRow(observation({ snapshots: [later] })).result, "pass");
    const survived = ranSnapshot({ contextLost: [{ t: 1_000, kind: "webglcontextlost" }] });
    assert.equal(noErrorsRow(observation({ snapshots: [survived] })).result, "pass", "the loop drew on for 29 s");
  });

  it("renderer_drew fails on a rejected draw call, whatever the page otherwise did", () => {
    const flood = events({
      console: [
        { atMs: 2_000, type: "warning", text: "GL_INVALID_OPERATION: glDrawElements: Mismatch between texture format" },
      ],
    });
    assert.equal(rendererDrewRow(observation({ events: flood })).result, "fail");
    assert.equal(rendererDrewRow(observation()).result, "pass");
  });

  it("visually_legible: black gameplay frames fail, textured ones pass, too few frames are unknown", () => {
    const black = [2_000, 3_000, 4_000].map((t) => frame(t, "input-burst", 0));
    assert.equal(legibleRow(observation({ frames: black })).result, "fail");
    const lit = [2_000, 3_000, 4_000].map((t) => frame(t, "input-burst", -1));
    assert.equal(legibleRow(observation({ frames: lit })).result, "pass");
    assert.equal(legibleRow(observation({ frames: lit.slice(0, 2) })).result, "unknown");
  });

  it("input: a response above the post-entrance threshold passes; none fails; an unopened lock door demotes the fail", () => {
    const quiet = [{ input: "KeyW", sent: true, samples: 5, maxDiff: 0.001, cameraMoved: false }];
    const bursts = [...quiet, { input: "KeyA", sent: true, samples: 5, maxDiff: 0.05, cameraMoved: false }];
    assert.equal(inputRow(observation({ bursts })).result, "pass");
    const still = [...quiet, { ...quiet[0], input: "KeyA" }];
    assert.equal(inputRow(observation({ bursts: still })).result, "fail");
    const locked = ranSnapshot({ pointerLock: { requested: 3, grantedNatively: false, shimmed: false } as never });
    const demoted = inputRow(observation({ bursts: still, snapshots: [locked] }));
    assert.equal(demoted.result, "unknown");
    assert.match(demoted.detail, /could not ENTER/);
    const refused = [{ input: "KeyW", sent: false, samples: 0, maxDiff: null, cameraMoved: null }];
    assert.equal(inputRow(observation({ bursts: refused })).result, "unknown");
  });

  it("input on a page that never changes without input: one small thing moving is a response, rounding is not", () => {
    // The known-good mini golf as a live calibration measured it: 120 readings with no change at
    // all, then a 16 px ball rolling moved the 64x36 mirror by 0.0008 after Space.
    const stillPage = {
      preBaseline: buildBaseline(BaselineName.PreGesture, Array<number>(81).fill(0)),
      postBaseline: buildBaseline(BaselineName.PostEntrance, Array<number>(120).fill(0)),
    };
    const ignored = { input: "KeyW", sent: true, samples: 48, maxDiff: 0, cameraMoved: null };
    const shot = { input: "Space", sent: true, samples: 48, maxDiff: 0.0008, cameraMoved: null };
    assert.equal(inputRow(observation({ ...stillPage, bursts: [ignored, shot] })).result, "pass");

    const dead = inputRow(observation({ ...stillPage, bursts: [ignored, { ...ignored, input: "Space" }] }));
    assert.equal(dead.result, "fail", "input that moves nothing still fails");
    assert.doesNotMatch(dead.detail, /already moving/, "nothing moved without input, and the row does not say it did");
    // The aim line growing by 8 px measured 2e-6: a few channel steps, not a thing moving.
    const rounding = { ...shot, maxDiff: 2.3e-6 };
    assert.equal(inputRow(observation({ ...stillPage, bursts: [ignored, rounding] })).result, "fail");
    // A page with drift of its own keeps the coarse floor: 0.0008 there is not told from the drift.
    assert.equal(inputRow(observation({ bursts: [ignored, shot] })).result, "fail");
    // Too few still readings prove nothing, so they do not lower the floor.
    const thin = buildBaseline(BaselineName.PostEntrance, Array<number>(6).fill(0));
    const thinPage = { preBaseline: thin, postBaseline: thin };
    assert.equal(inputRow(observation({ ...thinPage, bursts: [ignored, shot] })).result, "fail");
  });

  it("evidence frames are gameplay frames on the game's origin, and none at all when gameplay was never reached", () => {
    const frames = [
      frame(1_000, "boot", -1),
      frame(2_000, "entrance", -1),
      frame(3_000, "input-burst", -1),
      frame(4_000, "input-burst", -1, "https://elsewhere.example.test"),
    ];
    assert.deepEqual(
      evidenceFrames(observation({ frames })).map((f) => f.record.atMs),
      [2_000, 3_000],
    );
    const stuck = confirmed({
      verdict: { confirmed: false, by: EntranceVia.None, doorObserved: true, why: "the PLAY button stayed" },
    });
    assert.deepEqual(evidenceFrames(observation({ frames, entrance: stuck })), []);
  });
});
