/**
 * The cards waiting on the user above the composer show one at a time: the one on show stays until
 * it is answered, and a card that cannot be answered never hides one that can.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answerAtPress, unansweredCards, waitingHead } from "../../src/renderer/chat/waiting-cards.ts";

const card = (key: string, blocked = false) => ({ key, blocked });

describe("waiting cards", () => {
  it("shows nothing when nothing waits", () => {
    assert.equal(waitingHead([], null), null);
    assert.equal(waitingHead([], "gone"), null);
  });

  it("shows the first card when none was on show", () => {
    assert.equal(waitingHead([card("a"), card("b")], null), "a");
  });

  it("keeps the card on show while it waits, even when an earlier one arrives", () => {
    assert.equal(waitingHead([card("new"), card("b"), card("c")], "b"), "b");
  });

  it("moves on to the next card once the one on show is answered", () => {
    assert.equal(waitingHead([card("b"), card("c")], "a"), "b");
  });

  it("never lets a card that cannot be answered hide one that can", () => {
    // A question while the chat works cannot be answered; the permission the work waits on can.
    assert.equal(waitingHead([card("question", true), card("permission")], null), "permission");
    assert.equal(waitingHead([card("question", true), card("permission")], "question"), "permission");
  });

  it("keeps a blocked card on show when nothing else can be answered either", () => {
    assert.equal(waitingHead([card("a", true), card("b", true)], "b"), "b");
    assert.equal(waitingHead([card("a", true), card("b", true)], null), "a");
  });

  it("lets an answered card go at the press, before the host settles it", () => {
    const cards = [card("a"), card("b")];
    assert.deepEqual(unansweredCards(cards, new Set(["a"])), [card("b")]);
    assert.deepEqual(unansweredCards(cards, new Set(["a", "b"])), []);
    // A key the host already settled, and so no longer lists, changes nothing.
    assert.deepEqual(unansweredCards(cards, new Set(["gone"])), cards);
  });

  it("marks a card answered before its answer is sent, and keeps it so once it is", async () => {
    const marks: [string, boolean][] = [];
    await answerAtPress(
      "a",
      async () => {
        assert.deepEqual(marks, [["a", true]], "the card is gone while its answer is on its way");
      },
      (key, answered) => marks.push([key, answered]),
    );
    assert.deepEqual(marks, [["a", true]]);
  });

  it("brings a card back when its answer fails, and still reports the failure", async () => {
    const marks: [string, boolean][] = [];
    await assert.rejects(
      answerAtPress(
        "a",
        async () => {
          throw new Error("already settled");
        },
        (key, answered) => marks.push([key, answered]),
      ),
      /already settled/,
    );
    assert.deepEqual(marks, [
      ["a", true],
      ["a", false],
    ]);
  });
});
