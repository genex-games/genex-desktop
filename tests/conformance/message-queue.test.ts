import assert from "node:assert/strict";
import { test } from "node:test";
import { MESSAGE_ATTEMPTS, MessageQueue, messageQueueState } from "../../src/harness-seed/loop/message-queue.ts";
import { conversationThrough } from "../../src/harness-seed/loop/run-inbox.ts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const until = async (check: () => boolean) => {
  for (let n = 0; n < 1000; n++) {
    if (check()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail("queue did not settle");
};
function fixture() {
  const events: any[] = [],
    artifacts = new Map(),
    notices: any[] = [];
  const host = {
    call: async (method: string, p: any) => {
      if (method === "events.append") {
        for (const data of p.batch) events.push({ id: String(events.length + 1), thread_id: p.threadId, data });
      }
      if (method === "artifact.write") artifacts.set(p.artifactId, p.value);
      if (method === "artifact.read") return artifacts.get(p.artifactId);
    },
    notify: (name: string, payload: any) => notices.push({ name, ...payload }),
  };
  const send = (text: string) => ({ type: "user_message", threadId: "chat", text });
  return { host, events, artifacts, notices, send };
}

test("pending messages are editable in order, removals do not erase neighbors, and held edits survive restart", async () => {
  const f = fixture(),
    first = deferred(),
    started = deferred();
  const seen: string[] = [];
  const queue = new MessageQueue(f.host as never, async (a: any) => {
    seen.push(a.text);
    started.resolve();
    await first.promise;
  });
  await queue.enqueue(f.send("first"));
  await started.promise;
  await queue.enqueue(f.send("change the river"));
  await queue.enqueue(f.send("remove this"));
  await queue.enqueue(f.send("keep the trees"));
  const entries = [...messageQueueState(f.events).messages.values()];
  assert.equal(entries[0].state, "processing");
  assert.equal(entries[1].state, "queued");
  await queue.change("chat", entries[1].messageId, "hold");
  await queue.change("chat", entries[2].messageId, "remove");
  first.resolve();
  await until(() => messageQueueState(f.events).messages.get(entries[0].messageId)?.state === "handled");
  assert.deepEqual(seen, ["first"]);
  queue.stop();
  const restored = new MessageQueue(f.host as never, async (a: any) => {
    seen.push(a.text);
  });
  await restored.restore("chat", f.events);
  assert.deepEqual(seen, ["first"]);
  await restored.change("chat", entries[1].messageId, "edit", "make the river blue");
  await until(() => seen.length === 3);
  assert.deepEqual(seen, ["first", "make the river blue", "keep the trees"]);
  const view = conversationThrough(f.events, entries[1].messageId)
    .filter((e: any) => e.data.type === "messages")
    .flatMap((e: any) => e.data.messages.map((m: any) => m.content));
  assert.deepEqual(view, ["first", "make the river blue"], "no removed, superseded or future text reaches this turn");
  await assert.rejects(restored.change("chat", entries[1].messageId, "edit", "too late"), /already started/);
  restored.stop();
});

test("Stop can interrupt first and drain the oldest follow-up without losing its attachments or later messages", async () => {
  const f = fixture(),
    first = deferred(),
    started = deferred(),
    second = deferred();
  const seen: any[] = [];
  const queue = new MessageQueue(f.host as never, async (a: any) => {
    seen.push(a);
    if (seen.length === 1) {
      started.resolve();
      await first.promise;
    }
    if (seen.length === 2) await second.promise;
  });
  await queue.enqueue(f.send("build"));
  await started.promise;
  await queue.enqueue({ ...f.send("new instruction"), stills: [{ data: "synthetic", mimeType: "image/png" }] });
  await queue.enqueue(f.send("last instruction"));
  await queue.pause("chat");
  first.resolve();
  await until(() => [...messageQueueState(f.events).messages.values()][0].state === "handled");
  assert.equal(seen.length, 1);
  await queue.resume("chat");
  await until(() => seen.length === 2);
  assert.equal(seen[1].text, "new instruction");
  assert.equal(seen[1].stills[0].data, "synthetic");
  assert.equal(seen.length, 2);
  second.resolve();
  await until(() => seen.length === 3);
  queue.stop();
});

test("one chat waiting for a build does not block another chat or editing its queue", async () => {
  const f = fixture(),
    build = deferred();
  const seen: string[] = [];
  const queue = new MessageQueue(
    f.host as never,
    async (a: any) => {
      seen.push(a.text);
    },
    async (thread: string) => {
      if (thread === "chat") await build.promise;
    },
  );
  await queue.enqueue(f.send("waiting"));
  await queue.enqueue({ ...f.send("other chat"), threadId: "other" });
  await until(() => seen.length === 1);
  assert.deepEqual(seen, ["other chat"]);
  const id = [...messageQueueState(f.events).messages.values()].find((m) => m.action!.text === "waiting")!.messageId;
  await queue.change("chat", id, "edit", "updated while building");
  build.resolve();
  await until(() => seen.length === 2);
  assert.deepEqual(seen, ["other chat", "updated while building"]);
  queue.stop();
});

// ── steer: what is sent while the chat's turn works reaches that turn ──

/** A queue host that also answers `engine.steer` (the session's door) and lists the log. */
function steerFixture(steer: (p: any) => any = (p) => ({ how: "native", accepted: p.messages.map((m: any) => m.id) })) {
  const f = fixture(),
    asked: any[] = [];
  const call = f.host.call;
  f.host.call = async (method: string, p: any) => {
    if (method === "engine.steer") {
      asked.push(p);
      return steer(p);
    }
    if (method === "events.list") return f.events;
    return call(method, p);
  };
  const state = (id: string) => messageQueueState(f.events).messages.get(id);
  const idOf = (text: string) =>
    [...messageQueueState(f.events).messages.values()].find((m) => m.action!.text === text)!.messageId;
  const read = (messageId: string, into: string, how = "native") =>
    f.events.push({
      id: String(f.events.length + 1),
      thread_id: "chat",
      data: { type: "custom", event_type: "coordinator_message_delivered", payload: { messageId, into, how } },
    });
  return { ...f, asked, state, idOf, read };
}

test("a message sent while the turn is open goes into it with its receipt and is never answered on its own", async () => {
  const f = steerFixture(),
    open = deferred(),
    release = deferred(),
    seen: string[] = [];
  const queue = new MessageQueue(f.host as never, async (a: any, steer: any) => {
    seen.push(a.text);
    if (a.text !== "build a pond") return;
    await steer.open();
    open.resolve();
    await release.promise;
    for (const m of f.asked.flatMap((p) => p.messages)) f.read(m.id, steer.messageId);
    await steer.close({ steered: f.asked.flatMap((p) => p.messages.map((m: any) => m.id)) });
  });
  await queue.enqueue(f.send("build a pond"));
  await open.promise;
  await queue.enqueue({
    ...f.send("and ducks"),
    stills: [{ label: "duck", mimeType: "image/png", data: "synthetic" }],
  } as never);
  // Recorded with its receipt: the chat never shows it as queued first.
  assert.deepEqual(
    f.events.slice(-3).map((e) => e.data.event_type ?? e.data.type),
    ["messages", "coordinator_message_queued", "coordinator_message_steering"],
  );
  await until(() => f.asked.length === 1);
  const pond = f.idOf("build a pond"),
    ducks = f.idOf("and ducks");
  assert.equal(f.asked[0].into, pond);
  assert.deepEqual(f.asked[0].messages, [
    { id: ducks, text: "and ducks", images: [{ label: "duck", mimeType: "image/png", data: "synthetic" }] },
  ]);
  assert.equal(f.state(ducks)!.state, "steering");
  await assert.rejects(queue.change("chat", ducks, "remove"), /already started/, "handed over: no longer removable");
  release.resolve();
  await until(() => f.state(pond)?.state === "handled");
  assert.equal(f.state(ducks)!.state, "delivered");
  assert.deepEqual(seen, ["build a pond"], "a delivered message gets no turn of its own");
  assert.equal(f.events.filter((e) => e.data.event_type === "coordinator_message_processing").length, 1);
  queue.stop();
});

test("a message whose saved pictures cannot be read is still handed to the running turn, without them", async () => {
  const f = steerFixture(),
    open = deferred(),
    release = deferred();
  const call = f.host.call;
  f.host.call = async (method: string, p: any) => {
    if (method === "artifact.read") throw new Error("the attachments are gone");
    return call(method, p);
  };
  const queue = new MessageQueue(f.host as never, async (a: any, steer: any) => {
    if (a.text !== "build a pond") return;
    await steer.open();
    open.resolve();
    await release.promise;
    for (const m of f.asked.flatMap((p) => p.messages)) f.read(m.id, steer.messageId);
    await steer.close({ steered: f.asked.flatMap((p) => p.messages.map((m: any) => m.id)) });
  });
  await queue.enqueue(f.send("build a pond"));
  await open.promise;
  await queue.enqueue({ ...f.send("and ducks"), attachmentsArtifact: "message_attachments_gone" } as never);
  await until(() => f.asked.length === 1);
  const ducks = f.idOf("and ducks");
  assert.deepEqual(f.asked[0].messages, [{ id: ducks, text: "and ducks" }]);
  release.resolve();
  await until(() => f.state(f.idOf("build a pond"))?.state === "handled");
  assert.equal(f.state(ducks)!.state, "delivered", "never left Sending… until a restart");
  queue.stop();
});

test("what the session did not read waits again in the order it was sent, and a refusing session stops being offered messages", async () => {
  const unread = steerFixture(),
    open = deferred(),
    release = deferred(),
    seen: string[] = [];
  const queue = new MessageQueue(unread.host as never, async (a: any, steer: any) => {
    seen.push(a.text);
    if (a.text !== "first") return;
    await steer.open();
    open.resolve();
    await release.promise;
    await steer.close({ steered: [] }); // the turn ended before its next step
  });
  await queue.enqueue(unread.send("first"));
  await open.promise;
  await queue.enqueue(unread.send("second"));
  await queue.enqueue(unread.send("third"));
  await until(() => unread.asked.length === 2);
  release.resolve();
  await until(() => seen.length === 3);
  assert.deepEqual(seen, ["first", "second", "third"]);
  assert.deepEqual(
    ["second", "third"].map((t) => unread.state(unread.idOf(t))!.state),
    ["handled", "handled"],
  );
  queue.stop();

  const refused = steerFixture(() => ({ how: null, accepted: [] })),
    open2 = deferred(),
    release2 = deferred(),
    seen2: string[] = [];
  const q2 = new MessageQueue(refused.host as never, async (a: any, steer: any) => {
    seen2.push(a.text);
    if (a.text !== "first") return;
    await steer.open();
    open2.resolve();
    await release2.promise;
    await steer.close({});
  });
  await q2.enqueue(refused.send("first"));
  await open2.promise;
  await q2.enqueue(refused.send("second"));
  await until(() => refused.state(refused.idOf("second"))?.state === "queued" && refused.asked.length === 1);
  await q2.enqueue(refused.send("third"));
  assert.equal(refused.asked.length, 1, "a session that refused is not asked again this turn");
  release2.resolve();
  await until(() => seen2.length === 3);
  assert.deepEqual(seen2, ["first", "second", "third"]);
  q2.stop();
});

test("messages waiting from before the turn keep their own turns, and nothing steers while a build runs", async () => {
  const f = steerFixture(),
    gate = deferred(),
    open = deferred(),
    release = deferred(),
    seen: string[] = [];
  let building = true;
  const queue = new MessageQueue(
    f.host as never,
    async (a: any, steer: any) => {
      seen.push(a.text);
      if (a.text !== "first") return;
      await steer.open();
      open.resolve();
      await release.promise;
      await steer.close({ steered: [] });
    },
    async () => {
      if (building) await gate.promise;
    },
    () => !building,
  );
  await queue.enqueue(f.send("first"));
  await queue.enqueue(f.send("sent during the build"));
  building = false;
  gate.resolve();
  await open.promise;
  await queue.enqueue(f.send("sent during the reply"));
  assert.equal(f.asked.length, 0, "older input waits ahead: the new message is not steered past it");
  release.resolve();
  await until(() => seen.length === 3);
  assert.deepEqual(seen, ["first", "sent during the build", "sent during the reply"]);
  queue.stop();

  const g = steerFixture(),
    open2 = deferred(),
    release2 = deferred();
  const q2 = new MessageQueue(
    g.host as never,
    async (a: any, steer: any) => {
      if (a.text !== "first") return;
      await steer.open();
      open2.resolve();
      await release2.promise;
      await steer.close({});
    },
    async () => {},
    () => false,
  );
  await q2.enqueue(g.send("first"));
  await open2.promise;
  await q2.enqueue(g.send("during a build"));
  assert.equal(g.asked.length, 0);
  assert.equal(g.state(g.idOf("during a build"))!.state, "queued");
  release2.resolve();
  await until(() => g.state(g.idOf("during a build"))?.state === "handled");
  q2.stop();
});

test("Stop returns what the session had not read to the front of the queue, and the next turn takes it", async () => {
  const f = steerFixture(),
    open = deferred(),
    release = deferred(),
    seen: string[] = [];
  const queue = new MessageQueue(f.host as never, async (a: any, steer: any) => {
    seen.push(a.text);
    if (a.text !== "first") return;
    await steer.open();
    open.resolve();
    await release.promise;
    await steer.close({ ok: false, stopReason: "stopped", steered: [] });
  });
  await queue.enqueue(f.send("first"));
  await open.promise;
  await queue.enqueue(f.send("add fireflies"));
  await until(() => f.asked.length === 1);
  await queue.pause("chat");
  release.resolve();
  await until(() => f.state(f.idOf("first"))?.state === "handled");
  assert.equal(f.state(f.idOf("add fireflies"))!.state, "queued");
  assert.deepEqual(seen, ["first"]);
  await queue.resume("chat");
  await until(() => seen.length === 2);
  assert.deepEqual(seen, ["first", "add fireflies"]);
  queue.stop();
});

/** A log written by an earlier harness: `receive` saves a message, `append` any queue record. */
function writtenLog(f: ReturnType<typeof steerFixture>) {
  const append = (event_type: string, payload: any) =>
    f.events.push({
      id: String(f.events.length + 1),
      thread_id: "chat",
      data: { type: "custom", event_type, payload },
    });
  const receive = (messageId: string, text: string, extra: any = {}) => {
    f.events.push({
      id: String(f.events.length + 1),
      thread_id: "chat",
      data: { type: "messages", messages: [{ role: "user", content: text }] },
    });
    append("coordinator_message_queued", {
      messageId,
      action: { type: "user_message", threadId: "chat", text, messageId, ...extra },
    });
  };
  return { append, receive };
}

test("restart: a message handed over but unread runs on its own; one read by a cut-short turn rides with that turn again, once", async () => {
  const f = steerFixture();
  const { append, receive } = writtenLog(f);
  receive("a", "build a pond");
  append("coordinator_message_processing", { messageId: "a" });
  receive("b", "and ducks", { attachmentsArtifact: "message_attachments_b", imageCount: 1 });
  append("coordinator_message_steering", { messageId: "b", into: "a" });
  append("coordinator_message_delivered", { messageId: "b", into: "a", how: "native" });
  receive("c", "make it run");
  append("coordinator_message_steering", { messageId: "c", into: "a" });
  f.artifacts.set("message_attachments_b", { stills: [{ label: "duck", mimeType: "image/png", data: "synthetic" }] });
  const turns: any[] = [];
  const queue = new MessageQueue(f.host as never, async (a: any, steer: any) => {
    turns.push({ text: a.text, carried: steer.carried.map((m: any) => ({ text: m.text, stills: m.stills })) });
  });
  await queue.restore("chat", f.events);
  await until(() => turns.length === 2);
  assert.deepEqual(turns, [
    {
      text: "build a pond",
      carried: [{ text: "and ducks", stills: [{ label: "duck", mimeType: "image/png", data: "synthetic" }] }],
    },
    { text: "make it run", carried: [] },
  ]);
  await until(() => f.state("c")?.state === "handled");
  assert.equal(f.state("b")!.state, "delivered", "delivered once: never requeued or answered on its own");
  queue.stop();
  const again = new MessageQueue(f.host as never, async (a: any) => {
    turns.push(a.text);
  });
  await again.restore("chat", f.events);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(turns.length, 2, "a finished turn and what it read are never replayed");
  again.stop();
});

test("restart: a turn cut off twice is not retried, and what it had read settles with it instead of being asked again", async () => {
  const f = steerFixture();
  const { append, receive } = writtenLog(f);
  receive("a", "build a pond");
  append("coordinator_message_processing", { messageId: "a" });
  append("coordinator_message_requeued", { messageId: "a", attempts: 1 });
  append("coordinator_message_processing", { messageId: "a", attempt: 2 });
  receive("b", "and ducks");
  append("coordinator_message_steering", { messageId: "b", into: "a" });
  append("coordinator_message_delivered", { messageId: "b", into: "a", how: "native" });
  assert.equal(f.state("a")!.attempts, MESSAGE_ATTEMPTS, "cut off on its retry");
  const before = f.events.length,
    seen: string[] = [];
  const queue = new MessageQueue(f.host as never, async (a: any) => {
    seen.push(a.text);
  });
  await queue.restore("chat", f.events);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, [], "neither the turn nor what it had read is answered again");
  assert.deepEqual(
    f.events.slice(before).map((e) => [e.data.event_type, e.data.payload]),
    [["coordinator_message_handled", { messageId: "a", interrupted: true, attempts: MESSAGE_ATTEMPTS }]],
    "the read message is neither requeued nor carried",
  );
  assert.deepEqual([f.state("a")!.state, f.state("b")!.state], ["handled", "delivered"]);
  queue.stop();
});

test("a restart replay that reaches a chat after a new turn began keeps its messages out of that turn", async () => {
  const f = steerFixture();
  const { append, receive } = writtenLog(f);
  receive("cut", "build a pond");
  append("coordinator_message_processing", { messageId: "cut" });
  receive("read", "and ducks");
  append("coordinator_message_delivered", { messageId: "read", into: "cut", how: "native" });
  const before = [...f.events];
  const open = deferred(),
    release = deferred(),
    prompts: any[] = [];
  const queue = new MessageQueue(f.host as never, async (a: any, steer: any) => {
    if (a.text === "hello?") {
      await steer.expect();
      open.resolve();
      await release.promise;
      prompts.push({ text: a.text, joined: (await steer.open()).map((m: any) => m.text) });
      await steer.close({});
      return;
    }
    prompts.push({ text: a.text, carried: steer.carried.map((m: any) => m.text) });
  });
  await queue.enqueue(f.send("hello?"));
  await open.promise; // typed before the replay reached this chat
  await queue.restore("chat", before);
  release.resolve();
  await until(() => prompts.length === 2);
  assert.deepEqual(
    prompts,
    [
      { text: "hello?", joined: [] },
      { text: "build a pond", carried: ["and ducks"] },
    ],
    "the cut-short turn is answered on its own, with what it had read",
  );
  queue.stop();
});

test("removing a replayed turn before it runs gives what it had read a turn of its own", async () => {
  const f = steerFixture();
  const { append, receive } = writtenLog(f);
  receive("cut", "build a pond");
  append("coordinator_message_processing", { messageId: "cut" });
  receive("read", "and ducks");
  append("coordinator_message_delivered", { messageId: "read", into: "cut", how: "native" });
  append("coordinator_queue_paused", {});
  const seen: string[] = [];
  const queue = new MessageQueue(f.host as never, async (a: any) => {
    seen.push(a.text);
  });
  await queue.restore("chat", f.events);
  await queue.change("chat", "cut", "remove");
  await queue.resume("chat");
  await until(() => seen.length === 1);
  assert.deepEqual(seen, ["and ducks"]);
  await until(() => f.state("read")?.state === "handled");
  queue.stop();
});

test("a message handed over as its turn ends still gets an answer: it waits and the queue runs it", async () => {
  const f = steerFixture(),
    open = deferred(),
    slow = deferred(),
    seen: string[] = [];
  let appends = 0;
  const call = f.host.call;
  f.host.call = async (method: string, p: any) => {
    // The second message's receipt is slow to write: the running leg ends meanwhile.
    if (method === "events.append" && p.batch.some((e: any) => e.type === "messages") && ++appends === 2)
      await slow.promise;
    return call(method, p);
  };
  let leg: any = null;
  const queue = new MessageQueue(f.host as never, async (a: any, steer: any) => {
    seen.push(a.text);
    if (a.text !== "first") return;
    await steer.open();
    leg = steer;
    open.resolve();
    await until(() => appends === 2);
    await steer.close({ steered: [] });
  });
  await queue.enqueue(f.send("first"));
  await open.promise;
  const sending = queue.enqueue(f.send("second"));
  await until(() => f.state(f.idOf("first"))?.state === "handled" || appends === 2);
  slow.resolve();
  await sending;
  await until(() => seen.length === 2);
  assert.deepEqual(seen, ["first", "second"]);
  assert.ok(leg);
  queue.stop();
});

test("a message that joins as the turn ends still gets an answer: joining closes inside the queue before the turn settles", async () => {
  const f = steerFixture(),
    expecting = deferred(),
    slow = deferred(),
    seen: string[] = [];
  let receipts = 0;
  const call = f.host.call;
  f.host.call = async (method: string, p: any) => {
    // The second message's receipt is still being written when the first turn ends.
    if (method === "events.append" && p.batch.some((e: any) => e.type === "messages") && ++receipts === 2)
      await slow.promise;
    return call(method, p);
  };
  const queue = new MessageQueue(f.host as never, async (a: any, steer: any) => {
    seen.push(a.text);
    if (a.text === "first") {
      await steer.expect();
      expecting.resolve();
      await until(() => receipts === 2);
    }
  });
  await queue.enqueue(f.send("first"));
  await expecting.promise;
  const sending = queue.enqueue(f.send("second"));
  await until(() => receipts === 2);
  setTimeout(() => slow.resolve(), 20);
  await sending;
  await until(() => seen.length === 2);
  assert.deepEqual(seen, ["first", "second"]);
  await until(() => f.state(f.idOf("second"))?.state === "handled");
  queue.stop();
});

test("an intake message with other commission settings waits for its own turn instead of joining", async () => {
  const { steersInto } = await import("../../src/harness-seed/loop/message-queue.ts");
  const turn = { engine: "claude-code", autopilot: { hours: 8 } };
  assert.equal(
    steersInto({ text: "more trees", engine: "claude-code", autopilot: { hours: 8, frames: [] } }, turn),
    true,
  );
  assert.equal(
    steersInto({ text: "make it 2 hours", engine: "claude-code", autopilot: { hours: 2 } }, turn),
    false,
    "the hours would be dropped",
  );
  assert.equal(
    steersInto({ text: "review first", engine: "claude-code", autopilot: { hours: 8, reviewPlan: true } }, turn),
    false,
  );
  assert.equal(steersInto({ text: "hi", engine: "claude-code" }, turn), false, "not an intake message");
  assert.equal(
    steersInto({ text: "hi", engine: "claude-code", effort: "high" }, { engine: "claude-code" }),
    true,
    "effort matters only to a commission",
  );
  assert.equal(
    steersInto({ text: "/compact now", engine: "claude-code" }, { engine: "claude-code" }),
    false,
    "slash text is a command, never words for the turn",
  );
});

/**
 * Live chat during a build: while a run's lead takes the chat (director/wake.ts), a message is
 * handed to it with its receipt — recorded delivered to the run, with the records the lead reads
 * it from — instead of waiting as Queued for the build to end. What the lead does not take (a
 * picture, a New build) keeps its place and waits, and nothing sent after it is handed past it.
 */
function leadDoor(into: string, handed: string[], open: () => boolean = () => true): any {
  return {
    into,
    open,
    records: (item: any) => [
      { event_type: "run_steering", payload: { runId: into, text: item.text, sourceMessageId: item.messageId } },
    ],
    handed: (item: any) => handed.push(item.text),
  };
}
const kinds = (events: any[]) => events.map((e) => e.data.event_type ?? e.data.type);

test("a message sent while a run's lead takes the chat is delivered to it with its receipt: never Queued, never answered on its own", async () => {
  const f = fixture(),
    handed: string[] = [],
    seen: string[] = [];
  const door = leadDoor("run_1", handed);
  const queue = new MessageQueue(
    f.host as never,
    async (a: any) => {
      seen.push(a.text);
    },
    async () => {},
    () => false,
    (threadId: string, action: any) => (threadId === "chat" && !action.stills ? door : null),
  );
  await queue.enqueue(f.send("is the sky dusk yet?"));
  assert.deepEqual(
    kinds(f.events),
    ["messages", "coordinator_message_queued", "coordinator_message_delivered", "run_steering"],
    "one receipt: the words, the queue record, the hand-over and what the lead reads",
  );
  const [message] = messageQueueState(f.events).messages.values();
  assert.equal(message!.state, "delivered");
  assert.equal(message!.into, "run_1", "delivered to the run whose lead takes it");
  assert.equal(f.events[2].data.payload.how, "lead");
  assert.deepEqual(f.events[3].data.payload, {
    runId: "run_1",
    text: "is the sky dusk yet?",
    sourceMessageId: message!.messageId,
  });
  assert.deepEqual(handed, ["is the sky dusk yet?"], "the lead is told once the records are written");
  assert.ok(f.notices.some((n) => n.name === "coordinator.delivered"));
  // One the lead does not take waits as Queued, as before.
  await queue.enqueue({ ...f.send("look at this"), stills: [{ data: "synthetic", mimeType: "image/png" }] });
  await until(() => seen.length === 1);
  assert.deepEqual(seen, ["look at this"], "the handed message never had a turn of its own");
  queue.stop();
});

test("messages that waited for the lead are handed to it in order once it takes the chat; one it does not take keeps its place until the build closes, and holds nothing back", async () => {
  const f = fixture(),
    handed: string[] = [],
    seen: string[] = [],
    waitedWith: string[] = [];
  let live = false;
  let closed = false;
  let changed = deferred();
  const takes = (action: any) => !action.stills;
  const door = leadDoor("run_1", handed, () => live);
  const bump = () => {
    const was = changed;
    changed = deferred();
    was.resolve();
  };
  const queue = new MessageQueue(
    f.host as never,
    async (a: any) => {
      seen.push(a.text);
    },
    // The build holds the chat until it closes, unless its lead takes the next message.
    async (_threadId: string, next?: any) => {
      waitedWith.push(next?.text);
      for (;;) {
        if (closed) return undefined;
        if (live && next && takes(next)) return door;
        await changed.promise;
      }
    },
    () => false,
    (_threadId: string, action: any) => (live && takes(action) ? door : null),
  );
  await queue.enqueue(f.send("first, while the run prepares"));
  await queue.enqueue(f.send("second"));
  const state = () => [...messageQueueState(f.events).messages.values()].map((m) => m.state);
  assert.deepEqual(state(), ["queued", "queued"], "no lead yet: they wait");
  live = true;
  bump();
  await until(() => handed.length === 2);
  assert.deepEqual(handed, ["first, while the run prepares", "second"], "handed in the order sent");
  assert.deepEqual(state(), ["delivered", "delivered"]);
  assert.deepEqual(seen, []);

  await queue.enqueue({ ...f.send("a picture"), stills: [{ data: "synthetic", mimeType: "image/png" }] });
  await queue.enqueue(f.send("after the picture"));
  // Flipped (review of live chat): a message the lead does not take no longer holds every later one
  // away from it until the run closes. It keeps its place and waits; plain words after it still
  // reach the lead, in the order they were sent among themselves.
  assert.deepEqual(state().slice(2), ["queued", "delivered"], "handed to the lead past the picture that waits");
  assert.equal(waitedWith.at(-1), "a picture", "the wait is for the message at the front");
  live = false;
  closed = true;
  bump();
  await until(() => seen.length === 1);
  assert.deepEqual(seen, ["a picture"], "once the build closes, the picture gets a turn of its own");
  assert.deepEqual(handed, ["first, while the run prepares", "second", "after the picture"]);
  queue.stop();
});

test("messages a run's lead never heard come back when its run ends: Queued again, each answered in order", async () => {
  const f = fixture(),
    seen: string[] = [];
  let giveBack: (items: any[]) => Promise<void> = async () => {};
  const handedItems: any[] = [];
  let leadTakes = true;
  let building = true;
  let closed = () => {};
  const closes = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const door: any = {
    into: "run_1",
    open: () => leadTakes,
    records: () => [],
    handed: (item: any, back: typeof giveBack) => {
      handedItems.push(item);
      giveBack = back;
    },
  };
  const queue = new MessageQueue(
    f.host as never,
    async (a: any) => {
      seen.push(a.text);
    },
    async () => {
      if (building) await closes;
    },
    () => false,
    () => (leadTakes ? door : null),
  );
  await queue.enqueue(f.send("add fog"));
  await queue.enqueue(f.send("and rain"));
  const state = () => [...messageQueueState(f.events).messages.values()].map((m) => m.state);
  assert.deepEqual(state(), ["delivered", "delivered"]);
  // Stop: the run ends before its lead heard either; they go back, and wait for the build to close.
  leadTakes = false;
  await giveBack(handedItems);
  assert.deepEqual(state(), ["queued", "queued"], "Queued again, in the order they were sent");
  assert.deepEqual(seen, []);
  building = false;
  closed();
  await until(() => seen.length === 2);
  assert.deepEqual(seen, ["add fog", "and rain"], "the oldest first, each a turn of its own");
  await until(() => state().every((s) => s === "handled"));
  queue.stop();
});
