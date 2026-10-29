/**
 * The `finish-check` dev fixture: one game whose chat holds four Loops, each standing at one of the
 * finish check's four looks (Checking, Not yet, Done, Stopped), for a rendered look at the node,
 * its card and its chat lines. Seeding again writes nothing.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { LOOP_END_GAMES, loopEnds, seedFinishCheck } from "../../src/main/dev/fixture-finish-check.ts";
import { FixtureName, isFixtureName } from "../../src/main/dev/fixture-kit.ts";
import { projectBuildGraph } from "../../src/renderer/build-progress.ts";
import { EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { finishCheckFace } from "../../src/renderer/run-tree.ts";
import { FINISH_CHECK_WORDS } from "../../src/renderer/words.ts";
import { type FinishCheckNode, FinishCheckState, GraphNodeKind } from "../../src/renderer/run-graph.ts";
import { CustomEvent, customRecord } from "../../src/shared/custom-events.ts";
import { CHAT_PAGE_SIZE } from "../../src/shared/chat-history.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";
import { StopWhy } from "../../src/shared/finish-check.ts";
import { tmpDir } from "../helpers/tmp.ts";

const GAME = "fixture-game";
const THREAD = "thread-fixture-game";
const START = Date.UTC(2026, 0, 1, 9, 0, 0);

/** A core that keeps the chat's log as the fixture writes it. */
async function fakeCore() {
  const runs = await tmpDir("studio-finish-check-fixture-");
  const log: EventEnvelope[] = [];
  const core = {
    layout: { runs },
    store: { listEvents: async (threadId: string) => log.filter((e) => e.thread_id === threadId) },
    append: async (events: EventData[], threadId: string) => {
      for (const data of events)
        log.push({
          id: `e${String(log.length + 1).padStart(5, "0")}`,
          thread_id: threadId,
          session_id: null,
          turn_id: null,
          created_at: new Date(START + (log.length + 1) * 1000).toISOString(),
          data,
        } as EventEnvelope);
      return threadId;
    },
  };
  return { core, log };
}

it("seeds four Loops whose finish checks stand at each of the four looks", async () => {
  assert.ok(isFixtureName(FixtureName.FinishCheck));
  const { core, log } = await fakeCore();
  await seedFinishCheck(core as never, GAME, THREAD);
  const runIds = [
    ...new Set(
      log.flatMap((e) => {
        const record = customRecord(e.data);
        return record?.event_type === CustomEvent.RunStarted ? [String(record.payload.runId)] : [];
      }),
    ),
  ];
  assert.equal(runIds.length, 4, "four Loops");
  const states = runIds.map((runId) => {
    const graph = projectBuildGraph(log, THREAD, [], core.layout.runs, runId);
    const node = graph?.nodes.find((n): n is FinishCheckNode => n.kind === GraphNodeKind.FinishCheck);
    assert.ok(node, `${runId}: draws its finish check`);
    return node;
  });
  assert.deepEqual(
    states.map((node) => node.state).sort(),
    Object.values(FinishCheckState).sort(),
    "one Loop in each look",
  );
  const notYet = states.find((node) => node.state === FinishCheckState.NotYet);
  assert.deepEqual([notYet?.round, notYet?.reasons.length], [1, 2], "Not yet after its first no, with two reasons");
  const stopped = states.find((node) => node.state === FinishCheckState.Stopped);
  assert.deepEqual(
    stopped?.rounds.map((round) => [round.timeLeft, round.stopped, round.notDone.length > 0]),
    [
      [true, false, true],
      [true, false, true],
      [true, false, true],
      [false, true, true],
    ],
    "the timed Loop went on past its no's with time left, and the next stopped it",
  );
  assert.equal(
    finishCheckFace(stopped as FinishCheckNode).word,
    FINISH_CHECK_WORDS.leftWord(1),
    "its node says what is left",
  );
  const newest = projectBuildGraph(log, THREAD, [], core.layout.runs);
  const shown = newest?.nodes.find((n): n is FinishCheckNode => n.kind === GraphNodeKind.FinishCheck);
  assert.equal(shown?.state, FinishCheckState.Checking, "Builds opens on the Loop being checked");
  const entries = toEntries(log);
  assert.ok(!JSON.stringify(entries).includes("Finish check"), "no finish check line in the chat");
  const cards = entries.flatMap((e) => (e.kind === EntryKind.Morning && e.stillToFix ? [e.stillToFix] : []));
  assert.deepEqual(cards.length, 1, "the stopped Loop's card lists what is done and still to fix");

  const before = log.length;
  await seedFinishCheck(core as never, GAME, THREAD);
  assert.equal(log.length, before, "seeding again writes nothing");
});

it("ends a Loop with something still to fix each other way: its hours, the person's Stop, and past the chat's first page", () => {
  const cardOf = (events: EventData[]) => {
    const log = events.map(
      (data, index): EventEnvelope => ({
        id: `e${String(index + 1).padStart(5, "0")}`,
        thread_id: THREAD,
        session_id: null,
        turn_id: null,
        created_at: new Date(START + (index + 1) * 1000).toISOString(),
        data,
      }),
    );
    // What a chat opened after a restart reads: its newest page only.
    return toEntries(log.slice(-CHAT_PAGE_SIZE)).find((entry) => entry.kind === EntryKind.Morning);
  };
  const ends = new Map(loopEnds().map(({ game, events }) => [game.name, cardOf(events)]));
  const timeUp = ends.get(LOOP_END_GAMES.TimeUp.name);
  assert.ok(timeUp?.kind === EntryKind.Morning);
  assert.deepEqual([timeUp.stillToFix?.why, timeUp.stillToFix?.hours, timeUp.latest], [StopWhy.Time, 5, true]);
  const stopped = ends.get(LOOP_END_GAMES.Stopped.name);
  assert.ok(stopped?.kind === EntryKind.Morning);
  assert.equal(stopped.stillToFix, undefined, "a Stop pauses: the card keeps Resume and no list");
  const long = ends.get(LOOP_END_GAMES.Long.name);
  assert.ok(long?.kind === EntryKind.Morning);
  assert.deepEqual([long.stillToFix?.why, long.stillToFix?.hours], [StopWhy.Time, 2], "its start is off the page");
});
