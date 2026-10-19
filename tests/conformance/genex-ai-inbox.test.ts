/**
 * Determinism in `genex-ai`: an answer never enters the game the moment it arrives. It waits in
 * the inbox until the drain it is due on (`drain()`, once per `update()`), so a seed and the same
 * steps replay the same frames however the studio paces them and however late a tape loads.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inbox } from "../../src/page/ai/inbox.ts";

/** Drain `count` times, keeping what each drain released. */
function drains<T>(box: ReturnType<typeof inbox<T>>, count: number): T[][] {
  return Array.from({ length: count }, () => box.drain());
}

describe("the inbox", () => {
  it("releases an answer on the drain it is due, never before", () => {
    const box = inbox<string>();
    box.holdUntil("a", 3);
    assert.deepEqual(drains(box, 4), [[], [], ["a"], []]);
    assert.equal(box.frame(), 4);
    assert.equal(box.pending(), 0);
  });

  it("releases an answer whose due drain has passed on the next one", () => {
    const box = inbox<string>();
    drains(box, 5);
    box.holdUntil("late", 2);
    assert.deepEqual(box.drain(), ["late"]);
  });

  it("releases answers due on one drain in the order they were held, whatever order they fall due in", () => {
    const box = inbox<string>();
    box.holdUntil("second-held", 2);
    box.holdUntil("first-due", 1);
    box.holdUntil("third-held", 2);
    assert.deepEqual(drains(box, 2), [["first-due"], ["second-held", "third-held"]]);
  });

  it("holds nothing for the drain in progress: an answer is due one drain from now at the soonest", () => {
    const box = inbox<string>();
    box.drain();
    box.holdUntil("now", box.frame());
    box.holdUntil("past", -10);
    box.holdUntil("nan", Number.NaN);
    assert.deepEqual(box.drain(), ["now", "past", "nan"]);
  });

  it("takes an answer back before it is released", () => {
    const box = inbox<string>();
    box.holdUntil("kept", 2);
    box.holdUntil("taken", 2);
    box.remove("taken");
    assert.equal(box.pending(), 1);
    assert.deepEqual(drains(box, 2), [[], ["kept"]]);
  });

  it("forgets every answer and the frame count when the world is reset", () => {
    const box = inbox<string>();
    box.holdUntil("a", 5);
    drains(box, 2);
    box.clear();
    assert.equal(box.pending(), 0);
    assert.equal(box.frame(), 0);
    assert.deepEqual(drains(box, 6).flat(), []);
  });

  it("replays the same frames for the same holds, however many times it runs", () => {
    const run = () => {
      const box = inbox<number>();
      const seen: Array<[number, number]> = [];
      for (let frame = 0; frame < 300; frame += 1) {
        if (frame % 7 === 0) box.holdUntil(frame, box.frame() + 1 + (frame % 13));
        for (const item of box.drain()) seen.push([box.frame(), item]);
      }
      return seen;
    };
    assert.deepEqual(run(), run());
  });
});
