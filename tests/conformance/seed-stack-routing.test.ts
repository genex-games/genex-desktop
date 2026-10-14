/**
 * A C++ · raylib night is planned and briefed as one (wave-2 leftovers): the facet loop's recipe
 * lookups are made for the run's stack, the planner's ask says the game is C++, and the plugin
 * listing a night asks for names its game, so the host leaves out skills for the other stack.
 *
 * The stack comes from typed fields (the run's stamped `stack`, the shape's `kind`), never from
 * words. Each seed caller is driven through its own exported function with a recording ctx.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { runAutopilot } from "../../src/harness-seed/loop/autopilot.ts";
import { runDirector } from "../../src/harness-seed/loop/director.ts";
import { DirectorLoop } from "../../src/harness-seed/loop/director/wake-schedule.ts";
import { createFacetLoopState, type FacetLoop } from "../../src/harness-seed/loop/facet/state.ts";
import { writeBrief } from "../../src/harness-seed/loop/facet/phases/brief.ts";
import { nameTheFix } from "../../src/harness-seed/loop/facet/phases/plan.ts";
import { HostMethod } from "../../src/harness-seed/loop/host-methods.ts";
import { normalizeRecipe, RecipeKind, RecipeStatus, saveRecipe } from "../../src/harness-seed/loop/library.ts";
import { BuildTarget, GameStack, ProjectKind, TargetRefusal } from "../../src/harness-seed/loop/native-contract.ts";
import { CPP_PLANNER_HEADER, cppPlannerLines } from "../../src/harness-seed/loop/native-briefs.ts";
import {
  nightStack,
  refusingProblems,
  stackChangeRefusal,
  stackOfShape,
  wiringFor,
} from "../../src/harness-seed/loop/native-loop.ts";
import { HOUR_MS } from "../../src/harness-seed/loop/time.ts";
import type { HarnessCtx, Run } from "../../src/harness-seed/types/harness.d.ts";
import { MULTIPLAYER_REASON } from "../../src/main/core/generation-prerequisites.ts";
import { GameValidationCode } from "../../src/shared/game-project.ts";
import { RAYLIB_SHAPE } from "../../src/substrate/project-shape.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { ctxRecorder, type CtxRecorder } from "../helpers/ctx-recorder.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { ScaffoldCaller } from "../../src/substrate/game-workspace.ts";

/** The one check both recipes were written for. */
const GLOW_CHECK = {
  id: "lamp-glow",
  kind: "pixel",
  camera: "default",
  expr: "litFraction > 0.4",
  weight: "identity",
} as const;

/** What the judge keeps saying is missing: THE FIX once it has stood three verdicts. */
const GLOW_GAP = "the lamps have no glow halo around them";

/**
 * The stacks whose recipes the loop routes today. Rust · wgpu recipes and briefs arrive with the
 * Rust harness work, which extends this list.
 */
const ROUTED_STACKS = [GameStack.ThreeJs, GameStack.RaylibCpp] as const;
type RoutedStack = (typeof ROUTED_STACKS)[number];

/** The words each stack's recipe is told apart by in a rendered brief. */
const RECIPE_TITLE = {
  [GameStack.ThreeJs]: "Bloom pass over the lamp meshes",
  [GameStack.RaylibCpp]: "Additive halo quads under BeginBlendMode",
} as const satisfies Record<RoutedStack, string>;

/** Each stack's recipe's code, as its builder ports it. */
const RECIPE_SKETCH = {
  [GameStack.ThreeJs]: "composer.addPass(new UnrealBloomPass(size, 1.2, 0.4, 0.85));",
  [GameStack.RaylibCpp]:
    "BeginBlendMode(BLEND_ADDITIVE);\nDrawCircleV(lamp, 24.0f, Fade(GOLD, 0.35f));\nEndBlendMode();",
} as const satisfies Record<RoutedStack, string>;

/** A promoted craft recipe for the glow check, written for `runtime`. */
function glowRecipe(runtime: RoutedStack) {
  const recipe = normalizeRecipe({
    id: `glow.${runtime}`,
    runtime,
    kind: RecipeKind.Craft,
    title: RECIPE_TITLE[runtime],
    tags: ["lamps", "glow", "halo"],
    checkClass: GLOW_CHECK.id,
    intent: `How a ${runtime} game makes its lamps glow.`,
    sketch: RECIPE_SKETCH[runtime],
    check: { ...GLOW_CHECK },
    // A learned recipe: a seeded one's file is the seed's, and only its statistics are saved.
    origin: "craft",
    status: RecipeStatus.Promoted,
    stats: { applied: 4, wins: 4, losses: 0 },
  });
  assert.ok(recipe, "the recipe normalizes");
  return recipe;
}

/** A workspace whose library holds one glow recipe of each stack, for the same check. */
async function libraryWithBothStacks(): Promise<string> {
  const workspace = await tmpDir("seed-stack-");
  for (const runtime of ROUTED_STACKS) await saveRecipe(workspace, glowRecipe(runtime));
  return workspace;
}

/** A night's run on `stack`, as autopilot, the director and the gauntlet stamp it. */
function stampedRun(stack: GameStack): Run {
  return {
    runId: "run_stack",
    goal: "a lamplit street at dusk",
    project: "street",
    engine: "ollama",
    reference: { name: "street", shots: [], kind: "direction" },
    budgets: { wallClockMs: HOUR_MS },
    stack,
  } as Run;
}

/** The shape a facet of `stack` works on: the C++ template's, or the three.js template's. */
function shapeOf(stack: GameStack): Record<string, unknown> {
  if (stack === GameStack.RaylibCpp) return { ...RAYLIB_SHAPE };
  return { entry: "index.html", main: "src/main.js", build: null, kind: ProjectKind.StudioTemplate };
}

/** A real facet loop on `stack`, whose glow check has failed, over a library of both stacks' recipes. */
async function facetOn(stack: GameStack): Promise<{ loop: FacetLoop; recorder: CtxRecorder }> {
  const workspace = await libraryWithBothStacks();
  const recorder = ctxRecorder({
    workspace,
    unknown: { value: null },
    handlers: { [HostMethod.EngineDescribe]: () => [] },
  });
  const loop = await createFacetLoopState(recorder.ctx as unknown as HarnessCtx, {
    runThreadId: "thread-run",
    facetThreadId: "thread-facet",
    run: stampedRun(stack),
    deadline: Date.now() + HOUR_MS,
    facet: {
      id: "street",
      title: "The street",
      intent: "a street of lamps",
      owns: ["src/street.cpp"],
      checks: [{ ...GLOW_CHECK }],
      cameras: ["default"],
    },
    shape: shapeOf(stack),
  });
  loop.board[GLOW_CHECK.id] = {
    id: GLOW_CHECK.id,
    kind: GLOW_CHECK.kind,
    weight: GLOW_CHECK.weight,
    pass: false,
    reason: "too dark",
  };
  return { loop, recorder };
}

/** The other stack's. */
function otherThan(stack: RoutedStack): RoutedStack {
  return stack === GameStack.RaylibCpp ? GameStack.ThreeJs : GameStack.RaylibCpp;
}

describe("the facet loop retrieves recipes for its game's stack", () => {
  for (const stack of ROUTED_STACKS) {
    it(`a ${stack} facet's brief injects only the ${stack} recipe`, async () => {
      const { loop } = await facetOn(stack);
      const round = { iteration: 2 } as Record<string, unknown> & { iteration: number };
      await writeBrief(loop, round);
      const injected = (round.injected as Array<{ recipe: { id: string; runtime?: string } }>).map(
        (hit) => hit.recipe.runtime,
      );
      assert.deepEqual(injected, [stack], "the brief's recipes");
      assert.ok(String(round.briefText).includes(RECIPE_TITLE[stack]), "the brief names its own stack's recipe");
      assert.ok(!String(round.briefText).includes(RECIPE_TITLE[otherThan(stack)]), "and never the other stack's");
    });

    it(`a ${stack} facet's FIX carries the ${stack} craft recipe`, async () => {
      const { loop } = await facetOn(stack);
      loop.gapStreak = { text: GLOW_GAP, count: loop.policy.fixAfterSameGap, losses: 0 };
      await nameTheFix(loop, { iteration: 3 });
      assert.equal(loop.currentFix?.recipe?.runtime, stack, "THE FIX's recipe");
    });
  }
});

/** The words a three.js brief speaks that a C++ · raylib builder has no use for. */
const THREE_ONLY = [
  /installStudio/,
  /window\.__studio/,
  /__studio\.hud/,
  /userData/,
  /src\/main\.js/,
  /src\/studio\.js/,
  /studio\.js owns/,
  /Math\.random/,
  /THREE\./,
  /import map/,
  /foliage\.js|materials\.js/,
  /```js/,
];

/** The BRIEF.md a facet on `stack` writes on a round whose FIX the judge has repeated. */
async function briefWithFix(stack: GameStack): Promise<string> {
  const { loop } = await facetOn(stack);
  loop.gapStreak = { text: GLOW_GAP, count: loop.policy.fixAfterSameGap, losses: 0 };
  await nameTheFix(loop, { iteration: 3 });
  const round = { iteration: 3 } as Record<string, unknown> & { iteration: number };
  await writeBrief(loop, round);
  return String(round.brief);
}

/**
 * The three.js BRIEF.md `briefWithFix(GameStack.ThreeJs)` writes, as origin/dev cf4b2c56's seed
 * (before the compiled stacks were ported to it) writes it over a library holding only the
 * three.js recipe. A change here must be deliberate.
 */
const THREE_JS_BRIEF = "2442dfe0523c30e1";

describe("a C++ · raylib facet's BRIEF.md speaks C++", () => {
  it("its rules, seam, entry, demo, FIX and recipe are C++ ones, with no three.js word", async () => {
    const brief = await briefWithFix(GameStack.RaylibCpp);
    for (const word of THREE_ONLY) assert.doesNotMatch(brief, word, String(word));
    assert.match(brief, /studio::install/, "the contract it keeps answering");
    assert.match(brief, /studio::tag\("<tag>"\)/, "how its draws are tagged");
    assert.match(brief, /src\/main\.cpp/, "the entry it owns");
    assert.match(brief, /```cpp\nBeginBlendMode/, "its recipe's code, as C++");
  });

  it("a three.js facet's BRIEF.md is the one it always was", async () => {
    assert.equal(digest(await briefWithFix(GameStack.ThreeJs)), THREE_JS_BRIEF);
  });
});

/** The sentinel the recording ctx throws once the plan is made, so the night goes no further. */
const STOP_AFTER_SCAFFOLD = "stopped after the scaffold";

/** A one-facet plan a planner might answer. */
function onePlan() {
  return {
    facets: [
      {
        id: "street",
        title: "Street",
        intent: "a street of lamps",
        owns: ["src/street.cpp"],
        checks: [{ ...GLOW_CHECK }],
      },
    ],
    integrationNotes: "",
  };
}

/** A night from an intake that chose `targets`, driven until it scaffolds the game's folder. */
async function autopilotNight(targets: readonly string[], games: readonly unknown[] = []): Promise<CtxRecorder> {
  const recorder = ctxRecorder({
    unknown: { value: null },
    handlers: {
      [HostMethod.GameList]: () => games,
      [HostMethod.EventsList]: () => [],
      [HostMethod.EventsMessages]: () => [],
      [HostMethod.EngineDescribe]: () => [],
      [HostMethod.PluginsTools]: () => ({ tools: [], guidance: "PLUGIN GUIDANCE", revision: 1 }),
      [HostMethod.EngineComplete]: () => ({ message: { role: "assistant", content: JSON.stringify(onePlan()) } }),
      [HostMethod.GameScaffold]: () => {
        throw new Error(STOP_AFTER_SCAFFOLD);
      },
    },
  });
  const run = {
    runId: "run_plan",
    goal: "a lamplit street at dusk",
    project: "street",
    reference: { name: "street", shots: [], kind: "direction" },
    budgets: { wallClockMs: HOUR_MS },
    targets: [...targets],
  } as Run;
  await runAutopilot(recorder.ctx as unknown as HarnessCtx, { threadId: "t1", run }).catch((error: unknown) => {
    if ((error as Error)?.message !== STOP_AFTER_SCAFFOLD) throw error;
  });
  return recorder;
}

/**
 * An autopilot night on the existing C++ · raylib game "street": since raylib creation ended
 * (M6.6), a desktop intake alone asks for a Rust game, so a raylib night is one on a raylib folder.
 */
function raylibNight(): Promise<CtxRecorder> {
  const street = { name: "street", dir: "/games/street", title: "Street", shape: { ...RAYLIB_SHAPE } };
  return autopilotNight([BuildTarget.Mac, BuildTarget.Web], [street]);
}

/** The planner's first ask in a recorded night. */
function plannerAsk(recorder: CtxRecorder): string {
  const [first] = recorder.paramsOf(HostMethod.EngineComplete);
  const messages = (first?.messages ?? []) as Array<{ role: string; content: string }>;
  assert.ok(messages[0], "the planner was asked");
  return messages[0].content;
}

/** The first 16 hex digits of the text's sha256. */
function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * The three.js planner ask of `autopilotNight([BuildTarget.Web])` as origin/dev cf4b2c56's seed
 * asks it, before the compiled stacks were ported to it: an empty workspace, so no catalogue,
 * skill or recipe varies it. A change here must be deliberate.
 */
const THREE_JS_PLANNER_ASK = "97e7deda89585e3c";

describe("the planner is told the game is C++", () => {
  it("a raylib night's planner ask carries the C++ rules as their own section", async () => {
    const ask = plannerAsk(await raylibNight());
    const section = cppPlannerLines().join("\n");
    assert.ok(ask.includes(`\n${section}\n`), "the C++ section, whole, on lines of its own");
    assert.equal(ask.split(CPP_PLANNER_HEADER).length, 2, "once");
  });

  it("a three.js night's planner ask is the one it always was", async () => {
    const three = plannerAsk(await autopilotNight([BuildTarget.Web]));
    assert.ok(!three.includes(CPP_PLANNER_HEADER), "no C++ section");
    assert.equal(digest(three), THREE_JS_PLANNER_ASK, "byte for byte");
    const cpp = plannerAsk(await raylibNight());
    assert.equal(cpp.replace(`${cppPlannerLines().join("\n")}\n`, ""), three, "the C++ section is the only difference");
  });
});

/** The sentinel the recording ctx throws when the director's session opens, so the night goes no further. */
const STOP_AT_SESSION = "stopped at the director's session";

/** The brief a director night on a game of `stack` opens its session with, in `loop`. */
async function directorOpening(stack: GameStack, loop: DirectorLoop): Promise<string> {
  const workspace = await tmpDir("seed-director-");
  const game = { name: "street", dir: `${workspace}/games/street`, title: "Street", shape: shapeOf(stack) };
  const recorder = ctxRecorder({
    workspace,
    unknown: { value: null },
    handlers: {
      [HostMethod.GameList]: () => [game],
      [HostMethod.EngineDescribe]: () => [],
      [HostMethod.EngineDelegate]: () => {
        throw new Error(STOP_AT_SESSION);
      },
    },
  });
  const run = {
    runId: "run_director",
    goal: "a lamplit street at dusk",
    project: "street",
    engine: "claude-code",
    budgets: { wallClockMs: HOUR_MS },
    directorLoop: loop,
  } as Run;
  await runDirector(recorder.ctx as unknown as HarnessCtx, { threadId: "t1", run }).catch(() => {});
  const [session] = recorder.paramsOf(HostMethod.EngineDelegate);
  assert.ok(session, "the director's session opened");
  return String(session.prompt);
}

describe("the director is told the game is C++", () => {
  for (const loop of Object.values(DirectorLoop)) {
    it(`a raylib night's director (${loop}) opens with the C++ planning rules; a three.js night's never`, async () => {
      const cpp = await directorOpening(GameStack.RaylibCpp, loop);
      assert.ok(cpp.includes(`\n${cppPlannerLines().join("\n")}\n`), "the C++ section, whole, on lines of its own");
      assert.equal(cpp.split(CPP_PLANNER_HEADER).length, 2, "once");
      const three = await directorOpening(GameStack.ThreeJs, loop);
      assert.ok(!three.includes(CPP_PLANNER_HEADER), "no C++ section for a three.js game");
    });
  }
});

describe("a night's plugin listing names its game", () => {
  for (const targets of [[BuildTarget.Mac, BuildTarget.Web], [BuildTarget.Web]]) {
    it(`autopilot asks plugins.tools for its run's game (${targets.join(", ")})`, async () => {
      const recorder = await autopilotNight(targets);
      assert.deepEqual(recorder.paramsOf(HostMethod.PluginsTools), [{ project: "street" }]);
    });
  }
});

describe("Genex online play asks a C++ game for nothing it cannot have", () => {
  it("the multiplayer preflight answers a C++ · raylib game by its stack, never with a package.json to make", async () => {
    const { core, api, close } = await coreLite({});
    try {
      await core.games.scaffold("pong", {
        title: "pong",
        stack: GameStack.RaylibCpp,
        caller: ScaffoldCaller.Internal,
        targets: [BuildTarget.Web],
      });
      await core.games.scaffold("web", { title: "web" });
      const cpp = await api()["plugins.preflightMultiplayer"]({ project: "pong" });
      assert.deepEqual(cpp, { ready: false, reason: MULTIPLAYER_REASON.CppGame, hostedVerified: false });
      const three = await api()["plugins.preflightMultiplayer"]({ project: "web" });
      assert.deepEqual(three, { ready: false, reason: MULTIPLAYER_REASON.NoManifest, hostedVerified: false });
    } finally {
      await close();
    }
  });
});

describe("the seed reads a game's stack from its kind's record, Rust included", () => {
  it("each kind is its own stack, and a kind this seed does not know is a browser game", () => {
    assert.equal(stackOfShape({ kind: ProjectKind.RustWgpu }), GameStack.RustWgpu);
    assert.equal(stackOfShape({ kind: ProjectKind.RaylibCpp }), GameStack.RaylibCpp);
    assert.equal(stackOfShape({ kind: ProjectKind.ThreeVite }), GameStack.ThreeJs);
    assert.equal(stackOfShape({ kind: "unity-2031" }), GameStack.ThreeJs);
    assert.equal(stackOfShape({ kind: "toString" }), GameStack.ThreeJs, "no inherited name is a kind");
    assert.equal(stackOfShape(null), GameStack.ThreeJs);
    assert.equal(nightStack({ name: "ferris", shape: { kind: ProjectKind.RustWgpu } }), GameStack.RustWgpu);
  });

  it("a Rust entry always has the wiring block, and a Rust game choosing the desktop keeps its stack", () => {
    const rust = { kind: ProjectKind.RustWgpu, main: "src/main.rs" };
    assert.deepEqual(wiringFor(rust, true), { main: "src/main.rs", wiring: true });
    assert.equal(stackChangeRefusal({ name: "ferris", shape: rust }, [BuildTarget.Mac]), null);
    const browser = { name: "orbit", shape: { kind: ProjectKind.StudioTemplate } };
    assert.equal(stackChangeRefusal(browser, [BuildTarget.Mac])?.code, TargetRefusal.StackIsFixed);
  });
});

describe("a night on a newer Genex's game is refused", () => {
  it("kind-unsupported leaves a night nothing it may write into, so the launch names it", () => {
    const problem = "a newer version of Genex made this game, so it opens read-only";
    assert.deepEqual(refusingProblems([problem], [GameValidationCode.KindUnsupported]), [problem]);
  });
});
