/**
 * A judge that plays, asked for by the chat's own session (`judge_play`), on the host's side: the
 * blind judge plays the game folder while the chat's own session holds it, and every other session
 * there is still refused.
 */
import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import type { LiveToolResult } from "../../src/shared/engine-requests.ts";
import { type DispatchAction, HarnessCapability } from "../../src/shared/protocol.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { workerChat } from "../helpers/worker-chat.ts";

/** How long one case may take: a real lite core and its sessions. */
const CASE_TIMEOUT_MS = 60_000;

/** A request held until released, or its session stopped. */
function holding(holds: Array<() => void>) {
  return (request: DelegateRequest) =>
    new Promise<void>((resolve) => {
      holds.push(resolve);
      request.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
}

describe("a chat's judge on the host", () => {
  it("plays the game folder the chat's own session holds, blind; a playtester or any other session there is still refused", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { game, project, seen, delegate, personSays, whileRunning, untilSeen } = await workerChat();
    const turn = await personSays();
    const holds: Array<() => void> = [];
    const hold = holding(holds);
    whileRunning(async (request) => {
      if (request.permissions) await hold(request);
    });
    const chat = delegate({ chatTurn: { messageId: turn } }).catch(() => null);
    try {
      await untilSeen(1);
      assert.ok(seen[0]?.permissions, "the chat's own session holds the game folder");
      const grant = (role: "judge" | "playtester") => ({
        readOnly: true,
        playtest: {
          project: game,
          root: project.dir,
          handle: "pool-7",
          role,
          pacing: role === "judge" ? "stepped" : "paced",
          setup: { begin: false },
        },
      });
      // A blind judge writes nothing and reads no file: it never needs the folder's writer lock.
      await delegate(grant("judge"));
      const judged = seen.at(-1)!;
      assert.equal(judged.blind, true, "the judge plays blind");
      assert.equal(judged.playtest?.role, "judge");
      for (const [label, extra] of [
        ["a playtester", grant("playtester")],
        ["a read-only session", { readOnly: true }],
        ["a writing session", {}],
      ] as const) {
        const count = seen.length;
        await assert.rejects(delegate(extra), { code: "folder_busy" }, `${label}: still refused`);
        assert.equal(seen.length, count, `${label}: no session`);
      }
    } finally {
      for (const release of holds) release();
      await chat;
    }
  });

  it("offers judge_play to the chat's own session on a game it plays in a window, where the harness serves it; a call is forwarded and answered as one chat line", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, game, project, threadId, seen, delegate, personSays, whileRunning } = await workerChat();
    const sent: DispatchAction[] = [];
    let capable = true;
    core.host.hasCapability = (capability) => capable && capability === HarnessCapability.ChatJudge;
    core.host.dispatch = async (action) => {
      sent.push(action);
      return { status: "passed", answer: "yes", note: "Reached the star.", objective: "model-said", trace: null };
    };
    /** What was forwarded to the harness's judge: the chat's own messages go there too. */
    const judged = () => sent.filter((action) => action.type === "chat_judge");
    const window = { selfCapture: { project: game, root: project.dir, label: game } };
    let answered: LiveToolResult | null = null;
    whileRunning(async (request) => {
      if (request.liveTools?.some((tool) => tool.name === "judge_play"))
        answered = await request.onLiveTool!("judge_play", { ask: "Can you reach the star and win?" });
    });
    await delegate({ chatTurn: { messageId: await personSays() }, ...window });
    const offered = (request: DelegateRequest | undefined) =>
      (request?.liveTools ?? []).some((tool) => tool.name === "judge_play");
    assert.equal(offered(seen.at(-1)), true, "the chat's own session is offered the judge");
    assert.deepEqual(
      judged().map(
        (action) => action.type === "chat_judge" && [action.threadId, action.project, action.root, action.ask],
      ),
      [[threadId, game, project.dir, "Can you reach the star and win?"]],
    );
    assert.match(
      String(answered && (typeof answered === "string" ? answered : (answered as { text: string }).text)),
      /Passed\. The judge answered yes/,
    );
    const lines = (await core.store.listEvents(threadId)).filter(
      (event) => event.data.type === "custom" && event.data.event_type === CustomEvent.ChatJudgeResult,
    );
    assert.equal(lines.length, 1, "one line in the chat");

    // No window of its own (not a game the studio plays in a window), or a harness that does not
    // serve it: no judge, and nothing forwarded.
    await delegate({ chatTurn: { messageId: await personSays() } });
    assert.equal(offered(seen.at(-1)), false, "no window: no judge");
    capable = false;
    await delegate({ chatTurn: { messageId: await personSays() }, ...window });
    assert.equal(offered(seen.at(-1)), false, "an older harness: no judge");
    assert.equal(judged().length, 1);
  });

  it("offers judge_play to the chat's own session on a game played in its engine's editor, the judge playing its game folder", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, game, project, threadId, seen, delegate, personSays, whileRunning } = await workerChat();
    const sent: DispatchAction[] = [];
    core.host.hasCapability = (capability) => capability === HarnessCapability.ChatJudge;
    core.host.dispatch = async (action) => {
      sent.push(action);
      return { status: "passed", answer: "yes", note: "", objective: "model-said", trace: null };
    };
    const offered = () => (seen.at(-1)?.liveTools ?? []).some((tool) => tool.name === "judge_play");
    await core.plugins.setEnabled("unreal", true);
    try {
      await delegate({ chatTurn: { messageId: await personSays() } });
      assert.equal(offered(), false, "a web game with no window: no judge");
      const uproject = path.join(await realpath(await tmpDir("judge-uproject-")), "Valley", "Valley.uproject");
      await mkdir(path.dirname(uproject), { recursive: true });
      await writeFile(uproject, '{"FileVersion":3}\n');
      await core.engineLinks.link("unreal", { project: game, directory: project.dir }, { project: uproject });
      let asked = false;
      whileRunning(async (request) => {
        if (asked || !request.liveTools?.some((tool) => tool.name === "judge_play")) return;
        asked = true;
        await request.onLiveTool!("judge_play", { ask: "Can you walk off the start disc?" });
      });
      await delegate({ chatTurn: { messageId: await personSays() } });
      assert.equal(offered(), true, "the Unreal game's chat is offered the judge");
      const judged = sent.filter((action) => action.type === "chat_judge");
      assert.deepEqual(
        judged.map((action) => action.type === "chat_judge" && [action.threadId, action.project, action.root]),
        [[threadId, game, project.dir]],
      );
    } finally {
      await core.plugins.setEnabled("unreal", false);
    }
  });

  it("runs judge.play for the harness's own loop (Ollama) only in a chat, with its model, on a game the studio plays in a window", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, api, game, project, other, threadId } = await workerChat();
    const sent: DispatchAction[] = [];
    core.host.hasCapability = (capability) => capability === HarnessCapability.ChatJudge;
    core.host.dispatch = async (action) => {
      sent.push(action);
      return { status: "failed", answer: "no", note: "Hit the block.", objective: "model-said", trace: null };
    };
    const play = (params: Record<string, unknown>) =>
      api["judge.play"]!({ project: game, args: { ask: "Can you win?" }, ...params }) as Promise<
        { answer: LiveToolResult } | { unavailable: string }
      >;
    assert.ok("unavailable" in (await play({ engine: "ollama" })), "no chat to record in");
    assert.ok("unavailable" in (await play({ threadId })), "no model to play with");
    // The harness is the agent's: a line goes only to this game's own chat, never another's.
    const elsewhere = await core.threadForGame(other.name);
    for (const [label, chat] of [
      ["another game's chat", elsewhere],
      ["a chat that does not exist", "no-such-thread"],
    ] as const) {
      assert.ok("unavailable" in (await play({ threadId: chat, engine: "ollama" })), `${label}: no judge`);
    }
    assert.equal(sent.length, 0, "nothing was played for a chat that is not this game's");
    const strays = (await core.store.listEvents(elsewhere)).filter(
      (event) => event.data.type === "custom" && event.data.event_type === CustomEvent.ChatJudgeResult,
    );
    assert.equal(strays.length, 0, "another game's chat got no line");
    const answered = await play({ threadId, engine: "ollama", model: "qwen3.5:4b" });
    assert.ok("answer" in answered);
    assert.match(String(answered.answer), /Failed\. The judge answered no/);
    assert.deepEqual(
      sent
        .filter((action) => action.type === "chat_judge")
        .map((action) => action.type === "chat_judge" && [action.root, action.engine, action.model]),
      [[project.dir, "ollama", "qwen3.5:4b"]],
    );
    const lines = (await core.store.listEvents(threadId)).filter(
      (event) => event.data.type === "custom" && event.data.event_type === CustomEvent.ChatJudgeResult,
    );
    assert.equal(lines.length, 1);
  });
});
