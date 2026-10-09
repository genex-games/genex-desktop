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
  ];
  return out;
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
