/**
 * The status a Live card asks a plugin for while it shows: one ask at a time (a tick that finds an
 * ask still out is skipped), a press asks once more after the ask that is out, and once the card
 * stops (it left the stage, or moved to another game) no answer lands and nothing more is asked.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { type PollTimers, startStatusPoll } from "../../src/renderer/status-poll.ts";

/** Intervals that run only when the test ticks them. */
function manualIntervals(): PollTimers & { tick(): void; running(): number } {
  const runs = new Map<number, () => void>();
  let next = 0;
  return {
    setInterval: (run) => {
      runs.set(++next, run);
      return next;
    },
    clearInterval: (handle) => void runs.delete(handle as number),
    tick: () => {
      for (const run of [...runs.values()]) run();
    },
    running: () => runs.size,
  };
}

/** A plugin whose every status answer the test gives by hand, in the order it was asked. */
function handAnswered() {
  const waiting: Array<(answer: string) => void> = [];
  return {
    ask: () => new Promise<string>((resolve) => waiting.push(resolve)),
    asked: () => waiting.length,
    answer: async (index: number, answer: string) => {
      waiting[index]?.(answer);
      await settle();
    },
  };
}

describe("a Live card's status asking", () => {
  it("asks now, never twice at once, and again on the next tick after an answer", async () => {
    const timers = manualIntervals();
    const plugin = handAnswered();
    const seen: string[] = [];
    startStatusPoll(plugin.ask, (answer) => seen.push(answer), 3_000, timers);
    assert.equal(plugin.asked(), 1);
    timers.tick();
    timers.tick();
    assert.equal(plugin.asked(), 1, "a slow plugin is not asked again while it answers");
    await plugin.answer(0, "opening");
    timers.tick();
    assert.equal(plugin.asked(), 2);
    await plugin.answer(1, "ready");
    assert.deepEqual(seen, ["opening", "ready"]);
  });

  it("asks once more after a press, after the ask that is out", async () => {
    const timers = manualIntervals();
    const plugin = handAnswered();
    const seen: string[] = [];
    const poll = startStatusPoll(plugin.ask, (answer) => seen.push(answer), 3_000, timers);
    const pressed = poll.refresh();
    assert.equal(plugin.asked(), 1, "the press waits for the ask that is out");
    await plugin.answer(0, "closed");
    assert.equal(plugin.asked(), 2);
    await plugin.answer(1, "opening");
    await pressed;
    assert.deepEqual(seen, ["closed", "opening"]);
  });

  it("drops the answer of a card that stopped, and asks nothing more", async () => {
    const timers = manualIntervals();
    const plugin = handAnswered();
    const seen: string[] = [];
    const lantern = startStatusPoll(plugin.ask, (answer) => seen.push(`lantern ${answer}`), 3_000, timers);
    lantern.stop();
    await plugin.answer(0, "ready");
    timers.tick();
    await lantern.refresh();
    assert.equal(plugin.asked(), 1);
    assert.equal(timers.running(), 0);
    assert.deepEqual(seen, [], "the last game's answer never shows on the new game's card");
  });
});
