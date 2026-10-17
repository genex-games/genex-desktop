/**
 * A local server that leaves a reasoning model's thinking inline (`<think>…</think>`): the chat
 * streams and keeps only the answer, and the thinking is kept apart.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answerDeltas, splitInlineThinking } from "../../src/substrate/local-server/inline-thinking.ts";

/** What `answerDeltas` passes on when a reply arrives in these pieces. */
function streamed(pieces: string[]): string {
  const out: string[] = [];
  const push = answerDeltas((delta) => out.push(delta));
  for (const piece of pieces) push(piece);
  return out.join("");
}

describe("a finished reply with inline thinking", () => {
  const rows: Array<[string, string, string]> = [
    ["<think>plan it</think>\n\nHere it is.", "plan it", "Here it is."],
    ["  \n<think>\nplan\n</think>Done", "plan", "Done"],
    ["the template opened it</think>\nAnswer", "the template opened it", "Answer"],
    ["<think>ran out while thinking", "ran out while thinking", ""],
    ["No thinking at all.", "", "No thinking at all."],
    ["Wrap it in a <think> tag.", "", "Wrap it in a <think> tag."],
    ["Quoting <think>a</think> mid-answer", "", "Quoting <think>a</think> mid-answer"],
  ];
  for (const [text, thinking, answer] of rows)
    it(`splits ${JSON.stringify(text)}`, () => {
      assert.deepEqual(splitInlineThinking(text), { thinking, answer });
    });
});

describe("a streamed reply with inline thinking", () => {
  it("holds a leading thought back, even when its tags arrive in pieces", () => {
    assert.equal(streamed(["<think>", "plan", "</think>", "\n\nHi"]), "Hi");
    assert.equal(streamed(["<th", "ink>pl", "an</thi", "nk>Hi ", "there"]), "Hi there");
    assert.equal(streamed(["\n", " <think>x", "</think>", "ok"]), "ok");
  });

  it("passes an answer that does not start by thinking straight on", () => {
    assert.equal(streamed(["Hel", "lo"]), "Hello");
    assert.equal(streamed(["<b>bold</b>"]), "<b>bold</b>");
    assert.equal(streamed(["<", "div>"]), "<div>", "a tag that only starts like <think> is the answer");
  });

  it("passes nothing for a reply that never stops thinking", () => {
    assert.equal(streamed(["<think>", "still going", "and going"]), "");
  });
});
