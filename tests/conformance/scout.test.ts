/**
 * The scout and the requested state, so facets never build and judge the wrong map because
 * nothing had opened the game first:
 *
 *  1. the scout's answer is normalised into a setup the studio can replay and a builder count
 *     the planner must respect;
 *  2. the planner's ask carries the scout report, and a plan that splits past the ceiling is
 *     folded back — at one builder, into one facet that keeps every check;
 *  3. every evidence pass replays the setup before anyone looks and says when it did not land;
 *  4. every board carries the requested-state probe.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeScoutReport,
  normalizeScoutSetup,
  renderScoutForPlanner,
  runScout,
  scoutBrief,
  setupVerifyExpr,
} from "../../src/harness-seed/loop/scout.ts";
import { clampFacets, decompose } from "../../src/harness-seed/loop/autopilot.ts";
import { applySetup, gatherEvidence } from "../../src/harness-seed/loop/gauntlet.ts";
import { normalizeFacetSpec, withRequestedStateCheck } from "../../src/harness-seed/loop/spec.ts";
import { evaluateProbeCheck } from "../../src/harness-seed/loop/checks.ts";
import { workerSetupOf } from "../../src/harness-seed/loop/director/workers.ts";

const REPORT = {
  seen: "Downtown Block: a brick street, sunset, the skater at spawn.",
  requested: "The MACBA plaza — reached through the map picker on I.",
  setup: {
    actions: [
      { type: "tap", keys: ["i"] },
      { type: "wait", ms: 400 },
      { type: "click", x: 480, y: 300, px: true },
    ],
    verify: { path: "maps.activeId", equals: "macba" },
    note: "I opens the picker, the second card is MACBA",
  },
  reachedRequested: true,
  files: ["src/main.ts", "src/world/after-rain/index.ts"],
  already: ["the plaza with eight puddles"],
  risks: ["the picker swallows WASD while open"],
  workers: { count: 1, why: "one plaza, one look — parallel builders would edit the same modules" },
  seams: [],
};

describe("the scout's report", () => {
  it("is normalised into a replayable setup and a builder ceiling", () => {
    const report = normalizeScoutReport(REPORT) as any;
    assert.ok(report);
    assert.equal(report!.setup!.actions!.length, 3);
    assert.deepEqual(report!.setup!.verify, { path: "maps.activeId", equals: "macba" });
    assert.deepEqual(report!.workers, { count: 1, why: REPORT.workers.why });
    assert.equal(normalizeScoutReport({ setup: { actions: [{ type: "teleport" }] } }), null, "nothing usable is null");
    assert.equal(
      (normalizeScoutReport({ workers: { count: 40 } }) as any).workers.count,
      12,
      "the ceiling has a ceiling",
    );
    assert.equal(setupVerifyExpr(report!.setup!.verify), 'has("maps.activeId") && maps.activeId == "macba"');
  });

  it("reads to the planner as data with the ceiling spelled out", () => {
    const text = renderScoutForPlanner(normalizeScoutReport(REPORT));
    assert.match(text, /SCOUT REPORT/);
    assert.match(text, /BUILDERS: 1/);
    assert.match(text, /produce exactly one facet/);
    assert.match(text, /maps\.activeId == "macba"/);
    assert.equal(renderScoutForPlanner(null), "");
  });

  it("briefs a read-only session with hands, a time cap and the JSON shape", () => {
    // Spelled for the orchestrator's engine (one engine voice): a Claude scout reads the MCP name.
    const brief = scoutBrief({
      run: { runId: "r", project: "p", goal: "refine the MACBA map", engine: "claude-code" },
      profile: { maxParallel: 6, delegated: true },
    } as never);
    assert.match(brief, /SCOUT/);
    assert.match(brief, /mcp__studio__computer/);
    assert.doesNotMatch(brief, /tool\.mjs/);
    assert.match(brief, /up to 6 builders at once; that is a ceiling, not a target/);
    assert.match(brief, /"workers"/);
  });

  it("runs as a read-only playtest-style delegation on the live folder, and a failure is a note", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const ctx = {
      cancelled: false,
      setStatus: () => {},
      call: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, ...params });
        if (method === "engine.delegate") return { ok: true, summary: `here you go\n${JSON.stringify(REPORT)}` };
        throw new Error(method);
      },
    };
    const run = { runId: "r", project: "skate", goal: "refine the MACBA map", engine: "codex" };
    const scouted = await runScout(
      ctx as never,
      { threadId: "t", run, profile: { maxParallel: 6, delegated: true }, projectDir: "/games/skate" } as never,
    );
    assert.ok(scouted.report);
    assert.equal((scouted.report as any).workers.count, 1);
    const delegation = calls.find((c) => c.method === "engine.delegate")!;
    assert.equal(delegation.readOnly, true);
    assert.equal(delegation.cwd, "/games/skate");
    assert.equal((delegation.playtest as { role: string }).role, "scout");
    // A direct engine skips the scout; a failing engine leaves a note, not a crash.
    const direct = await runScout(
      ctx as never,
      { threadId: "t", run, profile: { maxParallel: 1, delegated: false }, projectDir: "/games/skate" } as never,
    );
    assert.equal(direct.report, null);
    assert.equal(direct.skipped, "direct engine");
    const failing = {
      ...ctx,
      call: async () => {
        throw new Error("boom");
      },
    };
    const failed = await runScout(
      failing as never,
      { threadId: "t", run, profile: { maxParallel: 6, delegated: true }, projectDir: "/games/skate" } as never,
    );
    assert.equal(failed.report, null);
    assert.match(failed.skipped!, /the scout failed: boom/);
  });
});

const PLAN_OF_THREE = {
  facets: ["plaza", "museum", "perimeter"].map((id, i) => ({
    id,
    title: id,
    intent: `${id} work`,
    owns: [`src/${id}.js`],
    cameras: [`cam${i}`],
    checks: [{ id: `${id}-lit`, kind: "pixel", camera: `cam${i}`, expr: "litFraction > 0.5", weight: "identity" }],
    budgetShare: i === 0 ? 0.5 : 0.25,
  })),
  mainOwner: "plaza",
  base: null,
  integrationNotes: "",
  assumptions: [],
};

describe("the planner respects the scout", () => {
  it("carries the scout report in the ask and folds a plan back to the ceiling", async () => {
    let ask = "";
    const ctx = {
      call: async (method: string, params: { messages?: Array<{ content: string }> }) => {
        if (method !== "engine.complete") throw new Error(method);
        ask = params.messages?.[0]?.content ?? "";
        return { message: { role: "assistant", content: JSON.stringify(PLAN_OF_THREE) } };
      },
    };
    const scout = normalizeScoutReport(REPORT);
    const plan = await decompose(
      ctx as never,
      {
        run: { runId: "r", goal: "refine the MACBA map" },
        profile: { maxParallel: 6, delegated: true },
        scout,
      } as never,
    );
    assert.match(ask, /SCOUT REPORT/);
    assert.equal(plan.facets.length, 1, "one builder means one facet");
    assert.equal(plan.facets[0].id, "whole-game");
    assert.equal(plan.facets[0].intent, "refine the MACBA map");
    assert.deepEqual(
      plan.facets[0].checks.map((c: { id: string }) => c.id),
      ["plaza-lit", "museum-lit", "perimeter-lit"],
      "every check survives the fold",
    );
    assert.deepEqual(plan.facets[0].owns, ["src/plaza.js", "src/museum.js", "src/perimeter.js"]);
    assert.equal(plan.mainOwner, "whole-game");
  });

  it("keeps the largest shares when the ceiling is above one", () => {
    const two = clampFacets(
      PLAN_OF_THREE.facets.map((f, i) => normalizeFacetSpec(f, i)),
      2,
      { goal: "g" },
    );
    assert.deepEqual(two.map(((f: { id: string }) => f.id) as never), ["plaza", "museum"]);
    const all = clampFacets(
      PLAN_OF_THREE.facets.map((f, i) => normalizeFacetSpec(f, i)),
      5,
      { goal: "g" },
    );
    assert.equal(all.length, 3, "a ceiling above the plan changes nothing");
  });
});

describe("every look replays the setup", () => {
  function stubCtx(state: Record<string, unknown>) {
    const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const ctx = {
      cancelled: false,
      call: async (method: string, payload: Record<string, unknown> = {}) => {
        calls.push({ method, payload });
        switch (method) {
          case "preview.load":
          case "preview.reload":
            return {};
          case "preview.status":
            return { loadError: null, crashed: false };
          case "preview.state":
            return state;
          case "preview.input":
            return { ok: true, applied: 1, width: 960, height: 600 };
          case "preview.screenshot":
            return { base64: "AAAA", bytes: 4, path: "/runs/x.jpg", stats: null };
          case "preview.console":
          case "preview.gpuErrors":
            return [];
          case "preview.call":
            if (payload.method === "cameras") return ["default"];
            if (payload.method === "demos") return [];
            return { ok: true };
          default:
            return {};
        }
      },
    };
    return { ctx, calls };
  }

  it("presses the keys before the seed and warns when the state did not land", async () => {
    const setup = (normalizeScoutReport(REPORT) as any).setup;
    const wrong = stubCtx({ version: 1, maps: { activeId: "street" }, player: { x: 0, y: 0, z: 0 } });
    const evidence = await gatherEvidence(
      wrong.ctx as never,
      { run: { runId: "r", project: "p", setup }, iterationId: "001", seed: 1, eyes: false, audio: false } as never,
    );
    const inputAt = wrong.calls.findIndex(
      (c) =>
        c.method === "preview.input" &&
        Array.isArray((c.payload as { actions?: unknown[] }).actions) &&
        (c.payload as { actions: Array<{ type: string }> }).actions[0]?.type === "tap",
    );
    const seedAt = wrong.calls.findIndex((c) => c.method === "preview.call" && c.payload.method === "seed");
    assert.ok(inputAt >= 0 && seedAt > inputAt, "the setup script runs before the deterministic seed");
    assert.equal(evidence.requestedState?.reached, false);
    assert.ok(
      evidence.warnings.some((w: string) => /requested state not reached: maps\.activeId is "street"/.test(w)),
      evidence.warnings.join(" | "),
    );
    const right = stubCtx({ version: 1, maps: { activeId: "macba" }, player: { x: 0, y: 0, z: 0 } });
    const landed = await gatherEvidence(
      right.ctx as never,
      { run: { runId: "r", project: "p", setup }, iterationId: "001", seed: 1, eyes: false, audio: false } as never,
    );
    assert.equal(landed.requestedState?.reached, true);
    assert.ok(!landed.warnings.some((w: string) => /requested state/.test(w)));
    const none = stubCtx({ version: 1 });
    const plain = await gatherEvidence(
      none.ctx as never,
      { run: { runId: "r", project: "p" }, iterationId: "001", seed: 1, eyes: false, audio: false } as never,
    );
    assert.equal(plain.requestedState, null, "no setup, nothing replayed");
    // Without a setup nothing is pressed before the seed; the scripted controls come after it.
    const firstInput = none.calls.findIndex((c) => c.method === "preview.input");
    const seed = none.calls.findIndex((c) => c.method === "preview.call" && c.payload.method === "seed");
    assert.ok(firstInput === -1 || firstInput > seed, "no input before the seed without a setup");
  });

  it("runs a demo setup and reports a demo the game does not have", async () => {
    const { ctx, calls } = stubCtx({ version: 1, mode: { museum: true } });
    const result = await applySetup(ctx as never, {
      demo: "open-macba",
      verify: { path: "mode.museum", truthy: true },
    });
    assert.equal(result.applied, true);
    assert.equal(result.reached, true);
    assert.ok(
      calls.some((c) => c.method === "preview.call" && c.payload.method === "demo" && c.payload.arg === "open-macba"),
    );
    const missing = {
      ...ctx,
      call: async (method: string, payload: Record<string, unknown> = {}) =>
        method === "preview.call" && payload.method === "demo"
          ? { ok: false, reason: "no such demo" }
          : ctx.call(method, payload),
    };
    const failed = await applySetup(missing as never, { demo: "nope" });
    assert.match(failed.error!, /did not run: no such demo/);
  });
});

describe("the requested state is on the board", () => {
  it("adds a harness-owned identity probe that fails on the wrong map", () => {
    const spec = normalizeFacetSpec(
      {
        id: "plaza",
        intent: "x",
        checks: [{ id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.5" }],
      },
      0,
    );
    const withState = withRequestedStateCheck(spec, {
      expr: setupVerifyExpr({ path: "maps.activeId", equals: "macba" }),
      note: "I opens the picker",
    } as never);
    const check = withState.checks.find((c: { id: string }) => c.id === "requested-state");
    assert.ok(check);
    assert.equal(check.kind, "probe");
    assert.equal(check.weight, "identity");
    assert.equal(evaluateProbeCheck(check, { state: { maps: { activeId: "street" } } }).pass, false);
    assert.equal(evaluateProbeCheck(check, { state: { maps: { activeId: "macba" } } }).pass, true);
    assert.equal(withRequestedStateCheck(spec, { expr: null }).checks.length, 1, "no probe, no check");
    assert.equal(
      withRequestedStateCheck(withState, { expr: 'has("x")' } as never).checks.filter(
        (c: { id: string }) => c.id === "requested-state",
      ).length,
      1,
      "never twice",
    );
  });
});

// ── what kind of game the scout drove ──────────────────────────────────────────────────────

describe("the scout says what kind of game it just drove", () => {
  it("keeps a validated kind, a normalised play script and a gesture", () => {
    const report = normalizeScoutReport({
      ...REPORT,
      kind: "static-board",
      play: [
        { type: "click", x: 0.5, y: 0.5 },
        { type: "step", ms: 16 },
      ],
    }) as any;
    assert.equal(report.kind, "static-board");
    // The studio owns the clock and the evidence: a plan may not step or pause the game.
    assert.deepEqual(report.play, [{ type: "click", x: 0.5, y: 0.5 }]);
    assert.equal(
      (normalizeScoutReport({ ...REPORT, kind: "roguelike" }) as any).kind,
      null,
      "an unknown kind is no kind",
    );
    // A scout that answered only "this is a side-on game" told the planner something no other
    // source knows; the discard guard must not throw it away.
    assert.equal((normalizeScoutReport({ kind: "side-2d" }) as any)?.kind, "side-2d");
    assert.deepEqual(
      normalizeScoutSetup({ gesture: true }),
      { gesture: true },
      "a setup that is only a gesture survives",
    );
    assert.deepEqual((normalizeScoutSetup({ gesture: { x: 480, y: 300 } }) as any).gesture, { x: 480, y: 300 });
  });

  it("keeps the front-end for the worker that owns it: begin:false is a setup of its own", () => {
    assert.deepEqual(normalizeScoutSetup({ begin: false }), { begin: false }, "the title screen worker's whole setup");
    assert.deepEqual(normalizeScoutSetup({ demo: "pick-map", begin: false }), { demo: "pick-map", begin: false });
    assert.deepEqual(normalizeScoutSetup({ demo: "pick-map", begin: true }), { demo: "pick-map", begin: true });
    for (const begin of ["false", 0, null, {}])
      assert.equal(
        Object.hasOwn(normalizeScoutSetup({ demo: "pick-map", begin } as never) ?? {}, "begin"),
        false,
        JSON.stringify(begin),
      );
    assert.equal(normalizeScoutSetup({ begin: "no" } as never), null, "a begin that is not a boolean sets nothing up");
  });

  it("keeps the run's requested state for the front-end's own worker, and adds only its begin flag", () => {
    const runSetup = {
      actions: [{ type: "tap", keys: ["i"] }],
      verify: { path: "maps.activeId", equals: "macba" },
      note: "I opens the picker",
    };
    assert.deepEqual(
      workerSetupOf({ begin: false }, runSetup),
      { ...runSetup, begin: false },
      "the menu worker is judged on the run's map, on its menu",
    );
    assert.deepEqual(workerSetupOf({ begin: false }, null), { begin: false });
    assert.deepEqual(
      workerSetupOf({ demo: "harbour" }, runSetup),
      { demo: "harbour" },
      "a worker's own state is its own",
    );
    assert.equal(workerSetupOf({ nothing: true }, runSetup), null);
  });

  it("reads to the planner as the kind, and says when the studio must click first", () => {
    const text = renderScoutForPlanner(
      normalizeScoutReport({
        ...REPORT,
        kind: "top-down",
        play: [{ type: "hold", keys: ["w"], ms: 800 }],
        setup: { ...REPORT.setup, gesture: true },
      }),
    );
    assert.match(text, /Kind: top-down/);
    assert.match(text, /hold W for 800 ms/);
    assert.match(text, /the studio clicks once/);
    const brief = scoutBrief({
      run: { runId: "r", project: "p", goal: "a chess board" },
      profile: { maxParallel: 1, delegated: true },
    } as never);
    assert.match(brief, /WHAT KIND OF GAME IS THIS/);
    for (const kind of ["first-person", "top-down", "static-board", "free-camera"])
      assert.ok(brief.includes(kind), kind);
    assert.match(brief, /"gesture": true/);
    assert.match(brief, /"play"/);
  });
});
