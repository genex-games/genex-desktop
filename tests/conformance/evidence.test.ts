/**
 * The evidence pass — three rules:
 *
 *  1. A capture that raced the compositor (stale frame wearing another camera's label) gets ONE
 *     retake before the duplicate guard may call debugCamera dead — 10 of 36 iterations died to
 *     that race, plus the run's final verdict.
 *  2. Cameras and demos the game declares are photographed too, so behaviour off the fixed trio
 *     (a bench sit, a hero prop) can become the biggest gap instead of never being seen.
 *  3. "Not judgeable" must distinguish a broken build from a broken camera: only observation-layer
 *     failures may be forgiven at run scope.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import vm from "node:vm";
import {
  classifyEvidenceFailure,
  EMPTY_SCENE_PROBE,
  gatherEvidence,
  MISSING_CONTRACT,
  proveStep,
  STEP_WITNESS,
  withObservationPatience,
} from "../../src/harness-seed/loop/gauntlet.ts";
import { observationOnlyFailure } from "../../src/harness-seed/loop/autopilot.ts";
import { demosNamedByChecks, HARNESS_CHECKS, withHarnessChecks } from "../../src/harness-seed/loop/spec.ts";
import type { Check } from "../../src/harness-seed/loop/spec.ts";
import { evaluateProbeCheck, evaluateSceneCheck, sceneCheckExpression } from "../../src/harness-seed/loop/checks.ts";
import {
  criticFor,
  cruiseFor,
  gameLine,
  inputProbesFor,
  KIND_NAMES,
  normalizeGameTraits,
  playScriptFor,
  readDeclaredGame,
  startKeysFor,
  wantsEyeCameras,
  writeDeclaredGame,
} from "../../src/harness-seed/loop/kinds.ts";
import { applyPlayScript, CONTROL_EXERCISE } from "../../src/harness-seed/loop/play-script.ts";
import { applySetup, EvidenceFailure, patientEvidence } from "../../src/harness-seed/loop/evidence.ts";
import { FlowPhase as HarnessFlowPhase } from "../../src/harness-seed/loop/page-contract.ts";
import { FlowPhase as TemplateFlowPhase } from "../../src/game-template/src/studio.js";
import { PreviewConsoleSource } from "../../src/harness-seed/loop/preview-gone.ts";
import { blindCompare } from "../../src/harness-seed/loop/judge.ts";
import { facetPrompt } from "../../src/harness-seed/loop/facet/prompt.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

interface StubOptions {
  /** Base64 payload per screenshot call, in order; repeats simulate a stale compositor frame. */
  frames: string[];
  cameras?: unknown;
  demos?: unknown;
  /** What the page logged: `error` entries are the ones a build is judged on. */
  console?: Array<{ level: string; message: string; source?: string }>;
  /** What `preview.ready` answers. `null` is an older studio that has no such host call. */
  ready?: Record<string, unknown> | null;
  /** What `preview.pageUi` answers. Absent is a studio that cannot see outside the canvas. */
  pageUi?: Record<string, unknown> | null;
  /** The user:view-vs-canvas diff fraction; `null` means it could not be computed. */
  diff?: number | null;
  /** The step witness, read three times per pass. `null` is a page with no studio clock. */
  witness?: ((tick: number) => unknown) | null;
  /** Pixel stats per shot, in screenshot order. */
  stats?: Array<Record<string, unknown> | null>;
  /** What the n-th `preview.state` answers (1-based); absent is a small state with the frame. */
  state?: (call: number) => unknown;
  /** What `debugCamera` answers; the default registers every name asked for. */
  debugCamera?: (name: string) => unknown;
  /** What surface the port says it PHOTOGRAPHED; absent is a port that does not say. */
  shotSurface?: (payload: Record<string, unknown>) => string | undefined;
  /** Return a message to make that screenshot throw. */
  failShot?: (payload: Record<string, unknown>) => string | null;
  /** A message to make the console read throw — the one call outside the drive block's catch. */
  failConsole?: string;
  /** Answers for `preview.evaluate` that are not the step witness. */
  evaluate?: (expression: string) => unknown;
  /** What `preview.status` answers beyond a healthy page; a function answers the n-th read (1-based). */
  status?: Record<string, unknown> | ((call: number) => Record<string, unknown>);
  /** A page verb's own answer (`preview.call`); `undefined` falls through to the stub's. */
  page?: (method: string, arg: unknown) => unknown;
  /** What the page does with each `preview.input` batch. */
  input?: (actions: Array<Record<string, unknown>>) => void;
}

const READY_NOW = {
  ready: true,
  ms: 0,
  pageMs: 0,
  timedOut: false,
  budgetMs: 15_000,
  via: "shim",
  phase: "ready",
  reason: null,
  polls: 1,
  gesture: { needed: false, done: false, reasons: [] },
};

function stubCtx(options: StubOptions) {
  let shotIndex = 0;
  let tick = 0;
  let stateCalls = 0;
  let statusCalls = 0;
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const ctx = {
    cancelled: false,
    setStatus: () => {},
    call: async (method: string, payload: Record<string, unknown> = {}) => {
      calls.push({ method, payload });
      switch (method) {
        case "preview.reload":
        case "preview.load":
          return {};
        case "preview.ready":
          if (options.ready === null) throw new Error("no such host call: preview.ready");
          return { ...READY_NOW, ...(options.ready ?? {}) };
        case "preview.pageUi":
          if (!options.pageUi) throw new Error("no such host call: preview.pageUi");
          return options.pageUi;
        case "preview.diff":
          return options.diff === undefined
            ? { compared: 1_000, diffFraction: 0 }
            : options.diff === null
              ? { compared: 0 }
              : { compared: 1_000, diffFraction: options.diff };
        case "preview.status": {
          statusCalls++;
          const status = typeof options.status === "function" ? options.status(statusCalls) : options.status;
          return { loadError: null, crashed: false, ...(status ?? {}) };
        }
        case "preview.state":
          stateCalls++;
          return options.state ? options.state(stateCalls) : { version: 1, frame: shotIndex };
        case "preview.gesture":
          return { knocked: true, trusted: null };
        case "preview.input":
          options.input?.((payload.actions ?? []) as Array<Record<string, unknown>>);
          return { ok: true, applied: 1, width: 800, height: 600 };
        case "preview.console":
          if (options.failConsole) throw new Error(options.failConsole);
          return options.console ?? [];
        case "preview.gpuErrors":
          return [];
        case "preview.evaluate": {
          const expression = String(payload.expression);
          if (expression.includes("studio step witness")) {
            tick++;
            if (options.witness === null) return null;
            return options.witness
              ? options.witness(tick)
              : {
                  steppedFrames: tick * 8,
                  drawCalls: tick * 40,
                  now: tick * 320,
                  canvas: true,
                  simulatedMs: tick * 320,
                };
          }
          return options.evaluate ? options.evaluate(expression) : false;
        }
        case "preview.screenshot": {
          const failure = options.failShot?.(payload);
          if (failure) throw new Error(failure);
          const base64 = options.frames[Math.min(shotIndex, options.frames.length - 1)];
          const stats = options.stats?.[Math.min(shotIndex, options.stats.length - 1)] ?? null;
          shotIndex++;
          const surface = options.shotSurface?.(payload);
          return {
            base64,
            bytes: base64.length,
            path: `/runs/shots/${shotIndex}.jpg`,
            stats,
            ...(surface ? { surface } : {}),
          };
        }
        case "preview.call": {
          const m = payload.method;
          const own = options.page?.(String(m), payload.arg);
          if (own !== undefined) return own;
          if (m === "cameras") return options.cameras ?? { ok: false };
          if (m === "demos") return options.demos ?? { ok: false };
          if (m === "demo") return { ok: true, demo: payload.arg, result: { done: true } };
          if (m === "debugCamera" && options.debugCamera) return options.debugCamera(String(payload.arg));
          return { ok: true };
        }
        default:
          return {};
      }
    },
  };
  return { ctx, calls };
}

const run = { runId: "run_test", project: "proj" };

/** The .mjs destructure makes TS see every option as required; the loop passes them optionally. */
function gather(ctx: unknown, extra: Record<string, unknown> = {}) {
  return gatherEvidence(ctx as never, { run, iterationId: "001", seed: 1, ...extra } as never);
}

/** Every camera the pass photographed, in order — the demo and user frames included. */
function cameraList(evidence: { shots: Array<{ camera: string }> }): string[] {
  return evidence.shots.map((shot) => shot.camera);
}

describe("gatherEvidence after the stale-frame run", () => {
  it("retakes a duplicate frame once and accepts the fresh one — the race costs a retake, not the iteration", async () => {
    // Capture order: default=A, close=A (stale!), retake close=B, wide=C.
    const { ctx } = stubCtx({ frames: ["AAAA", "AAAA", "BBBB", "CCCC"] });
    const evidence = await gather(ctx);
    assert.equal(evidence.ok, true, `problems: ${evidence.problems.join("; ")}`);
    assert.deepEqual(
      evidence.shots.map((shot: { camera: string }) => shot.camera),
      ["default", "close", "wide"],
    );
    assert.equal(evidence.shots[1].base64, "BBBB");
  });

  it("every camera identical is a dead cameras contract — a build failure, never an outage", async () => {
    // Two DECLARED viewpoints: the floor's own guesses cannot indict a game that never claimed
    // to have more than one camera, so the verdict is read off what the game declares.
    const { ctx } = stubCtx({ frames: ["AAAA", "AAAA", "AAAA", "AAAA"], cameras: ["default", "close", "wide"] });
    const evidence = await gather(ctx);
    assert.equal(evidence.ok, false);
    assert.ok(evidence.problems.some((p: string) => p.includes("every camera returned the same frame")));
    // Page-side captures are fresh per call, so this must reach the builder as a gap to fix —
    // the outage path once held a finished panelka on this signal until teardown deleted it.
    assert.equal(observationOnlyFailure(evidence.problems), false);
  });

  it("one duplicated camera is a warning, not a voided challenger", async () => {
    // default=A, close=A, retake close=A (genuinely wired to the same view), wide=C.
    const { ctx } = stubCtx({ frames: ["AAAA", "AAAA", "AAAA", "CCCC"], cameras: ["default", "close", "wide"] });
    const evidence = await gather(ctx);
    assert.equal(evidence.ok, true, `problems: ${evidence.problems.join("; ")}`);
    assert.ok(evidence.warnings.some((w: string) => w.includes("close camera returned the same frame")));
  });

  it("photographs declared cameras and demos, and demos run after the main shots", async () => {
    const { ctx, calls } = stubCtx({
      frames: ["AAAA", "BBBB", "CCCC", "DDDD", "EEEE"],
      cameras: ["default", "close", "wide", "bench"],
      demos: ["sit-on-bench"],
    });
    const evidence = await gather(ctx);
    assert.equal(evidence.ok, true, `problems: ${evidence.problems.join("; ")}`);
    assert.deepEqual(
      evidence.shots.map((shot: { camera: string }) => shot.camera),
      ["default", "close", "wide", "bench", "demo:sit-on-bench"],
    );
    assert.deepEqual(evidence.demos, { "sit-on-bench": { ok: true, demo: "sit-on-bench", result: { done: true } } });
    // The state each demo leaves behind, so a probe scoped to a demo reads the number the demo
    // drove rather than the sample taken before any demo ran.
    const demoStates = (evidence.demoStates ?? {}) as Record<string, unknown>;
    assert.deepEqual(Object.keys(demoStates), ["sit-on-bench"]);
    assert.notDeepEqual(demoStates["sit-on-bench"], evidence.state);
    // The demo mutates game state toward its end frame, so it must run after every camera shot.
    const sequence = calls
      .filter((c) => c.method === "preview.call" && ["debugCamera", "demo"].includes(String(c.payload.method)))
      .map((c) => `${c.payload.method}:${c.payload.arg}`);
    assert.equal(sequence.at(-1), "demo:sit-on-bench");
  });

  it("every check-named demo runs; the cap applies only to the unreferenced remainder", async () => {
    const { ctx, calls } = stubCtx({
      frames: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
      cameras: ["default"],
      demos: ["one", "two", "three", "four", "five"],
    });
    // The loop names the required demos with demosNamedByChecks — a probe scoped to a demo
    // counts, or the cap would drop the demo and leave its check permanently unmeasured.
    const requiredDemos = demosNamedByChecks([{ kind: "probe", demo: "five", expr: "state.done > 0" }] as never);
    assert.deepEqual(requiredDemos, ["five"]);
    // A cap of three, named: the default is DEMOS_PER_LOOK (the judges' evidence, below).
    const evidence = await gatherEvidence(
      ctx as never,
      {
        run,
        iterationId: "001",
        seed: 1,
        requiredDemos,
        maxDemos: 3,
      } as never,
    );
    const ran = calls
      .filter((c) => c.method === "preview.call" && c.payload.method === "demo")
      .map((c) => c.payload.arg);
    assert.deepEqual(ran, ["five", "one", "two", "three"], "the required demo first, then three unreferenced ones");
    assert.deepEqual(evidence.registeredDemos, ["one", "two", "three", "four", "five"]);
    assert.deepEqual(evidence.skippedDemos, ["four"]);
    assert.ok((evidence.demos as Record<string, { ok?: boolean }>).five?.ok);
  });

  it("the early state is sampled before the scripted controls, so probe deltas measure them", async () => {
    const { ctx, calls } = stubCtx({ frames: ["a", "b", "c"], cameras: ["default"] });
    await gather(ctx);
    const order = calls
      .map((c) => (c.method === "preview.state" ? "state" : c.method === "preview.input" ? "input" : null))
      .filter(Boolean);
    assert.equal(order[0], "state", "first state sample precedes any input");
    assert.ok(order.includes("input"));
    assert.equal(order.at(-1), "state", "the late sample comes after the controls");
  });

  it("a state the studio bounded flows through the pass, and keys-move-player is measured over it", async () => {
    // AUDIT-STATE-STUB: what the host's bounder hands back — the HUD list a stub, the player whole.
    const bounded = (call: number) => ({
      player: { x: call, z: 0, yaw: 0 },
      hud: { items: { __elided: "array", length: 6000, chars: 168_001 }, crosshair: true },
      __cut: { chars: 177_640, paths: ["hud.items"] },
    });
    const { ctx } = stubCtx({ frames: ["a", "b", "c"], cameras: ["default"], state: bounded });
    const evidence = (await gather(ctx)) as never as Parameters<typeof evaluateProbeCheck>[1];
    const keysMove = withHarnessChecks({ id: "f", checks: [] as Check[], cameras: [] }, {
      ownsMain: true,
      game: { keyboardMove: true },
    } as never).checks.find((check: { id: string }) => check.id === "keys-move-player") as Check;
    const outcome = evaluateProbeCheck(keysMove, evidence);
    assert.equal(outcome.pass, true, outcome.reason);
    assert.equal(outcome.stateTooLarge, undefined);
    const listed = evaluateProbeCheck({ id: "hud", kind: "probe", expr: "len(hud.items) == 6000" }, evidence);
    assert.equal(listed.pass, true, listed.reason);
  });

  it("the final pass can add the user's-eye frame: a compositor capture labelled user:view", async () => {
    const { ctx, calls } = stubCtx({ frames: ["a", "b", "c", "d"], cameras: ["default"], diff: 0.4 });
    const evidence = await gatherEvidence(
      ctx as never,
      { run, iterationId: "final", seed: 1, userView: true } as never,
    );
    assert.ok(evidence.shots.some((s: { camera: string }) => s.camera === "user:view"));
    assert.equal(evidence.shots.find((s: { camera: string }) => s.camera === "user:view")!.surface, "page");
    const pageShot = calls.find((c) => c.method === "preview.screenshot" && c.payload.page === true);
    assert.ok(pageShot, "the user view is captured with page: true");
    assert.match(String(pageShot!.payload.label), /user-view/);
  });

  /**
   * The run of run_fixture123456: the base logged one shader error under three r185, and every
   * pass that did not know it was inherited — four first-round iterations, every director judge,
   * the health passes, the close — answered "the build does not run: 1 console error(s)".
   */
  it("an error the build inherited is a warning; only one this build introduced voids it", async () => {
    const shader = "THREE.WebGLProgram: shader error VALIDATE_STATUS false";
    const inherited = await gatherEvidence(
      stubCtx({
        frames: ["a", "b", "c"],
        console: [
          { level: "error", message: shader },
          { level: "warn", message: "deprecated" },
        ],
      }).ctx as never,
      { run, iterationId: "001", seed: 1, inheritedConsole: [shader] } as never,
    );
    assert.equal(inherited.ok, true, `problems: ${inherited.problems.join("; ")}`);
    assert.match(inherited.warnings.join(" "), /1 console error\(s\) inherited from the build this one started from/);
    assert.match(
      inherited.warnings.join(" "),
      /VALIDATE_STATUS/,
      "and it names the error, so somebody can still own it",
    );

    const fresh = await gatherEvidence(
      stubCtx({
        frames: ["a", "b", "c"],
        console: [
          { level: "error", message: shader },
          { level: "error", message: "Uncaught TypeError: bins.forEach is not a function" },
        ],
      }).ctx as never,
      { run, iterationId: "002", seed: 1, inheritedConsole: [shader] } as never,
    );
    assert.equal(fresh.ok, false);
    assert.deepEqual(fresh.problems, ["1 console error(s)"], "the one the diff introduced, not the two on screen");
  });

  it("the baseline carries every message, not the five a prompt shows", async () => {
    const logged = Array.from({ length: 8 }, (_, i) => ({ level: "error", message: `boot error ${i}` }));
    const first = await gatherEvidence(
      stubCtx({ frames: ["a", "b", "c"], console: logged }).ctx as never,
      { run, iterationId: "001", seed: 1 } as never,
    );
    assert.equal(first.consoleErrors.length, 5, "a judge reads the last five");
    assert.deepEqual(
      first.consoleBaseline,
      logged.map((entry) => entry.message),
      "the baseline is all of them",
    );

    const next = (inheritedConsole: string[]) =>
      gatherEvidence(
        stubCtx({ frames: ["a", "b", "c"], console: logged }).ctx as never,
        { run, iterationId: "002", seed: 1, inheritedConsole } as never,
      );
    assert.equal((await next(first.consoleBaseline)).ok, true, "nothing new was introduced");
    const truncated = await next(first.consoleErrors);
    assert.equal(truncated.ok, false, "a baseline of five forgives five: the other three read as this build's");
    assert.deepEqual(truncated.problems, ["3 console error(s)"]);
  });

  it("a game predating cameras()/demos() yields the classic trio untouched", async () => {
    const { ctx } = stubCtx({ frames: ["AAAA", "BBBB", "CCCC"] });
    const evidence = await gather(ctx);
    assert.equal(evidence.ok, true);
    assert.equal(evidence.shots.length, 3);
    assert.equal(evidence.demos, null);
  });
});

describe("observationOnlyFailure — a broken camera is not a broken build", () => {
  it("forgives pure observation failures", () => {
    assert.equal(
      observationOnlyFailure(["screenshot(close) failed: UnknownVizError", "screenshot(wide) failed: UnknownVizError"]),
      true,
    );
  });

  it("forgives the occluded window — every capture failing on a missing display surface", () => {
    // The failure mode that cost a run all three first-iteration builds: window covered,
    // compositor parked, every camera blind while the game itself ran fine.
    assert.equal(
      observationOnlyFailure([
        "screenshot(default) failed: Current display surface not available for capture",
        "screenshot(close) failed: Current display surface not available for capture",
      ]),
      true,
    );
  });

  it("never forgives a build that itself failed, even alongside camera trouble", () => {
    assert.equal(observationOnlyFailure(["the renderer crashed"]), false);
    assert.equal(
      observationOnlyFailure([
        "screenshot(wide) failed: UnknownVizError",
        "window.__studio is missing — the build cannot be judged",
      ]),
      false,
    );
    // Duplicate frames indict the build's camera wiring now that captures are page-rendered.
    assert.equal(
      observationOnlyFailure([
        "every camera returned the same frame — debugCamera switches nothing, the cameras contract is dead",
      ]),
      false,
    );
    assert.equal(observationOnlyFailure(["3 console error(s)"]), false);
    assert.equal(observationOnlyFailure(["every camera renders effectively black (<0.5% pixels above luma 8)"]), false);
  });

  it("an empty problem list is not an observation outage", () => {
    assert.equal(observationOnlyFailure([]), false);
  });
});

describe("withObservationPatience — a blind camera retries, a broken build does not", () => {
  const blind = {
    ok: false,
    problems: ["screenshot(default) failed: Current display surface not available for capture"],
    shots: [],
  };
  const crashed = { ok: false, problems: ["the renderer crashed"], shots: [] };
  const fine = { ok: true, problems: [], shots: [] };
  const ctx = { cancelled: false, setStatus: () => {} };

  it("retries an observation outage until the window comes back", async () => {
    const sequence = [blind, blind, fine];
    let calls = 0;
    const evidence = await withObservationPatience(ctx, async () => sequence[calls++], { delays: [1, 1, 1] });
    assert.equal(evidence.ok, true);
    assert.equal(calls, 3);
  });

  it("gives up after the backoff and returns the blind evidence", async () => {
    let calls = 0;
    const evidence = await withObservationPatience(ctx, async () => (calls++, blind), { delays: [1, 1] });
    assert.equal(evidence.ok, false);
    assert.equal(calls, 3);
  });

  it("never retries a genuinely broken build", async () => {
    let calls = 0;
    const evidence = await withObservationPatience(ctx, async () => (calls++, crashed), { delays: [1, 1, 1] });
    assert.equal(evidence.ok, false);
    assert.equal(calls, 1);
  });

  it("respects the deadline instead of sleeping past it", async () => {
    let calls = 0;
    const evidence = await withObservationPatience(ctx, async () => (calls++, blind), {
      delays: [60_000],
      deadline: Date.now() + 5,
    });
    assert.equal(calls, 1);
    assert.equal(evidence.ok, false);
  });
});

// ── the kind of game, and the controls the harness drives on it ────────────────────────────

describe("the kind a game declares, and what the harness assumes without one", () => {
  it("assumes nothing until something declares it", () => {
    assert.deepEqual(normalizeGameTraits(undefined), {
      kind: null,
      hud: false,
      mouseLook: false,
      keyboardMove: false,
      playScript: null,
    });
    assert.equal(KIND_NAMES.length, 8, "eight kinds, and a ninth is a change to the table");
    const topDown = normalizeGameTraits({ kind: "top-down" });
    assert.equal(topDown.hud, true, "a declared kind IS a declaration");
    assert.equal(topDown.keyboardMove, true);
    assert.equal(topDown.mouseLook, false, "a top-down game is not mouse-looked");
    // An explicit boolean beside the kind still wins, in both directions.
    assert.equal(normalizeGameTraits({ kind: "first-person", hud: false }).hud, false);
    assert.equal(normalizeGameTraits({ kind: "first-person", hud: false }).mouseLook, true);
    assert.equal(normalizeGameTraits({ kind: "static-board", hud: true }).hud, true);
    // The genres most likely to be real DOM or React UI keep it: no canvas-only screen rule.
    assert.equal(normalizeGameTraits({ kind: "static-board" }).hud, false);
    assert.equal(normalizeGameTraits({ kind: "free-camera" }).hud, false);
    assert.equal(normalizeGameTraits({ kind: "side-2d" }).hud, false);
    assert.equal(normalizeGameTraits({ kind: "nonsense" }).kind, null, "an unknown kind is no kind");
    // Null-safe: evidence is gathered from many places that have no declared game at all.
    assert.equal(playScriptFor(undefined), CONTROL_EXERCISE);
    assert.equal(playScriptFor(null), CONTROL_EXERCISE);
    assert.equal(playScriptFor({ kind: "static-board" })[0]!.type, "click");
    assert.deepEqual(playScriptFor({ playScript: [{ type: "tap", keys: ["x"] }] }), [{ type: "tap", keys: ["x"] }]);
  });

  it("gives every judge one sentence, and retracts [dead-input] for a game that cannot have it", () => {
    const topDown = gameLine({ kind: "top-down" });
    assert.ok(topDown.startsWith("GAME: a top-down game"), topDown);
    for (const path of ["player.x", "player.y", "player.z"])
      assert.match(topDown, new RegExp(path.replace(".", "\\.")));
    assert.match(topDown, /report \[dead-input\] only if those are unchanged/);
    // A board and a builder have no player the studio can measure. The retraction is the whole
    // point of the branch: an empty evidence list would invite the report it exists to prevent.
    for (const kind of ["static-board", "free-camera"]) {
      const line = gameLine({ kind });
      assert.match(line, /the artefact class \[dead-input\] does not apply — do not report it/, kind);
      assert.doesNotMatch(line, /player\./, kind);
    }
    assert.equal(gameLine(undefined), "", "an undeclared game tells the judge nothing about a kind");
    assert.match(
      gameLine({ kind: "first-person" }),
      /Before every judgement the harness drives the same controls: hold W for 1\.6s/,
    );
  });

  it("measures the input checks on the axes this kind actually moves on", () => {
    const evidence = { state: { player: { x: 0, y: 4 } }, stateEarly: { player: { x: 0, y: 0 } } };
    const probe = (expr: string) => evaluateProbeCheck({ id: "moved", kind: "probe", expr }, evidence);
    assert.equal(
      probe(inputProbesFor({ kind: "top-down" }).move.expr).pass,
      true,
      "the top-down axes see the move on y",
    );
    assert.equal(
      probe(inputProbesFor({ kind: "first-person" }).move.expr).pass,
      false,
      "the template's x/z see nothing here",
    );
    assert.equal(probe(inputProbesFor({ kind: "side-2d" }).move.expr).pass, true);
    // An undeclared game is still measured on the template's own axes, exactly as before.
    assert.equal(inputProbesFor(undefined).move.expr, "abs(delta('player.x')) > 0 || abs(delta('player.z')) > 0");
    assert.equal(inputProbesFor(undefined).look.expr, "abs(delta('player.yaw')) > 0.01");
    // "declare mouseLook: true" is the documented remedy for a mouse-steered racer, and a
    // remedy that silently drops the check is worse than no remedy.
    assert.match(inputProbesFor({ kind: "top-down", mouseLook: true }).look.expr, /player\.yaw/);
    assert.match(inputProbesFor({ kind: "flight" }).look.expr, /player\.pitch/);
    assert.match(inputProbesFor({ kind: "flight" }).look.expr, /player\.yaw/);
  });

  it("never passes an input check on a game that reports no player at all", () => {
    // `delta('player.x') != 0` reads undefined on a game with no player, and `undefined != 0`
    // is true: the identity check that proves ctx.keys reaches the game passed on a chess board
    // where no key reached anything. Every route to the fallback is covered here, because the
    // fallback is what an undeclared game and an axis-less kind both get.
    const board = { state: { board: { cells: 9 }, turn: 3 }, stateEarly: { board: { cells: 9 }, turn: 1 } };
    const games: Array<Record<string, unknown> | undefined> = [
      undefined,
      { hud: true, mouseLook: true, keyboardMove: true },
      { kind: "static-board", keyboardMove: true },
      { kind: "free-camera", keyboardMove: true },
    ];
    for (const game of games) {
      const probes = inputProbesFor(game);
      for (const which of ["move", "look"] as const) {
        const outcome = evaluateProbeCheck({ id: which, kind: "probe", expr: probes[which].expr }, board);
        assert.equal(outcome.pass, false, `${which} on ${JSON.stringify(game)}: ${probes[which].expr}`);
      }
    }
    // And the check the harness actually installs carries the fixed expression, at identity
    // weight, on the facet that owns main.js.
    const spec = withHarnessChecks({ id: "f", checks: [] as Check[], cameras: [] }, {
      ownsMain: true,
      game: { keyboardMove: true },
    } as never);
    const installed = spec.checks.find((check: { id: string }) => check.id === "keys-move-player");
    assert.ok(installed, JSON.stringify(spec.checks));
    assert.equal(installed.weight, "identity");
    // Never green: false when the expression is all there is to go on, unmeasured when the
    // check names the paths it needs and the build reports none of them.
    assert.notEqual(evaluateProbeCheck(installed, board).pass, true, installed.expr);
  });
});

describe("the harness's own checks on the result a player gets", () => {
  const harnessCheck = (id: string, options: Record<string, unknown>): Check | undefined =>
    withHarnessChecks({ id: "f", checks: [] as Check[], cameras: [] }, options as never).checks.find(
      (check: { id: string }) => check.id === id,
    );

  it("reaches-play: the game is in play after begin, and a game that reports no flow is not failed for it", () => {
    const check = harnessCheck("reaches-play", { ownsMain: true, game: { kind: "racing" } });
    assert.ok(check, "a keyboard-moved game's main owner carries reaches-play");
    assert.equal(check.weight, "identity");
    // Read off the early sample — the state reachPlay left, after begin and before the drive.
    const playing = { flow: { phase: "play", playing: true } };
    const countdown = { flow: { phase: "countdown", playing: false } };
    assert.equal(evaluateProbeCheck(check, { state: playing, stateEarly: playing }).pass, true);
    assert.equal(evaluateProbeCheck(check, { state: countdown, stateEarly: countdown }).pass, false);
    // A race that ends (or a player who dies) during the drive did reach play: begin worked.
    const results = { flow: { phase: "results", playing: false } };
    assert.equal(evaluateProbeCheck(check, { state: results, stateEarly: playing }).pass, true);
    const undeclared = evaluateProbeCheck(check, { state: { player: { x: 1 } } });
    assert.equal(undeclared.pass, null);
    assert.equal(undeclared.unavailable, true);
    // The integration facet owns the player too; any other part does not carry it.
    assert.ok(harnessCheck("reaches-play", { role: "integration", game: { kind: "first-person" } }));
    assert.equal(harnessCheck("reaches-play", { ownsMain: false, game: { kind: "first-person" } }), undefined);
    // A game with no keys and no mouse look has no "play" the harness drives into.
    assert.equal(harnessCheck("reaches-play", { ownsMain: true, game: { kind: "static-board" } }), undefined);
  });

  it("hud-coverage and hud-overlap read the HUD's own measurements, unmeasured on a HUD that takes none", () => {
    const coverage = harnessCheck("hud-coverage", { ownsMain: false, game: { kind: "racing" } });
    const overlap = harnessCheck("hud-overlap", { ownsMain: false, game: { kind: "racing" } });
    assert.ok(coverage && overlap);
    assert.equal(coverage.weight, "normal");
    assert.equal(evaluateProbeCheck(coverage, { state: { hud: { coverage: 0.35, overlaps: [] } } }).pass, false);
    assert.equal(evaluateProbeCheck(coverage, { state: { hud: { coverage: 0.1, overlaps: [] } } }).pass, true);
    assert.equal(evaluateProbeCheck(coverage, { state: { hud: { items: ["speed"] } } }).pass, null);
    assert.equal(evaluateProbeCheck(overlap, { state: { hud: { coverage: 0.1, overlaps: [] } } }).pass, true);
    const crowded = { state: { hud: { coverage: 0.1, overlaps: [["speedo", "radar"]] } } };
    assert.equal(evaluateProbeCheck(overlap, crowded).pass, false);
    assert.equal(evaluateProbeCheck(overlap, { state: { hud: { items: ["speed"] } } }).pass, null);
  });
});

describe("a check that says what it needs, and a page that cannot answer yet", () => {
  it("is unmeasured when the build reports no such path, in either scope", () => {
    const check = {
      id: "draws",
      kind: "probe",
      expr: "__render.drawCalls > 0",
      needs: ["__render.drawCalls", "__render.triangles"],
    };
    const blind = evaluateProbeCheck(check, { state: { frame: 3 }, stateEarly: { frame: 0 } });
    assert.equal(blind.pass, null, "nothing was measured, so nothing failed");
    assert.equal(blind.state, "unmeasured");
    assert.match(blind.reason, /__render\.drawCalls/);
    assert.match(blind.reason, /__render\.triangles/);
    const measured = evaluateProbeCheck(check, {
      state: { frame: 3, __render: { drawCalls: 12, triangles: 400 } },
      stateEarly: { frame: 0 },
    });
    assert.equal(measured.pass, true);
    // A counter created lazily exists late and not early: a delta over it compares a number
    // with nothing, which is not a failure of the build.
    const grew = { id: "score", kind: "probe", expr: "delta('score') > 0", needs: ["score"] };
    const lazy = evaluateProbeCheck(grew, { state: { score: 5 }, stateEarly: {} });
    assert.equal(lazy.pass, null);
    assert.match(lazy.reason, /early\.score/);
    assert.equal(evaluateProbeCheck(grew, { state: { score: 5 }, stateEarly: { score: 0 } }).pass, true);
    // A check that names nothing keeps today's behaviour exactly.
    assert.equal(
      evaluateProbeCheck({ id: "old", kind: "probe", expr: "has('player.x')" }, { state: { frame: 1 } }).pass,
      false,
    );
  });

  it("maps a page that reports inspect() unavailable to unmeasured, and a real error to a fail", async () => {
    // The page-side wrapper itself, run the way the page runs it.
    const inPage = (studio: unknown) =>
      new Function("window", `return ${sceneCheckExpression("count('hud') === 1")}`)({ __studio: studio });
    const unavailable = inPage({ inspect: () => ({ available: false, reason: "no renderer has drawn a frame yet" }) });
    assert.match(String(unavailable.__unavailable), /inspect\(\) is unavailable/);
    assert.match(String(unavailable.__unavailable), /no renderer has drawn a frame yet/);
    assert.equal(
      inPage({}).__error,
      "the build exposes no __studio.inspect() — install the v2 contract (scene/renderer helpers)",
    );

    const check = { id: "single-hud", kind: "scene", js: "count('hud') === 1", detail: "'hud objects'" };
    let details = 0;
    const answer = (payload: Record<string, unknown>) => ({
      cancelled: false,
      call: async () => {
        details++;
        return payload;
      },
    });
    const skipped = await evaluateSceneCheck(answer(unavailable) as never, check as never);
    assert.equal(skipped.pass, null);
    assert.equal(skipped.state, "unmeasured");
    assert.match(skipped.reason, /no renderer has drawn a frame yet/);
    assert.equal(details, 1, "an unavailable page is not asked again for a detail it cannot give");
    const broke = await evaluateSceneCheck(answer({ __error: "count is not a function" }) as never, check as never);
    assert.equal(broke.pass, false, "a real error still fails hard");
    assert.match(broke.reason, /count is not a function/);
  });
});

describe("the play script under the stepped clock", () => {
  const record = () => {
    const calls: Array<{ method: string; payload: Record<string, any> }> = [];
    return {
      calls,
      ctx: {
        cancelled: false,
        call: async (method: string, payload: Record<string, any> = {}) => (calls.push({ method, payload }), {}),
      },
    };
  };

  it("steps the clock for a wait, straddles a tap with a frame, and drags where a board is dragged", async () => {
    const { calls, ctx } = record();
    await applyPlayScript(
      ctx as never,
      [
        { type: "wait", ms: 500 },
        { type: "tap", keys: ["space"] },
        { type: "drag", fromX: 0.4, fromY: 0.6, x: 0.6, y: 0.4 },
      ],
      { clock: "step" },
    );
    // The game is paused: a wall-clock wait would advance nothing while the GAME line tells
    // the judge the game waited.
    assert.deepEqual(calls[0], { method: "preview.call", payload: { method: "step", arg: 500 } });
    assert.ok(
      !calls.some((c) => c.method === "preview.input" && c.payload.actions?.[0]?.type === "wait"),
      "no wall wait under the stepped clock",
    );
    const tap = calls.find((c) => c.method === "preview.input" && c.payload.actions?.[0]?.type === "tap")!;
    assert.equal(tap.payload.actions[0].stepMs, 48, "the press and the release straddle a frame");
    const drag = calls.find((c) => c.method === "preview.input" && c.payload.actions?.[0]?.type === "drag")!;
    assert.equal(drag.payload.actions[0].fromX, 0.4);
    assert.equal(drag.payload.actions[0].fromY, 0.6);
    assert.equal(drag.payload.actions[0].x, 0.6);
  });

  it("keeps the wall clock waiting on the wall", async () => {
    const { calls, ctx } = record();
    await applyPlayScript(
      ctx as never,
      [
        { type: "wait", ms: 20 },
        { type: "tap", keys: ["space"] },
      ],
      { clock: "wall" },
    );
    assert.deepEqual(calls[0].payload.actions, [{ type: "wait", ms: 20 }]);
    assert.equal(calls[1].payload.actions[0].stepMs, undefined, "a stepMs means nothing to a clock that runs itself");
  });

  it("drives every action type in order, on the lease, and keeps the screenshots it took", async () => {
    const calls: Array<{ method: string; payload: Record<string, any> }> = [];
    const ctx = {
      cancelled: false,
      call: async (method: string, payload: Record<string, any> = {}) => {
        calls.push({ method, payload });
        return method === "preview.screenshot" ? { base64: "AAAA" } : {};
      },
    };
    const script = [
      { type: "hold", key: "w", ms: 99_999 },
      { type: "look", dx: "12", dy: null },
      { type: "click", x: 0.5, y: 0.5, button: "left", px: true },
      { type: "move", x: 3, y: 4 },
      { type: "scroll", dx: 0, dy: 120 },
      { type: "step", ms: 1 },
      { type: "pause" },
      { type: "start" },
      { type: "camera" },
      { type: "camera", name: "top" },
      { type: "screenshot", camera: "side", label: "after" },
      { type: "fly" },
      null,
    ];
    const step = await applyPlayScript(ctx as never, script, { clock: "step", handle: "h1", runId: "r1" });
    assert.deepEqual(
      calls.map((c) => [c.method, c.payload]),
      [
        ["preview.input", { actions: [{ type: "down", keys: ["w"] }], handle: "h1" }],
        ["preview.call", { method: "step", arg: 8_000, handle: "h1" }],
        ["preview.input", { actions: [{ type: "up", keys: ["w"] }], handle: "h1" }],
        ["preview.input", { actions: [{ type: "look", dx: 12, dy: 0 }], handle: "h1" }],
        ["preview.call", { method: "step", arg: 48, handle: "h1" }],
        [
          "preview.input",
          { actions: [{ type: "click", x: 0.5, y: 0.5, button: "left", px: true, stepMs: 48 }], handle: "h1" },
        ],
        ["preview.call", { method: "step", arg: 48, handle: "h1" }],
        ["preview.input", { actions: [{ type: "move", x: 3, y: 4 }], handle: "h1" }],
        ["preview.input", { actions: [{ type: "scroll", dx: 0, dy: 120 }], handle: "h1" }],
        ["preview.call", { method: "step", arg: 16, handle: "h1" }],
        ["preview.call", { method: "pause", handle: "h1" }],
        ["preview.call", { method: "start", handle: "h1" }],
        ["preview.call", { method: "debugCamera", arg: "top", handle: "h1" }],
        ["preview.call", { method: "debugCamera", arg: "side", handle: "h1" }],
        ["preview.screenshot", { runId: "r1", label: "after", handle: "h1" }],
      ],
    );
    assert.deepEqual(step.images, [{ mimeType: "image/jpeg", data: "AAAA", label: "after" }]);
    calls.length = 0;
    await applyPlayScript(ctx as never, [{ type: "hold", keys: ["a", "d"] }, { type: "look" }], { clock: "wall" });
    assert.deepEqual(
      calls.map((c) => [c.method, c.payload]),
      [
        ["preview.input", { actions: [{ type: "down", keys: ["a", "d"] }] }],
        ["preview.input", { actions: [{ type: "wait", ms: 400 }] }],
        ["preview.input", { actions: [{ type: "up", keys: ["a", "d"] }] }],
        ["preview.input", { actions: [{ type: "look", dx: 0, dy: 0 }] }],
      ],
    );
  });
});

describe("where a kind is read from and written back to", () => {
  it("reads the nested game block of studio.json, never the top-level shape kind", async () => {
    const files: Record<string, string> = {
      "studio.json": JSON.stringify(
        { name: "board", title: "Board", kind: "three-modules", contractVersion: 1, game: { kind: "static-board" } },
        null,
        2,
      ),
    };
    const writes: Array<{ file: string; contents: string }> = [];
    const ctx = {
      call: async (method: string, payload: any) => {
        if (method === "game.read") {
          if (!(payload.file in files)) throw new Error("no such file");
          return files[payload.file];
        }
        if (method === "game.write") {
          writes.push({ file: payload.file, contents: payload.contents });
          files[payload.file] = payload.contents;
          return { bytes: payload.contents.length };
        }
        throw new Error(method);
      },
    };
    const declared = (await readDeclaredGame(ctx as never, "board"))!;
    assert.equal(declared.kind, "static-board");
    assert.equal(declared.hud, false);
    assert.equal(criticFor(declared), "screen");
    assert.equal(wantsEyeCameras(declared), false);
    assert.equal(wantsEyeCameras(undefined), true, "an undeclared game is looked at exactly as before");

    const written = await writeDeclaredGame(ctx as never, "board", { kind: "top-down" }, { from: "the plan" });
    assert.equal(written.written, true);
    const saved = JSON.parse(writes[0]!.contents);
    assert.equal(saved.game.kind, "top-down");
    assert.equal(saved.game.declaredBy, "the plan");
    assert.equal(saved.kind, "three-modules", "the project's own shape is untouched");
    assert.equal(saved.title, "Board", "and so is everything else the user's file holds");
    // Once a run: the same declaration written twice writes nothing the second time.
    assert.equal(
      (await writeDeclaredGame(ctx as never, "board", { kind: "top-down" }, { from: "the plan" })).written,
      false,
    );
    assert.equal(
      (await writeDeclaredGame(ctx as never, "board", {}, { from: "the plan" })).written,
      false,
      "nothing declared, nothing written",
    );
    // A studio.json nobody can read is left exactly as it is.
    const blind = {
      call: async () => {
        throw new Error("gone");
      },
    };
    assert.equal(await readDeclaredGame(blind as never, "board"), null);
    assert.equal((await writeDeclaredGame(blind as never, "board", { kind: "racing" })).written, false);
  });
});

// ── the pass itself, rebuilt: readiness, the proof, the kind, the surfaces, the guards ────────

describe("readiness: the pass waits for the page instead of photographing its boot", () => {
  it("judges a six-second contract normally, and says what it cost", async () => {
    const { ctx, calls } = stubCtx({ frames: ["a", "b", "c"], ready: { pageMs: 6_000, ms: 6_000 } });
    const evidence = await gather(ctx);
    assert.equal(evidence.ok, true, `problems: ${evidence.problems.join("; ")}`);
    assert.equal(evidence.readyAfterMs, 6_000);
    assert.match(evidence.warnings.join(" | "), /the page took 6\.0 s to report itself ready/);
    // The poll sits between the load and the first thing that assumes a running game.
    const order = calls.map((c) => (c.method === "preview.call" ? `${c.method}:${c.payload.method}` : c.method));
    const readyAt = order.indexOf("preview.ready");
    assert.ok(readyAt > order.indexOf("preview.load") || order.includes("preview.reload"));
    assert.ok(readyAt >= 0 && readyAt < order.indexOf("preview.call:seed"), order.slice(0, 6).join(" → "));
  });

  it("a page that never comes up is a build failure, not one frame and a clean bill", async () => {
    const { ctx, calls } = stubCtx({
      frames: ["a", "b", "c"],
      ready: { ready: false, timedOut: true, budgetMs: 15_000, phase: "boot", reason: "still booting" },
    });
    const evidence = await gather(ctx);
    assert.equal(evidence.ok, false);
    assert.match(evidence.problems.join(" | "), /the page never reported itself ready within 15\.0 s: still booting/);
    // 30 step round trips against a page that never booted is the endless hold this replaces.
    const drove = calls.filter(
      (c) => c.method === "preview.call" && ["seed", "step"].includes(String(c.payload.method)),
    );
    assert.deepEqual(drove, []);
    assert.ok(evidence.shots.length <= 1, `shots: ${cameraList(evidence).join(", ")}`);
    assert.equal(classifyEvidenceFailure(evidence.problems, { readyAfterMs: evidence.readyAfterMs }), "build");
  });

  it("a page that says it failed pushes its own sentence rather than coming back ok", async () => {
    const { ctx } = stubCtx({
      frames: ["a", "b", "c"],
      ready: { ready: false, timedOut: false, phase: "failed", reason: "the game's boot threw: THREE is not defined" },
    });
    const evidence = await gather(ctx);
    assert.equal(evidence.ok, false);
    assert.match(
      evidence.problems.join(" | "),
      /the page reported itself failed: the game's boot threw: THREE is not defined/,
    );
  });

  it("an older studio that cannot measure readiness changes nothing", async () => {
    const { ctx } = stubCtx({ frames: ["a", "b", "c"], ready: null });
    const evidence = await gather(ctx);
    assert.equal(evidence.ok, true, `problems: ${evidence.problems.join("; ")}`);
    assert.equal(evidence.readyAfterMs, null);
    assert.equal(evidence.ready, null);
    assert.equal(evidence.shots.length, 3, "the whole pass still ran");
  });

  it("a page the studio cannot reach at all is unmeasured, not failed", async () => {
    const { ctx } = stubCtx({
      frames: ["a", "b", "c"],
      ready: {
        ready: false,
        via: "none",
        phase: "unknown",
        pageMs: null,
        reason: "the page reports no readiness signal",
      },
    });
    const evidence = await gather(ctx);
    assert.equal(evidence.ok, true, `problems: ${evidence.problems.join("; ")}`);
    assert.equal(evidence.readyAfterMs, null);
  });
});

describe("proveStep: the studio owns the clock, or nothing it measures means anything", () => {
  const record = (witness: (tick: number) => unknown, step: Record<string, unknown> = { ok: true }) => {
    let tick = 0;
    const calls: Array<{ method: string; payload: Record<string, any> }> = [];
    return {
      calls,
      ctx: {
        cancelled: false,
        call: async (method: string, payload: Record<string, any> = {}) => {
          calls.push({ method, payload });
          if (method === "preview.evaluate") return witness(++tick);
          if (method === "preview.call" && payload.method === "step") return step;
          return { ok: true };
        },
      },
    };
  };

  const moving = (tick: number) => ({
    steppedFrames: tick * 8,
    drawCalls: tick * 40,
    now: tick * 320,
    canvas: true,
    simulatedMs: tick * 320,
  });

  it("passes when every counter moves across BOTH steps, and takes exactly two", async () => {
    const { ctx, calls } = record((tick) => ({
      steppedFrames: tick * 8,
      drawCalls: tick * 40,
      now: tick * 320,
      canvas: true,
      simulatedMs: tick * 320,
    }));
    const proof = await proveStep(ctx as never);
    assert.equal(proof.ok, true, proof.reason);
    assert.equal(proof.frames, 16);
    assert.equal(proof.drawCalls, 80);
    assert.equal(proof.ms, 640);
    const steps = calls.filter((c) => c.method === "preview.call" && c.payload.method === "step");
    assert.equal(
      steps.length,
      2,
      "two steps, because one delta can be a wall-clock frame that landed between two reads",
    );
    assert.deepEqual(
      steps.map((c) => c.payload.arg),
      [320, 320],
    );
    // The witness is the page's OWN stepped-frame counter, not the pump's frame counter.
    assert.match(STEP_WITNESS, /steppedFrames/);
  });

  it("reads the shim's own count of frames that found no animation callback", async () => {
    // Every counter can move on a game that never registers a callback — a timer loop, a render
    // on input — and the old answer charged those frames to the game's loop. A page that says
    // every stepped frame was idle gets a note beside a pass, not sixty frames it never ran.
    const idle = await proveStep(record(moving, { ok: true, frames: 8, idle: 8 }).ctx as never);
    assert.equal(idle.ok, true, idle.reason);
    assert.equal(idle.idle, 16);
    assert.equal(idle.askedFrames, 16);
    assert.equal(idle.idleLoop, true);
    assert.match(idle.note, /ran no animation frame of its own/);
    const riding = await proveStep(record(moving, { ok: true, frames: 8, idle: 0 }).ctx as never);
    assert.equal(riding.idleLoop, false);
    assert.equal(riding.note, "");
    // A studio too old to answer with counts says nothing rather than accusing the game.
    const silent = await proveStep(record(moving).ctx as never);
    assert.equal(silent.askedFrames, 0);
    assert.equal(silent.idleLoop, false);
  });

  it("names a flat clock, and a page with no clock at all", async () => {
    const flat = await proveStep(
      record((tick) => ({ steppedFrames: tick * 8, drawCalls: tick * 40, now: 500, canvas: true })).ctx as never,
    );
    assert.equal(flat.ok, false);
    assert.match(flat.reason, /the studio clock did not advance across two steps/);
    const none = await proveStep(record(() => null).ctx as never);
    assert.equal(none.ok, false);
    assert.equal(none.reason, "the page has no studio clock (the shim did not load)");
    const junk = await proveStep(record(() => "default").ctx as never);
    assert.equal(junk.reason, "the page has no studio clock (the shim did not load)");
  });

  it("is a verdict on every stage when the shim itself did not load", async () => {
    // A regression in the game is a warning on a challenger. The page layer not loading is not a
    // fact about the game at all: nothing measured below it can be believed on any stage.
    const gone = await gather(stubCtx({ frames: ["a", "b", "c"], witness: null }).ctx);
    assert.match(gone.problems.join(" | "), /the page has no studio clock \(the shim did not load\)/);
    assert.equal(gone.ok, false);
    const base = await gather(stubCtx({ frames: ["a", "b", "c"], witness: null }).ctx, {
      iterationId: "base",
      scaffold: true,
    });
    assert.match(base.problems.join(" | "), /the shim did not load/);
  });

  it("is a verdict on a scaffold base and a warning on an iteration — one regression never voids a run", async () => {
    const stuck = (tick: number) => ({ steppedFrames: 8, drawCalls: tick * 40, now: tick * 320, canvas: true });
    const sentence = /the game does not ride the studio's clock/;
    const base = await gather(stubCtx({ frames: ["a", "b", "c"], witness: stuck }).ctx, {
      iterationId: "base",
      scaffold: true,
    });
    assert.match(base.problems.join(" | "), sentence);
    assert.equal(base.ok, false);
    const later = await gather(stubCtx({ frames: ["a", "b", "c"], witness: stuck }).ctx);
    assert.match(later.warnings.join(" | "), sentence);
    assert.equal(later.ok, true, `problems: ${later.problems.join("; ")}`);
    assert.equal(later.clock.ok, false);
    assert.match(later.clock.reason, sentence);
  });

  it("frames without draws indict a page that has a canvas and only warn on one that does not", async () => {
    const dry = (canvas: boolean) => (tick: number) => ({
      steppedFrames: tick * 8,
      drawCalls: 0,
      now: tick * 320,
      canvas,
    });
    const canvasPage = await gather(stubCtx({ frames: ["a", "b", "c"], witness: dry(true) }).ctx, {
      iterationId: "base",
      scaffold: true,
    });
    assert.match(canvasPage.problems.join(" | "), /frames ran but nothing was drawn/);
    // A DOM-first screen is exactly the shape the readiness ladder exists for; the pixel rule
    // still votes on blankness after the screenshots.
    const domPage = await gather(stubCtx({ frames: ["a", "b", "c"], witness: dry(false) }).ctx, {
      iterationId: "base",
      scaffold: true,
    });
    assert.ok(!domPage.problems.some((p: string) => /nothing was drawn/.test(p)), domPage.problems.join(" | "));
    assert.match(domPage.warnings.join(" | "), /frames ran but nothing was drawn/);
  });
});

describe("the game's own controls, driven before every judgement", () => {
  const driven = (calls: Array<{ method: string; payload: Record<string, any> }>) =>
    calls
      .filter((c) => c.method === "preview.input")
      .flatMap((c) => (c.payload.actions ?? []) as Array<{ type: string; keys?: string[] }>);

  it("drives a top-down game on its keys and never looks around with a mouse it has no use for", async () => {
    const { ctx, calls } = stubCtx({ frames: ["a", "b", "c"] });
    await gatherEvidence(
      ctx as never,
      { run: { ...run, game: { kind: "top-down" } }, iterationId: "001", seed: 1 } as never,
    );
    const actions = driven(calls);
    const held = actions.filter((a) => a.type === "down").flatMap((a) => a.keys ?? []);
    assert.ok(held.includes("w"), held.join(", "));
    assert.ok(held.includes("a"), held.join(", "));
    assert.ok(!actions.some((a) => a.type === "look"), "a top-down camera is not mouse-looked");
  });

  it("drives a first-person game with the look the template always had", async () => {
    const { ctx, calls } = stubCtx({ frames: ["a", "b", "c"] });
    await gatherEvidence(
      ctx as never,
      { run: { ...run, game: { kind: "first-person" } }, iterationId: "001", seed: 1 } as never,
    );
    assert.ok(driven(calls).some((a) => a.type === "look"));
    assert.deepEqual(playScriptFor({ kind: "first-person" }), CONTROL_EXERCISE);
  });

  it("a declared play script replaces the kind's", async () => {
    const { ctx, calls } = stubCtx({ frames: ["a", "b", "c"] });
    const game = { kind: "first-person", playScript: [{ type: "tap", keys: ["e"] }] };
    await gatherEvidence(ctx as never, { run: { ...run, game }, iterationId: "001", seed: 1 } as never);
    const actions = driven(calls);
    assert.deepEqual(
      actions.map((a) => a.type),
      ["tap"],
    );
    assert.deepEqual(actions[0]!.keys, ["e"]);
  });

  it("asks a board game for no player eyes, and an undeclared game for them exactly as before", async () => {
    const eyesAsked = async (game: unknown) => {
      const { ctx, calls } = stubCtx({ frames: ["a", "b", "c"] });
      await gatherEvidence(
        ctx as never,
        { run: { ...run, ...(game ? { game } : {}) }, iterationId: "001", seed: 1 } as never,
      );
      return calls.some((c) => c.method === "preview.call" && c.payload.method === "eyes");
    };
    assert.equal(
      await eyesAsked({ kind: "static-board" }),
      false,
      "a board game stops shipping three frames of nothing",
    );
    assert.equal(await eyesAsked({ kind: "free-camera" }), false);
    assert.equal(await eyesAsked(null), true, "an undeclared game is looked at exactly as before");
    assert.equal(await eyesAsked({ kind: "first-person" }), true);
  });
});

describe("surfaces: the canvas is judged, the page is shown", () => {
  const menu = {
    entries: ["nav.main-menu"],
    coverage: 0.42,
    canvas: null,
    viewport: { width: 800, height: 600 },
    uiPrimary: true,
  };

  it("keeps every CAMERA frame on the canvas and adds the page frame beside them", async () => {
    const { ctx } = stubCtx({ frames: ["a", "b", "c", "d"], cameras: ["default", "close"], pageUi: menu, diff: 0.4 });
    const evidence = await gather(ctx);
    for (const shot of evidence.shots.filter((s: { camera: string }) => s.camera !== "user:view")) {
      assert.equal(shot.surface, "canvas", `${shot.camera} must stay canvas-sourced`);
    }
    assert.equal(evidence.surface, "canvas");
    assert.ok(cameraList(evidence).includes("user:view"));
    assert.deepEqual(evidence.pageUi, { entries: ["nav.main-menu"], coverage: 0.42, primary: true });
    // The wording is the game's shape, not a defect: a DOM menu is the norm for these genres.
    assert.match(
      evidence.warnings.join(" | "),
      /this game paints UI outside the canvas \(nav\.main-menu\) — user:view shows it, the canvas frames do not/,
    );
    assert.ok(!evidence.warnings.some((w: string) => /differs from the canvas capture/.test(w)));
  });

  it("keeps the frame for a HUD too small to move the diff", async () => {
    const hud = { entries: ["div.hud"], coverage: 0.002, canvas: null, viewport: null, uiPrimary: false };
    const { ctx } = stubCtx({ frames: ["a", "b", "c", "d"], cameras: ["default", "close"], pageUi: hud, diff: 0.001 });
    const evidence = await gather(ctx);
    assert.ok(cameraList(evidence).includes("user:view"), "the probe found UI, so the frame is kept");
    assert.equal(evidence.pageUi!.primary, false);
  });

  it("drops it for a page with nothing outside its canvas and a sub-2% diff", async () => {
    const bare = { entries: [], coverage: 0, canvas: null, viewport: null, uiPrimary: false };
    const { ctx } = stubCtx({ frames: ["a", "b", "c", "d"], cameras: ["default", "close"], pageUi: bare, diff: 0.001 });
    const evidence = await gather(ctx);
    assert.ok(!cameraList(evidence).includes("user:view"));
    assert.deepEqual(
      evidence.warnings.filter((w: string) => /user:view|outside the canvas/.test(w)),
      [],
    );
  });

  it("keeps the defect wording when the probe found nothing and the pictures still differ", async () => {
    const bare = { entries: [], coverage: 0, canvas: null, viewport: null, uiPrimary: false };
    const { ctx } = stubCtx({ frames: ["a", "b", "c", "d"], cameras: ["default", "close"], pageUi: bare, diff: 0.4 });
    const evidence = await gather(ctx);
    assert.match(
      evidence.warnings.join(" | "),
      /the page the user sees differs from the canvas capture on the default camera \(40\.0% of pixels\)/,
    );
  });

  it("retakes a page capture that throws off the canvas, with a warning and no problem", async () => {
    const { ctx } = stubCtx({
      frames: ["a", "b", "c", "d"],
      cameras: ["default", "close"],
      failShot: (payload) => (payload.page === true ? "Current display surface not available for capture" : null),
    });
    const evidence = await gather(ctx);
    assert.equal(evidence.ok, true, `problems: ${evidence.problems.join("; ")}`);
    assert.match(
      evidence.warnings.join(" | "),
      /user:view capture unavailable: Current display surface not available for capture/,
    );
    const shot = evidence.shots.find((s: { camera: string }) => s.camera === "user:view");
    assert.ok(shot, cameraList(evidence).join(", "));
    assert.equal(shot.surface, "canvas");
  });

  it("takes no page frame at all when the caller asked for none", async () => {
    const { ctx } = stubCtx({ frames: ["a", "b", "c"], cameras: ["default"], diff: 0.9 });
    const evidence = await gather(ctx, { userView: false });
    assert.ok(!cameraList(evidence).includes("user:view"));
  });
});

describe("cameras: a floor under the classic trio, and an honest 'registered' half", () => {
  it("photographs the view a contract-less game renders and names what it does register", async () => {
    const { ctx } = stubCtx({ frames: ["a", "b", "c"], debugCamera: () => ({ ok: false, available: [] }) });
    const evidence = await gather(ctx);
    assert.deepEqual(cameraList(evidence), ["default"]);
    assert.equal(evidence.ok, true, `problems: ${evidence.problems.join("; ")}`);
    assert.match(evidence.warnings.join(" | "), /this game registers no "default" camera \(registered: none\)/);
    // The floor asked for close and wide; an unregistered one of those is skipped in silence,
    // never reported as a defect of a game that never claimed to have it.
    assert.deepEqual(evidence.missingCameras, []);
  });

  it("keeps the template at three frames through the floor, since the template registers one camera", async () => {
    const { ctx, calls } = stubCtx({ frames: ["a", "b", "c"], cameras: ["default"] });
    const evidence = await gather(ctx);
    assert.deepEqual(cameraList(evidence), ["default", "close", "wide"]);
    const asked = calls
      .filter((c) => c.method === "preview.call" && c.payload.method === "debugCamera")
      .map((c) => c.payload.arg);
    assert.deepEqual(asked.slice(0, 3), ["default", "close", "wide"]);
  });

  it("says why there is nothing to judge, so 'the build does not run: ' never ends in a colon", async () => {
    const { ctx } = stubCtx({
      frames: ["a"],
      debugCamera: () => ({ ok: false, available: [] }),
      failShot: () => "Current display surface not available for capture",
    });
    const evidence = await gather(ctx);
    assert.equal(evidence.ok, false);
    assert.ok(
      evidence.problems.includes("no camera produced a frame (asked for: default; registered: none)"),
      evidence.problems.join(" | "),
    );
    assert.ok(!`the build does not run: ${evidence.problems.join("; ")}`.endsWith(": "));
    // A pass that took no frame because the window was blind is still an outage, not a verdict.
    assert.equal(classifyEvidenceFailure(evidence.problems), "observation");
  });

  it("one declared viewpoint warns, two declared cameras still fail", async () => {
    const one = await gather(stubCtx({ frames: ["A", "A", "A", "A"], cameras: ["default"] }).ctx);
    assert.equal(one.ok, true, `problems: ${one.problems.join("; ")}`);
    assert.match(one.warnings.join(" | "), /this build declares one viewpoint — identical frames are its design/);
    const two = await gather(stubCtx({ frames: ["A", "A", "A", "A"], cameras: ["default", "close"] }).ctx);
    assert.equal(two.ok, false);
    assert.match(two.problems.join(" | "), /every camera returned the same frame/);
  });

  it("a full-screen overlay is named as an overlay, not as dead camera wiring", async () => {
    const overlay = { entries: ["div.pause-screen"], coverage: 0.98, canvas: null, viewport: null, uiPrimary: true };
    const { ctx } = stubCtx({
      frames: ["A", "A", "A", "A"],
      cameras: ["default", "close"],
      pageUi: overlay,
      diff: 0.4,
    });
    const evidence = await gather(ctx);
    assert.equal(evidence.ok, true, `problems: ${evidence.problems.join("; ")}`);
    assert.match(evidence.warnings.join(" | "), /a full-screen overlay covers the game \(div\.pause-screen\)/);
  });

  it("a frame that drew nothing leaves the blankness census; every frame drawing nothing is the verdict", async () => {
    const lit = { canvas: true, litFraction: 0.6, width: 800, height: 600, sampled: 1, meanLuma: 40 };
    const some = await gather(
      stubCtx({
        frames: ["a", "b", "c"],
        cameras: ["default", "close", "wide"],
        stats: [
          { ...lit, drawCalls: 0 },
          { ...lit, drawCalls: 120 },
          { ...lit, drawCalls: 120 },
        ],
      }).ctx,
    );
    assert.equal(some.ok, true, `problems: ${some.problems.join("; ")}`);
    assert.match(some.warnings.join(" | "), /1 camera frame\(s\) drew nothing \(default\)/);
    const none = await gather(
      stubCtx({
        frames: ["a", "b", "c"],
        cameras: ["default", "close", "wide"],
        stats: [{ ...lit, drawCalls: 0 }],
      }).ctx,
    );
    assert.equal(none.ok, false);
    assert.ok(none.problems.includes("the game drew nothing for any camera"), none.problems.join(" | "));
  });

  it('does not count the harness\'s own "default" as a viewpoint the game declares', async () => {
    // "default" is the harness asking for the view the page renders. A game that names its own
    // cameras and none of them "default" declares ONE viewpoint, so its two identical frames are
    // one view photographed twice — not a dead debugCamera, and not a build to void.
    const unregistered = await gather(
      stubCtx({
        frames: ["A", "A", "A", "A"],
        cameras: ["hero"],
        debugCamera: (name) => (name === "hero" ? { ok: true } : { ok: false, available: ["hero"] }),
      }).ctx,
    );
    assert.equal(unregistered.ok, true, `problems: ${unregistered.problems.join("; ")}`);
    assert.deepEqual(cameraList(unregistered), ["default", "hero"]);
    assert.match(unregistered.warnings.join(" | "), /this game registers no "default" camera \(registered: hero\)/);
    assert.match(unregistered.warnings.join(" | "), /this build declares one viewpoint/);
    // The same when the game DOES register a default it never declared: what the game claims to
    // have is what the census counts.
    const registered = await gather(stubCtx({ frames: ["A", "A", "A", "A"], cameras: ["hero"] }).ctx);
    assert.equal(registered.ok, true, `problems: ${registered.problems.join("; ")}`);
    // Two viewpoints the game itself declares, one frame between them: still the verdict.
    const two = await gather(stubCtx({ frames: ["A", "A", "A", "A"], cameras: ["hero", "top"] }).ctx);
    assert.equal(two.ok, false);
    assert.match(two.problems.join(" | "), /every camera returned the same frame/);
  });

  it("carries the surface the port photographed, not the one the capture asked for", async () => {
    // A canvas read that declines (no canvas, nothing drew, a painted page background) is
    // answered by the compositor. Every camera then gets the same page bitmap, which is a stale
    // picture and not a dead debugCamera — the guard that says so was unreachable while every
    // shot was stamped "canvas".
    const { ctx } = stubCtx({ frames: ["A", "A", "A", "A"], cameras: ["default", "close"], shotSurface: () => "page" });
    const evidence = await gather(ctx);
    assert.equal(evidence.ok, true, `problems: ${evidence.problems.join("; ")}`);
    assert.equal(evidence.surface, "page");
    const surfaces = evidence.shots.map(
      (shot: { camera: string; surface?: string }) => `${shot.camera}=${shot.surface}`,
    );
    assert.ok(
      surfaces.every((entry: string) => entry.endsWith("=page")),
      surfaces.join(", "),
    );
    assert.match(evidence.warnings.join(" | "), /came off the compositor and not the canvas/);
    assert.ok(
      !evidence.problems.some((problem: string) => /cameras contract is dead/.test(problem)),
      evidence.problems.join(" | "),
    );
    // A port that says the canvas gave the frame is believed too, and the verdict stands.
    const canvas = await gather(
      stubCtx({ frames: ["A", "A", "A", "A"], cameras: ["default", "close"], shotSurface: () => "canvas" }).ctx,
    );
    assert.equal(canvas.surface, "canvas");
    assert.match(canvas.problems.join(" | "), /every camera returned the same frame/);
  });

  it("carries the surface and the page-side capture's own report beside every shot", async () => {
    const stats = {
      canvas: true,
      litFraction: 0.6,
      width: 800,
      height: 600,
      sampled: 1,
      meanLuma: 40,
      drawCalls: 120,
      source: "page",
      composited: true,
      kind: "webgpu",
      captureReason: null,
    };
    const { ctx } = stubCtx({ frames: ["a", "b", "c"], cameras: ["default"], stats: [stats] });
    const evidence = await gather(ctx);
    assert.equal(evidence.shots[0]!.stats!.drawCalls, 120);
    // A port that says nothing about who took the picture reports nulls, not absence: the
    // judge's block always has the same shape.
    assert.deepEqual(evidence.canvas, {
      source: "page",
      composited: true,
      drawCalls: 120,
      reason: null,
      kind: "webgpu",
      provenance: null,
      ladder: null,
    });
  });

  it("says whose picture the judged frame was, and by which rungs", async () => {
    // `capture()` is a member the facade delegates to the game, so a build can answer with a
    // picture and a draw count of its own. The block must say so, or a run reads the build's
    // claim about itself as the canvas's own answer.
    const claimed = {
      canvas: true,
      litFraction: 0.6,
      width: 800,
      height: 600,
      sampled: 1,
      meanLuma: 40,
      drawCalls: 0,
      source: "page",
      composited: false,
      kind: "webgl2",
      captureReason: null,
      provenance: "game",
      ladder: ["frame", "game"],
    };
    const { ctx } = stubCtx({ frames: ["a", "b", "c"], cameras: ["default"], stats: [claimed] });
    const evidence = await gather(ctx);
    assert.equal(evidence.canvas!.provenance, "game");
    assert.deepEqual(evidence.canvas!.ladder, ["frame", "game"]);
    // …and a zero-draw census made entirely of the build's own pictures is a warning, never
    // the verdict "the game drew nothing for any camera".
    assert.ok(
      !evidence.problems.some((problem: string) => /drew nothing for any camera/.test(problem)),
      evidence.problems.join(" | "),
    );
    assert.match(evidence.warnings.join(" | "), /the count is the build's claim about itself/);
    // The same census off the studio's own read of the canvas keeps the verdict.
    const own = await gather(
      stubCtx({
        frames: ["a", "b", "c"],
        cameras: ["default"],
        stats: [{ ...claimed, provenance: "shim", ladder: ["frame"] }],
      }).ctx,
    );
    assert.ok(
      own.problems.some((problem: string) => /drew nothing for any camera/.test(problem)),
      own.problems.join(" | "),
    );
  });
});

describe("the empty-scene exemption, read the way the page reads it", () => {
  const inPage = (studio: unknown) =>
    new vm.Script(EMPTY_SCENE_PROBE).runInNewContext({ window: { __studio: studio } }) as boolean;
  const world = (extra: Record<string, unknown>) => ({
    inspect: () => ({ camera: { isCamera: true }, ...extra }),
    state: () => ({ hud: { items: [], crosshair: false, flash: null } }),
  });
  const mesh = { isMesh: true, children: [] };

  it("exempts a WebGPU base with an empty scene and refuses the same base with one mesh", () => {
    const gpu = { backend: { isWebGPUBackend: true } };
    assert.equal(inPage(world({ renderer: gpu, scenes: [{ isScene: true, children: [] }] })), true);
    assert.equal(inPage(world({ renderer: gpu, scenes: [{ isScene: true, children: [mesh] }] })), false);
    // A WebGPURenderer forced onto WebGL is the same renderer and the same exemption.
    assert.equal(
      inPage(world({ renderer: { backend: { isWebGLBackend: true } }, scenes: [{ isScene: true, children: [] }] })),
      true,
    );
    // And the flag the old probe was anchored on still counts as one of the three backends.
    assert.equal(
      inPage(world({ renderer: { isWebGLRenderer: true }, scenes: [{ isScene: true, children: [] }] })),
      true,
    );
    assert.equal(
      inPage(world({ renderer: { isSomethingElse: true }, scenes: [{ isScene: true, children: [] }] })),
      false,
    );
  });

  it("censuses every scene the hook says was rendered, not just the first", () => {
    const gpu = { backend: { isWebGPUBackend: true } };
    const two = [
      { isScene: true, children: [] },
      { isScene: true, children: [mesh] },
    ];
    assert.equal(inPage(world({ renderer: gpu, scenes: two })), false, "the menu is empty and the level is not");
    assert.equal(inPage(world({ renderer: gpu, scene: two[0] })), true, "a page with one scene answers as before");
  });

  it("never exempts a page whose own state() throws", () => {
    const gpu = { backend: { isWebGPUBackend: true } };
    assert.equal(
      inPage({
        inspect: () => ({ renderer: gpu, camera: { isCamera: true }, scenes: [{ isScene: true, children: [] }] }),
        state: () => {
          throw new Error("state is not a function");
        },
      }),
      false,
    );
    assert.equal(inPage({ inspect: () => ({ available: false, reason: "no renderer has drawn a frame yet" }) }), false);
    assert.equal(inPage({}), false);
  });

  it("never censuses the floor's own guesses for camera placement", async () => {
    // A shared base that declares ONE camera answers the same pose for close and wide because
    // the harness asked twice, not because it never placed its cameras. Counting those would
    // fail every one-camera base with "every camera has the same transform".
    const black = { canvas: true, litFraction: 0, width: 800, height: 600, sampled: 1, meanLuma: 0 };
    const { ctx } = stubCtx({
      frames: ["a", "b", "c"],
      stats: [black],
      evaluate: (expression) => (expression.includes("var s = window.__studio;") ? true : "[1,0,0,1]"),
    });
    const evidence = await gather(ctx, { iterationId: "base", scaffold: true });
    assert.equal(evidence.emptyScene, true);
    assert.equal(evidence.ok, true, `problems: ${evidence.problems.join("; ")}`);
    // Two DECLARED cameras answering one pose is still the defect it always was.
    const declared = await gather(
      stubCtx({
        frames: ["a", "b", "c"],
        cameras: ["default", "wide"],
        stats: [black],
        evaluate: (expression) => (expression.includes("var s = window.__studio;") ? true : "[1,0,0,1]"),
      }).ctx,
      { iterationId: "base", scaffold: true },
    );
    assert.match(declared.problems.join(" | "), /every camera has the same transform/);
  });

  it("lets an all-black WebGPU scaffold base pass, exactly as a WebGL one always could", async () => {
    let pose = 0;
    const black = { canvas: true, litFraction: 0, width: 800, height: 600, sampled: 1, meanLuma: 0, drawCalls: 12 };
    const { ctx } = stubCtx({
      frames: ["a", "b", "c"],
      cameras: ["default", "close"],
      stats: [black],
      evaluate: (expression) => (expression.includes("var s = window.__studio;") ? true : `pose-${pose++}`),
    });
    const evidence = await gather(ctx, { iterationId: "base", scaffold: true });
    assert.equal(evidence.emptyScene, true);
    assert.equal(evidence.ok, true, `problems: ${evidence.problems.join("; ")}`);
    assert.ok(!evidence.problems.some((p: string) => /black/.test(p)));
    assert.match(evidence.warnings.join(" | "), /no visual content or gameplay has been validated/);
  });
});

describe("why a pass failed, and how long it is worth waiting", () => {
  it("tells a blind camera from a page that was not up yet from a broken build", () => {
    assert.equal(classifyEvidenceFailure([]), "none");
    assert.equal(classifyEvidenceFailure(["screenshot(close) failed: UnknownVizError"]), "observation");
    assert.equal(classifyEvidenceFailure([MISSING_CONTRACT], { readyAfterMs: null }), "race");
    assert.equal(
      classifyEvidenceFailure([MISSING_CONTRACT], { readyAfterMs: 6_000 }),
      "build",
      "a measured boot means the page really has no contract",
    );
    assert.equal(classifyEvidenceFailure([MISSING_CONTRACT, "3 console error(s)"], { readyAfterMs: null }), "build");
    assert.equal(classifyEvidenceFailure(["the renderer crashed"]), "build");
    // The catch-all for a dead preview must cost its iteration, not be retried against a corpse.
    assert.equal(classifyEvidenceFailure(["evidence pass failed: window is not defined"]), "build");
    assert.equal(observationOnlyFailure(["screenshot(close) failed: x"]), true);
    assert.equal(observationOnlyFailure([MISSING_CONTRACT]), false);
  });

  it("retries a race on its own short backoff and reports every retry", async () => {
    const race: { ok: boolean; problems: string[]; shots: unknown[]; readyAfterMs: number | null } = {
      ok: false,
      problems: [MISSING_CONTRACT],
      shots: [],
      readyAfterMs: null,
    };
    const fine = { ok: true, problems: [], shots: [] };
    const sequence = [race, race, fine];
    const seen: Array<{ kind: string; delay: number }> = [];
    let calls = 0;
    const ctx = { cancelled: false, setStatus: () => {} };
    const evidence = await withObservationPatience(ctx, async () => sequence[calls++], {
      raceDelays: [1, 1],
      onRetry: (kind, _evidence, delay) => void seen.push({ kind, delay }),
    });
    assert.equal(evidence.ok, true);
    assert.equal(calls, 3);
    assert.deepEqual(seen, [
      { kind: "race", delay: 1 },
      { kind: "race", delay: 1 },
    ]);

    // The same sentence on a page whose boot WAS measured is a build failure: no retry at all.
    let measured = 0;
    const once = await withObservationPatience(ctx, async () => (measured++, { ...race, readyAfterMs: 6_000 }), {
      raceDelays: [1, 1],
    });
    assert.equal(measured, 1);
    assert.equal(once.ok, false);
  });

  it("run.classic is frozen: the gauntlet's own call site takes no race backoff", async () => {
    const source = await readFile(new URL("../../src/harness-seed/loop/gauntlet.ts", import.meta.url), "utf8");
    assert.match(source, /raceDelays: \[\]/, "the classic pass must behave byte-for-byte as it did");
  });
});

describe("the order a pass touches the page in, and the state it leaves it in", () => {
  it("ready, then the knock, then start, then the setup's own input", async () => {
    const { ctx, calls } = stubCtx({ frames: ["a", "b", "c"] });
    const setup = {
      gesture: true,
      actions: [{ type: "tap", keys: ["space"] }],
      verify: { path: "phase", truthy: true },
    };
    await gatherEvidence(ctx as never, { run: { ...run, setup }, iterationId: "001", seed: 1 } as never);
    const order = calls
      .map((c) => (c.method === "preview.call" ? `call:${c.payload.method}` : c.method))
      .filter((name) => ["preview.ready", "preview.gesture", "call:start", "preview.input"].includes(name));
    assert.deepEqual(order.slice(0, 4), ["preview.ready", "preview.gesture", "call:start", "preview.input"]);
  });

  it("hands the game back running however the pass ends", async () => {
    const { ctx, calls } = stubCtx({ frames: ["a", "b", "c"], failConsole: "the preview is gone" });
    await assert.rejects(() => gather(ctx), /the preview is gone/);
    const last = calls.at(-1)!;
    assert.equal(last.method, "preview.call");
    assert.equal(last.payload.method, "start", "a crashed pass must never leave a dead page on the user's stage");
    // And an ordinary pass leaves it running too.
    const clean = stubCtx({ frames: ["a", "b", "c"] });
    await gather(clean.ctx);
    assert.equal(clean.calls.at(-1)!.payload.method, "start");
  });
});

// ── the game's front-end, the drive held in play, and what the pass now always says ──────────

/**
 * A racer with a title → countdown → race front-end: `seed` puts it back
 * on its menu, `begin` starts the countdown, each step of the countdown counts it down, and a held
 * W moves the car only once the race is on.
 */
function frontEnd({
  countdownSteps = 2,
  begin = true,
  playingAtBoot = false,
}: {
  countdownSteps?: number;
  begin?: boolean;
  playingAtBoot?: boolean;
} = {}) {
  const first = playingAtBoot ? "playing" : "menu";
  let phase = first;
  let countdown = 0;
  let x = 0;
  const held = new Set<string>();
  const startCountdown = () => {
    phase = "countdown";
    countdown = countdownSteps;
  };
  return {
    state: () => ({ version: 2, flow: { phase, playing: phase === "playing" }, player: { x, z: 0, yaw: 0 } }),
    page: (method: string): unknown => {
      if (method === "seed") {
        phase = first;
        countdown = 0;
        x = 0;
        held.clear();
        return 1;
      }
      if (method === "begin") {
        if (!begin) return { ok: false, reason: "this game has no config.begin" };
        startCountdown();
        return { ok: true, flow: { phase, playing: false } };
      }
      if (method !== "step") return undefined;
      if (phase === "countdown") {
        countdown -= 1;
        if (countdown <= 0) phase = "playing";
      } else if (phase === "playing" && held.has("w")) x += 1;
      return { frame: 1 };
    },
    input: (actions: Array<Record<string, unknown>>) => {
      for (const action of actions) {
        const keys = (action.keys ?? []) as string[];
        if (action.type === "down") for (const key of keys) held.add(key);
        if (action.type === "up") for (const key of keys) held.delete(key);
        if (action.type === "tap" && keys.includes("Enter") && phase === "menu") startCountdown();
      }
    },
  };
}

/** What the pass asked of the page, one word per call: `call:seed`, `input:down`, `state`. */
function sequence(calls: Array<{ method: string; payload: Record<string, unknown> }>): string[] {
  return calls.map((c) => {
    if (c.method === "preview.call") return `call:${c.payload.method}:${c.payload.arg ?? ""}`;
    if (c.method === "preview.input") return `input:${JSON.stringify(c.payload.actions)}`;
    return c.method.replace("preview.", "");
  });
}

describe("a game with a front-end: the drive starts in play", () => {
  it("speaks the template's phase words", () => {
    assert.deepEqual({ ...HarnessFlowPhase }, { ...TemplateFlowPhase });
  });

  it("begins after the seed, waits out the countdown, and samples the early state in play before any control", async () => {
    const game = frontEnd({ countdownSteps: 2 });
    const { ctx, calls } = stubCtx({ frames: ["a", "b", "c"], ...game });
    const evidence = await gather(ctx);
    assert.equal(evidence.ok, true, evidence.problems.join("; "));
    const words = sequence(calls);
    const seed = words.indexOf("call:seed:1");
    const begin = words.indexOf("call:begin:");
    const firstInput = words.findIndex((word) => word.startsWith("input:"));
    assert.ok(seed >= 0 && seed < begin, words.join(" "));
    assert.ok(begin < firstInput, "the game is begun before any scripted control");
    assert.deepEqual(evidence.play, { declared: true, reached: true, phase: "playing", via: "begin", ms: 480 });
    assert.equal((evidence.stateEarly as { flow: { playing: boolean } }).flow.playing, true);
    assert.ok((evidence.state as { player: { x: number } }).player.x > 0, "the held W moved the car in play");
    assert.ok(!evidence.warnings.some((w: string) => /outside play/.test(w)), evidence.warnings.join("; "));
  });

  it("warns, never voids, when the game does not reach play", async () => {
    const game = frontEnd({ countdownSteps: Number.POSITIVE_INFINITY });
    const { ctx, calls } = stubCtx({ frames: ["a", "b", "c"], ...game });
    const evidence = await gather(ctx);
    assert.equal(evidence.ok, true, "one regression never voids a run");
    assert.equal(evidence.play?.reached, false);
    assert.equal(evidence.play?.phase, "countdown");
    assert.ok(
      evidence.warnings.some((w: string) => /^the drive began outside play \(flow\.phase "countdown"\)/.test(w)),
      evidence.warnings.join("; "),
    );
    const waits = calls.filter((c) => c.payload.method === "step" && c.payload.arg === 240);
    assert.equal(waits.length, 50, "twelve simulated seconds, stepped, never slept");
  });

  it("drives a game already in play at boot exactly like one that declares no flow", async () => {
    const boot = frontEnd({ playingAtBoot: true });
    const playing = stubCtx({ frames: ["a", "b", "c"], ...boot });
    const undeclared = stubCtx({ frames: ["a", "b", "c"] });
    const inPlay = await gather(playing.ctx);
    const plain = await gather(undeclared.ctx);
    assert.deepEqual(sequence(playing.calls), sequence(undeclared.calls), "not one call more or less");
    assert.equal(inPlay.play?.via, "boot");
    assert.equal("play" in plain, false, "an undeclared game's evidence has no new key");
    assert.equal("machineKilled" in plain, false);
  });

  it("keeps the front-end for the worker that owns it (setup begin:false)", async () => {
    const game = frontEnd();
    const { ctx, calls } = stubCtx({ frames: ["a", "b", "c"], ...game });
    const evidence = await gather(ctx, { setup: { begin: false } });
    assert.ok(!sequence(calls).includes("call:begin:"), "nobody skips the menu this worker is building");
    assert.deepEqual(evidence.play, { declared: true, reached: false, phase: "menu", via: "kept", ms: 0 });
    assert.ok(!evidence.warnings.some((w: string) => /outside play/.test(w)), evidence.warnings.join("; "));
  });

  it("taps the declared start keys for a game with a flow and no begin()", async () => {
    const game = frontEnd({ begin: false, countdownSteps: 1 });
    const { ctx, calls } = stubCtx({ frames: ["a", "b", "c"], ...game });
    const evidence = await gather(ctx, { run: { ...run, game: { kind: "racing", start: { keys: ["Enter"] } } } });
    const words = sequence(calls);
    const tap = words.findIndex((word) => word.startsWith("input:") && word.includes('"Enter"'));
    const seed = words.indexOf("call:seed:1");
    const firstDrive = words.findIndex((word) => word.startsWith("input:") && word.includes('"w"'));
    assert.ok(seed < tap && tap < firstDrive, words.join(" "));
    assert.equal(evidence.play?.via, "keys");
    assert.equal(evidence.play?.reached, true);
  });

  it("hands the live view back on the game's first screen, and a leased window as it stands", async () => {
    const live = stubCtx({ frames: ["a", "b", "c"], ...frontEnd() });
    await gather(live.ctx);
    assert.deepEqual(sequence(live.calls).slice(-2), ["call:seed:1", "call:start:"]);
    const leased = stubCtx({ frames: ["a", "b", "c"], ...frontEnd() });
    await gather(leased.ctx, { handle: "w1" });
    const tail = sequence(leased.calls).slice(-2);
    assert.equal(tail[1], "call:start:");
    assert.notEqual(tail[0], "call:seed:1", "a pooled window is nobody's stage: no reseed");
  });
});

/**
 * How many drive steps the last `down` of exactly `keys` is held through before its `up`, or null
 * when no such hold spans a drive step (a script's own short hold of the same keys does not).
 */
function heldThrough(calls: Array<{ method: string; payload: Record<string, unknown> }>, keys: string[]) {
  const same = (c: { payload: Record<string, unknown> }, type: string) => {
    const action = ((c.payload.actions ?? []) as Array<{ type: string; keys?: string[] }>)[0];
    return action?.type === type && JSON.stringify(action.keys) === JSON.stringify(keys);
  };
  const down = calls.findLastIndex((c) => c.method === "preview.input" && same(c, "down"));
  if (down < 0) return null;
  const up = calls.findIndex((c, i) => i > down && c.method === "preview.input" && same(c, "up"));
  const steps = calls.slice(down, up).filter((c) => c.payload.method === "step" && c.payload.arg === 960).length;
  if (steps === 0) return null;
  const firstShot = calls.findIndex((c, i) => i > down && c.method === "preview.screenshot");
  return { steps, releasedBeforeShots: up >= 0 && (firstShot < 0 || up < firstShot) };
}

describe("racing and flight hold the throttle through the drive", () => {
  it("holds W/ArrowUp from the end of the script to the last drive step, and lets go before the cameras", async () => {
    const { ctx, calls } = stubCtx({ frames: ["a", "b", "c"] });
    await gather(ctx, { run: { ...run, game: { kind: "racing" } } });
    const held = heldThrough(calls, ["w", "ArrowUp"]);
    assert.ok(held && held.steps >= 20, JSON.stringify(held));
    assert.equal(held!.releasedBeforeShots, true);
  });

  it("holds nothing for a walker, or for a racer whose plan wrote its own script", async () => {
    for (const game of [{ kind: "first-person" }, { kind: "racing", playScript: [{ type: "tap", keys: ["x"] }] }]) {
      const { ctx, calls } = stubCtx({ frames: ["a", "b", "c"] });
      await gather(ctx, { run: { ...run, game } });
      assert.equal(heldThrough(calls, ["w", "ArrowUp"]), null, JSON.stringify(game));
    }
    assert.deepEqual(cruiseFor({ kind: "racing" }), ["w", "ArrowUp"]);
    assert.deepEqual(cruiseFor({ kind: "flight" }), ["w", "ArrowUp"]);
    assert.deepEqual(cruiseFor({ kind: "racing", playScript: [{ type: "tap", keys: ["x"] }] }), []);
    assert.deepEqual(cruiseFor(undefined), []);
  });

  it("tells the judge the throttle was held", () => {
    assert.match(gameLine({ kind: "racing" }), /then holds W\/ArrowUp through the rest of the drive/);
    assert.doesNotMatch(gameLine({ kind: "first-person" }), /through the rest of the drive/);
  });

  it("reads declared start keys from the plan or studio.json, and writes them back", async () => {
    assert.deepEqual(normalizeGameTraits({ start: { keys: "Enter" } }).start, { keys: ["Enter"] });
    assert.equal("start" in normalizeGameTraits({ start: { keys: [] } }), false);
    assert.equal("start" in normalizeGameTraits({ start: 5 }), false);
    assert.deepEqual(startKeysFor({ start: { keys: ["Enter", "space"] } }), ["Enter", "space"]);
    assert.deepEqual(startKeysFor(undefined), []);
    const files: Record<string, string> = { "studio.json": JSON.stringify({ name: "apex", game: {} }) };
    const ctx = {
      call: async (method: string, payload: { file: string; contents: string }) => {
        if (method === "game.read") return files[payload.file];
        files[payload.file] = payload.contents;
        return {};
      },
    };
    const written = await writeDeclaredGame(ctx as never, "apex", { kind: "racing", start: { keys: ["Enter"] } });
    assert.equal(written.written, true);
    assert.deepEqual(JSON.parse(files["studio.json"]!).game.start, { keys: ["Enter"] });
    assert.deepEqual((await readDeclaredGame(ctx as never, "apex"))!.start, { keys: ["Enter"] });
    const startOnly = { "studio.json": JSON.stringify({ name: "x", game: { start: { keys: ["Enter"] } } }) };
    const startCtx = { call: async (_m: string, p: { file: string }) => startOnly[p.file as "studio.json"] };
    assert.deepEqual((await readDeclaredGame(startCtx as never, "x"))!.start, { keys: ["Enter"] });
  });
});

describe("what every pass now records and reads", () => {
  it("records the cameras the game registers even when the facet names its own", async () => {
    const { ctx } = stubCtx({ frames: ["a", "b", "c"], cameras: ["default", "close", "bench"] });
    const named = await gather(ctx, { cameras: ["close"] });
    assert.deepEqual(named.registeredCameras, ["default", "close", "bench"]);
    const { ctx: plain } = stubCtx({ frames: ["a", "b", "c"], cameras: ["default", "close", "bench"] });
    assert.deepEqual((await gather(plain)).registeredCameras, ["default", "close", "bench"]);
  });

  it("sizes a leased window before it loads, and never the live view", async () => {
    const leased = stubCtx({ frames: ["a", "b", "c"] });
    await gather(leased.ctx, { handle: "w1", root: "/work", viewport: { width: 1600, height: 900 } });
    assert.equal(leased.calls[0]!.method, "preview.viewport");
    assert.deepEqual(leased.calls[0]!.payload, { handle: "w1", width: 1600, height: 900 });
    assert.equal(leased.calls[1]!.method, "preview.load");
    const live = stubCtx({ frames: ["a", "b", "c"] });
    await gather(live.ctx, { viewport: { width: 1600, height: 900 } });
    assert.ok(!live.calls.some((c) => c.method === "preview.viewport"));
  });

  it("asks the studio to keep the paths a board reads, and asks nothing when there are none", async () => {
    const kept = stubCtx({ frames: ["a", "b", "c"] });
    await gather(kept.ctx, { keepPaths: ["race.cars"] });
    const reads = kept.calls.filter((c) => c.method === "preview.state");
    assert.ok(reads.length >= 2);
    for (const read of reads) assert.deepEqual(read.payload.keep, ["race.cars"]);
    const plain = stubCtx({ frames: ["a", "b", "c"] });
    await gather(plain.ctx, { keepPaths: [] });
    assert.ok(plain.calls.filter((c) => c.method === "preview.state").every((c) => !("keep" in c.payload)));
  });

  it("says what the studio cut out of an over-budget state, and that an old cut state reads as nothing", async () => {
    const bounded = () => ({
      player: { x: 1, z: 0, yaw: 0 },
      hud: { items: { __elided: "array", length: 6000, chars: 168_001 } },
      __cut: { chars: 177_640, paths: ["hud.items"] },
    });
    const cut = await gather(stubCtx({ frames: ["a", "b", "c"], state: bounded }).ctx);
    const said = cut.warnings.find((w: string) => /hud\.items/.test(w));
    assert.ok(said, cut.warnings.join("; "));
    assert.match(said!, /177,640/);
    const head = () => ({ __truncated: true, length: 82_303, head: "{" });
    const old = await gather(stubCtx({ frames: ["a", "b", "c"], state: head }).ctx);
    assert.ok(
      old.warnings.some((w: string) => /82,303/.test(w)),
      old.warnings.join("; "),
    );
    const small = await gather(stubCtx({ frames: ["a", "b", "c"] }).ctx);
    assert.ok(!small.warnings.some((w: string) => /chars/.test(w)), small.warnings.join("; "));
  });

  it("calls a requested state unread, not unreached, when the state came back cut to a string", async () => {
    const { ctx } = stubCtx({ frames: ["a"], state: () => ({ __truncated: true, length: 82_303, head: "{" }) });
    const outcome = await applySetup(ctx as never, { verify: { path: "maps.activeId", equals: "macba" }, settleMs: 1 });
    assert.equal(outcome.reached, null);
    assert.match(outcome.reason, /unreadable/);
  });
});

describe("a window the machine killed is an outage, not a broken build", () => {
  const crashed = "the renderer crashed";

  it("classifies a kill by its typed flag, and a crash of the build's own as the build's", () => {
    assert.equal(classifyEvidenceFailure([crashed], { machineKilled: true }), EvidenceFailure.Observation);
    assert.equal(classifyEvidenceFailure([crashed], { machineKilled: false }), EvidenceFailure.Build);
    assert.equal(classifyEvidenceFailure([crashed]), EvidenceFailure.Build);
    const blind = [
      crashed,
      "could not drive the game: target closed",
      "no camera produced a frame (asked for: default)",
    ];
    assert.equal(classifyEvidenceFailure(blind, { machineKilled: true }), EvidenceFailure.Observation);
    assert.equal(
      classifyEvidenceFailure([crashed, "2 console error(s)"], { machineKilled: true }),
      EvidenceFailure.Build,
      "an error the build logged is still the build's",
    );
  });

  it("reads the kill off the window's status, and only a kill", async () => {
    const killed = await gather(stubCtx({ frames: ["a", "b", "c"], status: { crashed: true, gone: "killed" } }).ctx);
    assert.equal(killed.machineKilled, true);
    const oom = await gather(stubCtx({ frames: ["a", "b", "c"], status: { crashed: true, gone: "oom" } }).ctx);
    assert.equal(oom.machineKilled, true);
    const own = await gather(stubCtx({ frames: ["a", "b", "c"], status: { crashed: true, gone: "crashed" } }).ctx);
    assert.equal("machineKilled" in own, false);
  });

  it("looks again with patience, and a build the machine always kills still loses after the retries", async () => {
    const ctx = { cancelled: false, setStatus: () => {} };
    const dead = { ok: false, problems: [crashed], machineKilled: true, readyAfterMs: null };
    let looks = 0;
    const always = await withObservationPatience(ctx, async () => (looks++, dead), { delays: [0, 0], raceDelays: [] });
    assert.equal(looks, 3, "the first look and both retries");
    assert.equal(always.ok, false);
    assert.equal(observationOnlyFailure(always.problems), false, "after the retries it is judged a broken build");
    let second = 0;
    const back = await withObservationPatience(
      ctx,
      async () => (second++ === 0 ? dead : { ok: true, problems: [], readyAfterMs: 0 }),
      { delays: [0], raceDelays: [] },
    );
    assert.equal(back.ok, true);
    let patient = 0;
    const director = await patientEvidence(
      ctx,
      async () =>
        (patient++ === 0 ? dead : { ok: true, problems: [], warnings: [], shots: [], consoleErrors: [] }) as never,
      { attempts: 3, delayMs: 0 },
    );
    assert.equal(director?.ok, true, "the director's patient look looks again too");
    const sized: Array<{ method: string; payload: unknown }> = [];
    const calling = {
      cancelled: false,
      call: async (method: string, payload: unknown) => sized.push({ method, payload }),
    };
    const healthy = async () => ({ ok: true, problems: [], warnings: [], shots: [], consoleErrors: [] }) as never;
    await patientEvidence(calling as never, healthy, { handle: "w1", viewport: { width: 1600, height: 900 } });
    await patientEvidence(calling as never, healthy, { viewport: { width: 1600, height: 900 } });
    assert.deepEqual(sized, [{ method: "preview.viewport", payload: { handle: "w1", width: 1600, height: 900 } }]);
  });
});

describe("after the review: a kill mid-pass, the studio's own console line, and what a menu is spared", () => {
  /** A page the OS kills the moment the drive's first input lands: every later read fails. */
  function killedMidPass(gone: string) {
    let killed = false;
    const dead = () => {
      if (killed) throw new Error("Target closed");
    };
    return stubCtx({
      frames: ["a", "b", "c"],
      status: () => (killed ? { crashed: true, gone } : {}),
      input: () => {
        killed = true;
      },
      page: (method: string) => {
        if (method !== "start") dead();
        return undefined;
      },
      failShot: () => (killed ? "Target closed" : null),
      state: (call: number) => {
        dead();
        return { version: 1, frame: call };
      },
    });
  }

  it("reads a kill that lands during the drive, after the load, and calls the look an outage", async () => {
    const evidence = await gather(killedMidPass("oom").ctx);
    assert.equal(evidence.machineKilled, true, evidence.problems.join(" | "));
    assert.ok(evidence.problems.includes("the renderer crashed"), evidence.problems.join(" | "));
    assert.equal(
      classifyEvidenceFailure(evidence.problems, { machineKilled: evidence.machineKilled === true }),
      EvidenceFailure.Observation,
      evidence.problems.join(" | "),
    );
    const own = await gather(killedMidPass("crashed").ctx);
    assert.equal("machineKilled" in own, false, "a renderer the build crashed itself is the build's");
    assert.ok(own.problems.includes("the renderer crashed"), own.problems.join(" | "));
    assert.equal(classifyEvidenceFailure(own.problems), EvidenceFailure.Build);
  });

  it("does not count the studio's own line about a dead window as an error the build logged", async () => {
    const gone = { level: "error", message: "render process gone: oom", source: PreviewConsoleSource.WindowGone };
    const killed = await gather(
      stubCtx({ frames: ["a", "b", "c"], status: { crashed: true, gone: "oom" }, console: [gone] }).ctx,
    );
    assert.ok(!killed.problems.some((p: string) => /console error/.test(p)), killed.problems.join(" | "));
    assert.equal(
      classifyEvidenceFailure(killed.problems, { machineKilled: killed.machineKilled === true }),
      EvidenceFailure.Observation,
    );
    const logged = { level: "error", message: "TypeError: car is undefined" };
    const both = await gather(
      stubCtx({ frames: ["a", "b", "c"], status: { crashed: true, gone: "oom" }, console: [gone, logged] }).ctx,
    );
    assert.ok(both.problems.includes("1 console error(s)"), both.problems.join(" | "));
    assert.equal(
      classifyEvidenceFailure(both.problems, { machineKilled: both.machineKilled === true }),
      EvidenceFailure.Build,
      "an error the build logged is still the build's",
    );
  });

  it("holds no throttle on a menu: not for the front-end's own worker, nor when play was never reached", async () => {
    const racing = { run: { ...run, game: { kind: "racing" } } };
    const kept = stubCtx({ frames: ["a", "b", "c"], ...frontEnd() });
    await gather(kept.ctx, { ...racing, setup: { begin: false } });
    assert.equal(heldThrough(kept.calls, ["w", "ArrowUp"]), null, "a menu held on W for the whole drive");
    const stuck = stubCtx({ frames: ["a", "b", "c"], ...frontEnd({ countdownSteps: Number.POSITIVE_INFINITY }) });
    await gather(stuck.ctx, racing);
    assert.equal(heldThrough(stuck.calls, ["w", "ArrowUp"]), null);
    const raced = stubCtx({ frames: ["a", "b", "c"], ...frontEnd() });
    await gather(raced.ctx, racing);
    assert.ok(heldThrough(raced.calls, ["w", "ArrowUp"]), "in play, the racer still cruises");
  });

  it("tells the judges of a kept front-end that nothing was pressed, not to look for dead input", async () => {
    const kept = stubCtx({ frames: ["a", "b", "c"], ...frontEnd() });
    const game = { kind: "racing" };
    const evidence = await gather(kept.ctx, { run: { ...run, game }, setup: { begin: false } });
    assert.equal(evidence.play?.via, "kept");
    const recorder = ctxRecorder({
      handlers: { "engine.complete": () => ({ message: { content: '{"pick":"A"}' } }) },
    });
    const judged = { ...run, goal: "a racer", game, budgets: { wallClockMs: 1000 } } as never;
    await blindCompare(recorder.ctx, { run: judged, challenger: evidence, incumbentEvidence: evidence });
    const asked = JSON.stringify(recorder.paramsOf("engine.complete")[0]?.messages);
    assert.doesNotMatch(asked, /holds W\/ArrowUp/, "the judge is not told about a drive that did not happen");
    assert.doesNotMatch(asked, /report \[dead-input\] only if/);
    assert.match(asked, /pressed nothing/);
    assert.match(asked, /\[dead-input\] does not apply/);
    // A build driven in play is still described as driven.
    assert.match(gameLine(game), /then holds W\/ArrowUp through the rest of the drive/);
    assert.match(gameLine(game, { kept: false }), /report \[dead-input\] only if/);
  });

  it("drives no controls at all into a kept front-end, not the kind's nor the game's gameplay script", async () => {
    // A title that starts on any key would be started by the racing exercise's own throttle, and
    // its owner judged on a countdown instead of the title it is building.
    const kept = stubCtx({ frames: ["a", "b", "c"], ...frontEnd() });
    const evidence = await gather(kept.ctx, { run: { ...run, game: { kind: "racing" } }, setup: { begin: false } });
    const inputs = sequence(kept.calls).filter((word) => word.startsWith("input:"));
    assert.deepEqual(inputs, [], "the front-end's owner is judged on its menu, untouched");
    assert.equal(evidence.play?.via, "kept");
    // The clock still runs through the drive, so the title is seen moving.
    assert.ok(kept.calls.some((c) => c.payload.method === "step" && c.payload.arg !== 240));
    const playScript = [{ type: "tap", keys: ["Enter"] }];
    const declared = stubCtx({ frames: ["a", "b", "c"], ...frontEnd() });
    await gather(declared.ctx, { run: { ...run, game: { kind: "racing", playScript } }, setup: { begin: false } });
    const taps = sequence(declared.calls).filter((word) => word.startsWith("input:"));
    // The declared script is written for play: its first Enter would start the title too.
    assert.deepEqual(taps, [], "a gameplay script does not reach the front-end either");
  });

  it("quotes what begin() answered when it would not take the game into play", async () => {
    const game = frontEnd();
    const refusing = (method: string) =>
      method === "begin" ? { ok: false, reason: "the track failed to load" } : game.page(method);
    const evidence = await gather(stubCtx({ frames: ["a", "b", "c"], ...game, page: refusing }).ctx);
    const said = evidence.warnings.find((w: string) => /outside play/.test(w)) ?? "";
    assert.match(said, /the track failed to load/);
    assert.doesNotMatch(said, /has no __studio\.begin\(\)/);
  });

  it("cruises on a racer's own script whichever word the plan used for it", () => {
    assert.deepEqual(cruiseFor({ kind: "racing", play: [{ type: "tap", keys: ["x"] }] }), []);
  });

  it("keeps the verified path when it reads the requested state, and calls a cut one unmeasured", async () => {
    const cut = () => ({
      maps: { __elided: "object", length: 900, chars: 60_000 },
      __cut: { chars: 90_000, paths: ["maps"] },
    });
    const { ctx, calls } = stubCtx({ frames: ["a"], state: cut });
    const outcome = await applySetup(ctx as never, { verify: { path: "maps.activeId", equals: "macba" }, settleMs: 1 });
    assert.equal(outcome.reached, null, outcome.reason);
    const read = calls.find((c) => c.method === "preview.state");
    assert.deepEqual(read?.payload.keep, ["maps.activeId"]);
    const whole = stubCtx({ frames: ["a"], state: () => ({ maps: { activeId: "street" } }) });
    const wrong = await applySetup(whole.ctx as never, {
      verify: { path: "maps.activeId", equals: "macba" },
      settleMs: 1,
    });
    assert.equal(wrong.reached, false, "a state read whole and wrong is still not reached");
  });
});

/**
 * What a racer's judges must see: every registered demo's end (a builder's new demo above all),
 * a frame of a corner, a drive the game's racing line steers rather than one held into a wall, and
 * whether a bot that only holds the throttle wins the race.
 */
const RACER_DEMOS = [
  "title",
  "countdown",
  "race-finish",
  "rival-battle",
  "contact",
  "drift",
  "drift-hold",
  "wall-scrape",
  "top-speed",
  "rain-spray",
];

/** Frames that never repeat, so no retake hides a demo frame. */
const uniqueFrames = (n: number): string[] => Array.from({ length: n }, (_, i) => `frame-${i}`);

/** What the pass handed one page verb, call by call, in order. */
function pageCalls(calls: Array<{ method: string; payload: Record<string, unknown> }>, method: string): unknown[] {
  return calls.filter((c) => c.method === "preview.call" && c.payload.method === method).map((c) => c.payload.arg);
}

/**
 * A racer on a course as the evidence pass sees it: a car that gains ground while W is held in play,
 * turns into a corner after `cornerAfter` drive steps, and finishes a race of `raceMs` simulated
 * milliseconds in `position`. It reports its race and its heading only when told to.
 */
function racer({
  cornerAfter = 10,
  raceMs = 200_000,
  position = 1,
  reportsRace = true,
  reportsHeading = true,
  assist = true,
}: {
  cornerAfter?: number;
  raceMs?: number;
  position?: number;
  reportsRace?: boolean;
  reportsHeading?: boolean;
  assist?: boolean;
} = {}) {
  let playing = false;
  let raced = 0;
  let driveSteps = 0;
  const held = new Set<string>();
  const assists: unknown[] = [];
  const yaw = () => (driveSteps > cornerAfter ? (driveSteps - cornerAfter) * 0.6 : 0);
  return {
    assists,
    state: () => ({
      version: 2,
      flow: { phase: playing ? "playing" : "menu", playing },
      player: { x: raced, z: 0, yaw: reportsHeading ? yaw() : 0 },
      ...(reportsRace ? { race: { position, finished: raced >= raceMs, lap: 1 } } : {}),
    }),
    evaluate: (expression: string) =>
      expression.includes("studio corner probe") ? { yaw: reportsHeading ? yaw() : null, steer: null } : false,
    page: (method: string, arg: unknown): unknown => {
      if (method === "seed") {
        playing = false;
        raced = 0;
        driveSteps = 0;
        held.clear();
        return 1;
      }
      if (method === "begin") {
        playing = true;
        return { ok: true, flow: { phase: "playing", playing: true } };
      }
      if (method === "assist") {
        assists.push(arg);
        const steer = (arg as { steer?: boolean } | null)?.steer === true;
        return assist ? { ok: true, steer } : { ok: false, reason: "no config.steer" };
      }
      if (method !== "step") return undefined;
      if (arg === 960) driveSteps += 1;
      if (playing && held.has("w")) raced += Number(arg);
      return { frame: 1 };
    },
    input: (actions: Array<Record<string, unknown>>) => {
      for (const action of actions) {
        const keys = (action.keys ?? []) as string[];
        if (action.type === "down") for (const key of keys) held.add(key);
        if (action.type === "up") for (const key of keys) held.delete(key);
      }
    },
  };
}

const racingRun = { run: { ...run, game: { kind: "racing" } } };
/** The frame the drive takes of a corner, in its wire spelling (pass-frames.ts `CORNER_CAMERA`). */
const CORNER_CAMERA = "drive:corner";
const throttleBot = (): Check => ({ id: "throttle-bot-loses", ...HARNESS_CHECKS["throttle-bot-loses"] }) as Check;

describe("judges get the evidence they need", () => {
  it("photographs the end of every registered demo", async () => {
    const { ctx } = stubCtx({ frames: uniqueFrames(40), cameras: ["default", "pack"], demos: RACER_DEMOS });
    const evidence = await gather(ctx, { requiredDemos: ["rival-battle"] });
    assert.deepEqual(evidence.skippedDemos, [], "the cap of three left contact unseen for four rounds");
    const demoFrames = cameraList(evidence).filter((camera) => camera.startsWith("demo:"));
    assert.equal(demoFrames.length, RACER_DEMOS.length, demoFrames.join(", "));
    assert.ok(demoFrames.includes("demo:contact"));
  });

  it("a vision check on demo:<name> waits on that demo, so the cap can never drop it", () => {
    const checks = [
      { id: "contact-reads", kind: "vision", camera: "demo:rival-battle", ask: "Is the contact physical?" },
      { id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.2" },
    ] as Check[];
    assert.deepEqual(demosNamedByChecks(checks), ["rival-battle"]);
  });

  it("a capped look runs the build's new demos first, and tells the judge and the builder what it left out", async () => {
    const { ctx, calls } = stubCtx({
      frames: uniqueFrames(20),
      cameras: ["default"],
      demos: ["title", "countdown", "race-finish", "contact"],
    });
    const evidence = await gather(ctx, { maxDemos: 2, knownDemos: ["title", "countdown", "race-finish"] });
    assert.deepEqual(pageCalls(calls, "demo"), ["contact", "title"], "the demo this build added comes first");
    assert.deepEqual(evidence.skippedDemos, ["countdown", "race-finish"]);
    assert.equal(evidence.demoCap, 2);
    // The cap is the harness's, never a defect a judge may name as the gap: not a warning.
    assert.ok(!evidence.warnings.some((w: string) => /race-finish/.test(w)), evidence.warnings.join("; "));
    const recorder = ctxRecorder({
      handlers: { "engine.complete": () => ({ message: { content: '{"pick":"A"}' } }) },
    });
    const judged = { ...run, goal: "a racer", budgets: { wallClockMs: 1000 } } as never;
    await blindCompare(recorder.ctx, { run: judged, challenger: evidence, incumbentEvidence: evidence });
    const asked = JSON.stringify(recorder.paramsOf("engine.complete")[0]?.messages);
    assert.match(
      asked,
      /demos registered but not photographed this pass \(a look runs every demo a check names and at most 2 more; unmeasured, not the build's defect\): countdown, race-finish/,
    );
  });

  it("the builder is told which of its demos its last look left unphotographed", () => {
    const lastAttempt = { won: false, flips: [], why: "no check moved", skippedDemos: ["contact", "drift-hold"] };
    const prompt = facetPrompt({
      resumed: true,
      run: { runId: "run_nfs", goal: "a street race" },
      spec: { id: "rivals-race", title: "Rivals", checks: [] },
      iteration: 3,
      lastAttempt,
    });
    assert.match(prompt, /did not photograph the demos contact, drift-hold/);
    assert.match(prompt, /name one in a check/);
    const quiet = facetPrompt({
      resumed: true,
      run: { runId: "run_nfs", goal: "a street race" },
      spec: { id: "rivals-race", title: "Rivals", checks: [] },
      iteration: 3,
      lastAttempt: { ...lastAttempt, skippedDemos: [] },
    });
    assert.doesNotMatch(quiet, /did not photograph/);
  });

  it("a facet camera that is a demo's frame or the drive's corner is never asked of debugCamera", async () => {
    const { ctx, calls } = stubCtx({ frames: uniqueFrames(20), cameras: ["default", "pack"], demos: ["rival-battle"] });
    const evidence = await gather(ctx, {
      cameras: ["pack", "demo:rival-battle", "drive:corner"],
      requiredDemos: ["rival-battle"],
    });
    const asked = pageCalls(calls, "debugCamera");
    assert.ok(!asked.includes("demo:rival-battle"), asked.join(", "));
    assert.ok(!asked.includes("drive:corner"), asked.join(", "));
    assert.deepEqual(evidence.missingCameras, []);
    assert.equal(cameraList(evidence).filter((camera) => camera === "demo:rival-battle").length, 1);
  });

  it("photographs the turn-in of a racer's first corner", async () => {
    const game = racer({ cornerAfter: 10 });
    const { ctx, calls } = stubCtx({ frames: uniqueFrames(20), ...game });
    const evidence = await gather(ctx, racingRun);
    assert.equal(evidence.ok, true, evidence.problems.join("; "));
    const corner = evidence.shots.find((shot: { camera: string }) => shot.camera === CORNER_CAMERA);
    assert.ok(corner, `no corner frame among ${cameraList(evidence).join(", ")}`);
    assert.equal(evidence.corner?.seen, true);
    assert.ok(Number(evidence.corner?.turnDegPerSecond) > 20, JSON.stringify(evidence.corner));
    const labels = calls.filter((c) => c.method === "preview.screenshot").map((c) => String(c.payload.label));
    assert.ok(
      labels.some((label) => label.endsWith("/screenshots/drive-corner")),
      labels.join(", "),
    );
  });

  it("a racer that never turns or reports nothing gets no corner frame, never a failure, and a walker is not watched", async () => {
    const straight = stubCtx({ frames: uniqueFrames(20), ...racer({ cornerAfter: 1_000 }) });
    const flat = await gather(straight.ctx, racingRun);
    assert.equal(flat.ok, true, flat.problems.join("; "));
    assert.equal(cameraList(flat).includes(CORNER_CAMERA), false);
    assert.deepEqual(flat.corner, { seen: false, turnDegPerSecond: 0 });
    const blind = stubCtx({ frames: uniqueFrames(20), ...racer({ reportsHeading: false }) });
    const unread = await gather(blind.ctx, racingRun);
    assert.equal(unread.ok, true, unread.problems.join("; "));
    assert.equal(unread.corner?.seen, false);
    assert.equal(unread.corner?.unreadable, true);
    const walker = stubCtx({ frames: uniqueFrames(20), ...racer() });
    const walked = await gather(walker.ctx, { run: { ...run, game: { kind: "first-person" } } });
    assert.equal(walked.corner, undefined);
    const probed = walker.calls.filter((c) => String(c.payload.expression ?? "").includes("studio corner probe"));
    assert.deepEqual(probed, [], "a walker's drive is not watched for corners");
  });

  it("steers the cruise by the game's racing line", async () => {
    const game = racer({ cornerAfter: 1_000 });
    const { ctx, calls } = stubCtx({ frames: uniqueFrames(20), ...game });
    const evidence = await gather(ctx, racingRun);
    const words = calls.map((c) =>
      c.method === "preview.call" ? `call:${c.payload.method}:${JSON.stringify(c.payload.arg ?? null)}` : c.method,
    );
    const cruise = calls.findIndex(
      (c) => c.method === "preview.input" && JSON.stringify(c.payload.actions).includes('"down"'),
    );
    const on = words.indexOf('call:assist:{"steer":true}');
    const off = words.indexOf('call:assist:{"steer":false}');
    const firstCamera = words.indexOf('call:debugCamera:"default"');
    assert.ok(cruise >= 0 && cruise < on, words.join(" "));
    assert.ok(on < off && off < firstCamera, "steered through the drive, let go before the cameras");
    assert.deepEqual(evidence.drive, { steered: true });
    // A racer with no helper is driven exactly as before: the throttle held, nothing steered.
    const plain = stubCtx({ frames: uniqueFrames(20), ...racer({ cornerAfter: 1_000, assist: false }) });
    const unsteered = await gather(plain.ctx, racingRun);
    assert.deepEqual(unsteered.drive, { steered: false });
    assert.ok(heldThrough(plain.calls, ["w", "ArrowUp"]), "the throttle is still held");
    // A walker is not steered at all.
    const walker = stubCtx({ frames: uniqueFrames(20), ...racer() });
    await gather(walker.ctx, { run: { ...run, game: { kind: "first-person" } } });
    assert.deepEqual(pageCalls(walker.calls, "assist"), []);
  });

  it("races the throttle-only bot, and the harness check fails when it wins", async () => {
    const game = racer({ cornerAfter: 1_000, raceMs: 226_600, position: 1 });
    const { ctx, calls } = stubCtx({ frames: uniqueFrames(20), ...game });
    const evidence = await gather(ctx, { ...racingRun, challenge: true });
    assert.equal(evidence.challenge?.ran, true, JSON.stringify(evidence.challenge));
    assert.equal(evidence.challenge?.finished, true);
    assert.equal(evidence.challenge?.position, 1);
    assert.equal(evidence.challenge?.steered, true);
    assert.ok(Number(evidence.challenge?.simulatedMs) >= 226_600, JSON.stringify(evidence.challenge));
    const bot = evaluateProbeCheck(throttleBot(), evidence);
    assert.equal(bot.pass, false, bot.reason);
    // The bot holds the throttle and nothing else: no brake, no handbrake, and lets go after.
    const pressed = calls
      .filter((c) => c.method === "preview.input")
      .flatMap((c) => (c.payload.actions as Array<{ keys?: string[] }>).flatMap((a) => a.keys ?? []));
    assert.ok(!pressed.some((key) => /^(s|ArrowDown|space|Space)$/.test(key)), pressed.join(","));
    assert.deepEqual(game.assists.at(-1), { steer: false });
    // A field that beats it passes.
    const beaten = stubCtx({ frames: uniqueFrames(20), ...racer({ cornerAfter: 1_000, position: 3 }) });
    const fair = await gather(beaten.ctx, { ...racingRun, challenge: true });
    assert.equal(evaluateProbeCheck(throttleBot(), fair).pass, true);
  });

  it("the challenge race is bounded, skipped for a game with no race result, and never run unasked", async () => {
    const endless = stubCtx({
      frames: uniqueFrames(20),
      ...racer({ cornerAfter: 1_000, raceMs: Number.POSITIVE_INFINITY }),
    });
    const timedOut = await gather(endless.ctx, { ...racingRun, challenge: true });
    assert.equal(timedOut.challenge?.finished, false);
    assert.ok(Number(timedOut.challenge?.simulatedMs) <= 6 * 60_000, JSON.stringify(timedOut.challenge));
    assert.equal(evaluateProbeCheck(throttleBot(), timedOut).pass, false, "leading when the time ran out is winning");
    const noRace = stubCtx({ frames: uniqueFrames(20), ...racer({ reportsRace: false }) });
    const skipped = await gather(noRace.ctx, { ...racingRun, challenge: true });
    assert.equal(skipped.challenge?.ran, false);
    assert.equal(evaluateProbeCheck(throttleBot(), skipped).pass, null, "a game that reports no race is not failed");
    const unasked = stubCtx({ frames: uniqueFrames(20), ...racer({ cornerAfter: 1_000 }) });
    const plain = await gather(unasked.ctx, racingRun);
    assert.equal(plain.challenge, undefined);
    assert.equal(evaluateProbeCheck(throttleBot(), plain).pass, null);
  });
});
