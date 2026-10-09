/**
 * What a builder is told on a project's first message, from the folder's facts; Genex never reads the
 * person's words to decide. A folder with no kind yet is told to pick one: web through
 * `start_web_game`, an engine whose plugin is on through the question card, anything else through
 * `plugins_find`. A folder that has a kind is never asked; each kind gets its own rules, named by
 * path when the folder holds more than one; an Unreal project with the plugin off is told it has no
 * Unreal tools. Every brief opens with who runs it: Genex, the folder, what it holds and what a
 * Genex plugin is.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildContractorBrief } from "../../src/harness-seed/loop/chat-session.ts";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { directorBrief, singleWorkerBrief } from "../../src/harness-seed/loop/director/briefs.ts";
import { CONFLICT_WORDS } from "../../src/harness-seed/loop/director/lead-session-prompts.ts";
import { facetPromptFor } from "../../src/harness-seed/loop/facet/phases/brief.ts";
import { baseBrief } from "../../src/harness-seed/loop/prompts-build.ts";
import { agentBrief } from "../../src/harness-seed/loop/unreal/agent-prompts.ts";
import { AgentKind } from "../../src/harness-seed/loop/unreal/lead-contract.ts";
import { WorkerIsolation } from "../../src/harness-seed/loop/workers/contract.ts";
import { workerBrief } from "../../src/harness-seed/loop/workers/prompts.ts";
import { runIdentity } from "../../src/harness-seed/loop/workers/identity.ts";
import { CoreFact } from "../../src/harness-seed/loop/folder-facts.ts";
import { toolCall } from "../../src/harness-seed/loop/model-roles.ts";
import { RunEvent } from "../../src/harness-seed/loop/run-events.ts";
import { leadBrief } from "../../src/harness-seed/loop/unreal/lead-prompts.ts";
import { TemplateKind } from "../../src/harness-seed/loop/unreal/template-kind.ts";
import { engineChoiceRule, UNREAL_NEW_GAME_TOOL } from "../../src/harness-seed/loop/unreal-prompts.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

const CLAUDE = "claude-code";
const ASK = "make a castle exploration game";
const NAME = "keep";
const START_WEB_GAME = toolCall(CLAUDE, "start_web_game");
const PLUGINS_FIND = toolCall(CLAUDE, "plugins_find");
const PLUGINS_SUGGEST = toolCall(CLAUDE, "plugins_suggest");
/** The words every brief opens with: where it runs, and what a plugin is there. */
const IDENTITY = /inside Genex[\s\S]*a Genex plugin/;

/** A fact as `game.list` lists it. */
const fact = (id: string, where = ".", source = "core") => ({ id, path: where, source });

/** A descriptor as `game.list` answers it, with the folder's facts. */
function game(facts: unknown[], extra: Record<string, unknown> = {}) {
  return {
    name: NAME,
    title: "Keep",
    dir: `/games/${NAME}`,
    shape: { entry: "index.html", main: "src/main.js", build: null, own: false, kind: "studio-template" },
    built: false,
    facts,
    ...extra,
  };
}

const NEW_GAME_TOOL = { name: UNREAL_NEW_GAME_TOOL, description: "Make the game's Unreal project.", parameters: {} };
const UNREAL_KIND = { plugin: "unreal", name: "Unreal Engine", tool: UNREAL_NEW_GAME_TOOL, makes: ["unreal-project"] };
const TOY_KIND = { plugin: "toy", name: "Toy Engine", tool: "toy__new-toy", makes: ["toy-project"] };
const UNREAL_ON = { tools: [NEW_GAME_TOOL], kinds: [UNREAL_KIND] };
const NONE_ON = { tools: [], kinds: [] };

/** One delegated chat turn on the game: its first message, the plugin tools the host serves. */
async function firstMessage(
  descriptor: unknown,
  plugins: { tools: unknown[]; kinds: unknown[] },
  messages: Array<{ role: string; content: string }> = [{ role: "user", content: ASK }],
) {
  const recorder = ctxRecorder({
    unknown: { value: null },
    handlers: {
      "events.messages": () => messages,
      "game.contentStamp": () => ({ all: null, source: null }),
      "game.list": () => [descriptor],
      "plugins.tools": () => ({ ...plugins, guidance: "", revision: 1 }),
      "engine.describe": () => [],
      "preview.ready": () => ({ ready: false }),
      "engine.delegate": () => ({ ok: true, engine: CLAUDE, turns: 1, usage: {}, sessionId: "s", summary: "ok" }),
    },
  });
  const turn = {
    threadId: "t1",
    turnId: "turn-1",
    text: ASK,
    engine: CLAUDE,
    engineLabel: "Claude Code",
    project: NAME,
  };
  await runDelegatedTurn(recorder.ctx as never, turn as never);
  const [delegated] = recorder.paramsOf("engine.delegate");
  assert.ok(delegated, "the ask reached the builder");
  const handoff = recorder
    .paramsOf("turn.append")
    .flatMap((p) => (p.batch as Array<{ event_type?: string; payload?: { text?: string } }>) ?? [])
    .find((event) => event.event_type === RunEvent.ContractorHandoff);
  return {
    prompt: String(delegated.prompt),
    lines: String(delegated.prompt).split("\n"),
    bridged: (delegated.interviewTools as Array<{ name: string }> | undefined)?.map((t) => t.name) ?? [],
    capture: Boolean(delegated.selfCapture),
    validated: recorder.sequence("game.validate").length > 0,
    handoffText: String(handoff?.payload?.text ?? ""),
  };
}

describe("the first message on a project with no kind", () => {
  it("a project with no kind and no engine plugin on is told to start web with start_web_game, or find a plugin; no card", async () => {
    const { prompt, bridged, capture } = await firstMessage(game([]), NONE_ON);
    assert.ok(prompt.includes(START_WEB_GAME), "web starts with start_web_game");
    assert.ok(prompt.includes(PLUGINS_FIND), "anything else goes through plugins_find");
    assert.doesNotMatch(prompt, /Unreal/);
    assert.deepEqual(bridged, [], "no question card");
    assert.equal(capture, true, "served as a web game until it picks");
    assert.match(prompt, /folder is empty: there is nothing to inspect yet/);
  });

  it("with an engine plugin on, the first message on a project with no kind asks with the card, and web still starts with start_web_game", async () => {
    const { lines, prompt, bridged } = await firstMessage(game([]), UNREAL_ON);
    assert.ok(lines.includes(engineChoiceRule(CLAUDE, null, [UNREAL_KIND])), "the engine question, as its own line");
    assert.deepEqual(bridged, ["ask_user"]);
    assert.ok(prompt.includes(START_WEB_GAME), "the web answer starts the web starter");
    const both = await firstMessage(game([]), { tools: [NEW_GAME_TOOL], kinds: [UNREAL_KIND, TOY_KIND] });
    assert.ok(both.prompt.includes('"Toy Engine"'), "every engine plugin on is an option");
    assert.ok(both.prompt.includes(toolCall(CLAUDE, TOY_KIND.tool)), "with its own kind tool");
    assert.deepEqual(both.bridged, ["ask_user"]);
  });

  it("a project still with no kind is offered the kinds on every message, not only the chat's first", async () => {
    const later = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello! What shall we make?" },
      { role: "user", content: "make it in Unreal Engine" },
    ];
    const { prompt, bridged } = await firstMessage(game([]), UNREAL_ON, later);
    assert.deepEqual(bridged, ["ask_user"], "the card is still there after a greeting");
    assert.ok(prompt.includes(toolCall(CLAUDE, UNREAL_NEW_GAME_TOOL)), "the Unreal kind tool is named");
    assert.doesNotMatch(prompt, /picked by this first message/, "the identity does not say this is the first message");

    // Without the card (no question to bridge), each kind on offer is named by its tool.
    const plain = buildContractorBrief({ ask: ASK, engine: CLAUDE, facts: [], kinds: [UNREAL_KIND, TOY_KIND] });
    assert.ok(plain.includes(START_WEB_GAME), "web is still the default");
    assert.ok(plain.includes(`When the request names Unreal Engine, call ${toolCall(CLAUDE, UNREAL_NEW_GAME_TOOL)}`));
    assert.ok(plain.includes(`When the request names Toy Engine, call ${toolCall(CLAUDE, TOY_KIND.tool)}`));
    assert.doesNotMatch(plain, /FIRST, THE ENGINE/, "no question without the card");
  });

  it("a folder of notes is new but not empty: the notes are read first, and web still starts with start_web_game", async () => {
    const { prompt } = await firstMessage(game([], { holds: "notes" }), NONE_ON);
    assert.ok(prompt.includes(START_WEB_GAME), "no kind yet: web is the default");
    assert.doesNotMatch(prompt, /empty/, "a folder of notes is never called empty");
    assert.match(prompt, /holds notes but no game yet/);
    assert.match(prompt, /read the notes/);
  });

  it("a folder of its own files of a kind no rule knows is never told it is empty nor handed the web starter", async () => {
    for (const plugins of [NONE_ON, UNREAL_ON]) {
      const { prompt, bridged } = await firstMessage(game([], { holds: "own-files" }), plugins);
      assert.ok(!prompt.includes(START_WEB_GAME), "no web starter");
      assert.doesNotMatch(prompt, /empty|holds nothing yet|nothing to inspect/, "it holds files");
      assert.match(prompt, /files of its own of a kind Genex has no rules for/);
      assert.match(prompt, /look through them first/);
      assert.ok(prompt.includes(PLUGINS_FIND), "a plugin is looked for");
      assert.deepEqual(bridged, [], "no question card: it has a kind, just not one Genex knows");
    }
    const unreadable = await firstMessage(game([], { holds: "unreadable" }), NONE_ON);
    assert.ok(!unreadable.prompt.includes(START_WEB_GAME), "an unreadable folder takes no starter");
    assert.match(unreadable.prompt, /could not read this project's folder/);
  });

  it("a project that has a kind is never asked", async () => {
    const kinds: Record<string, unknown[]> = {
      web: [fact(CoreFact.WebGame)],
      unreal: [fact(CoreFact.UnrealProject, "unreal", "link")],
      godot: [fact(CoreFact.GodotProject)],
    };
    for (const [label, facts] of Object.entries(kinds)) {
      const { prompt, bridged } = await firstMessage(game(facts), UNREAL_ON);
      assert.deepEqual(bridged, [], label);
      assert.doesNotMatch(prompt, /FIRST, THE ENGINE/, label);
      assert.ok(!prompt.includes(START_WEB_GAME), `${label}: nothing to start`);
    }
  });
});

describe("the rules each kind gets", () => {
  it("an Unreal project with the plugin off is told it has no Unreal tools and saves in the editor itself before a checkpoint", async () => {
    const { prompt, bridged, capture } = await firstMessage(game([fact(CoreFact.UnrealProject)]), NONE_ON);
    assert.match(prompt, /no Unreal tools/);
    assert.match(prompt, /can't save inside the editor before a checkpoint/);
    assert.ok(prompt.includes(PLUGINS_FIND), "it may offer the plugin");
    assert.ok(!prompt.includes("unreal-editor__call_tool"), "no tool it was not handed");
    assert.deepEqual(bridged, []);
    assert.equal(capture, false);
  });

  it("a kind no plugin on covers looks for a Genex plugin first, and turns to the shell only on the person's word", async () => {
    const rows: Array<[string, unknown]> = [
      ["an Unreal project, plugin off", game([fact(CoreFact.UnrealProject)])],
      ["a Godot project", game([fact(CoreFact.GodotProject)], { built: true, shape: { own: true } })],
      ["files of its own", game([], { holds: "own-files" })],
    ];
    for (const [label, descriptor] of rows) {
      const { lines } = await firstMessage(descriptor, NONE_ON);
      const find = lines.findIndex((line) => line.includes(PLUGINS_FIND));
      const shell = lines.findIndex((line) => /from the shell|files and the shell/.test(line));
      assert.ok(find >= 0, `${label}: plugins_find`);
      const findLine = lines[find] ?? "";
      assert.ok(findLine.includes(PLUGINS_SUGGEST), `${label}: a plugin it finds is suggested`);
      assert.match(findLine, /end your reply/, `${label}: the reply ends at the card`);
      assert.match(findLine, /only once the person has said to go on without a plugin/, `${label}: the person's word`);
      // One rule with plugins_find's own answer: with none found, the shell still waits for the person.
      assert.doesNotMatch(findLine, /or when \S+ finds none/, `${label}: no plugin found is no go-ahead`);
      assert.match(findLine, /finds none, offer to write a Genex plugin/, `${label}: as plugins_find answers`);
      assert.ok(find <= shell, `${label}: the plugin comes before the shell (${find}, ${shell})`);
    }
    // A plugin's own kind has its plugin on already: nothing to look for.
    const toy = await firstMessage(game([fact("toy-project", ".", "plugin:toy-engine")]), NONE_ON);
    assert.ok(!toy.prompt.includes(PLUGINS_SUGGEST), "a plugin's kind");
  });

  it("each kind gets its own rules, named by path when there are two", () => {
    const brief = buildContractorBrief({
      ask: ASK,
      engine: CLAUDE,
      folderLabel: "AI Games/keep",
      facts: [fact(CoreFact.UnrealProject), fact(CoreFact.WebGame, "site")] as never,
    });
    const lines = brief.split("\n");
    const web = lines.filter((line) => line.includes("window.__studio"));
    assert.ok(web.length > 0, "the web game's rules");
    for (const line of web) assert.ok(line.startsWith("For the web game in `site/`: "), line);
    const unreal = lines.filter((line) => line.includes("unreal-editor__list_toolsets"));
    assert.ok(unreal.length > 0, "the Unreal project's rules");
    for (const line of unreal) assert.doesNotMatch(line, /^For the /, line);
    const single = buildContractorBrief({ ask: ASK, engine: CLAUDE, facts: [fact(CoreFact.WebGame)] as never });
    assert.doesNotMatch(single, /^For the /m, "one kind needs no path");
  });

  it("an Unreal project the game is not linked to is never built through the Unreal tools until use-project links it", () => {
    const brief = buildContractorBrief({
      ask: ASK,
      engine: CLAUDE,
      folderLabel: "AI Games/keep",
      facts: [fact(CoreFact.UnrealProject, "unreal")] as never,
    });
    const useProject = toolCall(CLAUDE, "unreal__use-project");
    assert.doesNotMatch(brief, /built in Unreal Engine, in the user's open Unreal Editor, through the Unreal tools/);
    assert.doesNotMatch(
      brief,
      /Your changes land in the Unreal project/,
      "its changes land nowhere the tools reach yet",
    );
    assert.doesNotMatch(brief, /lands in its Unreal project[^\n]*through the Unreal tools/);
    assert.match(brief, /the project chosen in Genex's Unreal panel/, "the tools work on the panel's project");
    const linkLine = brief.split("\n").find((line) => line.includes(useProject)) ?? "";
    assert.match(linkLine, /never call them before/, "no Unreal call before the link");
    const linked = buildContractorBrief({
      ask: ASK,
      engine: CLAUDE,
      engineProject: "/games/keep/unreal/Keep.uproject",
      facts: [fact(CoreFact.UnrealProject, "unreal", "link")] as never,
    });
    assert.match(linked, /through the Unreal tools/, "a linked game is built through them");
  });

  it("a Godot folder's builder gets no web capture, no contract check and no preview words", async () => {
    const godot = game([fact(CoreFact.GodotProject)], { built: true, shape: { own: true } });
    const { prompt, capture, validated, handoffText } = await firstMessage(godot, NONE_ON);
    assert.equal(capture, false, "no web capture");
    assert.equal(validated, false, "no page contract check");
    assert.doesNotMatch(handoffText, /preview/);
    assert.doesNotMatch(prompt, /window\.__studio|checkpoint/);
    assert.match(prompt, /a Godot project/);
  });

  it("a folder of a kind Genex doesn't know is served as no web game: no web capture, contract check or Reload checkpoint", async () => {
    for (const holds of ["own-files", "unreadable"]) {
      const { prompt, capture, validated, handoffText } = await firstMessage(game([], { holds }), NONE_ON);
      assert.equal(capture, false, `${holds}: no web capture`);
      assert.equal(validated, false, `${holds}: no page contract check`);
      assert.doesNotMatch(handoffText, /preview/, holds);
      assert.doesNotMatch(prompt, /window\.__studio|lights the user's Reload/, holds);
    }
  });
});

describe("who runs the brief", () => {
  it("every brief says it runs inside Genex, which folder, what it holds, and what a Genex plugin is", () => {
    const facts = [fact(CoreFact.WebGame)] as never;
    const options = { ask: ASK, engine: CLAUDE, folderLabel: "AI Games/keep", facts };
    for (const brief of [buildContractorBrief(options), buildContractorBrief({ ...options, resume: true })]) {
      assert.match(brief, IDENTITY);
      assert.match(brief, /folder `AI Games\/keep`/);
      assert.match(brief, /a web game/);
    }
    const pending = buildContractorBrief({ ...options, facts: [] });
    assert.match(pending, /holds nothing yet/);
    const now = Date.now();
    const director = directorBrief({
      run: { runId: "r", project: NAME, goal: "g" },
      softDeadline: now + 1,
      finalDeadline: now + 2,
      integrationWorktree: "/w",
      baseCommit: null,
    } as never);
    assert.match(director, IDENTITY);
    assert.match(director, /a web game/);
    const placed = directorBrief({
      run: { runId: "r", project: NAME, goal: "g" },
      softDeadline: now + 1,
      finalDeadline: now + 2,
      integrationWorktree: "/w",
      baseCommit: null,
      facts: [fact(CoreFact.WebGame, "site"), fact(CoreFact.UnrealProject)],
      gameFolder: "/Users/me/AI Games/keep-site",
    } as never);
    assert.match(
      placed,
      /folder `AI Games\/keep-site`; it holds a web game in `site\/`, an Unreal Engine project at its root/,
    );
    const lead = leadBrief({
      engine: CLAUDE,
      project: "/games/keep/unreal/Keep.uproject",
      goal: "g",
      title: "Keep",
      template: "",
      templateKind: TemplateKind.ThirdPerson,
      minutes: 60,
      cpp: false,
      offers: { blender: false, genex: false },
      references: [],
      handover: "",
      notes: "",
    });
    assert.match(lead, IDENTITY);
    assert.match(lead, /an Unreal Engine project/);
  });
});

/** A director's run and one of its builders, as the briefs read them. */
const RUN = { runId: "run_w", project: NAME, goal: "a keep to explore", engine: CLAUDE };
const BUILDER = { id: "w1", title: "The gate", brief: "build the gate", owns: ["src/gate.js"], ownsMain: false };
/** What the run found the game's folder holds, and where it is. */
const LOOP_RUN = { run: RUN, projectDir: "/Users/me/AI Games/keep", gameFacts: [fact(CoreFact.WebGame)] };
/** Where a brief says the game is, as the run found it. */
const FOLDER = /^You are working inside Genex[^\n]*folder `AI Games\/keep`; it holds a web game at its root/;

/** A facet builder's opening prompt: a director's (its `identity` option) or a classic Autopilot's (none). */
function facetOpening(options: Record<string, unknown>): string {
  const spec = { id: "gate", title: "The gate", intent: "a stone gate", owns: ["src/gate.js"], checks: [], done: [] };
  const loop = {
    run: RUN,
    spec,
    options,
    game: null,
    gapHistory: [],
    legacy: false,
    ownShape: false,
    ownsMain: false,
    result: { attempts: [] },
    shape: null,
    worktree: "/w",
    board: {},
    lastFailure: null,
    loseStreak: 0,
    defectList: [],
    integrationNote: null,
    currentMove: null,
  };
  const round = {
    iteration: 1,
    briefFile: null,
    userSteering: [],
    acceptedShots: [],
    spikeText: null,
    promptImages: [],
  };
  return facetPromptFor(loop as never, round as never, { resumed: false });
}

describe("every worker's brief", () => {
  it("every worker's brief opens with Genex's identity: the pool's, the director's single and conflict workers, the Unreal lead's agents", () => {
    const pooled = workerBrief({
      identity: { folderLabel: "AI Games/keep", facts: [fact(CoreFact.WebGame)] as never },
      task: "read the level",
      isolation: WorkerIsolation.Read,
      research: false,
      typeDescription: null,
      inputs: [],
    });
    assert.match(pooled, FOLDER, "the pool's");
    assert.doesNotMatch(pooled, /editor is the lead's alone/, "a web game has no engine's editor");
    const onUnreal = workerBrief({
      identity: { folderLabel: "AI Games/keep", facts: [fact(CoreFact.UnrealProject)] as never },
      task: "write the gate's logic",
      isolation: WorkerIsolation.Copy,
      research: false,
      typeDescription: null,
      inputs: [],
    });
    assert.match(onUnreal, /The game engine's editor is the lead's alone: you have none of its tools/);

    const single = singleWorkerBrief({
      run: RUN,
      worker: BUILDER,
      facts: LOOP_RUN.gameFacts,
      gameFolder: LOOP_RUN.projectDir,
    } as never);
    assert.match(single, FOLDER, "the director's single worker");
    assert.match(single, /YOUR BRIEF FROM THE DIRECTOR — The gate:\nbuild the gate/, "and its brief follows");
    const conflict = CONFLICT_WORDS.brief({
      of: "w1",
      title: "The gate",
      commit: "a".repeat(40),
      conflicts: ["src/gate.js"],
    });
    const merging = singleWorkerBrief({
      run: RUN,
      worker: { ...BUILDER, id: "w1-merge", title: "Merge The gate", brief: conflict },
      facts: [fact(CoreFact.WebGame, "site"), fact(CoreFact.UnrealProject)],
      gameFolder: LOOP_RUN.projectDir,
    } as never);
    assert.match(
      merging,
      /^You are working inside Genex[^\n]*it holds a web game in `site\/`, an Unreal Engine project at its root/,
    );
    assert.ok(merging.includes(conflict), "the conflict worker's");
    // A kept older caller that names no folder still opens with it: the run's game, a web game at its root.
    assert.match(
      singleWorkerBrief({ run: RUN, worker: BUILDER } as never),
      /^You are working inside Genex[^\n]*`keep`; it holds a web game/,
    );

    const director = runIdentity(LOOP_RUN as never);
    assert.match(director, FOLDER);
    const facet = facetOpening({ identity: director, worker: { id: "w2", title: "The hall", runId: RUN.runId } });
    assert.ok(facet.startsWith(`${director}\n\n`), "a director's facet builder");
    assert.match(facet, /You are building ONE FACET/);

    const agent = agentBrief({
      kind: AgentKind.Texture,
      title: "Stone texture",
      brief: "a mossy stone",
      game: "Keep",
      folder: "assets/agents/a1",
      cppFolder: null,
      inputs: [],
      engine: CLAUDE,
      folderLabel: "AI Games/keep",
    });
    assert.match(
      agent,
      /^You are working inside Genex[^\n]*folder `AI Games\/keep`; it holds an Unreal Engine project at its root/,
    );
    assert.match(agent, /You are a worker of the Unreal Loop/);
  });

  it("a lead's brief names the plugin search and its card; a worker's names the search only", () => {
    const now = Date.now();
    const director = directorBrief({
      run: RUN,
      softDeadline: now + 1,
      finalDeadline: now + 2,
      integrationWorktree: "/w",
      baseCommit: null,
    } as never);
    assert.match(director, /plugins_find; plugins_suggest shows the person its card/);
    const lead = leadBrief({
      engine: CLAUDE,
      project: "/games/keep/unreal/Keep.uproject",
      goal: "g",
      title: "Keep",
      template: "",
      templateKind: TemplateKind.ThirdPerson,
      minutes: 60,
      cpp: false,
      offers: { blender: false, genex: false },
      references: [],
      handover: "",
      notes: "",
    });
    assert.ok(lead.includes(PLUGINS_FIND) && lead.includes(PLUGINS_SUGGEST), "the Unreal lead's");
    const worker = workerBrief({
      identity: { folderLabel: "AI Games/keep", facts: [] },
      task: "read the level",
      isolation: WorkerIsolation.Read,
      research: false,
      typeDescription: null,
      inputs: [],
    });
    assert.match(worker, /plugins_find/);
    assert.match(worker, /only the lead shows the person a plugin's card/);
    assert.doesNotMatch(worker, /plugins_suggest/);
  });

  it("a classic Autopilot's builders keep their brief", () => {
    const facet = facetOpening({});
    assert.match(facet, /^You are building ONE FACET/, "a facet builder of a classic run");
    assert.doesNotMatch(facet, /inside Genex/);
    const base = baseBrief({ run: RUN, plan: { facets: [], integrationNotes: "" }, projectLabel: NAME } as never);
    assert.doesNotMatch(base, /inside Genex/, "the base builder of a classic run");
  });
});
