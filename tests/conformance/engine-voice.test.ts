/**
 * One engine voice (M4.8b).
 *
 * The studio runs a run on somebody's own subscription, and the two engines it hires spell a
 * tool call differently: Claude Code receives the studio's tools as MCP tools and calls them by
 * name, Codex has no tool channel at all and runs a bridge script the studio writes into the
 * workspace. That difference is the ONLY thing in the whole harness that branches on the engine
 * — and until this package eight prompts spelled BOTH, so a Claude session read a shell command
 * it must never run and a Codex session read an `mcp__` name it cannot call.
 *
 * The invariant here is not a list of the sites that were fixed. It enumerates the prompt
 * builders each module EXPORTS, renders every one of them once per engine, and asserts that a
 * Claude render carries no bridge command and a Codex render carries no `mcp__` name — so the
 * ninth prompt somebody writes is held to the same rule without anybody remembering to add it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BRIDGE_TOOL_CMD, toolCall, toolSyntax } from "../../src/harness-seed/loop/model-roles.ts";
import { BRIDGE_DIR } from "../../src/substrate/engines/studio-bridge.ts";
import * as director from "../../src/harness-seed/loop/director.ts";
import * as facetLoop from "../../src/harness-seed/loop/facet-loop.ts";
import * as singleWorker from "../../src/harness-seed/loop/director/single-worker-prompts.ts";
import * as autopilot from "../../src/harness-seed/loop/autopilot.ts";
import * as spike from "../../src/harness-seed/loop/spike.ts";
import * as chatSession from "../../src/harness-seed/loop/chat-session.ts";
import { GameEngine } from "../../src/harness-seed/loop/game-engine.ts";
import * as chatSteer from "../../src/harness-seed/loop/chat-steer-prompts.ts";
import * as scout from "../../src/harness-seed/loop/scout.ts";
import * as library from "../../src/harness-seed/loop/library.ts";
import * as nativeBriefs from "../../src/harness-seed/loop/native-briefs.ts";
import {
  CheckSupport,
  GameStack,
  ProjectKind,
  RAYLIB_CHECK_SUPPORT,
} from "../../src/harness-seed/loop/native-contract.ts";
import { computerToolDescription } from "../../src/substrate/computer-tool-prompts.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const CLAUDE = "claude-code";
const CODEX = "codex";

const PENDING_CROSS_LANE = new Set<string>();

/** A spec whose checks, ownership and board are enough for every builder below to render. */
function fixture(engine: string) {
  const run = {
    runId: "run_v",
    project: "plaza",
    goal: "a plaza people want to skate",
    engine,
    blender: { version: "4.2", path: "/blender" },
    setup: null,
    reference: null,
  };
  const spec = {
    id: "plaza",
    title: "The plaza",
    intent: "a stone plaza with benches",
    owns: ["src/plaza.js"],
    identity: ["stone"],
    checks: [{ id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.5", weight: "identity" }],
    done: [{ id: "lit", what: "a plaza a player can walk across" }],
    cameras: ["default"],
  };
  const worker = { id: "w1", title: "The plaza", brief: "build the plaza", owns: ["src/plaza.js"], ownsMain: false };
  const shape = { entry: "index.html", main: "src/main.js", build: null };
  return { run, spec, worker, shape };
}

/** Every exported prompt builder, with arguments that make it render. */
function builders(engine: string): Array<{ name: string; text: string }> {
  const { run, spec, worker, shape } = fixture(engine);
  const now = Date.now();
  const out: Array<{ name: string; text: string }> = [
    { name: "contractBrief", text: director.contractBrief({ run, projectLabel: "plaza", shape } as never) },
    {
      name: "directorBrief",
      text: director.directorBrief({
        run,
        shape,
        ownShape: false,
        capacity: { max: 6, free: 5, memory: { freeMb: 9000 } },
        skill: "# playbook",
        softDeadline: now + 60_000,
        finalDeadline: now + 120_000,
        integrationWorktree: "/w",
        baseCommit: "abcdef1234567890",
      } as never),
    },
    { name: "singleWorkerBrief", text: director.singleWorkerBrief({ run, worker, shape } as never) },
    {
      name: "wrapUpPrompt",
      text: director.wrapUpPrompt({
        run,
        finalDeadline: now + 60_000,
        integrationHead: "abc",
        integrationHealthy: true,
        workers: [],
      } as never),
    },
    {
      name: "facetPrompt",
      text: facetLoop.facetPrompt({
        run,
        spec,
        iteration: 2,
        resumed: false,
        briefFile: null,
        board: {},
        worktree: "/w",
        acceptedShots: [],
        userSteering: ["make it oak"],
      } as never),
    },
    { name: "steerPrompt", text: facetLoop.steerPrompt(["make the benches oak"]) },
    { name: "carryOnPrompt", text: singleWorker.carryOnPrompt() },
    {
      name: "baseBrief",
      text: autopilot.baseBrief({
        run,
        plan: { facets: [spec], base: { notes: "", files: [] } },
        projectLabel: "plaza",
        shape,
      } as never),
    },
    {
      name: "spikeBrief",
      text: spike.spikeBrief({
        run,
        spec,
        check: spec.checks[0],
        tried: ["a shader"],
        recipes: [],
        page: "spike/lit.html",
        script: "spike/lit.js",
        recipeFile: "spike/RECIPE.md",
      } as never),
    },
    {
      name: "buildContractorBrief",
      text: chatSession.buildContractorBrief({
        ask: "a pong game",
        scaffolded: true,
        engine,
        launch: { toolName: "start_autopilot", hours: 8, project: "plaza" },
      }),
    },
    {
      // An Unreal game's brief names the Unreal Editor's tools, held to the same rule.
      name: "buildContractorBrief",
      text: chatSession.buildContractorBrief({
        ask: "add a lighthouse",
        engine,
        gameEngine: GameEngine.Unreal,
        engineProject: "/Users/me/Unreal Projects/Valley/Valley.uproject",
      }),
    },
    {
      name: "buildInterviewBrief",
      text: chatSession.buildInterviewBrief({
        ask: "a pong game",
        project: "plaza",
        toolName: "start_autopilot",
        hours: 8,
      }),
    },
    { name: "steeredTurnPrompt", text: chatSteer.steeredTurnPrompt(["make the benches oak"]) },
    { name: "scoutBrief", text: scout.scoutBrief({ run, profile: { maxParallel: 2 }, shape } as never) },
    {
      name: "renderBrief",
      text: library.renderBrief({ run, spec, iteration: 2, board: {}, comparison: null } as never),
    },
    ...cppBuilders(engine),
    ...cppRenderBriefs(engine),
  ];
  return out;
}

/** A C++ · raylib game as the studio scaffolds it, and one somebody brought. */
const CPP_SHAPE = { entry: "index.html", main: "src/main.cpp", build: null, kind: ProjectKind.RaylibCpp };
const CPP_OWN = { entry: "index.html", main: "src/game.cpp", build: null, kind: ProjectKind.RaylibCpp };

/** A C++ · raylib facet's BRIEF.md, on the studio's C++ template and in a game of its own, for `engine`. */
function cppRenderBriefs(engine: string): Array<{ name: string; text: string }> {
  const { run, spec } = fixture(engine);
  const cppSpec = { ...spec, owns: ["src/plaza.cpp"] };
  const cpp = { run, spec: cppSpec, iteration: 2, board: {}, comparison: null, stack: GameStack.RaylibCpp };
  return [
    { name: "renderBrief (C++)", text: library.renderBrief({ ...cpp, entryMain: CPP_SHAPE.main } as never) },
    {
      name: "renderBrief (C++ own shape)",
      text: library.renderBrief({ ...cpp, entryMain: CPP_OWN.main, screen: false, template: false } as never),
    },
  ];
}

/** Every brief a C++ · raylib game's agents read, rendered for `engine`. */
function cppBuilders(engine: string): Array<{ name: string; text: string }> {
  const { run, spec } = fixture(engine);
  const cppSpec = { ...spec, owns: ["src/plaza.cpp"] };
  const launch = { toolName: "start_autopilot", hours: 8, project: "plaza" };
  return [
    {
      name: "cppBaseBrief",
      text: nativeBriefs.cppBaseBrief({
        run,
        plan: { facets: [cppSpec] },
        projectLabel: "plaza",
        shape: CPP_SHAPE,
      } as never),
    },
    {
      name: "baseBrief (C++)",
      text: autopilot.baseBrief({ run, plan: { facets: [cppSpec] }, projectLabel: "plaza", shape: CPP_SHAPE } as never),
    },
    {
      name: "baseBrief (C++ starting scene)",
      text: autopilot.baseBrief({ run, plan: { facets: [] }, projectLabel: "plaza", shape: CPP_SHAPE } as never),
    },
    {
      name: "baseBrief (C++ own shape)",
      text: autopilot.baseBrief({
        run,
        plan: { facets: [cppSpec] },
        projectLabel: "plaza",
        shape: CPP_OWN,
        ownShape: true,
      } as never),
    },
    { name: "contractWiringAsk (C++)", text: autopilot.contractWiringAsk(CPP_OWN as never) },
    {
      name: "buildContractorBrief (C++)",
      text: chatSession.buildContractorBrief({
        ask: "a pong game",
        scaffolded: true,
        engine,
        launch,
        shape: CPP_SHAPE,
      }),
    },
    {
      name: "buildContractorBrief (C++ own shape)",
      text: chatSession.buildContractorBrief({
        ask: "add a boss",
        engine,
        shape: CPP_OWN,
        ownShape: true,
        contractMissing: true,
      }),
    },
    {
      name: "facetPrompt (C++)",
      text: facetLoop.facetPrompt({ ...facetArgs, run, spec: cppSpec, ownsMain: false, shape: CPP_SHAPE } as never),
    },
    {
      name: "facetPrompt (C++ owner)",
      text: facetLoop.facetPrompt({ ...facetArgs, run, spec: cppSpec, ownsMain: true, shape: CPP_SHAPE } as never),
    },
    {
      name: "facetPrompt (C++ own shape)",
      text: facetLoop.facetPrompt({ ...facetArgs, run, spec: cppSpec, ownShape: true, shape: CPP_OWN } as never),
    },
    {
      name: "briefWithMovedSections (C++)",
      text: facetLoop.briefWithMovedSections("# Brief", {
        spec: cppSpec,
        ownsMain: false,
        entryMain: CPP_SHAPE.main,
        kind: CPP_SHAPE.kind,
      } as never),
    },
    {
      name: "spikeBrief (C++)",
      text: spike.spikeBrief({
        run,
        spec: cppSpec,
        check: spec.checks[0],
        tried: ["a shader"],
        recipes: [],
        page: "spike/lit.html",
        script: "spike/lit.js",
        recipeFile: "spike/lit.RECIPE.md",
        stack: GameStack.RaylibCpp,
      } as never),
    },
    {
      name: "contractBrief (C++)",
      text: director.contractBrief({ run, projectLabel: "plaza", shape: CPP_OWN } as never),
    },
    {
      name: "cppContractBrief",
      text: nativeBriefs.cppContractBrief({ run, projectLabel: "plaza", shape: CPP_OWN } as never),
    },
    {
      name: "cppSpikeBrief",
      text: nativeBriefs.cppSpikeBrief({
        run,
        spec: cppSpec,
        check: "- lit: litFraction > 0.5",
        tried: [],
        recipes: [],
        id: "lit",
        location: { dir: "spike", recipeFile: "spike/lit.RECIPE.md" },
      } as never),
    },
    {
      name: "singleWorkerBrief (C++)",
      text: director.singleWorkerBrief({ run, worker: cppWorker, shape: CPP_SHAPE } as never),
    },
    {
      name: "singleWorkerBrief (C++ own shape)",
      text: director.singleWorkerBrief({ run, worker: cppWorker, shape: CPP_OWN, ownShape: true } as never),
    },
    {
      name: "directorBrief (C++)",
      text: director.directorBrief({ ...directorArgs(run), shape: CPP_SHAPE, ownShape: false } as never),
    },
    {
      name: "directorBrief (C++ own shape)",
      text: director.directorBrief({ ...directorArgs(run), shape: CPP_OWN, ownShape: true } as never),
    },
  ];
}

/** A facet prompt's arguments that are the same for every stack. */
const facetArgs = {
  iteration: 2,
  resumed: false,
  briefFile: null,
  board: {},
  worktree: "/w",
  acceptedShots: [],
  userSteering: [],
};
/** A worker the director starts on a C++ game. */
const cppWorker = { id: "w1", title: "The plaza", brief: "build the plaza", owns: ["src/plaza.cpp"], ownsMain: false };
/** A director brief's arguments that are the same for every stack. */
function directorArgs(run: Record<string, unknown>) {
  const now = Date.now();
  return {
    run: { ...run, engine: run.engine },
    capacity: { max: 6, free: 5, memory: { freeMb: 9000 } },
    skill: "# playbook",
    softDeadline: now + 60_000,
    finalDeadline: now + 120_000,
    integrationWorktree: "/w",
    baseCommit: "abcdef1234567890",
  };
}

describe("one engine voice", () => {
  it("the bridge command the prompts print is the bridge the app actually writes", () => {
    assert.equal(BRIDGE_TOOL_CMD, `node ${BRIDGE_DIR}/tool.mjs`);
  });

  it("one tool, spelled the way each engine can call it", () => {
    assert.equal(toolCall(CLAUDE, "computer"), "mcp__studio__computer");
    assert.equal(toolCall(CODEX, "computer"), `${BRIDGE_TOOL_CMD} computer`);
    // A local engine drives its tools through the studio's own tool loop: neither spelling.
    assert.equal(toolCall("ollama", "computer"), "computer");
    // OpenCode has no channel for the studio's tools either: it runs the same bridge as Codex.
    assert.equal(toolCall("opencode", "computer"), `${BRIDGE_TOOL_CMD} computer`);
    assert.match(toolSyntax("opencode"), /tool\.mjs <name> --field=value/);
    // OpenRouter's tools run in the studio's own session loop, by their bare names.
    assert.equal(toolCall("openrouter", "computer"), "computer");
    assert.equal(toolCall(undefined, "capture"), "capture");
    assert.match(toolSyntax(CLAUDE), /mcp__studio__<name>/);
    assert.doesNotMatch(toolSyntax(CLAUDE), /tool\.mjs/);
    assert.match(toolSyntax(CODEX), /tool\.mjs <name> --field=value/);
    assert.doesNotMatch(toolSyntax(CODEX), /mcp__/);
    assert.doesNotMatch(toolSyntax("ollama"), /mcp__|tool\.mjs/);
  });

  it("every exported prompt builder speaks one engine's language and never the other's", () => {
    const claude = builders(CLAUDE);
    const codex = builders(CODEX);
    assert.equal(claude.length, codex.length);
    const checked: string[] = [];
    for (let i = 0; i < claude.length; i += 1) {
      const name = claude[i].name;
      if (PENDING_CROSS_LANE.has(name)) continue;
      checked.push(name);
      assert.equal(
        claude[i].text.includes("tool.mjs"),
        false,
        `${name} tells a Claude session to run the Codex bridge`,
      );
      assert.equal(
        codex[i].text.includes("mcp__studio__"),
        false,
        `${name} tells a Codex session to call an mcp__ tool it does not have`,
      );
    }
    assert.ok(checked.length >= 9, `nine builders at least, got ${checked.join(", ")}`);
  });

  it("names every exported prompt builder, so a tenth cannot be added without being held to the rule", () => {
    const exported: string[] = [];
    for (const [label, mod] of Object.entries({
      director,
      facetLoop,
      singleWorker,
      autopilot,
      spike,
      chatSession,
      chatSteer,
      scout,
      library,
      nativeBriefs,
    })) {
      for (const [key, value] of Object.entries(mod as Record<string, unknown>)) {
        if (typeof value !== "function") continue;
        if (!/Brief$|Prompt$/.test(key)) continue;
        // A writer, not a builder: it takes a rendered brief and puts it on disk.
        if (key === "writeWorktreeBrief") continue;
        exported.push(`${label}.${key}`);
      }
    }
    const covered = new Set(builders(CLAUDE).map((b) => b.name));
    const missing = exported.filter((e) => !covered.has(e.split(".")[1]));
    assert.deepEqual(
      missing,
      [],
      `every exported *Brief/*Prompt is rendered by this test; missing: ${missing.join(", ")}`,
    );
  });

  it("the two builders another lane owns are the only ones still spelling both", () => {
    // A ratchet, not an approval: when lane C and lane D take the one-line change recorded in
    // M4.8b's cross-lane requests, this test says so and the entry comes out of the set above.
    const claude = builders(CLAUDE);
    const still = claude.filter((b) => b.text.includes("tool.mjs")).map((b) => b.name);
    assert.deepEqual(still, [], "every builder uses its provider-specific tool spelling");
  });
});

/**
 * Two subscriptions in one run (cross-provider roles): a worker's brief is read by the
 * workers' engine, the director's by its own. On a run planned on Claude Code and built on
 * Codex the worker briefs must spell the bridge and the director's brief the MCP names — the
 * same rule as above, now with two engines on one run.
 */
describe("one engine voice on a run with two engines", () => {
  const crossed = (engine: string, builderEngine: string) => {
    const { run, spec, worker, shape } = fixture(engine);
    return { run: { ...run, builderEngine }, spec, worker, shape };
  };

  it("worker-facing briefs speak the workers' engine; the director's brief speaks the orchestrator's", () => {
    const { run, spec, worker, shape } = crossed(CLAUDE, CODEX);
    const now = Date.now();
    const forWorkers = [
      director.contractBrief({ run, projectLabel: "plaza", shape } as never),
      director.singleWorkerBrief({ run, worker, shape } as never),
      facetLoop.facetPrompt({
        run,
        spec,
        iteration: 2,
        resumed: false,
        briefFile: null,
        board: {},
        worktree: "/w",
        acceptedShots: [],
        userSteering: [],
      } as never),
      autopilot.baseBrief({
        run,
        plan: { facets: [spec], base: { notes: "", files: [] } },
        projectLabel: "plaza",
        shape,
      } as never),
      spike.spikeBrief({
        run,
        spec,
        check: spec.checks[0],
        tried: [],
        recipes: [],
        page: "spike/lit.html",
        script: "spike/lit.js",
        recipeFile: "spike/RECIPE.md",
      } as never),
    ];
    for (const brief of forWorkers) {
      assert.ok(brief.includes(BRIDGE_TOOL_CMD), "a Codex worker on a Claude-planned run reads the bridge");
      assert.equal(brief.includes("mcp__studio__"), false, "and never an mcp__ name it cannot call");
    }
    const forDirector = director.directorBrief({
      run,
      shape,
      ownShape: false,
      capacity: { max: 6, free: 5, memory: { freeMb: 9000 } },
      skill: "",
      softDeadline: now + 60_000,
      finalDeadline: now + 120_000,
      integrationWorktree: "/w",
      baseCommit: "abcdef1234567890",
    } as never);
    assert.ok(forDirector.includes("mcp__studio__"), "the Claude director reads mcp__ names");
    assert.equal(forDirector.includes("tool.mjs"), false, "and never the bridge its workers run");
  });

  it("and the other way round", () => {
    const { run, worker, shape } = crossed(CODEX, CLAUDE);
    const brief = director.singleWorkerBrief({ run, worker, shape } as never);
    assert.ok(brief.includes("mcp__studio__"));
    assert.equal(brief.includes("tool.mjs"), false);
    const now = Date.now();
    const forDirector = director.directorBrief({
      run,
      shape,
      ownShape: false,
      capacity: null,
      skill: "",
      softDeadline: now + 60_000,
      finalDeadline: now + 120_000,
      integrationWorktree: "/w",
      baseCommit: "abcdef1234567890",
    } as never);
    assert.ok(forDirector.includes(BRIDGE_TOOL_CMD.replace("node ", "")));
    assert.equal(forDirector.includes("mcp__studio__"), false);
  });
});

/** The words a Three.js game read before C++ games: what `cppBuilders` must never leave behind. */
const THREE_ONLY = [/installStudio/, /window\.__studio/, /src\/main\.js/, /src\/studio\.js/, /THREE\./, /import map/];

describe("a C++ · raylib game's briefs", () => {
  it("speak C++ on both engines: the contract is studio::install, and no Three.js word reaches them", () => {
    for (const engine of [CLAUDE, CODEX]) {
      for (const { name, text } of [...cppBuilders(engine), ...cppRenderBriefs(engine)]) {
        for (const word of THREE_ONLY) assert.doesNotMatch(text, word, `${engine} ${name}: ${word}`);
        assert.match(text, /studio::install|the studio's C\+\+ lane/, `${engine} ${name} speaks of the C++ contract`);
      }
    }
  });

  it("tell a raylib night's planner the game is C++ and which check kinds it measures, by the checks' own table", () => {
    const text = nativeBriefs.cppPlannerLines().join("\n");
    assert.ok(text.startsWith(nativeBriefs.CPP_PLANNER_HEADER), "it opens with the line the planner skill names");
    for (const word of [...THREE_ONLY, /src\/\S+\.js\b/]) assert.doesNotMatch(text, word, String(word));
    assert.match(text, /src\/<slug>\.cpp/, "a facet owns its own C++ source");
    assert.match(text, /wire_<id>\(game\)/, "and wires in with one line");
    const kindsLine = text.split("\n").find((line) => line.includes("Check kinds measured")) ?? "";
    const [measured = "", never = ""] = kindsLine.split(". A ");
    for (const [kind, support] of Object.entries(RAYLIB_CHECK_SUPPORT)) {
      const clause = support === CheckSupport.Measured ? measured : never;
      assert.ok(clause.includes(`\`${kind}\``), `${kind} is said to be ${support}: ${kindsLine}`);
    }
    assert.match(never, /check is never measured here/);
    // The workspace's own skill copy may predate C++ games; the shipped one names the line the ask carries.
    const skill = readFileSync(
      new URL("../../src/harness-seed/skills/facet-decomposition.md", import.meta.url),
      "utf8",
    );
    assert.ok(
      skill.includes(`\`${nativeBriefs.CPP_PLANNER_HEADER}\``),
      "the planner skill's C++ section is keyed to it",
    );
  });

  it("name only paths the spike runner lets a C++ spike edit, and the recipe file it harvests", () => {
    const location = spike.spikeLocation({ id: "lit", shape: CPP_SHAPE });
    const { run, spec } = fixture(CLAUDE);
    const text = spike.spikeBrief({
      run,
      spec,
      check: spec.checks[0],
      tried: [],
      recipes: [],
      page: location.page,
      script: location.script,
      recipeFile: location.recipeFile,
      stack: GameStack.RaylibCpp,
    } as never);
    const owns = spike.spikeOwns(location);
    const named = [...new Set(text.match(/\b[\w./-]*spike\/[\w./<>-]+/g) ?? [])].map((p) => p.replace(/[.]$/, ""));
    assert.ok(named.length >= 4, `the brief names its files: ${named.join(", ")}`);
    for (const file of named)
      assert.ok(
        owns.some((own) => file === own || file.startsWith(`${own}/`)),
        `${file} is inside what the spike owns (${owns.join(", ")})`,
      );
    assert.ok(
      text.includes(`write ${location.recipeFile} with exactly these sections`),
      "it writes the runner's recipe file",
    );
    assert.ok(spike.recipeCandidates(location, "lit").includes(location.recipeFile), "which the runner harvests");
  });

  it("open no spike on a C++ · raylib game: no workspace, no build turn, and the reason in the outcome", async () => {
    const recorder = ctxRecorder({
      handlers: {
        "engine.describe": () => [{ id: "claude-code", kind: "delegated" }],
        "engine.delegate": () => assert.fail("no build for a C++ spike"),
      },
    });
    const { spec } = fixture(CLAUDE);
    const outcome = await spike.runSpike(
      recorder.ctx as never,
      {
        run: { runId: "run_c", project: "pong", engine: CLAUDE },
        spec,
        check: spec.checks[0],
        iteration: 2,
        facetThreadId: "facet-thread",
        deadline: Date.now() + 60 * 60_000,
        shape: CPP_SHAPE,
        worktree: true,
        incumbentCommit: "abc123",
      } as never,
    );
    assert.deepEqual(recorder.sequence(), ["engine.describe"], "nothing opened, snapshotted or built");
    assert.equal(outcome.ok, false);
    assert.match(outcome.reason, /^no spike: this is a C\+\+ · raylib game/);
    for (const word of THREE_ONLY) assert.doesNotMatch(outcome.reason, word);
  });
});

describe("the computer tool's words", () => {
  const view = { width: 1280, height: 720 };
  const cameras = " Known cameras: default, eye:here.";
  it("are what they were before C++ games for every Three.js session (sha256 at origin/dev cf4b2c56)", () => {
    const PRE_NATIVE = {
      builder: "66885724c53287dc",
      director: "9aad5ebfff99c483",
      playtester: "62a2ba5bfbdc8741",
      scout: "e6d353c39e17adae",
    } as const;
    for (const [role, digest] of Object.entries(PRE_NATIVE)) {
      const text = computerToolDescription({ role: role as keyof typeof PRE_NATIVE, view, cameras });
      assert.equal(createHash("sha256").update(text).digest("hex").slice(0, 16), digest, role);
      assert.doesNotMatch(text, /C\+\+/, `${role}: no C++ word`);
    }
  });

  it("say a C++ session's reload rebuilds through the studio's lane, for the roles that edit", () => {
    for (const role of ["builder", "director"] as const)
      assert.match(computerToolDescription({ role, view, cameras, cpp: true }), /rebuilds this C\+\+ · raylib game/);
    assert.doesNotMatch(computerToolDescription({ role: "playtester", view, cameras, cpp: true }), /C\+\+/);
  });
});

/**
 * Every Three.js brief, rendered from fixed arguments, and the first 16 hex of its sha256 in
 * origin/dev cf4b2c56's seed, before the compiled stacks were ported to it: the C++ and Rust
 * variants branch beside these texts, never through them.
 */
const PRE_NATIVE_BRIEFS = {
  [CLAUDE]: {
    baseBriefFacets: "51dc3d2810245dce",
    baseBriefStart: "73fe6a14005c24a1",
    baseBriefOwn: "9a2cabce6cd93d4f",
    contractWiringAsk: "08bd1fab4144a340",
    contractorFresh: "b94dc08e250475da",
    contractorFollowUp: "f75cf05c6ee0de88",
    contractorOwn: "c23353614b9e6a40",
    contractorResume: "f08664c74565604b",
    interview: "ccfc8e18264c12f3",
    spikeBrief: "3981c09354d6e4f8",
    facetPrompt: "1597ab4163ef756b",
    contractBrief: "4fd6edf2d2afabe1",
    singleWorkerBrief: "9f8cc64ed6b36d3a",
  },
  [CODEX]: {
    baseBriefFacets: "b46b89125416b882",
    baseBriefStart: "73fe6a14005c24a1",
    baseBriefOwn: "8e36d19e777dc2f6",
    contractWiringAsk: "08bd1fab4144a340",
    contractorFresh: "687471899698e04b",
    contractorFollowUp: "aca630fcbe4ea7d1",
    contractorOwn: "47afdca1c69693e5",
    contractorResume: "f08664c74565604b",
    interview: "ccfc8e18264c12f3",
    spikeBrief: "7279d5ca7f175080",
    facetPrompt: "a5717393b3494bea",
    contractBrief: "cf35637b1216e916",
    singleWorkerBrief: "9028fcf334c02e81",
  },
} as const;

/** The Three.js briefs `PRE_NATIVE_BRIEFS` digests, from the same arguments every time. */
function threeBriefs(engine: string): Record<string, string> {
  const { run, spec, worker, shape } = fixture(engine);
  const template = { ...shape, kind: "studio-template" };
  const own = { entry: "dist/index.html", main: "src/game.ts", build: "npm run build", kind: "three-vite" };
  return {
    baseBriefFacets: autopilot.baseBrief({
      run,
      plan: { facets: [spec], base: { notes: "", files: [] } },
      projectLabel: "plaza",
      shape: template,
    } as never),
    baseBriefStart: autopilot.baseBrief({ run, plan: { facets: [] }, projectLabel: "plaza", shape: template } as never),
    baseBriefOwn: autopilot.baseBrief({
      run,
      plan: { facets: [spec] },
      projectLabel: "plaza",
      shape: own,
      ownShape: true,
      setup: { note: "the arena", verify: { path: "phase", equals: "arena" } },
    } as never),
    contractWiringAsk: autopilot.contractWiringAsk(own) + autopilot.contractWiringAsk(null),
    contractorFresh: chatSession.buildContractorBrief({
      ask: "a pong game",
      scaffolded: true,
      engine,
      launch: { toolName: "start_autopilot", hours: 8, project: "plaza" },
    }),
    contractorFollowUp: chatSession.buildContractorBrief({
      ask: "add fog",
      messages: [
        { role: "user", content: "a pong game" },
        { role: "assistant", content: "done" },
      ],
      engine,
      extraReads: ["/stills"],
      folderLabel: "plaza",
    }),
    contractorOwn: chatSession.buildContractorBrief({
      ask: "add fog",
      engine,
      shape: own,
      ownShape: true,
      contractMissing: true,
    }),
    contractorResume: chatSession.buildContractorBrief({ ask: "go on", resume: true, engine }),
    interview: chatSession.buildInterviewBrief({
      ask: "a pong game",
      project: "plaza",
      toolName: "start_autopilot",
      hours: 8,
    }),
    spikeBrief: spike.spikeBrief({
      run,
      spec,
      check: spec.checks[0],
      tried: ["a shader"],
      recipes: [],
      page: "spike/lit.html",
      script: "spike/lit.js",
      recipeFile: "spike/RECIPE.md",
    } as never),
    facetPrompt: facetLoop.facetPrompt({
      run,
      spec,
      iteration: 2,
      resumed: false,
      briefFile: null,
      board: {},
      worktree: "/w",
      acceptedShots: [],
      userSteering: ["make it oak"],
    } as never),
    contractBrief: director.contractBrief({ run, projectLabel: "plaza", shape: own } as never),
    singleWorkerBrief: director.singleWorkerBrief({ run, worker, shape: template } as never),
  };
}

describe("a Three.js game's briefs", () => {
  it("keep every word they had before C++ games, on both engines", () => {
    const digest = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
    for (const engine of [CLAUDE, CODEX] as const) {
      const rendered = Object.fromEntries(Object.entries(threeBriefs(engine)).map(([k, v]) => [k, digest(v)]));
      assert.deepEqual(rendered, PRE_NATIVE_BRIEFS[engine], engine);
    }
  });
});
