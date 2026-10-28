/**
 * Substrate conformance suite.
 *
 * D6 was accepted on one explicit condition from Simeon: *the reimplementation must be firmly
 * verifiable*. These tests transcribe the behaviours Exo's own substrate tests assert, so the
 * port is checked against the semantics it claims to have rather than against itself.
 */
import assert from "node:assert/strict";
import { readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { EventStore } from "../../src/substrate/event-store.ts";
import { compareIds, isUuidV7, uuid7Millis, uuidv7 } from "../../src/substrate/ids.ts";
import { TurnFactory, findInterruptedTurns } from "../../src/substrate/turns.ts";
import { type EventEnvelope, HeadMismatch, ThreadNotFound } from "../../src/substrate/types.ts";
import { tmpDir } from "../helpers/tmp.ts";

async function newStore(): Promise<EventStore> {
  return EventStore.open(path.join(await tmpDir(), "exoharness"), "studio");
}

it("a corrupt committed event remains visible without blocking unrelated history or rewriting bytes", async () => {
  const store = await newStore();
  const broken = await store.createThread();
  const healthy = await store.createThread();
  const result = await store.appendEvents(broken, [
    { type: "messages", messages: [{ role: "user", content: "before corruption" }] },
  ]);
  await store.appendEvents(healthy, [{ type: "messages", messages: [{ role: "user", content: "intact" }] }]);
  const file = store.eventPath(broken, result.latestEventId);
  await writeFile(file, "{broken");
  const rows = await store.listEvents(broken);
  const unreadable = rows.find((event) => event.id === result.latestEventId);
  assert.ok(unreadable);
  assert.equal(unreadable.data.type, "error");
  assert.match(String((unreadable.data as { message: string }).message), /unreadable/i);
  assert.ok((await store.listEvents(healthy)).some((event) => event.data.type === "messages"));
  assert.equal((await store.getRecord(broken)).latest_event_id, result.latestEventId);
  assert.equal(await readFile(file, "utf8"), "{broken");
});

it("a corrupt thread record is preserved and reported without preventing healthy conversations from opening", async () => {
  const root = path.join(await tmpDir(), "store");
  const store = await EventStore.open(root);
  const broken = await store.createThread();
  const healthy = await store.createThread();
  const file = store.recordPath(broken);
  await writeFile(file, "{broken-record");
  const warnings: string[] = [];
  const reopened = await EventStore.open(root, "studio", { warn: (message) => warnings.push(message) });
  assert.ok((await reopened.listThreads()).some((record) => record.id === healthy));
  await assert.rejects(reopened.appendEvents(broken, [{ type: "error", message: "do not overwrite" }]), /unreadable/);
  assert.equal(await readFile(file, "utf8"), "{broken-record");
  assert.ok(warnings.some((message) => message.includes(broken) && /preserved/.test(message)));
});

describe("uuidv7", () => {
  it("is monotonic within a millisecond and lexicographically time-ordered", () => {
    const ids: string[] = [];
    for (let i = 0; i < 5000; i++) ids.push(uuidv7());
    for (const id of ids) assert.ok(isUuidV7(id), `${id} is not a v7 uuid`);
    const sorted = [...ids].sort(compareIds);
    assert.deepEqual(sorted, ids, "ids must already be in sorted order");
    assert.equal(new Set(ids).size, ids.length, "ids must be unique");
  });

  it("encodes the mint time", () => {
    const now = Date.now();
    const ms = uuid7Millis(uuidv7(now));
    assert.ok(Math.abs(ms - now) <= 1, `expected ~${now}, got ${ms}`);
  });

  it("never regresses when the clock jumps backwards", () => {
    const a = uuidv7(Date.now());
    const b = uuidv7(Date.now() - 60_000); // NTP step / wake from sleep
    assert.ok(compareIds(b, a) > 0, "id minted after a backwards clock step must still sort later");
  });
});

describe("event store: layout", () => {
  it("writes Exo's directory shape, one pretty JSON file per event", async () => {
    const store = await newStore();
    const thread = await store.createThread({ title: "layout" });
    await store.appendEvents(thread, [{ type: "messages", messages: [{ role: "user", content: "hi" }] }]);

    const eventsDir = store.eventsDir(thread);
    const files = (await readdir(eventsDir)).filter((f) => f.endsWith(".json")).sort();
    assert.equal(files.length, 2, "thread_created + messages");
    for (const file of files) assert.ok(isUuidV7(file.slice(0, -5)), `${file} must be <uuid7>.json`);

    const raw = await readFile(path.join(eventsDir, files[0]!), "utf8");
    assert.ok(raw.includes("\n  "), "events are pretty-printed (human-inspectable log)");
    const parsed = JSON.parse(raw);
    assert.deepEqual(Object.keys(parsed).sort(), ["created_at", "data", "id", "session_id", "thread_id", "turn_id"]);

    assert.ok(store.recordPath(thread).endsWith(path.join("conversations", thread, "record.json")));
    assert.ok(store.agentDir().endsWith(path.join("agents", "studio")));
  });

  it("accepts Exo's conversation_id alias on read", async () => {
    const store = await newStore();
    const thread = await store.createThread();
    const id = uuidv7();
    // Emulate a store written by upstream Exo: the alias key, plus a committed head.
    await writeFile(
      store.eventPath(thread, id),
      JSON.stringify({
        id,
        conversation_id: thread, // Exo serde alias, never written by us
        session_id: null,
        turn_id: null,
        created_at: new Date().toISOString(),
        data: { type: "error", message: "from exo" },
      }),
    );
    const record = JSON.parse(await readFile(store.recordPath(thread), "utf8"));
    record.latest_event_id = id;
    await writeFile(store.recordPath(thread), JSON.stringify(record, null, 2));

    const events = await store.listEvents(thread);
    const imported = events.find((e) => e.id === id);
    assert.equal(imported?.thread_id, thread);
  });
});

describe("event store: append + head check", () => {
  it("advances the head and returns the written envelopes", async () => {
    const store = await newStore();
    const thread = await store.createThread();
    const before = await store.head(thread);
    const result = await store.appendEvents(thread, [
      { type: "messages", messages: [{ role: "user", content: "a" }] },
      { type: "messages", messages: [{ role: "assistant", content: "b" }] },
    ]);
    assert.equal(result.events.length, 2);
    assert.notEqual(result.latestEventId, before);
    assert.equal(await store.head(thread), result.latestEventId);
    assert.ok(compareIds(result.events[1]!.id, result.events[0]!.id) > 0);
  });

  it("rejects a stale expectedHead (concurrent-writer safety)", async () => {
    const store = await newStore();
    const thread = await store.createThread();
    const staleHead = await store.head(thread);
    await store.appendEvents(thread, [{ type: "error", message: "writer A" }]);

    await assert.rejects(
      () => store.appendEvents(thread, [{ type: "error", message: "writer B" }], { expectedHead: staleHead }),
      (err: unknown) => {
        assert.ok(err instanceof HeadMismatch);
        assert.equal(err.expected, staleHead);
        return true;
      },
    );
    // The rejected write must not have landed.
    const messages = await store.listEvents(thread);
    assert.equal(messages.filter((e) => e.data.type === "error").length, 1);
  });

  it("serialises concurrent appenders without interleaving batches", async () => {
    const store = await newStore();
    const thread = await store.createThread();
    const writers = Array.from({ length: 12 }, (_, w) =>
      store.appendEvents(
        thread,
        Array.from({ length: 5 }, (_, i) => ({
          type: "custom" as const,
          event_type: "probe",
          payload: { writer: w, index: i },
        })),
      ),
    );
    await Promise.all(writers);
    const events = (await store.listEvents(thread)).filter((e) => e.data.type === "custom");
    assert.equal(events.length, 60);
    // Each writer's five events must appear contiguously and in order.
    const seen = new Map<number, number>();
    let previousWriter: number | null = null;
    for (const event of events) {
      const payload = (event.data as { payload: { writer: number; index: number } }).payload;
      if (payload.writer !== previousWriter) {
        assert.equal(payload.index, 0, "a batch must not be split by another writer");
        previousWriter = payload.writer;
      }
      const expected: number = seen.get(payload.writer) ?? 0;
      assert.equal(payload.index, expected);
      seen.set(payload.writer, expected + 1);
    }
    assert.equal(
      [...seen.values()].every((n) => n === 5),
      true,
    );
  });

  it("a store given a redactor writes, returns and announces every appended event redacted (SEC-1)", async () => {
    const leased = "leased-connector-FAKE-value";
    const store = await EventStore.open(path.join(await tmpDir(), "exoharness"), "studio", {
      redact: (text) => text.replaceAll(leased, "[redacted]"),
    });
    const thread = await store.createThread();
    const announced: string[] = [];
    const watching = store.watch(thread, (event) => announced.push(JSON.stringify(event.data)));
    const result = await store.appendEvents(thread, [
      {
        type: "custom",
        event_type: "delegated.claude-code",
        payload: { kind: "tool_result", data: { text: `WEATHER=${leased}`, count: 3 } },
      },
    ]);
    watching.close();
    const onDisk = await readFile(store.eventPath(thread, result.latestEventId), "utf8");
    for (const text of [
      onDisk,
      JSON.stringify(result.events),
      JSON.stringify(await store.listEvents(thread)),
      ...announced,
    ]) {
      assert.equal(text.includes(leased), false, text);
      assert.match(text, /WEATHER=\[redacted\]/);
    }
    const event = (await store.listEvents(thread)).at(-1);
    assert.deepEqual(event!.data, {
      type: "custom",
      event_type: "delegated.claude-code",
      payload: { kind: "tool_result", data: { text: "WEATHER=[redacted]", count: 3 } },
    });
  });

  it("throws ThreadNotFound for unknown threads", async () => {
    const store = await newStore();
    await assert.rejects(() => store.appendEvents(uuidv7(), [{ type: "error", message: "x" }]), ThreadNotFound);
    await assert.rejects(() => store.listEvents(uuidv7()), ThreadNotFound);
  });
});

describe("event store: bounded pagination", () => {
  it("a bounded page constructs references only for its returned rows", async () => {
    const store = await newStore();
    const thread = await store.createThread();
    await store.appendEvents(
      thread,
      Array.from({ length: 96 }, (_, i) => ({ type: "custom" as const, event_type: "n", payload: i })),
    );
    const history = await store.listEvents(thread);
    for (const tail of [false, true]) {
      let references = 0;
      const original = Array.prototype.map;
      // Count materialized event references while using the public reader, without a timing budget.
      // Restore the built-in before another test can observe this allocation probe.
      Object.defineProperty(Array.prototype, "map", {
        configurable: true,
        writable: true,
        value(this: unknown[], ...args: unknown[]) {
          const values: unknown[] = Reflect.apply(original, this, args);
          for (const value of values) {
            if (value && typeof value === "object" && "threadId" in value && value.threadId === thread) references++;
          }
          return values;
        },
      });
      let page: EventEnvelope[];
      try {
        page = await store.listEvents(thread, { limit: 3, tail });
      } finally {
        Array.prototype.map = original;
      }
      assert.deepEqual(page, tail ? history.slice(-3) : history.slice(0, 3));
      assert.ok(references <= 3, `a three-row page constructed ${references} references (tail=${tail})`);
    }
  });

  it("bounded reads preserve cursor, upper-bound and unusual limit semantics", async () => {
    const store = await newStore();
    const thread = await store.createThread();
    const { events } = await store.appendEvents(
      thread,
      Array.from({ length: 8 }, (_, i) => ({ type: "custom" as const, event_type: "n", payload: i })),
    );
    const after = events[1]?.id;
    const upToInclusive = events[6]?.id;
    assert.ok(after && upToInclusive);
    const range = events.slice(2, 7);
    const cases = [
      { limit: 0, count: 5 },
      { limit: Number.NaN, count: 5 },
      { limit: Number.POSITIVE_INFINITY, count: 5 },
      { limit: -1, count: 0 },
      { limit: Number.NEGATIVE_INFINITY, count: 0 },
      { limit: 0.5, count: 1 },
      { limit: 2.5, count: 3 },
      { limit: 3, count: 3 },
    ];
    for (const { limit, count } of cases) {
      for (const tail of [false, true]) {
        let expected = range.slice(0, count);
        if (tail && count > 0) expected = range.slice(-count);
        const page = await store.listEvents(thread, { after, upToInclusive, limit, tail });
        assert.deepEqual(page, expected, `limit=${limit}, tail=${tail}`);
      }
    }
    assert.deepEqual(await store.listEvents(thread, { after: upToInclusive, upToInclusive: after, limit: 3 }), []);
  });
});

it("bounded head and tail pages keep unreadable placeholders for corrupt or deleted selected bodies", async () => {
  const store = await newStore();
  const thread = await store.createThread();
  await store.appendEvents(
    thread,
    Array.from({ length: 8 }, (_, i) => ({ type: "custom" as const, event_type: "n", payload: i })),
  );
  const history = await store.listEvents(thread);
  const head = history.slice(0, 3);
  const tail = history.slice(-3);
  for (const rows of [head.slice(1), tail.slice(0, 2)]) {
    const [corrupt, missing] = rows;
    assert.ok(corrupt && missing);
    await writeFile(store.eventPath(thread, corrupt.id), "{broken");
    await unlink(store.eventPath(thread, missing.id));
  }
  for (const fromTail of [false, true]) {
    const expected = fromTail ? tail : head;
    const page = await store.listEvents(thread, { limit: 3, tail: fromTail });
    assert.deepEqual(
      page.map((event) => event.id),
      expected.map((event) => event.id),
    );
    const placeholders = page.filter((event) => event.data.type === "error");
    assert.equal(placeholders.length, 2);
    for (const event of placeholders) {
      assert.equal(event.data.type, "error");
      if (event.data.type === "error") assert.match(event.data.message, /unreadable/);
    }
  }
  assert.equal(await store.head(thread), history.at(-1)?.id);
});

describe("event store: read + watch", () => {
  it("paginates with an exclusive cursor and an inclusive upper bound", async () => {
    const store = await newStore();
    const thread = await store.createThread();
    const { events } = await store.appendEvents(
      thread,
      Array.from({ length: 10 }, (_, i) => ({ type: "custom" as const, event_type: "n", payload: i })),
    );
    const after = await store.listEvents(thread, { after: events[4]!.id });
    assert.deepEqual(
      after.map((e) => e.id),
      events.slice(5).map((e) => e.id),
    );

    const upTo = await store.listEvents(thread, { upToInclusive: events[4]!.id });
    assert.equal(upTo.at(-1)!.id, events[4]!.id);

    const limited = await store.listEvents(thread, { limit: 3 });
    assert.equal(limited.length, 3);
  });

  it("replays then streams live events to a watcher", async () => {
    const store = await newStore();
    const thread = await store.createThread();
    await store.appendEvents(thread, [{ type: "error", message: "historic" }]);

    const seen: string[] = [];
    const subscription = store.watch(thread, (e) => seen.push(e.data.type), { replay: true });
    await subscription.ready;
    assert.deepEqual(seen, ["thread_created", "error"], "replay delivers the existing log first");

    await store.appendEvents(thread, [{ type: "error", message: "live" }]);
    assert.deepEqual(seen, ["thread_created", "error", "error"]);

    subscription.close();
    await store.appendEvents(thread, [{ type: "error", message: "after unsubscribe" }]);
    assert.equal(seen.length, 3);
  });

  it("delivers each event exactly once when a write races the replay", async () => {
    const store = await newStore();
    const thread = await store.createThread();
    await store.appendEvents(thread, [{ type: "error", message: "historic" }]);

    const ids: string[] = [];
    const subscription = store.watch(thread, (e) => ids.push(e.id), { replay: true });
    // Append while the replay read is still in flight.
    const racing = store.appendEvents(thread, [{ type: "error", message: "racing" }]);
    await Promise.all([subscription.ready, racing]);

    const logged = (await store.listEvents(thread)).map((e) => e.id);
    assert.deepEqual(ids, logged, "subscriber saw the whole log, in order, with no duplicates");
    subscription.close();
  });

  it("keeps notifying other subscribers when one throws", async () => {
    const store = await newStore();
    const thread = await store.createThread();
    let good = 0;
    store.watch(thread, () => {
      throw new Error("bad subscriber");
    });
    store.watch(thread, () => {
      good++;
    });
    await store.appendEvents(thread, [{ type: "error", message: "x" }]);
    assert.equal(good, 1);
  });
});

describe("event store: fork", () => {
  it("copies exactly the prefix with fresh ids and records lineage — never truncates", async () => {
    const store = await newStore();
    const source = await store.createThread({ title: "original" });
    const { events } = await store.appendEvents(
      source,
      Array.from({ length: 6 }, (_, i) => ({
        type: "messages" as const,
        messages: [{ role: "user" as const, content: `m${i}` }],
      })),
    );
    const cut = events[2]!.id; // keep thread_created + m0..m2
    await store.writeArtifact(source, "memory", { note: "carried" });

    const fork = await store.forkThread(source, cut);
    const forkEvents = await store.listEvents(fork);

    const copied = forkEvents.filter((e) => e.data.type !== "thread_forked");
    assert.equal(copied.length, 4, "thread_created + 3 messages");
    assert.equal(forkEvents.at(-1)!.data.type, "thread_forked");
    assert.deepEqual(
      copied.flatMap((e) => (e.data.type === "messages" ? e.data.messages.map((m) => m.content) : [])),
      ["m0", "m1", "m2"],
    );

    // Fresh ids, rebound thread, no id collision with the source.
    const sourceIds = new Set((await store.listEvents(source)).map((e) => e.id));
    for (const event of forkEvents) {
      assert.equal(event.thread_id, fork);
      assert.ok(!sourceIds.has(event.id), "forked events must be re-ided");
    }

    const forked = forkEvents.at(-1)!.data as { source_thread_id: string; up_to_inclusive: string };
    assert.equal(forked.source_thread_id, source);
    assert.equal(forked.up_to_inclusive, cut);

    // Source is untouched — forking is copy-and-rewrite, never truncate.
    assert.equal((await store.listEvents(source)).length, 8); // created + 6 + artifact_written
    // Artifacts come along so the fork is self-contained.
    assert.deepEqual(await store.readArtifact(fork, "memory"), { note: "carried" });
    const record = await store.getRecord(fork);
    assert.deepEqual(record.parent, { thread_id: source, up_to_inclusive: cut });
    assert.equal(record.latest_event_id, forkEvents.at(-1)!.id);
  });

  it("supports rewind-by-fork of a thread that later went wrong", async () => {
    const store = await newStore();
    const thread = await store.createThread();
    const { events } = await store.appendEvents(thread, [
      { type: "messages", messages: [{ role: "user", content: "good" }] },
      { type: "messages", messages: [{ role: "assistant", content: "also good" }] },
      { type: "error", message: "went wrong here" },
    ]);
    const rewound = await store.forkThread(thread, events[1]!.id, { title: "rewound" });
    const kinds = (await store.listEvents(rewound)).map((e) => e.data.type);
    assert.ok(!kinds.includes("error"));
  });
});

describe("turns: durability rule", () => {
  it("makes input durable before any model call, in one batch", async () => {
    const store = await newStore();
    const turns = new TurnFactory(store, "ses_test");
    const thread = await store.createThread();

    const turn = await turns.beginTurn(thread, { input: [{ role: "user", content: "build pong" }] });
    const events = await store.listEvents(thread);
    const kinds = events.map((e) => e.data.type);
    assert.deepEqual(kinds, ["thread_created", "session_started", "turn_started", "messages"]);
    for (const event of events.slice(1)) {
      assert.equal(event.session_id, "ses_test");
      assert.equal(event.turn_id, turn.turnId);
    }
    assert.equal(turn.latestEventId, events.at(-1)!.id);
  });

  it("opens a session once per thread", async () => {
    const store = await newStore();
    const turns = new TurnFactory(store, "ses_test");
    const thread = await store.createThread();
    const turn1 = await turns.beginTurn(thread, { input: [{ role: "user", content: "a" }] });
    await turn1.end("ok");
    await turns.beginTurn(thread, { input: [{ role: "user", content: "b" }] });
    const kinds = (await store.listEvents(thread)).map((e) => e.data.type);
    assert.equal(kinds.filter((k) => k === "session_started").length, 1);
    assert.equal(kinds.filter((k) => k === "turn_started").length, 2);
  });

  it("resyncs — but does not lose — a turn write that raced another writer", async () => {
    const store = await newStore();
    const turns = new TurnFactory(store, "ses_test");
    const thread = await store.createThread();
    const turn = await turns.beginTurn(thread, { input: [{ role: "user", content: "b" }] });

    // A legitimate interleaved writer: a tool taking a snapshot, the watchdog recording a rewind.
    await store.appendEvents(thread, [{ type: "error", message: "interloper" }]);

    // The turn's own write still lands, after the interloper, and the resync is counted.
    const head = await turn.append([{ type: "error", message: "turn continues" }]);
    assert.equal(turn.resyncs, 1);
    assert.equal(await store.head(thread), head);
    const messages = (await store.listEvents(thread))
      .filter((e) => e.data.type === "error")
      .map((e) => (e.data as { message: string }).message);
    assert.deepEqual(messages, ["interloper", "turn continues"], "order is preserved, nothing is dropped");

    // The strict check is still available on the store for callers that want it.
    await assert.rejects(
      () => store.appendEvents(thread, [{ type: "error", message: "stale" }], { expectedHead: turn.turnId }),
      HeadMismatch,
    );
  });

  it("lands a turn write when another writer also slips in between its resync and the retry", async () => {
    // A Stop: the queue records its pause and its resume while the stopped turn writes its end.
    const root = path.join(await tmpDir(), "exoharness");
    let thread = "";
    let slipIn = true;
    class RacedStore extends EventStore {
      override async appendEvents(...args: Parameters<EventStore["appendEvents"]>) {
        try {
          return await super.appendEvents(...args);
        } catch (err) {
          if (!(err instanceof HeadMismatch) || !slipIn) throw err;
          slipIn = false;
          await super.appendEvents(thread, [{ type: "error", message: "second interloper" }]);
          throw err;
        }
      }
    }
    const store = new RacedStore(root, "studio");
    const turns = new TurnFactory(store, "ses_test");
    thread = await store.createThread();
    const turn = await turns.beginTurn(thread, { input: [{ role: "user", content: "b" }] });
    await store.appendEvents(thread, [{ type: "error", message: "first interloper" }]);

    const head = await turn.end("cancelled");

    assert.equal(await store.head(thread), head);
    const kinds = (await store.listEvents(thread)).map((e) => e.data.type);
    assert.equal(kinds.at(-1), "turn_ended", "the turn ends after both interlopers");
    assert.deepEqual(await findInterruptedTurns(store, thread), []);
  });

  it("exposes turns that never ended (crash detection from the log alone)", async () => {
    const store = await newStore();
    const turns = new TurnFactory(store, "ses_crash");
    const thread = await store.createThread();
    const finished = await turns.beginTurn(thread, { input: [{ role: "user", content: "done" }] });
    await finished.end("ok");
    const interrupted = await turns.beginTurn(thread, { input: [{ role: "user", content: "boom" }] });
    assert.deepEqual(await findInterruptedTurns(store, thread), [interrupted.turnId]);
  });
});

describe("artifacts", () => {
  it("versions artifacts and logs each write", async () => {
    const store = await newStore();
    const thread = await store.createThread();
    assert.equal(await store.readArtifact(thread, "memory"), null);
    assert.equal(await store.writeArtifact(thread, "memory", { v: 1 }), 1);
    assert.equal(await store.writeArtifact(thread, "memory", { v: 2 }), 2);
    assert.deepEqual(await store.readArtifact(thread, "memory"), { v: 2 });
    const versions = await store.listArtifactVersions(thread, "memory");
    assert.deepEqual(
      versions.map((v) => v.version),
      [1, 2],
    );
    const written = (await store.listEvents(thread)).filter((e) => e.data.type === "artifact_written");
    assert.equal(written.length, 2);
  });

  it("names one directory per id — an id from the harness never reaches outside the store", async () => {
    const store = await newStore();
    const thread = await store.createThread();
    for (const id of ["../../../outside", "a/b", "..", ""]) {
      await assert.rejects(store.writeArtifact(thread, id, { v: 1 }), /invalid artifact id/);
      await assert.rejects(store.readArtifact(thread, id), /invalid artifact id/);
    }
    await assert.rejects(store.writeArtifact("../../elsewhere", "memory", { v: 1 }), /invalid thread id/);
    await assert.rejects(readdir(path.join(store.root, "..", "outside")));
    assert.equal(await store.writeArtifact(thread, "autopilot_run_mtq96bu1z3x0", { v: 1 }), 1, "real ids still work");
  });
});
