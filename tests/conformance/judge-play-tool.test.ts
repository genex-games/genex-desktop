/**
 * `judge_play` on the host: what it forwards to the harness, what it records in the chat, and that
 * "verified by the studio" holds only for a trace the studio itself saw reach the goal. On a game
 * played in its engine's editor, the judges its engine plugin declares (the toy engine's crowd and
 * plain): picked by id, briefed, opened with their players and probed once the play opens.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { ChatJudgeResultPayload } from "../../src/shared/chat-judge.ts";
import type { LiveToolResult } from "../../src/shared/engine-requests.ts";
import { type DispatchAction, HarnessCapability } from "../../src/shared/protocol.ts";
import { keepProbePictures } from "../../src/main/core/judge-probe-pictures.ts";
import { type JudgePlayHost, judgePlayFor, runJudgePlay } from "../../src/main/core/judge-play-tool.ts";
import { markVerified } from "../../src/main/core/verified-traces.ts";
import { studioJudgeHost } from "../../src/main/core/judge-play-tool.ts";
import { CONNECTOR_CAPTURES_DIR } from "../../src/shared/mcp.ts";
import { type JudgeRef, PluginSourceKind } from "../../src/shared/plugins.ts";
import type { GameProject } from "../../src/shared/game-project.ts";
import { COMPUTER_TOOL_NAME } from "../../src/substrate/computer-tool.ts";
import { TOY_PLUGIN, TOY_PLUGIN_ID } from "../helpers/project-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { workerChat } from "../helpers/worker-chat.ts";

const CALLER = {
  project: "star-dash",
  threadId: "thread-7",
  root: "/games/star-dash",
  engine: "claude-code",
  model: "sonnet",
} as const;

/** A host with the chat's judge, answering every dispatch with `answer`, recording every line. */
function fakeHost(answer: unknown, options: { capable?: boolean; throws?: Error; judges?: JudgeRef[] } = {}) {
  const sent: DispatchAction[] = [];
  const lines: Array<{ threadId: string; payload: ChatJudgeResultPayload }> = [];
  const host: JudgePlayHost = {
    hasCapability: (capability) => capability === HarnessCapability.ChatJudge && options.capable !== false,
    dispatch: async (action) => {
      sent.push(action);
      if (options.throws) throw options.throws;
      return answer;
    },
    record: async (threadId, payload) => {
      lines.push({ threadId, payload });
    },
    judges: async () => options.judges ?? [],
  };
  return { host, sent, lines };
}

const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);

describe("judge_play on the host", () => {
  it("forwards one question and its goal state to the harness for the chat's game, as the host resolved it", async () => {
    const { host, sent } = fakeHost({
      status: "passed",
      answer: "yes",
      note: "",
      objective: "model-said",
      trace: null,
    });
    await runJudgePlay(
      host,
      { ask: "  Can you reach the star?  ", goal_state: { path: "flow.phase", equals: "won" } },
      CALLER,
    );
    assert.deepEqual(sent, [
      {
        type: "chat_judge",
        threadId: "thread-7",
        project: "star-dash",
        root: "/games/star-dash",
        engine: "claude-code",
        model: "sonnet",
        ask: "Can you reach the star?",
        goalState: '{"path":"flow.phase","equals":"won"}',
      },
    ]);
  });

  it("forwards nothing to a harness without the chat's judge, or for a call with no question", async () => {
    const old = fakeHost({}, { capable: false });
    assert.match(text(await runJudgePlay(old.host, { ask: "Can you win?" }, CALLER)), /not available/);
    const empty = fakeHost({});
    assert.match(text(await runJudgePlay(empty.host, { ask: "  " }, CALLER)), /needs ask/);
    assert.deepEqual([old.sent.length, empty.sent.length, old.lines.length, empty.lines.length], [0, 0, 0, 0]);
  });

  it("keeps 'verified by the studio' only for the trace the studio itself saw reach the goal, once", async () => {
    const trace = `/runs/adhoc/facet_chat-judge/playtest/iter_000/trace-${Date.now()}.jsonl`;
    markVerified(trace, "can-you-reach-the-star");
    const claim = {
      status: "passed",
      answer: "yes",
      note: "Went round the bottom.",
      objective: "studio-verified",
      trace,
    };
    const seen = fakeHost(claim);
    const result = text(await runJudgePlay(seen.host, { ask: "Can you reach the star?" }, CALLER));
    assert.match(result, /verified by the studio/);
    assert.deepEqual(seen.lines, [
      {
        threadId: "thread-7",
        payload: {
          project: "star-dash",
          ask: "Can you reach the star?",
          status: "passed",
          answer: "yes",
          note: "Went round the bottom.",
          objective: "studio-verified",
        },
      },
    ]);
    // The same claim again: the trace vouched once already, so this is the judge's word.
    const again = fakeHost(claim);
    assert.match(text(await runJudgePlay(again.host, { ask: "Can you reach the star?" }, CALLER)), /judge's word/);
    assert.equal(again.lines[0]?.payload.objective, "model-said");
    // A claim on a trace the studio never marked is the judge's word too.
    const forged = fakeHost({ ...claim, trace: "/runs/adhoc/forged.jsonl" });
    await runJudgePlay(forged.host, { ask: "Can you reach the star?" }, CALLER);
    assert.equal(forged.lines[0]?.payload.objective, "model-said");
  });

  it("says why nothing was played, and records that in the chat", async () => {
    const refused = fakeHost({
      status: "incomplete",
      answer: null,
      note: "",
      objective: "model-said",
      trace: null,
      refusal: "No hidden window is free to play in right now.",
    });
    const result = text(await runJudgePlay(refused.host, { ask: "Can you win?" }, CALLER));
    assert.match(result, /did not play: No hidden window/);
    assert.equal(refused.lines[0]?.payload.status, "incomplete");
    assert.equal(refused.lines[0]?.payload.refusal, "No hidden window is free to play in right now.");
  });

  it("answers a failed or unreadable dispatch as an error, and records no outcome it does not have", async () => {
    const failed = fakeHost(null, { throws: new Error("harness restarted") });
    const result = await runJudgePlay(failed.host, { ask: "Can you win?" }, CALLER);
    assert.equal(typeof result === "string" ? false : result.isError, true);
    assert.match(text(result), /harness restarted/);
    const garbled = fakeHost("not an outcome");
    assert.match(text(await runJudgePlay(garbled.host, { ask: "Can you win?" }, CALLER)), /failed/);
    assert.deepEqual([failed.lines.length, garbled.lines.length], [0, 0]);
  });
});

/** The toy engine's two judges, as a toy-linked game's descriptor names them. */
const TOY_JUDGES: JudgeRef[] = [
  { id: "crowd", label: "Crowd" },
  { id: "plain", label: "Plain" },
];
const PLAYED = { status: "passed", answer: "yes", note: "All three moved.", objective: "model-said", trace: null };

describe("judge_play with an engine plugin's judges", () => {
  it("offers a judge to pick only where the game has judges, each by its id and label", () => {
    const [tool] = judgePlayFor(true, true, TOY_JUDGES);
    const judge = tool?.parameters.properties?.judge as { description?: string } | undefined;
    assert.match(String(judge?.description), /crowd \(Crowd\), plain \(Plain\)/);
    const [plain] = judgePlayFor(true, true, []);
    assert.equal(Object.hasOwn(plain?.parameters.properties ?? {}, "judge"), false, "no judges, no judge to pick");
    assert.deepEqual(judgePlayFor(false, true, TOY_JUDGES), [], "never for a session that is not the chat's own");
  });

  it("forwards the judge the session names, as the game's engine declares it", async () => {
    const { host, sent } = fakeHost(PLAYED, { judges: TOY_JUDGES });
    await runJudgePlay(host, { ask: "Does every player see the others move?", judge: " crowd " }, CALLER);
    assert.equal(sent[0]?.type === "chat_judge" ? sent[0].judge : undefined, "crowd");
  });

  it("refuses a judge the game does not have, in plain words, and plays nothing", async () => {
    const unknown = fakeHost(PLAYED, { judges: TOY_JUDGES });
    const result = await runJudgePlay(unknown.host, { ask: "Can you win?", judge: "cheater" }, CALLER);
    assert.equal(typeof result === "string" ? false : result.isError, true);
    assert.match(
      text(result),
      /No judge named "cheater" plays this game\. Its judges: crowd \(Crowd\), plain \(Plain\)\./,
    );
    const none = fakeHost(PLAYED);
    assert.match(text(await runJudgePlay(none.host, { ask: "Can you win?", judge: "crowd" }, CALLER)), /has no judges/);
    assert.deepEqual([unknown.sent.length, none.sent.length, unknown.lines.length, none.lines.length], [0, 0, 0, 0]);
  });

  it("records the judge it played as and its probe's pictures, once, for the trace the studio wrote", async () => {
    const trace = `/runs/adhoc/facet_chat-judge/playtest/iter_000/trace-probe-${Date.now()}.jsonl`;
    const pictures = [".studio/captures/shot_0123456789abcdef0123.jpg"];
    keepProbePictures(trace, pictures);
    const played = fakeHost({ ...PLAYED, trace }, { judges: TOY_JUDGES });
    await runJudgePlay(played.host, { ask: "Does every player see the others move?", judge: "crowd" }, CALLER);
    assert.equal(played.lines[0]?.payload.judge, "Crowd");
    assert.deepEqual(played.lines[0]?.payload.pictures, pictures);
    // The same trace claimed again: its pictures went with the first line.
    const again = fakeHost({ ...PLAYED, trace }, { judges: TOY_JUDGES });
    await runJudgePlay(again.host, { ask: "Does every player see the others move?", judge: "crowd" }, CALLER);
    assert.equal(again.lines[0]?.payload.pictures, undefined);
    // No judge named: a plain line, as before.
    const plain = fakeHost(PLAYED, { judges: TOY_JUDGES });
    await runJudgePlay(plain.host, { ask: "Can you win?" }, CALLER);
    assert.equal(plain.lines[0]?.payload.judge, undefined);
  });
});

/** How long one case may take: a real lite core and the toy engine plugin's backend. */
const CASE_TIMEOUT_MS = 90_000;

/** A `.toyproj` of the game's own, as a linked toy project needs one on disk. */
async function toyProject(name: string): Promise<string> {
  const file = path.join(await realpath(await tmpDir("judge-toyproj-")), name, `${name}.toyproj`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "toy\n");
  return file;
}

/** A chat on a game linked to the toy engine, with the toy plugin installed and on. */
async function toyChat() {
  const chat = await workerChat();
  const { core, game, project } = chat;
  await core.plugins.installLocal(TOY_PLUGIN, PluginSourceKind.Local, []);
  await core.plugins.setEnabled(TOY_PLUGIN_ID, true);
  await core.engineLinks.link(
    TOY_PLUGIN_ID,
    { project: game, directory: project.dir },
    { project: await toyProject("Garden") },
  );
  const off = () => core.plugins.setEnabled(TOY_PLUGIN_ID, false);
  return { ...chat, off };
}

const windowless = {
  loaded: null,
  handle: () => "pool:1",
  get: async () => assert.fail("a game played in its editor has no window"),
  release: async () => {},
};

describe("an engine plugin's judges, through the real core on the toy engine", () => {
  it("are listed on a game the plugin plays in its editor, and never on a web game or with the plugin off", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, game, off } = await toyChat();
    const api = core.api() as unknown as Record<string, (params: unknown) => Promise<GameProject[]>>;
    const listed = async (name: string) => (await api["game.list"]!(undefined)).find((entry) => entry.name === name);
    try {
      const web = (await core.games.scaffold("pond")).name;
      assert.deepEqual(
        [(await listed(game))?.editorPlay, (await listed(game))?.judges],
        [true, TOY_JUDGES],
        "the toy game plays in its editor, with both judges",
      );
      const pond = await listed(web);
      assert.deepEqual([pond?.editorPlay, pond?.judges], [undefined, undefined], "a web game has neither");
    } finally {
      await off();
    }
    const after = await listed(game);
    assert.deepEqual([after?.editorPlay, after?.judges], [undefined, undefined], "no plugin on plays it: no judges");
  });

  it("opens the judge's players and runs its probe once, right after opening: its note and pictures open the first answer, and the chat's line keeps the pictures", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, game, project, threadId, off } = await toyChat();
    const outDir = await tmpDir("judge-toy-frames-");
    const answers: LiveToolResult[] = [];
    let description = "";
    // The harness's part, as its chat judge plays: a blind judge's computer on the game, as the judge named.
    const host: JudgePlayHost = {
      ...studioJudgeHost(core),
      hasCapability: (capability) => capability === HarnessCapability.ChatJudge,
      dispatch: async (action) => {
        assert.equal(action.type, "chat_judge");
        const judge = action.type === "chat_judge" ? action.judge : undefined;
        const grant = {
          project: game,
          root: project.dir,
          handle: "pool:1",
          role: "judge" as const,
          ...(judge ? { judge } : {}),
        };
        const tools = await core._computerToolsFor(grant, project.dir, outDir, windowless as never);
        description = String(tools.liveTools.find((tool) => tool.name === COMPUTER_TOOL_NAME)?.description);
        answers.push(await tools.onLiveTool(COMPUTER_TOOL_NAME, { action: "screenshot" }));
        answers.push(await tools.onLiveTool(COMPUTER_TOOL_NAME, { action: "screenshot", player: 3 }));
        const trace = tools.trace().path;
        await tools.release();
        return { status: "passed", answer: "yes", note: "All three moved.", objective: "model-said", trace };
      },
    };
    try {
      const caller = { project: game, root: project.dir, threadId, engine: "claude-code" };
      await runJudgePlay(host, { ask: "Does every player see the others move?", judge: "crowd" }, caller);
      assert.match(description, /3 players/, "the crowd judge's play opens its three players");
      const [first, second] = answers.map((answer) => (typeof answer === "string" ? { text: answer } : answer));
      assert.match(
        String(first?.text),
        /What the Crowd judge's probe measured once the play opened: 3 players in the play; probe 1/,
      );
      assert.equal(first?.images?.length, 4, "the player's view, then the probe's picture of each player");
      assert.doesNotMatch(String(second?.text), /probe/, "the probe ran once, and its note went with the first answer");
      assert.equal(second?.images?.length, 1);
      const captures = await readdir(path.join(project.dir, CONNECTOR_CAPTURES_DIR));
      assert.equal(captures.length, 3, "the probe's pictures are kept in the game's captures folder");
      const lines = (await core.store.listEvents(threadId)).filter(
        (event) => event.data.type === "custom" && event.data.event_type === "chat_judge_result",
      );
      const payload = (lines.at(-1)?.data as { payload?: { judge?: string; pictures?: string[] } } | undefined)
        ?.payload;
      assert.equal(payload?.judge, "Crowd");
      assert.deepEqual(
        payload?.pictures?.map((picture) => path.basename(picture)).sort(),
        [...captures].sort(),
        "the chat's checks line shows the probe's pictures",
      );
      // The plain judge: one player, no probe, nothing measured.
      answers.length = 0;
      await runJudgePlay(host, { ask: "Can you win?", judge: "plain" }, caller);
      const plain = answers[0];
      assert.doesNotMatch(typeof plain === "string" ? plain : String(plain?.text), /probe|live game/);
      assert.doesNotMatch(description, /3 players/);
      // A play that reaches the live game's saved data says so as it opens.
      await writeFile(path.join(project.dir, "live-data.txt"), "live\n");
      answers.length = 0;
      await runJudgePlay(host, { ask: "Can you win?", judge: "plain" }, caller);
      const live = answers[0];
      assert.match(
        typeof live === "string" ? live : String(live?.text),
        /Saved data in this play is the live game's: play only as the test players this play opened/,
      );
      assert.doesNotMatch(typeof answers[1] === "string" ? answers[1] : String(answers[1]?.text), /live game/, "once");
    } finally {
      await off();
    }
  });

  it("serves judge.play for the harness's own loop on a game played in its editor, with the judge it names; none with the plugin off", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, api, game, threadId, off } = await toyChat();
    const sent: DispatchAction[] = [];
    core.host.hasCapability = (capability) => capability === HarnessCapability.ChatJudge;
    core.host.dispatch = async (action) => {
      sent.push(action);
      return PLAYED;
    };
    const play = () =>
      api["judge.play"]!({
        project: game,
        threadId,
        engine: "ollama",
        args: { ask: "Does every player see the others move?", judge: "crowd" },
      }) as Promise<{ answer: LiveToolResult } | { unavailable: string }>;
    try {
      assert.ok("answer" in (await play()), "the toy game is played in its editor");
      assert.deepEqual(
        sent.map((action) => action.type === "chat_judge" && action.judge),
        ["crowd"],
      );
    } finally {
      await off();
    }
    assert.ok("unavailable" in (await play()), "no plugin on plays it: no judge");
    assert.equal(sent.length, 1);
  });

  it("briefs a judge's session with its brief beside the rubric, and refuses a judge the game does not have", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { game, project, seen, delegate, off } = await toyChat();
    const grant = (judge: string) => ({
      readOnly: true,
      playtest: { project: game, root: project.dir, handle: "pool:1", role: "judge", pacing: "stepped", judge },
    });
    try {
      await delegate(grant("crowd"));
      const prompt = String(seen.at(-1)?.prompt);
      assert.match(prompt, /^go\n\nYour brief as the Crowd judge:\n# Crowd/, "the brief follows the rubric");
      assert.match(prompt, /Three players share the toy play/);
      const count = seen.length;
      await assert.rejects(delegate(grant("cheater")), /No judge named "cheater" plays this game/);
      assert.equal(seen.length, count, "no session for a judge the game does not have");
    } finally {
      await off();
    }
  });
});
