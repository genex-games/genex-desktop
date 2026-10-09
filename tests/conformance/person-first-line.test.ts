/**
 * While the agent's work waits for the person to finish in an app a plugin guards, the chat's
 * working line says so in plain words, and goes back to what the work says once the wait ends.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { busyLabel } from "../../src/renderer/chat/chat-work-state.ts";
import { initialThreads, personFirstLabel, personFirstReported } from "../../src/renderer/state/threads.ts";
import { PERSON_FIRST_WORDS } from "../../src/renderer/words.ts";

it("keeps, per chat, what the person is waited on in, and forgets it when the wait ends", () => {
  const waiting = personFirstReported(initialThreads(), {
    project: "valley",
    threadId: "t1",
    label: "Unreal",
    waiting: true,
  });
  assert.equal(personFirstLabel(waiting, "t1"), "Unreal");
  assert.equal(personFirstLabel(waiting, "t2"), null, "another chat waits for nothing");
  const done = personFirstReported(waiting, { project: "valley", threadId: "t1", label: "Unreal", waiting: false });
  assert.equal(personFirstLabel(done, "t1"), null);
  assert.equal(personFirstLabel(done, null), null);
});

it("ignores a wait it cannot place or name", () => {
  const start = initialThreads();
  const rows: Array<[string, Record<string, unknown>]> = [
    ["no chat", { project: "valley", label: "Unreal", waiting: true }],
    ["no label", { project: "valley", threadId: "t1", waiting: true }],
    ["an empty label", { project: "valley", threadId: "t1", label: "  ", waiting: true }],
    ["a label that is no text", { project: "valley", threadId: "t1", label: 7, waiting: true }],
    ["a chat named __proto__", { project: "valley", threadId: "__proto__", label: "Unreal", waiting: true }],
  ];
  for (const [name, payload] of rows) {
    const next = personFirstReported(start, payload as never);
    assert.equal(next, start, name);
  }
});

it("the working line says the work waits for the person, unless something nearer to them says more", () => {
  const base = { stopping: false, sending: false, questionsWaiting: false, revisingPlan: false, current: "Painting" };
  assert.equal(PERSON_FIRST_WORDS.waiting("Unreal"), "Waiting for you to finish in Unreal");
  assert.equal(busyLabel({ ...base, personFirst: "Unreal" }), "Waiting for you to finish in Unreal");
  assert.equal(busyLabel({ ...base, personFirst: null }), "Painting");
  assert.equal(
    busyLabel({ ...base, personFirst: "Unreal", questionsWaiting: true }),
    busyLabel({ ...base, questionsWaiting: true }),
  );
  assert.equal(busyLabel({ ...base, personFirst: "Unreal", stopping: true }), busyLabel({ ...base, stopping: true }));
  assert.equal(
    busyLabel({ ...base, personFirst: "Unreal", sending: true }),
    busyLabel({ ...base, sending: true }),
    "a message on its way says so first",
  );
  assert.equal(
    busyLabel({ ...base, personFirst: "Unreal", revisingPlan: true }),
    "Waiting for you to finish in Unreal",
    "the wait on the person comes before a plan being revised",
  );
});
