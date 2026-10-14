/**
 * The loop's modes on a Rust · wgpu game (plan M3.3, the per-mode table).
 *
 * Before Rust games every mode told stacks apart with one raylib equality, so a Rust game fell
 * through to the three.js rules without a word: its scene checks asked a page that has no scene
 * graph, its board carried DOM checks, a frameless look left its vision checks unasked, the
 * gauntlet looked at it with no lease, and a spike built it a three.js page. Each row below drives
 * the entry point one mode scores, plans or looks through with a Rust game, and holds it to the
 * Rust row of the per-stack capability table (native-contract.ts `STACK_CHECK_SUPPORT`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runDeterministicChecks, PARITY_CHECK_ID } from "../../src/harness-seed/loop/checks.ts";
import { renderCatalogueForPlanner, withHarnessChecks, type Check } from "../../src/harness-seed/loop/spec.ts";
import { visionCheck } from "../../src/harness-seed/loop/judge.ts";
import { compileWorkerSpec } from "../../src/harness-seed/loop/director/rules.ts";
import { runSpike, spikeLocation } from "../../src/harness-seed/loop/spike.ts";
import * as gauntlet from "../../src/harness-seed/loop/gauntlet.ts";
import * as checksParts from "../../src/harness-seed/loop/checks.ts";
import * as specParts from "../../src/harness-seed/loop/spec.ts";
import * as judgeParts from "../../src/harness-seed/loop/judge.ts";
import * as spikeParts from "../../src/harness-seed/loop/spike.ts";
import * as optimizationParts from "../../src/harness-seed/loop/optimization.ts";
import * as gauntletParts from "../../src/harness-seed/loop/gauntlet.ts";
import {
  BuildTarget,
  CheckSupport,
  GameStack,
  NativeRefusal,
  ProjectKind,
  STACK_CHECK_SUPPORT,
  StudioPlatform,
  TargetRefusal,
  servesRust,
} from "../../src/harness-seed/loop/native-contract.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import type { HarnessCtx, Run } from "../../src/harness-seed/types/harness.d.ts";

type Stack = (typeof GameStack)[keyof typeof GameStack];
const RUST = GameStack.RustWgpu;
/** Read off the module, so a seed without the vocabulary fails its rows rather than the whole file. */
const { SpikeRefusal } = spikeParts;
const STACKS = Object.values(GameStack) as Stack[];

/** One check of every kind, each with a body its evaluator can read. */
const BODIES: Record<string, Record<string, unknown>> = {
  scene: { js: "true" },
  pixel: { camera: "default", expr: "meanLuma > 0" },
  metric: { camera: "default", metric: "meanLuma", goal: "min", target: 1 },
  probe: { expr: "score >= 0" },
  demo: { demo: "dash" },
  vision: { ask: "is there a dash?", expect: "yes" },
  play: { ask: "can you dash?", expect: "yes" },
};
const everyKind = (): Check[] =>
  Object.keys(BODIES).map((kind) => ({ id: `c-${kind}`, kind, weight: "normal", ...BODIES[kind] }) as unknown as Check);

const run = (stack: Stack | null): Run =>
  ({
    runId: "run_modes",
    project: "pond",
    goal: "a pond",
    engine: "claude-code",
    reference: { name: "", shots: [] },
    budgets: { wallClockMs: 60_000 },
    ...(stack ? { stack } : {}),
  }) as Run;

/** The recorder as the seed's ctx: the one cast these rows make. */
const asCtx = (ctx: unknown): HarnessCtx => ctx as HarnessCtx;

describe("the per-stack capability table, as every mode scores a board (facet loop, autopilot, rounds, director)", () => {
  for (const stack of STACKS) {
    it(`scores each kind on a ${stack} game by its row of STACK_CHECK_SUPPORT`, async () => {
      const recorder = ctxRecorder({ handlers: { "preview.evaluate": () => ({ value: true }) } });
      const { results, pending } = await runDeterministicChecks(asCtx(recorder.ctx), {
        spec: { checks: everyKind() },
        evidence: { state: { score: 1 }, shots: [], demos: {} },
        handle: "h1",
        stack,
      });
      for (const [kind, support] of Object.entries(STACK_CHECK_SUPPORT[stack])) {
        const scored = results.find((entry) => entry.kind === kind);
        if (support === CheckSupport.Unmeasured) {
          assert.equal(scored?.pass, null, `${kind} is unmeasured on ${stack}: ${JSON.stringify(scored)}`);
          assert.equal(scored?.state, "unmeasured");
        } else if (kind === "vision" || kind === "play") {
          assert.ok(
            pending.some((check) => check.kind === kind),
            `${kind} goes to its model on ${stack}`,
          );
        } else assert.notEqual(scored, undefined, `${kind} is measured on ${stack}`);
      }
      const asked = recorder.paramsOf("preview.evaluate").length > 0;
      assert.equal(asked, STACK_CHECK_SUPPORT[stack].scene === CheckSupport.Measured, `${stack}: the page is asked`);
    });
  }

  it("scores a Rust look's scene checks unmeasured when the caller names no stack: the evidence does", async () => {
    const recorder = ctxRecorder({ handlers: { "preview.evaluate": () => ({ value: true }) } });
    const scene = { id: "one-hud", kind: "scene", weight: "identity", js: "count('hud') === 1" } as unknown as Check;
    const { results } = await runDeterministicChecks(asCtx(recorder.ctx), {
      spec: { checks: [scene] },
      evidence: { stack: RUST, shots: [] },
      handle: "h1",
    });
    assert.equal(results[0]?.pass, null, JSON.stringify(results));
    assert.deepEqual(recorder.paramsOf("preview.evaluate"), [], "no JS reaches a game with no scene graph");
  });

  it("fails a Rust look's vision and play checks when no frame was captured: it is judged on its frames", async () => {
    const recorder = ctxRecorder();
    const frameless = everyKind().filter((check) => check.kind === "vision" || check.kind === "play");
    const { results, pending } = await runDeterministicChecks(asCtx(recorder.ctx), {
      spec: { checks: frameless },
      evidence: { stack: RUST, shots: [], captureFailed: true },
    });
    assert.deepEqual(pending, [], "nothing is left for a judge to look at");
    assert.deepEqual(
      results.map((entry) => entry.pass),
      [false, false],
      JSON.stringify(results),
    );
    assert.ok(
      results.every((entry) => /Rust · wgpu/.test(entry.reason)),
      "the reason names the stack",
    );
  });

  it("fails a Rust night's uncaptured vision question instead of leaving it unasked (judge)", async () => {
    const recorder = ctxRecorder();
    const check = { id: "lit", kind: "vision", weight: "identity", camera: "default", ask: "lit?" } as unknown as Check;
    const rust = await visionCheck(asCtx(recorder.ctx), { run: run(RUST), check, crop: null });
    assert.equal(rust.pass, false, JSON.stringify(rust));
    assert.match(rust.reason, /Rust · wgpu/);
    const three = await visionCheck(asCtx(recorder.ctx), { run: run(GameStack.ThreeJs), check, crop: null });
    assert.equal(three.pass, null, "a three.js night's uncaptured question stays unmeasured");
  });
});

describe("the boards a Rust game's planner and director are offered", () => {
  const hud = { kind: "first-person", traits: { hud: true } };
  const screenChecks = ["no-dom-ui", "single-hud"];

  it("carries no DOM screen checks on a Rust board, even when the plan wrote them (spec)", () => {
    const planned = { id: "dash", checks: [{ id: "single-hud", kind: "scene", js: "count('hud') === 1" }] as Check[] };
    const ids = withHarnessChecks(planned, { ownsMain: true, game: hud, stack: RUST }).checks.map((c) => c.id);
    for (const id of screenChecks) assert.ok(!ids.includes(id), `${id} is off a Rust board: ${JSON.stringify(ids)}`);
  });

  it("offers a planner a catalogue check of a kind only when its stack's row measures that kind", () => {
    const checks = Object.fromEntries(
      Object.keys(BODIES).map((kind) => [`seeded-${kind}`, { kind, note: `a ${kind} check` }]),
    );
    for (const stack of STACKS) {
      const menu = renderCatalogueForPlanner({ checks }, { stack });
      for (const [kind, support] of Object.entries(STACK_CHECK_SUPPORT[stack])) {
        const offered = new RegExp(`"seeded-${kind}"`).test(menu);
        assert.equal(offered, support === CheckSupport.Measured, `${stack} offers ${kind}: ${support}`);
      }
    }
  });

  it("compiles a director's Rust worker board with no DOM screen checks (director)", () => {
    const board = compileWorkerSpec({
      id: "dash",
      owns: ["src/facets/dash.rs"],
      kind: "first-person",
      traits: ["hud"],
      stack: RUST,
    }).spec.checks.map((c: { id: string }) => c.id);
    for (const id of screenChecks) assert.ok(!board.includes(id), `${id} is off the board: ${JSON.stringify(board)}`);
  });
});

describe("a Rust game's parity rows", () => {
  /** A destination's gate whose rows all passed, or whose ready row was refused `refusal`. */
  const gate = (target: string, refusal: string | null) => ({
    target,
    pass: refusal ? false : true,
    reason: refusal ? `ready: refused ${refusal}` : "",
    rows: [
      { row: "admission", pass: true, reason: "", refusal: null },
      refusal
        ? { row: "ready", pass: false, reason: `refused ${refusal}`, refusal }
        : { row: "ready", pass: true, reason: "", refusal: null },
    ],
  });
  const parityRow = async (targets: ReturnType<typeof gate>[]) => {
    const failing = targets.find((target) => target.pass === false);
    const settled = targets.every((target) => target.pass === true);
    const parity = {
      pass: failing ? false : settled || null,
      reason: failing ? `${failing.target}: ${failing.reason}` : "",
      refusal: null,
      targets,
    };
    const { results } = await runDeterministicChecks(asCtx(ctxRecorder().ctx), {
      spec: { checks: [] },
      evidence: { stack: RUST, shots: [], parity: parity as never },
    });
    return results.find((entry) => entry.id === PARITY_CHECK_ID);
  };

  it("records a web parity row refused gpu-unsupported as unavailable; the native verdict stands", async () => {
    const row = await parityRow([gate(BuildTarget.Mac, null), gate(BuildTarget.Web, NativeRefusal.GpuUnsupported)]);
    assert.equal(row?.pass, true, `the Mac build passed its gate: ${JSON.stringify(row)}`);
    assert.deepEqual(row?.unavailableTargets, [BuildTarget.Web]);
  });

  it("keeps a native failure a failure beside an unavailable web row", async () => {
    const row = await parityRow([
      gate(BuildTarget.Mac, NativeRefusal.ReadyTimeout),
      gate(BuildTarget.Web, NativeRefusal.GpuUnsupported),
    ]);
    assert.equal(row?.pass, false, JSON.stringify(row));
    assert.match(String(row?.reason), /macos/);
  });

  it("records a gate whose only destination is a web build without WebGPU as unavailable, never failed", async () => {
    const row = await parityRow([gate(BuildTarget.Web, NativeRefusal.GpuUnsupported)]);
    assert.equal(row?.pass, null, JSON.stringify(row));
    assert.equal(row?.unavailable, true);
  });

  it("still fails a native destination refused gpu-unsupported: only the web parity row is a preview's limit", async () => {
    const row = await parityRow([gate(BuildTarget.Mac, NativeRefusal.GpuUnsupported)]);
    assert.equal(row?.pass, false, JSON.stringify(row));
  });

  it("leaves a gate refused not-runnable-here unavailable, as before Rust games", async () => {
    const refused = { row: "admission", pass: null, reason: "", refusal: TargetRefusal.NotRunnableHere };
    const unrun = { target: BuildTarget.Windows, pass: null, reason: "", rows: [refused] };
    const row = await parityRow([unrun as never]);
    assert.equal(row?.unavailable, true, JSON.stringify(row));
  });
});

describe("gauntlet, optimization and spike with a Rust game", () => {
  it("looks at a Rust gauntlet build through a lease naming its judging target (gauntlet)", async () => {
    const recorder = ctxRecorder({
      unknown: { value: null },
      handlers: {
        "game.list": () => [{ name: "pond", destinations: { stack: RUST, targets: [BuildTarget.Mac] } }],
        "preview.capacity": () => ({ max: 4, inUse: 0, host: StudioPlatform.Mac, native: { gameBox: true } }),
        "preview.acquire": () => ({ handle: "lease-1" }),
      },
    });
    assert.equal(typeof gauntlet.lookAt, "function", "the gauntlet's look is reachable");
    await gauntlet.lookAt(asCtx(recorder.ctx), run(RUST), { iterationId: "001", seed: 1 }).catch(() => null);
    const leases = recorder.paramsOf("preview.acquire");
    assert.equal(leases.length, 1, JSON.stringify(recorder.sequence()));
    assert.equal(leases[0]?.target, BuildTarget.Mac, "a Mac-only Rust game is judged on its Mac build");
    assert.equal(leases[0]?.label, "gauntlet:run_modes");
  });

  it("refuses a Rust spike rust-spike-unbuilt before anything is opened (spike)", async () => {
    const shape = { kind: ProjectKind.RustWgpu, main: "src/main.rs" };
    const location = spikeLocation({ id: "lit", shape });
    assert.equal(location.code, SpikeRefusal.RustSpikeUnbuilt);
    assert.equal(SpikeRefusal.RustSpikeUnbuilt, "rust-spike-unbuilt");
    assert.match(String(location.refused), /Rust · wgpu/);
    const recorder = ctxRecorder({ handlers: { "engine.describe": () => [] } });
    const check = { id: "lit", kind: "pixel", weight: "identity", camera: "default", expr: "meanLuma > 0.3" };
    const outcome = await runSpike(asCtx(recorder.ctx), {
      run: run(RUST),
      spec: { id: "pond", title: "Pond", intent: "a pond", owns: [], checks: [check] } as never,
      check: check as unknown as Check,
      worktree: "/fake/wt",
      iteration: 3,
      facetThreadId: "t-facet",
      shape,
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.refusal, SpikeRefusal.RustSpikeUnbuilt);
    // The builder's engine is described, as for every spike; no worktree, snapshot or turn follows.
    assert.deepEqual(recorder.sequence(), ["engine.describe"], "nothing is opened for a spike nothing can look at");
  });

  it("keeps a raylib spike refused by its own code, and a three.js spike open", () => {
    const raylib = spikeLocation({ id: "lit", shape: { kind: ProjectKind.RaylibCpp, main: "src/main.cpp" } });
    assert.equal(raylib.code, SpikeRefusal.NativeSpikeUnbuilt);
    const three = spikeLocation({ id: "lit", shape: { kind: ProjectKind.ThreeModules } });
    assert.equal(three.code, null);
    assert.equal(three.refused, null);
  });

  it("marks every part this table covers SERVES_RUST, so a Rust night may run on them", () => {
    const parts = [checksParts, specParts, judgeParts, spikeParts, optimizationParts, gauntletParts];
    assert.equal(servesRust(parts), true);
  });
});
