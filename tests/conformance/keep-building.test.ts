/**
 * Keep building (`renderer/keep-building.ts`): where it is offered (the chat's newest result card
 * while nothing runs or waits paused; Builds' newest build once it ended) and that a tap while its
 * send is under way sends nothing more.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HistoryEntry } from "../../src/renderer/build-progress.ts";
import { keepsBuildingIn, keepsBuildingOn, oneAtATime } from "../../src/renderer/keep-building.ts";
import { RunState } from "../../src/shared/run-state.ts";

const build = (runId: string, state: string, chat?: true): HistoryEntry => ({
  runId,
  rounds: 0,
  state,
  startedAt: null,
  ask: "",
  since: null,
  ...(chat ? { chat } : {}),
});

describe("Keep building on the chat's result card", () => {
  const quiet = { activeRunId: null, pausedRunId: null };
  it("is offered on the newest card only, while nothing of the chat runs or waits paused", () => {
    assert.equal(keepsBuildingIn({ latest: true }, quiet), true);
    assert.equal(keepsBuildingIn({}, quiet), false, "an older card's list is history");
    assert.equal(keepsBuildingIn({ latest: true }, { ...quiet, activeRunId: "r2" }), false, "a Loop is running");
    assert.equal(keepsBuildingIn({ latest: true }, { ...quiet, pausedRunId: "r1" }), false, "Resume belongs to it");
  });
});

describe("Keep building on Builds' final look", () => {
  it("is offered on the chat's newest build once it ended, never on a paused one, an older one or a chat turn", () => {
    const ended = [build("r1", RunState.Finished), build("r2", RunState.Finished)];
    assert.equal(keepsBuildingOn(ended, "r2"), true);
    assert.equal(keepsBuildingOn(ended, "r1"), false, "a newer build makes it history");
    assert.equal(keepsBuildingOn([build("r1", RunState.Paused)], "r1"), false, "a paused build keeps Resume");
    assert.equal(keepsBuildingOn([build("r1", RunState.Running)], "r1"), false, "still working");
    const turnAfter = [build("r1", RunState.Finished), build("turn:m1", RunState.Finished, true)];
    assert.equal(keepsBuildingOn(turnAfter, "r1"), false, "a chat turn came after it");
    assert.equal(keepsBuildingOn([], "r1"), false);
    assert.equal(keepsBuildingOn(ended, null), false);
  });
});

describe("Keep building's send", () => {
  it("sends once for a double tap, and again once that send is over", async () => {
    const sent: string[][] = [];
    let release = (): void => {};
    const send = oneAtATime(async (notDone: string[]) => {
      sent.push(notDone);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return true;
    });
    const first = send(["The timer resets"]);
    assert.equal(await send(["The timer resets"]), false, "the second tap while the first sends sends nothing");
    assert.equal(sent.length, 1);
    release();
    assert.equal(await first, true);
    const again = send(["The timer resets"]);
    release();
    await again;
    assert.equal(sent.length, 2, "a later tap sends");
  });

  it("is free again after a send that failed", async () => {
    let calls = 0;
    const send = oneAtATime(async () => {
      calls += 1;
      throw new Error("offline");
    });
    await assert.rejects(send());
    await assert.rejects(send());
    assert.equal(calls, 2);
  });
});
