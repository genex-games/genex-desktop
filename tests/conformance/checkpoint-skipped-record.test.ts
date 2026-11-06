/**
 * Files a chat checkpoint leaves out for their size: Genex's own `checkpoint_skipped` record names
 * them in the chat, written by the studio only, and no delegated session is told of them. Nothing a
 * session can do brings them back, and the person already reads Genex's line.
 */
import assert from "node:assert/strict";
import { truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { CHECKPOINT_CHANGE_MAX_BYTES, CHECKPOINT_FILE_MAX_BYTES } from "../../src/main/chat-checkpoints.ts";
import { CHECKPOINT_SKIPPED_FILES_LISTED, SkippedBy } from "../../src/shared/chat-rewind.ts";
import { CustomEvent, customEvent, customEventData } from "../../src/shared/custom-events.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";

type Api = Record<string, (input: unknown) => Promise<unknown>>;

const KB = 1024;

/** Poll until `predicate` holds. */
async function until(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Everything a delegated session read: its system text, Genex's notices and the prompt. */
function everythingRead(request: DelegateRequest): string {
  return [request.system ?? "", ...(request.notices ?? []), request.prompt].join("\n\n");
}

describe("files too large to save: the chat's record, never a session's notice", () => {
  let lite: CoreLite;
  let api: Api;
  let threadId: string;
  let otherThread: string;
  const project = "unsaved";
  const other = "unsaved-other";
  const read: string[] = [];
  /** Whether the next delegated session fails (its engine answers `ok: false`). */
  let failNext = false;

  before(async () => {
    lite = await coreLite();
    api = lite.api() as unknown as Api;
    await lite.core.games.scaffold(project);
    await lite.core.games.scaffold(other);
    threadId = await lite.core.createGameThread(project);
    otherThread = await lite.core.createGameThread(other);
    lite.core.engines.register({
      id: "claude-code",
      label: "fixture",
      kind: "delegated",
      compactsNatively: true,
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        read.push(everythingRead(request));
        const ok = !failNext;
        failNext = false;
        return { ok, engine: "claude-code", summary: "fixture", turns: 1, usage: {}, sessionId: "s1" };
      },
    } as never);
  });

  after(async () => {
    await lite.close();
  });

  /** One of the core's harness calls, by its method name. */
  const call = (method: string, input: unknown): Promise<unknown> => {
    const handler = api[method];
    assert.ok(handler, method);
    return handler(input);
  };
  const delegate = (thread = threadId, game = project) =>
    call("engine.delegate", { engine: "claude-code", project: game, threadId: thread, prompt: "Build it" });

  it("the chat names a file a checkpoint left out, and no session that follows is told of it", async () => {
    const big = path.join(lite.core.games.dirFor(project), "big.bin");
    await writeFile(big, "");
    await truncate(big, CHECKPOINT_FILE_MAX_BYTES + 1);
    // The chat's queue starts answering a message: its checkpoint leaves the big file out.
    await call("events.append", {
      threadId,
      batch: [customEventData(CustomEvent.CoordinatorMessageProcessing, { messageId: "msg_one" })],
    });
    await until(
      async () =>
        (await lite.core.store.listEvents(threadId)).some((event) => customEvent(event, CustomEvent.CheckpointSkipped)),
      "the chat's line about the file",
    );
    const [record] = (await lite.core.store.listEvents(threadId))
      .map((event) => customEvent(event, CustomEvent.CheckpointSkipped))
      .filter((payload) => payload !== null);
    assert.equal(record?.by, SkippedBy.Checkpoint);
    assert.deepEqual(
      record?.files,
      [{ file: "big.bin", bytes: CHECKPOINT_FILE_MAX_BYTES + 1 }],
      "Genex's line names it",
    );

    await call("engine.delegate", {
      engine: "claude-code",
      project,
      threadId,
      prompt: "",
      compact: true,
      resume: "s1",
    });
    await delegate(otherThread, other);
    failNext = true;
    await delegate().catch(() => null);
    await delegate();
    await delegate();
    assert.equal(read.length, 5, "every session ran");
    // Flipped: the thread's next sessions read "Genex couldn't save these files at its checkpoint
    // (too large), so Rewind can't bring them back: big.bin (50 MB)." until one settled, and an
    // agent repeated it to the person, who had already read Genex's line.
    for (const [n, text] of read.entries()) {
      assert.ok(text.includes("Build it") || n === 0, `session ${n} read its prompt`);
      assert.doesNotMatch(text, /big\.bin|Rewind can't bring/, `session ${n} is told nothing of the file`);
    }
  });

  it("the chat's record lists the fifty largest files, the count of all and the limits", async () => {
    const project = "unsaved-many";
    await lite.core.games.scaffold(project);
    const thread = await lite.core.createGameThread(project);
    const dir = lite.core.games.dirFor(project);
    // Sparse: each is past the size a checkpoint keeps and costs no disk.
    const count = CHECKPOINT_SKIPPED_FILES_LISTED + 1;
    for (let n = 0; n < count; n++) {
      const file = path.join(dir, `big-${String(n).padStart(2, "0")}.bin`);
      await writeFile(file, "");
      await truncate(file, CHECKPOINT_FILE_MAX_BYTES + 1 + ((n * 7) % count) * KB);
    }
    await call("events.append", {
      threadId: thread,
      batch: [customEventData(CustomEvent.CoordinatorMessageProcessing, { messageId: "msg_many" })],
    });
    await until(
      async () =>
        (await lite.core.store.listEvents(thread)).some((event) => customEvent(event, CustomEvent.CheckpointSkipped)),
      "the chat's line about the files",
    );
    const records = (await lite.core.store.listEvents(thread))
      .map((event) => customEvent(event, CustomEvent.CheckpointSkipped))
      .filter((payload) => payload !== null);
    assert.equal(records.length, 1);
    const [record] = records;
    assert.ok(record?.files);
    const listed = record.files;
    assert.equal(listed.length, CHECKPOINT_SKIPPED_FILES_LISTED, "at most fifty are listed");
    assert.equal(record.total, count, "and how many there were");
    const sizes = listed.map((file) => file.bytes);
    assert.deepEqual(
      sizes,
      [...sizes].sort((a, b) => b - a),
      "largest first",
    );
    assert.equal(sizes[0], CHECKPOINT_FILE_MAX_BYTES + 1 + (count - 1) * KB, "the largest is listed");
    assert.ok(!listed.some((file) => file.bytes === CHECKPOINT_FILE_MAX_BYTES + 1), "the smallest is the one left out");
    assert.equal(record.fileLimitBytes, CHECKPOINT_FILE_MAX_BYTES);
    assert.equal(record.changeLimitBytes, CHECKPOINT_CHANGE_MAX_BYTES);
  });

  it("the harness cannot forge one: the record is refused", async () => {
    const forged = customEventData(CustomEvent.CheckpointSkipped, { files: [{ file: "game.js", bytes: 1 }] });
    await assert.rejects(
      call("events.append", { threadId: otherThread, batch: [forged] }),
      /written by the studio only/,
    );
    const records = (await lite.core.store.listEvents(otherThread)).filter((event) =>
      customEvent(event, CustomEvent.CheckpointSkipped),
    );
    assert.deepEqual(records, []);
  });
});
