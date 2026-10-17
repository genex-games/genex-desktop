/**
 * The native run contract's checks over untrusted lines (`shared/native-contract.ts`): every op's
 * reply is accepted in its shape and refused outside it, events are copied field by field, and
 * input from the renderer or the harness is refused whole for a NaN, an oversize list or an
 * unknown kind. Also: the refusals that alias `TargetRefusal` are its strings, `NativeError`
 * carries its refusal and build problem, and a port that answers readiness itself is asked first.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { SandboxProblemCode } from "../../src/shared/boot.ts";
import { BuildProblemCode, type BuildProblem } from "../../src/shared/build-problem.ts";
import { BuildTarget } from "../../src/shared/game-project.ts";
import { DestinationBadge, TargetRefusal } from "../../src/shared/game-targets.ts";
import {
  type DestinationCheck,
  GameBoxProblem,
  isNativeOp,
  isNativeProtocolVersion,
  isNativeResult,
  NATIVE_CUSTOM_PASS_API_VERSION,
  NATIVE_CUSTOM_PASSES_KEY,
  NATIVE_EXTENSION_API_VERSION,
  NATIVE_PROTOCOL_V1,
  NATIVE_PROTOCOL_VERSION,
  NATIVE_PROTOCOL_VERSIONS,
  NATIVE_RECEIPT_MAX_BYTES,
  NATIVE_WGSL_MAX_BYTES,
  NativeEnhancedFeature,
  NativeGpuBound,
  NativeGpuTier,
  NativeLifecycle,
  NativeOpError,
  NATIVE_WGPU_BACKENDS,
  NATIVE_CAPTURE_MAX_PX,
  NATIVE_CROSS_EXECUTABLES,
  NATIVE_FRAME_PIXELS_MAX,
  NATIVE_FRAME_SIDE_MAX,
  NATIVE_FRAMES_DROPPED,
  NATIVE_INPUT_ACTIONS_MAX,
  NATIVE_QUIT_GRACE_MS,
  NATIVE_REAP_MARGIN_MS,
  NATIVE_STOP_BUDGET_MS,
  NATIVE_TERM_GRACE_MS,
  NativeBackend,
  NativeEnv,
  NativeError,
  type NativeEmbedSize,
  NativeEvent,
  NativeFramesCode,
  NativeInputKind,
  NativeOp,
  type NativeOpResults,
  NativeRefusal,
  nativeRefusalOfFrames,
  parseNativeEmbedSize,
  parseDestinationCheck,
  parseNativeCapabilityReceipt,
  BootStage,
  NATIVE_BOOT_COUNT_MAX,
  parseNativeEvent,
  parseNativeInput,
  nativeCustomPasses,
  nativeRenderStatus,
  NATIVE_RENDER_KEY,
  NATIVE_RENDER_SETTINGS_API_VERSION,
  receiptCustomPassApis,
  receiptExtensionApis,
  receiptServesRenderSettings,
  ringSizeFor,
} from "../../src/shared/native-contract.ts";
import { parseRenderSettingsAnswer } from "../../src/shared/render-quality.ts";
import { ReadyPhase, ReadyVia, TouchPhase } from "../../src/shared/preview-contract.ts";
import type { PreviewPort } from "../../src/substrate/preview-port.ts";
import { readySnapshot, type ReadySnapshot } from "../../src/substrate/preview-ready.ts";

/** For every op: a reply the host accepts, and replies it refuses (each must be `reply-invalid`). */
const RESULTS: { [K in keyof NativeOpResults]: { good: unknown[]; bad: unknown[] } } = {
  [NativeOp.Seed]: {
    good: [{ seed: 7, paused: true }],
    bad: [
      { seed: 7, paused: false },
      { seed: "7", paused: true },
    ],
  },
  [NativeOp.Start]: { good: [{ running: true }], bad: [{ running: "yes" }, {}] },
  [NativeOp.Pause]: { good: [{ running: false }], bad: [{ running: 0 }] },
  [NativeOp.Step]: {
    good: [{ frame: 3, simulatedMs: 50, steppedFrames: 3, drawCalls: 12 }],
    bad: [
      { frame: -1, simulatedMs: 50, steppedFrames: 3, drawCalls: 12 },
      { frame: 3, simulatedMs: Number.NaN, steppedFrames: 3, drawCalls: 12 },
      { frame: 3.5, simulatedMs: 50, steppedFrames: 3, drawCalls: 12 },
    ],
  },
  [NativeOp.State]: { good: [{}, { phase: "play", player: { x: 1 } }], bad: [[], "state", null] },
  [NativeOp.Input]: { good: [{ held: ["KeyW"] }, { held: [], ignored: 2 }], bad: [{ held: "KeyW" }, { held: [1] }] },
  [NativeOp.Capture]: {
    good: [{ seq: 0, width: 640, height: 360, format: "bgra8", digest: "0123456789abcdef" }],
    bad: [
      { seq: 0, width: NATIVE_CAPTURE_MAX_PX + 1, height: 360, format: "bgra8", digest: "0123456789abcdef" },
      { seq: 0, width: 0, height: 360, format: "bgra8", digest: "0123456789abcdef" },
      { seq: 0, width: 640, height: 360, format: "rgba8", digest: "0123456789abcdef" },
      { seq: 0, width: 640, height: 360, format: "bgra8", digest: "0123456789ABCDEF" },
      { seq: 0, width: 640, height: 360, format: "bgra8", digest: "../../etc/passwd" },
      { seq: -1, width: 640, height: 360, format: "bgra8", digest: "0123456789abcdef" },
    ],
  },
  [NativeOp.DebugCamera]: {
    good: [
      { ok: true, camera: "top" },
      { ok: false, available: ["default", "top"] },
    ],
    bad: [{ camera: "top" }, { ok: false, available: "top" }],
  },
  [NativeOp.Cameras]: { good: [{ cameras: ["default"] }], bad: [{ cameras: [1] }, { cameras: "default" }] },
  [NativeOp.Eyes]: { good: [{ eyes: [] }], bad: [{}] },
  [NativeOp.Demos]: { good: [{ demos: ["jump"] }], bad: [{ demos: [null] }] },
  [NativeOp.Demo]: {
    good: [
      { ok: true, demo: "jump", result: { landed: true } },
      { ok: false, available: ["jump"] },
    ],
    bad: [{ demo: "jump" }, { ok: true, demo: 5 }],
  },
  [NativeOp.Audio]: { good: [{ muted: true }], bad: [{ muted: "true" }] },
  [NativeOp.AudioLevel]: {
    good: [{ rms: 0.2, centroid: 1800 }],
    bad: [{ rms: Number.POSITIVE_INFINITY, centroid: 1 }, { rms: 0.2 }],
  },
  [NativeOp.Timing]: {
    good: [{ frameMs: 16.6, updateMs: 2, drawMs: 4, frames: 60 }],
    bad: [{ frameMs: 16.6, updateMs: 2, drawMs: 4, frames: -2 }],
  },
  [NativeOp.Quit]: { good: [{ quitting: true }], bad: [{ quitting: false }] },
  [NativeOp.Front]: { good: [{ fronted: false }], bad: [{ fronted: null }] },
  [NativeOp.Visible]: { good: [{ visible: true }], bad: [{}] },
  [NativeOp.Surface]: {
    good: [
      { generation: 1, width: 1280, height: 720, slots: 3 },
      { generation: 7, width: NATIVE_FRAME_SIDE_MAX, height: 1, slots: 1, extra: true },
    ],
    bad: [
      // The wave-2 shape: a ring of handle names is refused, the generation answers now.
      { ring: [{ slot: 0, handleRef: "a" }] },
      { generation: 0, width: 1280, height: 720, slots: 3 },
      { generation: 1.5, width: 1280, height: 720, slots: 3 },
      { generation: 2 ** 32, width: 1280, height: 720, slots: 3 },
      { generation: 1, width: NATIVE_FRAME_SIDE_MAX + 1, height: 720, slots: 3 },
      { generation: 1, width: 1280, height: 0, slots: 3 },
      { generation: 1, width: 1280, height: 720, slots: 4 },
      { generation: 1, width: 1280, height: 720, slots: 0 },
      { generation: "1", width: 1280, height: 720, slots: 3 },
    ],
  },
  [NativeOp.Release]: { good: [{}], bad: [null, []] },
  [NativeOp.RenderSettings]: {
    good: [
      {
        preset: "medium",
        requested: "auto",
        deviceClass: "desktop-mid",
        detectedClass: "desktop-mid",
        features: {},
        renderScaleLock: null,
        scale: 1,
      },
    ],
    bad: [
      {
        preset: "auto",
        requested: "auto",
        deviceClass: "desktop-mid",
        detectedClass: "desktop-mid",
        features: {},
        renderScaleLock: null,
        scale: 1,
      },
      {
        preset: "low",
        requested: "low",
        deviceClass: "phone",
        detectedClass: "desktop-mid",
        features: {},
        renderScaleLock: null,
        scale: 1,
      },
      {
        preset: "low",
        requested: "low",
        deviceClass: "desktop-mid",
        detectedClass: "desktop-mid",
        features: { rtx: true },
        renderScaleLock: null,
        scale: 1,
      },
      {
        preset: "low",
        requested: "low",
        deviceClass: "desktop-mid",
        detectedClass: "desktop-mid",
        features: {},
        renderScaleLock: 2,
        scale: 1,
      },
      {
        preset: "low",
        requested: "low",
        deviceClass: "desktop-mid",
        detectedClass: "desktop-mid",
        features: {},
        renderScaleLock: null,
        scale: 0.1,
      },
      {
        preset: "low",
        requested: "low",
        deviceClass: "desktop-mid",
        detectedClass: "desktop-mid",
        features: {},
        scale: 1,
      },
    ],
  },
};

describe("every op's reply is checked against its own shape", () => {
  for (const op of Object.values(NativeOp)) {
    it(`${op}: accepts its shape and refuses everything else`, () => {
      const rows = RESULTS[op];
      for (const good of rows.good) assert.equal(isNativeResult(op, good), true, JSON.stringify(good));
      for (const bad of [...rows.bad, undefined, "x", 1])
        assert.equal(isNativeResult(op, bad), false, JSON.stringify(bad));
    });
  }

  it("refuses an op the host does not know, and knows every op it sends", () => {
    assert.equal(isNativeResult("eval" as keyof NativeOpResults, {}), false);
    for (const op of Object.values(NativeOp)) assert.equal(isNativeOp(op), true, op);
    for (const op of ["eval", "", 1, null, "__proto__"]) assert.equal(isNativeOp(op), false, String(op));
  });
});

describe("events are checked and copied", () => {
  const ready = {
    event: NativeEvent.Ready,
    nonce: "n-1",
    protocol: 1,
    contractVersion: 2,
    build: "abc123",
    backend: { api: NativeBackend.MetalAngle, device: "Apple M4 Max" },
    size: { width: 640, height: 360 },
    seed: 42,
  };

  it("a ready event is copied with only the fields it declares", () => {
    const parsed = parseNativeEvent({ ...ready, extra: "dropped", backend: { ...ready.backend, other: 1 } });
    assert.deepEqual(parsed, ready);
  });

  it("refuses a ready event with any field outside its shape", () => {
    for (const bad of [
      { ...ready, nonce: 1 },
      { ...ready, nonce: "x".repeat(10_000) },
      { ...ready, protocol: "1" },
      { ...ready, backend: { api: "opengl", device: null } },
      { ...ready, backend: { api: NativeBackend.MetalAngle } },
      { ...ready, size: { width: 0, height: 360 } },
      { ...ready, size: { width: NATIVE_CAPTURE_MAX_PX + 1, height: 360 } },
      { ...ready, seed: Number.NaN },
      { ...ready, event: "Ready" },
    ])
      assert.equal(parseNativeEvent(bad), null, JSON.stringify(bad));
  });

  // Renderer pass 2 (owner decision D11): a boot step names where the boot is, so Live shows real
  // progress; a progress it cannot read is dropped, never the event (its deadline still counts).
  it("a starting event carries where the boot is, and a malformed progress is dropped, never the event", () => {
    const starting = { event: NativeEvent.Starting };
    assert.deepEqual(parseNativeEvent(starting), starting);
    assert.deepEqual(parseNativeEvent({ ...starting, stage: BootStage.Pipelines, done: 12, total: 40 }), {
      ...starting,
      progress: { stage: BootStage.Pipelines, done: 12, total: 40 },
    });
    assert.deepEqual(parseNativeEvent({ ...starting, stage: BootStage.Device }), {
      ...starting,
      progress: { stage: BootStage.Device, done: null, total: null },
    });
    assert.deepEqual(parseNativeEvent({ ...starting, stage: "warp-drive", done: 1, total: 2 }), starting);
    assert.deepEqual(parseNativeEvent({ ...starting, stage: 7 }), starting);
    for (const [done, total] of [
      [-1, 40],
      [41, 40],
      [1.5, 40],
      ["12", 40],
      [1, NATIVE_BOOT_COUNT_MAX + 1],
    ]) {
      assert.deepEqual(
        parseNativeEvent({ ...starting, stage: BootStage.Pipelines, done, total }),
        { ...starting, progress: { stage: BootStage.Pipelines, done: null, total: null } },
        `${done} of ${total}`,
      );
    }
  });

  it("a focus event is forwarded, and a malformed one is refused", () => {
    assert.deepEqual(parseNativeEvent({ event: NativeEvent.Focus, focused: true }), {
      event: NativeEvent.Focus,
      focused: true,
    });
    for (const bad of [{ event: NativeEvent.Focus }, { event: NativeEvent.Focus, focused: "yes" }])
      assert.equal(parseNativeEvent(bad), null);
  });

  it("fatal and frame events are copied; anything else is refused", () => {
    assert.deepEqual(parseNativeEvent({ event: NativeEvent.Fatal, reason: "out of memory", pid: 1 }), {
      event: NativeEvent.Fatal,
      reason: "out of memory",
    });
    assert.deepEqual(parseNativeEvent({ event: NativeEvent.Frame, seq: 1, slot: 0, ts: 12.5 }), {
      event: NativeEvent.Frame,
      seq: 1,
      slot: 0,
      ts: 12.5,
    });
    for (const bad of [null, [], "ready", { event: "hello" }, { event: NativeEvent.Frame, seq: -1, slot: 0, ts: 1 }])
      assert.equal(parseNativeEvent(bad), null, JSON.stringify(bad));
  });
});

describe("input from the renderer or the harness", () => {
  it("keeps every known kind, copied with only the fields it knows", () => {
    const actions = [
      { type: "tap", keys: ["KeyW"], stepMs: 16, junk: true },
      { type: "click", x: 0.5, y: 0.5, button: "left" },
      { type: "move", x: 10, y: 20 },
      { type: "look", dx: 3, dy: -2 },
      { type: "wait", ms: 100 },
      { type: NativeInputKind.Gamepad, index: 0, buttons: [1, 0, 0.5], axes: [-1, 0, 1, 0.25] },
      { type: NativeInputKind.Text, text: "héllo" },
    ];
    const parsed = parseNativeInput(actions);
    assert.ok(parsed);
    assert.equal(parsed.length, actions.length);
    assert.deepEqual(JSON.parse(JSON.stringify(parsed[0])), { type: "tap", keys: ["KeyW"], stepMs: 16 });
    assert.deepEqual(parsed[5], {
      type: NativeInputKind.Gamepad,
      index: 0,
      buttons: [1, 0, 0.5],
      axes: [-1, 0, 1, 0.25],
    });
  });

  it("refuses the whole list for a NaN, an infinity, an unknown kind or a field outside its shape", () => {
    const rows: unknown[][] = [
      [{ type: "move", x: Number.NaN, y: 0 }],
      [{ type: "look", dx: Number.POSITIVE_INFINITY, dy: 0 }],
      [
        { type: "wait", ms: 10 },
        { type: "eval", code: "1" },
      ],
      [{ type: "tap", keys: [] }],
      [{ type: "tap", keys: "KeyW" }],
      [{ type: "click", button: "fourth" }],
      [{ type: NativeInputKind.Gamepad, index: 4, buttons: [], axes: [] }],
      [{ type: NativeInputKind.Gamepad, index: 0, buttons: [2], axes: [] }],
      [{ type: NativeInputKind.Gamepad, index: 0, buttons: [], axes: [0, 0, 0, 0, 0] }],
      [{ type: NativeInputKind.Text, text: "x".repeat(257) }],
      [null],
      [[]],
    ];
    for (const row of rows) assert.equal(parseNativeInput(row), null, JSON.stringify(row));
    for (const notAList of [undefined, null, "tap", { type: "tap", keys: ["KeyW"] }])
      assert.equal(parseNativeInput(notAList), null);
  });

  it("takes 5000 actions and refuses 5001", () => {
    const wait = { type: "wait", ms: 1 };
    assert.equal(parseNativeInput(Array.from({ length: NATIVE_INPUT_ACTIONS_MAX }, () => wait))?.length, 5000);
    assert.equal(parseNativeInput(Array.from({ length: NATIVE_INPUT_ACTIONS_MAX + 1 }, () => wait)), null);
  });
});

describe("refusals and errors", () => {
  it("the refusals a destination shares with TargetRefusal are its strings", () => {
    assert.equal(NativeRefusal.NoGameBox, TargetRefusal.NoGameBox);
    assert.equal(NativeRefusal.NotADestination, TargetRefusal.NotADestination);
    assert.equal(NativeRefusal.NotRunnableHere, TargetRefusal.NotRunnableHere);
    assert.equal(NativeRefusal.KindUnsupported, TargetRefusal.KindUnsupported);
    assert.equal(NativeRefusal.StackGated, TargetRefusal.StackGated);
    assert.equal(NativeRefusal.ToolchainOffline, TargetRefusal.ToolchainOffline);
    assert.equal(NativeRefusal.BuildFailed, "build-failed");
    assert.equal(NativeRefusal.HarnessPredatesNative, "harness-predates-native");
    const values = Object.values(NativeRefusal);
    assert.equal(new Set(values).size, values.length, "no two refusals share a string");
  });

  it("a NativeError carries its refusal and the build's problem beside its sentence", () => {
    const problem: BuildProblem = {
      project: "pong",
      command: "cmake --build",
      code: 1,
      lines: ["main.cpp:3:1: error: expected ';'"],
      needsInstall: false,
      install: null,
      showingLastBuild: false,
      at: "2026-10-01T00:00:00.000Z",
      reason: BuildProblemCode.CommandFailed,
    };
    const failed = new NativeError(NativeRefusal.BuildFailed, "the Mac build failed", problem);
    assert.ok(failed instanceof Error);
    assert.equal(failed.refusal, NativeRefusal.BuildFailed);
    assert.equal(failed.problem, problem);
    assert.equal(failed.message, "the Mac build failed");
    assert.equal(new NativeError(NativeRefusal.ReadyTimeout, "late").problem, null);
    assert.equal(new NativeError(NativeRefusal.ReadyTimeout, "late").box, null);
  });

  it("a NativeError for a host with no usable game box carries the box's problem", () => {
    const refused = new NativeError(NativeRefusal.NoGameBox, "no bubblewrap", null, GameBoxProblem.BubblewrapMissing);
    assert.equal(refused.refusal, NativeRefusal.NoGameBox);
    assert.equal(refused.problem, null);
    assert.equal(refused.box, GameBoxProblem.BubblewrapMissing);
  });

  it("names the PE and ELF gates' machine and import refusals once, after #42's embedding refusals", () => {
    assert.equal(NativeRefusal.WrongMachine, "wrong-machine");
    assert.equal(NativeRefusal.ForeignImport, "foreign-import");
    const values = Object.values(NativeRefusal);
    const machine = values.indexOf("wrong-machine");
    assert.deepEqual(values.slice(machine, machine + 2), ["wrong-machine", "foreign-import"]);
    assert.equal(values[machine - 1], "game-predates-embedding", "appended after #42's embedding refusals");
    assert.equal(values.lastIndexOf("wrong-machine"), machine, "once");
  });

  it("names every game-box problem once; the user-namespace one is the boot gate's own string", () => {
    assert.deepEqual(Object.values(GameBoxProblem), [
      "launcher-missing",
      "bubblewrap-missing",
      "userns-restricted",
      "x11-only",
      "no-wayland",
      "wayland-unrestricted",
      "no-headless-build",
      "box-refused",
      "wayland-helper-missing",
    ]);
    assert.equal(GameBoxProblem.UsernsRestricted, SandboxProblemCode.UsernsRestricted);
  });

  it("names the Windows pipe and the cross destinations' executables", () => {
    assert.equal(NativeEnv.StudioPipe, "GENEX_STUDIO_PIPE");
    assert.deepEqual(NATIVE_CROSS_EXECUTABLES, { [BuildTarget.Windows]: "game.exe", [BuildTarget.Linux]: "game" });
  });

  it("the stop budget is the stop sequence, quit to reap", () => {
    assert.equal(NATIVE_STOP_BUDGET_MS, NATIVE_QUIT_GRACE_MS + NATIVE_TERM_GRACE_MS + NATIVE_REAP_MARGIN_MS);
  });
});

/** A destination check as the lane records it. */
const CHECK: DestinationCheck = {
  badge: DestinationBadge.NotRunHere,
  lock: "0123456789ab",
  at: "2026-10-01T11:00:00.000Z",
};

describe("a destination check read back from the library", () => {
  it("round-trips a check, with and without a refusal, as a copy", () => {
    assert.deepEqual(parseDestinationCheck(CHECK), CHECK);
    const failed = { ...CHECK, badge: DestinationBadge.Failed, refusal: NativeRefusal.ImportsOpengl32 };
    assert.deepEqual(parseDestinationCheck(failed), failed);
    const extra = { ...CHECK, note: "dropped" };
    assert.deepEqual(parseDestinationCheck(extra), CHECK, "unknown fields are not carried");
    assert.notEqual(parseDestinationCheck(CHECK), CHECK);
  });

  const HOSTILE: ReadonlyArray<[string, unknown]> = [
    ["null", null],
    ["undefined", undefined],
    ["a string", "built"],
    ["an array", [CHECK]],
    ["an array of fields", ["built", "0123456789ab", CHECK.at]],
    ["a badge the stage does not know", { ...CHECK, badge: "pass" }],
    ["a badge that is not a string", { ...CHECK, badge: 1 }],
    ["no badge", { lock: CHECK.lock, at: CHECK.at }],
    ["a lock that climbs out", { ...CHECK, lock: "../x" }],
    ["a whole lock digest", { ...CHECK, lock: "0123456789abcdef".repeat(4) }],
    ["a lock in capitals", { ...CHECK, lock: "0123456789AB" }],
    ["a lock of 11 hex", { ...CHECK, lock: "0123456789a" }],
    ["no lock", { badge: CHECK.badge, at: CHECK.at }],
    ["a time that is no date", { ...CHECK, at: "yesterday" }],
    ["a time that is an invalid date", { ...CHECK, at: "2026-13-45T99:00:00.000Z" }],
    ["a time past 40 characters", { ...CHECK, at: `${CHECK.at}${" ".repeat(20)}` }],
    ["a time that is a number", { ...CHECK, at: 1_759_316_400_000 }],
    ["a refusal the host does not know", { ...CHECK, refusal: "rm -rf" }],
    ["a refusal that is null", { ...CHECK, refusal: null }],
    ["a refusal that is an array", { ...CHECK, refusal: [NativeRefusal.Symlink] }],
  ];
  for (const [name, value] of HOSTILE)
    it(`answers null for ${name}`, () => {
      assert.equal(parseDestinationCheck(value), null);
    });
});

describe("a port that answers readiness itself", () => {
  /** A port whose page probe would answer `pageAnswer`, and which may answer readiness itself. */
  function port(pageAnswer: unknown, own?: () => Promise<ReadySnapshot | null>): PreviewPort & { probes: number } {
    const fake = {
      probes: 0,
      load: async () => "",
      reload: async () => {},
      screenshot: async () => Buffer.alloc(0),
      evaluate: async () => {
        fake.probes++;
        return pageAnswer;
      },
      studioState: async () => ({}),
      studioCall: async () => ({}),
      input: async () => ({ ok: true, applied: 0, width: 1, height: 1 }),
      consoleEntries: () => [],
      status: () => ({
        project: null,
        url: null,
        crashed: false,
        unresponsive: false,
        loadError: null,
        consoleErrors: null,
      }),
      ...(own ? { readySnapshot: own } : {}),
    };
    return fake;
  }
  const native: ReadySnapshot = {
    via: ReadyVia.Contract,
    ready: true,
    phase: ReadyPhase.Ready,
    attached: true,
    frames: 1,
    drawCalls: 4,
    pageMs: null,
    timedOut: false,
    reason: null,
    gesture: { needed: false, done: false, reasons: [] },
  };

  it("is asked instead of the page probe, which a native game cannot run", async () => {
    const answered = port({ via: ReadyVia.None, ready: false }, async () => native);
    assert.deepEqual(await readySnapshot(answered), native);
    assert.equal(answered.probes, 0, "nothing was evaluated");
  });

  it("an empty answer is a silent page, and a throw never escapes", async () => {
    const empty = await readySnapshot(port(null, async () => null));
    assert.equal(empty.via, ReadyVia.None);
    assert.equal(empty.ready, false);
    const thrown = await readySnapshot(
      port(null, async () => {
        throw new Error("the game is gone");
      }),
    );
    assert.equal(thrown.ready, false);
    assert.match(thrown.reason ?? "", /the game is gone/);
  });

  it("a port without one is still probed through the page", async () => {
    const page = port({ via: ReadyVia.Shim, ready: true, phase: ReadyPhase.Ready, frames: 2 });
    const snapshot = await readySnapshot(page);
    assert.equal(snapshot.ready, true);
    assert.equal(page.probes, 1);
  });
});

describe("Live's embedded size", () => {
  const hostile: Array<[string, unknown]> = [
    ["NaN width", { width: Number.NaN, height: 600, dpr: 2 }],
    ["a negative width", { width: -1, height: 600, dpr: 2 }],
    ["a zero height", { width: 800, height: 0, dpr: 2 }],
    ["a million pixels wide", { width: 1e6, height: 600, dpr: 2 }],
    ["one past the side cap", { width: NATIVE_FRAME_SIDE_MAX + 1, height: 600, dpr: 1 }],
    ["a fractional side", { width: 800.5, height: 600, dpr: 1 }],
    ["a side as text", { width: "800", height: 600, dpr: 2 }],
    ["dpr 0", { width: 800, height: 600, dpr: 0 }],
    ["dpr 5", { width: 800, height: 600, dpr: 5 }],
    ["dpr NaN", { width: 800, height: 600, dpr: Number.NaN }],
    ["dpr Infinity", { width: 800, height: 600, dpr: Number.POSITIVE_INFINITY }],
    ["no dpr", { width: 800, height: 600 }],
    ["no height", { width: 800, dpr: 1 }],
    ["device pixels as text", { width: 800, height: 600, dpr: 2, device: "1600x1200" }],
    ["fractional device pixels", { width: 800, height: 600, dpr: 2, device: { width: 1600.5, height: 1200 } }],
    ["zero device pixels", { width: 800, height: 600, dpr: 2, device: { width: 0, height: 1200 } }],
    ["NaN device pixels", { width: 800, height: 600, dpr: 2, device: { width: Number.NaN, height: 1200 } }],
    ["a missing device side", { width: 800, height: 600, dpr: 2, device: { width: 1600 } }],
    ["device pixels far from the CSS size", { width: 800, height: 600, dpr: 2, device: { width: 1e6, height: 1200 } }],
    [
      "device pixels a few pixels off the CSS size",
      { width: 800, height: 600, dpr: 2, device: { width: 1603, height: 1200 } },
    ],
    ["null", null],
    ["an array", [800, 600, 2]],
    ["a string", "800x600"],
  ];
  for (const [label, value] of hostile)
    it(`refuses ${label}`, () => assert.equal(parseNativeEmbedSize(value), null, JSON.stringify(value)));

  it("accepts CSS sides from 1 to the cap and a dpr from 1 to 4, as a fresh copy", () => {
    const sent = { width: 800, height: 600, dpr: 2, extra: "x" };
    const parsed = parseNativeEmbedSize(sent);
    assert.deepEqual(parsed, { width: 800, height: 600, dpr: 2 });
    assert.notEqual(parsed, sent);
    assert.deepEqual(parseNativeEmbedSize({ width: 1, height: NATIVE_FRAME_SIDE_MAX, dpr: 1 }), {
      width: 1,
      height: NATIVE_FRAME_SIDE_MAX,
      dpr: 1,
    });
    assert.deepEqual(parseNativeEmbedSize({ width: 320, height: 200, dpr: 4 }), { width: 320, height: 200, dpr: 4 });
    assert.deepEqual(parseNativeEmbedSize({ width: 320, height: 200, dpr: 1.5 }), {
      width: 320,
      height: 200,
      dpr: 1.5,
    });
  });

  it("accepts the canvas's device pixels within one CSS pixel of its CSS size, as a fresh copy", () => {
    const device = { width: 1625, height: 915 };
    const parsed = parseNativeEmbedSize({ width: 813, height: 458, dpr: 2, device });
    assert.deepEqual(parsed, { width: 813, height: 458, dpr: 2, device });
    assert.notEqual(parsed?.device, device);
  });

  const rings: Array<[string, NativeEmbedSize, { width: number; height: number }]> = [
    ["device pixels of a Retina canvas", { width: 800, height: 600, dpr: 2 }, { width: 1600, height: 1200 }],
    ["a fractional dpr rounds", { width: 333, height: 201, dpr: 1.5 }, { width: 500, height: 302 }],
    ["one pixel", { width: 1, height: 1, dpr: 1 }, { width: 1, height: 1 }],
    ["a square past the side cap halves", { width: 4096, height: 4096, dpr: 2 }, { width: 4096, height: 4096 }],
    ["a wide strip keeps its aspect", { width: 4000, height: 1000, dpr: 2 }, { width: 4096, height: 1024 }],
    ["a thin strip never reaches zero", { width: 4096, height: 1, dpr: 4 }, { width: 4096, height: 1 }],
    [
      "the canvas's device pixels when it reports them",
      { width: 813, height: 458, dpr: 2, device: { width: 1625, height: 915 } },
      { width: 1625, height: 915 },
    ],
    [
      "device pixels past the side cap keep the cap and the aspect",
      { width: 4000, height: 1000, dpr: 2, device: { width: 7999, height: 2000 } },
      { width: 4096, height: 1024 },
    ],
  ];
  for (const [label, size, expected] of rings)
    it(`rings: ${label}`, () => {
      const ring = ringSizeFor(size);
      assert.deepEqual(ring, expected);
      assert.ok(ring.width <= NATIVE_FRAME_SIDE_MAX && ring.height <= NATIVE_FRAME_SIDE_MAX);
      assert.ok(ring.width * ring.height <= NATIVE_FRAME_PIXELS_MAX);
    });
});

describe("the frames addon's refusals", () => {
  it("has the addon's 26 codes, in their wire spelling, each once", () => {
    const codes = Object.values(NativeFramesCode);
    assert.equal(codes.length, 26);
    assert.equal(new Set(codes).size, 26);
    for (const code of codes) assert.match(code, /^[a-z]+(-[a-z]+)*$/, code);
  });

  it("drops a foreign sender's frame and a stale generation's; every other code is fatal", () => {
    assert.deepEqual([...NATIVE_FRAMES_DROPPED].sort(), [
      NativeFramesCode.ForeignSender,
      NativeFramesCode.StaleGeneration,
    ]);
  });

  it("maps every code to a run refusal: the slot, size and rate ones by name, the rest as invalid frames", () => {
    const named: Partial<Record<NativeFramesCode, NativeRefusal>> = {
      [NativeFramesCode.UnknownSlot]: NativeRefusal.SlotUnknown,
      [NativeFramesCode.SizeMismatch]: NativeRefusal.SlotMismatch,
      [NativeFramesCode.FormatMismatch]: NativeRefusal.SlotMismatch,
      [NativeFramesCode.AllocMismatch]: NativeRefusal.SlotMismatch,
      [NativeFramesCode.RingOverflow]: NativeRefusal.TooManySlots,
      [NativeFramesCode.DuplicateSurface]: NativeRefusal.TooManySlots,
      [NativeFramesCode.Rate]: NativeRefusal.FrameRate,
    };
    const refusals = new Set<string>(Object.values(NativeRefusal));
    for (const code of Object.values(NativeFramesCode)) {
      const refusal = nativeRefusalOfFrames(code);
      assert.ok(refusals.has(refusal), `${code} → ${refusal}`);
      assert.equal(refusal, named[code] ?? NativeRefusal.FramesInvalid, code);
    }
  });

  it("adds the embedding refusals at the end, keeping every older value where it was", () => {
    const values = Object.values(NativeRefusal);
    // #42's embedding refusals, then the gate refusals, then contract v2's GPU refusals, then
    // touch-not-taken, each appended after the last: an older value never moves.
    const embedding = values.indexOf("frames-invalid");
    assert.deepEqual(values.slice(embedding, embedding + 3), [
      "frames-invalid",
      "frames-stalled",
      "game-predates-embedding",
    ]);
    assert.equal(values.indexOf("electron-untested"), embedding - 1);
    assert.deepEqual(values.slice(embedding + 3, embedding + 5), ["wrong-machine", "foreign-import"]);
    const gpu = embedding + 5;
    assert.deepEqual(values.slice(gpu, gpu + WIRE.gpuRefusals.length), WIRE.gpuRefusals);
    // Then the host's own answer to a touch on a preview that takes none (M3 review), then (flipped,
    // M7.3) the conformance gate's refusal of an ejected game's run.
    assert.deepEqual(values.slice(gpu + WIRE.gpuRefusals.length), ["touch-not-taken", "conformance-required"]);
  });
});

/** Contract v2's wire names, held by this file and by genex-studio's `wire.rs` tests. */
const WIRE = JSON.parse(readFileSync(new URL("../fixtures/native-wire-v2.json", import.meta.url), "utf8")) as {
  protocol: { v1: number; current: number };
  inputKind: { touch: string };
  bootStages: string[];
  touchPhases: string[];
  lifecycle: string[];
  wgpuBackends: string[];
  receiptTier: string;
  nativeEnhanced: string[];
  gpuRefusals: string[];
  gpuBounds: string[];
  extensionApi: number;
  customPassApi: number;
  receiptMaxBytes: number;
  wgslMaxBytes: number;
  readyV2: Record<string, unknown> & { receipt: Record<string, unknown>; backend: Record<string, unknown> };
  stateV2: { lifecycle: string; safeArea: Record<string, number> };
  customPasses: { key: string; example: unknown[] };
  receiptSingular: Record<string, unknown>;
  receiptRenderSettings: Record<string, unknown>;
  render: {
    op: string;
    stateKey: string;
    captureKey: string;
    renderSettingsApi: number;
    unavailable: string;
    set: unknown;
    answer: Record<string, unknown>;
    status: Record<string, unknown>;
    provenance: Record<string, unknown>;
  };
};

describe("contract v2: the vocabularies are the wire's", () => {
  it("speaks protocol 2 and still accepts protocol 1, and nothing else", () => {
    assert.equal(NATIVE_PROTOCOL_V1, WIRE.protocol.v1);
    assert.equal(NATIVE_PROTOCOL_VERSION, WIRE.protocol.current);
    assert.deepEqual(NATIVE_PROTOCOL_VERSIONS, [WIRE.protocol.v1, WIRE.protocol.current]);
    for (const version of NATIVE_PROTOCOL_VERSIONS) assert.equal(isNativeProtocolVersion(version), true);
    for (const other of [0, 3, -1, 1.5, "1", "2", null, undefined, Number.NaN])
      assert.equal(isNativeProtocolVersion(other), false, String(other));
  });

  it("names the touch kind, its phases, the lifecycle, the wgpu backends and the receipt tier as the wire does", () => {
    assert.equal(NativeInputKind.Touch, WIRE.inputKind.touch);
    assert.deepEqual(Object.values(TouchPhase), WIRE.touchPhases);
    assert.deepEqual(Object.values(NativeLifecycle), WIRE.lifecycle);
    assert.deepEqual(NATIVE_WGPU_BACKENDS, WIRE.wgpuBackends);
    assert.equal(NativeGpuTier.Core, WIRE.receiptTier);
    assert.deepEqual(Object.values(NativeEnhancedFeature), WIRE.nativeEnhanced);
    assert.deepEqual(Object.values(NativeGpuBound), WIRE.gpuBounds);
    assert.equal(NATIVE_EXTENSION_API_VERSION, WIRE.extensionApi);
    assert.equal(NATIVE_CUSTOM_PASS_API_VERSION, WIRE.customPassApi);
    assert.equal(NATIVE_RECEIPT_MAX_BYTES, WIRE.receiptMaxBytes);
    assert.equal(NATIVE_WGSL_MAX_BYTES, WIRE.wgslMaxBytes);
  });

  it("the wgpu backends are NativeBackend members with no GL among them, and the raylib backends stay", () => {
    const backends = new Set<string>(Object.values(NativeBackend));
    for (const backend of NATIVE_WGPU_BACKENDS) assert.ok(backends.has(backend), backend);
    for (const gl of ["gl", "gles", "opengl", "webgl", "webgl2", "metal-angle"])
      assert.equal((NATIVE_WGPU_BACKENDS as readonly string[]).includes(gl), false, gl);
    // v1 games keep reporting these (characterization).
    for (const v1 of ["metal-angle", "d3d11-angle", "vulkan-angle", "webgl2", "unknown"])
      assert.ok(backends.has(v1), v1);
  });

  it("the GPU refusals are run refusals, the capture-time ones are op errors, and capture's bound is the refusal's", () => {
    const refusals = new Set<string>(Object.values(NativeRefusal));
    for (const code of WIRE.gpuRefusals) assert.ok(refusals.has(code), code);
    assert.equal(NativeOpError.DeviceLost, NativeRefusal.DeviceLost);
    assert.equal(NativeOpError.GpuHang, NativeRefusal.GpuHang);
    assert.equal(NativeGpuBound.CaptureTooLarge, NativeRefusal.CaptureTooLarge);
  });
});

describe("the renderer's quality on the wire (renderSettings, volatile.render, capture provenance)", () => {
  const render = WIRE.render;

  it("names the verb, the volatile and capture key, the verb's version and its unavailable answer as the wire does", () => {
    assert.equal(NativeOp.RenderSettings, render.op);
    assert.equal(NATIVE_RENDER_KEY, render.stateKey);
    assert.equal(NATIVE_RENDER_KEY, render.captureKey);
    assert.equal(NATIVE_RENDER_SETTINGS_API_VERSION, render.renderSettingsApi);
    assert.equal(NativeOpError.Unavailable, render.unavailable);
  });

  it("accepts the wire's renderSettings answer and copies it field by field", () => {
    assert.equal(isNativeResult(NativeOp.RenderSettings, render.answer, NATIVE_PROTOCOL_VERSION), true);
    assert.deepEqual(parseRenderSettingsAnswer({ ...render.answer, extra: 1 }), render.answer);
  });

  it("reads the wire's volatile.render, and nothing from a state without one or one outside its shape", () => {
    assert.deepEqual(nativeRenderStatus({ volatile: { [NATIVE_RENDER_KEY]: render.status } }), render.status);
    for (const state of [
      {},
      { volatile: {} },
      { volatile: { [NATIVE_RENDER_KEY]: { ...render.status, preset: "auto" } } },
      { volatile: { [NATIVE_RENDER_KEY]: { ...render.status, degraded: [{ reason: "slow", subject: null }] } } },
      { volatile: { [NATIVE_RENDER_KEY]: { ...render.status, gpuMs: -1 } } },
    ])
      assert.equal(nativeRenderStatus(state), null, JSON.stringify(state));
  });

  it("a capture may carry the wire's provenance; one outside its shape refuses the reply", () => {
    const capture = { seq: 0, width: 64, height: 64, format: "bgra8", digest: "0123456789abcdef" };
    assert.equal(isNativeResult(NativeOp.Capture, capture), true, "a capture without provenance (C++, pre-RQ0)");
    assert.equal(isNativeResult(NativeOp.Capture, { ...capture, render: render.provenance }), true);
    for (const provenance of [
      { ...render.provenance, settingsSource: "saved" },
      { ...render.provenance, settleFrames: 0 },
      { ...render.provenance, exposure: "adapted" },
      { ...render.provenance, preset: "auto" },
      null,
    ])
      assert.equal(
        isNativeResult(NativeOp.Capture, { ...capture, render: provenance }),
        false,
        JSON.stringify(provenance),
      );
  });

  it("an old receipt (singular API fields only) and a new one parse; the old one serves [extensionApi]", () => {
    const old = parseNativeCapabilityReceipt(WIRE.receiptSingular);
    assert.deepEqual(old, WIRE.receiptSingular);
    assert.ok(old);
    assert.deepEqual(receiptExtensionApis(old), [old.extensionApi]);
    assert.deepEqual(receiptCustomPassApis(old), [old.customPassApi]);
    assert.equal(receiptServesRenderSettings(old), false);
    const fresh = parseNativeCapabilityReceipt(WIRE.receiptRenderSettings);
    assert.deepEqual(fresh, WIRE.receiptRenderSettings);
    assert.ok(fresh);
    assert.equal(receiptServesRenderSettings(fresh), true);
    assert.equal(receiptServesRenderSettings(null), false);
  });

  it("refuses a receipt whose renderer fields are outside their shape", () => {
    const base = WIRE.receiptRenderSettings;
    for (const row of [
      { ...base, extensionApis: [2] },
      { ...base, extensionApis: [1, 1] },
      { ...base, extensionApis: [] },
      { ...base, customPassApis: [0, 1] },
      { ...base, rendererFeatures: ["timestamp-query", "timestamp-query"] },
      { ...base, rendererFeatures: ["ray-query"] },
      { ...base, renderInputs: ["pixels"] },
      { ...base, renderSettingsApi: 0 },
      { ...base, renderSettingsApi: "1" },
    ])
      assert.equal(parseNativeCapabilityReceipt(row), null, JSON.stringify(row));
  });
});

describe("contract v2: custom passes in state()", () => {
  it("reads volatile.customPasses under the wire's key, each pass with its stage, whether it runs and its code", () => {
    assert.equal(NATIVE_CUSTOM_PASSES_KEY, WIRE.customPasses.key);
    const state = { volatile: { fps: 60, [NATIVE_CUSTOM_PASSES_KEY]: WIRE.customPasses.example } };
    assert.deepEqual(nativeCustomPasses(state), WIRE.customPasses.example);
    assert.equal(nativeCustomPasses(state)?.[0]?.code, NativeRefusal.GpuPassInvalid);
    assert.deepEqual(nativeCustomPasses({ volatile: { fps: 60 } }), [], "a game without passes lists none");
  });

  it("refuses a list outside its shape", () => {
    const rows: unknown[] = [
      "glow",
      [{ name: "glow", stage: "post", running: "no", code: null }],
      [{ name: "glow", stage: "post", running: false, code: 7 }],
      [{ name: "x".repeat(300), stage: "post", running: true, code: null }],
    ];
    for (const listed of rows)
      assert.equal(
        nativeCustomPasses({ volatile: { [NATIVE_CUSTOM_PASSES_KEY]: listed } }),
        null,
        JSON.stringify(listed),
      );
  });
});

describe("contract v2: touch input", () => {
  const touch = { type: NativeInputKind.Touch, phase: TouchPhase.Start, id: 3, x: 120.5, y: -4 };

  it("takes start, move and end with an id and world coordinates, copied with only those fields", () => {
    const actions = Object.values(TouchPhase).map((phase) => ({ ...touch, phase, pressure: 0.4 }));
    assert.deepEqual(
      parseNativeInput(actions),
      Object.values(TouchPhase).map((phase) => ({ ...touch, phase })),
    );
    assert.deepEqual(parseNativeInput([{ ...touch, id: 0xffff_ffff }]), [{ ...touch, id: 0xffff_ffff }]);
  });

  it("keeps px: true on a touch Live gives in ring pixels (the game maps it through the letterbox); any other px is dropped", () => {
    assert.deepEqual(parseNativeInput([{ ...touch, px: true }]), [{ ...touch, px: true }]);
    for (const px of [false, 1, "true", null])
      assert.deepEqual(parseNativeInput([{ ...touch, px }]), [touch], String(px));
  });

  it("refuses the whole list for a touch outside its shape, and for one action too many", () => {
    const { id: _id, ...noId } = touch;
    const { x: _x, ...noX } = touch;
    const rows: unknown[] = [
      { ...touch, x: Number.NaN },
      { ...touch, y: Number.POSITIVE_INFINITY },
      { ...touch, x: "1" },
      noX,
      noId,
      { ...touch, id: null },
      { ...touch, id: -1 },
      { ...touch, id: 1.5 },
      { ...touch, id: 2 ** 32 },
      { ...touch, id: "3" },
      { ...touch, phase: "cancel" },
      { ...touch, phase: undefined },
      { ...touch, phase: "Start" },
    ];
    for (const row of rows) {
      assert.equal(parseNativeInput([row]), null, JSON.stringify(row));
      assert.equal(parseNativeInput([touch, row]), null, `after a good one: ${JSON.stringify(row)}`);
    }
    assert.equal(parseNativeInput(Array.from({ length: NATIVE_INPUT_ACTIONS_MAX }, () => touch))?.length, 5000);
    assert.equal(parseNativeInput(Array.from({ length: NATIVE_INPUT_ACTIONS_MAX + 1 }, () => touch)), null);
  });
});

describe("contract v2: state() carries lifecycle and safe area", () => {
  const state = { phase: "play", ...WIRE.stateV2 };

  it("a v2 game's state needs a known lifecycle and a whole safe area", () => {
    assert.equal(isNativeResult(NativeOp.State, state, NATIVE_PROTOCOL_VERSION), true);
    for (const lifecycle of Object.values(NativeLifecycle))
      assert.equal(isNativeResult(NativeOp.State, { ...state, lifecycle }, NATIVE_PROTOCOL_VERSION), true, lifecycle);
    const { lifecycle: _lifecycle, ...noLifecycle } = state;
    const { safeArea: _safeArea, ...noSafeArea } = state;
    const area = { top: 0, left: 0, bottom: 0, right: 0 };
    const bad: unknown[] = [
      {},
      noLifecycle,
      noSafeArea,
      { ...state, lifecycle: "background" },
      { ...state, lifecycle: 1 },
      { ...state, safeArea: null },
      { ...state, safeArea: [] },
      { ...state, safeArea: { ...area, top: -1 } },
      { ...state, safeArea: { ...area, left: 1.5 } },
      { ...state, safeArea: { ...area, right: Number.NaN } },
      { ...state, safeArea: { top: 0, left: 0, bottom: 0 } },
      { ...state, safeArea: { ...area, bottom: 1e9 } },
    ];
    for (const row of bad)
      assert.equal(isNativeResult(NativeOp.State, row, NATIVE_PROTOCOL_VERSION), false, JSON.stringify(row));
  });

  it("a v1 game's state is checked as before (characterization): any object", () => {
    for (const v1 of [{}, { phase: "play" }, { lifecycle: "nonsense" }]) {
      assert.equal(isNativeResult(NativeOp.State, v1), true, JSON.stringify(v1));
      assert.equal(isNativeResult(NativeOp.State, v1, NATIVE_PROTOCOL_V1), true, JSON.stringify(v1));
    }
    for (const op of Object.values(NativeOp))
      for (const good of RESULTS[op].good)
        if (op !== NativeOp.State) assert.equal(isNativeResult(op, good, NATIVE_PROTOCOL_VERSION), true, op);
  });
});

describe("contract v2: ready carries the capability receipt", () => {
  const ready = WIRE.readyV2;
  const receipt = ready.receipt;

  it("a Rust game's ready is copied with its receipt", () => {
    const parsed = parseNativeEvent({ ...ready, extra: 1, receipt: { ...receipt, unknown: true } });
    assert.deepEqual(parsed, ready);
    assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < NATIVE_RECEIPT_MAX_BYTES);
  });

  it("a v1 game's ready is unchanged: no receipt, the raylib backends, a receipt it sends is dropped", () => {
    const v1 = {
      event: NativeEvent.Ready,
      nonce: "n-1",
      protocol: NATIVE_PROTOCOL_V1,
      contractVersion: 1,
      build: "raylib-6.0/macos/window",
      backend: { api: NativeBackend.Unknown, device: null },
      size: { width: 640, height: 360 },
      seed: 1,
    };
    assert.deepEqual(parseNativeEvent(v1), v1);
    assert.deepEqual(parseNativeEvent({ ...v1, receipt }), v1);
    const angle = { ...v1, backend: { api: NativeBackend.MetalAngle, device: "Apple M4 Max" } };
    assert.deepEqual(parseNativeEvent(angle), angle);
  });

  it("refuses a v2 ready without a receipt, with a GL or ANGLE backend, a tier other than core or a receipt outside its shape", () => {
    const { receipt: _receipt, ...noReceipt } = ready;
    const rows: unknown[] = [
      noReceipt,
      { ...ready, receipt: null },
      { ...ready, receipt: [] },
      { ...ready, receipt: { ...receipt, backend: "gl" } },
      { ...ready, receipt: { ...receipt, backend: NativeBackend.MetalAngle } },
      { ...ready, receipt: { ...receipt, backend: NativeBackend.WebGl2 } },
      { ...ready, backend: { api: NativeBackend.MetalAngle, device: null } },
      { ...ready, backend: { api: NativeBackend.Unknown, device: null } },
      // The game's `backend.api` and its receipt name the same backend.
      { ...ready, backend: { api: NativeBackend.Vulkan, device: null } },
      { ...ready, receipt: { ...receipt, tier: "downlevel" } },
      { ...ready, receipt: { ...receipt, tier: "native-enhanced" } },
      { ...ready, receipt: { ...receipt, tier: undefined } },
      { ...ready, receipt: { ...receipt, nativeEnhanced: ["webgl"] } },
      { ...ready, receipt: { ...receipt, nativeEnhanced: ["subgroup", "subgroup"] } },
      { ...ready, receipt: { ...receipt, nativeEnhanced: "subgroup" } },
      { ...ready, receipt: { ...receipt, adapter: 7 } },
      { ...ready, receipt: { ...receipt, adapter: "x".repeat(257) } },
      { ...ready, receipt: { ...receipt, extensionApi: 0 } },
      { ...ready, receipt: { ...receipt, extensionApi: 1.5 } },
      { ...ready, receipt: { ...receipt, customPassApi: undefined } },
      { ...ready, receipt: { ...receipt, customPassApi: -1 } },
    ];
    for (const row of rows) assert.equal(parseNativeEvent(row), null, JSON.stringify(row).slice(0, 300));
  });

  it("refuses a receipt past its own size cap before reading any field", () => {
    const padded = { ...receipt, padding: "x".repeat(NATIVE_RECEIPT_MAX_BYTES) };
    assert.equal(parseNativeCapabilityReceipt(padded), null);
    assert.equal(parseNativeEvent({ ...ready, receipt: padded }), null);
    // Multi-byte text counts in UTF-8 bytes, not characters.
    const wide = { ...receipt, padding: "é".repeat(NATIVE_RECEIPT_MAX_BYTES / 2) };
    assert.equal(parseNativeCapabilityReceipt(wide), null);
    assert.deepEqual(parseNativeCapabilityReceipt(receipt), receipt);
  });

  it("a ready that names a protocol this host does not speak still parses; the port refuses it by version", () => {
    const v3 = { ...ready, protocol: 3 };
    const parsed = parseNativeEvent(v3);
    assert.ok(parsed && parsed.event === NativeEvent.Ready);
    assert.equal(isNativeProtocolVersion(parsed.protocol), false);
  });
});

describe("the boot's stages are the wire's", () => {
  it("names every stage genex-studio's `starting` and the web shell's progress carry, in boot order", () => {
    assert.deepEqual(Object.values(BootStage), WIRE.bootStages);
  });
});
