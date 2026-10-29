/**
 * A judge that plays, asked for by the chat's own session, through the real studio: the session calls
 * `judge_play`, the real harness leases a hidden window and sends the same blind judge a build uses,
 * the judge plays the game to its goal, the studio sees the goal reached, and the chat records one
 * line verified by the studio.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import type { DelegateRequest, DelegateResult, LiveToolResult } from "../../src/substrate/engines/types.ts";
import {
  customEvents,
  type FakePreview,
  makeFakePreview,
  type Rig,
  startRig,
  waitForLog,
} from "../helpers/studio-rig.ts";

const rigs: Rig[] = [];
after(async () => {
  await Promise.all(rigs.map((rig) => rig.stop().catch(() => {})));
});

/** How long the whole play may take in the rig. */
const PLAY_TIMEOUT_MS = 120_000;
const GOAL = '{"path":"phase","equals":"won"}';

const text = (result: LiveToolResult | null): string =>
  result === null ? "" : typeof result === "string" ? result : result.text;

/** A finished session's answer. */
const done = (summary: string): DelegateResult => ({ ok: true, engine: "codex", turns: 1, usage: {}, summary });

describe("a chat's judge through the real studio", () => {
  it("plays the chat's game on a hidden window to its goal, and the chat records a yes verified by the studio", {
    timeout: PLAY_TIMEOUT_MS,
  }, async () => {
    // One hidden window, whose game is won once the judge presses Return.
    const windows: FakePreview[] = [];
    const rig = await startRig(
      { replies: [] },
      {
        previewPoolMax: 1,
        createHeadlessPreview: async () => {
          const window = makeFakePreview();
          window.next = { ...window.next, phase: "title" };
          const input = window.input.bind(window);
          window.input = async (actions) => {
            const answer = await input(actions);
            const pressed = (actions ?? []).some((action) => JSON.stringify(action).includes("Enter"));
            if (pressed) window.next = { ...window.next, phase: "won" };
            return answer;
          };
          windows.push(window);
          return window;
        },
      },
    );
    rigs.push(rig);
    const game = await rig.core.games.scaffold("judge-from-chat", { title: "Judge from chat" });
    const threadId = await rig.core.threadForGame(game.name);
    const judges: DelegateRequest[] = [];
    let said: LiveToolResult | null = null;
    rig.core.engines.register({
      id: "codex",
      label: "codex",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        if (request.playtest?.role === "judge") {
          // The judge: it sees the first screen, presses Return, and says what it saw.
          judges.push(request);
          await request.onLiveTool!("computer", { action: "screenshot" });
          const pressed = text(await request.onLiveTool!("computer", { action: "key", text: "Return" }));
          assert.match(pressed, /GOAL REACHED \(studio-verified\)/, "the studio checks the goal after the move");
          return done(JSON.stringify({ answers: { "chat-judge": { answer: "yes", frames: ["s2"] } } }));
        }
        // The chat's own session: the person asked for an independent check.
        if (request.liveTools?.some((tool) => tool.name === "judge_play"))
          said = await request.onLiveTool!("judge_play", { ask: "Can you win?", goal_state: GOAL });
        return done("Asked a judge to play it.");
      },
    } as never);

    await rig.core.sendUserMessage("Have someone else check that the game can be won.", {
      thread: threadId,
      engine: "codex",
    });
    const events = await waitForLog(
      rig.core,
      (all) => customEvents(all, "chat_judge_result").length > 0,
      PLAY_TIMEOUT_MS,
      "the chat's judge line",
    );
    const [line] = customEvents(events, "chat_judge_result");
    assert.deepEqual(
      [line?.ask, line?.status, line?.answer, line?.objective],
      ["Can you win?", "passed", "yes", "studio-verified"],
    );
    assert.match(text(said), /verified by the studio/);
    assert.equal(judges.length, 1, "one judge played");
    const judge = judges[0]!;
    assert.equal(judge.blind, true, "blind: no file, shell or edit tool");
    assert.equal(judge.playtest?.pacing, "stepped");
    assert.deepEqual(
      judge.liveTools?.map((tool) => tool.name),
      ["computer"],
      "it plays with the computer alone",
    );
    assert.equal(windows.length, 1, "on a hidden window of its own, never the person's view");
    assert.equal(rig.preview.inputs.length, 0, "the person's own window was never driven");
  });
});
