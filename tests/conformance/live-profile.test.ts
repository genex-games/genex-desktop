/**
 * Live's profile strip and crash card (game-systems PROF-7), through their pure derivations and
 * the store, with no DOM: a hitch mark lands at its poll's x, a game's own scopes are flagged,
 * memory over its budget is flagged, the armed GPU passes are their mean, the crash card names its
 * first frames, and the strip polls `studio:native.profile` only while it is open (a fake clock).
 */
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { describe, it } from "node:test";
import type { GameCrashEntry } from "../../src/shared/crash-record.ts";
import {
  FrameProfileAction,
  type FrameProfileAnswer,
  type FrameProfileRequest,
  GpuTimeSource,
  GpuTimingMode,
  NodeTimingState,
  type ProfileReportV2,
  type ProfileSummaryV1,
  ProfileUnavailableReason,
} from "../../src/shared/frame-profile.ts";
import type { NativeTimers } from "../../src/shared/native-contract.ts";
import {
  crashCardOf,
  gpuNodeRows,
  memoryRows,
  PROFILE_BUDGET_MS,
  PROFILE_HISTORY_POINTS,
  type ProfilePoint,
  sparklineOf,
  topScopeRows,
  withPoint,
} from "../../src/renderer/live-profile.ts";
import {
  createLiveProfileStore,
  type LiveProfileApi,
  liveProfileOf,
  PROFILE_POLL_MS,
} from "../../src/renderer/state/live-profile.ts";

function summary(overrides: Partial<ProfileSummaryV1> = {}): ProfileSummaryV1 {
  return {
    v: 1,
    on: true,
    frames: 120,
    cpu: { p50: 6, p95: 9 },
    gpu: { p50: 4, p95: 5, source: GpuTimeSource.Timestamps },
    top: [
      { scope: "physics", game: false, p95: 1.9 },
      { scope: "enemy_ai", game: true, p95: 2.4 },
    ],
    counters: {},
    memory: [
      { class: "streamed-meshes", bytes: 96 * 1024 * 1024, budget: 64 * 1024 * 1024 },
      { class: "textures", bytes: 32 * 1024 * 1024, budget: 128 * 1024 * 1024 },
      { class: "process-resident", bytes: 512 * 1024 * 1024 },
    ],
    hitches: { count: 0, last: null },
    nodes: NodeTimingState.Off,
    dropped: { scopes: 0, counters: 0, frames: 0 },
    ...overrides,
  };
}

const point = (cpuMs: number, hitches: number, gpuMs: number | null = null): ProfilePoint => ({
  cpuMs,
  gpuMs,
  hitches,
});

describe("the profile strip's derivations", () => {
  it("puts a hitch mark at the x of the poll whose hitch count rose, the newest poll at the right edge", () => {
    const history = [point(8, 0), point(9, 0), point(40, 1), point(8, 1), point(8, 3)];
    const line = sparklineOf(history, 236, 40);
    const step = 236 / (PROFILE_HISTORY_POINTS - 1);
    assert.deepEqual(line.hitches, [Math.round((236 - 2 * step) * 10) / 10, 236]);
    assert.equal(line.ceilingMs, 40, "the slowest poll is the top of the box");
    assert.equal(line.budgetY, Math.round((40 - (PROFILE_BUDGET_MS / 40) * 40) * 10) / 10);
    assert.equal(line.cpu.split(" ").length, 5);
    assert.equal(line.gpu, "", "no GPU line without GPU times");
  });

  it("keeps the 60 fps line in view when every poll is fast, and keeps only the last polls", () => {
    assert.equal(sparklineOf([point(2, 0)], 100, 40).ceilingMs, PROFILE_BUDGET_MS * 2);
    let history: ProfilePoint[] = [];
    for (let poll = 0; poll < PROFILE_HISTORY_POINTS + 5; poll++) history = withPoint(history, point(poll, 0));
    assert.equal(history.length, PROFILE_HISTORY_POINTS);
    assert.equal(history[0]?.cpuMs, 5, "the oldest polls are dropped");
  });

  it("flags the game's own scopes, heaviest first", () => {
    assert.deepEqual(topScopeRows(summary()), [
      { scope: "enemy_ai", game: true, ms: 2.4 },
      { scope: "physics", game: false, ms: 1.9 },
    ]);
  });

  it("flags memory over its budget, first, with the bar capped at full", () => {
    const rows = memoryRows(summary());
    assert.deepEqual(
      rows.map((row) => [row.name, row.over, row.fraction]),
      [
        ["streamed-meshes", true, 1],
        ["textures", false, 0.25],
        ["process-resident", false, null],
      ],
    );
    assert.deepEqual([rows[0]?.mib, rows[0]?.budgetMib], [96, 64]);
  });

  it("times each armed GPU pass as its mean over the frames that timed it, slowest first", () => {
    const frame = (gpu: Array<{ node: string; ms: number }>, index: number) => ({
      index,
      cpuMs: 6,
      gpuMs: 4,
      intervalMs: 16.7,
      scopes: [],
      gpu,
    });
    const report: ProfileReportV2 = {
      v: 2,
      engine: "rust-wgpu",
      destination: "mac",
      deviceClass: "desktop-high",
      frames: [
        frame(
          [
            { node: "shadows", ms: 1 },
            { node: "world", ms: 2 },
          ],
          0,
        ),
        frame([{ node: "world", ms: 4 }], 1),
      ],
      hitches: [],
      memory: [],
      counters: {},
      gpuSource: GpuTimeSource.Timestamps,
      truncated: false,
    };
    assert.deepEqual(gpuNodeRows(report), [
      { node: "world", ms: 3 },
      { node: "shadows", ms: 1 },
    ]);
  });

  it("names the crash, its place, its first named frames (foreign ones left out) and the tick and seed", () => {
    const entry: GameCrashEntry = {
      crashId: "run1-1",
      runId: "run1",
      at: "2026-10-21T00:00:00.000Z",
      repeat: 2,
      symbolicated: true,
      record: {
        format: "genex-crash/1",
        kind: "panic",
        source: "game",
        fatal: true,
        handled: false,
        message: "index out of bounds",
        location: { file: "src/enemy.rs", line: 42, column: 17 },
        thread: null,
        frames: [{ ip: "0x1" }, { ip: "0x2" }, { ip: "0x3" }, { ip: "0x4" }, { ip: "0x5" }],
        anchor: null,
        images: [],
        gpu: null,
        wasm: null,
        context: { tick: 300, seed: 1 },
        replay: null,
        profile: null,
        hitches: [],
        symbols: null,
        trimmed: [],
      },
      symbols: {
        frames: [
          { foreign: true },
          {
            foreign: false,
            functions: [{ function: "game::enemy::think", file: "src/enemy.rs", line: 42, column: 17 }],
          },
          {
            foreign: false,
            functions: [{ function: "game::enemy::think", file: "src/enemy.rs", line: 42, column: 17 }],
          },
          { foreign: false, functions: [{ function: "genex::tick", file: null, line: null, column: null }] },
          { foreign: false, functions: [{ function: "main", file: "src/main.rs", line: 9, column: 1 }] },
        ],
        wasm: [],
      },
    };
    assert.deepEqual(crashCardOf(entry), {
      kind: "panic",
      message: "index out of bounds",
      location: "src/enemy.rs:42",
      frames: ["game::enemy::think (src/enemy.rs:42)", "genex::tick", "main (src/main.rs:9)"],
      tick: 300,
      seed: 1,
      repeat: 2,
    });
  });
});

/** A clock that only moves when the row says so, running what falls due. */
function fakeTimers() {
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
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      for (let round = 0; round < 5; round++) await tick();
      const next = [...due.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at);
      const first = next[0];
      if (!first) break;
      due.delete(first[0]);
      now = first[1].at;
      first[1].run();
    }
    now = until;
    for (let round = 0; round < 5; round++) await tick();
  };
  return { timers, advance, pending: () => due.size };
}

/** A host that answers the summary (hitches rising each poll) and records every request. */
function fakeApi(answer?: (request: FrameProfileRequest) => FrameProfileAnswer) {
  const asked: FrameProfileRequest[] = [];
  let polls = 0;
  const api: LiveProfileApi = {
    nativeProfile: async (_project, request) => {
      asked.push(request);
      if (answer) return answer(request);
      polls += 1;
      return summary({ hitches: { count: polls, last: polls } });
    },
    gameCrashes: async () => ({ records: [] }),
  };
  return { api, asked };
}

describe("the profile strip's store", () => {
  it("polls only while the strip is open", async () => {
    const clock = fakeTimers();
    const host = fakeApi();
    const store = createLiveProfileStore(host.api, clock.timers);
    await clock.advance(PROFILE_POLL_MS * 4);
    assert.equal(host.asked.length, 0, "a closed strip asks nothing");
    store.open("pond");
    await clock.advance(PROFILE_POLL_MS * 3);
    assert.equal(host.asked.length, 4, "one poll on open, then one per interval");
    assert.ok(host.asked.every((request) => request.action === FrameProfileAction.Summary));
    assert.equal(liveProfileOf(store.getState(), "pond").history.length, 4);
    store.close("pond");
    await clock.advance(PROFILE_POLL_MS * 10);
    assert.equal(host.asked.length, 4, "a closed strip stops polling");
    assert.equal(clock.pending(), 0, "no timer is left behind");
    assert.equal(liveProfileOf(store.getState(), "pond").history.length, 0, "closing forgets the polls");
  });

  it("an unavailable answer says why, and opening twice keeps one poll", async () => {
    const clock = fakeTimers();
    const host = fakeApi(() => ({ state: "unavailable", reason: ProfileUnavailableReason.NotServed }));
    const store = createLiveProfileStore(host.api, clock.timers);
    store.open("pond");
    store.open("pond");
    await clock.advance(PROFILE_POLL_MS);
    assert.equal(host.asked.length, 2);
    assert.equal(liveProfileOf(store.getState(), "pond").unavailable, ProfileUnavailableReason.NotServed);
    store.close("pond");
  });

  it("armed, each poll also reads a report for the GPU passes; disarmed, it stops and forgets them", async () => {
    const clock = fakeTimers();
    const report: ProfileReportV2 = {
      v: 2,
      engine: "rust-wgpu",
      destination: "mac",
      deviceClass: "desktop-high",
      frames: [{ index: 0, cpuMs: 6, gpuMs: 4, intervalMs: 16.7, scopes: [], gpu: [{ node: "world", ms: 2 }] }],
      hitches: [],
      memory: [],
      counters: {},
      gpuSource: GpuTimeSource.Timestamps,
      truncated: false,
    };
    const host = fakeApi((request) => {
      if (request.action === FrameProfileAction.Arm) return { mode: request.mode ?? GpuTimingMode.Frame };
      if (request.action === FrameProfileAction.Report) return report;
      return summary();
    });
    const store = createLiveProfileStore(host.api, clock.timers);
    store.open("pond");
    await store.arm("pond", true);
    await clock.advance(PROFILE_POLL_MS);
    assert.deepEqual(liveProfileOf(store.getState(), "pond").nodes, [{ node: "world", ms: 2 }]);
    assert.ok(host.asked.some((request) => request.action === FrameProfileAction.Report && request.frames === 30));
    await store.arm("pond", false);
    const reports = host.asked.filter((request) => request.action === FrameProfileAction.Report).length;
    await clock.advance(PROFILE_POLL_MS * 2);
    assert.equal(host.asked.filter((request) => request.action === FrameProfileAction.Report).length, reports);
    assert.deepEqual(liveProfileOf(store.getState(), "pond").nodes, []);
    store.close("pond");
  });
});
