/**
 * Which engine a new game builds in. With the Unreal plugin on, a chat's first build of a game with no
 * kind yet first asks the user one question with the question card: the web or Unreal Engine, unless
 * the ask already named one. The web answer starts Genex's web starter (`start_web_game`); Unreal
 * goes through the plugin's `new-game` tool. With the plugin off nothing about Unreal reaches the
 * brief, and a game that has a kind is never asked. The signal is typed (`handoff.scaffolded`, the
 * host's facts for the folder, the kinds the host lists while the plugin is on); the words live in
 * `loop/unreal-prompts.ts`.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildContractorBrief } from "../../src/harness-seed/loop/chat-session.ts";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { GameEngine } from "../../src/harness-seed/loop/game-engine.ts";
import { toolCall } from "../../src/harness-seed/loop/model-roles.ts";
import { RunEvent } from "../../src/harness-seed/loop/run-events.ts";
import {
  engineChoiceRule,
  offersUnrealGame,
  UNREAL_NEW_GAME_TOOL,
} from "../../src/harness-seed/loop/unreal-prompts.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

const CLAUDE = "claude-code";
const CODEX = "codex";
const ENGINES = [CLAUDE, CODEX, undefined];
const ASK = "make a rally racing game";
const PROJECT = "/Users/me/AI Games/rally/unreal/Rally.uproject";
const SHAPE = { entry: "index.html", main: "src/main.js", build: null };
const LAUNCH = { toolName: "start_unattended_run", hours: 2, frameCount: 0, project: "rally" };
/** The Unreal plugin's kind, as the host lists it while the plugin is on. */
const UNREAL_KIND = { plugin: "unreal", name: "Unreal Editor", tool: UNREAL_NEW_GAME_TOOL, makes: ["unreal-project"] };

/** What a web brief varies by: the engine reading it, fresh or not, own shape, Loop, follow-up, resumed. */
const WEB_BRIEF_AXES: Record<string, readonly unknown[]> = {
  engine: ENGINES,
  scaffolded: [false, true],
  ownShape: [false, true],
  launch: [null, LAUNCH],
  messages: [[], [{ role: "user", content: "make pong" }]],
  resume: [false, true],
};

/** Every web brief shape a chat writes: each combination of the axes. */
function webBriefs(): Array<Parameters<typeof buildContractorBrief>[0]> {
  const base: Record<string, unknown> = { ask: "add fog", shape: SHAPE };
  return Object.entries(WEB_BRIEF_AXES).reduce(
    (all, [axis, values]) => all.flatMap((options) => values.map((value) => ({ ...options, [axis]: value }))),
    [base],
  );
}

const lines = (brief: string) => brief.split("\n");

describe("the engine question in a chat's brief", () => {
  it("a kind offered in its plugin's own words still names its tool the way this session calls it", () => {
    const note = `Offer "Unreal Engine"; when the answer is Unreal Engine, call ${UNREAL_NEW_GAME_TOOL} with a template and a name.`;
    for (const engine of [CLAUDE, CODEX]) {
      for (const ready of [true, false]) {
        const rule = engineChoiceRule(engine, null, [{ ...UNREAL_KIND, ready, note }]);
        assert.ok(rule.includes(note), `${engine}: the plugin's words`);
        assert.ok(rule.includes(toolCall(engine, UNREAL_NEW_GAME_TOOL)), `${engine}, ready ${ready}: its spelling`);
      }
    }
  });

  it("offers a plugin's kind tool that answers its readiness before another, even when the answer was late", () => {
    const switcher = { ...UNREAL_KIND, tool: "unreal__use-project" };
    // A late answer: neither kind carries `ready`; the host lists the kind that asks first.
    const late = engineChoiceRule(CLAUDE, null, [{ ...UNREAL_KIND, asksReady: true }, switcher]);
    assert.ok(late.includes(toolCall(CLAUDE, UNREAL_NEW_GAME_TOOL)), late);
    assert.ok(!late.includes("unreal__use-project"), "never the tool that switches to an existing project");
    const reversed = engineChoiceRule(CLAUDE, null, [switcher, { ...UNREAL_KIND, asksReady: true }]);
    assert.ok(reversed.includes(toolCall(CLAUDE, UNREAL_NEW_GAME_TOOL)), reversed);
    assert.ok(!reversed.includes("unreal__use-project"));
  });

  it("a web brief is byte for byte the brief it was without the question", () => {
    for (const options of webBriefs())
      assert.equal(buildContractorBrief({ ...options, engineChoice: false }), buildContractorBrief(options));
  });

  it("a fresh web game asks web or Unreal first, naming both tools the way this session calls them", () => {
    for (const engine of ENGINES) {
      const brief = buildContractorBrief({
        ask: ASK,
        scaffolded: true,
        engine,
        engineChoice: true,
        kinds: [UNREAL_KIND],
      });
      const rule = engineChoiceRule(engine, null, [UNREAL_KIND]);
      assert.ok(lines(brief).includes(rule), `the rule is a line of the ${engine ?? "local"} brief`);
      assert.ok(rule.includes(toolCall(engine, "ask_user")), "it asks with the question card");
      assert.ok(rule.includes(toolCall(engine, UNREAL_NEW_GAME_TOOL)), "Unreal goes through the plugin's new-game");
      const rest = buildContractorBrief({ ask: ASK, scaffolded: true, engine });
      assert.deepEqual(
        lines(brief).filter((line) => line !== rule),
        lines(rest),
        "the rest of the brief is the web brief",
      );
    }
    assert.ok(
      !engineChoiceRule(CLAUDE, null, [UNREAL_KIND]).includes("tool.mjs"),
      "a Claude session is never told to run the bridge",
    );
    assert.ok(
      !engineChoiceRule(CODEX, null, [UNREAL_KIND]).includes("mcp__"),
      "a Codex session is never told an mcp__ name",
    );
    assert.equal(engineChoiceRule(CLAUDE), "", "no kind on offer: no question");
  });

  it("is never in an Unreal game's brief, nor in a resumed session's pickup", () => {
    for (const engine of ENGINES) {
      const rule = engineChoiceRule(engine, null, [UNREAL_KIND]);
      const unreal = buildContractorBrief({
        ask: ASK,
        engine,
        gameEngine: GameEngine.Unreal,
        engineProject: PROJECT,
        engineChoice: true,
      });
      assert.ok(!lines(unreal).includes(rule));
      const resumed = buildContractorBrief({ ask: ASK, scaffolded: true, resume: true, engine, engineChoice: true });
      assert.ok(!lines(resumed).includes(rule));
    }
  });

  it("an Unreal game's brief carries no web checkpoint line: the Reload it lights is the web preview's", () => {
    for (const engine of [CLAUDE, CODEX]) {
      const checkpoint = toolCall(engine, "checkpoint");
      const web = buildContractorBrief({ ask: ASK, scaffolded: true, engine });
      assert.ok(web.includes(checkpoint), "a web game keeps it");
      const unreal = buildContractorBrief({ ask: ASK, engine, gameEngine: GameEngine.Unreal, engineProject: PROJECT });
      assert.ok(!unreal.includes(checkpoint));
    }
  });

  it("the seed reads a new Unreal game as offered only from the plugin's own tool name", () => {
    assert.equal(offersUnrealGame([{ name: UNREAL_NEW_GAME_TOOL }]), true);
    for (const tools of [null, undefined, [], [{ name: "unreal__use-project" }], [{ name: "new-game" }]])
      assert.equal(offersUnrealGame(tools as never), false, JSON.stringify(tools));
  });
});

/** A descriptor as `game.list` answers it. */
function game(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    title: name,
    dir: `/games/${name}`,
    shape: { ...SHAPE, own: false, kind: "studio-template" },
    built: false,
    ...extra,
  };
}
const NEW_GAME_TOOL = { name: UNREAL_NEW_GAME_TOOL, description: "Make the game's Unreal project.", parameters: {} };
const OTHER_TOOL = { name: "blender__model", description: "Model with Blender.", parameters: {} };

/**
 * A delegated chat turn: the games the host lists, the plugin tools it serves, the builder's answer,
 * the chat's messages so far, and the content stamp the game's folder has now.
 */
function chatTurn(options: {
  games?: unknown[];
  tools?: unknown[];
  answer?: Record<string, unknown>;
  messages?: unknown[];
  stamp?: string;
}) {
  return ctxRecorder({
    unknown: { value: null },
    handlers: {
      "events.messages": () => options.messages ?? [{ role: "user", content: ASK }],
      "game.contentStamp": () => ({ all: options.stamp ?? null, source: options.stamp ?? null }),
      "game.list": () => options.games ?? [],
      "game.scaffold": (p) => game(String(p.name)),
      // While the Unreal plugin is on (its new-game tool served), the host lists its kind.
      "plugins.tools": () => ({
        tools: options.tools ?? [],
        guidance: "",
        revision: 1,
        kinds: offersUnrealGame(options.tools as never) ? [UNREAL_KIND] : [],
      }),
      "engine.describe": () => [],
      // The preview answers at once, so no turn waits out the settle of a studio that cannot.
      "preview.ready": () => ({ ready: false }),
      "engine.delegate": () => ({
        ok: true,
        engine: CLAUDE,
        turns: 1,
        usage: {},
        sessionId: "s",
        summary: "done",
        ...options.answer,
      }),
    },
  });
}
const TURN = { threadId: "thread-1", turnId: "turn-1", text: ASK, engine: CLAUDE, engineLabel: "Claude Code" };
const NEW_CHAT = { ...TURN, newProject: true };

/** What the builder was handed: its prompt, the bridged tools by name, and whether it got the capture tool. */
function handed(recorder: ReturnType<typeof chatTurn>) {
  const [delegated] = recorder.paramsOf("engine.delegate");
  assert.ok(delegated, "the ask reached the builder");
  const bridged = (delegated.interviewTools as Array<{ name: string }> | undefined)?.map((t) => t.name) ?? [];
  return { prompt: String(delegated.prompt), bridged, capture: Boolean(delegated.selfCapture) };
}

describe("a chat turn and the engine question", () => {
  const RULE = engineChoiceRule(CLAUDE, null, [UNREAL_KIND]);

  it("with the Unreal plugin off, a new game's builder hears nothing about Unreal and gets no question card", async () => {
    const recorder = chatTurn({ tools: [OTHER_TOOL] });
    await runDelegatedTurn(recorder.ctx as never, NEW_CHAT);
    const { prompt, bridged } = handed(recorder);
    assert.ok(!lines(prompt).includes(RULE));
    assert.doesNotMatch(prompt, /Unreal/);
    assert.deepEqual(bridged, []);
  });

  it("with it on, a new game's builder asks web or Unreal first, with the question card bridged in", async () => {
    const recorder = chatTurn({ tools: [OTHER_TOOL, NEW_GAME_TOOL] });
    await runDelegatedTurn(recorder.ctx as never, NEW_CHAT);
    const { prompt, bridged, capture } = handed(recorder);
    assert.ok(lines(prompt).includes(RULE));
    assert.deepEqual(bridged, ["ask_user"]);
    assert.equal(capture, true, "it is still a web game until the user chooses");
  });

  it("with Loop on, the same question rides beside the launch, one question card only", async () => {
    const recorder = chatTurn({ tools: [NEW_GAME_TOOL] });
    await runDelegatedTurn(recorder.ctx as never, { ...NEW_CHAT, loop: { hours: 2 } });
    const { prompt, bridged } = handed(recorder);
    assert.ok(lines(prompt).includes(RULE));
    assert.deepEqual(bridged, ["start_unattended_run", "ask_user"]);
  });

  it("a game linked to Unreal is never asked, and its builder gets no web capture", async () => {
    const linked = game("rally", { engine: { kind: GameEngine.Unreal, project: PROJECT, linkedAt: "" } });
    const recorder = chatTurn({ games: [linked], tools: [NEW_GAME_TOOL] });
    await runDelegatedTurn(recorder.ctx as never, { ...TURN, project: "rally" });
    const { prompt, bridged, capture } = handed(recorder);
    assert.ok(!lines(prompt).includes(RULE));
    assert.deepEqual(bridged, []);
    assert.equal(capture, false, "its folder holds notes, not a page to capture");
  });

  it("a web game is never asked, even with the plugin on", async () => {
    const web = { facts: [{ id: "web-game", path: ".", source: "core" }] };
    for (const existing of [
      game("rally", web),
      game("rally", { ...web, built: true, shape: { ...SHAPE, own: true } }),
    ]) {
      const recorder = chatTurn({ games: [existing], tools: [NEW_GAME_TOOL] });
      await runDelegatedTurn(recorder.ctx as never, { ...TURN, project: "rally" });
      const { prompt, bridged, capture } = handed(recorder);
      assert.ok(!lines(prompt).includes(RULE));
      assert.deepEqual(bridged, []);
      assert.equal(capture, true);
    }
  });

  it("the question the builder records in Auto is shown as the question card, not reported as a build", async () => {
    const question = {
      question: "Build it for the web or in Unreal Engine?",
      options: "Web (Three.js)\nUnreal Engine",
    };
    const recorder = chatTurn({
      tools: [NEW_GAME_TOOL],
      answer: { studioToolCalls: [{ name: "ask_user", args: question }] },
    });
    await runDelegatedTurn(recorder.ctx as never, NEW_CHAT);
    const recorded = recorder
      .paramsOf("turn.append")
      .flatMap((p) => (p.batch as Array<{ event_type?: string; payload?: { question?: string } }>) ?? [])
      .filter((event) => event.event_type === RunEvent.InterviewQuestion);
    assert.deepEqual(
      recorded.map((event) => event.payload?.question),
      [question.question],
    );
  });
});

/**
 * New game makes the game before the chat's first ask, as an empty folder with no kind: the turn
 * finds a project that already exists. The host's facts say it has no kind yet (`facts: []`), and
 * the chat's first ask is a chat with no reply, no session and no run; both together ask.
 */
describe("a game the app made before the chat's first ask", () => {
  const RULE = engineChoiceRule(CLAUDE, null, [UNREAL_KIND]);
  const PENDING = { facts: [] };
  const madeGame = (extra: Record<string, unknown> = {}) => game("made-game", { ...PENDING, ...extra });
  const ON_ITS_GAME = { ...TURN, project: "made-game" };

  /** The builder's brief and bridged tools for one turn on the app-made game. */
  async function turnOn(options: Parameters<typeof chatTurn>[0], turn: Record<string, unknown> = ON_ITS_GAME) {
    const recorder = chatTurn({ games: [madeGame()], tools: [NEW_GAME_TOOL], ...options });
    await runDelegatedTurn(recorder.ctx as never, turn as never);
    return handed(recorder);
  }

  it("with nothing built in it and the plugin on, the chat's first build asks web or Unreal first", async () => {
    const { prompt, bridged, capture } = await turnOn({});
    assert.ok(lines(prompt).includes(RULE));
    assert.deepEqual(bridged, ["ask_user"]);
    assert.equal(capture, true, "it is still a web game until the user chooses");
  });

  it("with Loop on, the same question rides beside the launch", async () => {
    const { prompt, bridged } = await turnOn({}, { ...ON_ITS_GAME, loop: { hours: 2 } });
    assert.ok(lines(prompt).includes(RULE));
    assert.deepEqual(bridged, ["start_unattended_run", "ask_user"]);
  });

  it("is never asked once it has a kind, the game is linked to Unreal, or the plugin is off", async () => {
    const linked = madeGame({
      engine: { kind: GameEngine.Unreal, project: PROJECT, linkedAt: "" },
      facts: [{ id: "unreal-project", path: ".", source: "link" }],
    });
    const cases: Record<string, Parameters<typeof chatTurn>[0]> = {
      "a web game since it was made": { games: [madeGame({ facts: [{ id: "web-game", path: ".", source: "core" }] })] },
      "a descriptor from a host that lists no facts": { games: [game("made-game")] },
      "linked to Unreal": { games: [linked] },
      "the plugin off": { tools: [OTHER_TOOL] },
    };
    for (const [label, options] of Object.entries(cases)) {
      const { prompt, bridged } = await turnOn(options);
      assert.ok(!lines(prompt).includes(RULE), label);
      assert.deepEqual(bridged, [], label);
    }
  });

  it("is never asked on a resumed session or a run's own turn, and asked again on a later message while the folder has no kind", async () => {
    const turns: Record<string, [Parameters<typeof chatTurn>[0], Record<string, unknown>]> = {
      "a resumed session": [{}, { ...ON_ITS_GAME, resume: "session-1" }],
      "a run's own turn": [{}, { ...ON_ITS_GAME, runId: "run-1" }],
    };
    for (const [label, [options, turn]] of Object.entries(turns)) {
      const { prompt, bridged } = await turnOn(options, turn);
      assert.ok(!lines(prompt).includes(RULE), label);
      assert.deepEqual(bridged, [], label);
    }
    // A greeting first never loses the card: the folder still has no kind, so a fresh brief asks.
    const replied = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello! What shall we make?" },
      { role: "user", content: ASK },
    ];
    const later = await turnOn({ messages: replied }, ON_ITS_GAME);
    assert.ok(lines(later.prompt).includes(RULE), "a later message");
    assert.deepEqual(later.bridged, ["ask_user"], "a later message");
  });
});

/**
 * The turn that answers the engine question may link the game to Unreal: its end looks at the game
 * as the host lists it then, read again, so a folder that now holds an Unreal project gets no web
 * preview load, no "fix the black screen" and no failed `build_observation`. A host that cannot
 * answer leaves the game the turn started with.
 */
describe("the end of a turn whose game was linked to Unreal during it", () => {
  const NAME = "rally-circuit";
  const BLACK = "black canvas: 0.00% of pixels above luma 8 (mean 0.0)";
  const REPORT = "Made the Unreal project.";
  const WEB = game(NAME, { facts: [{ id: "web-game", path: ".", source: "core" }] });
  const UNREAL = game(NAME, {
    engine: { kind: GameEngine.Unreal, project: PROJECT, linkedAt: "" },
    facts: [{ id: "unreal-project", path: "unreal", source: "link" }],
  });
  const QUESTION = { studioToolCalls: [{ name: "ask_user", args: { question: "A night track too?" } }] };

  /**
   * One turn on the game: its engine read answers `before` until the builder has run and `after`
   * once it has (a throwing `after` is a host that cannot answer); the preview shows a black canvas.
   */
  async function turnOn(before: unknown, after: unknown, turn: Record<string, unknown> = {}, answer = {}) {
    let built = false;
    const recorder = chatTurn({});
    recorder.handle("game.list", () => {
      if (!built) return [before];
      if (after instanceof Error) throw after;
      return [after];
    });
    recorder.handle("engine.delegate", () => {
      built = true;
      return { ok: true, engine: CLAUDE, turns: 1, usage: {}, sessionId: "s", summary: REPORT, ...answer };
    });
    recorder.handle("preview.load", () => true);
    recorder.handle("preview.ready", () => ({ ready: true, ms: 5 }));
    recorder.handle("preview.status", () => ({ loadError: null }));
    recorder.handle("preview.console", () => []);
    recorder.handle("preview.observe", () => ({ ok: false, reasons: [BLACK] }));
    await runDelegatedTurn(recorder.ctx as never, { ...TURN, text: "Unreal Engine", project: NAME, ...turn } as never);
    const observations = recorder
      .paramsOf("turn.append")
      .flatMap((p) => (p.batch as Array<{ event_type?: string }>) ?? [])
      .filter((event) => event.event_type === RunEvent.BuildObservation);
    const said = recorder.notifications
      .filter((n) => n.type === "chat.message")
      .map((n) => String((n.payload as { content?: unknown }).content))
      .join("\n");
    return { previewCalls: recorder.sequence("preview."), observations: observations.length, said };
  }

  it("a game linked to Unreal by the turn gets no preview load, no build_observation and no black-screen line", async () => {
    const cases: Record<string, [Record<string, unknown>, Record<string, unknown>]> = {
      "its report": [{}, {}],
      "a Loop question beside it": [{ loop: { hours: 2 } }, QUESTION],
    };
    for (const [label, [turn, answer]] of Object.entries(cases)) {
      const { previewCalls, observations, said } = await turnOn(WEB, UNREAL, turn, answer);
      assert.deepEqual(previewCalls, [], label);
      assert.equal(observations, 0, label);
      assert.doesNotMatch(said, /black screen|loads clean|console error/, label);
      assert.ok(said.includes(REPORT), `${label}: the builder's report still reaches the chat`);
    }
  });

  it("a web game is still checked, and a game linked before the turn still is not", async () => {
    const web = await turnOn(WEB, WEB);
    assert.equal(web.previewCalls[0], "preview.load");
    assert.equal(web.observations, 1);
    assert.match(web.said, /fix the black screen/);
    const unreal = await turnOn(UNREAL, UNREAL);
    assert.deepEqual(unreal.previewCalls, []);
    assert.equal(unreal.observations, 0);
  });

  it("a host that cannot read the game again leaves the engine the turn started with", async () => {
    const web = await turnOn(WEB, new Error("game.list failed"));
    assert.equal(web.previewCalls[0], "preview.load");
    assert.equal(web.observations, 1);
    const unreal = await turnOn(UNREAL, new Error("game.list failed"));
    assert.deepEqual(unreal.previewCalls, []);
    assert.equal(unreal.observations, 0);
  });
});
