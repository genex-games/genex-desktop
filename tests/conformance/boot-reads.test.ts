/**
 * What a launch and a harness boot read from the event log. The log grows for as long as the app
 * is kept, so the repairs a boot runs read each conversation once, a later launch only what came
 * after the last one (checkpointed folds), and the harness asks the host
 * for the follow-ups still owed an answer instead of pulling every conversation's whole history
 * over stdio (review PERF-1, PERF-2). Turn appends index what they wrote (PERF-10).
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { RecoveryService } from "../../src/main/core/recovery.ts";
import type { CoreInternals } from "../../src/main/studio-core.ts";
// The app's copy of the harness's queue reader; seed-contracts.test.ts holds the two to the same answers.
import { messageQueueState } from "../../src/shared/message-queue.ts";
import type { EventStore } from "../../src/substrate/event-store.ts";
import { TurnFactory } from "../../src/substrate/turns.ts";
import type { EventData, EventEnvelope } from "../../src/substrate/types.ts";
import { coreLite } from "../helpers/core-lite.ts";

const custom = (event_type: string, payload: Record<string, unknown>): EventData => ({
  type: "custom",
  event_type,
  payload,
});
const queued = (messageId: string, text: string): EventData[] => [
  { type: "messages", messages: [{ role: "user", content: text }] },
  custom("coordinator_message_queued", { messageId, action: { type: "user_message", text } }),
];

/** Count the full and cursor reads each thread gets while `work` runs. */
async function countReads(
  store: EventStore,
  work: () => Promise<unknown>,
): Promise<{ full: Map<string, number>; after: number }> {
  const full = new Map<string, number>();
  let after = 0;
  const listEvents = store.listEvents.bind(store);
  store.listEvents = async (threadId, options) => {
    if (options?.after) after++;
    else full.set(threadId, (full.get(threadId) ?? 0) + 1);
    return listEvents(threadId, options);
  };
  try {
    await work();
  } finally {
    store.listEvents = listEvents;
  }
  return { full, after };
}

describe("a launch reads each conversation once", () => {
  it("the boot repair closes interrupted turns, runs and questions from one read per conversation", async () => {
    const lite = await coreLite();
    const { core } = lite;
    const crashed = await core.store.createThread({ title: "crashed" });
    await core.store.appendEvents(crashed, [
      ...queued("boss", "add a boss"),
      custom("coordinator_message_processing", { messageId: "boss" }),
    ]);
    const turn = await new TurnFactory(core.store).beginTurn(crashed, {
      input: [{ role: "user", content: "add a boss" }],
    });
    await core.store.appendEvents(crashed, [custom("run_started", { runId: "run_lost", project: "arena" })]);
    const calm = await core.store.createThread({ title: "calm" });
    await core.store.appendEvents(calm, [
      custom("run_started", { runId: "run_done" }),
      custom("run_finished", { runId: "run_done" }),
    ]);

    const recovery = new RecoveryService(core, {} as CoreInternals);
    const reads = await countReads(core.store, () => recovery.closeInterruptedWork());

    for (const thread of await core.store.listThreads())
      assert.equal(reads.full.get(thread.id), 1, `${thread.title} is read once`);
    const events = await core.store.listEvents(crashed);
    const ended = events.filter((e) => e.data.type === "turn_ended");
    assert.deepEqual(
      ended.map((e) => e.turn_id),
      [turn.turnId],
    );
    const notice = events.find((e) => e.data.type === "error");
    assert.match(notice?.data.type === "error" ? notice.data.message : "", /Studio will retry this message/);
    const finished = events.flatMap((e) =>
      e.data.type === "custom" && e.data.event_type === "run_finished" ? [e.data.payload as { runId: string }] : [],
    );
    assert.deepEqual(
      finished.map((p) => p.runId),
      ["run_lost"],
    );
    await lite.close();
  });
});

describe("a later launch reads only what came after the last one", () => {
  const closures = (events: EventEnvelope[]) =>
    events.flatMap((e) => {
      if (e.data.type === "turn_ended") return [`turn ${e.turn_id}`];
      if (e.data.type !== "custom") return [];
      const p = e.data.payload as { runId?: string; consentId?: string; state?: string };
      if (e.data.event_type === "run_finished") return [`run ${p.runId}`];
      if (e.data.event_type === "plugin_consent" && p.state === "declined") return [`question ${p.consentId}`];
      return [];
    });
  const question = (threadId: string, extra: Record<string, unknown> = {}): EventData =>
    custom("plugin_consent", {
      consentId: "publish",
      pluginId: "example",
      pluginName: "Example",
      tool: "example__publish",
      args: {},
      project: "arena",
      threadId,
      prompt: "Publish?",
      state: "pending",
      ...extra,
    });

  it("the boot repair folds on from its checkpoint and closes exactly what the new lifetime left open", async () => {
    const lite = await coreLite();
    const { core } = lite;
    const thread = await core.store.createThread({ title: "runs" });
    await core.store.appendEvents(thread, [custom("run_started", { runId: "run_1", project: "arena" })]);
    await new RecoveryService(core, {} as CoreInternals).closeInterruptedWork();

    // The next lifetime starts another run, a turn and a question, and dies too.
    await core.store.appendEvents(thread, [
      custom("run_registered", { runId: "run_2", project: "arena", mode: "autopilot" }),
      custom("run_started", { runId: "run_2", project: "arena", mode: "director" }),
    ]);
    const turn = await new TurnFactory(core.store).beginTurn(thread, { input: [{ role: "user", content: "again" }] });
    await core.store.appendEvents(thread, [question(thread)]);
    const reads = await countReads(core.store, () =>
      new RecoveryService(core, {} as CoreInternals).closeInterruptedWork(),
    );

    assert.equal(reads.full.size, 0, "no conversation is read in full");
    const events = await core.store.listEvents(thread);
    assert.deepEqual(closures(events), ["run run_1", `turn ${turn.turnId}`, "question publish", "run run_2"]);
    const lastRun = events.findLast((e) => e.data.type === "custom" && e.data.event_type === "run_finished");
    assert.equal(
      lastRun?.data.type === "custom" ? (lastRun.data.payload as { mode?: string }).mode : null,
      "director",
      "the last word on a run's mode wins, as in a full read",
    );

    // Nothing is left open, so a third launch appends nothing.
    await new RecoveryService(core, {} as CoreInternals).closeInterruptedWork();
    assert.equal((await core.store.listEvents(thread)).length, events.length);
    await lite.close();
  });

  it("closes a run with the time its work last happened, not the time of the repair's own records", async () => {
    const lite = await coreLite();
    const { core } = lite;
    const thread = await core.store.createThread({ title: "run" });
    await core.store.appendEvents(thread, [custom("run_started", { runId: "held", project: "arena" })]);
    await new RecoveryService(core, {} as CoreInternals).closeInterruptedWork();
    // The next lifetime starts it again, a worker asks a question, and the app dies under both.
    await core.store.appendEvents(thread, [
      custom("run_started", { runId: "late", project: "arena" }),
      question(thread, { runId: "late" }),
    ]);
    const lastWork = (await core.store.listEvents(thread)).at(-1)?.created_at;
    await new RecoveryService(core, {} as CoreInternals).closeInterruptedWork();

    const events = await core.store.listEvents(thread);
    assert.deepEqual(closures(events).slice(-2), ["question publish", "run late"], "the withdrawal is written first");
    const close = events.findLast((e) => e.data.type === "custom" && e.data.event_type === "run_finished");
    const payload = close?.data.type === "custom" ? (close.data.payload as { workedUntil?: string }) : null;
    assert.equal(payload?.workedUntil, lastWork);
    await lite.close();
  });

  it("a checkpoint it cannot read is rebuilt from the whole log", async () => {
    const lite = await coreLite();
    const { core } = lite;
    const thread = await core.store.createThread({ title: "damaged" });
    await new RecoveryService(core, {} as CoreInternals).closeInterruptedWork();
    await core.store.appendEvents(thread, [custom("run_started", { runId: "held", project: "arena" })]);
    await writeFile(path.join(core.store.threadDir(thread), "repair-state.json"), "{ torn");

    const reads = await countReads(core.store, () =>
      new RecoveryService(core, {} as CoreInternals).closeInterruptedWork(),
    );
    assert.equal(reads.full.get(thread), 1);
    assert.deepEqual(closures(await core.store.listEvents(thread)), ["run held"]);
    await lite.close();
  });

  it("the snapshot index is rebuilt from its checkpoint plus the records after it", async () => {
    const lite = await coreLite();
    const { core } = lite;
    const snapshot = (id: string, healthy: boolean): EventData => ({
      type: "snapshot_created",
      snapshot_id: id,
      scope: "harness",
      git: { harness: "b".repeat(40) },
      healthy,
    });
    await core.append([snapshot("snap_1", false), snapshot("snap_2", false)]);
    await core.append([custom("snapshot_healthy", { snapshot_id: "snap_1" })]);
    await new RecoveryService(core, { indexEvent: () => {} } as unknown as CoreInternals).rebuildSnapshotIndex();
    await core.append([snapshot("snap_3", true), { type: "error", message: "unrelated" }]);

    const indexed: string[] = [];
    const x = { indexEvent: (event: EventEnvelope) => indexed.push(event.id) } as unknown as CoreInternals;
    const reads = await countReads(core.store, () => new RecoveryService(core, x).rebuildSnapshotIndex());
    assert.equal(reads.full.size, 0, "the Studio conversation is not read in full");
    const relevant = (await core.store.listEvents(core.mainThread)).filter(
      (e) =>
        e.data.type === "snapshot_created" || (e.data.type === "custom" && e.data.event_type === "snapshot_healthy"),
    );
    assert.deepEqual(
      indexed,
      relevant.map((e) => e.id),
      "the index sees every snapshot record, in log order",
    );
    await lite.close();
  });
});

describe("the harness boot restores its inbox from the host", () => {
  it("events.inbox names the follow-ups each conversation still owes, as the harness would read them from the whole log", async () => {
    const lite = await coreLite();
    const { core } = lite;
    const busy = await core.store.createThread({ title: "busy" });
    await core.store.appendEvents(busy, [
      ...queued("answered", "first"),
      custom("coordinator_message_processing", { messageId: "answered" }),
      custom("coordinator_message_handled", { messageId: "answered" }),
      ...queued("cut-off", "second"),
      custom("coordinator_message_processing", { messageId: "cut-off" }),
      ...queued("edited", "third"),
      custom("coordinator_message_updated", { messageId: "edited", text: "third, reworded" }),
      ...queued("removed", "fourth"),
      custom("coordinator_message_removed", { messageId: "removed" }),
      custom("coordinator_queue_paused", {}),
    ]);
    const quiet = await core.store.createThread({ title: "quiet" });
    await core.store.appendEvents(quiet, [
      ...queued("done", "hi"),
      custom("coordinator_message_handled", { messageId: "done" }),
    ]);

    const open = (events: Parameters<typeof messageQueueState>[0]) => {
      const view = messageQueueState(events);
      return {
        paused: view.paused,
        messages: [...view.messages.values()]
          .filter((m) => m.state === "queued" || m.state === "processing")
          .map(({ messageId, action, state, attempts }) => ({ messageId, action, state, attempts })),
      };
    };
    const inbox = await lite.api()["events.inbox"]();
    assert.deepEqual(
      inbox.map((entry) => entry.threadId),
      [busy],
      "a conversation with nothing owed is left out",
    );
    assert.deepEqual(open(inbox[0]!.events), open(await core.store.listEvents(busy)));
    assert.equal(open(inbox[0]!.events).messages.length, 2);

    // Later records extend it from where it stopped.
    await core.store.appendEvents(busy, [
      custom("coordinator_queue_resumed", {}),
      custom("coordinator_message_processing", { messageId: "edited" }),
    ]);
    const reads = await countReads(core.store, async () => {
      const again = await lite.api()["events.inbox"]();
      assert.deepEqual(open(again[0]!.events), open(await core.store.listEvents(busy)));
    });
    assert.equal(reads.full.get(busy), 1, "only the comparison reads the whole log");
    assert.equal(reads.full.get(quiet), undefined);
    await lite.close();
  });

  it("events.inbox keeps what a steered turn owes: a message handed to it unread, and one it read, until it is answered", async () => {
    const lite = await coreLite();
    const { core } = lite;
    const thread = await core.store.createThread({ title: "steered" });
    await core.store.appendEvents(thread, [
      ...queued("done", "build a pond"),
      custom("coordinator_message_processing", { messageId: "done" }),
      ...queued("read-by-done", "and ducks"),
      custom("coordinator_message_delivered", { messageId: "read-by-done", into: "done", how: "native" }),
      custom("coordinator_message_handled", { messageId: "done" }),
      ...queued("cut", "make it run"),
      custom("coordinator_message_processing", { messageId: "cut" }),
      ...queued("read", "and stars"),
      custom("coordinator_message_steering", { messageId: "read", into: "cut" }),
      custom("coordinator_message_delivered", { messageId: "read", into: "cut", how: "interrupt" }),
      ...queued("handed", "and rain"),
      custom("coordinator_message_steering", { messageId: "handed", into: "cut" }),
    ]);
    const owed = (events: Parameters<typeof messageQueueState>[0]) =>
      [...messageQueueState(events).messages.values()].map((m) => [m.messageId, m.state, m.into ?? null]);
    const inbox = await lite.api()["events.inbox"]();
    assert.deepEqual(
      owed(inbox[0]!.events),
      [
        ["cut", "processing", null],
        ["read", "delivered", "cut"],
        ["handed", "steering", "cut"],
      ],
      "the cut-short turn replays with what it read; what it was handed but did not read gets its own turn",
    );
    // Answered: what it read settles with it.
    await core.store.appendEvents(thread, [
      custom("coordinator_message_requeued", { messageId: "handed" }),
      custom("coordinator_message_handled", { messageId: "cut" }),
    ]);
    const after = await lite.api()["events.inbox"]();
    assert.deepEqual(owed(after[0]!.events), [["handed", "queued", null]]);
    await lite.close();
  });

  it("events.inbox lets go of what a turn cut off twice had read, once the harness settles that turn unretried", async () => {
    const lite = await coreLite();
    const { core } = lite;
    const thread = await core.store.createThread({ title: "cut twice" });
    await core.store.appendEvents(thread, [
      ...queued("cut", "build a pond"),
      custom("coordinator_message_processing", { messageId: "cut" }),
      custom("coordinator_message_requeued", { messageId: "cut", attempts: 1 }),
      custom("coordinator_message_processing", { messageId: "cut", attempt: 2 }),
      ...queued("read", "and ducks"),
      custom("coordinator_message_steering", { messageId: "read", into: "cut" }),
      custom("coordinator_message_delivered", { messageId: "read", into: "cut", how: "native" }),
    ]);
    const owed = (events: Parameters<typeof messageQueueState>[0]) =>
      [...messageQueueState(events).messages.values()].map((m) => [m.messageId, m.state, m.attempts ?? 0]);
    const inbox = await lite.api()["events.inbox"]();
    assert.deepEqual(owed(inbox[0]!.events), [
      ["cut", "processing", 2],
      ["read", "delivered", 0],
    ]);
    // What the harness's restore writes for a turn cut off on its retry: it is not answered again,
    // and the message it had read is neither carried nor answered on its own.
    await core.store.appendEvents(thread, [
      custom("coordinator_message_handled", { messageId: "cut", interrupted: true, attempts: 2 }),
    ]);
    assert.deepEqual(
      (await lite.api()["events.inbox"]()).map((entry) => entry.threadId),
      [],
      "nothing is owed: the read message settled with its turn",
    );
    await lite.close();
  });

  it("the boot repair's read seeds it, so the harness boot that follows reads only what came after", async () => {
    const lite = await coreLite();
    const { core } = lite;
    const thread = await core.store.createThread({ title: "waiting" });
    await core.store.appendEvents(thread, queued("later", "do it later"));
    await new RecoveryService(core, {} as CoreInternals).closeInterruptedWork();

    const reads = await countReads(core.store, () => lite.api()["events.inbox"]());
    assert.equal(reads.full.size, 0, "no conversation is read in full");
    const inbox = await lite.api()["events.inbox"]();
    assert.deepEqual(open(inbox), [["later", "queued"]]);
    await lite.close();

    function open(entries: typeof inbox) {
      return entries.flatMap((entry) =>
        [...messageQueueState(entry.events).messages.values()].map((m) => [m.messageId, m.state]),
      );
    }
  });
});

describe("turn appends", () => {
  it("turn appends cannot forge a host snapshot or advance the snapshot index", async () => {
    const lite = await coreLite();
    const { core } = lite;
    const api = lite.api();
    const { turnId } = await api["turn.begin"]({ threadId: core.mainThread });
    await assert.rejects(
      api["turn.append"]({
        turnId,
        batch: [
          {
            type: "snapshot_created",
            snapshot_id: "snap_in_turn",
            scope: "harness",
            git: { harness: "a".repeat(40) },
            healthy: true,
          },
        ],
      }),
      /written by the studio only/,
    );
    assert.ok(!core.snapshotIndex.all().some((record) => record.snapshot_id === "snap_in_turn"));
    await api["turn.end"]({ turnId });
    await lite.close();
  });
});
