/**
 * While the agent's work waits for the person to finish in an app a plugin guards, the chat's
 * working line says so in plain words, and goes back to what the work says once the wait ends.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { busyLabel, chatWorkState, runCaption } from "../../src/renderer/chat/chat-work-state.ts";
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

it("a chat waiting on the person in two apps keeps saying so until both waits end, whichever ends first", () => {
  const wait = (state: ReturnType<typeof initialThreads>, label: string, waiting: boolean) =>
    personFirstReported(state, { project: "valley", threadId: "t1", label, waiting });
  const both = wait(wait(initialThreads(), "Unreal", true), "Desk", true);
  assert.equal(personFirstLabel(both, "t1"), "Unreal", "the first wait is named");
  const deskEnded = wait(both, "Desk", false);
  assert.equal(personFirstLabel(deskEnded, "t1"), "Unreal", "the Unreal wait goes on");
  assert.equal(personFirstLabel(wait(deskEnded, "Unreal", false), "t1"), null);
  const unrealEnded = wait(both, "Unreal", false);
  assert.equal(personFirstLabel(unrealEnded, "t1"), "Desk", "the Desk wait goes on and is named");
  assert.equal(personFirstLabel(wait(unrealEnded, "Desk", false), "t1"), null);
  const start = initialThreads();
  assert.equal(wait(start, "Desk", false), start, "the end of a wait never told changes nothing");
});

it("while a build runs in the chat, its one line says the work waits for the person", () => {
  const state = chatWorkState({
    status: "",
    run: null,
    activeRunId: "run-1",
    busy: false,
    sending: false,
    answering: false,
    working: true,
    planWorking: false,
    revisingPlan: false,
    stopping: false,
    questionsWaiting: false,
    readingEntries: [],
    streamingReply: false,
  });
  assert.equal(state.chatWorking, false, "a running build shows its card, not the chat's busy line");
  const caption = "Building the track";
  assert.equal(runCaption({ running: true, caption, personFirst: "Unreal" }), "Waiting for you to finish in Unreal");
  assert.equal(runCaption({ running: true, caption, personFirst: null }), caption);
  assert.equal(runCaption({ running: false, caption, personFirst: "Unreal" }), "", "no build, no build line");
});
