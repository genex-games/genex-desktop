/**
 * The cost of one iteration: a bounded brief cut at
 * word boundaries, recipes that fit this game, memory admission before a round, a fast self-look
 * at a bench page, and a re-baseline that measures only what the board reads. Every case drives
 * the seed's or the host's own functions with fakes: no rig, no window, no real clock.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { clipTailWords, clipWords } from "../../src/harness-seed/loop/text.ts";
import {
  BRIEF_MAX_CHARS,
  CRAFT_ADOPT_SCORE,
  loadRecipes,
  normalizeRecipe,
  recipesForChecks,
  renderBrief,
} from "../../src/harness-seed/loop/library.ts";
import { BriefCut, RECIPES_FILE_PATH, renderRecipesFile } from "../../src/harness-seed/loop/brief-budget.ts";
import { fitBrief } from "../../src/harness-seed/loop/facet/brief-fit.ts";
import { briefWithMovedSections } from "../../src/harness-seed/loop/facet/prompt.ts";
import { writeBrief } from "../../src/harness-seed/loop/facet/phases/brief.ts";
import { runFacetLoop } from "../../src/harness-seed/loop/facet-loop.ts";
import { openRound, rebaselineIncumbent } from "../../src/harness-seed/loop/facet/phases/gate.ts";
import { nameTheFix } from "../../src/harness-seed/loop/facet/phases/plan.ts";
import { StopCode } from "../../src/harness-seed/loop/outcomes.ts";
import {
  admitRound,
  MACHINE_PRESSURE_POLL_MS,
  ROUND_MIN_FREE_MB,
} from "../../src/harness-seed/loop/facet/admission.ts";
import { MIN_FREE_MB } from "../../src/harness-seed/loop/director/budgets.ts";
import { MOTION_FRAMES } from "../../src/harness-seed/loop/facet/policy.ts";
import { RunEvent } from "../../src/harness-seed/loop/run-events.ts";
import { toScoreboard } from "../../src/harness-seed/loop/checks.ts";
import { PreviewService } from "../../src/main/core/previews.ts";
import { unservedPreviews, type CoreInternals } from "../../src/main/core/internals.ts";
import type { StudioCore } from "../../src/main/studio-core.ts";
import type { PreviewPort } from "../../src/substrate/preview-port.ts";
import { TEMPLATE_SHAPE } from "../../src/substrate/project-shape.ts";
import { captureArgs } from "../../src/substrate/engines/capture-args.ts";
import { executeLocalTool, LocalTool, localToolDefinitions } from "../../src/substrate/engines/local-session-tools.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import { tmpDir } from "../helpers/tmp.ts";

const seedDir = path.join(fileURLToPath(new URL("../..", import.meta.url)), "src", "harness-seed");

/** `n` distinct words, `prefix0001 prefix0002 …`, so a test can tell a whole word from half of one. */
function words(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(4, "0")}`).join(" ");
}

describe("text cut at a word, not inside one", () => {
  it("clipWords keeps whole words and marks the cut; clipTailWords keeps the newest words", () => {
    assert.equal(clipWords("short enough", 40), "short enough");
    assert.equal(clipWords("alpha beta gamma delta", 13), "alpha beta…");
    assert.ok(clipWords("alpha beta gamma delta", 13).length <= 13);
    assert.equal(
      clipWords("alpha beta gamma", 11),
      "alpha beta…",
      "a cut that lands on a space keeps the word before it",
    );
    assert.equal(clipTailWords("alpha beta gamma delta", 13), "…gamma delta");
    assert.ok(clipTailWords("alpha beta gamma delta", 13).length <= 13);
    assert.equal(clipTailWords("short", 40), "short");
    // One word longer than the room: nothing to cut at but the word itself.
    assert.equal(clipWords("abcdefghijklmnop", 6), "abcde…");
    assert.equal(clipTailWords("abcdefghijklmnop", 6), "…lmnop");
    assert.equal(clipWords(null, 10), "");
    assert.equal(clipTailWords(undefined, 10), "");
  });
});

/** Every word of the line at `at` is a whole fixture word (`<prefix><four digits>`), cut marks aside. */
function assertWholeWords(brief: string, prefix: string, at: number): void {
  assert.ok(at >= 0, `the ${prefix} field is in the brief`);
  const line = brief.slice(at, brief.indexOf("\n", at));
  for (const token of line
    .replace(/^notes: /, "")
    .split(/\s+/)
    .filter(Boolean)) {
    const bare = token.replace(/^…/, "").replace(/…$/, "");
    if (bare === "NEWEST-LINE") continue;
    assert.match(bare, new RegExp(`^${prefix}\\d{4}$`), `a whole word at the cut: "${token}"`);
  }
  assert.ok(line.includes("…"), `the ${prefix} field was cut`);
}

/** A board, a contract and a history as large as a long run makes them. */
function adversarialBrief() {
  const checks = Array.from({ length: 40 }, (_, i) => ({
    id: `chk-${String(i + 1).padStart(2, "0")}`,
    kind: "scene",
    js: `count('dial-${i}') >= 1`,
    weight: i < 4 ? "identity" : "normal",
  }));
  const sketch = (tag: string) => `// ${tag}\n${"const ring = new THREE.RingGeometry(0.8, 1, 64);\n".repeat(120)}`;
  const recipe = (id: string, check: string) =>
    normalizeRecipe({
      id,
      title: `Recipe ${id}`,
      tags: ["dial", "gauge"],
      checkClass: check,
      intent: words("i", 200),
      sketch: sketch(`SKETCH-${id}`),
      port: `PORT-${id} wire it into the HUD module`,
    })!;
  const fixRecipe = recipe("hud.round-dials", "chk-01");
  const hits = [
    { recipe: fixRecipe, score: Infinity, checkIds: ["chk-01"], primaryCheckId: "chk-01" },
    { recipe: recipe("hud.needle-sweep", "chk-02"), score: 5, checkIds: ["chk-02"], primaryCheckId: "chk-02" },
    { recipe: recipe("hud.redline-band", "chk-03"), score: 4, checkIds: ["chk-03"], primaryCheckId: "chk-03" },
  ];
  const input = {
    run: { runId: "run_apex", goal: "GOAL-LINE a rally stage at dusk with a cockpit HUD", game: { kind: "racing" } },
    spec: {
      id: "hud",
      title: "HUD",
      intent: "the cockpit instruments",
      identity: ["round dials"],
      owns: ["src/hud.js"],
      checks,
      done: [{ id: "chk-01", what: "DONE-LINE the dials read at a glance" }],
    },
    iteration: 6,
    board: toScoreboard(
      checks.map((c) => ({ id: c.id, kind: c.kind, weight: c.weight, pass: false, reason: "the dial is not there" })),
    ),
    comparison: null,
    steering: ["STEER-LINE keep the speedometer on the left"],
    move: { what: "MOVE-LINE a rev counter with a sweeping needle", mandatory: true },
    fix: { what: "FIX-LINE the speedometer is a flat grey disc", streak: 3, mandatory: true, recipe: fixRecipe },
    review: {
      violations: Array.from({ length: 30 }, (_, i) => ({
        file: "src/hud.js",
        line: i + 1,
        what: `VIOLATION-${i + 1} reads the wall clock`,
      })),
    },
    recipes: hits,
    attempts: [4, 5, 6].map((iteration) => ({
      iteration,
      won: false,
      branch: `refs/attempts/hud/${iteration}`,
      flips: [],
      regressions: [],
      why: "nothing flipped",
      diffStat: Array.from({ length: 12 }, (_, i) => ` src/hud-${i}.js | 40 ++++`).join("\n"),
      notes: `${words("n", 1_400)} NEWEST-LINE`,
    })),
    defects: Array.from({ length: 6 }, (_, i) => `DEFECT-${i + 1} the needle clips through the bezel`),
    polish: ["POLISH-LINE soften the bezel highlight"],
    lessons: Array.from({ length: 6 }, (_, i) => `LESSON-${i + 1} ${words("s", 60)}`),
    gameLessons: Array.from({ length: 5 }, (_, i) => `GAME-LESSON-${i + 1} ${words("h", 60)}`),
    recipesFile: RECIPES_FILE_PATH,
  };
  return { input, hits, fixRecipe, moved: { spec: input.spec, ownsMain: false, ownShape: false } };
}

describe("a brief with a budget", () => {
  it("an adversarial brief stays bounded and keeps what governs the round", () => {
    const { input, moved, hits } = adversarialBrief();
    const { brief } = fitBrief(input as never, moved as never);
    assert.ok(brief.length <= BRIEF_MAX_CHARS, `the brief is ${brief.length} characters`);
    for (const kept of ["GOAL-LINE", "STEER-LINE", "MOVE-LINE", "FIX-LINE", "DONE-LINE", "NEWEST-LINE"])
      assert.ok(brief.includes(kept), `${kept} is in the brief`);
    assert.match(brief, /- YOUR FILES: put this facet's work in its own module — src\/hud\.js/);
    for (const check of input.spec.checks) assert.ok(brief.includes(check.id), `check ${check.id} is listed`);
    // Six review violations and a count of the rest, never thirty.
    assert.match(brief, /VIOLATION-6 /);
    assert.doesNotMatch(brief, /VIOLATION-7 /);
    assert.match(brief, /\(\+24 more\)/);
    // The rules come before the attempts and the recipes: an inline cut takes the tail, not the seam.
    const rules = brief.indexOf("## Rules that do not change");
    assert.ok(rules > 0 && rules < brief.indexOf("## Earlier rounds"), "the rules before the earlier rounds");
    assert.ok(rules < brief.indexOf("## Recipes that apply"), "and before the recipes");
    // The lowest sections went first, and the brief says what it left out.
    assert.doesNotMatch(brief, /LESSON-1/);
    assert.match(brief, /## Left out of this brief\nTo stay readable: the lessons from earlier runs/);
    assertWholeWords(brief, "n", brief.indexOf("notes: …"));
    // The section naming what was left out is the last one, after the lessons' place.
    assert.ok(brief.indexOf("## Left out of this brief") > brief.indexOf("## Recipes that apply"));
    // The sketches live in RECIPES.md, whole.
    const file = renderRecipesFile(hits as never);
    for (const hit of hits) assert.ok(file.includes(hit.recipe.sketch.trim()), `${hit.recipe.id}'s sketch`);
    assert.match(file, /PORT-hud\.needle-sweep/);
  });

  it("cuts the liveness card and the integration note at a word", () => {
    const brief = renderBrief({
      run: { runId: "r", goal: "g" },
      spec: { id: "hud", title: "HUD", intent: "dials", checks: [] },
      iteration: 3,
      board: {},
      liveness: words("l", 900),
      integration: words("g", 600),
      maxChars: 50_000,
    } as never);
    assertWholeWords(brief, "l", brief.indexOf("l0001"));
    assertWholeWords(brief, "g", brief.indexOf("g0001"));
    assert.ok(brief.length < 6_000, `${brief.length}`);
  });

  it("points at RECIPES.md for every sketch but the fix's own, when there is room", () => {
    const { hits, fixRecipe } = adversarialBrief();
    const brief = renderBrief({
      run: { runId: "r", goal: "g" },
      spec: { id: "hud", title: "HUD", intent: "dials", checks: [] },
      iteration: 3,
      board: {},
      fix: { what: "the speedometer is flat", streak: 3, mandatory: true, recipe: fixRecipe },
      recipes: hits.map((hit) => ({
        ...hit,
        recipe: { ...hit.recipe, sketch: hit.recipe.sketch.slice(0, 300), intent: "build it" },
      })),
      recipesFile: RECIPES_FILE_PATH,
      maxChars: 50_000,
    } as never);
    assert.match(brief, /SKETCH-hud\.round-dials/, "the fix's recipe keeps its sketch inline");
    assert.doesNotMatch(brief, /SKETCH-hud\.needle-sweep/);
    assert.match(brief, /hud\.needle-sweep[\s\S]*\.studio\/RECIPES\.md/);
    // With no recipes file written (a direct engine, an older caller) every sketch stays inline.
    const inline = renderBrief({
      run: { runId: "r", goal: "g" },
      spec: { id: "hud", title: "HUD", intent: "dials", checks: [] },
      iteration: 3,
      board: {},
      recipes: hits.map((hit) => ({ ...hit, recipe: { ...hit.recipe, sketch: "SKETCH-short" } })),
    } as never);
    assert.match(inline, /SKETCH-short/);
    assert.doesNotMatch(inline, /RECIPES\.md/);
  });

  it("drops the lowest section first: lessons go before the polish", () => {
    const brief = renderBrief({
      run: { runId: "r", goal: "g" },
      spec: { id: "hud", title: "HUD", intent: "dials", checks: [] },
      iteration: 3,
      board: {},
      polish: ["POLISH-LINE soften the bezel"],
      lessons: Array.from({ length: 6 }, (_, i) => `LESSON-${i} ${words("s", 80)}`),
      maxChars: 3_000,
    } as never);
    assert.ok(brief.length <= 3_000, `${brief.length}`);
    assert.doesNotMatch(brief, /LESSON-/);
    assert.match(brief, /POLISH-LINE/);
    assert.equal(BriefCut.Lessons, "lessons");
  });

  it("a game of its own gets no bench rule and no blank line in its rules", () => {
    const brief = (template: boolean) =>
      renderBrief({
        run: { runId: "r", goal: "g" },
        spec: { id: "hud", title: "HUD", intent: "dials", checks: [] },
        iteration: 3,
        board: {},
        template,
        screen: template,
        maxChars: 50_000,
      } as never);
    const rules = (text: string) => {
      const start = text.indexOf("## Rules that do not change");
      const end = text.indexOf("\n\n", start);
      return text.slice(start, end === -1 ? undefined : end);
    };
    const own = rules(brief(false));
    assert.match(own, /HARNESS:/, `the whole rules list is one block: ${own}`);
    assert.doesNotMatch(own, /bench\//);
    assert.match(rules(brief(true)), /bench\/hud\.html/);
  });

  it("moves an older brief's rules block before its earlier rounds", () => {
    const old = [
      "# Brief",
      "## Earlier rounds (build on what was kept; do not repeat what lost)",
      "- iteration 1, lost",
      "",
      "## Recipes that apply to what is failing",
      "### a recipe",
      "",
      "## Rules that do not change",
      "- Tag every object you create.",
      "",
      "## Lessons from past runs (each cost a run — do not re-learn them)",
      "- a lesson",
    ].join("\n");
    const moved = briefWithMovedSections(old, { spec: { id: "hud" }, ownsMain: false } as never);
    const rules = moved.indexOf("## Rules that do not change");
    assert.ok(rules < moved.indexOf("## Earlier rounds"), moved);
    assert.match(moved, /- YOUR FILES:/);
    assert.ok(moved.indexOf("- YOUR FILES:") < moved.indexOf("## Earlier rounds"));
    assert.ok(moved.indexOf("## Lessons from past runs") > moved.indexOf("## Recipes that apply"));
    assert.equal(briefWithMovedSections(moved, { spec: { id: "hud" }, ownsMain: false } as never), moved);
  });

  it("notes are kept as their newest words, cut at a word", () => {
    const brief = renderBrief({
      run: { runId: "r", goal: "g" },
      spec: { id: "hud", title: "HUD", intent: "dials", checks: [] },
      iteration: 3,
      board: {},
      attempts: [{ iteration: 2, won: false, flips: [], regressions: [], notes: `${words("n", 300)} NEWEST-LINE` }],
    } as never);
    const line = brief.split("\n").find((l) => l.includes("notes:"))!;
    assert.match(line, /NEWEST-LINE$/);
    assert.match(line, /notes: …n\d{4} /);
  });
});

describe("recipes that fit this game", () => {
  it("a racing run gets no first-person or arena recipe, and only a real overlap", async () => {
    const recipes = await loadRecipes(seedDir);
    const racing = { kind: "racing", minScore: CRAFT_ADOPT_SCORE };
    const ids = (checks: unknown[], options: Record<string, unknown>) =>
      recipesForChecks(recipes, checks as never, 5, options as never).map((hit) => hit.recipe.id);
    const hudDials = [
      { id: "hud-dials", kind: "vision", ask: "the speedometer dial reads at a glance, high contrast, no blown light" },
    ];
    const pitLights = [
      { id: "pit-lights", kind: "vision", ask: "the pit lane lamps throw pools of light without blown highlights" },
    ];
    for (const checks of [hudDials, pitLights]) {
      const got = ids(checks, racing);
      assert.ok(!got.some((id) => id.startsWith("fps.") || id.startsWith("arena.")), `racing got ${got.join(", ")}`);
    }
    // The spec's own rows: headlights and a wet road reach nothing on a two-word coincidence.
    assert.deepEqual(
      ids(
        [
          { id: "headlight-pool", kind: "vision", ask: "headlights light the road" },
          { id: "wet-road", kind: "pixel" },
        ],
        racing,
      ),
      [],
    );
    // An exact check match always passes the gate.
    assert.deepEqual(
      ids([{ id: "hands-present", kind: "scene" }], { kind: "first-person", minScore: CRAFT_ADOPT_SCORE }),
      ["fps.hands-in-frame"],
    );
    assert.ok(ids([{ id: "hands-present", kind: "scene" }], racing).includes("fps.hands-in-frame"));
    // A recipe that names no kinds fits every kind, and an unknown kind name is dropped.
    const free = normalizeRecipe({
      id: "x.any",
      intent: "i",
      tags: ["dial", "gauge", "needle"],
      kinds: ["submarine"],
    })!;
    assert.equal(free.kinds, undefined);
    assert.deepEqual(
      recipesForChecks([free], [{ id: "dial-gauge-needle", kind: "scene" }] as never, 3, racing as never).map(
        (h) => h.recipe.id,
      ),
      ["x.any"],
    );
    const fps = normalizeRecipe({ id: "x.fps", intent: "i", kinds: ["first-person", "noir"] })!;
    assert.deepEqual(fps.kinds, ["first-person"]);
  });

  it("iteration 1 injects exact matches only, and writes the sketches beside the brief", async () => {
    const recipes = await loadRecipes(seedDir);
    const dir = await tmpDir("studio-brief-");
    const { loop, round } = briefLoop({
      dir,
      recipes,
      checks: [
        { id: "hands-present", kind: "scene", js: "count('hands') >= 1", weight: "identity" },
        { id: "crosshair-hidden", kind: "vision", ask: "the crosshair hides while aiming down the sights" },
      ],
    });
    await writeBrief(loop as never, round as never);
    assert.deepEqual(
      round.injected.map((hit: { recipe: { id: string } }) => hit.recipe.id),
      ["fps.hands-in-frame"],
      "an unscored check's two-word overlap is not a reason to read a recipe yet",
    );
    const file = await readFile(path.join(dir, ".studio", "RECIPES.md"), "utf8");
    assert.match(file, /fps\.hands-in-frame/);
    assert.match(String(round.brief), /\.studio\/RECIPES\.md/);
  });
});

describe("THE FIX's recipe fits this game too", () => {
  /** The loop `nameTheFix` reads, with a gap the judge has named three times. */
  function fixLoop(recipes: unknown[], kind: string) {
    return {
      appendRun: async () => {},
      emitLoopState: () => {},
      facet: { id: "cockpit", title: "Cockpit" },
      policy: { fixAfterSameGap: 2, fixLosesAfter: 3 },
      run: { runId: "run_fix", project: "rally" },
      game: { kind },
      legacy: false,
      spec: { checks: [] },
      recipes,
      gapStreak: { text: "the crosshair should hide while the driver aims down the sights", count: 3, losses: 0 },
      currentFix: null,
    };
  }

  it("a racing loop's fix sentence about a crosshair pins no first-person recipe", async () => {
    const recipes = await loadRecipes(seedDir);
    const racing = fixLoop(recipes, "racing");
    await nameTheFix(racing as never, { iteration: 4 } as never);
    assert.equal(
      (racing.currentFix as { recipe: { id: string } | null } | null)?.recipe?.id ?? null,
      null,
      "a first-person viewmodel sketch is not THE FIX's recipe for a racing game",
    );
    const shooter = fixLoop(recipes, "first-person");
    await nameTheFix(shooter as never, { iteration: 4 } as never);
    assert.equal(
      (shooter.currentFix as { recipe: { id: string } | null } | null)?.recipe?.id,
      "fps.crosshair-off-in-ads",
    );
  });
});

describe("RECIPES.md follows the round", () => {
  it("a round with no recipes leaves no earlier round's recipes to read", async () => {
    const recipes = await loadRecipes(seedDir);
    const dir = await tmpDir("studio-brief-");
    const first = briefLoop({
      dir,
      recipes,
      checks: [{ id: "hands-present", kind: "scene", js: "count('hands') >= 1", weight: "identity" }],
    });
    await writeBrief(first.loop as never, first.round as never);
    assert.match(await readFile(path.join(dir, ".studio", "RECIPES.md"), "utf8"), /fps\.hands-in-frame/);
    const later = briefLoop({ dir, recipes, checks: [{ id: "sky-tone", kind: "pixel" }] });
    await writeBrief(later.loop as never, later.round as never);
    assert.deepEqual(later.round.injected, []);
    assert.doesNotMatch(
      await readFile(path.join(dir, ".studio", "RECIPES.md"), "utf8"),
      /fps\.hands-in-frame/,
      "the file the builder was pointed at earlier no longer carries recipes this round did not pick",
    );
  });
});

describe("a taste judge never sees one side move", () => {
  it("shows the motion strip on both builds or on neither", async () => {
    const { tasteImages } = await import("../../src/harness-seed/loop/judge.ts");
    const shots = ["default", "chase"].map((camera) => ({ camera, base64: "aGk=" }));
    const challenger = { ok: true, shots, motion: Array.from({ length: 6 }, () => ({ base64: "aGk=" })) };
    const incumbent = { incumbent: true, evidence: { ok: true, shots, motion: [] } };
    const images = tasteImages({
      run: { runId: "r", reference: { name: "none", frames: [] } } as never,
      facet: { id: "handling", intent: "the car's feel when it turns", cameras: ["default", "chase"], checks: [] },
      A: challenger as never,
      B: incumbent as never,
      cameras: ["default", "chase"],
      max: 12,
    });
    const motion = (tag: string) => images.filter((image) => image.label?.startsWith(`${tag} / MOTION`)).length;
    assert.equal(motion("BUILD A"), motion("BUILD B"), images.map((image) => image.label).join("; "));
  });
});

/** The loop and round `writeBrief` reads, for one delegated worker on a first-person game. */
function briefLoop({ dir, recipes, checks }: { dir: string; recipes: unknown[]; checks: unknown[] }) {
  const spec = { id: "arms", title: "Arms", intent: "hands on the rifle", checks, cameras: ["default"], owns: [] };
  const loop = {
    baseShots: [],
    delegated: true,
    ownShape: false,
    ownsMain: false,
    run: { runId: "run_b", project: "range", goal: "a shooting range", game: { kind: "first-person" } },
    game: { kind: "first-person" },
    shape: null,
    spec,
    facet: spec,
    workdir: dir,
    worktree: dir,
    board: {},
    recipes,
    currentFix: null,
    currentMove: null,
    result: { attempts: [] },
    critic: "place",
    lessons: [],
    integrationNote: null,
    defectList: [],
    polishList: [],
    references: [],
    incumbentEvidence: null,
    lastStyle: null,
    lastPairs: [],
    flags: [],
    lastLiveness: null,
    loseStreak: 0,
    gapHistory: [],
    legacy: false,
    lastFailure: null,
    sessionId: null,
  };
  const round = { iteration: 1, spikeText: null, userSteering: [], injected: [], brief: "" } as Record<string, any>;
  return { loop, round };
}

describe("memory admission before a round", () => {
  /** The loop `openRound` reads, with a capacity script, a fake clock and a record of the run's events. */
  function admissionLoop(t: { mock: { timers: { tick(ms: number): void } } }, capacity: () => unknown) {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const slept: number[] = [];
    let polls = 0;
    const loop = {
      appendRun: async (type: string, payload: Record<string, unknown>) => {
        events.push({ type, payload });
      },
      ctx: {
        cancelled: false,
        setStatus: () => {},
        call: async (method: string) => {
          if (method !== "preview.capacity") return null;
          polls += 1;
          return capacity();
        },
      },
      deadline: Date.now() + 60 * 60_000,
      facet: { id: "hud", title: "HUD" },
      finishRequested: async () => null,
      result: {},
      roundEstimate: () => ({}),
      run: { runId: "run_m" },
      steering: async () => [],
      iterationsThisRound: 0,
      softCap: 0,
      sleepFor: async (ms: number) => {
        slept.push(ms);
        t.mock.timers.tick(ms);
      },
    };
    return { loop, events, slept, polls: () => polls };
  }

  it("waits on a machine under pressure, says so once, and opens the round when memory comes back", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    let answer = 0;
    const freeMb = [70, 70, 70, 3_000];
    const { loop, events, slept, polls } = admissionLoop(t, () => ({ memory: { freeMb: freeMb[answer++] } }));
    const started = Date.now();
    const flow = await openRound(loop as never, { iteration: 2 } as never);
    assert.equal(flow, undefined, "the round opens");
    assert.equal(polls(), 4, "three answers under the floor, then one over it");
    assert.deepEqual(slept, [MACHINE_PRESSURE_POLL_MS, MACHINE_PRESSURE_POLL_MS, MACHINE_PRESSURE_POLL_MS]);
    assert.equal(Date.now() - started, 3 * MACHINE_PRESSURE_POLL_MS, "no real sleep: the fake clock moved three polls");
    const pressure = events.filter((e) => e.type === RunEvent.FacetMachinePressure);
    assert.equal(pressure.length, 1, "one event per wait");
    assert.equal(pressure[0]!.payload.freeMb, 70);
    const order = events.map((e) => e.type);
    assert.ok(order.indexOf(RunEvent.FacetMachinePressure) < order.indexOf(RunEvent.FacetBuildStarted));
    assert.ok(ROUND_MIN_FREE_MB < MIN_FREE_MB, "a running worker's round asks less than a new worker's window");
  });

  it("a capacity call that fails, or answers no memory, never holds a round", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    for (const capacity of [
      () => {
        throw new Error("preview.capacity is not a method");
      },
      () => null,
      () => ({ pool: { max: 4 } }),
    ]) {
      const { loop, events, slept } = admissionLoop(t, capacity);
      assert.equal(await openRound(loop as never, { iteration: 2 } as never), undefined);
      assert.deepEqual(slept, []);
      assert.ok(!events.some((e) => e.type === RunEvent.FacetMachinePressure));
    }
  });

  it("a stop or a wrap-up asked during the wait ends it at the next poll, with no build", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    // Asked before the wait: no poll is slept at all.
    const early = admissionLoop(t, () => ({ memory: { freeMb: 70 } }));
    early.loop.finishRequested = (async () => ({ by: "director", reason: "stopped by the director" })) as never;
    const earlyResult: Record<string, unknown> = {};
    early.loop.result = earlyResult;
    assert.equal(await openRound(early.loop as never, { iteration: 2 } as never), "stop");
    assert.deepEqual(early.slept, [], "a worker already told to stop does not wait for memory");
    assert.equal(earlyResult.stopCode, StopCode.FinishRequested);
    assert.ok(!early.events.some((e) => e.type === RunEvent.FacetBuildStarted));
    // Asked two polls into the wait: the next poll ends it, not memory or the 4 h deadline.
    const late = admissionLoop(t, () => ({ memory: { freeMb: 70 } }));
    late.loop.deadline = Date.now() + 4 * 60 * 60_000;
    late.loop.finishRequested = (async () =>
      late.slept.length >= 2
        ? { by: "director", reason: "stopped by the director: the build is wrapping up" }
        : false) as never;
    const lateResult: Record<string, unknown> = {};
    late.loop.result = lateResult;
    assert.equal(await openRound(late.loop as never, { iteration: 2 } as never), "stop");
    assert.equal(late.slept.length, 2, `the wait ends at the poll after the stop (${late.slept.length} slept)`);
    assert.equal(lateResult.stopCode, StopCode.FinishRequested);
    assert.ok(!late.events.some((e) => e.type === RunEvent.FacetBuildStarted));
    // The user's stop (a cancelled context) mid-wait: the round never opens.
    const cancelled = admissionLoop(t, () => ({ memory: { freeMb: 70 } }));
    cancelled.loop.sleepFor = async (ms: number) => {
      cancelled.slept.push(ms);
      t.mock.timers.tick(ms);
      cancelled.loop.ctx.cancelled = true;
    };
    const cancelledResult: Record<string, unknown> = {};
    cancelled.loop.result = cancelledResult;
    assert.equal(await openRound(cancelled.loop as never, { iteration: 2 } as never), "stop");
    assert.equal(cancelled.slept.length, 1);
    assert.equal(cancelledResult.stopCode, StopCode.UserStop);
    assert.ok(!cancelled.events.some((e) => e.type === RunEvent.FacetBuildStarted));
  });

  it("says why it is idle while it waits: the status line and the loop's phase", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    let answer = 0;
    const freeMb = [70, 3_000];
    const { loop } = admissionLoop(t, () => ({ memory: { freeMb: freeMb[answer++] } }));
    const statuses: string[] = [];
    const phases: string[] = [];
    loop.ctx.setStatus = ((line: string) => {
      statuses.push(line);
    }) as never;
    Object.assign(loop, { emitLoopState: (phase: string) => phases.push(phase) });
    await openRound(loop as never, { iteration: 2 } as never);
    assert.ok(
      statuses.some(
        (line) => /waiting for memory/.test(line) && line.includes("70 MB") && line.includes(`${ROUND_MIN_FREE_MB}`),
      ),
      statuses.join(" | "),
    );
    assert.deepEqual(phases, ["waiting for memory"], "the director's run_status reads the loop's phase");
  });

  it("stops waiting at the facet's deadline and lets the clock gate stop the round", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    const { loop, events, slept } = admissionLoop(t, () => ({ memory: { freeMb: 10 } }));
    loop.deadline = Date.now() + 2.5 * MACHINE_PRESSURE_POLL_MS;
    loop.roundEstimate = () => ({ buildMs: 60_000, afterMs: 60_000 }) as never;
    assert.equal(await openRound(loop as never, { iteration: 2 } as never), "stop");
    assert.equal(slept.length, 2, "two whole polls fit before the deadline");
    assert.equal(events.filter((e) => e.type === RunEvent.FacetMachinePressure).length, 1);
    assert.ok(!events.some((e) => e.type === RunEvent.FacetBuildStarted), "no build at the deadline");
  });

  it("reads the deadline on the loop's own clock, the one its sleeps move, not the wall clock", async (t) => {
    // No mocked Date: the loop's clock starts at zero and only its own sleeps move it.
    const { loop, slept } = admissionLoop(t, () => ({ memory: { freeMb: 10 } }));
    let at = 0;
    Object.assign(loop, {
      now: () => at,
      deadline: 2.5 * MACHINE_PRESSURE_POLL_MS,
      sleepFor: async (ms: number) => {
        slept.push(ms);
        at += ms;
      },
    });
    await admitRound(loop as never, 2);
    assert.equal(slept.length, 2, `two whole polls fit before the loop's deadline (${slept.length} slept)`);
    assert.equal(at, 2 * MACHINE_PRESSURE_POLL_MS);
  });
});

describe("a re-baseline measures what the board reads", () => {
  async function rebaseline(checks: unknown[], facetFields: Record<string, unknown> = {}) {
    const recorder = ctxRecorder({
      unknown: { value: null },
      handlers: {
        "preview.status": () => ({}),
        "preview.screenshot": () => ({ path: "/tmp/x.jpg", bytes: 10, base64: "", stats: null }),
      },
    });
    const spec = { id: "hud", title: "HUD", checks, cameras: ["default"], ...facetFields };
    const loop = {
      legacy: false,
      previewLock: async () => () => {},
      worktree: "/scratch/w/hud",
      incumbentEvidence: { ok: true, shots: [] },
      ctx: recorder.ctx,
      facet: spec,
      spec,
      run: { runId: "run_r", project: "rally" },
      seed: 1,
      handle: "w1",
      references: [],
      facetSetup: null,
      appendRun: async () => {},
      board: {},
      mergedIntegration: "abc",
    };
    await rebaselineIncumbent(loop as never, { rebaseline: true, iterationId: "003", iteration: 3 } as never);
    const motion = recorder
      .paramsOf("preview.screenshot")
      .filter((p) => String(p.label ?? "").includes("/motion/")).length;
    const audio = recorder.paramsOf("preview.call").filter((p) => p.method === "audio").length;
    return { motion, audio };
  }

  it("a scene-and-vision facet's re-look takes no motion strip, and keeps the audio both sides show", async () => {
    const quiet = await rebaseline([
      { id: "dials", kind: "scene", js: "count('dial') > 0" },
      { id: "reads", kind: "vision", ask: "the dials read" },
    ]);
    // The audio probe is one page call after the drive, and the taste judge reads both builds'
    // audio lines: a re-look without it would put the probe on the challenger's side only.
    assert.deepEqual(quiet, { motion: 0, audio: 1 });
    const moving = await rebaseline([{ id: "drift", kind: "play", ask: "the car drifts" }]);
    assert.equal(moving.motion, MOTION_FRAMES, "a facet judged on play still gets its strip");
    const demo = await rebaseline([{ id: "lap", kind: "demo", ask: "one lap" }]);
    assert.equal(demo.motion, MOTION_FRAMES, "a demo check still gets its strip");
  });

  it("keeps the strip for a facet the taste judge watches move: an intent about feel, no play check", async () => {
    const feel = await rebaseline([{ id: "dials", kind: "scene", js: "count('dial') > 0" }], {
      intent: "the car's feel when it turns",
    });
    assert.equal(feel.motion, MOTION_FRAMES, "the taste judge shows motion for this intent, so both sides need it");
  });
});

describe("a fast self-look at a bench page", () => {
  /** A preview service over a fake core and a port that records every load. */
  async function benchCapture() {
    const root = await tmpDir("studio-bench-");
    const outside = await tmpDir("studio-outside-");
    await mkdir(path.join(root, "bench"), { recursive: true });
    await writeFile(path.join(root, "index.html"), "<!doctype html>");
    await writeFile(path.join(root, "bench", "hud.html"), "<!doctype html><canvas></canvas>");
    await writeFile(path.join(root, "bench", "x.js"), "export {};");
    await writeFile(path.join(outside, "x.html"), "<!doctype html>");
    await symlink(path.join(outside, "x.html"), path.join(root, "bench", "link.html"));
    const loads: Array<{ entry: string; root: string | undefined }> = [];
    const studioCalls: string[] = [];
    const port = {
      async load(_project: string, entry: string, servedRoot: string | undefined) {
        loads.push({ entry, root: servedRoot });
        return `game://hud/${entry}`;
      },
      async evaluate() {
        return { via: "shim", ready: true, phase: "ready", gesture: { needed: false, done: false, reasons: [] } };
      },
      async studioCall(method: string) {
        studioCalls.push(method);
        return method === "cameras" ? ["default", "chase", "top", "side", "wheel", "dash"] : null;
      },
      async studioState() {
        return {};
      },
      async screenshot() {
        return Buffer.alloc(0);
      },
      consoleEntries: () => [],
      status: () => ({ project: "hud", url: loads.length ? `game://hud/${loads.at(-1)!.entry}` : "", loadError: null }),
    } as unknown as PreviewPort;
    let games: unknown[] = [];
    const core = {
      emit: () => {},
      games: { list: async () => games, dirFor: () => root },
      builds: { ensure: async () => ({ ok: true, output: root }) },
    } as unknown as StudioCore;
    const service = new PreviewService(core, unservedPreviews() as CoreInternals);
    const session = { loaded: null, handle: () => "w1", get: async () => port, release: async () => {} };
    const capture = (grant: Record<string, unknown> = {}) =>
      service.captureFor(
        { project: "hud", root, setup: { gesture: true }, ...grant } as never,
        root,
        path.join(outside, "shots"),
        session as never,
      );
    /** The game turns out to have its own build: the preview serves the bundler's output. */
    const built = () => {
      games = [
        {
          name: "hud",
          built: true,
          shape: { ...TEMPLATE_SHAPE, build: "npm run build", own: true, kind: "three-vite" },
        },
      ];
    };
    return { root, outside, loads, studioCalls, capture, built };
  }

  it("refuses a page outside the workspace, a link out of it, a script and a missing page, and loads nothing", async () => {
    const { outside, loads, capture } = await benchCapture();
    const hostile = [
      "../x.html",
      path.join(outside, "x.html"),
      "/etc/x.html",
      "bench/link.html",
      "bench/x.js",
      "bench/missing.html",
      "",
    ];
    for (const page of hostile) {
      const answer = await capture()({ page } as never);
      assert.match(answer, /bench page/i, `${JSON.stringify(page)} is refused: ${answer}`);
      assert.doesNotMatch(answer, /Captured your CURRENT build/);
    }
    assert.deepEqual(loads, [], "no load for any of them");
  });

  it("loads a bench page through the served root, with no setup, and shoots its default view", async () => {
    const { root, loads, studioCalls, capture } = await benchCapture();
    const answer = await capture()({ page: "bench/hud.html" } as never);
    assert.deepEqual(loads, [{ entry: "bench/hud.html", root }], answer);
    assert.ok(!studioCalls.includes("start"), `the setup script is not replayed: ${studioCalls.join(",")}`);
    assert.match(answer, /^Captured the bench page bench\/hud\.html/);
    assert.match(answer, /c1_default\.jpg/, "its default view, not the game's six cameras");
    assert.doesNotMatch(answer, /c1_chase\.jpg/);
  });

  it("a worker's build turn hands its capture the part's own cameras", async () => {
    const turns: Array<Record<string, any>> = [];
    const ctx = {
      workspace: path.join(import.meta.dirname, "no-such-workspace"),
      cancelled: false,
      notify: () => {},
      setStatus: () => {},
      call: async (method: string, params: Record<string, any>) => {
        if (method === "engine.delegate") {
          turns.push(params);
          ctx.cancelled = true;
          return { ok: true, summary: "built", sessionId: "ses_1" };
        }
        if (method === "run.exec") return { code: 0, stdout: "0123456789abcdef0123456789abcdef01234567", stderr: "" };
        if (method === "engine.describe") return [{ id: "codex", kind: "delegated" }];
        return null;
      },
    };
    await runFacetLoop(
      ctx as never,
      {
        runThreadId: "run-thread",
        facetThreadId: "facet-thread",
        run: { runId: "run_cams", project: "rally", engine: "codex" },
        facet: { id: "hud", title: "HUD", intent: "the dials", checks: [], cameras: ["chase"] },
        worktree: "/scratch/autopilot/run_cams/hud",
        deadline: Date.now() + 60 * 60_000,
      } as never,
    );
    assert.deepEqual(turns[0]?.selfCapture?.cameras, ["chase"]);
  });

  it("refuses a bench page for a game served from its build output, and loads nothing", async () => {
    const { loads, capture, built } = await benchCapture();
    built();
    const answer = await capture()({ page: "bench/hud.html" } as never);
    assert.match(answer, /build output/i, answer);
    assert.doesNotMatch(answer, /your build failed to load/);
    assert.deepEqual(loads, []);
  });

  it("a grant whose cameras are not a list shoots the default view instead of failing", async () => {
    const { capture } = await benchCapture();
    const answer = await capture({ cameras: "chase" })({});
    assert.match(answer, /^Captured your CURRENT build/, answer);
  });

  it("captures only the part's own cameras when the grant names them", async () => {
    const { capture } = await benchCapture();
    const answer = await capture({ cameras: ["chase"] })({});
    assert.match(answer, /c1_chase\.jpg/);
    assert.doesNotMatch(answer, /c1_top\.jpg|c1_dash\.jpg/);
    const asked = await capture({ cameras: ["chase"] })({ cameras: "top" });
    assert.match(asked, /c\d+_top\.jpg/, "a camera the builder names still wins");
  });
});

describe("every builder engine can look at a bench page", () => {
  it("passes a named page on, and leaves an empty one out: the game is captured", () => {
    const table: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ page: "bench/hud.html" }, { page: "bench/hud.html" }],
      [{ page: "" }, {}],
      [{ page: "   " }, {}],
      [{ page: null }, {}],
      [{ page: 7 }, {}],
      [
        { cameras: "chase", page: "bench/hud.html" },
        { cameras: "chase", page: "bench/hud.html" },
      ],
      [{ cameras: "" }, {}],
      [{}, {}],
    ];
    for (const [args, want] of table) assert.deepEqual(captureArgs(args), want, JSON.stringify(args));
  });

  it("a local session's capture takes a page and hands it to the studio", async () => {
    const asked: Array<Record<string, unknown>> = [];
    const request = {
      onCapture: async (args: Record<string, unknown>) => {
        asked.push(args);
        return "captured";
      },
    };
    const definitions = localToolDefinitions(request as never, false);
    const capture = definitions.find((tool) => tool.name === LocalTool.Capture);
    assert.ok(
      (capture?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties?.page,
      "the schema names page",
    );
    const context = { request } as never;
    await executeLocalTool(
      { id: "1", name: LocalTool.Capture, arguments: { page: "bench/hud.html" } } as never,
      definitions,
      context,
    );
    await executeLocalTool(
      { id: "2", name: LocalTool.Capture, arguments: { page: "" } } as never,
      definitions,
      context,
    );
    assert.deepEqual(asked, [{ page: "bench/hud.html" }, {}]);
  });
});
