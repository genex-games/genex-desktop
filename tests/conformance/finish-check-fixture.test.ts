/**
 * The `finish-check` dev fixture: one game whose chat holds four Loops, each standing at one of the
 * finish check's four looks (Checking, Not yet, Done, Stopped), for a rendered look at the node,
 * its card and its chat lines. Seeding again writes nothing.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { seedFinishCheck } from "../../src/main/dev/fixture-finish-check.ts";
import { FixtureName, isFixtureName } from "../../src/main/dev/fixture-kit.ts";
import { projectBuildGraph } from "../../src/renderer/build-progress.ts";
import { EntryKind, SystemTag, toEntries } from "../../src/renderer/chat-entries.ts";
import { type FinishCheckNode, FinishCheckState, GraphNodeKind } from "../../src/renderer/run-graph.ts";
import { CustomEvent, customRecord } from "../../src/shared/custom-events.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";
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
  const newest = projectBuildGraph(log, THREAD, [], core.layout.runs);
  const shown = newest?.nodes.find((n): n is FinishCheckNode => n.kind === GraphNodeKind.FinishCheck);
  assert.equal(shown?.state, FinishCheckState.Checking, "Builds opens on the Loop being checked");
  const lines = toEntries(log).filter((e) => e.kind === EntryKind.System && e.tag === SystemTag.FinishCheck);
  assert.ok(lines.length >= 4, "each round has its chat line");

  const before = log.length;
  await seedFinishCheck(core as never, GAME, THREAD);
  assert.equal(log.length, before, "seeding again writes nothing");
});
