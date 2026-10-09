/**
 * The loop's self-test — the architect's bar (HARNESS-REWORK.md §4.6, §5 step 7).
 *
 * A structural change to the harness used to be validated by "it boots". A loop that boots but
 * scores wrong would have passed. This runs the pure logic of the v2 loop against fixed inputs:
 * spec normalisation and validation, the expression language, scoreboard comparison, recipe
 * retrieval and the outcome gate, the code reviewer's mechanical scan, and brief rendering.
 * No engine, no preview, no network — seconds, deterministic, and a real behavioural bar.
 */
import {
  normalizeFacetSpec,
  validateFacetSpec,
  renderChecks,
  withHarnessChecks,
  HARNESS_CHECKS,
  recordCatalogueOutcomes,
  renderCatalogueForPlanner,
  catalogueEntryEarned,
} from "./spec.ts";
import {
  evaluateBoolean,
  pixelScope,
  probeScope,
  compareScoreboards,
  toScoreboard,
  summarizeScoreboard,
  isInvisibleDiff,
  evaluatePixelCheck,
  evaluateProbeCheck,
  evaluateDemoCheck,
  isMeasured,
} from "./checks.ts";
import { normalizeRecipe, recipesForChecks, applyRecipeOutcome, renderBrief, scoreRecipe } from "./library.ts";
import { defectsToChecks, facetIsDone } from "./facet-loop.ts";
import { mechanicalReview } from "./review.ts";
import { cameraSubset, combineFacetVerdict, normalizeDefects } from "./judge.ts";
import { spikeCandidates } from "./spike.ts";
import { playResults } from "./playtester.ts";
import type { Catalogue, Check, FacetSpec } from "./spec.ts";
import type { CheckResult } from "./checks.ts";

function check(name: string, condition: unknown): void {
  if (!condition) throw new Error(`selftest failed: ${name}`);
}

/** One self-test step: its name, and the checks it runs over fixed inputs (it throws on the first failure). */
type SelftestStep = readonly [name: string, run: () => void];

/** The self-test, step by step, in the order it runs. */
const SELFTEST_STEPS: readonly SelftestStep[] = [
  [
    "spec: normalises and validates a planner facet",
    () => {
      const spec = normalizeFacetSpec({
        id: "Terrain Water!",
        intent: "opaque terrain with a mirror",
        cameras: ["camBridge"],
        checks: [
          {
            id: "terrain-opaque",
            kind: "scene",
            weight: "identity",
            js: "meshes('terrain').every(m => !m.material.transparent)",
          },
          {
            id: "grade",
            kind: "pixel",
            camera: "default",
            expr: "meanLuma in [0.3,0.5] && fractionAbove(0.9) <= 0.02",
          },
          { id: "moved", kind: "probe", expr: "delta('player.x') != 0 || delta('player.z') != 0" },
          { id: "walk", kind: "demo", name: "district-walk" },
          {
            id: "legible",
            kind: "vision",
            camera: "camBridge",
            crop: [0.2, 0.5, 0.8, 1],
            ask: "Is the bridge reflected?",
          },
          { id: "bad", kind: "pixel", camera: "default", expr: "meanLuma in [" },
          { id: "worse", kind: "teleport" },
        ],
      });
      check("id slug", spec.id === "terrain-water");
      check(
        "cameras include default and camBridge",
        spec.cameras[0] === "default" && spec.cameras.includes("camBridge"),
      );
      const validated = validateFacetSpec(spec);
      check("two problems", validated.problems.length === 2);
      check("five checks kept", validated.spec.checks.length === 5);
      check("renders", renderChecks(validated.spec.checks).includes("terrain-opaque [identity]"));
    },
  ],

  [
    "spec: a floor on how much the build draws is refused, a budget is kept",
    () => {
      const spec = normalizeFacetSpec({
        id: "hud",
        intent: "a HUD read at a glance",
        checks: [
          { id: "hud-rich", kind: "probe", expr: "len(hud.items) >= 60" },
          { id: "draw-budget", kind: "probe", expr: "__render.drawCalls <= 1000" },
          { id: "hud-there", kind: "probe", expr: "len(state.hud.items) >= 1" },
        ],
      });
      const validated = validateFacetSpec(spec);
      check("one problem", validated.problems.length === 1 && validated.problems[0]?.includes("hud-rich") === true);
      check(
        "the budget and the existence check stay",
        validated.spec.checks.map((c) => c.id).join(",") === "draw-budget,hud-there",
      );
    },
  ],

  [
    "spec: `done` is the contract, the prose identity list still weighs, and checks are dry-run",
    () => {
      const spec = normalizeFacetSpec({
        id: "contact",
        intent: "props that do not stop cars",
        identity: ["props are knocked over by the car"],
        done: [
          {
            what: "a car that hits a bin keeps most of its speed",
            check: { id: "speed-kept", kind: "probe", expr: "state.contact.speedKept >= 0.7" },
          },
          {
            what: "the bin ends up somewhere else",
            check: { id: "props-moved", kind: "probe", expr: "delta('props.moved') > 0" },
          },
        ],
        checks: [
          { id: "props-dont-stop-cars", kind: "probe", expr: "player.speed > 1" },
          { id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.4" },
        ],
      });
      check(
        "done checks are identity",
        spec.checks
          .filter((c) => c.weight === "identity")
          .map((c) => c.id)
          .join(",") === "speed-kept,props-moved,props-dont-stop-cars",
      );
      check(
        "the prose feature marked its check",
        spec.checks.find((c) => c.id === "props-dont-stop-cars")!.weight === "identity",
      );
      check("one word in common is not a match", spec.checks.find((c) => c.id === "lit")!.weight === "normal");
      check(
        "what done means rides with the spec",
        spec.done![0].what === "a car that hits a bin keeps most of its speed" &&
          spec.checks[0].note === spec.done![0].what,
      );
      // The dry run against the state the fork point reports: one path it has, one it has not.
      const validated = validateFacetSpec(spec, { state: { player: { speed: 3 }, props: { moved: 0 } } });
      check(
        "the missing path is named",
        validated.unsatisfiable.length === 1 &&
          validated.unsatisfiable[0].id === "speed-kept" &&
          validated.unsatisfiable[0].missing[0] === "state.contact.speedKept",
      );
      check("with the keys that do exist", validated.stateKeys!.join(",") === "player,props");
      check(
        "and the builder is told in its note",
        /does not report state\.contact\.speedKept yet — expose it/.test(validated.spec.checks[0].note),
      );
      check(
        "a path the build reports is satisfiable",
        !validated.unsatisfiable.some((u) => u.id === "props-dont-stop-cars"),
      );
      check(
        "no state, no verdict",
        validateFacetSpec(spec).unsatisfiable.length === 0 && validateFacetSpec(spec).stateKeys === null,
      );
    },
  ],

  [
    "a facet is done on the checks it was given, not on the judge's later ones",
    () => {
      const board = toScoreboard([
        { id: "speed-kept", kind: "probe", weight: "identity", pass: true },
        { id: "defect-milky-water", kind: "vision", weight: "normal", pass: false, reason: "still milky" },
      ] as CheckResult[]);
      const summary = summarizeScoreboard(board, { checks: [1, 2] } as never);
      check(
        "done",
        facetIsDone({ won: true, verdict: { satisfied: true }, summary }) === "the work it was given is done",
      );
      check(
        "the taste judge still has a vote",
        facetIsDone({ won: true, verdict: { satisfied: false }, summary }) === null,
      );
      const failing = summarizeScoreboard(
        toScoreboard([
          { id: "speed-kept", kind: "probe", weight: "identity", pass: false, reason: "0.2" },
        ] as CheckResult[]),
        { checks: [1] } as never,
      );
      check(
        "a failing done check keeps it going",
        facetIsDone({ won: true, verdict: { satisfied: true }, summary: failing }) === null,
      );
      check(
        "a broken build is never done",
        facetIsDone({ won: true, broken: true, verdict: { satisfied: true }, summary }) === null,
      );
    },
  ],

  [
    "expressions: parse, evaluate, refuse missing values",
    () => {
      const scope = pixelScope({
        meanLuma: 102,
        litFraction: 0.7,
        histogram: [...new Array(30).fill(0), 0.5, 0.5],
        bands: { top: 200, middle: 100, bottom: 30, left: 90, center: 100, right: 110 },
        saturation: 0.3,
        contrast: 40,
      });
      check("in-range", evaluateBoolean("meanLuma in [0.35,0.45]", scope).pass);
      check("fractionAbove", evaluateBoolean("fractionAbove(0.9) > 0.9", scope).pass);
      check("bands", evaluateBoolean("top > bottom && band('left') < band('right')", scope).pass);
      check("missing fails", evaluateBoolean("nothing > 1", scope).pass === false);
      check("parse error is a reason", /parse/.test(evaluateBoolean("meanLuma in [", scope).reason));
      const probe = probeScope(
        { player: { x: 3, z: 0 }, entities: { pickups: 4 }, phase: "playing" },
        { player: { x: 0, z: 0 } },
      );
      check("delta", evaluateBoolean("delta('player.x') != 0 || delta('player.z') != 0", probe).pass);
      check("string equality", evaluateBoolean("phase == 'playing' && entities.pickups >= 4", probe).pass);
      check("not", evaluateBoolean("!(entities.pickups < 4)", probe).pass);
      check("state. prefix", evaluateBoolean("state.player.x == 3 && state.entities.pickups >= 4", probe).pass);
      check(
        "a real state field is not shadowed",
        evaluateBoolean("state.saved == 2", probeScope({ state: { saved: 2 } })).pass,
      );
    },
  ],

  [
    "checks: pixel/probe/demo evaluation over evidence",
    () => {
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
        demos: { walk: { ok: true, result: { reached: true } } },
        demoStates: { walk: { reached: true, player: { x: 9, z: 1 } } },
        registeredDemos: ["walk", "ads"],
        skippedDemos: ["ads"],
        missingCameras: ["nope"],
      };
      check(
        "pixel passes",
        evaluatePixelCheck({ id: "p", kind: "pixel", camera: "default", expr: "meanLuma in [0.3,0.4]" }, evidence).pass,
      );
      check(
        "pixel unregistered camera fails",
        evaluatePixelCheck({ id: "p", kind: "pixel", camera: "nope", expr: "meanLuma > 0" }, evidence).pass === false,
      );
      check(
        "pixel uncaptured camera is unmeasured",
        evaluatePixelCheck({ id: "p", kind: "pixel", camera: "lost", expr: "meanLuma > 0" }, evidence).pass === null,
      );
      check(
        "probe passes",
        evaluateProbeCheck({ id: "m", kind: "probe", expr: "delta('player.x') != 0" }, evidence).pass,
      );
      check(
        "a demo-scoped probe reads the state that demo left",
        evaluateProbeCheck({ id: "m", kind: "probe", demo: "walk", expr: "state.reached == true" }, evidence).pass,
      );
      check(
        "a demo-scoped probe the cap skipped is unmeasured",
        evaluateProbeCheck({ id: "m", kind: "probe", demo: "ads", expr: "state.reached == true" }, evidence).pass ===
          null,
      );
      check(
        "demo passes",
        evaluateDemoCheck({ id: "d", kind: "demo", name: "walk", expr: "result.reached == true" }, evidence).pass,
      );
      const unregistered = evaluateDemoCheck({ id: "d", kind: "demo", name: "fly" }, evidence);
      check(
        "demo not registered fails with the list",
        unregistered.pass === false && /not registered — config.demos has: walk, ads/.test(unregistered.reason),
      );
      const skipped = evaluateDemoCheck({ id: "d", kind: "demo", name: "ads" }, evidence);
      check(
        "demo skipped by the cap is unmeasured",
        skipped.pass === null &&
          skipped.state === "unmeasured" &&
          /demo cap/.test(skipped.reason) &&
          !isMeasured(skipped),
      );
    },
  ],

  [
    "unmeasured: never a flip, a regression, a pass, or a defect",
    () => {
      const before = toScoreboard([
        { id: "a", kind: "demo", weight: "identity", pass: true },
        { id: "b", kind: "demo", weight: "normal", pass: false },
      ] as CheckResult[]);
      const after = toScoreboard([
        { id: "a", kind: "demo", weight: "identity", pass: null, state: "unmeasured", reason: "cap" },
        { id: "b", kind: "demo", weight: "normal", pass: null, state: "unmeasured", reason: "cap" },
      ] as CheckResult[]);
      const cmp = compareScoreboards(before, after);
      check("no flip", cmp.flips.length === 0);
      check("no regression", cmp.regressions.length === 0);
      check("listed as unmeasured", cmp.unmeasured.join(",") === "a,b" && cmp.failing.length === 0);
      const summary = summarizeScoreboard(after, { checks: [1, 2] } as never);
      check(
        "blocks satisfied",
        summary.identityAllPass === false && summary.unmeasured === 2 && summary.failing.length === 0,
      );
    },
  ],

  [
    "harness-owned checks ride on every plan; judge defects become checks",
    () => {
      // Every trait is off until a kind (or an explicit flag) declares it, so each of these
      // says which game it is talking about; a spec with no game carries no harness check.
      const firstPerson = { kind: "first-person" };
      const spec = withHarnessChecks(
        normalizeFacetSpec({ id: "gun", intent: "a gun", checks: [{ id: "single-hud", kind: "scene", js: "true" }] }),
        { ownsMain: true, game: firstPerson },
      );
      // A racer's main owner carries the one a first-person game cannot (the throttle-only bot's race).
      const racer = withHarnessChecks(
        { id: "car", checks: [] as Check[], cameras: [] },
        { ownsMain: true, game: { kind: "racing" } },
      );
      const ridesOnce = (id: string, board: { checks: Check[] }) => board.checks.filter((c) => c.id === id).length;
      check(
        "every harness check, no duplicate",
        Object.keys(HARNESS_CHECKS).every((id) => Math.max(ridesOnce(id, spec), ridesOnce(id, racer)) === 1),
      );
      check(
        "the HUD budget is the kind's",
        spec.checks.find((c) => c.id === "hud-coverage")?.expr === "hud.coverage <= 0.12",
      );
      check(
        "harness origin wins",
        spec.checks.find((c) => c.id === "single-hud")!.js === HARNESS_CHECKS["single-hud"].js &&
          spec.checks.find((c) => c.id === "single-hud")!.origin === "harness",
      );
      check(
        "input checks and reaches-play only for the main owner",
        withHarnessChecks({ id: "x", checks: [], cameras: [] }, { ownsMain: false, game: firstPerson }).checks
          .length === 4,
      );
      check(
        "a game that declares nothing carries no harness check",
        withHarnessChecks({ id: "x", checks: [], cameras: [] }, { ownsMain: true }).checks.length === 0,
      );
      check(
        "a game without a HUD or mouse look gets no such checks",
        withHarnessChecks(
          { id: "x", checks: [] as Check[], cameras: [] },
          { ownsMain: true, game: { ...firstPerson, hud: false, mouseLook: false } },
        )
          .checks.map((c) => c.id)
          .join(",") === "keys-move-player,reaches-play",
      );
      const grown = defectsToChecks(
        { id: "gun", checks: [], cameras: ["default", "camGun"] },
        ["the gun is a white box — camGun", "no hands hold the weapon", "the gun is a white box — camGun", "d4", "d5"],
        { iteration: 1 },
      );
      check(
        "worst two, deduplicated (WP2e)",
        grown.length === 2 && grown[0].camera === "camGun" && grown[1].camera === "default",
      );
      check(
        "judge origin vision checks",
        grown.every((c) => c.kind === "vision" && c.origin === "judge" && c.expect === "yes"),
      );
    },
  ],

  [
    "scoreboard: flips, regressions, identity, invisible diff",
    () => {
      const before = toScoreboard([
        { id: "a", kind: "scene", weight: "identity", pass: true },
        { id: "b", kind: "pixel", weight: "normal", pass: false },
      ] as CheckResult[]);
      const after = toScoreboard([
        { id: "a", kind: "scene", weight: "identity", pass: false, reason: "x" },
        { id: "b", kind: "pixel", weight: "normal", pass: true },
        { id: "c", kind: "probe", weight: "normal", pass: true },
      ] as CheckResult[]);
      const cmp = compareScoreboards(before, after);
      check("flips", cmp.flips.join(",") === "b,c");
      check("regressions", cmp.regressions.join(",") === "a");
      const summary = summarizeScoreboard(after, { checks: [1, 2, 3] } as never);
      check("identity not all pass", summary.identityAllPass === false && summary.passing === 2);
      check(
        "invisible",
        isInvisibleDiff({ default: { diffFraction: 0.001, compared: 10 }, close: { diffFraction: 0, compared: 10 } }),
      );
      check("visible", !isInvisibleDiff({ default: { diffFraction: 0.2, compared: 10 } }));
    },
  ],

  [
    "library: retrieval by check tokens and the outcome gate",
    () => {
      const recipe = normalizeRecipe({
        id: "reflection.planar-mirror",
        title: "Planar mirror",
        tags: ["mirror", "reflection", "rt"],
        intent: "x",
        sketch: "y",
        check: { id: "mirror-rt" },
      })!;
      const hits = recipesForChecks([recipe], [{ id: "mirror-rt", kind: "scene", js: "" }]);
      check(
        "retrieved",
        hits.length === 1 && hits[0].checkIds[0] === "mirror-rt" && hits[0].primaryCheckId === "mirror-rt",
      );
      check("no hit", recipesForChecks([recipe], [{ id: "fog-band", kind: "pixel" }]).length === 0);
      check(
        "one shared word is not relevance",
        scoreRecipe(normalizeRecipe({ id: "spike.ragdoll", tags: ["ragdoll", "death", "ads"], intent: "x" })!, {
          id: "hud-crosshair-ads",
          kind: "demo",
          name: "ads",
        }) === 0,
      );
      const scoped = normalizeRecipe({
        id: "spike.x",
        tags: ["ragdoll", "death", "enemy"],
        intent: "x",
        scope: "project",
        project: "game-a",
        check: { id: "ragdoll-death" },
      })!;
      check(
        "project-scoped recipe stays home unless exact",
        scoreRecipe(scoped, { id: "enemy-death", kind: "demo", ask: "ragdoll" }, { project: "game-b" }) === 0 &&
          scoreRecipe(scoped, { id: "ragdoll-death", kind: "demo" }, { project: "game-b" }) > 0,
      );
      applyRecipeOutcome(recipe, { checkId: "mirror-rt", flipped: true });
      applyRecipeOutcome(recipe, { checkId: "mirror-rt", flipped: true });
      check("promoted", recipe.status === "promoted");
      for (let i = 0; i < 5; i++) applyRecipeOutcome(recipe, { checkId: "mirror-rt", flipped: false });
      check("retired", recipe.status === "retired");
    },
  ],

  [
    "review: the mechanical scan",
    () => {
      const diff = [
        "+++ b/src/city.js",
        "@@ -1,0 +1,4 @@",
        "+const r = Math.random();",
        "+const m = new THREE.Mesh();",
        "+const n = new THREE.Mesh();",
        "+const o = new THREE.Group();",
      ].join("\n");
      const violations = mechanicalReview(diff, { id: "city", owns: ["src/city.js"], checks: [] });
      check(
        "random flagged",
        violations.some((v) => /Math\.random/.test(v.what)),
      );
      check(
        "untagged flagged",
        violations.some((v) => /none tagged/.test(v.what)),
      );
      check(
        "clean diff",
        mechanicalReview("+++ b/src/city.js\n@@ -1,0 +1,1 @@\n+mesh.userData.tag = 'roof';\n", {
          id: "city",
          owns: ["src/city.js"],
          checks: [],
        }).length === 0,
      );
    },
  ],

  [
    "judge helpers: verdict combination, defects, camera subsets",
    () => {
      check(
        "feel veto",
        combineFacetVerdict({ facets: { works: "tie", visuals: "A", feel: "B", play: "A" } }, true).pick ===
          "incumbent",
      );
      check("defects dedupe", normalizeDefects({ defects: ["a", "a", " b "] }).length === 2);
      const subset = cameraSubset(
        [{ camera: "default" }, { camera: "close" }, { camera: "wide" }, { camera: "eye:spawn" }],
        1,
        3,
      );
      check("subset size", Array.isArray(subset) && subset.length === 2);
      check("vote 0 sees all", cameraSubset([{ camera: "a" }, { camera: "b" }, { camera: "c" }], 0, 3) === null);
    },
  ],

  [
    "spikes and play answers",
    () => {
      const spec = {
        checks: [
          { id: "mirror", kind: "scene", weight: "identity" },
          { id: "hard", kind: "pixel", weight: "normal", hard: true },
          { id: "soft", kind: "pixel", weight: "normal" },
        ],
      };
      const candidates = spikeCandidates(spec, { mirror: 2, soft: 5 }, new Set());
      check("hard + streak", candidates.map((c) => c.id).join(",") === "mirror,hard");
      const answers = playResults([{ id: "find-bench", kind: "play", ask: "?", expect: "yes" }] as Check[], {
        answers: { "find-bench": { answer: "no", note: "n" } },
      });
      check("play fail", answers[0].pass === false && /answered no/.test(answers[0].reason));
    },
  ],

  [
    "catalogue: a planner's check is a hypothesis the runs can vote out; judge content must earn its place; the seed's five are not hypotheses",
    () => {
      const catalogue: Pick<Catalogue, "version" | "checks"> = {
        version: 2,
        checks: {
          "seed-never": { kind: "pixel", origin: "planner", uses: 3, passes: 0 },
          "seed-good": { kind: "pixel", origin: "planner", pack: "arena", uses: 3, passes: 2 },
        },
      };
      const spec = {
        checks: [
          {
            id: "defect-box-gun",
            kind: "vision",
            camera: "default",
            ask: "gone?",
            origin: "judge",
            defect: "the gun is a box",
          },
        ] as Check[],
      };
      recordCatalogueOutcomes(catalogue, spec, { "defect-box-gun": { pass: false } }, "planner", {
        runId: "run1",
        genres: ["fps"],
      });
      check(
        "learned once is not yet shown",
        !catalogueEntryEarned(catalogue.checks["defect-box-gun"]) &&
          !renderCatalogueForPlanner(catalogue).includes("defect-box-gun"),
      );
      recordCatalogueOutcomes(catalogue, spec, { "defect-box-gun": { pass: true } }, "planner", {
        runId: "run2",
        genres: ["fps"],
        everFailed: new Set(["defect-box-gun"]),
      });
      const text = renderCatalogueForPlanner(catalogue);
      check(
        "learned twice across two runs is filed under the kind it was learned on",
        catalogueEntryEarned(catalogue.checks["defect-box-gun"]) &&
          /Learned on "fps"[\s\S]*defect-box-gun/.test(text) &&
          /learned from 2 runs/.test(text),
      );
      check(
        "a planner check that never passed in 3 uses is gone; a good one stays",
        !text.includes("seed-never") && text.includes("seed-good"),
      );
    },
  ],

  [
    "brief renders",
    () => {
      const text = renderBrief({
        run: { runId: "r", goal: "g" },
        spec: {
          id: "f",
          title: "F",
          intent: "i",
          checks: [{ id: "a", kind: "pixel", camera: "default", expr: "meanLuma > 0" }] as Check[],
          cameras: ["default"],
        } as FacetSpec,
        iteration: 2,
        board: toScoreboard([
          { id: "a", kind: "pixel", weight: "normal", pass: false, reason: "dark" },
        ] as CheckResult[]),
        comparison: null,
        attempts: [{ iteration: 1, flips: [], regressions: [], why: "nothing flipped" }],
        recipes: [],
        steering: ["more fog"],
      });
      check("brief has steering and scoreboard", text.includes("USER STEERING") && text.includes("[FAIL] a"));
    },
  ],
];

export async function runSelftest() {
  const started = Date.now();
  const passed: string[] = [];
  for (const [name, run] of SELFTEST_STEPS) {
    run();
    passed.push(name);
  }
  return { ok: true, passed, durationMs: Date.now() - started };
}
