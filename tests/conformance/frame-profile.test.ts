/**
 * A Rust game's frame profile as the host reads it (`shared/frame-profile.ts`, PROF-0c): the
 * `volatile.profile` summary, `ProfileReport` v2 and the dev op's other answers are copied with
 * only their known fields, refused (null, never a throw) outside their shape, size or depth, and a
 * `profile` request is checked before it reaches a game. All rows are new behaviour; the shared
 * fixture genex-profile writes (`tests/fixtures/profile-report-v2.json`, PROF-1b) adds its row.
 */
import assert from "node:assert/strict";
import { harnessParamsProblem, HostMethod } from "../../src/shared/harness-api.ts";
import { describe, it } from "node:test";
import {
  GpuTimeSource,
  GpuTimingMode,
  HitchCause,
  NodeTimingState,
  PROFILE_FRAME_SCOPES_MAX,
  PROFILE_REPORT_FRAMES_MAX,
  PROFILE_REPORT_MAX_BYTES,
  PROFILE_SUMMARY_MAX_BYTES,
  PROFILE_TOP_SCOPES,
  FrameProfileAction,
  ProfileUnavailableReason,
  jsonWithin,
  parseProfileAnswer,
  parseProfileReport,
  parseFrameProfileRequest,
  parseProfileSummary,
  profileUnavailable,
} from "../../src/shared/frame-profile.ts";

/** The summary of design-PROFILE section 3.3. */
const summary = {
  v: 1,
  on: true,
  frames: 120,
  cpu: { p50: 6.1, p95: 9.8 },
  gpu: { p50: 4.2, p95: 5.0, source: GpuTimeSource.Timestamps },
  top: [
    { scope: "physics", game: false, p95: 1.9 },
    { scope: "enemy_ai", game: true, p95: 1.1 },
  ],
  counters: { enemies: 42 },
  memory: [
    { class: "streamed-meshes", bytes: 41943040, budget: 67108864 },
    { class: "process-resident", bytes: 512000000 },
  ],
  hitches: { count: 3, last: 4411 },
  nodes: NodeTimingState.Off,
  dropped: { scopes: 0, counters: 0, frames: 0 },
};

const frame = {
  index: 4411,
  cpuMs: 21.0,
  gpuMs: 5.1,
  intervalMs: 33.3,
  scopes: [{ scope: "tick", game: false, depth: 0, startUs: 0, us: 15100 }],
  gpu: [
    { node: "shadows", ms: 1.2 },
    { node: "world", ms: 2.0 },
  ],
};

/** The report of design-PROFILE section 3.4. */
const report = {
  v: 2,
  engine: "rust-wgpu",
  destination: "mac",
  deviceClass: "desktop-high",
  frames: [frame],
  hitches: [{ frame: 4411, cause: HitchCause.Cpu, thresholdMs: 16.7, top: [{ scope: "enemy_ai", us: 11000 }] }],
  memory: summary.memory,
  counters: { enemies: 42 },
  gpuSource: GpuTimeSource.Timestamps,
  truncated: false,
};

describe("the volatile.profile summary", () => {
  it("is copied with only its known fields", () => {
    assert.deepEqual(parseProfileSummary({ ...summary, junk: 1, cpu: { ...summary.cpu, p99: 3 } }), summary);
    assert.deepEqual(parseProfileSummary({ ...summary, gpu: null, hitches: { count: 0, last: null } }), {
      ...summary,
      gpu: null,
      hitches: { count: 0, last: null },
    });
  });

  it("refuses one outside its shape, over 4 KiB or nested too deep, without throwing", () => {
    const rows: Array<[string, unknown]> = [
      ["another version", { ...summary, v: 2 }],
      ["a negative p95", { ...summary, cpu: { p50: 1, p95: -1 } }],
      ["a NaN p50", { ...summary, cpu: { p50: Number.NaN, p95: 1 } }],
      ["an unknown GPU source", { ...summary, gpu: { ...summary.gpu, source: "guess" } }],
      ["a scope name with spaces", { ...summary, top: [{ scope: "Bad Name", game: true, p95: 1 }] }],
      ["nine top scopes", { ...summary, top: Array(PROFILE_TOP_SCOPES + 1).fill(summary.top[0]) }],
      ["a counter that is not a number", { ...summary, counters: { enemies: "42" } }],
      ["a fractional byte count", { ...summary, memory: [{ class: "target", bytes: 1.5 }] }],
      ["an unknown node state", { ...summary, nodes: "maybe" }],
      ["a missing dropped", { ...summary, dropped: undefined }],
      ["over 4 KiB", { ...summary, counters: { pad: 1 }, padding: "x".repeat(PROFILE_SUMMARY_MAX_BYTES) }],
      ["nested too deep", { ...summary, deep: [[[[[[[[[0]]]]]]]]] }],
      ["an array", [summary]],
      ["null", null],
    ];
    for (const [name, value] of rows) {
      assert.doesNotThrow(() => parseProfileSummary(value), name);
      assert.equal(parseProfileSummary(value), null, name);
    }
  });

  it("a counter named __proto__ stays plain data", () => {
    const parsed = parseProfileSummary({ ...summary, counters: JSON.parse('{"__proto__": 3}') });
    assert.equal(parsed?.counters.__proto__, 3);
    assert.equal(Object.getPrototypeOf(parsed?.counters), Object.prototype);
  });
});

describe("ProfileReport v2", () => {
  it("is copied with only its known fields", () => {
    assert.deepEqual(parseProfileReport({ ...report, extra: true, frames: [{ ...frame, junk: 1 }] }), report);
  });

  it("refuses one outside its shape or caps", () => {
    const tooManyFrames = Array(PROFILE_REPORT_FRAMES_MAX + 1).fill({ ...frame, scopes: [], gpu: [] });
    const tooManyScopes = Array(PROFILE_FRAME_SCOPES_MAX + 1).fill(frame.scopes[0]);
    const rows: Array<[string, unknown]> = [
      ["version 1", { ...report, v: 1 }],
      ["an unknown hitch cause", { ...report, hitches: [{ ...report.hitches[0], cause: "cosmic-ray" }] }],
      ["241 frames", { ...report, frames: tooManyFrames }],
      ["513 scopes in a frame", { ...report, frames: [{ ...frame, scopes: tooManyScopes }] }],
      ["a negative depth", { ...report, frames: [{ ...frame, scopes: [{ ...frame.scopes[0], depth: -1 }] }] }],
      ["a GPU node with a path", { ...report, frames: [{ ...frame, gpu: [{ node: "../world", ms: 1 }] }] }],
      ["an engine label with spaces", { ...report, engine: "rust wgpu" }],
      ["a non-boolean truncated", { ...report, truncated: "no" }],
      ["over 256 KiB", { ...report, padding: "x".repeat(PROFILE_REPORT_MAX_BYTES) }],
    ];
    for (const [name, value] of rows) assert.equal(parseProfileReport(value), null, name);
  });
});

describe("the dev op's answers, by action", () => {
  it("reads each action's answer in its own shape and refuses another action's", () => {
    assert.deepEqual(parseProfileAnswer(FrameProfileAction.Summary, summary), summary);
    assert.deepEqual(parseProfileAnswer(FrameProfileAction.Report, report), report);
    assert.deepEqual(parseProfileAnswer(FrameProfileAction.Arm, { mode: GpuTimingMode.Nodes, x: 1 }), {
      mode: GpuTimingMode.Nodes,
    });
    assert.deepEqual(parseProfileAnswer(FrameProfileAction.Trace, { bytes: 4096, digest: "0123456789abcdef" }), {
      bytes: 4096,
      digest: "0123456789abcdef",
    });
    assert.equal(parseProfileAnswer(FrameProfileAction.Summary, report), null);
    assert.equal(parseProfileAnswer(FrameProfileAction.Arm, { mode: "all" }), null);
    assert.equal(parseProfileAnswer(FrameProfileAction.Trace, { bytes: 1, digest: "XYZ" }), null);
    assert.equal(parseProfileAnswer(FrameProfileAction.Trace, { bytes: -1, digest: "0123456789abcdef" }), null);
  });
});

describe("a profile request", () => {
  it("takes every action, frames 1..=240 and a known mode, copied", () => {
    for (const action of Object.values(FrameProfileAction))
      assert.deepEqual(parseFrameProfileRequest({ action, junk: 1 }), { action });
    assert.deepEqual(parseFrameProfileRequest({ action: FrameProfileAction.Report, frames: 240 }), {
      action: FrameProfileAction.Report,
      frames: 240,
    });
    assert.deepEqual(parseFrameProfileRequest({ action: FrameProfileAction.Arm, mode: GpuTimingMode.Nodes }), {
      action: FrameProfileAction.Arm,
      mode: GpuTimingMode.Nodes,
    });
  });

  it("refuses an unknown action, frames outside 1..=240 and an unknown mode", () => {
    for (const bad of [
      null,
      "summary",
      { action: "eval" },
      { action: FrameProfileAction.Report, frames: 0 },
      { action: FrameProfileAction.Report, frames: 241 },
      { action: FrameProfileAction.Report, frames: 1.5 },
      { action: FrameProfileAction.Arm, mode: "everything" },
    ])
      assert.equal(parseFrameProfileRequest(bad), null, JSON.stringify(bad));
  });
});

describe("vocabularies and bounds", () => {
  it("names the wire's spellings", () => {
    assert.deepEqual(Object.values(FrameProfileAction), ["summary", "report", "arm", "trace"]);
    assert.deepEqual(Object.values(GpuTimingMode), ["frame", "nodes"]);
    assert.deepEqual(Object.values(HitchCause), ["cpu", "gpu", "pacing"]);
    assert.deepEqual(Object.values(GpuTimeSource), ["timestamps", "timestamps-quantized", "submit-latency", "none"]);
    assert.deepEqual(profileUnavailable(ProfileUnavailableReason.NotServed), {
      state: "unavailable",
      reason: "not-served",
    });
  });

  it("measures depth without recursion and size as UTF-8 JSON", () => {
    let deep: unknown = 0;
    for (let i = 0; i < 100_000; i += 1) deep = [deep];
    assert.equal(jsonWithin(deep, Number.MAX_SAFE_INTEGER, 8), false);
    assert.equal(jsonWithin({ a: "é" }, 10, 2), true);
    assert.equal(jsonWithin({ a: "éé" }, 10, 2), false);
    assert.equal(jsonWithin(BigInt(1), 100, 2), false);
  });
});

describe("the harness's preview.frameProfile and game.crashes params", () => {
  it("takes a known action, frames 1..=240 and a known mode, and a game named as text", () => {
    for (const params of [
      { handle: "h1", action: FrameProfileAction.Summary },
      { handle: "h1", action: FrameProfileAction.Report, frames: 240 },
      { handle: "h1", action: FrameProfileAction.Arm, mode: GpuTimingMode.Nodes },
    ])
      assert.equal(harnessParamsProblem(HostMethod.PreviewFrameProfile, params), null, JSON.stringify(params));
    assert.equal(
      harnessParamsProblem(HostMethod.GameCrashes, { project: "pong", since: "2026-10-20T00:00:00Z" }),
      null,
    );
  });

  it("refuses anything else before a handler runs", () => {
    for (const params of [
      null,
      {},
      { handle: "h1" },
      { handle: "h1", action: "flame" },
      { handle: "h1", action: FrameProfileAction.Report, frames: 0 },
      { handle: "h1", action: FrameProfileAction.Report, frames: 241 },
      { handle: "h1", action: FrameProfileAction.Report, frames: 1.5 },
      { handle: "h1", action: FrameProfileAction.Arm, mode: "all" },
      { handle: 7, action: FrameProfileAction.Summary },
    ])
      assert.ok(harnessParamsProblem(HostMethod.PreviewFrameProfile, params), JSON.stringify(params));
    for (const params of [null, {}, { project: 7 }, { project: "pong", id: 3 }])
      assert.ok(harnessParamsProblem(HostMethod.GameCrashes, params), JSON.stringify(params));
  });
});
