/**
 * The v2 verification layer, pure and fast:
 * the expression language behind pixel/probe/demo checks, spec normalisation and validation,
 * scoreboard comparison, the extended pixel statistics and frame diff, the technique library's
 * retrieval and outcome gate, the code reviewer's mechanical scan, and the loop's self-test.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computePixelDiff, computePixelStats, fractionAbove, fractionBelow } from "../../src/substrate/pixel-stats.ts";
import {
  compareScoreboards,
  dryRunChecks,
  evaluateBoolean,
  evaluateDemoCheck,
  evaluatePixelCheck,
  evaluateProbeCheck,
  isInvisibleDiff,
  parseExpr,
  pixelScope,
  probeScope,
  renderScoreboard,
  sceneCheckExpression,
  settleVision,
  summarizeScoreboard,
  toScoreboard,
} from "../../src/harness-seed/loop/checks.ts";
import {
  acceptRound,
  defectsToChecks,
  facetPrompt,
  grownCheckIds,
  judgeChecksToRetire,
  similarDefect,
  strongFlips,
  suggestedProbe,
} from "../../src/harness-seed/loop/facet-loop.ts";
import { checkCounts } from "../../src/renderer/words.ts";
import {
  catalogueEntryEarned,
  checkTokens,
  demosNamedByChecks,
  loadCatalogue,
  MAX_CRAFT,
  normalizeCheck,
  normalizeFacetSpec,
  normalizeGameTraits,
  recordCatalogueOutcomes,
  renderCatalogueForPlanner,
  renderChecks,
  saveCatalogue,
  validateFacetSpec,
  withHarnessChecks,
} from "../../src/harness-seed/loop/spec.ts";
import {
  applyRecipeOutcome,
  checksFromDefects,
  craftForNewCheck,
  isCraftRecipe,
  loadRecipes,
  normalizeRecipe,
  recipesForChecks,
  renderBrief,
  renderCraftForPlanner,
  saveRecipe,
  scoreRecipe,
  withCraftChecks,
} from "../../src/harness-seed/loop/library.ts";
import { mechanicalReview, parseDiff } from "../../src/harness-seed/loop/review.ts";
import { CheckLintCode, lintCheck } from "../../src/harness-seed/loop/check-lint.ts";
import { appliesToBuild } from "../../src/harness-seed/loop/applies-to-build.ts";
import { mineValidationTasks } from "../../src/harness-seed/loop/skillopt.ts";
import type { Check } from "../../src/harness-seed/loop/spec.ts";
import { askVisionBoard, cameraSubset, normalizeLiveness, selectShots } from "../../src/harness-seed/loop/judge.ts";
import { parseRecipeMarkdown, spikeCandidates } from "../../src/harness-seed/loop/spike.ts";
import { runSelftest } from "../../src/harness-seed/loop/selftest.ts";
import { decompose } from "../../src/harness-seed/loop/autopilot.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as pathMod from "node:path";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { tmpDir } from "../helpers/tmp.ts";

const repoRoot = pathMod.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function bitmap(width: number, height: number, quad: [number, number, number, number]): Buffer {
  const buffer = Buffer.alloc(width * height * 4);
  for (let i = 0; i < buffer.length; i += 4) buffer.set(quad, i);
  return buffer;
}

describe("check expressions", () => {
  it("parses the planner's vocabulary and refuses what it cannot", () => {
    assert.doesNotThrow(() => parseExpr("meanLuma in [0.32,0.45] && fractionAbove(0.9) <= 0.02"));
    assert.doesNotThrow(() => parseExpr("delta('player.x') != 0 || delta('player.z') != 0"));
    assert.doesNotThrow(() => parseExpr('!(entities.pickups < 4) && phase == "playing"'));
    assert.throws(() => parseExpr("meanLuma in ["), /expected/);
    assert.throws(() => parseExpr("meanLuma >"), /unexpected end/);
    assert.throws(() => parseExpr("a ; b"), /unexpected character/);
  });

  it("evaluates against normalised pixel stats and names what is missing", () => {
    const histogram = new Array(32).fill(0);
    histogram[31] = 0.05;
    histogram[10] = 0.95;
    const scope = pixelScope({
      meanLuma: 102,
      litFraction: 0.7,
      histogram,
      bands: { top: 200, middle: 100, bottom: 30, left: 90, center: 100, right: 110 },
      saturation: 0.3,
      contrast: 40,
    });
    assert.equal(evaluateBoolean("meanLuma in [0.35,0.45]", scope).pass, true);
    assert.equal(evaluateBoolean("fractionAbove(0.9) <= 0.02", scope).pass, false, "5% above 0.9 fails a 2% ceiling");
    assert.equal(evaluateBoolean("fractionBelow(0.5) >= 0.9", scope).pass, true);
    assert.equal(evaluateBoolean("top > bottom && band('left') < band('right')", scope).pass, true);
    const missing = evaluateBoolean("skyLuma > 0.5", scope);
    assert.equal(missing.pass, false);
    assert.match(missing.reason, /missing: skyLuma/);
    // A comparison against nothing is false, never NaN-true.
    assert.equal(evaluateBoolean("diffFraction < 0.5", scope).pass, false);
  });

  it("evaluates probe expressions with dotted paths, early state and delta()", () => {
    const scope = probeScope({ player: { x: 3, z: 0 }, entities: { pickups: 4 }, phase: "playing", held: ["w"] }, {
      player: { x: 0, z: 0 },
    } as never);
    assert.equal(evaluateBoolean("delta('player.x') != 0 || delta('player.z') != 0", scope).pass, true);
    assert.equal(evaluateBoolean("early.player.x == 0 && player.x > early.player.x", scope).pass, true);
    assert.equal(evaluateBoolean("len(held) == 1 && has('entities.pickups')", scope).pass, true);
    assert.equal(evaluateBoolean("phase == 'cleared'", scope).pass, false);
  });

  it("binds `state` in the probe scope without shadowing a game that has its own", () => {
    const scope = probeScope({ foo: { bar: 1 }, player: { x: 3 } }, { foo: { bar: 0 } } as never);
    // The grammar every director-written probe used, and the bare paths the loop's own checks use.
    assert.equal(evaluateBoolean("state.foo.bar > 0", scope).pass, true);
    assert.equal(evaluateBoolean("foo.bar > 0", scope).pass, true);
    assert.equal(evaluateBoolean("state.player.x == player.x", scope).pass, true);
    assert.equal(evaluateBoolean("delta('foo.bar') == 1", scope).pass, true);
    // The same alias inside has() and delta(), whose argument is a string the parser never
    // turns into a reference: `state.`-prefixed, these read a silent `false` for a whole run.
    assert.equal(evaluateBoolean("delta('state.foo.bar') == 1", scope).pass, true);
    assert.equal(evaluateBoolean("has('state.player.x')", scope).pass, true);
    assert.equal(
      evaluateBoolean("has('state.player.nope')", scope).pass,
      false,
      "a path that is really absent still reads false",
    );
    // A game whose state() really has a top-level `state` field reads its own, not the alias.
    const own = probeScope({ state: "playing" });
    assert.equal(evaluateBoolean("state == 'playing'", own).pass, true);
    assert.equal(evaluateBoolean("state.foo > 0", own).pass, false);
    assert.equal(evaluateBoolean("has('state')", own).pass, true, "and its own field is what has() names");
  });

  it("dry-runs the paths a probe names as a string, not only the ones it references", () => {
    const state = { player: { x: 3 }, props: { moved: 0 } };
    const checks = [
      { id: "moved", kind: "probe", expr: "delta('state.props.moved') > 0" },
      { id: "here", kind: "probe", expr: "has('player.x')" },
      { id: "nowhere", kind: "probe", expr: "delta('crates.knocked') > 0" },
      { id: "referenced", kind: "probe", expr: "state.crates.knocked > 0" },
    ];
    const { unsatisfiable, stateKeys } = dryRunChecks(checks as never, { state } as never);
    // `state.props.moved` resolves through the alias and `player.x` is really there; the two
    // paths the build does not report come back — the string one included, which used to pass
    // the dry run clean and then score false on every iteration for the rest of the run.
    assert.deepEqual(
      unsatisfiable.map((entry: { id: string; missing: string[] }) => [entry.id, entry.missing]),
      [
        ["nowhere", ["crates.knocked"]],
        ["referenced", ["state.crates.knocked"]],
      ],
    );
    assert.deepEqual(stateKeys, ["player", "props"]);
  });

  it("reads a demo-scoped probe from the state that demo left, and calls a capped demo unmeasured", () => {
    const evidence = {
      // The demos run after the main sample, so the number the demo drives is zero here.
      state: { contact: { speedKept: 0 } },
      stateEarly: { contact: { speedKept: 0 } },
      demos: { "prop-run": { ok: true, result: null }, "big-hit": { ok: false, error: "threw" } },
      demoStates: { "prop-run": { contact: { speedKept: 0.81 } } },
      registeredDemos: ["prop-run", "big-hit", "side-hit"],
      skippedDemos: ["side-hit"],
    };
    const scoped = evaluateProbeCheck(
      { id: "kept", kind: "probe", demo: "prop-run", expr: "state.contact.speedKept >= 0.7" },
      evidence,
    );
    assert.equal(scoped.pass, true);
    assert.equal(
      evaluateProbeCheck({ id: "kept", kind: "probe", expr: "state.contact.speedKept >= 0.7" }, evidence).pass,
      false,
      "unscoped, the same check reads the pre-demo zero",
    );
    // Under a demo scope `early` is the state before any demo ran, so delta() measures the demo.
    assert.equal(
      evaluateProbeCheck(
        { id: "moved", kind: "probe", demo: "prop-run", expr: "delta('contact.speedKept') > 0" },
        evidence,
      ).pass,
      true,
    );
    // A demo the cap dropped is "nobody looked", never "it failed" — and the cap must not drop it.
    const capped = evaluateProbeCheck(
      { id: "kept", kind: "probe", demo: "side-hit", expr: "state.contact.speedKept >= 0.7" },
      evidence,
    );
    assert.equal(capped.pass, null);
    assert.equal(capped.state, "unmeasured");
    assert.match(capped.reason, /demo cap/);
    assert.deepEqual(
      demosNamedByChecks([
        { kind: "probe", demo: "side-hit", expr: "x" },
        { kind: "demo", name: "prop-run" },
        { kind: "pixel", expr: "y" },
      ] as never),
      ["side-hit", "prop-run"],
    );
    // A demo that ran and threw is the builder's defect; one the game never declared likewise.
    assert.match(
      evaluateProbeCheck({ id: "kept", kind: "probe", demo: "big-hit", expr: "ok" }, evidence).reason,
      /failed: threw/,
    );
    assert.match(
      evaluateProbeCheck({ id: "kept", kind: "probe", demo: "fly", expr: "ok" }, evidence).reason,
      /not registered/,
    );
  });

  it("resolves thirteen synthetic nested probes with nothing missing", async () => {
    // Synthetic nested fields reproduce the historical missing-field regression.
    // Each reference uses `>= 0`: this tests lookup independently of a quality threshold.
    const fixture = JSON.parse(await readFile(new URL("../fixtures/nested-probes.json", import.meta.url), "utf8")) as {
      probes: Array<{ id: string; refs: string[]; reason: string }>;
      state: Record<string, unknown>;
    };
    assert.equal(fixture.probes.length, 13);
    assert.ok(
      fixture.probes.every((p) => /missing:/.test(p.reason)),
      "all thirteen inputs reproduce the missing-field error",
    );
    const stillMissing = fixture.probes
      .flatMap((probe) =>
        probe.refs.map((ref) => evaluateProbeCheck({ id: probe.id, kind: "probe", expr: `${ref} >= 0` }, fixture)),
      )
      .filter((outcome) => !outcome.pass)
      .map((outcome) => `${outcome.id}: ${outcome.reason}`);
    assert.deepEqual(stillMissing, []);
  });

  it("runs pixel, probe and demo checks over an evidence pass", () => {
    const evidence = {
      shots: [
        {
          camera: "default",
          stats: {
            meanLuma: 90,
            litFraction: 0.6,
            histogram: new Array(32).fill(1 / 32),
            bands: { top: 120, middle: 90, bottom: 60, left: 90, center: 90, right: 90 },
          },
        },
      ],
      state: { player: { x: 2, z: 1 }, phase: "playing" },
      stateEarly: { player: { x: 0, z: 0 } },
      demos: { walk: { ok: true, result: { reached: true } }, broken: { ok: false, error: "threw" } },
      registeredDemos: ["walk", "broken", "ads"],
      skippedDemos: ["ads"],
      missingCameras: ["camBridge"],
    };
    const pixel = evaluatePixelCheck(
      { id: "grade", kind: "pixel", camera: "default", expr: "meanLuma in [0.3,0.4]" },
      evidence,
    );
    assert.equal(pixel.pass, true);
    const failing = evaluatePixelCheck(
      { id: "grade", kind: "pixel", camera: "default", expr: "meanLuma > 0.9" },
      evidence,
    );
    assert.equal(failing.pass, false);
    assert.match(failing.reason, /observed meanLuma 0\.353/);
    assert.match(
      evaluatePixelCheck({ id: "x", kind: "pixel", camera: "camBridge", expr: "meanLuma > 0" }, evidence).reason,
      /camBridge" is not registered/,
    );
    // A camera the build registered but this pass lost is unmeasured — not a failure.
    const lost = evaluatePixelCheck({ id: "x", kind: "pixel", camera: "camLost", expr: "meanLuma > 0" }, evidence);
    assert.equal(lost.pass, null);
    assert.equal(lost.state, "unmeasured");
    assert.equal(
      evaluateProbeCheck({ id: "moved", kind: "probe", expr: "delta('player.x') != 0" }, evidence).pass,
      true,
    );
    assert.equal(
      evaluateDemoCheck({ id: "d", kind: "demo", name: "walk", expr: "result.reached == true" }, evidence).pass,
      true,
    );
    assert.match(
      evaluateDemoCheck({ id: "d", kind: "demo", name: "broken", expr: "ok" }, evidence).reason,
      /failed: threw/,
    );
    assert.match(
      evaluateDemoCheck({ id: "d", kind: "demo", name: "fly", expr: "ok" }, evidence).reason,
      /not registered — config.demos has: walk, broken, ads/,
    );
    // The demo cap: a declared demo that was not run is unmeasured, never failed. One run turned
    // exactly this into "ADS never engages" and chased the phantom for an hour.
    const capped = evaluateDemoCheck({ id: "d", kind: "demo", name: "ads", expr: "ok" }, evidence);
    assert.equal(capped.pass, null);
    assert.match(capped.reason, /was not run \(demo cap\)/);
    const cmp = compareScoreboards(
      toScoreboard([{ id: "d", kind: "demo", weight: "identity", pass: true }] as never),
      toScoreboard([capped]),
    );
    assert.deepEqual(cmp.regressions, []);
    assert.deepEqual(cmp.unmeasured, ["d"]);
    assert.equal(summarizeScoreboard(toScoreboard([capped]), { checks: [1] } as never).identityAllPass, false);
    assert.match(renderScoreboard(toScoreboard([capped])), /\[UNMEASURED\] d/);
  });

  it("wraps scene JS in the inspect() helpers and never evals the check outside the page", () => {
    const expression = sceneCheckExpression("meshes('terrain').every(m => !m.material.transparent)");
    assert.match(expression, /window\.__studio/);
    assert.match(expression, /inspect\(\)/);
    assert.match(expression, /meshes\('terrain'\)/);
    assert.match(expression, /__error/);
  });
});

describe("facet specs", () => {
  it("normalises planner JSON, keeps `brief` as an alias, and derives cameras from checks", () => {
    const spec = normalizeFacetSpec({
      id: "Terrain Water",
      intent: "opaque terrain with a mirror",
      owns: ["src/terrain-water.js"],
      identity: ["water mirror", "opaque terrain"],
      budgetShare: 0.4,
      checks: [
        {
          id: "terrain-opaque",
          kind: "scene",
          weight: "identity",
          js: "meshes('terrain').every(m => m.material.depthWrite)",
        },
        {
          id: "mirror-legible",
          kind: "vision",
          camera: "camBridge",
          crop: [0.2, 0.55, 0.8, 1.0],
          ask: "Is the bridge reflected?",
        },
        { id: "district-walk", kind: "demo", name: "district-walk", expect: "ok" },
        { id: "terrain-opaque", kind: "probe", expr: "player.x > 0" },
      ],
    });
    assert.equal(spec.id, "terrain-water");
    assert.equal(spec.brief, spec.intent);
    assert.deepEqual(spec.cameras, ["default", "camBridge"]);
    assert.deepEqual(
      spec.checks.map((c: { id: string }) => c.id),
      ["terrain-opaque", "mirror-legible", "district-walk", "terrain-opaque-2"],
    );
    assert.equal(spec.checks[0].weight, "identity");
    assert.deepEqual((spec.checks[1] as { crop?: number[] }).crop, [0.2, 0.55, 0.8, 1]);
    assert.equal((spec.checks[2] as { expr?: string }).expr, "ok");
  });

  it("keeps a probe's demo scope, so the number is read after the demo that drives it", () => {
    const spec = normalizeFacetSpec({
      id: "contact",
      intent: "props that do not stop cars",
      checks: [{ id: "props-dont-stop-cars", kind: "probe", demo: "prop-run", expr: "state.contact.speedKept >= 0.7" }],
    });
    assert.equal((spec.checks[0] as { demo?: string }).demo, "prop-run");
    assert.deepEqual(demosNamedByChecks(spec.checks), ["prop-run"]);
    const validated = validateFacetSpec(spec, { demos: ["side-hit"] as never });
    assert.equal(validated.ok, true);
    assert.match(String(validated.spec.checks[0].note), /demo "prop-run" is not registered yet/);
    assert.match(renderChecks(validated.spec.checks), /probe on the state left by demo "prop-run"/);
  });

  it("`done` is the contract: 2–4 sentences become the identity checks, and the sentence rides with them", () => {
    const spec = normalizeFacetSpec({
      id: "contact",
      intent: "props that do not stop cars",
      done: [
        {
          what: "a car that hits a bin keeps most of its speed",
          check: { id: "speed-kept", kind: "probe", demo: "prop-run", expr: "state.contact.speedKept >= 0.7" },
        },
        {
          what: "the bin ends up somewhere else",
          check: { id: "props-moved", kind: "probe", expr: "delta('props.moved') > 0" },
        },
      ],
      checks: [
        { id: "speed-kept", kind: "probe", expr: "state.contact.speedKept >= 0.1" },
        { id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.4" },
      ],
    });
    // The done checks head the board; a check repeated under `checks` is kept once, as identity.
    assert.deepEqual(
      spec.checks.map((c: { id: string }) => c.id),
      ["speed-kept", "props-moved", "lit"],
    );
    assert.deepEqual(
      spec.checks.map((c: { weight: string }) => c.weight),
      ["identity", "identity", "normal"],
    );
    assert.equal(
      (spec.checks[0] as unknown as { expr: string }).expr,
      "state.contact.speedKept >= 0.7",
      "the done version wins",
    );
    assert.deepEqual(spec.done, [
      { id: "speed-kept", what: "a car that hits a bin keeps most of its speed" },
      { id: "props-moved", what: "the bin ends up somewhere else" },
    ]);
    assert.match(renderChecks(spec.checks), /speed-kept \[identity\].*a car that hits a bin keeps most of its speed/);
    // Identity is what makes "satisfied" reachable at all: with none, every check must pass.
    assert.equal(
      summarizeScoreboard(
        toScoreboard(
          spec.checks.map((c: { id: string; kind: string; weight: string }) => ({
            ...c,
            pass: c.weight === "identity",
          })) as never,
        ),
        spec,
      ).identityAllPass,
      true,
    );
  });

  it("the dry run reads a probe against the state a build reports, and names the keys it does have", () => {
    const spec = normalizeFacetSpec({
      id: "contact",
      intent: "props that do not stop cars",
      checks: [
        { id: "speed-kept", kind: "probe", expr: "state.contact.speedKept >= 0.7" },
        { id: "moved", kind: "probe", expr: "delta('player.x') != 0" },
        { id: "somewhere", kind: "probe", expr: "player.x > 0" },
      ],
    });
    const validated = validateFacetSpec(spec, { state: { player: { x: 2 }, maps: { activeId: "macba" } } } as never);
    assert.deepEqual(validated.unsatisfiable, [{ id: "speed-kept", missing: ["state.contact.speedKept"] }]);
    assert.deepEqual(validated.stateKeys, ["player", "maps"]);
    assert.match(
      String(validated.spec.checks[0].note),
      /does not report state\.contact\.speedKept yet — expose it in __studio\.state\(\) \(which reports: player, maps\)/,
    );
    assert.equal(validated.spec.checks.length, 3, "an unsatisfiable check is a contract, not a rejection");
    assert.equal(validated.ok, true);
    // Nobody looked: nothing is claimed either way.
    const blind = validateFacetSpec(spec);
    assert.deepEqual(blind.unsatisfiable, []);
    assert.equal(blind.stateKeys, null);
  });

  it("validates: bad kinds and unparseable expressions are dropped with a reason, the rest survive", () => {
    const spec = normalizeFacetSpec({
      id: "sky",
      intent: "a sky",
      checks: [
        { id: "ok-pixel", kind: "pixel", camera: "default", expr: "top > 0.4" },
        { id: "bad-expr", kind: "pixel", camera: "default", expr: "top >" },
        { id: "no-js", kind: "scene" },
        { id: "teleport", kind: "warp", js: "1" },
        { id: "no-ask", kind: "vision", camera: "default" },
      ],
    });
    const result = validateFacetSpec(spec, { cameras: ["default"] as never });
    assert.equal(result.ok, false);
    assert.equal(result.problems.length, 4);
    assert.match(result.problems.join("\n"), /does not parse/);
    assert.match(result.problems.join("\n"), /unknown kind "warp"/);
    assert.deepEqual(
      result.spec.checks.map((c: { id: string }) => c.id),
      ["ok-pixel"],
    );
  });

  it("a vision-heavy spec is sent back; a missing camera is a note to the builder, not a rejection", () => {
    const spec = normalizeFacetSpec({
      id: "v",
      intent: "x",
      checks: [
        { id: "a", kind: "vision", camera: "camX", ask: "a?" },
        { id: "b", kind: "vision", camera: "camX", ask: "b?" },
        { id: "c", kind: "vision", camera: "camX", ask: "c?" },
        { id: "d", kind: "pixel", camera: "camX", expr: "meanLuma > 0.1" },
      ],
    });
    const result = validateFacetSpec(spec, { cameras: ["default"] as never });
    assert.match(result.problems.join("\n"), /3 of 4 checks are vision/);
    assert.match(String(result.spec.checks[3].note), /camX.*not registered/);
    // A screen part (critic "screen": the UI or HUD) is judged by eye: its looks are the work,
    // and a mechanical majority there only buys counts of what it draws.
    const screen = validateFacetSpec({ ...spec, critic: "screen" }, { cameras: ["default"] as never });
    assert.doesNotMatch(screen.problems.join("\n"), /checks are vision/);
    assert.equal(screen.spec.checks.length, 4);
    const place = validateFacetSpec({ ...spec, critic: "place" }, { cameras: ["default"] as never });
    assert.match(place.problems.join("\n"), /3 of 4 checks are vision/);
  });

  it("a floor on how much the build draws is refused at validation, a budget or an existence check is not", () => {
    const refused = [
      { id: "hud-rich", kind: "probe", expr: "len(hud.items) >= 60" },
      { id: "hud-rich-aliased", kind: "probe", expr: "len(state.hud.items) > 59" },
      { id: "hud-rich-mirrored", kind: "probe", expr: "60 <= len(hud.items)" },
      { id: "busy-frame", kind: "probe", expr: "__render.drawCalls >= 500" },
      { id: "hud-band", kind: "probe", expr: "len(hud.items) in [60, 999]" },
      { id: "hud-count", kind: "probe", expr: "hud.count > 12 && player.speed > 1" },
      { id: "tri-floor", kind: "probe", expr: "triangles >= 100000" },
      { id: "grew-hud", kind: "probe", expr: "delta('hud.count') >= 5" },
    ];
    const kept = [
      { id: "hud-there", kind: "probe", expr: "len(hud.items) >= 1" },
      { id: "draw-budget", kind: "probe", expr: "__render.drawCalls <= 1000 && __render.triangles <= 400000" },
      { id: "draws", kind: "probe", expr: "__render.drawCalls > 0" },
      { id: "fired", kind: "probe", expr: "delta('actions.primary') >= 1" },
      { id: "enemies", kind: "probe", expr: "len(enemies) >= 5" },
      { id: "budget-mirrored", kind: "probe", expr: "1000 >= drawCalls" },
    ];
    const spec = normalizeFacetSpec({ id: "hud", intent: "a HUD", checks: [...refused, ...kept] });
    const result = validateFacetSpec(spec);
    assert.deepEqual(
      result.spec.checks.map((c: { id: string }) => c.id),
      kept.map((c) => c.id),
    );
    assert.equal(result.problems.length, refused.length, result.problems.join("\n"));
    for (const problem of result.problems)
      assert.match(problem, /a floor on how much the build draws measures the implementation/);
  });

  it("reads the floor from the expression's shape, whichever way it is written, and only on draw quantities", () => {
    const table: Array<[Record<string, unknown>, string | null]> = [
      [{ kind: "probe", expr: "!(len(hud.items) < 60)" }, "hud.items"],
      [{ kind: "probe", expr: "!(len(hud.items) > 60)" }, null],
      [{ kind: "probe", expr: "len(hud.items) == 60" }, "hud.items"],
      [{ kind: "probe", expr: "len(hud.items) == 1" }, null],
      [{ kind: "probe", expr: "len(hud.items) != 0" }, null],
      [{ kind: "probe", expr: "abs(delta('state.__render.triangles')) > 10" }, "__render.triangles"],
      [{ kind: "probe", expr: "early.hud.count >= 4" }, "hud.count"],
      [{ kind: "probe", expr: "player.speed > 1 || vertices > 2" }, "vertices"],
      [{ kind: "probe", expr: "hud.count > -5" }, null],
      [{ kind: "probe", expr: "hud.count > other.count" }, null],
      [{ kind: "metric", expr: "__render.drawCalls", goal: "max" }, "__render.drawCalls"],
      [{ kind: "metric", expr: "__render.drawCalls", goal: "min" }, null],
      [{ kind: "demo", name: "lap", expr: "hud.count >= 8" }, "hud.count"],
      [{ kind: "demo", name: "lap", expr: "ok" }, null],
      [{ kind: "scene", js: "hud().items.length >= 60" }, null],
      [{ kind: "vision", ask: "Are there at least 60 HUD items?" }, null],
      [{ kind: "probe", expr: "len(hud.items) >=" }, null],
      [{ kind: "probe", expr: 60 }, null],
      // The JS spelling of the same floor: the probe scope resolves `.length` on the list.
      [{ kind: "probe", expr: "hud.items.length >= 60" }, "hud.items"],
      [{ kind: "probe", expr: "state.hud.items.length > 59" }, "hud.items"],
      [{ kind: "probe", expr: "hud.items.length <= 64" }, null],
      [{ kind: "probe", expr: "hud.items.length > 0" }, null],
      // An index that must exist is a floor of one more than it.
      [{ kind: "probe", expr: "has('hud.items.59')" }, "hud.items"],
      [{ kind: "probe", expr: "has('state.hud.items.1') && player.speed > 1" }, "hud.items"],
      [{ kind: "probe", expr: "has('hud.items.0')" }, null],
      [{ kind: "probe", expr: "!has('hud.items.64')" }, null],
      [{ kind: "probe", expr: "has('player.items.59')" }, null],
      // A range ruled out from 0 up is a floor above it; one that still allows nothing is not.
      [{ kind: "probe", expr: "!(len(hud.items) in [0, 59])" }, "hud.items"],
      [{ kind: "probe", expr: "!(len(hud.items) in [0, 0])" }, null],
      [{ kind: "probe", expr: "!(len(hud.items) in [5, 59])" }, null],
      // min/max against a number still reads the quantity.
      [{ kind: "probe", expr: "max(len(hud.items), 0) >= 60" }, "hud.items"],
      [{ kind: "probe", expr: "min(__render.drawCalls, 5000) > 400" }, "__render.drawCalls"],
      [{ kind: "probe", expr: "min(len(hud.items), 64) <= 64" }, null],
      [{ kind: "probe", expr: "max(len(hud.items), player.speed) >= 60" }, null],
      // The HUD summary's per-kind counts are draw quantities too: a segmented gauge asked for as
      // forty bars is the three-thousand-rectangle HUD again.
      [{ kind: "probe", expr: "hud.kinds.bar >= 40" }, "hud.kinds.bar"],
      [{ kind: "probe", expr: "state.hud.kinds.arc > 6" }, "hud.kinds.arc"],
      // How many kinds the HUD uses is variety bounded by the kind vocabulary, not an amount drawn.
      [{ kind: "probe", expr: "len(hud.kinds) >= 5" }, null],
      [{ kind: "probe", expr: "early.hud.kinds.text == 12" }, "hud.kinds.text"],
      [{ kind: "probe", expr: "hud.kinds.bar > 0" }, null],
      [{ kind: "probe", expr: "hud.kinds.text <= 8" }, null],
      [{ kind: "probe", expr: "hud.kindsOfMine >= 40" }, null],
    ];
    for (const [check, quantity] of table) {
      const finding = lintCheck(check);
      assert.equal(finding?.quantity ?? null, quantity, JSON.stringify(check));
      if (finding) assert.equal(finding.code, CheckLintCode.DrawCountFloor);
    }
    assert.equal(lintCheck(null), null);
    assert.equal(lintCheck(undefined), null);
  });

  it("a catalogue that learned a floor on what the build draws stops offering it and stops counting it", () => {
    const catalogue = {
      version: 2,
      checks: {
        "hud-rich": { kind: "probe", expr: "len(hud.items) >= 60", origin: "director", uses: 5, passes: 5 },
        "draw-budget": { kind: "probe", expr: "__render.drawCalls <= 1000", origin: "director", uses: 2, passes: 2 },
      } as Record<string, Record<string, unknown>>,
    };
    const planner = renderCatalogueForPlanner(catalogue);
    assert.doesNotMatch(planner, /hud-rich/);
    assert.match(planner, /draw-budget/);
    const spec = {
      checks: [
        { id: "hud-rich", kind: "probe", expr: "len(hud.items) >= 60", weight: "normal" },
        { id: "draw-budget", kind: "probe", expr: "__render.drawCalls <= 1000", weight: "normal" },
      ],
    };
    recordCatalogueOutcomes(catalogue, spec as never, { "hud-rich": { pass: true }, "draw-budget": { pass: true } });
    assert.equal(catalogue.checks["hud-rich"]!.uses, 5);
    assert.equal(catalogue.checks["draw-budget"]!.uses, 3);
  });

  it("the catalogue records uses and passes, renders for the planner, and never duplicates an id", () => {
    const catalogue = { version: 1, checks: {} as Record<string, { uses?: number; passes?: number }> };
    const spec = normalizeFacetSpec({
      id: "f",
      intent: "x",
      checks: [{ id: "grade-band", kind: "pixel", camera: "default", expr: "meanLuma in [0.32,0.45]" }],
    });
    recordCatalogueOutcomes(catalogue, spec, { "grade-band": { pass: true } });
    recordCatalogueOutcomes(catalogue, spec, { "grade-band": { pass: false } });
    assert.equal(Object.keys(catalogue.checks).length, 1);
    assert.equal(catalogue.checks["grade-band"].uses, 2);
    assert.equal(catalogue.checks["grade-band"].passes, 1);
    assert.match(renderCatalogueForPlanner(catalogue), /"id":"grade-band"/);
    // Learned content: a judge-origin check reaches the planner only after two runs caught
    // something with it; a planner's own check that never passes is voted out by use. What the
    // seed itself ships is no longer a hypothesis — it is five technical checks, not opinions.
    const learned = {
      version: 2,
      checks: { stale: { kind: "pixel", origin: "planner", uses: 3, passes: 0 } } as Record<
        string,
        Record<string, unknown>
      >,
    };
    const judgeSpec = {
      checks: [
        { id: "defect-no-hands", kind: "vision", camera: "default", ask: "gone?", origin: "judge", defect: "no hands" },
      ],
    };
    recordCatalogueOutcomes(learned, judgeSpec as never, { "defect-no-hands": { pass: false } }, "planner", {
      runId: "r1",
      genres: ["fps"],
    } as never);
    assert.doesNotMatch(renderCatalogueForPlanner(learned), /defect-no-hands|stale/);
    recordCatalogueOutcomes(learned, judgeSpec as never, { "defect-no-hands": { pass: false } }, "planner", {
      runId: "r2",
      genres: ["fps"],
    } as never);
    assert.match(
      renderCatalogueForPlanner(learned),
      /Learned on "fps"[\s\S]*defect-no-hands[\s\S]*learned from 2 runs/,
    );
    assert.deepEqual(checkTokens({ id: "mirror-rt", kind: "scene", camera: "camBridge" }), [
      "mirror",
      "scene",
      "cambridge",
    ]);
  });
});

describe("the board a game actually carries", () => {
  it("puts no harness check on a game nobody described, and the kind's own axes on one they did", () => {
    // Every trait is off until something declares it: the four harness checks describe the
    // template's screen and the template's controls, and a game nobody described has neither.
    assert.deepEqual(withHarnessChecks({ id: "f", checks: [] }, { ownsMain: true }).checks, []);
    assert.deepEqual(normalizeGameTraits(undefined), {
      kind: null,
      hud: false,
      mouseLook: false,
      keyboardMove: false,
      playScript: null,
    });

    // A board game declares a kind and still carries nothing: no HUD rule, no look, no move.
    assert.deepEqual(
      withHarnessChecks({ id: "f", checks: [] }, { ownsMain: true, game: { kind: "static-board" } as never }).checks,
      [],
    );

    // The template's own shape keeps all four.
    const firstPerson = withHarnessChecks(
      { id: "f", checks: [] },
      { ownsMain: true, game: { kind: "first-person" } as never },
    ).checks;
    assert.deepEqual(firstPerson.map((c: { id: string }) => c.id).sort(), [
      "hud-coverage",
      "hud-overlap",
      "keys-move-player",
      "look-turns-camera",
      "no-dom-ui",
      "reaches-play",
      "single-hud",
    ]);

    // A top-down game has a HUD and keys but no mouse look, and its move check asks about the
    // axes it actually moves on — x, y or z — not the first-person controller's x and z.
    const topDown = withHarnessChecks(
      { id: "f", checks: [] as Check[] },
      { ownsMain: true, game: { kind: "top-down" } as never },
    ).checks as { id: string; expr?: string }[];
    assert.deepEqual(topDown.map((c) => c.id).sort(), [
      "hud-coverage",
      "hud-overlap",
      "keys-move-player",
      "no-dom-ui",
      "reaches-play",
      "single-hud",
    ]);
    const move = topDown.find((c) => c.id === "keys-move-player");
    assert.match(String(move!.expr), /player\.y/);
    assert.doesNotMatch(String(move!.expr), /player\.yaw/);
    assert.equal(topDown.find((c) => c.id === "hud-coverage")!.expr, "hud.coverage <= 0.22");

    // The HUD's share of the frame is the kind's: a racer's dashboard may take more of it than
    // a first-person crosshair and ammo count.
    const racing = withHarnessChecks(
      { id: "f", checks: [] as Check[] },
      { ownsMain: true, game: { kind: "racing" } as never },
    ).checks as { id: string; expr?: string; needs?: string[]; weight: string }[];
    // Flipped: the entry owner of a racer also carries the race a throttle-only bot must not win.
    assert.deepEqual(racing.map((c) => c.id).sort(), [
      "hud-coverage",
      "hud-overlap",
      "keys-move-player",
      "no-dom-ui",
      "reaches-play",
      "single-hud",
      "throttle-bot-loses",
    ]);
    const coverage = racing.find((c) => c.id === "hud-coverage")!;
    assert.equal(coverage.expr, "hud.coverage <= 0.18");
    assert.deepEqual(coverage.needs, ["hud.coverage"]);
    assert.equal(coverage.weight, "normal");
    const firstPersonCoverage = (firstPerson as { id: string; expr?: string }[]).find((c) => c.id === "hud-coverage");
    assert.equal(firstPersonCoverage?.expr, "hud.coverage <= 0.12");
    // A part that does not own main still carries the screen checks, never the play check.
    const part = withHarnessChecks({ id: "f", checks: [] }, { game: { kind: "racing" } as never }).checks;
    assert.deepEqual(part.map((c: { id: string }) => c.id).sort(), [
      "hud-coverage",
      "hud-overlap",
      "no-dom-ui",
      "single-hud",
    ]);
  });

  it("puts the throttle-only bot's race on the entry owner of a racer or a craft, never a part or the front-end's owner", () => {
    const owned = (game: Record<string, unknown>, options: Record<string, unknown> = {}) =>
      withHarnessChecks({ id: "f", checks: [] as Check[] }, { ownsMain: true, game, ...options } as never).checks;
    const bot = owned({ kind: "racing" }).find((c: Check) => c.id === "throttle-bot-loses");
    assert.ok(bot, "the entry owner of a racer carries the challenge");
    assert.equal(bot.kind, "probe");
    assert.equal(bot.after, "throttle-bot", "it reads the state the throttle-only bot's race left");
    assert.equal(bot.expr, "race.position > 1");
    assert.deepEqual(bot.needs, ["race.position"], "a game that reports no race is not asked");
    assert.equal(bot.weight, "normal", "the challenge never decides whether a part is done");
    assert.ok(owned({ kind: "flight" }).some((c: Check) => c.id === "throttle-bot-loses"));
    const ownScript = { kind: "racing", playScript: [{ type: "tap", keys: ["x"] }] };
    assert.ok(
      owned(ownScript).some((c: Check) => c.id === "throttle-bot-loses"),
      "the bot holds the kind's throttle",
    );
    for (const game of [{ kind: "first-person" }, { kind: "top-down" }, {}]) {
      assert.ok(!owned(game).some((c: Check) => c.id === "throttle-bot-loses"), JSON.stringify(game));
    }
    const part = withHarnessChecks({ id: "f", checks: [] }, { game: { kind: "racing" } as never }).checks;
    assert.ok(!part.some((c: Check) => c.id === "throttle-bot-loses"), "a part that does not own main is not asked");
    const frontEnd = owned({ kind: "racing" }, { keepsFrontEnd: true });
    assert.ok(!frontEnd.some((c: Check) => c.id === "throttle-bot-loses"), "the title's owner is judged on its menu");
    // The normalised check keeps what it reads.
    assert.equal(normalizeCheck({ ...bot } as never)?.after, "throttle-bot");
  });

  it("a harness check whose needs the build does not report is not its question: no nudge, no count, no lost lesson", () => {
    // A racer with no front-end and an older HUD: reaches-play and the two HUD measurements have
    // nothing to read. The template declares no flow, and a kept hud.js measures nothing.
    const state = { player: { x: 0, y: 0, z: 0 }, hud: { items: ["speed"] } };
    const driven = { player: { x: 3, y: 0, z: 0 }, hud: { items: ["speed"] } };
    const director = { id: "lap-time", kind: "probe", expr: "race.lap > 0", needs: ["race.lap"] };
    const board = withHarnessChecks(
      normalizeFacetSpec({ id: "car", intent: "a car that drives", checks: [director] }),
      { ownsMain: true, game: { kind: "racing" } as never },
    );
    const validated = validateFacetSpec(board, { state });
    const notes = (id: string) => String(validated.spec.checks.find((c: { id: string }) => c.id === id)?.note);
    assert.doesNotMatch(notes("reaches-play"), /expose it/);
    assert.doesNotMatch(notes("hud-coverage"), /expose it/);
    assert.ok(!validated.unsatisfiable.some((u: { id: string }) => u.id === "reaches-play"));
    // The director's own contract still asks the build to report what it names.
    assert.match(notes("lap-time"), /does not report race\.lap yet — expose it/);

    const probes = validated.spec.checks.filter((c: { kind: string }) => c.kind === "probe");
    const results = probes.map((c: Check) => evaluateProbeCheck(c, { state: driven, stateEarly: state }));
    const summary = summarizeScoreboard(toScoreboard(results), validated.spec);
    assert.deepEqual(
      summary.unmeasuredChecks.map((u: { id: string }) => u.id),
      ["lap-time"],
    );
    assert.equal(summary.unmeasured, 1);
    assert.equal(summary.total, summary.passing + summary.failing.length + summary.unmeasured);
    // The lesson miner drops a round with anything unmeasured; with the director's check
    // answered, the harness's inapplicable ones no longer cost it the round.
    const answered = probes.map((c: Check) =>
      evaluateProbeCheck(c, {
        state: { ...driven, race: { lap: 1 } },
        stateEarly: { ...state, race: { lap: 0 } },
      }),
    );
    const scoreboard = summarizeScoreboard(toScoreboard(answered), validated.spec);
    assert.equal(scoreboard.unmeasured, 0);
    assert.equal(scoreboard.identityAllPass, true);
    const event = {
      data: {
        type: "custom",
        event_type: "facet_iteration",
        payload: { facetId: "car", iteration: 1, facetTitle: "Car", biggest_gap: "no drift", scoreboard },
      },
    };
    assert.equal(mineValidationTasks([event] as never, 10).length, 1);
  });

  it("one predicate says which board entries are this build's questions, and the summary counts exactly those", () => {
    const state = { player: { x: 0, y: 0, z: 0 }, hud: { items: ["speed"] } };
    const driven = { player: { x: 3, y: 0, z: 0 }, hud: { items: ["speed"] } };
    const director = { id: "lap-time", kind: "probe", expr: "race.lap > 0", needs: ["race.lap"] };
    const validated = validateFacetSpec(
      withHarnessChecks(normalizeFacetSpec({ id: "car", intent: "a car that drives", checks: [director] }), {
        ownsMain: true,
        game: { kind: "racing" } as never,
      }),
      { state },
    );
    const probes = validated.spec.checks.filter((c: { kind: string }) => c.kind === "probe");
    const board = toScoreboard(probes.map((c: Check) => evaluateProbeCheck(c, { state: driven, stateEarly: state })));
    const applying = Object.values(board)
      .filter((e) => appliesToBuild(e, validated.spec))
      .map((e) => e.id);
    for (const harness of ["reaches-play", "hud-coverage", "hud-overlap"]) {
      assert.ok(board[harness], `${harness} is on the board`);
      assert.ok(!applying.includes(harness), `${harness} is not this build's question`);
    }
    // The director's own contract applies even unmeasured, and so does everything measured.
    assert.ok(applying.includes("lap-time"));
    assert.ok(applying.includes("keys-move-player"));
    const summary = summarizeScoreboard(board, validated.spec);
    assert.equal(summary.total, applying.length);
    // reaches-play is an identity check: it is in no identity count either, and blocks nothing.
    const identity = applying.filter((id) => board[id]?.weight === "identity");
    assert.equal(summary.identityTotal, identity.length);
    assert.equal(summary.identityPassing, summary.identityTotal);
    // Without a spec nothing is a harness check, so nothing is dropped; a missing entry applies to nothing.
    assert.equal(Object.values(board).filter((e) => appliesToBuild(e, null)).length, Object.keys(board).length);
    assert.equal(appliesToBuild(null, validated.spec), false);
  });

  it("names no check the build cannot answer as unmeasured to its builder, its brief or its lead", () => {
    // The nudge harness-needs.ts names: "reaches-play — the build does not report flow.playing"
    // in every builder prompt pushed builders to add a menu nobody asked for.
    const state = { player: { x: 0, y: 0, z: 0 }, hud: { items: ["speed"] } };
    const driven = { player: { x: 3, y: 0, z: 0 }, hud: { items: ["speed"] } };
    const director = { id: "lap-time", kind: "probe", expr: "race.lap > 0", needs: ["race.lap"] };
    const validated = validateFacetSpec(
      withHarnessChecks(normalizeFacetSpec({ id: "car", intent: "a car that drives", checks: [director] }), {
        ownsMain: true,
        game: { kind: "racing" } as never,
      }),
      { state },
    );
    const probes = validated.spec.checks.filter((c: { kind: string }) => c.kind === "probe");
    const board = toScoreboard(probes.map((c: Check) => evaluateProbeCheck(c, { state: driven, stateEarly: state })));
    assert.equal(board["reaches-play"]?.pass, null, "the fixture has the harness check unmeasured on the board");
    const run = { runId: "run_car", goal: "a racer" };
    const prompt = (resumed: boolean) =>
      String(
        facetPrompt({
          run,
          spec: validated.spec,
          iteration: 3,
          resumed,
          briefFile: null,
          briefText: "brief",
          board,
          worktree: "/w",
          ownsMain: true,
        }),
      );
    const brief = String(renderBrief({ run, spec: validated.spec, iteration: 3, board } as never));
    const lead = renderScoreboard(board, null, validated.spec);
    for (const [reader, text] of [
      ["the opening prompt", prompt(false)],
      ["the resumed prompt", prompt(true)],
      ["the brief", brief],
      ["the lead's board", lead],
    ] as const) {
      const unmeasured = text.split("\n").filter((line) => line.includes("UNMEASURED"));
      assert.ok(unmeasured.length > 0, `${reader} still names the director's own unmeasured contract`);
      assert.ok(
        unmeasured.some((line) => line.includes("lap-time")),
        `${reader} names lap-time: ${unmeasured}`,
      );
      for (const harness of ["reaches-play", "hud-coverage", "hud-overlap"])
        assert.ok(!unmeasured.some((line) => line.includes(harness)), `${reader} names ${harness}: ${unmeasured}`);
    }
    // Without a spec the board renders whole, as it always has.
    assert.match(renderScoreboard(board), /\[UNMEASURED\] reaches-play/);
  });

  it("offers the planner what a sibling family learned, and tells it the truth about its own board", () => {
    const catalogue = {
      version: 1,
      checks: {
        "lap-time-drops": {
          kind: "probe",
          origin: "judge",
          uses: 4,
          passes: 2,
          catches: 2,
          runs: ["r1", "r2"],
          kinds: ["racing"],
        },
        "grade-band": { kind: "pixel", origin: "judge", uses: 4, passes: 2, catches: 2, runs: ["r1", "r2"] },
      } as Record<string, Record<string, unknown>>,
    };
    // A board game is a different family from a racer (a screen critic, no eyes), so what the
    // racer taught is not offered to it; a check no kind ever claimed stays general.
    const board = renderCatalogueForPlanner(catalogue, { game: { kind: "static-board" } } as never);
    assert.doesNotMatch(board, /lap-time-drops/);
    assert.match(board, /grade-band/);
    assert.match(
      board,
      /No harness-owned checks ride on this game's board — declare hud, mouseLook or keyboardMove in game if it has them\.$/,
    );
    // A game of the family that learned it still sees it, and its own board is named honestly.
    const racer = renderCatalogueForPlanner(catalogue, { game: { kind: "racing" } } as never);
    assert.match(racer, /lap-time-drops/);
    assert.match(
      racer,
      /Already on this game's board \(harness-owned, do not re-declare\): no-dom-ui, single-hud, hud-coverage, hud-overlap, keys-move-player, reaches-play, throttle-bot-loses\./,
    );
    // Two families have recorded it: it has stopped being one genre's opinion.
    catalogue.checks["lap-time-drops"].kinds = ["racing", "static-board"];
    assert.match(renderCatalogueForPlanner(catalogue, { game: { kind: "first-person" } } as never), /lap-time-drops/);
  });

  it("asks a screen the screen critic's question, in the rubric and in the brief", () => {
    const reply = {
      readable: { score: 1, reason: "r", fix: "f" },
      state: { score: 2, reason: "r", fix: "f" },
      affordance: { score: 3 },
      feedback: { score: 3 },
      depth: { score: 3 },
      composition: { score: 3 },
      palette: { score: 3 },
      finish: { score: 3 },
    };
    const screen = normalizeLiveness(reply, "screen");
    assert.equal(screen.critic, "screen");
    assert.deepEqual(
      screen.principles.map((p: { key: string }) => p.key),
      ["readable", "state", "affordance", "feedback", "depth", "composition", "palette", "finish"],
    );
    assert.equal(screen.max, 24);
    assert.equal(screen.grow[0]?.key, "readable");
    assert.equal(screen.biggest, "readable");
    // The place critic is unchanged, and it is what an undeclared game still gets.
    assert.equal(normalizeLiveness({}, "place").principles[0]!.key, "extent");
    assert.equal(normalizeLiveness({}).critic, "place");

    const args = {
      run: { runId: "r", goal: "g" },
      spec: { id: "f", title: "F", intent: "i", checks: [] },
      iteration: 2,
      board: {},
      comparison: null,
      liveness: "- readable 1/3 (grow) — the pieces blur together",
    };
    assert.match(
      String(renderBrief({ ...args, critic: "screen" } as never)),
      /## Why the screen does not read yet \(the readability critic/,
    );
    assert.match(
      String(renderBrief({ ...args, critic: "place" } as never)),
      /## Why it does not feel like a real place yet \(the liveness critic/,
    );
  });
});

/**
 * M4.7 — the 41 hand-seeded opinions about northern-European winter villages leave the board
 * and become craft recipes that are RETRIEVED. What is asserted here is the migration itself:
 * nothing was lost, nothing ships twice, and nothing was silently reworded on the way.
 */
describe("craft leaves the law", () => {
  const seedDir = pathMod.join(repoRoot, "src", "harness-seed");
  /** The five technical checks that say "this is a game and the harness can see and drive it". */
  const KEEPERS = ["camera-player-eye", "demo-walk", "drawcalls-ceiling", "player-moved", "primary-action-registers"];
  /** Bookkeeping the catalogue keeps and a recipe's copy of the body must not carry. */
  const BOOKKEEPING = new Set(["uses", "passes", "catches", "runs", "genres", "kinds", "lastUsed", "origin", "pack"]);
  const body = (id: string, entry: Record<string, unknown>) =>
    Object.fromEntries([["id", id], ...Object.entries(entry).filter(([k]) => !BOOKKEEPING.has(k))]);
  const frozen = JSON.parse(readFileSync(pathMod.join(repoRoot, "tests", "fixtures", "catalogue-af065b2.json"), "utf8"))
    .checks as Record<string, Record<string, unknown>>;

  it("the catalogue is exactly the five keepers, and every one of the 41 has a recipe carrying its body verbatim", async () => {
    const catalogue = await loadCatalogue(seedDir);
    assert.deepEqual(
      Object.keys(catalogue.checks).sort(),
      KEEPERS,
      "the shipped catalogue is the five technical checks",
    );
    const menu = renderCatalogueForPlanner(catalogue);
    const retired = Object.keys(frozen).filter((id) => !KEEPERS.includes(id) && id !== "fire-registers");
    assert.equal(retired.length, 41, "41 opinions left the board");
    for (const id of retired) assert.ok(!menu.includes(id), `the planner is not offered ${id} any more`);

    const recipes = await loadRecipes(seedDir);
    assert.equal(recipes.length, 44);
    assert.equal(recipes.filter(isCraftRecipe).length, 41);
    const byCheck = new Map<string, typeof recipes>();
    for (const recipe of recipes) {
      const list = byCheck.get(String(recipe.check?.id ?? "")) ?? [];
      list.push(recipe);
      byCheck.set(String(recipe.check?.id ?? ""), list);
    }
    const packs = new Set([
      "flora",
      "liveness",
      "materials",
      "characters",
      "fps",
      "arena",
      "world",
      "architecture",
      "atmosphere",
      "camera",
      "stats",
      "contract",
    ]);
    for (const id of retired) {
      const owners = (byCheck.get(id) ?? []).filter(isCraftRecipe);
      assert.equal(
        owners.length,
        1,
        `exactly one craft recipe owns ${id}: ${owners.map((r) => r.id).join(", ") || "none"}`,
      );
      const owner = owners[0]!;
      // Byte-identical, note included: only the prose around the check is new.
      assert.deepEqual(
        body(id, owner.check as Record<string, unknown>),
        body(id, frozen[id]!),
        `${owner.id} carries ${id}'s body unchanged`,
      );
      assert.ok(packs.has(owner.pack), `${owner.id} is filed under a known pack, not "${owner.pack}"`);
      assert.ok(
        owner.note.length >= 1 && owner.note.length <= 160,
        `${owner.id}'s note is one line: ${owner.note.length} chars`,
      );
      assert.ok(owner.intent.trim().length > 80, `${owner.id} says HOW, not just what`);
    }
  });

  it("no recipe ships a second definition of a keeper, and the seed's own bodies are what the recipes hold", async () => {
    const catalogue = await loadCatalogue(seedDir);
    const recipes = await loadRecipes(seedDir);
    let held = 0;
    for (const recipe of recipes) {
      const id = String(recipe.check?.id ?? "");
      if (!KEEPERS.includes(id)) continue;
      held += 1;
      assert.equal(recipe.kind, "technique", `${recipe.id} holds a keeper, so it is a technique, not craft`);
      assert.deepEqual(
        body(id, recipe.check as Record<string, unknown>),
        body(id, catalogue.checks[id]!),
        `${recipe.id} holds today's ${id}, not a stale copy`,
      );
    }
    assert.equal(held, 3, "the three keeper-holding technique recipes");
    // The two bodies this package corrected: the pitch band left camera-player-eye for the
    // recipe's intent, and the draw-call ceiling reads the honest whole-frame figure.
    assert.doesNotMatch(String(catalogue.checks["camera-player-eye"]!.js), /pitch/);
    assert.match(String(recipes.find((r) => r.id === "camera.named-rig")!.intent), /25–30° band/);
    assert.equal(
      catalogue.checks["drawcalls-ceiling"]!.expr,
      "__render.drawCalls <= 1000 && __render.triangles <= 400000",
    );
    assert.deepEqual(catalogue.checks["drawcalls-ceiling"]!.needs, ["__render.drawCalls", "__render.triangles"]);
    // The two weights the package changed, and the flag that stops demo-walk hard-failing.
    assert.equal(catalogue.checks["player-moved"]!.weight, "normal");
    assert.equal(catalogue.checks["demo-walk"]!.optional, true);
  });

  it("cannot pass player-moved on a player that was not there before the controls were driven", async () => {
    // A game with a title screen — the own-shape headline case: the early state is sampled a
    // second in, on the menu, and the play script starts the game. Both deltas then read
    // undefined, and `undefined != 0` used to be TRUE: a green "the controls work" line on a
    // build whose controls were never compared to anything. needs names the same two paths
    // delta() reads, which is what lets the early half of the gate fire at all.
    const catalogue = await loadCatalogue(seedDir);
    const moved = { id: "player-moved", ...catalogue.checks["player-moved"]! } as never;
    const lazy = evaluateProbeCheck(moved, {
      stateEarly: { phase: "menu" },
      state: { phase: "play", player: { x: 3, z: 4 } },
    });
    assert.equal(
      lazy.pass,
      null,
      `a player that only appears after the play script is unmeasured: ${JSON.stringify(lazy)}`,
    );
    assert.equal(lazy.state, "unmeasured");
    assert.deepEqual((lazy as { missing?: string[] }).missing, ["early.player.x", "early.player.z"]);
    // No player at all is unmeasured too, and never a pass.
    assert.equal(evaluateProbeCheck(moved, { state: { phase: "play" } }).pass, null);
    // The two states the check exists to tell apart still read the way they always did.
    const still = { stateEarly: { player: { x: 1, z: 2 } }, state: { player: { x: 1, z: 2 } } };
    assert.equal(evaluateProbeCheck(moved, still).pass, false);
    assert.equal(
      evaluateProbeCheck(moved, { stateEarly: { player: { x: 1, z: 2 } }, state: { player: { x: 1, z: 5 } } }).pass,
      true,
    );
    // The recipe that ships the same body is the same check, not a stale second copy.
    const recipes = await loadRecipes(seedDir);
    const seeded = recipes.find((r) => r.id === "contract.seed-step-probes")!;
    assert.equal(seeded.check!.expr, catalogue.checks["player-moved"]!.expr);
    assert.deepEqual(seeded.check!.needs, ["player.x", "player.z"]);
  });

  it("gives the harness-owned move probe the same guard, on the axes the kind actually moves on", () => {
    // The harness's own copy of the same check: identity weight, on every keyboard-moved game.
    const template = withHarnessChecks({ id: "f", checks: [] as Check[] }, {
      ownsMain: true,
      game: { kind: "first-person" },
    } as never).checks.find((c: { id: string }) => c.id === "keys-move-player") as { expr: string; needs?: string[] };
    assert.deepEqual(template.needs, ["player.x", "player.z"]);
    assert.doesNotMatch(
      template.expr,
      /!= 0/,
      "abs(delta(path)) > 0: `undefined != 0` is true and would pass a game with no player",
    );
    assert.equal(
      evaluateProbeCheck({ id: "keys-move-player", kind: "probe", ...template } as never, {
        stateEarly: { phase: "menu" },
        state: { player: { x: 1, z: 1 } },
      }).pass,
      null,
    );
    assert.equal(
      evaluateProbeCheck({ id: "keys-move-player", kind: "probe", ...template } as never, {
        stateEarly: { player: { x: 0, z: 0 } },
        state: { player: { x: 1, z: 0 } },
      }).pass,
      true,
    );

    // needs follows the expression, never the template: a top-down game moves on x and y, and
    // asking it for the first-person controller's z would report every build unmeasured.
    const topDown = withHarnessChecks({ id: "f", checks: [] as Check[] }, {
      ownsMain: true,
      game: { kind: "top-down" },
    } as never).checks.find((c: { id: string }) => c.id === "keys-move-player") as { expr: string; needs?: string[] };
    assert.deepEqual(topDown.needs, [...new Set([...topDown.expr.matchAll(/delta\('([^']+)'\)/g)].map((m) => m[1]))]);
    assert.ok(topDown.needs!.includes("player.y"), JSON.stringify(topDown));
    assert.equal(
      evaluateProbeCheck({ id: "keys-move-player", kind: "probe", ...topDown } as never, {
        stateEarly: {},
        state: { player: { x: 1, y: 1, z: 1 } },
      }).pass,
      null,
    );
  });

  it("retrieves a recipe from the judge's prose, and an exact failing check still wins", async () => {
    const recipes = await loadRecipes(seedDir);
    const defects = checksFromDefects(["[blob] the reeds are grey faceted balls on sticks"]);
    assert.equal(defects.length, 1);
    assert.equal(defects[0]!.kind, "defect");
    assert.match(defects[0]!.id, /^defect:/);
    const fromProse = recipesForChecks(recipes, defects, 3);
    assert.equal(
      fromProse[0]?.recipe.id,
      "flora.organic-not-solid",
      `prose retrieval: ${fromProse.map((h) => h.recipe.id).join(", ")}`,
    );
    assert.equal(
      fromProse[0]?.primaryCheckId,
      defects[0]!.id,
      "the pseudo-check is what it was retrieved for, so nothing on the board is blamed for it",
    );

    // An exact failing check id beats token overlap with the same words.
    const both = recipesForChecks(recipes, [{ id: "logs-are-cylinders", kind: "scene" }, ...defects], 3);
    assert.equal(both[0]?.recipe.id, "flora.logs-are-cylinders");
    // A defect no craft recipe is about retrieves no craft.
    assert.deepEqual(
      recipesForChecks(
        recipes.filter(isCraftRecipe),
        checksFromDefects(["[timing] an elevator arrives while its button is still animating"]),
        3,
      ),
      [],
    );
    // craftForNewCheck is the same ranking with a floor under it.
    assert.equal(
      craftForNewCheck(recipes, { id: "organic-not-solid", kind: "scene" })[0]?.recipe.id,
      "flora.organic-not-solid",
    );
    assert.deepEqual(craftForNewCheck(recipes, { id: "elevator-arrives", kind: "probe" }), []);
  });

  it("puts craft on a board only when a plan asks for it, by recipe id or by check id, and reports what it could not find", async () => {
    const recipes = await loadRecipes(seedDir);
    const spec = normalizeFacetSpec({
      id: "village",
      intent: "a hamlet",
      checks: [{ id: "houses", kind: "scene", js: "count('house') >= 6" }],
      // Four asked for, MAX_CRAFT kept; one by recipe id, one by check id, one that does not exist.
      craft: ["flora.leaf-cards", "organic-not-solid", "flora.nonesuch", "liveness.three-scales"],
    });
    assert.equal(spec.craft.length, MAX_CRAFT);
    const { spec: board, added, unknown } = withCraftChecks(spec, recipes);
    assert.deepEqual(
      added.map((a) => a.id),
      ["foliage-is-cards", "organic-not-solid"],
    );
    assert.deepEqual(unknown, ["flora.nonesuch"], "the planner's one re-ask gets the id it invented");
    const adopted = board.checks.filter((c: { origin?: string }) => c.origin === "craft");
    assert.equal(adopted.length, 2);
    for (const check of adopted as Array<{ weight: string; fromRecipe?: string }>) {
      assert.equal(check.weight, "normal", "craft is never identity — a facet exists for its own intent");
      assert.ok(check.fromRecipe, "the recipe that owns the body is named on the check");
    }
    assert.equal((adopted[0] as { fromRecipe?: string }).fromRecipe, "flora.leaf-cards");

    // A check already on the board is left as the plan wrote it, and the board's ceiling holds.
    const already = withCraftChecks(
      {
        ...spec,
        checks: [{ id: "organic-not-solid", kind: "scene", js: "true", weight: "identity" }],
        craft: ["organic-not-solid"],
      } as never,
      recipes,
    );
    assert.deepEqual(already.added, []);
    const full = withCraftChecks(
      {
        ...spec,
        checks: Array.from({ length: 16 }, (_, i) => ({ id: `c${i}`, kind: "scene", js: "true" })),
        craft: ["flora.leaf-cards"],
      } as never,
      recipes,
    );
    assert.deepEqual(full.added, []);
    assert.deepEqual(full.dropped, ["flora.leaf-cards"]);

    // A camera the recipe's check names joins the facet's camera list; an eye camera does not.
    const withCamera = withCraftChecks({ ...spec, craft: ["materials.weathered-masonry"] }, recipes);
    assert.deepEqual(
      withCamera.added.map((a) => a.id),
      ["masonry-reads-weathered"],
    );
    assert.ok(!withCamera.spec.cameras.includes("eye:spawn"), "eye cameras are the harness's, never declared");
  });

  it("a craft check never trickles back into the catalogue, and the retired map survives a round trip", async () => {
    const recipes = await loadRecipes(seedDir);
    const { spec: board } = withCraftChecks(
      normalizeFacetSpec({ id: "f", intent: "x", checks: [], craft: ["flora.leaf-cards"] }),
      recipes,
    );
    const catalogue = { version: 2, checks: {} as Record<string, unknown>, retired: {} };
    recordCatalogueOutcomes(catalogue as never, board, { "foliage-is-cards": { pass: false } });
    assert.deepEqual(
      Object.keys(catalogue.checks),
      [],
      "a recipe owns its own body; a copy of it is not the catalogue's to learn about",
    );
    // The same for a judge-grown check that was written off a recipe.
    recordCatalogueOutcomes(
      catalogue as never,
      {
        checks: [
          {
            id: "defect-blob",
            kind: "vision",
            camera: "default",
            ask: "gone?",
            origin: "judge",
            fromRecipe: "flora.organic-not-solid",
          },
        ],
      } as never,
      { "defect-blob": { pass: false } },
    );
    assert.deepEqual(Object.keys(catalogue.checks), []);
    // A planner that hand-writes the id still enters as that plan's own opinion.
    recordCatalogueOutcomes(
      catalogue as never,
      { checks: [{ id: "foliage-is-cards", kind: "scene", js: "true" }] } as never,
      { "foliage-is-cards": { pass: true } },
    );
    assert.deepEqual(Object.keys(catalogue.checks), ["foliage-is-cards"]);

    // The seed's own five are not hypotheses: they are never voted out by use.
    assert.equal(catalogueEntryEarned({ origin: "seed", uses: 9, passes: 0 }), true);
    assert.equal(catalogueEntryEarned({ origin: "planner", uses: 3, passes: 0 }), false);

    const ws = await tmpDir("catalogue-retired-");
    await saveCatalogue(ws, {
      version: 2,
      checks: { keep: { kind: "probe", origin: "seed" } },
      retired: { "foliage-is-cards": { kind: "scene", uses: 7, passes: 2, retiredTo: "flora.leaf-cards" } },
    } as never);
    const reloaded = await loadCatalogue(ws);
    assert.equal(reloaded.version, 2);
    assert.deepEqual(Object.keys(reloaded.checks), ["keep"]);
    assert.equal(
      (reloaded.retired["foliage-is-cards"] as { uses: number }).uses,
      7,
      "the statistics the migration preserved survive the first save",
    );
  });

  it("the craft menu the planner reads stays under three kilobytes", async () => {
    const recipes = await loadRecipes(seedDir);
    const menu = renderCraftForPlanner(recipes);
    assert.ok(menu.length < 3_000, `the craft menu is ${menu.length} characters`);
    assert.match(menu, /technique, not law/);
    assert.match(menu, /### flora/);
    // Only craft is offered; the three techniques are not a menu the planner picks from.
    for (const id of ["camera.named-rig", "stats.draw-call-capture", "contract.seed-step-probes"])
      assert.ok(!menu.includes(id), `${id} is a technique, not craft`);
    assert.equal(renderCraftForPlanner([]), "");
  });
});

describe("scoreboard", () => {
  it("assigns credit mechanically: flips, regressions, identity, exit condition", () => {
    const before = toScoreboard([
      { id: "a", kind: "scene", weight: "identity", pass: true },
      { id: "b", kind: "pixel", weight: "normal", pass: false, reason: "dark" },
    ] as never);
    const after = toScoreboard([
      { id: "a", kind: "scene", weight: "identity", pass: false, reason: "transparent" },
      { id: "b", kind: "pixel", weight: "normal", pass: true },
      { id: "c", kind: "probe", weight: "normal", pass: true },
    ] as never);
    const comparison = compareScoreboards(before, after);
    assert.deepEqual(comparison.flips, ["b", "c"]);
    assert.deepEqual(comparison.regressions, ["a"]);
    assert.deepEqual(comparison.failing, ["a"]);
    const summary = summarizeScoreboard(after, { checks: [1, 2, 3] } as never);
    assert.equal(summary.identityAllPass, false);
    assert.equal(summary.passing, 2);
    assert.match(
      renderScoreboard(after, comparison as never),
      /\[FAIL\] a \(scene, identity\) \(REGRESSED\): transparent/,
    );
    assert.match(renderScoreboard(after, comparison as never), /\[PASS\] b \(pixel\) \(flipped to pass\)/);
    // First iteration: nothing was passing, so every pass is a flip and nothing can regress.
    const first = compareScoreboards({}, after);
    assert.deepEqual(first.flips, ["b", "c"]);
    assert.deepEqual(first.regressions, []);
  });

  it("the invisible-diff detector needs every compared camera to agree", () => {
    assert.equal(
      isInvisibleDiff({ default: { diffFraction: 0.001, compared: 100 }, close: { diffFraction: 0, compared: 100 } }),
      true,
    );
    assert.equal(
      isInvisibleDiff({ default: { diffFraction: 0.001, compared: 100 }, close: { diffFraction: 0.3, compared: 100 } }),
      false,
    );
    assert.equal(isInvisibleDiff({}), false, "no witnesses is not evidence of no change");
    assert.equal(
      isInvisibleDiff({ default: { diffFraction: 0, compared: 0 } }),
      false,
      "an uncompared frame is not a witness",
    );
  });
});

/**
 * M3.2 — the judges, corrected. Every case here is a real misjudgement:
 * a round kept on a question the judge had written for itself, two questions about one trunk
 * that answered differently, a crop question about a number, and a question nobody could answer
 * that held its slot to the end.
 */
describe("judges that keep the right build", () => {
  const plan = {
    id: "cars2",
    cameras: ["default", "camCars"],
    checks: [
      { id: "wheels-turn", kind: "scene", origin: "planner" },
      { id: "shell-lit", kind: "vision", camera: "default", origin: "planner" },
      { id: "defect-trunk-flat", kind: "vision", camera: "camCars", origin: "judge", defect: "the trunk deck is flat" },
    ],
  };

  it("a first 'yes' on a question the incumbent never measured needs the judge to mean it", () => {
    const grown = (confidence: number) =>
      toScoreboard([{ id: "defect-trunk-flat", kind: "vision", weight: "normal", pass: true, confidence }] as never);
    // Nothing measured it before, so there is no "before" to have improved on: the same answer
    // against a measured "no" would not have flipped it either (settleVision's 0.7 bar).
    assert.deepEqual(compareScoreboards({}, grown(0.5)).flips, []);
    assert.deepEqual(compareScoreboards({}, grown(0.7)).flips, ["defect-trunk-flat"]);
    // A mechanical check measures itself: its first pass is a real win over nothing, as ever.
    assert.deepEqual(
      compareScoreboards(
        {},
        toScoreboard([{ id: "wheels-turn", kind: "scene", weight: "normal", pass: true }] as never),
      ).flips,
      ["wheels-turn"],
    );
    // And a measured fail still flips on any confidence the settler already let through.
    const measured = toScoreboard([
      { id: "defect-trunk-flat", kind: "vision", weight: "normal", pass: false, reason: "named by the judge" },
    ]);
    assert.deepEqual(compareScoreboards(measured, grown(0.5)).flips, ["defect-trunk-flat"]);
  });

  it("only the judge's own note flipping does not outrank the side-by-side pick", () => {
    const board = toScoreboard([
      { id: "defect-trunk-flat", kind: "vision", weight: "normal", pass: true, confidence: 0.8 },
    ] as never);
    const comparison = { flips: ["defect-trunk-flat"], regressions: [] };
    assert.deepEqual(strongFlips(plan, board, comparison.flips), [], "a judge-grown question is a hint, not proof");
    const kept = acceptRound({ spec: plan, board, comparison, taste: { pick: "incumbent", veto: false } });
    assert.equal(kept.accepted, false, "the judge preferred the round before, and that decides it");
    assert.equal(kept.source, "taste");
    // The same round with the judge on its side is still kept — the pick decides, both ways.
    assert.equal(
      acceptRound({ spec: plan, board, comparison, taste: { pick: "challenger", veto: false } }).accepted,
      true,
    );
  });

  it("a planner check flipping still wins on its own, and only a named regression undoes it", () => {
    const board = toScoreboard([
      { id: "shell-lit", kind: "vision", weight: "normal", pass: true, confidence: 0.9 },
    ] as never);
    const comparison = { flips: ["shell-lit"], regressions: [] };
    assert.deepEqual(
      strongFlips(plan, board, comparison.flips),
      ["shell-lit"],
      "the plan's own vision check is part of the contract",
    );
    const kept = acceptRound({ spec: plan, board, comparison, taste: { pick: "incumbent", veto: false } });
    assert.equal(kept.accepted, true, "a measured flip beats a bare preference");
    assert.equal(kept.source, "checks");
    const vetoed = acceptRound({ spec: plan, board, comparison, taste: { pick: "incumbent", veto: true } });
    assert.equal(vetoed.accepted, false);
    assert.equal(vetoed.source, "taste-veto");
    // No flip at all and a move that never arrived: the old rule, unchanged.
    const nothing = acceptRound({
      spec: plan,
      board: {},
      comparison: { flips: [], regressions: [] },
      taste: { pick: "challenger", veto: false },
      moveMissing: true,
    } as never);
    assert.equal(nothing.accepted, false);
    assert.equal(nothing.source, "no-move");
  });

  it("two wordings of one defect on one camera never grow twins", () => {
    // The run's own pair: `defect-coupe-trunk-deck-reads-as-a-smoot` and its `-2` twin, which
    // then answered differently — one "yes", one "no" at 0.80 — and the round was kept on the yes.
    const first = "coupe's trunk deck reads as a smooth red panel with no shutline or lamp detail";
    const second =
      "coupe's trunk deck reads as a smooth featureless slab; the reference has a raised lip, tail lamps and a plate recess";
    assert.equal(
      similarDefect(first, second),
      false,
      "whole-text similarity misses this pair — that is why it happened",
    );
    const spec = { id: "cars2", cameras: ["default", "camCars"], checks: [] as unknown[] };
    const grown = defectsToChecks(spec as never, [first], { iteration: 2 });
    assert.equal(grown.length, 1);
    spec.checks.push(...grown);
    assert.deepEqual(
      defectsToChecks(spec as never, [second], { iteration: 3 }),
      [],
      "the same complaint, the same camera, no second question",
    );
    // Two wordings in one batch are one question too.
    assert.equal(
      defectsToChecks({ id: "cars2", cameras: ["default", "camCars"], checks: [] }, [first, second], { iteration: 2 })
        .length,
      1,
    );
    // A different complaint on the same camera is still its own question.
    assert.equal(
      defectsToChecks(spec as never, ["the roof pillars are untextured grey posts"], { iteration: 3 }).length,
      1,
    );
  });

  it("a defect about a reading goes to the ledger with the expression that would measure it", () => {
    const spec = { id: "contact2", cameras: ["default", "camWheel"], checks: [] as unknown[] };
    const notes: Array<{ text: string; suggestedProbe: string | null }> = [];
    const grown = defectsToChecks(
      spec as never,
      ["the live probe reports speedKept 0.069 while the HUD shows 4 km/h"],
      {
        iteration: 2,
        noteDefect: ((note: { text: string; suggestedProbe: string | null }) => notes.push(note)) as never,
      } as never,
    );
    assert.deepEqual(grown, [], "no crop question about a number");
    assert.equal(notes.length, 1);
    assert.match(notes[0]!.text, /speedKept/);
    assert.equal(notes[0]!.suggestedProbe, "state.speedKept > 0.069");
    // The suggestion is the check language, not prose: the planner's own parser accepts it.
    assert.doesNotThrow(() => parseExpr(notes[0]!.suggestedProbe!));
    assert.equal(suggestedProbe("no probe readout of contact.speedKept is visible"), "has('state.contact.speedKept')");
    assert.equal(suggestedProbe("the console logs a shader warning"), null, "prose names no field to probe");
    // A defect about something the camera CAN see still becomes a question, numbers and all.
    assert.equal(
      defectsToChecks(spec as never, ["the mud coverage reads 0.81 but the tyres are clean — camWheel"], {
        iteration: 2,
      }).length,
      1,
    );
  });

  it("a question a picture cannot answer retires after two hedges and gives its slot back", () => {
    const failing = {
      id: "defect-probe-readout",
      kind: "vision",
      weight: "normal",
      pass: false,
      reason: "named by the judge",
    };
    // The run's actual answers: "no, no readout is visible" at 0.20, twice.
    const first = settleVision(failing, {
      id: "defect-probe-readout",
      kind: "vision",
      weight: "normal",
      pass: false,
      confidence: 0.2,
      answer: "no",
    } as never);
    assert.equal(first.stuck, true);
    const second = settleVision(first, {
      id: "defect-probe-readout",
      kind: "vision",
      weight: "normal",
      pass: false,
      confidence: 0.2,
      answer: "no",
    } as never);
    assert.equal(second.stuck, true);
    // A hedged "yes" on a failing question settles nothing either — it is carried, not counted.
    assert.equal(
      settleVision(failing, {
        id: "defect-probe-readout",
        kind: "vision",
        weight: "normal",
        pass: true,
        confidence: 0.3,
        answer: "yes",
      } as never).stuck,
      true,
    );
    // A confident answer is not stuck, whichever way it goes.
    assert.equal(
      settleVision(failing, {
        id: "defect-probe-readout",
        kind: "vision",
        weight: "normal",
        pass: false,
        confidence: 0.9,
        answer: "no",
      } as never).stuck,
      false,
    );
    assert.equal(
      settleVision(failing, {
        id: "defect-probe-readout",
        kind: "vision",
        weight: "normal",
        pass: true,
        confidence: 0.8,
        answer: "yes",
      } as never).stuck,
      false,
    );

    const spec = {
      id: "contact2",
      cameras: ["default"],
      checks: [1, 2, 3, 4].map((n) => ({
        id: `defect-${n}`,
        kind: "vision",
        camera: "default",
        origin: "judge",
        defect: `problem number ${n} is still plainly there`,
      })),
    };
    assert.deepEqual(
      defectsToChecks(spec, ["the wheel arches sit above the tyres"], { iteration: 5 }),
      [],
      "a full board has no room",
    );
    assert.deepEqual(judgeChecksToRetire(spec, { stucks: { "defect-2": 1 } }), [], "one hedge is not enough");
    const retiring = judgeChecksToRetire(spec, { passes: { "defect-1": 2 }, stucks: { "defect-2": 2 } });
    assert.deepEqual(
      retiring.map((entry) => [entry.check.id, entry.why]),
      [
        ["defect-1", "passed"],
        ["defect-2", "unanswerable"],
      ],
    );
    spec.checks = spec.checks.filter((check) => !retiring.some((entry) => entry.check.id === check.id));
    assert.equal(
      defectsToChecks(spec, ["the wheel arches sit above the tyres"], { iteration: 6 }).length,
      1,
      "the freed slot takes a question a judge can answer",
    );
  });

  it("the plan's checks and the judge's notes are counted apart, everywhere", () => {
    const spec = {
      checks: [
        { id: "wheels-turn", kind: "scene", origin: "planner" },
        { id: "shell-lit", kind: "vision", origin: "planner" },
        { id: "speed-kept", kind: "probe", origin: "harness" },
        { id: "mud-visible", kind: "vision", origin: "planner" },
        { id: "hud-legible", kind: "vision", origin: "planner" },
        { id: "demo-drift", kind: "demo", origin: "planner" },
        { id: "cam-spawn", kind: "pixel", origin: "planner" },
        { id: "trim-lit", kind: "vision", origin: "planner" },
        { id: "lamps-on", kind: "vision", origin: "planner" },
        { id: "defect-trunk", kind: "vision", origin: "judge" },
        { id: "defect-arches", kind: "vision", origin: "judge" },
        { id: "defect-readout", kind: "vision", origin: "judge" },
      ],
    };
    const board = toScoreboard([
      { id: "wheels-turn", kind: "scene", weight: "identity", pass: true },
      { id: "shell-lit", kind: "vision", weight: "normal", pass: true },
      { id: "speed-kept", kind: "probe", weight: "identity", pass: true },
      { id: "mud-visible", kind: "vision", weight: "normal", pass: false, reason: "no mud" },
      { id: "hud-legible", kind: "vision", weight: "normal", pass: false, reason: "cut off" },
      { id: "demo-drift", kind: "demo", weight: "normal", pass: null, state: "unmeasured", reason: "demo cap" },
      { id: "cam-spawn", kind: "pixel", weight: "normal", pass: null, state: "unmeasured", reason: "camera lost" },
      { id: "trim-lit", kind: "vision", weight: "normal", pass: null, state: "unmeasured", reason: "camera lost" },
      { id: "lamps-on", kind: "vision", weight: "normal", pass: null, state: "unmeasured", reason: "camera lost" },
      { id: "defect-trunk", kind: "vision", weight: "normal", pass: false, reason: "still flat" },
      { id: "defect-arches", kind: "vision", weight: "normal", pass: false, reason: "still high" },
      { id: "defect-readout", kind: "vision", weight: "normal", pass: false, reason: "no readout visible" },
    ] as never);
    const summary = summarizeScoreboard(board, spec as never);
    assert.equal(summary.total, 12, "everything measured is still counted for anyone who wants it");
    assert.equal(summary.plannedTotal, 9);
    assert.equal(summary.plannedPassing, 3);
    assert.equal(summary.plannedUnmeasured, 4);
    assert.equal(summary.grownTotal, 3);
    assert.equal(summary.grownPassing, 0);
    // What the round card, the round drawer, the judges' sheet and the chat all print.
    assert.equal(checkCounts(summary), "Passed 3 · Failed 2 · Couldn't measure 4 · 3 reviewer notes");
    // A run from before the split still reads exactly as it did.
    assert.equal(checkCounts({ total: 12, passing: 3, unmeasured: 4 }), "Passed 3 · Failed 5 · Couldn't measure 4");
  });

  it("a judge's own question retired in the round it flipped is still not one of the plan's flips", () => {
    // pass → fail → pass: the second pass lands on the very round the check flips, so the round
    // both counts the flip and retires the question. The spec no longer holds it a moment later,
    // and the card would read "+1 · kept" for a question the judge wrote itself.
    const spec = {
      checks: [
        { id: "wheels-turn", kind: "scene", origin: "planner" },
        { id: "defect-trunk", kind: "vision", origin: "judge", defect: "the trunk lid still sits proud" },
      ],
    };
    const flips = ["wheels-turn", "defect-trunk"];
    const retiring = judgeChecksToRetire(spec as never, { passes: { "defect-trunk": 2 } });
    assert.deepEqual(
      retiring.map((entry) => entry.check.id),
      ["defect-trunk"],
    );
    const retired = retiring.map((entry) => entry.check.id);
    spec.checks = spec.checks.filter((check) => !retired.includes(check.id));

    const grown = grownCheckIds(spec, retired);
    assert.deepEqual(
      flips.filter((id) => !grown.has(id)),
      ["wheels-turn"],
    );
    // Which the spec on its own can no longer say, because the question has left it.
    assert.deepEqual(
      flips.filter((id) => !grownCheckIds(spec).has(id)),
      ["wheels-turn", "defect-trunk"],
    );
  });
});

describe("pixel statistics, extended", () => {
  it("reports a histogram, band means, saturation and contrast beside the classic numbers", () => {
    const width = 30;
    const height = 30;
    const buffer = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        // Top third white, bottom two thirds black; right third pure red.
        const white = y < 10;
        const red = x >= 20;
        buffer.set(red ? [0, 0, 255, 255] : white ? [255, 255, 255, 255] : [0, 0, 0, 255], i);
      }
    }
    const stats = computePixelStats(buffer, width, height);
    assert.ok(stats.histogram && stats.histogram.length === 32);
    assert.ok(Math.abs(stats.histogram.reduce((a, b) => a + b, 0) - 1) < 1e-9, "histogram sums to 1");
    assert.ok(stats.bands!.top > stats.bands!.bottom, "top band brighter than bottom");
    assert.ok(stats.bands!.right < stats.bands!.left, "pure red is darker than white");
    assert.ok(
      stats.saturation! > 0.3 && stats.saturation! < 0.4,
      `a third of pixels fully saturated → ${stats.saturation}`,
    );
    assert.ok(stats.contrast! > 60, `high contrast frame → ${stats.contrast}`);
    const above = fractionAbove(stats, 0.9)!;
    assert.ok(above > 0.2 && above < 0.25, `white ≈ 2/9 of pixels → ${above}`);
    assert.ok(fractionBelow(stats, 0.1)! > 0.4);
  });

  it("diffs two frames: fraction changed, mean difference, a 3×3 grid of where", () => {
    const a = bitmap(60, 30, [0, 0, 0, 255]);
    const b = bitmap(60, 30, [0, 0, 0, 255]);
    // Light up the top-left cell only.
    for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) b.set([255, 255, 255, 255], (y * 60 + x) * 4);
    const diff = computePixelDiff(a, b, 60, 30);
    assert.ok(Math.abs(diff.diffFraction - 1 / 9) < 0.01, `one cell of nine changed → ${diff.diffFraction}`);
    assert.ok(diff.grid[0]! > 0.99 && diff.grid[8]! === 0, `grid ${diff.grid.join(",")}`);
    assert.equal(diff.compared, 1800);
    const same = computePixelDiff(a, a, 60, 30);
    assert.equal(same.diffFraction, 0);
    const mismatch = computePixelDiff(a, Buffer.alloc(0), 60, 30);
    assert.equal(mismatch.compared, 0, "an empty frame compares nothing");
    const cells = computePixelDiff(a, b, 60, 30, { cells: { x: 3, y: 3 } });
    assert.equal(cells.cells?.values.length, 9);
  });
});

describe("technique library", () => {
  const recipe = normalizeRecipe({
    id: "reflection.planar-mirror",
    title: "Planar mirror water with a ≥1024 render target",
    tags: ["water", "mirror", "reflection", "rt", "planar"],
    intent: "x",
    sketch: "const rt = new THREE.WebGLRenderTarget(1024, 1024);",
    check: { id: "mirror-rt", kind: "scene", js: "renderTargets().some(rt => rt.width >= 1024)" },
  });

  it("retrieves recipes by check tokens and ranks promoted ones higher", () => {
    assert.ok(scoreRecipe(recipe!, { id: "mirror-rt", kind: "scene" }) > 0);
    assert.equal(scoreRecipe(recipe!, { id: "fog-band", kind: "pixel" }), 0);
    const promoted = { ...recipe!, id: "b", status: "promoted", stats: { applied: 0, wins: 0, losses: 0 } };
    const hits = recipesForChecks(
      [recipe!, promoted],
      [{ id: "water-mirror", kind: "vision", ask: "reflection visible?" }],
    );
    assert.equal(hits[0]!.recipe.id, "b", "promoted first at equal overlap");
    assert.deepEqual(hits[0]!.checkIds, ["water-mirror"]);
  });

  it("promotes on wins and retires on losses — counts, not votes", () => {
    const r = normalizeRecipe({ ...recipe, id: "gate" })!;
    applyRecipeOutcome(r, { checkId: "mirror-rt", flipped: true });
    assert.equal(r.status, "candidate");
    applyRecipeOutcome(r, { checkId: "mirror-rt", flipped: true });
    assert.equal(r.status, "promoted");
    for (let i = 0; i < 5; i++) applyRecipeOutcome(r, { checkId: "mirror-rt", flipped: false });
    assert.equal(r.status, "retired");
    assert.match(String(r.retiredBecause), /5 losses against 2 wins/);
    assert.equal(
      recipesForChecks([r], [{ id: "mirror-rt", kind: "scene" }]).length,
      0,
      "retired recipes never come back",
    );
  });

  it("keeps a seeded recipe's own bytes, and its wins beside the library", async () => {
    // A run that rewrote the shipped file made every later correction to the technique
    // undeliverable: applySeed keeps a workspace file it did not write.
    const workspace = pathMod.join(await tmpDir("recipe-state-"), "ws");
    const file = pathMod.join(workspace, "library", "recipes", "seeded.json");
    await mkdir(pathMod.dirname(file), { recursive: true });
    const shipped = `${JSON.stringify({ ...recipe, id: "seeded", origin: "seed" }, null, 2)}\n`;
    await writeFile(file, shipped);

    const [loaded] = await loadRecipes(workspace);
    applyRecipeOutcome(loaded!, { checkId: "mirror-rt", flipped: true });
    applyRecipeOutcome(loaded!, { checkId: "mirror-rt", flipped: true });
    await saveRecipe(workspace, loaded!);

    assert.equal(await readFile(file, "utf8"), shipped, "the seeded recipe still matches what the seed ships");
    const state = JSON.parse(await readFile(pathMod.join(workspace, "library", "recipe-stats.json"), "utf8"));
    assert.equal(state.seeded.status, "promoted");
    assert.equal(state.seeded.stats.wins, 2);
    const [again] = await loadRecipes(workspace);
    assert.equal(again!.status, "promoted", "the sidecar is read back over the shipped body");
    assert.equal(again!.stats.wins, 2);

    // A recipe a spike wrote is nobody's seed: it still owns its whole file.
    const spiked = normalizeRecipe({ ...recipe, id: "spiked", origin: "spike" })!;
    await saveRecipe(workspace, spiked);
    assert.match(
      await readFile(pathMod.join(workspace, "library", "recipes", "spiked.json"), "utf8"),
      /"origin": "spike"/,
    );
  });

  it("the brief carries scoreboard, attempts, recipes and steering — and only relevant recipes", () => {
    const text = renderBrief({
      run: { runId: "run_x", goal: "a marsh" },
      spec: {
        id: "water",
        title: "Water",
        intent: "a mirror marsh",
        identity: ["mirror"],
        owns: ["src/water.js"],
        cameras: ["default"],
        checks: [{ id: "mirror-rt", kind: "scene", js: "renderTargets().length > 0", weight: "identity" }],
      },
      iteration: 3,
      board: toScoreboard([
        { id: "mirror-rt", kind: "scene", weight: "identity", pass: false, reason: "no render target" },
      ]),
      comparison: { flips: [], regressions: [] },
      attempts: [
        {
          iteration: 2,
          branch: "refs/studio/runs/run_x/attempts/water/2",
          flips: [],
          regressions: [],
          why: "nothing flipped",
          diffStat: " src/water.js | 12 ++",
        },
      ],
      recipes: recipesForChecks([recipe!], [{ id: "mirror-rt", kind: "scene" }]),
      steering: ["make the water darker"],
    } as never);
    assert.match(text, /USER STEERING[\s\S]*make the water darker/);
    assert.match(text, /\[FAIL\] mirror-rt \(scene, identity\)/);
    // Flipped: every round used to read "kept on <ref>", accepted
    // or not; a round now says whether it was kept or lost, and where its code is.
    assert.match(text, /iteration 2, lost — its code is on refs\/studio\/runs\/run_x\/attempts\/water\/2/);
    assert.match(text, /Planar mirror water/);
    assert.match(text, /WebGLRenderTarget\(1024/);
    assert.match(text, /Work identity checks first: mirror-rt/);
  });

  it("names the template's own modules in THE FIX only to a worker inside the template", () => {
    // M4.6 gates every template-specific rule on `template`. THE FIX kept naming foliage.js and
    // materials.js to a game the user brought, where neither module exists and the worker's seam
    // forbids creating them at those paths — a round spent looking for files that are not there.
    const args = {
      run: { runId: "r", goal: "g" },
      spec: { id: "trees", title: "Trees", intent: "a wood", checks: [] },
      iteration: 3,
      board: {},
      comparison: null,
      fix: { what: "[blob] the trees are grey faceted balls on posts — camA", streak: 2, mandatory: true },
    };
    const template = String(renderBrief({ ...args, template: true } as never));
    assert.match(template, /rebuilt from cards or parts \(`foliage\.js`\)/);
    assert.match(template, /a baked material kind \(`materials\.js`\)/);

    const own = String(renderBrief({ ...args, template: false, screen: false } as never));
    assert.match(own, /## THE FIX this iteration \(mandatory/);
    assert.match(own, /Replace the mechanism behind it, do not tune it\./);
    assert.doesNotMatch(own, /foliage\.js/, "the studio template's modules are not in this game");
    assert.doesNotMatch(own, /materials\.js/);
    assert.match(own, /the way this game already builds its objects/);
    assert.match(own, /a material this game's renderer can bake/);
    // The rules below it are the own-shape ones, so the whole brief speaks about one game.
    assert.match(own, /THIS GAME'S INPUT PATH/);
    assert.doesNotMatch(own, /rng from update\(\)/);

    // Historical runtime metadata is not tool authority. Only the active plugin
    // registry may advertise a modeller; a stored run must not resurrect it.
    const modelled = String(
      renderBrief({
        ...args,
        template: false,
        screen: false,
        run: { runId: "r", goal: "g", blender: { version: "5.2.1" } },
      } as never),
    );
    assert.doesNotMatch(modelled, /blender/i, "old runtime metadata cannot inject a disabled tool");
    assert.match(modelled, /the way this game already builds its objects/);
    assert.ok(!/blender/i.test(own), "no registry guidance, no Blender words");
  });

  it("parses a spike's RECIPE.md into a recipe", () => {
    const parsed = parseRecipeMarkdown(
      "# Knee-band fog\n\n## Intent\nA thin layer.\n\n## Sketch\n```js\nconst fog = 1;\n```\n\n## Port\nPut it in atmosphere.js.\n",
    );
    assert.equal(parsed.title, "Knee-band fog");
    assert.equal(parsed.intent, "A thin layer.");
    assert.equal(parsed.sketch, "const fog = 1;");
    assert.equal(parsed.port, "Put it in atmosphere.js.");
  });
});

describe("code reviewer, mechanical half", () => {
  it("parses a diff into added lines per file", () => {
    const files = parseDiff("--- a/src/x.js\n+++ b/src/x.js\n@@ -3,2 +3,3 @@\n context\n+added\n-removed\n");
    assert.deepEqual(files.get("src/x.js")?.added, [{ line: 4, text: "added" }]);
    assert.deepEqual(files.get("src/x.js")?.removed, ["removed"]);
  });

  it("flags Math.random, wall clock, untagged batches, and edits outside ownership", () => {
    const diff = [
      "+++ b/src/city.js",
      "@@ -1,0 +1,5 @@",
      "+const r = Math.random();",
      "+const t = performance.now();",
      "+const m = new THREE.Mesh();",
      "+const n = new THREE.Mesh();",
      "+const o = new THREE.Group();",
      "+++ b/src/lighting.js",
      "@@ -1,0 +1,1 @@",
      "+export const x = 1;",
    ].join("\n");
    const violations = mechanicalReview(diff, { id: "city", owns: ["src/city.js"], checks: [] });
    assert.ok(violations.some((v) => /Math\.random/.test(v.what)));
    assert.ok(violations.some((v) => /wall-clock/.test(v.what)));
    assert.ok(violations.some((v) => /none tagged/.test(v.what)));
    assert.ok(violations.some((v) => /outside this facet's ownership \(src\/lighting\.js\)/.test(v.what)));
    assert.ok(violations.every((v) => v.source === "mechanical"));
  });

  it("stays quiet on a clean diff, and catches a removed contract", () => {
    assert.deepEqual(
      mechanicalReview(
        "+++ b/src/city.js\n@@ -1,0 +1,2 @@\n+const m = new THREE.Mesh();\n+m.userData.tag = 'roof';\n",
        { id: "city", owns: ["src/city.js"], checks: [] },
      ),
      [],
    );
    const removed = mechanicalReview(
      "+++ b/src/main.js\n@@ -1,1 +1,1 @@\n-installStudio({ scene });\n+// gone\n",
      { id: "main", owns: ["src/main.js"], checks: [] },
      { ownsMain: true },
    );
    assert.ok(removed.some((v) => /installStudio\(\) call removed/.test(v.what)));
  });

  it("flags a build that writes the studio's own evidence globals, and never a build that reads them", () => {
    // The globals are behind accessors that ignore a write, so this is a second belt: a build
    // telling the studio what it drew is a build the judge would be reading back to itself.
    const wrote = [
      "+++ b/src/city.js",
      "@@ -1,0 +1,6 @@",
      "+window.__studioClock = { stats() { return { drawCalls: 9999 }; } };",
      "+window.__studioDraw.drawCalls = 500;",
      '+Object.defineProperty(window, "__studioCapture", { value: fake });',
      "+const clock = window.__studioClock;",
      "+if (window.__studioClock == null) return;",
      "+const on = window.__studioHook !== undefined;",
    ].join("\n");
    const violations = mechanicalReview(wrote, { id: "city", owns: ["src/city.js"], checks: [] });
    const evidence = violations.filter((v) => v.category === "evidence");
    assert.equal(
      evidence.length,
      3,
      `one per write, none per read: ${violations.map((v) => `${v.line}:${v.what}`).join(" | ")}`,
    );
    assert.deepEqual(
      evidence.map((v) => v.line),
      [1, 2, 3],
    );
    assert.ok(evidence.every((v) => /must be the page's own/.test(v.what)));
    // The same rule reaches a game the studio did not scaffold: it is not a template rule.
    const ownShape = mechanicalReview(
      "+++ b/src/world.ts\n@@ -1,0 +1,1 @@\n+window.__studioGl = null;\n",
      { id: "world", owns: ["src/world.ts"], checks: [] },
      { template: false },
    );
    assert.ok(
      ownShape.some((v) => v.category === "evidence"),
      ownShape.map((v) => v.what).join(" | "),
    );
  });

  /**
   * One owner of the screen: a part that does not own the screen publishes its values; drawing
   * them is the owner's call.
   */
  it("finds a part drawing on a screen another part owns, and says nothing when no part owns it", () => {
    const meter = [
      "+++ b/src/race/pursuit.js",
      "@@ -1,0 +1,4 @@",
      "+export const heat = { value: 0 };",
      "+__studio.hud.bar('heat', { value: heat.value, anchor: 'top-right' });",
      "+hud.text('wanted', 'WANTED');",
      "+const label = hud.textLabel;",
    ].join("\n");
    const race = { id: "race", owns: ["src/race/"], checks: [], screenOwner: "hud" };
    const found = mechanicalReview(meter, race).filter((v) => v.category === "screen-owner");
    assert.deepEqual(
      found.map((v) => v.line),
      [2, 3],
      `one finding per drawing line: ${found.map((v) => v.what).join(" | ")}`,
    );
    assert.match(found[0]!.what, /"hud" owns/);
    assert.match(String(found[0]!.fix), /__studio\.state\(\)/);
    const owner = { id: "hud", owns: ["src/race/"], checks: [], ownsScreen: true, screenOwner: "hud" };
    assert.deepEqual(
      mechanicalReview(meter, owner).filter((v) => v.category === "screen-owner"),
      [],
      "the owner draws",
    );
    const nobody = mechanicalReview(meter, { id: "race", owns: ["src/race/"], checks: [] });
    assert.deepEqual(
      nobody.filter((v) => v.category === "screen-owner"),
      [],
      "with no part owning the screen the rule is inert, as before",
    );
    const own = mechanicalReview(meter, race, { template: false });
    assert.deepEqual(
      own.filter((v) => v.category === "screen-owner"),
      [],
      "a game of its own draws however it already does",
    );
    const quiet = mechanicalReview("+++ b/src/race/pursuit.js\n@@ -1,0 +1,1 @@\n+export const heat = 1;\n", race);
    assert.deepEqual(quiet, []);
  });

  /** Review of WP-SCOPE-2: reading the HUD (a probe of what it shows) is not drawing on it. */
  it("lets a part read the HUD another part owns, and finds it changing it", () => {
    const lines = [
      "+const shown = { hudIds: () => __studio.hud.items() };",
      "+const speed = hud.get('speed');",
      "+__studio.hud.remove('speed');",
      "+hud.clear();",
      "+__studio.hud.enable(false);",
    ];
    const diff = ["+++ b/src/race/probe.js", `@@ -1,0 +1,${lines.length} @@`, ...lines].join("\n");
    const race = { id: "race", owns: ["src/race/"], checks: [], screenOwner: "hud" };
    const found = mechanicalReview(diff, race).filter((v) => v.category === "screen-owner");
    assert.deepEqual(
      found.map((v) => v.line),
      [3, 4, 5],
      `reads pass, changes are the owner's: ${found.map((v) => v.line).join(", ")}`,
    );
  });

  /**
   * Review of WP-SCOPE-2: the HUD part restarted (`replaces=hud`) without critic=screen lost the
   * screen, and every HUD line it drew was a finding naming the part it replaced.
   */
  it("hands the screen to the part that replaces its owner", async () => {
    const { linkScreenOwner } = await import("../../src/harness-seed/loop/screen-owner.ts");
    const hud: Record<string, unknown> = { id: "hud", ownsScreen: true };
    const race: Record<string, unknown> = { id: "race" };
    const specs = [hud, race];
    linkScreenOwner(specs, hud);
    linkScreenOwner(specs, race);
    const again: Record<string, unknown> = { id: "hud-2", owns: ["src/hud/"], checks: [] };
    specs.push(again);
    linkScreenOwner(specs, again, "hud");
    assert.equal(again.ownsScreen, true, "the replacement owns the screen");
    assert.equal(race.screenOwner, "hud-2", "and the other parts learn it");
    const drawing = "+++ b/src/hud/speed.js\n@@ -1,0 +1,1 @@\n+hud.text('speed', '120 km/h');\n";
    assert.deepEqual(
      mechanicalReview(drawing, again as never).filter((v) => v.category === "screen-owner"),
      [],
    );
    const other: Record<string, unknown> = { id: "lights" };
    specs.push(other);
    linkScreenOwner(specs, other, "race");
    assert.equal(other.ownsScreen, undefined, "replacing a part that never owned the screen gives none");
    assert.equal(other.screenOwner, "hud-2");
  });

  it("says the same thing to the model half of the review", () => {
    const rubric = readFileSync(pathMod.join(repoRoot, "src/harness-seed/judge/code-review.md"), "utf8");
    for (const global of ["__studioClock", "__studioDraw", "__studioCapture", "__studioGl", "__studioHook"])
      assert.match(rubric, new RegExp(`\\b${global}\\b`), `the rubric never names ${global}`);
  });
});

describe("judge helpers", () => {
  it("a facet judge sees only the facet's cameras plus demo end-frames", () => {
    const shots = [{ camera: "default" }, { camera: "close" }, { camera: "camBridge" }, { camera: "demo:walk" }];
    assert.deepEqual(
      selectShots(shots, ["default", "camBridge"] as never).map(((s: { camera: string }) => s.camera) as never),
      ["default", "camBridge", "demo:walk"],
    );
    assert.equal(selectShots(shots, null).length, 4);
  });

  it("panel votes rotate through camera subsets", () => {
    const shots = [{ camera: "default" }, { camera: "close" }, { camera: "wide" }, { camera: "eye:spawn" }];
    assert.equal(cameraSubset(shots, 0, 3), null);
    assert.deepEqual(cameraSubset(shots, 1, 3), ["default", "close"]);
    assert.deepEqual(cameraSubset(shots, 2, 3), ["wide", "eye:spawn"]);
  });

  it("spike candidates: hard checks at once, identity checks after two failures", () => {
    const spec = {
      checks: [
        { id: "mirror", kind: "scene", weight: "identity" },
        { id: "hard", kind: "pixel", weight: "normal", hard: true },
        { id: "soft", kind: "pixel", weight: "normal" },
        { id: "play", kind: "play", weight: "identity", hard: true },
      ],
    };
    assert.deepEqual(
      spikeCandidates(spec, { mirror: 2, soft: 9 }, new Set()).map((c: { id: string }) => c.id),
      ["mirror", "hard"],
    );
    assert.deepEqual(
      spikeCandidates(spec, { mirror: 1 }, new Set(["hard"])).map((c: { id: string }) => c.id),
      [],
    );
  });
});

describe("the loop's self-test (the architect's bar)", () => {
  it("passes on the shipped seed", async () => {
    const result = await runSelftest();
    assert.equal(result.ok, true);
    assert.ok(result.passed.length >= 9);
  });
});

describe("planner (decompose) over a stub substrate", () => {
  async function workspaceWithSkill(skill: string): Promise<string> {
    const workspace = pathMod.join(await tmpDir("planner-"), "ws");
    await mkdir(pathMod.join(workspace, "skills"), { recursive: true });
    await writeFile(pathMod.join(workspace, "skills", "facet-decomposition.md"), skill);
    return workspace;
  }

  it("re-asks once with the exact problems, then drops what is still unusable", async () => {
    const workspace = await workspaceWithSkill('---\nname: x\ndescription: y\n---\nOutput JSON with "checks".');
    const prompts: string[] = [];
    let calls = 0;
    const ctx = {
      workspace,
      call: async (method: string, params: { messages?: Array<{ content: string }>; systemPrompt?: string }) => {
        if (method !== "engine.complete") throw new Error(method);
        calls++;
        prompts.push(params.messages!.map((m) => m.content).join("\n"));
        const bad = {
          facets: [
            {
              id: "sky",
              intent: "a sky",
              checks: [
                { id: "a", kind: "pixel", camera: "default", expr: "top >" },
                { id: "b", kind: "warp" },
              ],
              budgetShare: 1,
            },
          ],
          mainOwner: "sky",
        };
        const fixed = {
          facets: [
            {
              id: "sky",
              intent: "a sky",
              checks: [
                { id: "a", kind: "pixel", camera: "default", expr: "top > 0.4" },
                { id: "b", kind: "warp" },
              ],
              budgetShare: 1,
            },
          ],
          mainOwner: "sky",
        };
        return { message: { role: "assistant", content: JSON.stringify(calls === 1 ? bad : fixed) } };
      },
    };
    const plan = await decompose(
      ctx as never,
      { run: { runId: "r", goal: "g" }, profile: { maxParallel: 3, delegated: true } } as never,
    );
    assert.equal(calls, 2, "one re-ask");
    assert.match(prompts[1]!, /Your plan has problems[\s\S]*does not parse[\s\S]*unknown kind "warp"/);
    assert.deepEqual(
      plan.facets[0]!.checks.map((c: { id: string }) => c.id),
      ["a"],
      "the corrected check survives, the unusable one is dropped",
    );
    assert.ok(
      plan.assumptions.some((a: string) => /dropped 1 unusable check/.test(a)),
      "the drop is a decision card",
    );
  });

  it("an install whose planner skill predates typed specs still gets the v2 vocabulary", async () => {
    const workspace = await workspaceWithSkill(
      '---\nname: old\ndescription: prose facets\n---\nOutput {"facets":[{"id","title","brief"}]}.',
    );
    let system = "";
    const ctx = {
      workspace,
      call: async (_method: string, params: { systemPrompt?: string }) => {
        system = params.systemPrompt ?? "";
        return {
          message: {
            role: "assistant",
            content: JSON.stringify({
              facets: [
                {
                  id: "one",
                  intent: "x",
                  checks: [{ id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.5" }],
                  budgetShare: 1,
                },
              ],
            }),
          },
        };
      },
    };
    const plan = await decompose(
      ctx as never,
      { run: { runId: "r", goal: "g" }, profile: { maxParallel: 1, delegated: false } } as never,
    );
    assert.match(system, /Typed specs \(v2/, "the fallback schema rides on an old skill");
    assert.equal(plan.facets[0]!.checks.length, 1);
  });
});

/**
 * The judge's bill (M3.10).
 *
 * Every picture question used to be its own Claude Code session — 81 of them on the first real
 * run, 774 seconds of wall clock, the same rubric re-uploaded each time. The questions about
 * one camera share a frame and a rubric, so they ride in one call. Nothing about the judge's
 * blindness changes: it is still a one-shot session that is never told which build it is looking
 * at, and each answer still lands on the board as a yes/no with a confidence.
 */
describe("what a board of picture questions costs", () => {
  type JudgeCall = { systemPrompt: string; content: string; images: number };

  function fakeJudge(reply: (call: JudgeCall) => string) {
    const calls: JudgeCall[] = [];
    const notes: string[] = [];
    const ctx = {
      // No workspace on disk, so every prompt falls back to its built-in rubric.
      workspace: pathMod.join(tmpdir(), "no-such-judge-workspace"),
      cancelled: false,
      threadId: "t",
      notify: (type: string, payload: { checkId?: string }) => {
        if (type === "judge.vision") notes.push(String(payload.checkId));
      },
      call: async (name: string, args: Record<string, unknown>) => {
        assert.equal(name, "engine.complete");
        const messages = args.messages as Array<{ content: string; images?: unknown[] }>;
        const call = {
          systemPrompt: String(args.systemPrompt ?? ""),
          content: messages[0]!.content,
          images: messages[0]!.images?.length ?? 0,
        };
        calls.push(call);
        return { message: { content: reply(call) } };
      },
    };
    return { ctx, calls, notes };
  }

  const ask = (id: string, camera: string) => ({
    check: { id, kind: "vision", camera, ask: `is ${id} visible?`, expect: "yes" },
    crop: { base64: `${camera}-frame`, path: `/shots/${camera}.jpg` },
    camera,
  });

  it("asks six questions over two cameras in two calls, and gives every one its own answer", async () => {
    const asks = [
      ask("sky", "default"),
      ask("road", "default"),
      ask("hud", "default"),
      ask("mirror", "chase"),
      ask("wake", "chase"),
      ask("crowd", "chase"),
    ];
    const { ctx, calls, notes } = fakeJudge((call) => {
      // Answer only the ids this call actually asked about, so a batch that leaked a question
      // into the wrong camera's call would come back unanswered.
      const ids = [...call.content.matchAll(/^- ([a-z]+) —/gm)].map((m) => m[1]!);
      const answers = Object.fromEntries(
        ids.map((id) => [id, { answer: id === "hud" ? "no" : "yes", confidence: 0.9, note: `${id} note` }]),
      );
      return JSON.stringify({ answers });
    });

    const results = await askVisionBoard(ctx as never, { run: { engine: "codex" }, asks } as never);

    assert.equal(calls.length, 2, `one call per camera, not one per question: ${calls.length}`);
    assert.deepEqual(
      results.map((r: { id: string }) => r.id),
      ["sky", "road", "hud", "mirror", "wake", "crowd"],
    );
    assert.deepEqual(results.map(((r: { pass: boolean }) => r.pass) as never), [true, true, false, true, true, true]);
    assert.equal(results[2]!.note, "hud note");
    assert.deepEqual(notes, ["sky", "road", "hud", "mirror", "wake", "crowd"], "every answer is still notified");
    // Crop-less questions about one camera share the one frame — three questions, one picture.
    assert.deepEqual(
      calls.map((c) => c.images),
      [1, 1],
    );
    // The frozen rubric is the system prompt, so the part that never changes is the prefix every
    // one-shot session sends: that is what a server-side cache can hit across sessions.
    assert.equal(calls[0]!.systemPrompt, calls[1]!.systemPrompt);
    assert.match(calls[0]!.systemPrompt, /SEVERAL yes\/no questions/);
    assert.doesNotMatch(calls[0]!.systemPrompt, /sky|road|hud/);
  });

  it("keeps the single-question call as it was, reference picture and all", async () => {
    const one = { ...ask("sky", "default"), incumbentCrop: { base64: "before", path: "/shots/before.jpg" } };
    const { ctx, calls } = fakeJudge(() => JSON.stringify({ answer: "yes", confidence: 0.8, note: "clear" }));
    const results = await askVisionBoard(ctx as never, { run: { engine: "codex" }, asks: [one] } as never);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.images, 2, "the accepted build still rides along on a lone question");
    assert.equal(results[0]!.pass, true);
  });

  it("counts an id the judge skipped as unanswered, not as a pass", async () => {
    const asks = [ask("sky", "default"), ask("road", "default")];
    const { ctx, calls } = fakeJudge(() => JSON.stringify({ answers: { sky: { answer: "yes", confidence: 0.9 } } }));
    const results = await askVisionBoard(ctx as never, { run: { engine: "codex" }, asks } as never);
    assert.equal(calls.length, 1);
    assert.equal(results[0]!.pass, true);
    assert.equal(results[1]?.pass, null);
    assert.equal(results[1]?.state, "unmeasured");
    assert.match(results[1]?.reason ?? "", /no usable/);
  });

  it("is what both scoring loops call, so no loop asks one question per session again", () => {
    for (const file of ["src/harness-seed/loop/director/tools.ts", "src/harness-seed/loop/facet/scoring.ts"]) {
      const source = readFileSync(pathMod.join(repoRoot, file), "utf8");
      assert.match(source, /askVisionBoard/, `${file} scores its board in one call per camera`);
    }
  });
});
