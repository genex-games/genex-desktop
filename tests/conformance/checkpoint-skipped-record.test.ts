/**
 * Files a chat checkpoint leaves out for their size: the chat says nothing of them then, since
 * nothing is lost yet, and no delegated session is told of them. Only a rewind that leaves them as
 * they are names them, in Genex's own `checkpoint_skipped` record, written by the studio only
 * (`chat-rewind-studio.test.ts`).
 */
import assert from "node:assert/strict";
import { truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { CHECKPOINT_FILE_MAX_BYTES, chatCheckpointRef } from "../../src/main/chat-checkpoints.ts";
import { CustomEvent, customEvent, customEventData } from "../../src/shared/custom-events.ts";
import { gitOrNull } from "../../src/substrate/snapshots.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";

type Api = Record<string, (input: unknown) => Promise<unknown>>;

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

describe("files too large to save: no line at the checkpoint, and never a session's notice", () => {
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

  it("a checkpoint that leaves a file out writes no line, and no session that follows is told of it", async () => {
    const dir = lite.core.games.dirFor(project);
    const big = path.join(dir, "big.bin");
    await writeFile(big, "");
    await truncate(big, CHECKPOINT_FILE_MAX_BYTES + 1);
    // The chat's queue starts answering a message: its checkpoint leaves the big file out.
    await call("events.append", {
      threadId,
      batch: [customEventData(CustomEvent.CoordinatorMessageProcessing, { messageId: "msg_one" })],
    });
    const checkpoint = chatCheckpointRef(threadId, "msg_one");
    await until(
      async () => (await gitOrNull(dir, ["rev-parse", "--verify", "-q", checkpoint])) !== null,
      "the message's checkpoint",
    );
    const leftOut = await gitOrNull(dir, ["show", `${checkpoint}:.studio-checkpoint-left-out.json`]);
    assert.deepEqual(JSON.parse(leftOut ?? "{}").skipped, ["big.bin"], "the checkpoint left it out");
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
    // agent repeated it to the person.
    for (const [n, text] of read.entries()) {
      assert.ok(text.includes("Build it") || n === 0, `session ${n} read its prompt`);
      assert.doesNotMatch(text, /big\.bin|Rewind can't bring/, `session ${n} is told nothing of the file`);
    }
    // Flipped: the checkpoint wrote a line, "Rewind can’t bring back 1 file that is too large to
    // save: big.bin (50 MB)", though nothing was lost yet. Only a rewind that leaves it names it.
    const records = (await lite.core.store.listEvents(threadId)).filter((event) =>
      customEvent(event, CustomEvent.CheckpointSkipped),
    );
    assert.deepEqual(records, [], "the chat says nothing of it");
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
