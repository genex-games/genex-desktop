/**
 * A blind judge's play for the chat's own session, in the chat: one line in the words of a build's
 * checks list, the question and the judge's note inside it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EntryAction, EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { judgeLineLabel } from "../../src/renderer/outcome-checks.ts";
import { toolWords } from "../../src/renderer/words.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";

const event = (id: number, data: EventData): EventEnvelope => ({
  id: String(id).padStart(6, "0"),
  thread_id: "t1",
  turn_id: "turn",
  session_id: null,
  created_at: new Date(id).toISOString(),
  data,
});
const judged = (id: number, payload: Record<string, unknown>) =>
  event(id, { type: "custom", event_type: "chat_judge_result", payload });

type ActionEntry = Extract<ReturnType<typeof toEntries>[number], { kind: typeof EntryKind.Action }>;
const judgeLines = (events: EventEnvelope[]): ActionEntry[] =>
  toEntries(events).flatMap((entry) =>
    entry.kind === EntryKind.Action && entry.action === EntryAction.Judge ? [entry] : [],
  );

describe("a chat's judge line", () => {
  it("is one line in the checks list's words, with the question and the judge's note inside", () => {
    const [line] = judgeLines([
      judged(1, {
        project: "star-dash",
        ask: "Can you reach the star and win?",
        status: "passed",
        answer: "yes",
        note: "Went round the bottom edge.",
        objective: "studio-verified",
      }),
    ]);
    assert.ok(line?.judge);
    assert.equal(judgeLineLabel(line.judge), "Passed · Judge who played it · verified by the studio");
    assert.equal(line.text, "Can you reach the star and win?");
    assert.equal(line.judge.note, "Went round the bottom edge.");
  });

  it("says a failure and the judge's word as plainly, and why nothing was played when nothing was", () => {
    const [failed, refused] = judgeLines([
      judged(1, {
        ask: "Can you win?",
        status: "failed",
        answer: "no",
        note: "Hit the block.",
        objective: "model-said",
      }),
      judged(2, { ask: "Can you win?", status: "incomplete", answer: null, refusal: "No hidden window is free." }),
    ]);
    assert.equal(judgeLineLabel(failed!.judge!), "Failed · Judge who played it · the player's word");
    assert.equal(judgeLineLabel(refused!.judge!), "The judge didn't play", "nobody played, so nothing rests on a word");
    assert.equal(refused!.judge!.refusal, "No hidden window is free.");
  });

  it("draws nothing for a record too old or partial to say what happened, and never trusts its objective", () => {
    assert.deepEqual(
      judgeLines([judged(1, {}), judged(2, { ask: "Can you win?", status: "won" }), judged(3, { status: "passed" })]),
      [],
    );
    const [line] = judgeLines([judged(4, { ask: "Can you win?", status: "passed", objective: "certainly" })]);
    assert.equal(line?.judge?.objective, "model-said", "an unknown objective is the judge's word");
  });

  it("keeps the engine judge it played as and its probe's pictures, only those in the game's captures folder", () => {
    const [line] = judgeLines([
      judged(1, {
        ask: "Does every player see the others move?",
        status: "passed",
        answer: "yes",
        note: "All three moved together.",
        objective: "model-said",
        judge: "Crowd",
        pictures: [
          ".studio/captures/shot_0123456789abcdef0123.jpg",
          "../secrets.png",
          "/etc/passwd",
          ".studio/captures/../../src/main.js",
          ".studio/captures/shot_fedcba9876543210fedc.png",
          42,
        ],
      }),
    ]);
    assert.equal(line?.judge?.judge, "Crowd");
    assert.deepEqual(line?.judge?.pictures, [
      ".studio/captures/shot_0123456789abcdef0123.jpg",
      ".studio/captures/shot_fedcba9876543210fedc.png",
    ]);
    const [plain] = judgeLines([judged(2, { ask: "Can you win?", status: "passed", pictures: "not a list" })]);
    assert.equal(plain?.judge?.pictures, undefined, "a line with no pictures shows none");
  });

  it("names its tool step in plain words", () => {
    assert.match(toolWords("judge_play").label, /judge play/);
  });
});
