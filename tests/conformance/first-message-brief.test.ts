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
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { GameEngine } from "../../src/harness-seed/loop/game-engine.ts";
import { buildContractorBrief } from "../../src/harness-seed/loop/chat-session.ts";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { directorBrief } from "../../src/harness-seed/loop/director/briefs.ts";
import { WorkerIsolation } from "../../src/harness-seed/loop/workers/contract.ts";
import { workerBrief } from "../../src/harness-seed/loop/workers/prompts.ts";
import { CoreFact } from "../../src/harness-seed/loop/folder-facts.ts";
import { toolCall } from "../../src/harness-seed/loop/model-roles.ts";
import { RunEvent } from "../../src/harness-seed/loop/run-events.ts";
import { leadBrief } from "../../src/harness-seed/loop/unreal/lead-prompts.ts";
import { TemplateKind } from "../../src/harness-seed/loop/unreal/template-kind.ts";
import { engineChoiceRule, UNREAL_NEW_GAME_TOOL } from "../../src/harness-seed/loop/unreal-prompts.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

/** What every Auto chat is handed (flipped from none): the Loop's start, for a Loop asked for in words. */
const AUTO_LOOP = "start_autopilot";

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
const GODOT_KIND = { plugin: "godot", name: "Godot", tool: "godot__new-game", makes: ["godot-project"] };
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
    assert.deepEqual(bridged, [AUTO_LOOP], "no question card");
    assert.equal(capture, true, "served as a web game until it picks");
    assert.match(prompt, /folder is empty: there is nothing to inspect yet/);
  });

  it("with an engine plugin on, the first message on a project with no kind asks with the card, and web still starts with start_web_game", async () => {
    const { lines, prompt, bridged } = await firstMessage(game([]), UNREAL_ON);
    assert.ok(lines.includes(engineChoiceRule(CLAUDE, null, [UNREAL_KIND])), "the engine question, as its own line");
    assert.deepEqual(bridged, [AUTO_LOOP, "ask_user"]);
    assert.ok(prompt.includes(START_WEB_GAME), "the web answer starts the web starter");
    const both = await firstMessage(game([]), { tools: [NEW_GAME_TOOL], kinds: [UNREAL_KIND, TOY_KIND] });
    assert.ok(both.prompt.includes('"Toy Engine"'), "every engine plugin on is an option");
    assert.ok(both.prompt.includes(toolCall(CLAUDE, TOY_KIND.tool)), "with its own kind tool");
    assert.deepEqual(both.bridged, [AUTO_LOOP, "ask_user"]);
  });

  // Flipped: the web answer once carried the starter's harness contract to every kind on offer;
  // the starter's page is now the game's to build, so a folder with no kind hears no web rules.
  it("a project with no kind hears no harness contract for the web answer", async () => {
    for (const on of [NONE_ON, UNREAL_ON]) {
      const { lines } = await firstMessage(game([]), on);
      assert.deepEqual(
        lines.filter((line) => line.includes("window.__studio")),
        [],
      );
    }
  });

  it("a project still with no kind is offered the kinds on every message, not only the chat's first", async () => {
    const later = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello! What shall we make?" },
      { role: "user", content: "make it in Unreal Engine" },
    ];
    const { prompt, bridged } = await firstMessage(game([]), UNREAL_ON, later);
    assert.deepEqual(bridged, [AUTO_LOOP, "ask_user"], "the card is still there after a greeting");
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
      assert.deepEqual(bridged, [AUTO_LOOP], "no question card: it has a kind, just not one Genex knows");
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
      assert.deepEqual(bridged, [AUTO_LOOP], label);
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
    assert.deepEqual(bridged, [AUTO_LOOP]);
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

  it("one of Genex's own kinds that a plugin on makes has that plugin already: nothing to look for", async () => {
    const godot = game([fact(CoreFact.GodotProject, "godot")], { built: true, shape: { own: true } });
    const on = await firstMessage(godot, { tools: [], kinds: [GODOT_KIND] });
    assert.ok(!on.prompt.includes(PLUGINS_FIND), "its plugin is on");
    assert.match(on.prompt, /a Godot project/);
    const off = await firstMessage(godot, { tools: [], kinds: [TOY_KIND] });
    assert.ok(off.prompt.includes(PLUGINS_FIND), "another plugin's kind covers nothing here");
  });

  it("a game linked to a Godot project outside its folder works in that project, its notes in the workspace", () => {
    const brief = buildContractorBrief({
      ask: ASK,
      engine: CLAUDE,
      folderLabel: "AI Games/moon",
      gameEngine: GameEngine.Godot,
      engineProject: "/Users/me/Documents/Godot Projects/Void/project.godot",
      facts: [fact(CoreFact.GodotProject, "/Users/me/Documents/Godot Projects/Void", "link")] as never,
    });
    assert.match(
      brief,
      /The game's work happens in its Godot project in `\/Users\/me\/Documents\/Godot Projects\/Void\/`/,
    );
    assert.match(
      brief,
      /The game's work lands in its Godot project in `[^`]+`; its notes stay in this workspace \(folder `AI Games\/moon`\)/,
    );
    assert.doesNotMatch(brief, /The game's work stays in this workspace/);
  });

  it("a plugin's web build in a folder is said once as a build, never handed the web game's rules", () => {
    const brief = buildContractorBrief({
      ask: ASK,
      engine: CLAUDE,
      facts: [
        fact(CoreFact.GodotProject, "godot"),
        fact(CoreFact.WebGame, "web"),
        fact("godot-web-export", "web", "plugin:godot"),
      ] as never,
    });
    assert.ok(!/serves its index\.html/.test(brief), "no web game's rules for the build");
    assert.match(brief, /The web page in `web\/` is a web build a plugin exports[^\n]*Never edit its files/);
    assert.ok(!brief.includes("godot-web-export"), "the plugin's fact needs no line of its own");
    const site = buildContractorBrief({
      ask: ASK,
      engine: CLAUDE,
      facts: [fact(CoreFact.GodotProject, "godot"), fact(CoreFact.WebGame, "site")] as never,
    });
    assert.ok(/serves its index\.html/.test(site), "a web game no plugin claims keeps its rules");
  });

  it("each kind gets its own rules, named by path when there are two", () => {
    const brief = buildContractorBrief({
      ask: ASK,
      engine: CLAUDE,
      folderLabel: "AI Games/keep",
      facts: [fact(CoreFact.UnrealProject), fact(CoreFact.WebGame, "site")] as never,
    });
    const lines = brief.split("\n");
    const web = lines.filter((line) => line.includes("serves its index.html"));
    assert.ok(web.length > 0, "the web game's rules");
    for (const line of web) assert.ok(line.startsWith("For the web game in `site/`: "), line);
    const unreal = lines.filter((line) => line.includes("the Unreal editor connector's tools"));
    assert.ok(unreal.length > 0, "the Unreal project's rules");
    for (const line of unreal) assert.doesNotMatch(line, /^For the /, line);
    const single = buildContractorBrief({ ask: ASK, engine: CLAUDE, facts: [fact(CoreFact.WebGame)] as never });
    assert.doesNotMatch(single, /^For the /m, "one kind needs no path");
  });

  it("an Unreal project the game is not linked to is never built through the Unreal tools until it is linked", () => {
    const brief = buildContractorBrief({
      ask: ASK,
      engine: CLAUDE,
      folderLabel: "AI Games/keep",
      facts: [fact(CoreFact.UnrealProject, "unreal")] as never,
    });
    assert.doesNotMatch(brief, /built in Unreal Engine, in the user's open Unreal Editor, through the Unreal tools/);
    assert.doesNotMatch(
      brief,
      /Your changes land in the Unreal project/,
      "its changes land nowhere the tools reach yet",
    );
    assert.doesNotMatch(brief, /lands in its Unreal project[^\n]*through the Unreal tools/);
    assert.match(brief, /the project chosen in Genex's Unreal panel/, "the tools work on the panel's project");
    const linkLine = brief.split("\n").find((line) => line.includes("never call them before")) ?? "";
    assert.match(linkLine, /is linked to this game/, "no Unreal call before the link");
    // The harness names no plugin's tool: the plugin's own skill says which one links the project.
    assert.doesNotMatch(brief, /use-project/);
    const manifest = JSON.parse(readFileSync("src/plugins/unreal/plugin.json", "utf8")) as {
      skills: Array<{ name: string; text?: string }>;
    };
    const skill = manifest.skills.find((s) => s.name === "unreal-editor")?.text ?? "";
    assert.match(skill, /unreal__use-project links a project to this game[^\n]*setting it up for Genex first/);
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

  it("a Godot game set up for Genex's play gets the window its computer tool drives, and no web page's checks", async () => {
    const bridge = { own: true, runtime: "bridge", play: { command: "bin/play", args: [] } };
    const godot = game([fact(CoreFact.GodotProject, "godot")], { built: true, shape: bridge });
    const { capture, validated, prompt } = await firstMessage(godot, NONE_ON);
    assert.equal(capture, true, "a window of the game, which it plays through bin/play");
    assert.equal(validated, false, "no page contract check");
    assert.doesNotMatch(prompt, /window\.__studio/);
    const declaredOnly = game([fact(CoreFact.GodotProject, "godot")], {
      built: true,
      shape: { own: true, runtime: "bridge" },
    });
    assert.equal((await firstMessage(declaredOnly, NONE_ON)).capture, false, "no play command, nothing to start");
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

describe("every worker's brief", () => {
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
});
