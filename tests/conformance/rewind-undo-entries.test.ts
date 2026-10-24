/**
 * A Rewind that put game files back leaves one line in the chat, with Bring back newer version
 * while the chat offers it: on the newest rewind only, until a message is sent after it, and once.
 * Once taken, the line says the game is back and the chat stays rewound. The button sends the
 * chat's own call, and a refusal reaches the person as a problem.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EntryAction, EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { bringBackNewer } from "../../src/renderer/chat/rewind-undo.ts";
import { ToastTone } from "../../src/renderer/state/toasts.ts";
import { CustomEvent, customEventData } from "../../src/shared/custom-events.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const event = (id: number, data: EventData): EventEnvelope => ({
  id: String(id).padStart(6, "0"),
  thread_id: "t1",
  turn_id: null,
  session_id: null,
  created_at: new Date(id).toISOString(),
  data,
});
const rewound = (id: number, files: number | null, rewindId?: string) =>
  event(
    id,
    customEventData(CustomEvent.ConversationRewound, {
      messageId: "m",
      from: "000001",
      through: "000002",
      hide: [],
      files,
      ...(rewindId ? { rewindId } : {}),
    }),
  );
const user = (id: number) => event(id, { type: "messages", messages: [{ role: "user", content: "Add a moat." }] });
const back = (id: number, rewindId: string) =>
  event(id, customEventData(CustomEvent.ConversationRewindUndone, { rewindId, files: 2 }));
const ONE = "mabc1-0123abcd";
const TWO = "mabc2-4567cdef";

const lines = (events: EventEnvelope[]) =>
  toEntries(events).flatMap((entry) =>
    entry.kind === EntryKind.Action && entry.action === EntryAction.Rewound ? [entry] : [],
  );

describe("a rewind's line in the chat", () => {
  it("says how many files went back, and offers the newer version", () => {
    const [line] = lines([rewound(3, 2, ONE)]);
    assert.equal(line?.text, "The chat went back, and 2 game files with it.");
    assert.equal(line?.rewindUndo, ONE);
    assert.equal(lines([rewound(3, 1, ONE)])[0]?.text, "The chat went back, and 1 game file with it.");
  });

  it("is not drawn for a rewind that put no files back", () => {
    assert.deepEqual(lines([rewound(3, null)]), []);
    assert.deepEqual(lines([rewound(3, 0)]), []);
  });

  it("offers it on the newest rewind only", () => {
    const [older, newer] = lines([rewound(3, 2, ONE), rewound(6, 1, TWO)]);
    assert.equal(older?.rewindUndo, undefined);
    assert.equal(newer?.rewindUndo, TWO);
    const [first] = lines([rewound(3, 2, ONE), rewound(6, null)]);
    assert.equal(first?.rewindUndo, undefined, "a newer rewind without files ends it too");
  });

  it("offers it until a message is sent after it", () => {
    const [line] = lines([rewound(3, 2, ONE), user(4)]);
    assert.ok(line);
    assert.equal(line.rewindUndo, undefined);
    assert.equal(line.outcome, undefined);
  });

  it("says what it did once taken, and offers it no more", () => {
    const [line] = lines([rewound(3, 2, ONE), back(4, ONE)]);
    assert.equal(line?.rewindUndo, undefined);
    assert.equal(line?.outcome, "The game is back as it was before the rewind. The chat stays rewound.");
  });
});

describe("Bring back newer version", () => {
  it("sends the chat's call for that rewind", async () => {
    const studio = fakeStudioApi();
    const notes: string[] = [];
    assert.equal(await bringBackNewer(studio.api, { threadId: "t1", rewindId: ONE }, (text) => notes.push(text)), true);
    assert.deepEqual(studio.callsOf("undoRewind"), [["t1", ONE]]);
    assert.deepEqual(notes, []);
  });

  it("tells the person when it is refused", async () => {
    const studio = fakeStudioApi();
    studio.stub("undoRewind", async () => {
      throw new Error("The newer version is already back.");
    });
    const notes: Array<[string, ToastTone | undefined]> = [];
    const done = await bringBackNewer(studio.api, { threadId: "t1", rewindId: ONE }, (text, tone) =>
      notes.push([text, tone]),
    );
    assert.equal(done, false);
    assert.deepEqual(notes, [["The newer version is already back.", ToastTone.Error]]);
  });
});
