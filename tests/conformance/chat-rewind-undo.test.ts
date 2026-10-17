/**
 * After a Rewind that put the game files back, the rewind's line offers to bring back the newer
 * version (`main/core/rewind.ts` `undo`): the files come back as they were just before the rewind,
 * between the game's restore steps (an engine reloads what it holds), while the conversation stays
 * rewound. Only the chat's newest rewind offers it, once, and only until a message is sent after
 * it; a restore that fails leaves the folder as it was and the offer standing.
 *
 * A real core (`coreLite`) with the toy engine plugin, whose `reload-scenes` runs after a restore.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { ChatCheckpoints, CheckpointPhase } from "../../src/main/chat-checkpoints.ts";
import {
  offeredRewindUndo,
  rewindsOf,
  UndoRewindRefusal,
  undoRewindRefusal,
  undoRewindRefusalWords,
} from "../../src/shared/chat-rewind.ts";
import { CustomEvent, customEventData, customPayload } from "../../src/shared/custom-events.ts";
import { type EventData, EventKind, SnapshotScope } from "../../src/shared/event-log.ts";
import { HookEvent } from "../../src/shared/plugin-hooks.ts";
import { type PluginBinding, PluginSourceKind } from "../../src/shared/plugins.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { TOY_PLUGIN, TOY_PLUGIN_ID } from "../helpers/project-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

type ToolCall = CoreLite["core"]["plugins"]["tool"];

const RELOAD_SCENES = `${TOY_PLUGIN_ID}__reload-scenes`;
const SkipReason = {
  NoModes: "a folder's write permission is POSIX: Windows keeps writing into it",
} as const;

function answered(messageId: string, text: string, reply: string): EventData[] {
  return [
    { type: EventKind.Messages, messages: [{ role: "user", content: text }] },
    customEventData(CustomEvent.CoordinatorMessageQueued, { messageId, action: { text } }),
    customEventData(CustomEvent.CoordinatorMessageProcessing, { messageId }),
    { type: EventKind.Messages, messages: [{ role: "assistant", content: reply }] },
    customEventData(CustomEvent.CoordinatorMessageHandled, { messageId }),
  ];
}

describe("bringing back the newer version after a Rewind", () => {
  let lite: CoreLite;
  let projects: string;
  /** Every plugin step Genex called, as `<moment> <tool>`. */
  const called: string[] = [];
  let games = 0;

  /**
   * A toy-linked game whose chat answered one message that changed `a.txt` and `locked/leaf.txt`
   * and added `new.txt`, rewound with its files: answers the chat and the rewind's undo id.
   */
  async function rewoundGame() {
    const { core } = lite;
    games += 1;
    const name = `orchard-${games}`;
    const dir = (await core.games.scaffold(name)).dir;
    const file = path.join(projects, name, `${name}.toyproj`);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "toy\n");
    await core.engineLinks.link(TOY_PLUGIN_ID, { project: name, directory: dir }, { project: file });
    await mkdir(path.join(dir, "locked"), { recursive: true });
    await writeFile(path.join(dir, "a.txt"), "apple\n");
    await writeFile(path.join(dir, "locked", "leaf.txt"), "green\n");
    await core.snapshot(SnapshotScope.Game, "before the message", name);
    const threadId = await core.threadForGame(name);
    const messageId = `undo-msg-${games}`;
    await core.append(answered(messageId, "Make the orchard autumn.", "It is autumn now."), threadId);
    const checkpoints = new ChatCheckpoints(await tmpDir("rewind-undo-indexes-"));
    await checkpoints.take(dir, threadId, messageId, CheckpointPhase.Before);
    await writeFile(path.join(dir, "a.txt"), "pear\n");
    await writeFile(path.join(dir, "locked", "leaf.txt"), "red\n");
    await writeFile(path.join(dir, "new.txt"), "harvest\n");
    const events = await core.store.listEvents(threadId);
    const bubble = events.findLast(
      (event) => event.data.type === EventKind.Messages && event.data.messages.some((m) => m.role === "user"),
    );
    assert.ok(bubble);
    const result = await core.rewindChat(threadId, bubble.id, messageId, { files: true });
    assert.equal(result.files, 3, "the Rewind put three files back");
    assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "apple\n");
    const rewindId = result.undo?.rewindId;
    assert.ok(rewindId, "a Rewind that put files back offers the newer version");
    return { name, dir, threadId, rewindId };
  }

  const read = (dir: string, file: string) => readFile(path.join(dir, file), "utf8").catch(() => null);
  const undone = async (threadId: string) =>
    (await lite.core.store.listEvents(threadId)).flatMap((event) => {
      const payload = customPayload(event.data, CustomEvent.ConversationRewindUndone);
      return payload ? [payload] : [];
    });

  before(async () => {
    lite = await coreLite();
    const { core } = lite;
    projects = await realpath(await tmpDir("rewind-undo-toyproj-"));
    await core.plugins.installLocal(TOY_PLUGIN, PluginSourceKind.Local, []);
    await core.plugins.setEnabled(TOY_PLUGIN_ID, true);
    const real = core.plugins.tool.bind(core.plugins);
    core.plugins.tool = (async (name, args, binding: PluginBinding, ...rest) => {
      called.push(`${binding.hook?.on ?? "call"} ${name}`);
      return real(name, args, binding, ...rest);
    }) as ToolCall;
    // The rewind asks a harness that runs; this core has none.
    Object.defineProperty(core.host, "state", { configurable: true, get: () => "ready" });
  });

  after(async () => {
    Reflect.deleteProperty(lite.core.host, "state");
    lite.core.plugins.cancel();
    await lite.close();
  });

  it("puts every file back as it was just before the rewind, runs the restore steps, and keeps the chat rewound", async () => {
    const game = await rewoundGame();
    const from = called.length;
    const result = await lite.core.undoRewind(game.threadId, game.rewindId);
    assert.equal(result.files, 3);
    assert.equal(await read(game.dir, "a.txt"), "pear\n");
    assert.equal(await read(game.dir, "locked/leaf.txt"), "red\n");
    assert.equal(await read(game.dir, "new.txt"), "harvest\n");
    assert.ok(called.slice(from).includes(`${HookEvent.RestoreAfter} ${RELOAD_SCENES}`), called.join("\n"));
    assert.deepEqual(await undone(game.threadId), [{ rewindId: game.rewindId, files: 3 }]);
    const record = await lite.core.store.getRecord(game.threadId);
    const events = await lite.core.store.listEvents(game.threadId);
    assert.equal(rewindsOf([], record.metadata).length, 1, "the conversation stays rewound");
    assert.equal(offeredRewindUndo(events), null, "the line offers it no more");
  });

  it("refuses a second time, and leaves the files as they are", async () => {
    const game = await rewoundGame();
    await lite.core.undoRewind(game.threadId, game.rewindId);
    await writeFile(path.join(game.dir, "a.txt"), "plum\n");
    await assert.rejects(
      lite.core.undoRewind(game.threadId, game.rewindId),
      new Error(undoRewindRefusalWords(UndoRewindRefusal.AlreadyBack)),
    );
    assert.equal(await read(game.dir, "a.txt"), "plum\n");
    assert.equal((await undone(game.threadId)).length, 1);
  });

  it("refuses in plain words once a message was sent after the rewind", async () => {
    const game = await rewoundGame();
    await lite.core.append(
      [{ type: EventKind.Messages, messages: [{ role: "user", content: "Now winter." }] }],
      game.threadId,
    );
    await assert.rejects(
      lite.core.undoRewind(game.threadId, game.rewindId),
      new Error("A message was sent after the rewind, so the newer version can’t come back now."),
    );
    assert.equal(await read(game.dir, "a.txt"), "apple\n", "the files stay rewound");
    assert.equal(await read(game.dir, "new.txt"), null);
  });

  it("refuses a rewind that is not the chat's newest, or an id it never gave", async () => {
    const game = await rewoundGame();
    for (const rewindId of ["0-00000000", "../../HEAD", "", "x".repeat(200)]) {
      await assert.rejects(
        lite.core.undoRewind(game.threadId, rewindId),
        new Error(undoRewindRefusalWords(UndoRewindRefusal.NotOffered)),
        rewindId,
      );
    }
    assert.equal(await read(game.dir, "a.txt"), "apple\n");
  });

  it("a restore that fails partway leaves the folder as it was, records nothing, and still offers it", {
    skip: process.platform === "win32" ? SkipReason.NoModes : false,
  }, async () => {
    const game = await rewoundGame();
    const locked = path.join(game.dir, "locked");
    await chmod(locked, 0o555);
    try {
      await assert.rejects(lite.core.undoRewind(game.threadId, game.rewindId));
    } finally {
      await chmod(locked, 0o755);
    }
    assert.equal(await read(game.dir, "a.txt"), "apple\n", "a file written before the failure went back");
    assert.equal(await read(game.dir, "locked/leaf.txt"), "green\n");
    assert.equal(await read(game.dir, "new.txt"), null);
    assert.deepEqual(await undone(game.threadId), []);
    const events = await lite.core.store.listEvents(game.threadId);
    assert.equal(offeredRewindUndo(events), game.rewindId, "the line still offers it");
    assert.equal((await lite.core.undoRewind(game.threadId, game.rewindId)).files, 3, "and it works once it can");
    assert.equal(await read(game.dir, "a.txt"), "pear\n");
  });
});

describe("which rewind offers the newer version", () => {
  const event = (n: number, data: EventData) => ({
    id: String(n).padStart(6, "0"),
    thread_id: "t",
    turn_id: null,
    session_id: null,
    created_at: new Date(n).toISOString(),
    data,
  });
  const rewound = (n: number, rewindId?: string) =>
    event(
      n,
      customEventData(CustomEvent.ConversationRewound, {
        messageId: "m",
        from: "000001",
        through: "000002",
        hide: [],
        files: rewindId ? 2 : null,
        ...(rewindId ? { rewindId } : {}),
      }),
    );
  const user = (n: number) => event(n, { type: EventKind.Messages, messages: [{ role: "user", content: "hi" }] });
  const reply = (n: number) => event(n, { type: EventKind.Messages, messages: [{ role: "assistant", content: "ok" }] });
  const back = (n: number, rewindId: string) =>
    event(n, customEventData(CustomEvent.ConversationRewindUndone, { rewindId, files: 2 }));
  const ONE = "mabc1-0123abcd";
  const TWO = "mabc2-4567cdef";

  const cases: Array<{
    name: string;
    events: ReturnType<typeof event>[];
    offered: string | null;
    refusal: string | null;
  }> = [
    {
      name: "the newest rewind that put files back",
      events: [user(1), reply(2), rewound(3, ONE)],
      offered: ONE,
      refusal: null,
    },
    { name: "an assistant row after it", events: [rewound(3, ONE), reply(4)], offered: ONE, refusal: null },
    { name: "a rewind with no files back", events: [rewound(3)], offered: null, refusal: UndoRewindRefusal.NotOffered },
    {
      name: "an older rewind",
      events: [rewound(3, ONE), rewound(5, TWO)],
      offered: TWO,
      refusal: UndoRewindRefusal.NotOffered,
    },
    {
      name: "a newer rewind with no files",
      events: [rewound(3, ONE), rewound(5)],
      offered: null,
      refusal: UndoRewindRefusal.NotOffered,
    },
    {
      name: "a message after it",
      events: [rewound(3, ONE), user(4)],
      offered: null,
      refusal: UndoRewindRefusal.MessageSent,
    },
    {
      name: "already brought back",
      events: [rewound(3, ONE), back(4, ONE)],
      offered: null,
      refusal: UndoRewindRefusal.AlreadyBack,
    },
    { name: "no rewind", events: [user(1)], offered: null, refusal: UndoRewindRefusal.NotOffered },
  ];
  for (const { name, events, offered, refusal } of cases) {
    it(name, () => {
      assert.equal(offeredRewindUndo(events), offered);
      assert.equal(undoRewindRefusal(events, ONE), refusal);
    });
  }
});
