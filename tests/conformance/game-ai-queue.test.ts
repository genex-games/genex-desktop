/**
 * The queue in front of play-time AI's doors (`main/game-ai/queue.ts`): build work first — a game's
 * call on this Mac's model or the person's plan waits while a build runs and is refused with a wait
 * when the build outlasts it; per-door concurrency (the plan and this Mac's model one at a time);
 * waiters served in order; a Stop or an abandoned page cancels a waiting call with no slot taken.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { createGameAiQueue, DOOR_CONCURRENCY } from "../../src/main/game-ai/queue.ts";
import { AiDoor, AiErrorCode, type AiGameKey } from "../../src/shared/game-ai.ts";

const CROWNS: AiGameKey = "play:proj_crowns";
const MOSS: AiGameKey = "create:Moss Garden";
const WAITS = { buildWaitMs: 60, slotWaitMs: 60, buildRetryMs: 5_000 };

const never = () => new AbortController().signal;

describe("the play-time AI queue", () => {
  it("runs the plan and this Mac's model one call at a time, in order", async () => {
    assert.equal(DOOR_CONCURRENCY[AiDoor.Plan], 1);
    assert.equal(DOOR_CONCURRENCY[AiDoor.Local], 1);
    const queue = createGameAiQueue({ ...WAITS, slotWaitMs: 1_000 });
    const first = await queue.acquire(AiDoor.Plan, CROWNS, never());
    assert.ok(first.ok);
    const order: string[] = [];
    const second = queue.acquire(AiDoor.Plan, MOSS, never()).then((slot) => {
      order.push("second");
      return slot;
    });
    const third = queue.acquire(AiDoor.Plan, CROWNS, never()).then((slot) => {
      order.push("third");
      return slot;
    });
    await sleep(10);
    assert.deepEqual(order, [], "both wait for the first");
    first.release();
    const two = await second;
    assert.ok(two.ok);
    await sleep(10);
    assert.deepEqual(order, ["second"], "one at a time");
    two.release();
    const three = await third;
    assert.ok(three.ok);
    assert.deepEqual(order, ["second", "third"]);
    three.release();
  });

  it("lets doors that bill run side by side, up to their own concurrency", async () => {
    const queue = createGameAiQueue(WAITS);
    const slots = await Promise.all(
      Array.from({ length: DOOR_CONCURRENCY[AiDoor.Byok] }, () => queue.acquire(AiDoor.Byok, CROWNS, never())),
    );
    assert.ok(slots.every((slot) => slot.ok));
    const local = await queue.acquire(AiDoor.Local, CROWNS, never());
    assert.ok(local.ok, "another door is not held up");
    const over = await queue.acquire(AiDoor.Byok, CROWNS, never());
    assert.equal(!over.ok && over.code, AiErrorCode.Concurrency, "past the wait, refused");
  });

  it("holds this Mac's model and the plan while a build runs, and refuses with a wait when it outlasts", async () => {
    const queue = createGameAiQueue(WAITS);
    queue.building(true);
    for (const door of [AiDoor.Local, AiDoor.Plan]) {
      const refused = await queue.acquire(door, CROWNS, never());
      assert.equal(!refused.ok && refused.code, AiErrorCode.DoorUnavailable, door);
      assert.equal(!refused.ok && refused.retryAfterMs, WAITS.buildRetryMs, door);
    }
    const byok = await queue.acquire(AiDoor.Byok, CROWNS, never());
    assert.ok(byok.ok, "the person's key shares nothing with the build");
    byok.release();
  });

  it("starts a waiting call the moment the build ends", async () => {
    const queue = createGameAiQueue({ ...WAITS, buildWaitMs: 1_000 });
    queue.building(true);
    const waiting = queue.acquire(AiDoor.Local, CROWNS, never());
    await sleep(10);
    queue.building(false);
    const slot = await waiting;
    assert.ok(slot.ok);
    slot.release();
  });

  it("counts overlapping builds: the queue waits until the last one ends", async () => {
    const queue = createGameAiQueue({ ...WAITS, buildWaitMs: 200 });
    queue.building(true);
    queue.building(true);
    queue.building(false);
    const refused = await queue.acquire(AiDoor.Local, CROWNS, never());
    assert.equal(refused.ok, false, "one build still runs");
    queue.building(false);
    queue.building(false);
    const slot = await queue.acquire(AiDoor.Local, CROWNS, never());
    assert.ok(slot.ok, "an extra end never goes negative");
    slot.release();
  });

  it("cancels a waiting call on its signal, with no slot taken", async () => {
    const queue = createGameAiQueue({ ...WAITS, slotWaitMs: 1_000 });
    const held = await queue.acquire(AiDoor.Plan, CROWNS, never());
    assert.ok(held.ok);
    const stop = new AbortController();
    const waiting = queue.acquire(AiDoor.Plan, CROWNS, stop.signal);
    stop.abort();
    const canceled = await waiting;
    assert.equal(!canceled.ok && canceled.code, AiErrorCode.Canceled);
    const aborted = new AbortController();
    aborted.abort();
    const already = await queue.acquire(AiDoor.Byok, CROWNS, aborted.signal);
    assert.equal(!already.ok && already.code, AiErrorCode.Canceled, "an aborted signal never takes a slot");
    held.release();
    const next = await queue.acquire(AiDoor.Plan, MOSS, never());
    assert.ok(next.ok, "the canceled waiter took nothing");
  });

  it("frees a slot once, however often it is released", async () => {
    const queue = createGameAiQueue(WAITS);
    const one = await queue.acquire(AiDoor.Plan, CROWNS, never());
    assert.ok(one.ok);
    one.release();
    one.release();
    const two = await queue.acquire(AiDoor.Plan, CROWNS, never());
    assert.ok(two.ok);
    const three = await queue.acquire(AiDoor.Plan, CROWNS, never());
    assert.equal(three.ok, false, "a double release never opens a second slot");
    two.release();
  });

  it("refuses a call past the waiting line's length at once", async () => {
    const queue = createGameAiQueue({ ...WAITS, slotWaitMs: 1_000, maxWaiting: 2 });
    const held = await queue.acquire(AiDoor.Plan, CROWNS, never());
    assert.ok(held.ok);
    const waiting = [queue.acquire(AiDoor.Plan, CROWNS, never()), queue.acquire(AiDoor.Plan, CROWNS, never())];
    const third = await queue.acquire(AiDoor.Plan, CROWNS, never());
    assert.equal(!third.ok && third.code, AiErrorCode.Concurrency);
    held.release();
    for (const pending of waiting) {
      const slot = await pending;
      assert.ok(slot.ok);
      slot.release();
    }
  });
});
