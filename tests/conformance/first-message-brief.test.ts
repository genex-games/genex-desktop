/**
 * What a builder is handed on a project's first message, from the folder's facts; Genex never reads
 * the person's words to decide. The words go as written; Genex's context is the session's system
 * text, the same whatever the folder holds: who runs it (Genex, the folder, what a Genex plugin is),
 * never the folder's kinds, which a turn can change while a resumed session keeps the text it started
 * with. A folder with no kind yet is handed the question card, with or without a plugin on, and
 * what the session records with it is asked; the kind tools, `start_web_game` and `plugins_find` are
 * its tools, never restated in words.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { WorkerIsolation } from "../../src/harness-seed/loop/workers/contract.ts";
import { workerBrief } from "../../src/harness-seed/loop/workers/prompts.ts";
import { CoreFact } from "../../src/harness-seed/loop/folder-facts.ts";
import { GameEngine } from "../../src/harness-seed/loop/game-engine.ts";
import { RunEvent } from "../../src/harness-seed/loop/run-events.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

/** What every Auto chat is handed (flipped from none): the Loop's start, for a Loop asked for in words. */
const AUTO_LOOP = "start_autopilot";

const CLAUDE = "claude-code";
const ASK = "make a castle exploration game";
const NAME = "keep";
/** The words every context opens with: where it runs, and what a plugin is there. */
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

const UNREAL_KIND = { plugin: "unreal", name: "Unreal Engine", tool: "unreal__new-game", makes: ["unreal-project"] };
const UNREAL_ON = { tools: [], kinds: [UNREAL_KIND] };
const NONE_ON = { tools: [], kinds: [] };

/** What a turn may differ by: the chat's messages so far, the turn's own fields, the builder's answer. */
interface TurnShape {
  messages?: unknown[];
  turn?: Record<string, unknown>;
  answer?: Record<string, unknown>;
}

/** One delegated chat turn on the game: its first message (unless `shape` says otherwise), the plugin kinds the host offers. */
async function firstMessage(
  descriptor: unknown,
  plugins: { tools: unknown[]; kinds: unknown[] },
  shape: TurnShape = {},
) {
  const recorder = ctxRecorder({
    unknown: { value: null },
    handlers: {
      "events.messages": () => shape.messages ?? [{ role: "user", content: ASK }],
      "game.contentStamp": () => ({ all: null, source: null }),
      "game.list": () => [descriptor],
      "plugins.tools": () => ({ ...plugins, guidance: "", revision: 1 }),
      "engine.describe": () => [],
      "preview.ready": () => ({ ready: false }),
      "engine.delegate": () => ({
        ok: true,
        engine: CLAUDE,
        turns: 1,
        usage: {},
        sessionId: "s",
        summary: "ok",
        ...shape.answer,
      }),
    },
  });
  const turn = {
    threadId: "t1",
    turnId: "turn-1",
    text: ASK,
    engine: CLAUDE,
    engineLabel: "Claude Code",
    project: NAME,
    ...shape.turn,
  };
  await runDelegatedTurn(recorder.ctx as never, turn as never);
  const [delegated] = recorder.paramsOf("engine.delegate");
  assert.ok(delegated, "the ask reached the builder");
  const appended = recorder
    .paramsOf("turn.append")
    .flatMap((p) => (p.batch as Array<{ event_type?: string; payload?: { text?: string; question?: string } }>) ?? []);
  const handoff = appended.find((event) => event.event_type === RunEvent.ContractorHandoff);
  return {
    prompt: String(delegated.prompt),
    system: String(delegated.system),
    bridged: (delegated.interviewTools as Array<{ name: string }> | undefined)?.map((t) => t.name) ?? [],
    capture: Boolean(delegated.selfCapture),
    validated: recorder.sequence("game.validate").length > 0,
    handoffText: String(handoff?.payload?.text ?? ""),
    questions: appended
      .filter((event) => event.event_type === RunEvent.InterviewQuestion)
      .map((event) => event.payload?.question),
  };
}

describe("the first message on a project with no kind", () => {
  // Flipped: the brief told it to start web with start_web_game or find a plugin, and asked web or
  // an engine in words with the card. The words go alone. Flipped again: the card was bridged only
  // while kinds were on offer; a new game's questions (how it feels, how it is seen) need no plugin.
  it("reads the words alone; the card is bridged whether or not a plugin on offers a kind", async () => {
    const none = await firstMessage(game([]), NONE_ON);
    assert.equal(none.prompt, ASK);
    assert.deepEqual(none.bridged, [AUTO_LOOP, "ask_user"], "the question card, with no plugin on");
    assert.equal(none.capture, true, "served as a web game until it picks");
    const on = await firstMessage(game([]), UNREAL_ON);
    assert.equal(on.prompt, ASK);
    assert.deepEqual(on.bridged, [AUTO_LOOP, "ask_user"]);
    assert.equal(on.capture, true, "still a web game until the session picks");
    for (const told of [none.system, on.system])
      assert.doesNotMatch(told, /start_web_game|plugins_find|unreal__new-game|THE ENGINE/, "its tools say it");
  });

  it("the question the session records is shown as the question card, not reported as a build", async () => {
    const question = {
      question: "Build it for the web or in Unreal Engine?",
      options: "Web (Three.js)\nUnreal Engine",
    };
    const { questions } = await firstMessage(game([]), UNREAL_ON, {
      answer: { studioToolCalls: [{ name: "ask_user", args: question }] },
    });
    assert.deepEqual(questions, [question.question]);
  });

  it("keeps the card on a resumed session and a later message while the folder has no kind, never on a run's own turn", async () => {
    const turns: Record<string, [TurnShape, string[]]> = {
      "a resumed session": [{ turn: { resume: "session-1" } }, [AUTO_LOOP, "ask_user"]],
      "a run's own turn": [{ turn: { runId: "run-1" } }, []],
      "a later message, after a greeting": [
        {
          messages: [
            { role: "user", content: "hi" },
            { role: "assistant", content: "Hello! What shall we make?" },
            { role: "user", content: ASK },
          ],
        },
        [AUTO_LOOP, "ask_user"],
      ],
    };
    for (const [label, [shape, expected]] of Object.entries(turns)) {
      const { bridged, prompt } = await firstMessage(game([]), UNREAL_ON, shape);
      assert.deepEqual(bridged, expected, label);
      if (!shape.turn?.runId) assert.equal(prompt, ASK, `${label}: the words alone`);
    }
  });

  it("a folder of its own files of a kind no rule knows gets no card", async () => {
    for (const plugins of [NONE_ON, UNREAL_ON]) {
      const { bridged } = await firstMessage(game([], { holds: "own-files" }), plugins);
      assert.deepEqual(bridged, [AUTO_LOOP], "no question card: it has a kind, just not one Genex knows");
    }
  });

  it("a project that has a kind gets no card, and only a web game is captured as a page", async () => {
    const kinds: Record<string, unknown[]> = {
      web: [fact(CoreFact.WebGame)],
      unreal: [fact(CoreFact.UnrealProject, "unreal", "link")],
      godot: [fact(CoreFact.GodotProject)],
    };
    const linked = { engine: { kind: GameEngine.Unreal, project: "/games/keep/unreal/Keep.uproject", linkedAt: "" } };
    for (const [label, facts] of Object.entries(kinds)) {
      const { bridged, capture } = await firstMessage(game(facts, label === "unreal" ? linked : {}), UNREAL_ON);
      assert.deepEqual(bridged, [AUTO_LOOP], label);
      assert.equal(capture, label === "web", `${label}: captured as a page`);
    }
  });
});

describe("the context, whatever the folder holds", () => {
  // Flipped: the context named what the folder holds and Genex's line of each kind (the build it runs
  // before every preview, a plugin's web build, where a linked project's work lands). A resumed
  // session keeps the system text it started with, so it is the same text for every folder: the
  // game's own CLAUDE.md and its plugins' guidance say those, and Genex's line says a new kind.
  it("is the same text for every folder: it names the folder and never what it holds", async () => {
    const folders: Record<string, unknown> = {
      "no kind yet": game([]),
      notes: game([], { holds: "notes" }),
      "own files": game([], { holds: "own-files" }),
      unreadable: game([], { holds: "unreadable" }),
      "a web game in its own shape": game([fact(CoreFact.WebGame)], {
        built: true,
        shape: { own: true, build: "npm run build" },
      }),
      "a Godot project with its web build": game([
        fact(CoreFact.GodotProject, "godot"),
        fact(CoreFact.WebGame, "web"),
        fact("godot-web-export", "web", "plugin:godot"),
      ]),
      "a linked Godot project outside the folder": game(
        [fact(CoreFact.GodotProject, "/Users/me/Documents/Godot Projects/Void", "link")],
        {
          engine: {
            kind: GameEngine.Godot,
            project: "/Users/me/Documents/Godot Projects/Void/project.godot",
            linkedAt: "",
          },
        },
      ),
      "an Unreal project not linked yet": game([fact(CoreFact.UnrealProject, "unreal")]),
      "a plugin's kind": game([fact("toy-project", ".", "plugin:toy-engine")]),
    };
    const systems = new Map<string, string>();
    for (const [label, descriptor] of Object.entries(folders)) {
      const { system } = await firstMessage(descriptor, NONE_ON);
      assert.match(system, IDENTITY, label);
      assert.match(system, /folder `games\/keep`/, label);
      assert.doesNotMatch(system, /it holds|not picked yet|lands in|web build|before every preview|not linked/, label);
      systems.set(label, system);
    }
    assert.equal(new Set(systems.values()).size, 1, "one text for every folder");
  });

  it("a Godot folder's builder gets no web capture, no contract check and no preview words", async () => {
    const godot = game([fact(CoreFact.GodotProject)], { built: true, shape: { own: true } });
    const { system, capture, validated, handoffText } = await firstMessage(godot, NONE_ON);
    assert.equal(capture, false, "no web capture");
    assert.equal(validated, false, "no page contract check");
    assert.doesNotMatch(handoffText, /preview/);
    assert.doesNotMatch(system, /window\.__studio|checkpoint/);
  });

  it("a Godot game set up for Genex's play gets the window its computer tool drives, and no web page's checks", async () => {
    const bridge = { own: true, runtime: "bridge", play: { command: "bin/play", args: [] } };
    const godot = game([fact(CoreFact.GodotProject, "godot")], { built: true, shape: bridge });
    const { capture, validated } = await firstMessage(godot, NONE_ON);
    assert.equal(capture, true, "a window of the game, which it plays through bin/play");
    assert.equal(validated, false, "no page contract check");
    const declaredOnly = game([fact(CoreFact.GodotProject, "godot")], {
      built: true,
      shape: { own: true, runtime: "bridge" },
    });
    assert.equal((await firstMessage(declaredOnly, NONE_ON)).capture, false, "no play command, nothing to start");
  });

  it("a folder of a kind Genex doesn't know is served as no web game: no web capture or contract check", async () => {
    for (const holds of ["own-files", "unreadable"]) {
      const { capture, validated, handoffText } = await firstMessage(game([], { holds }), NONE_ON);
      assert.equal(capture, false, `${holds}: no web capture`);
      assert.equal(validated, false, `${holds}: no page contract check`);
      assert.doesNotMatch(handoffText, /preview/, holds);
    }
  });
});

// Flipped: a web lead's brief said it runs inside Genex and named the plugin search and its card
// ("PLUGINS: … plugins_find; plugins_suggest shows the person its card"); the lead is the chat's own
// session, whose system text and tools say both (one-loop.test.ts "its first message is one Genex line").
describe("every worker's brief", () => {
  it("a worker's names the plugin search only", () => {
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
