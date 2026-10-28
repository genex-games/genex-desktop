/**
 * Usage analytics, phase 3 (P4): a refused rewind says why. Main refuses a rewind, its preview and
 * Bring back newer version with a typed code beside the same words (`RewindRefusal`, `RewindBlock`,
 * `UndoRewindRefusal`, a plugin step's `HookRefusal`); the code crosses IPC and reaches
 * `rewind_previewed`, `rewind_decided` and `rewind_undone`. Words, paths and Node codes read as none.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HookBlockedError } from "../../src/main/core/plugin-hooks.ts";
import {
  RewindBlock,
  type RewindFiles,
  RewindRefusal,
  rewindRefusalWords,
  UndoRewindRefusal,
  undoRewindRefusalWords,
} from "../../src/shared/chat-rewind.ts";
import { CustomEvent, customEventData } from "../../src/shared/custom-events.ts";
import { CodedError, errorMessage } from "../../src/shared/errors.ts";
import { type EventData, EventKind } from "../../src/shared/event-log.ts";
import { HookHold, HookRefusal } from "../../src/shared/plugin-hooks.ts";
import {
  rewindCode,
  rewindConfirmedProperties,
  REWIND_UNDONE,
  rewindPreviewProperties,
  rewindUndoFailedProperties,
  undoRewindCode,
} from "../../src/renderer/analytics/chat-properties.ts";
import { RewindFilesState } from "../../src/renderer/analytics/chat-vocabulary.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { assertClean, crossed, HOSTILE_THROWS, refusalOf } from "../helpers/failure-codes.ts";
/** One user message and its answer, queued and handled as the harness records them. */
function answeredMessage(messageId: string): EventData[] {
  return [
    { type: EventKind.Messages, messages: [{ role: "user", content: "Make the orchard autumn." }] },
    customEventData(CustomEvent.CoordinatorMessageQueued, { messageId, action: { text: "Make the orchard autumn." } }),
    customEventData(CustomEvent.CoordinatorMessageProcessing, { messageId }),
    { type: EventKind.Messages, messages: [{ role: "assistant", content: "It is autumn now." }] },
    customEventData(CustomEvent.CoordinatorMessageHandled, { messageId }),
  ];
}

describe("phase 3 analytics: a refused rewind says why", () => {
  it("main refuses a rewind, its preview and its undo with a code beside the same words", async () => {
    const lite = await coreLite();
    const { core } = lite;
    try {
      await core.games.scaffold("orchard");
      const threadId = await core.threadForGame("orchard");
      await core.append(answeredMessage("m-1"), threadId);
      const bubble = (await core.store.listEvents(threadId)).find(
        (event) => event.data.type === EventKind.Messages && event.data.messages.some((m) => m.role === "user"),
      );
      assert.ok(bubble);
      const restarting = await refusalOf(core.rewindPreview(threadId, bubble.id, "m-1"));
      assert.equal(rewindCode(restarting), RewindBlock.Restarting, "a harness that is not up refuses with a code");
      // The rewind asks a harness that runs; this core has none.
      Object.defineProperty(core.host, "state", { configurable: true, get: () => "ready" });
      const gone = await refusalOf(core.rewindPreview(threadId, bubble.id, "m-unknown"));
      assert.equal(rewindCode(gone), RewindRefusal.NotFound);
      assert.equal(errorMessage(gone), rewindRefusalWords(RewindRefusal.NotFound), "the words stay as they were");
      const notInChat = await refusalOf(core.rewindChat(threadId, "not-an-event", "m-1"));
      assert.equal(rewindCode(notInChat), RewindBlock.NotInChat);
      const other = await core.store.createThread({ title: "Notes", metadata: {} });
      const notGame = await refusalOf(core.rewindChat(other, bubble.id, "m-1"));
      assert.equal(rewindCode(notGame), RewindBlock.NotGameChat);
      const notOffered = await refusalOf(core.undoRewind(threadId, "rw-0000000000000000"));
      assert.equal(undoRewindCode(notOffered), UndoRewindRefusal.NotOffered);
      assert.equal(rewindCode(notOffered), null, "an undo's refusal is not a rewind's");
    } finally {
      Reflect.deleteProperty(core.host, "state");
      await lite.close();
    }
  });

  it("rewind_previewed, rewind_decided and rewind_undone carry the refusal's code, never its words", async () => {
    const busy = await crossed(new CodedError(RewindRefusal.Busy, rewindRefusalWords(RewindRefusal.Busy)));
    assert.equal(rewindPreviewProperties(null, busy).code, RewindRefusal.Busy);
    const files: RewindFiles = {
      state: RewindFilesState.Restore,
      files: 2,
      outside: [],
      outsideUnknown: false,
      tooLarge: 0,
      nested: [],
    };
    const choice = { restore: true, restoresByDefault: true, failed: true };
    const blocked = await crossed(new HookBlockedError("Unreal is saving", { hold: HookHold.Busy, label: "Unreal" }));
    assert.equal(rewindConfirmedProperties(files, choice, blocked).code, HookRefusal.Blocked);
    assert.equal(
      rewindConfirmedProperties(files, { ...choice, failed: false }).code,
      undefined,
      "a rewind that went has no code",
    );
    const gone = await crossed(new CodedError(UndoRewindRefusal.Gone, undoRewindRefusalWords(UndoRewindRefusal.Gone)));
    assert.deepEqual(rewindUndoFailedProperties(gone), { ok: false, code: UndoRewindRefusal.Gone });
    assert.deepEqual(REWIND_UNDONE, { ok: true });
    for (const [label, thrown] of HOSTILE_THROWS) {
      const refused = await crossed(thrown);
      assert.equal(rewindPreviewProperties(null, refused).code, null, label);
      assert.equal(rewindConfirmedProperties(files, choice, refused).code, null, label);
      assert.deepEqual(rewindUndoFailedProperties(refused), { ok: false, code: null }, label);
      assertClean(label, rewindUndoFailedProperties(refused));
      assert.deepEqual(rewindUndoFailedProperties(thrown), { ok: false, code: null }, `${label}, as thrown`);
    }
    const rewound = await crossed(new CodedError(RewindRefusal.Busy, "x"));
    assert.equal(undoRewindCode(rewound), null, "a rewind's refusal is not an undo's");
  });
});
