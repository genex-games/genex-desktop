/**
 * Files too large to save, which Rewind cannot bring back, are named to the lead: at the head of
 * its thread's next delegated prompt, until a session of that thread has read them and answered.
 */
import assert from "node:assert/strict";
import { truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { CHECKPOINT_CHANGE_MAX_BYTES, CHECKPOINT_FILE_MAX_BYTES } from "../../src/main/chat-checkpoints.ts";
import { CHECKPOINT_SKIPPED_FILES_LISTED } from "../../src/shared/chat-rewind.ts";
import { unsavedFilesNotice } from "../../src/main/core/delegation-prompts.ts";
import { clearUnsaved, noteUnsaved, peekUnsaved, type UnsavedFile } from "../../src/main/core/unsaved-files.ts";
import { CustomEvent, customEvent, customEventData } from "../../src/shared/custom-events.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";

type Api = Record<string, (input: unknown) => Promise<unknown>>;

const NOTICE =
  /^Studio notice: Rewind cannot bring back these files, which are too large to save: big\.bin \(50 MB\)\./;
/** What the test's engine notes ahead of a compaction's own prompt. */
const COMPACTED = "(compacted)";
const MB = 1024 ** 2;
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

describe("files Rewind cannot bring back, named to the lead", () => {
  let lite: CoreLite;
  let api: Api;
  let threadId: string;
  let otherThread: string;
  const project = "unsaved";
  const other = "unsaved-other";
  const prompts: string[] = [];
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
        prompts.push(request.compact ? `${COMPACTED}\n${request.prompt}` : request.prompt);
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

  it("names unsaved files at the head of the thread's next prompt until a session settles", async () => {
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
    assert.ok(prompts[0]?.startsWith(COMPACTED), "the first session was the compaction");
    assert.doesNotMatch(prompts[0] ?? "", /Rewind cannot bring back/, "a compaction reads no notice");
    assert.doesNotMatch(prompts[1] ?? "", /Rewind cannot bring back/, "another thread's prompt is not told");
    assert.match(prompts[2] ?? "", NOTICE, "the session that failed was told");
    assert.match(prompts[3] ?? "", NOTICE, "the next session that works still reads it");
    assert.ok((prompts[3] ?? "").indexOf("Build it") > 0, "the notice heads the prompt");
    assert.doesNotMatch(prompts[4] ?? "", /Rewind cannot bring back/, "and once a session settled, it is used up");
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

  it("the harness cannot forge one: the record is refused and the lead is told nothing", async () => {
    const forged = customEventData(CustomEvent.CheckpointSkipped, { files: [{ file: "game.js", bytes: 1 }] });
    await assert.rejects(
      call("events.append", { threadId: otherThread, batch: [forged] }),
      /written by the studio only/,
    );
    const told = prompts.length;
    await delegate(otherThread, other);
    assert.doesNotMatch(prompts[told] ?? "", /Rewind cannot bring back/);
    const records = (await lite.core.store.listEvents(otherThread)).filter((event) =>
      customEvent(event, CustomEvent.CheckpointSkipped),
    );
    assert.deepEqual(records, []);
  });
});

it("a thread keeps its last ten unsaved files, each at its newest size, until a session that read them answers", () => {
  const unsaved = new Map<string, UnsavedFile[]>();
  const file = (n: number, bytes = n): UnsavedFile => ({ file: `f${n}.bin`, bytes });
  for (let n = 1; n <= 11; n++) noteUnsaved(unsaved, "t", [file(n)]);
  assert.deepEqual(
    peekUnsaved(unsaved, "t").map((f) => f.file),
    Array.from({ length: 10 }, (_, i) => `f${i + 2}.bin`),
    "the oldest goes first",
  );
  const once = new Map<string, UnsavedFile[]>();
  noteUnsaved(
    once,
    "t",
    Array.from({ length: 11 }, (_, i) => file(i + 1)),
  );
  assert.deepEqual(
    peekUnsaved(once, "t").map((f) => f.file),
    Array.from({ length: 10 }, (_, i) => `f${i + 1}.bin`),
    "one report keeps its first files, the largest",
  );
  noteUnsaved(unsaved, undefined, [file(99)]);
  assert.deepEqual(peekUnsaved(unsaved, undefined), [], "a file with no thread is noted nowhere");

  const told = peekUnsaved(unsaved, "t");
  noteUnsaved(unsaved, "t", [file(5, 500)]);
  assert.deepEqual(peekUnsaved(unsaved, "t").at(-1), { file: "f5.bin", bytes: 500 }, "its newest size wins");
  assert.equal(peekUnsaved(unsaved, "t").length, 10);
  clearUnsaved(unsaved, "t", told);
  assert.deepEqual(peekUnsaved(unsaved, "t"), [file(5, 500)], "a file noted again after the session was told stays");
  clearUnsaved(unsaved, "t", peekUnsaved(unsaved, "t"));
  assert.deepEqual(peekUnsaved(unsaved, "t"), []);
});

it("the notice names each file with its size, and says nothing for none", () => {
  assert.equal(unsavedFilesNotice([]), "");
  const notice = unsavedFilesNotice([
    { file: "Content/Hero.uasset", bytes: 120 * MB },
    { file: "audio/theme.wav", bytes: 64 * MB },
  ]);
  assert.ok(notice.includes("Content/Hero.uasset (120 MB), audio/theme.wav (64 MB)."), notice);
  assert.match(notice, /change one only when the person asked for it/);
});
