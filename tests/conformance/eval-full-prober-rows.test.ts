/**
 * The full prober's machine rows beside the phases: five audio answers (never one boolean), the 60 s
 * error window unioned across snapshots, the frame-rate floor that never gates on a software
 * rasteriser, assets that arrived and could not be used, the reviewed dark phase, the judge-owned
 * spatial row, the phone pass, and the page-side series log that survives a re-installed document.
 * No browser: snapshots, events and pages are fakes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  CanvasState,
  type Capture,
  type InstrumentSnapshot,
  type PageEvents,
  type ProbeBrowser,
} from "../../scripts/evals/prober/driver.ts";
import { createFrameLog, type LoggedFrame, writeFrame } from "../../scripts/evals/prober/frame-log.ts";
import type { ProbeRms } from "../../scripts/evals/prober/instrument.ts";
import { encodePng, type RawFrame } from "../../scripts/evals/prober/png.ts";
import { audioFacts, audioRows } from "../../scripts/evals/prober/phases/audio.ts";
import {
  assetsUsableRow,
  frameRateRow,
  noErrors60sRow,
  ranOver,
  SPEC_ERROR_WINDOW_MS,
} from "../../scripts/evals/prober/phases/health.ts";
import { darkPhaseRow, spatiallyLegibleRow } from "../../scripts/evals/prober/phases/legibility.ts";
import {
  mobileNotRun,
  mobilePhase,
  type PhonePage,
  phoneViewportRow,
} from "../../scripts/evals/prober/phases/mobile.ts";
import { createSeriesLog, pullSeries, readSeriesInPage } from "../../scripts/evals/prober/phases/series.ts";
import { CheckSource } from "../../scripts/evals/prober/types.ts";
import { gateFor } from "../../scripts/evals/prober/verdicts.ts";
import { CheckResult, ProbePhase, ProbeRow, RendererMode } from "../../scripts/evals/vocabulary.ts";
import { tmpDir } from "../helpers/tmp.ts";

const GAME = "http://127.0.0.1:4173";

function events(overrides: Partial<PageEvents> = {}): PageEvents {
  return {
    console: [],
    pageErrors: [],
    network: [
      {
        url: `${GAME}/index.html`,
        method: "GET",
        status: 200,
        resourceType: "document",
        failure: null,
        startedAtMs: 0,
      },
      { url: `${GAME}/main.js`, method: "GET", status: 200, resourceType: "script", failure: null, startedAtMs: 1 },
    ],
    navigations: [],
    documentStatus: 200,
    ...overrides,
  };
}

/** A snapshot of a page that ran for `lastT` ms of page time. */
function snapshot(lastT: number, extra: Partial<InstrumentSnapshot> = {}): InstrumentSnapshot {
  return {
    raf: { calls: 100, distinctFrames: 100, firstT: 100, lastT, intervals: [16, 17, 16, 17, 16] },
    errors: [],
    rejections: [],
    contextLost: [],
    ...extra,
  } as InstrumentSnapshot;
}

describe("audio: five answers", () => {
  const gameplay = { reached: true, why: "the entrance was confirmed" };
  const menu = { reached: false, why: "a door was never seen to open" };

  it("a WebAudio-only game fails the network row and passes the other four; the rows stay independent", () => {
    const snap = snapshot(70_000, {
      audio: {
        contexts: [{ id: 1, t: 0, sampleRate: 48000, states: [], finalState: "running", analyserAttached: true }],
        edges: [],
        edgesTotal: 3,
        edgesRecordingCapped: false,
        edgesToDestination: 1,
        distinctSources: 1,
        peakRms: 0.01,
        rmsSamples: 12,
        elements: [
          {
            id: 1,
            src: "",
            everPlayed: true,
            paused: false,
            muted: false,
            volume: 1,
            currentTime: 1,
            duration: 2,
            readyState: 4,
            error: null,
            events: [],
          },
        ],
      },
    } as Partial<InstrumentSnapshot>);
    const rms: ProbeRms[] = Array.from({ length: 12 }, (_, i) => ({ t: i * 100, c: 1, rms: 0.01, peak: 0.02 }));
    const rows = audioRows(audioFacts(snap, rms, events().network), gameplay);
    assert.deepEqual(
      rows.map((r) => r.id),
      [
        ProbeRow.L3AudioNetwork,
        ProbeRow.L3AudioContextState,
        ProbeRow.L3AudioGraphEdges,
        ProbeRow.L3AudioOutputRms,
        ProbeRow.L3AudioElementState,
      ],
    );
    assert.deepEqual(
      rows.map((r) => r.result),
      [CheckResult.Fail, CheckResult.Pass, CheckResult.Pass, CheckResult.Pass, CheckResult.Pass],
    );
  });

  it("A SILENT TITLE SCREEN is not a silent game: the network row is unknown until gameplay is reached", () => {
    const [network] = audioRows(audioFacts(snapshot(1000), [], events().network), menu);
    assert.equal(network.result, CheckResult.Unknown);
    assert.match(network.detail, /gameplay was never reached/);
  });

  it("an audio file that arrived passes the network row; one that 404ed does not", () => {
    const net = events().network.concat([
      {
        url: `${GAME}/theme.ogg?v=1`,
        method: "GET",
        status: 200,
        resourceType: "media",
        failure: null,
        startedAtMs: 2,
      },
      { url: `${GAME}/missing.mp3`, method: "GET", status: 404, resourceType: "media", failure: null, startedAtMs: 3 },
    ]);
    const facts = audioFacts(snapshot(1000), [], net);
    assert.equal(facts.network.files, 1);
    assert.equal(audioRows(facts, menu)[0].result, CheckResult.Pass);
  });

  it("with no context, no analyser readings and no media element every other row says unknown", () => {
    const rows = audioRows(audioFacts(null, [], []), gameplay).slice(1);
    assert.ok(rows.every((r) => r.result === CheckResult.Unknown));
  });
});

describe("l1.no_errors_60s over its full window", () => {
  it("unions errors across snapshots: an error on a document the run later left still counts", () => {
    const first = snapshot(20_000, {
      errors: [{ t: 5_000, message: "boom", stack: null, source: "x" }],
    } as Partial<InstrumentSnapshot>);
    const last = snapshot(90_000);
    const row = noErrors60sRow([first, last], events());
    assert.equal(row.result, CheckResult.Fail);
    assert.match(row.detail, /boom/);
  });

  it("an error after 60 s of page time is outside the window; a page that stopped early cannot pass", () => {
    const late = snapshot(90_000, {
      errors: [{ t: SPEC_ERROR_WINDOW_MS + 1, message: "late", stack: null, source: "x" }],
    } as Partial<InstrumentSnapshot>);
    assert.equal(noErrors60sRow([late], events()).result, CheckResult.Pass);
    assert.equal(noErrors60sRow([snapshot(30_000)], events()).result, CheckResult.Unknown);
  });
});

describe("l1.frame_rate_floor", () => {
  it("passes above the floor on a GPU, and never gates on a software rasteriser", () => {
    const gpu = frameRateRow(snapshot(1000), RendererMode.Gpu);
    assert.equal(gpu.result, CheckResult.Pass);
    assert.notEqual(gpu.gates, false);
    const slow = snapshot(1000, {
      raf: { calls: 5, distinctFrames: 5, firstT: 0, lastT: 1000, intervals: [400, 500, 450] },
    } as Partial<InstrumentSnapshot>);
    const software = frameRateRow(slow, RendererMode.Software);
    assert.equal(software.result, CheckResult.Unknown);
    assert.equal(software.gates, false);
    assert.equal(frameRateRow(slow, RendererMode.Gpu).result, CheckResult.Fail);
    assert.equal(gateFor([software]).l1, CheckResult.Unknown, "a non-gating row cannot decide L1");
  });

  it("no animation frame at all is unknown", () => {
    const none = snapshot(0, {
      raf: { calls: 0, distinctFrames: 0, firstT: null, lastT: null, intervals: [] },
    } as Partial<InstrumentSnapshot>);
    assert.equal(frameRateRow(none, RendererMode.Gpu).result, CheckResult.Unknown);
  });
});

describe("l3.assets_usable", () => {
  it("fails on a loader that gave up on bytes that arrived; unknown on a page that never ran", () => {
    const logged = events({
      console: [{ atMs: 1, type: "warning", text: "THREE.GLTFLoader: Couldn't load texture blob:x" }],
    });
    const ran = ranOver([snapshot(70_000)], logged);
    const row = assetsUsableRow(logged, ran);
    assert.equal(row.id, ProbeRow.L3AssetsUsable);
    assert.equal(row.result, CheckResult.Fail);
    assert.equal(assetsUsableRow(events(), { ran: false, why: "no frame" }).result, CheckResult.Unknown);
    assert.equal(assetsUsableRow(events(), ran).result, CheckResult.Pass);
  });
});

/** A frame of flat luma `v`, with a little texture so it has range and contrast. */
function rawFrame(v: number): RawFrame {
  const width = 64;
  const height = 36;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const shade = Math.max(0, Math.min(255, v + ((i * 7) % 9) * 3));
    data.set([shade, shade, shade, 255], i * 4);
  }
  return { width, height, data };
}

function logFrames(): LoggedFrame[] {
  const log = createFrameLog(null);
  log.firstRenderMs = 100;
  const capture = (v: number): Capture => ({ png: encodePng(rawFrame(v)), source: "page" });
  const frames: LoggedFrame[] = [];
  for (const [i, v] of [120, 40, 38].entries()) {
    const written = writeFrame(log, capture(v), {
      phase: ProbePhase.Soak,
      label: `soak-${i}`,
      atMs: 1000 + i,
      origin: GAME,
    });
    if (typeof written !== "string") frames.push(written);
  }
  return frames;
}

describe("l3.dark_phase and l3.spatially_legible", () => {
  it("measures the frames the operator named, and is unknown without a review", () => {
    const frames = logFrames();
    const loopRun = frames.slice(1).map((f) => f.record.file);
    const review = {
      files: loopRun,
      phase: "village at night",
      gameplayReadable: true,
      note: "paths and doors readable",
    };
    const row = darkPhaseRow(frames, 100, review);
    assert.equal(row.id, ProbeRow.L3DarkPhase);
    assert.equal(row.result, CheckResult.Pass);
    assert.equal(darkPhaseRow(frames, 100).result, CheckResult.Unknown);
    const unreadable = darkPhaseRow(frames, 100, { ...review, gameplayReadable: false });
    assert.equal(unreadable.result, CheckResult.Fail);
  });

  it("a named frame the probe never wrote as gameplay is unknown", () => {
    const review = { files: ["07-boot-first-draw.png"], phase: "night", gameplayReadable: true, note: "n" };
    assert.equal(darkPhaseRow(logFrames(), 100, review).result, CheckResult.Unknown);
  });

  it("spatially legible is the judge's: unknown, judge-sourced, outside the L3 gate", () => {
    const row = spatiallyLegibleRow();
    assert.equal(row.result, CheckResult.Unknown);
    assert.equal(row.source, CheckSource.Judge);
    assert.equal(gateFor([row]).l3, CheckResult.Unknown);
  });
});

/** A textured, coloured scene: what a drawing canvas looks like to the degeneracy check. */
function scene(): RawFrame {
  const width = 64;
  const height = 36;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = 60 + ((x * 7 + y * 13) % 11) * 12;
      data.set([v, (v + 30) % 256, (v * 2) % 256, 255], (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

/** A phone page that shows `state` for its canvas and draws `drawn` pixels. */
function phonePage(
  state: CanvasState,
  drawn: boolean,
  status: number | null = 200,
): { page: PhonePage; taps: string[] } {
  let now = 0;
  const taps: string[] = [];
  const png = encodePng(drawn ? scene() : { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(30) });
  const page: PhonePage = {
    elapsedMs: () => now,
    url: () => GAME,
    viewport: () => ({ width: 390, height: 844 }),
    evaluate: async () => null,
    captureCanvas: async () => {
      now += 500;
      if (state === CanvasState.Image) return { state, capture: { png, source: "canvas" } };
      return { state } as never;
    },
    screenshot: async () => null,
    click: async () => false,
    clickAt: async () => true,
    press: async () => false,
    events: () => events({ documentStatus: status }),
    tap: async (x, y) => {
      taps.push(`${x},${y}`);
      return true;
    },
  };
  return { page, taps };
}

function phoneBrowser(page: PhonePage): ProbeBrowser {
  return { open: async () => page, close: async () => {}, openPhone: async () => page };
}

describe("l3.phone_viewport", () => {
  const sleep = async () => {};

  it("a canvas that draws at phone size passes; the centre is tapped and the frame written", async () => {
    const dir = await tmpDir("eval-full-prober-phone-");
    const { page, taps } = phonePage(CanvasState.Image, true);
    const m = await mobilePhase(phoneBrowser(page), GAME, "init", { sleep, evidenceDir: dir });
    assert.deepEqual(taps, ["195,422"]);
    assert.ok(m.frame && fs.existsSync(m.frame) && path.dirname(m.frame) === dir);
    assert.equal(phoneViewportRow(m).result, CheckResult.Pass);
  });

  it("a flat canvas fails; no canvas fails; an unreadable one or a 5xx origin is unknown", async () => {
    const flat = await mobilePhase(phoneBrowser(phonePage(CanvasState.Image, false).page), GAME, "i", {
      sleep,
      evidenceDir: null,
    });
    assert.equal(phoneViewportRow(flat).result, CheckResult.Fail);
    const none = await mobilePhase(phoneBrowser(phonePage(CanvasState.NoCanvas, false).page), GAME, "i", {
      sleep,
      evidenceDir: null,
    });
    assert.equal(phoneViewportRow(none).result, CheckResult.Fail);
    const unreadable = await mobilePhase(phoneBrowser(phonePage(CanvasState.Failed, false).page), GAME, "i", {
      sleep,
      evidenceDir: null,
    });
    assert.equal(unreadable.canvasFound, true, "a failed capture is a canvas that could not be read, not no canvas");
    assert.equal(phoneViewportRow(unreadable).result, CheckResult.Unknown);
    const origin = await mobilePhase(phoneBrowser(phonePage(CanvasState.Image, true, 503).page), GAME, "i", {
      sleep,
      evidenceDir: null,
    });
    assert.equal(phoneViewportRow(origin).result, CheckResult.Unknown);
  });

  it("a driver with no phone context records that the pass could not run", async () => {
    const { page } = phonePage(CanvasState.Image, true);
    const m = await mobilePhase({ open: async () => page, close: async () => {} }, GAME, "i", {
      sleep,
      evidenceDir: null,
    });
    assert.equal(m.ran, false);
    assert.equal(phoneViewportRow(m).result, CheckResult.Unknown);
    assert.equal(phoneViewportRow(mobileNotRun("disabled")).result, CheckResult.Unknown);
  });
});

describe("the page-side series log", () => {
  it("accumulates by cursor and restarts on a re-installed document instead of reading nothing forever", async () => {
    const documents = [
      {
        installedAt: 1,
        frames: [
          { t: 1, m: 0, d: 0.1 },
          { t: 2, m: 0, d: 0.2 },
        ],
      },
      { installedAt: 2, frames: [{ t: 1, m: 0, d: 0.3 }] },
    ];
    let current = 0;
    const reads: Array<{ fromFrame: number; fromRms: number }> = [];
    const ctx = {
      page: {
        evaluate: async (fn: unknown, arg: { fromFrame: number; fromRms: number }) => {
          assert.equal(fn, readSeriesInPage);
          reads.push(arg);
          const doc = documents[current];
          return {
            installedAt: doc.installedAt,
            href: GAME,
            frames: doc.frames.slice(arg.fromFrame),
            rms: [],
            nextFrame: doc.frames.length,
            nextRms: 0,
          };
        },
      },
    } as never;
    const log = createSeriesLog();
    assert.equal(await pullSeries(ctx, log), true);
    assert.equal(log.samples.length, 2);
    current = 1;
    await pullSeries(ctx, log);
    assert.equal(log.reinstalls, 1);
    assert.deepEqual(reads.at(-1), { fromFrame: 0, fromRms: 0 }, "the new document is read from its start");
    assert.deepEqual(
      log.samples.map((s) => s.d),
      [0.1, 0.2, 0.3],
    );
  });
});
