/**
 * Genex's moments, and the plugin steps they run: in order, by facts, told the moment, never with
 * arguments.
 *
 * A real core (`coreLite`) with the local test plugin `hk` (`helpers/hook-plugin.ts`): its harness
 * tools hook checkpoints, restores, health, a run's start, a turn's start and its own agent tool,
 * for games holding a `*.hkproj` file. The host fires checkpoints (`checkpoint.take`), every
 * restore of a game folder and a plugin's own tool moments; the harness fires the rest
 * (`hooks.fire`).
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import { ChatCheckpoints, CheckpointPhase } from "../../src/main/chat-checkpoints.ts";
import { kindsWithReadiness, READY_ASK_MS } from "../../src/main/core/kind-readiness.ts";
import { PERSON_FIRST_FRESH_MS, workerHolder } from "../../src/main/core/plugin-locks.ts";
import { PluginToolService } from "../../src/main/core/plugin-tools.ts";
import { CustomEvent, customEventData } from "../../src/shared/custom-events.ts";
import { EventKind, type EventData, SnapshotScope } from "../../src/shared/event-log.ts";
import { HostMethod, harnessParamsProblem } from "../../src/shared/harness-api.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import {
  CheckpointSkip,
  HOOK_BLOCKED,
  HOOK_IMAGE_MAX_BYTES,
  HOOK_IMAGES_MAX,
  HOOK_REASON_CHARS,
  HookEvent,
  HookHold,
  hookAnswerOf,
} from "../../src/shared/plugin-hooks.ts";
import { PluginSourceKind } from "../../src/shared/plugins.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import {
  DESK_LABEL,
  HOOK_PLUGIN,
  type HookPackage,
  LIGHT_PLUGIN,
  OTHER_PLUGIN,
  hookPackage,
  lightPackage,
  otherPackage,
} from "../helpers/hook-plugin.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A one-pixel PNG, as a handler hands one back. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

type Api = Record<string, (input: unknown) => Promise<unknown>>;

/** What `checkpoint.take` answers. */
type Checkpoint = {
  snapshot?: { snapshot_id: string; scope: string; git: { game?: string }; reason: string };
  notes?: Array<{ plugin: string; text: string }>;
  images?: Array<{ name: string }>;
  blocked?: string;
  hold?: string;
  label?: string;
  skipped?: string;
  reason?: string;
};

/** What `hooks.fire` answers. */
type Report = {
  blocked: { plugin: string; tool: string; reason: string; hold?: string; label?: string } | null;
  pending: { plugin: string; reason: string } | null;
  notes: Array<{ plugin: string; text: string }>;
  ran: string[];
};

describe("Genex's moments in a real core", () => {
  let lite: CoreLite;
  let api: Api;
  let hk: HookPackage;
  let threadId: string;
  let deskDir: string;
  let skew = 0;
  /** What the core logged. */
  const logged: string[] = [];
  const DESK = "desk-game";
  const POND = "pond";

  const call = (method: string, params: unknown) => {
    const handler = api[method];
    assert.ok(handler, method);
    return handler(params);
  };
  const take = (params: Record<string, unknown> = {}) =>
    call(HostMethod.CheckpointTake, { project: DESK, threadId, label: "Halfway", ...params }) as Promise<Checkpoint>;
  const fire = (params: Record<string, unknown>) =>
    call(HostMethod.HooksFire, { project: DESK, threadId, ...params }) as Promise<Report>;
  /** The moments' steps only: the lock's probe is asked outside any moment. */
  const steps = async () => (await hk.trail()).filter((step) => step !== "probe");

  before(async () => {
    // The locks' clock runs ahead when a test says so: what the person was doing a moment ago is asked again.
    lite = await coreLite({
      onLog: (line: string) => {
        logged.push(line);
      },
      locks: {
        now: () => Date.now() + skew,
        // A wait on the person moves the clock instead of taking real time.
        sleep: async (ms: number) => {
          skew += ms;
          await nextTurn();
        },
      },
    });
    const { core } = lite;
    hk = await hookPackage();
    await core.plugins.installLocal(hk.dir, PluginSourceKind.Local, []);
    await core.plugins.setEnabled(HOOK_PLUGIN, true);
    await core.plugins.installLocal((await otherPackage()).dir, PluginSourceKind.Local, []);
    await core.plugins.setEnabled(OTHER_PLUGIN, true);
    deskDir = (await core.games.scaffold(DESK)).dir;
    await writeFile(path.join(deskDir, "Desk.hkproj"), "{}\n");
    await core.games.scaffold(POND);
    threadId = await core.threadForGame(DESK);
    api = lite.api() as unknown as Api;
  });

  after(async () => {
    lite.core.plugins.cancel();
    await lite.close();
  });

  it("the engine card's kinds carry each kind's readiness, asked through its ready tool, for a game with no kind yet", async () => {
    type Listed = { kinds: Array<{ tool: string; asksReady?: boolean; ready?: boolean; note?: string }> };
    const deskKind = async (project: string) =>
      ((await call(HostMethod.PluginsTools, { project })) as Listed).kinds.find((kind) => kind.tool === "hk__new-desk");
    // A game New game made: an empty folder with no kind yet.
    const bare = (await lite.core.createGame("Bare Desk")).name;
    await hk.script({ ready: { ready: false, note: "  Set the desk up from the Hook demo button first.  " } });
    const pending = await deskKind(bare);
    assert.equal(pending?.ready, false);
    assert.equal(pending?.note, "Set the desk up from the Hook demo button first.");
    assert.deepEqual(await hk.trail(), ["ready"], "asked through the tool its manifest names");

    await hk.script({ ready: { ready: true } });
    const known = await deskKind(DESK);
    assert.equal(known?.ready, undefined, "a game with a kind is offered no card");
    assert.deepEqual(await hk.trail(), [], "and nobody is asked");

    const odd: Array<[string, unknown]> = [
      ["no answer", { throws: "the desk is away" }],
      ["odd fields", { ready: "yes", note: 7 }],
      ["nothing", null],
    ];
    for (const [label, answer] of odd) {
      await hk.script({ ready: answer });
      const kind = await deskKind(bare);
      assert.ok(kind, label);
      assert.equal(kind.ready, undefined, label);
      assert.equal(kind.note, undefined, label);
      assert.equal(kind.asksReady, true, `${label}: still the kind whose tool asks, for the card to prefer`);
    }
  });

  it("a checkpoint runs the before steps, takes the snapshot, then the after steps, and answers their notes and pictures", async () => {
    await hk.script({
      "checkpoint.before:save": { note: "Saved 2 scenes." },
      "checkpoint.after:shot": {
        note: "One still.",
        images: [{ name: "front", data: PIXEL, measures: { tone: 0.4 } }],
      },
    });
    const done = await take({ runId: "run_1" });
    assert.ok(done.snapshot, JSON.stringify(done));
    assert.equal(done.snapshot.scope, SnapshotScope.Game);
    assert.match(done.snapshot.reason, /Halfway/);
    assert.deepEqual(await steps(), ["checkpoint.before:save", "checkpoint.before:flush", "checkpoint.after:shot"]);
    const calls = (await hk.calls()).filter((c) => c.hook);
    const commit = done.snapshot.git.game;
    assert.ok(commit);
    assert.notEqual(calls[0]?.head, commit, "the before steps ran before the snapshot");
    assert.equal(calls[2]?.head, commit, "the after step ran once the snapshot was taken");
    assert.ok(lite.core.snapshotIndex.get(done.snapshot.snapshot_id));
    assert.deepEqual(done.notes, [
      { plugin: HOOK_PLUGIN, text: "Saved 2 scenes." },
      { plugin: HOOK_PLUGIN, text: "One still." },
    ]);
    assert.deepEqual(
      done.images?.map((image) => image.name),
      ["front"],
    );
    assert.deepEqual(lite.core.locks.holders(), [], "the checkpoint let its locks go");
  });

  it("a step's block stops the checkpoint: no snapshot, and the reason comes back", async () => {
    const before = lite.core.snapshotIndex.all().length;
    await hk.script({ "checkpoint.before:save": { block: "The desk is playing." } });
    const blocked = await take();
    assert.equal(blocked.blocked, "The desk is playing.");
    assert.deepEqual(await steps(), ["checkpoint.before:save"], "the steps after the block never ran");
    await hk.script({ "checkpoint.before:flush": { throws: "the drawer is stuck" } });
    const thrown = await take();
    assert.match(String(thrown.blocked), /the drawer is stuck/, "a step that fails stops the checkpoint too");
    assert.equal(lite.core.snapshotIndex.all().length, before, "no snapshot was taken");
    await hk.script({ "checkpoint.after:shot": { block: "Too dark to see." } });
    const late = await take();
    assert.ok(late.snapshot, "a block after the snapshot cannot undo it");
    assert.deepEqual(late.notes, [{ plugin: HOOK_PLUGIN, text: "Too dark to see." }]);
  });

  it("a snapshot that fails answers why, runs no after step and lets the locks go", async () => {
    const { core } = lite;
    const before = core.snapshotIndex.all().length;
    await hk.script({});
    const snapshot = core.snapshot;
    core.snapshot = async () => {
      throw new Error("the disk is full");
    };
    try {
      const failed = await take();
      assert.match(String(failed.blocked), /No snapshot was taken: the disk is full\./);
      assert.equal(failed.hold, undefined, "a failure is no hold of Genex's");
    } finally {
      core.snapshot = snapshot;
    }
    assert.deepEqual(await steps(), ["checkpoint.before:save", "checkpoint.before:flush"], "no after step ran");
    assert.equal(core.snapshotIndex.all().length, before);
    assert.deepEqual(core.locks.holders(), [], "the checkpoint let its locks go");
  });

  it("only if unsaved: skipped when every probe says nothing is unsaved, or one can't tell", async () => {
    const before = lite.core.snapshotIndex.all().length;
    await hk.script({ probe: { personActive: false, unsaved: 0 } });
    const clean = await take({ onlyIfUnsaved: true });
    assert.equal(clean.skipped, CheckpointSkip.NothingUnsaved);
    await hk.script({ probe: [{ personActive: false }, { personActive: false }] });
    const unknown = await take({ onlyIfUnsaved: true });
    assert.equal(unknown.skipped, CheckpointSkip.CantTell);
    assert.match(String(unknown.reason), /Desk/);
    assert.deepEqual(await steps(), [], "no step ran for a skipped checkpoint");
    assert.equal(lite.core.snapshotIndex.all().length, before);
    await hk.script({ probe: { personActive: false, unsaved: 3 } });
    const dirty = await take({ onlyIfUnsaved: true });
    assert.ok(dirty.snapshot, "work left unsaved is checkpointed");
  });

  it("a plugin's steps reach only games with its facts, and only while it is on", async () => {
    const listed = async (name: string) => (await lite.core.games.list()).find((game) => game.name === name);
    assert.deepEqual((await listed(DESK))?.hookEvents, [
      HookEvent.RunPrepare,
      HookEvent.TurnStart,
      HookEvent.TurnEnd,
      HookEvent.CheckpointBefore,
      HookEvent.CheckpointAfter,
      HookEvent.RestoreBefore,
      HookEvent.RestoreAfter,
      HookEvent.ToolBefore,
      HookEvent.ToolAfter,
      HookEvent.Health,
    ]);
    const pending = (await lite.core.createGame("Kite Hooks")).name;
    for (const name of [POND, pending]) {
      await hk.script({});
      assert.equal((await listed(name))?.hookEvents, undefined, name);
      const done = await call(HostMethod.CheckpointTake, { project: name, label: "Halfway" });
      assert.ok((done as Checkpoint).snapshot, name);
      const report = await call(HostMethod.HooksFire, { project: name, on: HookEvent.Health });
      assert.deepEqual((report as Report).ran, [], name);
      assert.deepEqual(await hk.trail(), [], `${name}: no step ran`);
    }
    await lite.core.plugins.setEnabled(HOOK_PLUGIN, false);
    try {
      assert.equal((await listed(DESK))?.hookEvents, undefined);
      assert.ok((await take()).snapshot);
      assert.deepEqual(await hk.trail(), [], "a plugin that is off runs nothing");
    } finally {
      await lite.core.plugins.setEnabled(HOOK_PLUGIN, true);
    }
  });

  it("every restore of a game folder runs the restore steps around it, and a block keeps the files", async () => {
    const file = path.join(deskDir, "desk.txt");
    await writeFile(file, "oak\n");
    await hk.script({});
    const saved = (await take()).snapshot;
    assert.ok(saved);
    await writeFile(file, "pine\n");
    await hk.script({ "restore.before:save": { block: "The desk is in use." } });
    skew += PERSON_FIRST_FRESH_MS;
    const restore = () => call(HostMethod.SnapshotRestore, { snapshotId: saved.snapshot_id, project: DESK });
    await assert.rejects(restore(), (error: Error & { code?: string }) => {
      assert.equal(error.code, HOOK_BLOCKED);
      assert.match(error.message, /The desk is in use\./);
      return true;
    });
    assert.equal(await readFile(file, "utf8"), "pine\n", "a block keeps the files");
    assert.deepEqual(
      await hk.trail(),
      ["probe", "restore.before:save"],
      "the harness's restore gives way to the person first",
    );
    await hk.script({ "restore.after:ready": { note: "Desk reopened." } });
    assert.equal(await restore(), true);
    assert.equal(await readFile(file, "utf8"), "oak\n");
    assert.deepEqual(await steps(), ["restore.before:save", "restore.after:ready"]);
  });

  it("only a restore of a game's own files runs the restore steps: a harness restore, a record with no game and a call with no game run none", async () => {
    const { core } = lite;
    const both = await core.snapshot(SnapshotScope.Both, "a won round", DESK);
    const harness = await core.snapshot(SnapshotScope.Harness, "the harness alone");
    assert.ok(both.git.game && both.git.harness, JSON.stringify(both.git));
    assert.equal(harness.git.game, undefined);
    const restore = (params: Record<string, unknown>) =>
      call(HostMethod.SnapshotRestore, params).then(
        () => "restored",
        (error: Error) => error.message,
      );
    const rows: Array<[string, Record<string, unknown>]> = [
      ["a both record's harness half", { snapshotId: both.snapshot_id, project: DESK, scope: SnapshotScope.Harness }],
      ["a record with no game commit", { snapshotId: harness.snapshot_id, project: DESK }],
      ["a call that names no game", { snapshotId: both.snapshot_id, scope: SnapshotScope.Harness }],
    ];
    for (const [name, params] of rows) {
      skew += PERSON_FIRST_FRESH_MS;
      await hk.script({});
      assert.equal(await restore(params), "restored", name);
      assert.deepEqual(await hk.trail(), [], `${name}: no step ran`);
    }
    skew += PERSON_FIRST_FRESH_MS;
    await hk.script({});
    assert.equal(await restore({ snapshotId: both.snapshot_id, project: DESK }), "restored");
    assert.deepEqual(
      await steps(),
      ["restore.before:save", "restore.after:ready"],
      "a both record's game half runs them",
    );
  });

  it("a restore that fails after its before steps still runs the after steps, rejects with its own error and lets the locks go", async () => {
    const saved = (await take()).snapshot;
    assert.ok(saved);
    await hk.script({});
    skew += PERSON_FIRST_FRESH_MS;
    await hk.trail();
    const { snapshots } = lite.core;
    const restore = snapshots.restore;
    snapshots.restore = (async () => {
      throw new Error("the disk is full");
    }) as typeof restore;
    try {
      await assert.rejects(
        call(HostMethod.SnapshotRestore, { snapshotId: saved.snapshot_id, project: DESK }),
        /the disk is full/,
      );
    } finally {
      snapshots.restore = restore;
    }
    assert.deepEqual(await steps(), ["restore.before:save", "restore.after:ready"], "the after steps ran all the same");
    assert.deepEqual(lite.core.locks.holders(), [], "nothing is held");
  });

  it("the person's Rewind runs the restore steps around the files, never asking whether they are busy", async () => {
    const { core } = lite;
    const file = path.join(deskDir, "desk.txt");
    await writeFile(file, "maple\n");
    await core.snapshot(SnapshotScope.Game, "before the message", DESK);
    const messageId = "hk-rewind-1";
    await core.append(answered(messageId, "Paint the desk red.", "The desk is red now."), threadId);
    const checkpoints = new ChatCheckpoints(await tmpDir("hook-rewind-indexes-"));
    await checkpoints.take(deskDir, threadId, messageId, CheckpointPhase.Before);
    await writeFile(file, "red\n");
    const events = await core.store.listEvents(threadId);
    const bubble = events.findLast(
      (event) => event.data.type === EventKind.Messages && event.data.messages.some((m) => m.role === "user"),
    );
    assert.ok(bubble);
    // The rewind asks a harness that runs; this core has none.
    Object.defineProperty(core.host, "state", { configurable: true, get: () => "ready" });
    try {
      await hk.script({ probe: { personActive: true } });
      await core.setPermissionMode(threadId, PermissionMode.Plan);
      const result = await core.rewindChat(threadId, bubble.id, messageId, { files: true });
      assert.equal(result.files, 1);
      assert.equal(await readFile(file, "utf8"), "maple\n");
      assert.deepEqual(await hk.trail(), ["restore.before:save", "restore.after:ready"], "no probe was asked");
      const told = (await hk.calls()).map((c) => c.hook?.forPerson);
      assert.deepEqual(told, [true, true]);
    } finally {
      await core.setPermissionMode(threadId, PermissionMode.Manual);
      Reflect.deleteProperty(core.host, "state");
    }
  });

  it("a step that blocks the person's Rewind keeps the files and the conversation, and says why", async () => {
    const { core } = lite;
    const file = path.join(deskDir, "desk.txt");
    await writeFile(file, "teak\n");
    await core.snapshot(SnapshotScope.Game, "before the blocked message", DESK);
    const messageId = "hk-rewind-blocked";
    await core.append(answered(messageId, "Paint the desk blue.", "The desk is blue now."), threadId);
    const checkpoints = new ChatCheckpoints(await tmpDir("hook-rewind-blocked-"));
    await checkpoints.take(deskDir, threadId, messageId, CheckpointPhase.Before);
    await writeFile(file, "blue\n");
    const before = await core.store.listEvents(threadId);
    const bubble = before.findLast(
      (event) => event.data.type === EventKind.Messages && event.data.messages.some((m) => m.role === "user"),
    );
    assert.ok(bubble);
    Object.defineProperty(core.host, "state", { configurable: true, get: () => "ready" });
    try {
      await hk.script({ "restore.before:save": { block: "The desk is still drying." } });
      await assert.rejects(
        core.rewindChat(threadId, bubble.id, messageId, { files: true }),
        /The desk is still drying\./,
      );
      assert.equal(await readFile(file, "utf8"), "blue\n", "the files stay as they are");
      assert.deepEqual(await steps(), ["restore.before:save"], "no restore.after step ran");
      const after = await core.store.listEvents(threadId);
      assert.equal(after.length, before.length, "the conversation is not rewound");
    } finally {
      Reflect.deleteProperty(core.host, "state");
    }
  });

  it("a plugin's own tool runs its tool.before and tool.after; another plugin's never does", async () => {
    await hk.script({
      "tool.after:flush": { note: "Wiped the brush." },
      paint: { painted: true },
    });
    const invoke = (name: string, args: Record<string, unknown> = {}) =>
      call(HostMethod.PluginsInvoke, { project: DESK, threadId, name, args });
    const painted = (await invoke(`${HOOK_PLUGIN}__paint`, { color: "red" })) as Record<string, unknown>;
    assert.equal(painted.painted, true);
    assert.deepEqual(painted.genex, { notes: ["Wiped the brush."] });
    assert.deepEqual(await steps(), ["tool.before:save", "paint", "tool.after:flush"]);
    await hk.script({});
    assert.deepEqual(await invoke(`${OTHER_PLUGIN}__wave`), {});
    assert.deepEqual(await hk.trail(), [], "another plugin's tool runs none of hk's steps");
    await hk.script({ "tool.before:save": { block: "Not with that brush." } });
    const refused = await invoke(`${HOOK_PLUGIN}__paint`, { color: "blue" });
    assert.deepEqual(refused, { blocked: "Not with that brush." });
    assert.deepEqual(await steps(), ["tool.before:save"], "a blocked call never reaches its tool");
  });

  it("a tool.after note joins any answer: after a text's words, beside a value, and beside Genex's own note", async () => {
    const invoke = (name: string) =>
      call(HostMethod.PluginsInvoke, { project: DESK, threadId, name, args: {} }) as Promise<unknown>;
    const brush = { "tool.after:flush": { note: "Wiped the brush." } };
    await hk.script({ ...brush, paint: "Painted the legs." });
    assert.equal(await invoke(`${HOOK_PLUGIN}__paint`), "Painted the legs.\n\nWiped the brush.");
    await hk.script({ ...brush, paint: [null] });
    assert.deepEqual(await invoke(`${HOOK_PLUGIN}__paint`), { answer: null, genex: { notes: ["Wiped the brush."] } });
    await hk.script({ ...brush, paint: [["leg", "top"]] });
    assert.deepEqual(await invoke(`${HOOK_PLUGIN}__paint`), {
      answer: ["leg", "top"],
      genex: { notes: ["Wiped the brush."] },
    });
    // A kind made on a game that had none: Genex's note of it, then the plugin's step on the new desk game.
    const bare = (await lite.core.createGame("Bare Bench")).name;
    await hk.script({ ...brush, "new-desk": { made: true, writes: "Bench.hkproj" } });
    const made = (await call(HostMethod.PluginsInvoke, {
      project: bare,
      threadId: await lite.core.threadForGame(bare),
      name: `${HOOK_PLUGIN}__new-desk`,
      args: {},
    })) as { made?: boolean; genex?: Record<string, unknown> };
    assert.equal(made.made, true);
    assert.equal(typeof made.genex?.note, "string", JSON.stringify(made));
    assert.ok(String(made.genex?.note).length > 0, "Genex's note of the kind it made is kept");
    assert.deepEqual(made.genex?.notes, ["Wiped the brush."]);
  });

  it("a worker writing in place calls its plugin's tool: the tool's steps pass the lock the worker holds", async () => {
    const writer = { project: DESK, threadId, holder: { id: "w1", title: "Varnish" } };
    assert.deepEqual(await call(HostMethod.LocksHold, writer), { held: true, labels: [DESK_LABEL] });
    try {
      await hk.script({ paint: { painted: true } });
      const service = new PluginToolService(lite.core, {
        consent: null as never,
        pluginCallAttribution: new WeakMap(),
        mcpSecrets: null,
        activeConnectorCalls: new Map(),
        cutOffCalls: new Map(),
        planning: async () => false,
        bypassing: async () => true,
        locks: lite.core.locks,
        hooks: lite.core.hooks,
      });
      const painted = await service.invokePluginTool(
        `${HOOK_PLUGIN}__paint`,
        {},
        { project: DESK, directory: deskDir, threadId },
        undefined,
        { engine: "claude-code", holder: workerHolder({ threadId, runId: null, id: "w1" }) },
      );
      assert.deepEqual(painted, { painted: true });
      assert.deepEqual(await steps(), ["tool.before:save", "paint", "tool.after:flush"]);
    } finally {
      await call(HostMethod.LocksRelease, writer);
    }
  });

  it("a chat's checkpoint passes the lock its own worker writing in place holds; one for no chat waits for it", async () => {
    const writer = { project: DESK, threadId, holder: { id: "w2", title: "Polish" } };
    assert.deepEqual(await call(HostMethod.LocksHold, writer), { held: true, labels: [DESK_LABEL] });
    try {
      skew += PERSON_FIRST_FRESH_MS;
      await hk.script({});
      const own = await take();
      assert.ok(own.snapshot, JSON.stringify(own));
      assert.deepEqual(await steps(), ["checkpoint.before:save", "checkpoint.before:flush", "checkpoint.after:shot"]);
      const other = await take({ threadId: undefined });
      assert.equal(other.hold, HookHold.Busy, "a checkpoint for no chat waits for the worker, then says why");
      assert.match(String(other.blocked), /Polish/);
    } finally {
      await call(HostMethod.LocksRelease, writer);
    }
    assert.deepEqual(lite.core.locks.holders(), []);
  });

  it("health answers pending while a step says so, and a step that throws is pending, never a crash", async () => {
    await hk.script({ "health:check": { pending: "The desk is opening." } });
    const opening = await fire({ on: HookEvent.Health });
    assert.deepEqual(opening.pending, { plugin: HOOK_PLUGIN, reason: "The desk is opening." });
    assert.equal(opening.blocked, null);
    await hk.script({ "health:check": { throws: "no answer" } });
    const silent = await fire({ on: HookEvent.Health });
    assert.equal(silent.blocked, null);
    assert.match(String(silent.pending?.reason), /no answer/);
    await hk.script({ "health:check": { block: "The desk is gone." } });
    const gone = await fire({ on: HookEvent.Health });
    assert.equal(gone.blocked?.reason, "The desk is gone.", "a health block is the moment's answer: a crash");
    await hk.script({});
    const fine = await fire({ on: HookEvent.Health });
    assert.deepEqual(
      [fine.blocked, fine.pending, fine.ran],
      [null, null, [`${HOOK_PLUGIN}__check`, `${HOOK_PLUGIN}__tidy`]],
    );
  });

  it("every note a moment's steps add is logged, whatever the moment", async () => {
    logged.length = 0;
    await hk.script({ "turn.end:tidy": { note: "Swept the desk." } });
    const turnEnd = await fire({ on: HookEvent.TurnEnd, turn: "t1" });
    assert.deepEqual(turnEnd.notes, [{ plugin: HOOK_PLUGIN, text: "Swept the desk." }]);
    assert.ok(
      logged.some((line) => line.includes(HookEvent.TurnEnd) && line.includes("Swept the desk.")),
      logged.join("\n"),
    );
    await hk.script({ "run.prepare:ready": { note: "Desk set." } });
    await fire({ on: HookEvent.RunPrepare });
    assert.ok(logged.some((line) => line.includes(HookEvent.RunPrepare) && line.includes("Desk set.")));
  });

  it("a step is told the moment and nothing else", async () => {
    await hk.script({});
    await take({ runId: "run_7" });
    const [save] = (await hk.calls()).filter((c) => c.hook);
    assert.deepEqual(save?.hook, { on: HookEvent.CheckpointBefore, runId: "run_7", label: "Halfway" });
    assert.deepEqual(save?.args, {}, "a step gets no arguments");
    await hk.script({});
    await call(HostMethod.PluginsInvoke, {
      project: DESK,
      threadId,
      name: `${HOOK_PLUGIN}__paint`,
      args: { color: "x".repeat(5000) },
    });
    const [before] = (await hk.calls()).filter((c) => c.hook);
    assert.equal(before?.hook?.on, HookEvent.ToolBefore);
    assert.equal(before?.hook?.tool, `${HOOK_PLUGIN}__paint`);
    const digest = String(before?.hook?.args);
    assert.ok(digest.length < 5000, "the arguments come as a digest, clipped");
    assert.match(digest, /color/);
    assert.deepEqual(before?.args, {});
  });

  it("a planning chat's moments that write wait for the plan; reads and the person's Rewind do not", async () => {
    await lite.core.setPermissionMode(threadId, PermissionMode.Plan);
    try {
      await hk.script({});
      const before = lite.core.snapshotIndex.all().length;
      assert.match(String((await take()).blocked), /Plan mode/);
      assert.equal(lite.core.snapshotIndex.all().length, before);
      const prepare = await fire({ on: HookEvent.RunPrepare });
      assert.match(String(prepare.blocked?.reason), /Plan mode/);
      assert.deepEqual(await hk.trail(), [], "nothing that writes ran");
      const health = await fire({ on: HookEvent.Health });
      assert.deepEqual(health.ran, [`${HOOK_PLUGIN}__check`, `${HOOK_PLUGIN}__tidy`]);
      const turn = await fire({ on: HookEvent.TurnStart, turn: "t1" });
      assert.deepEqual(turn.ran, [`${HOOK_PLUGIN}__check`]);
    } finally {
      await lite.core.setPermissionMode(threadId, PermissionMode.Manual);
    }
  });

  it("a planning chat's checkpoint asked only if unsaved still reads first: nothing unsaved is a skip, unsaved work waits for the plan", async () => {
    await lite.core.setPermissionMode(threadId, PermissionMode.Plan);
    try {
      skew += PERSON_FIRST_FRESH_MS;
      await hk.script({ probe: { personActive: false, unsaved: 0 } });
      const clean = await take({ onlyIfUnsaved: true });
      assert.equal(clean.skipped, CheckpointSkip.NothingUnsaved, JSON.stringify(clean));
      skew += PERSON_FIRST_FRESH_MS;
      await hk.script({ probe: { personActive: false, unsaved: 2 } });
      const dirty = await take({ onlyIfUnsaved: true });
      assert.match(String(dirty.blocked), /Plan mode/);
      assert.equal(dirty.hold, HookHold.Plan, "Genex's own hold is typed, never read from its words");
      assert.deepEqual(await steps(), [], "nothing that writes ran");
    } finally {
      await lite.core.setPermissionMode(threadId, PermissionMode.Manual);
    }
  });

  it("a game folder's restore the harness asks for in a planning chat's name waits for the plan, and nothing changes", async () => {
    const file = path.join(deskDir, "desk.txt");
    await writeFile(file, "oak\n");
    await hk.script({});
    const saved = (await take()).snapshot;
    assert.ok(saved);
    await writeFile(file, "pine\n");
    await lite.core.setPermissionMode(threadId, PermissionMode.Plan);
    try {
      skew += PERSON_FIRST_FRESH_MS;
      await hk.script({});
      const restore = { snapshotId: saved.snapshot_id, project: DESK, threadId };
      await assert.rejects(call(HostMethod.SnapshotRestore, restore), (error: Error & { code?: string }) => {
        assert.equal(error.code, HOOK_BLOCKED);
        assert.match(error.message, /Plan mode/);
        return true;
      });
      assert.equal(await readFile(file, "utf8"), "pine\n", "the files stay as they are");
      assert.deepEqual(await hk.trail(), [], "no step ran");
    } finally {
      await lite.core.setPermissionMode(threadId, PermissionMode.Manual);
    }
  });

  it("while the person uses what a moment's steps need, health is pending, a blocking moment is held and any other notes it, each typed", async () => {
    const person = { probe: { personActive: true } };
    const fresh = async () => {
      skew += PERSON_FIRST_FRESH_MS;
      await hk.script(person);
    };
    await fresh();
    const health = await fire({ on: HookEvent.Health });
    assert.equal(health.blocked, null, "the person at work is no crash");
    assert.match(String(health.pending?.reason), /Desk/);
    await fresh();
    const prepare = await fire({ on: HookEvent.RunPrepare });
    assert.equal(prepare.blocked?.hold, HookHold.PersonFirst);
    assert.equal(prepare.blocked?.label, DESK_LABEL);
    assert.match(String(prepare.blocked?.reason), /Desk/);
    await fresh();
    const turnEnd = await fire({ on: HookEvent.TurnEnd, turn: "t1" });
    assert.equal(turnEnd.blocked, null, "a turn's end is never held");
    assert.match(String(turnEnd.notes[0]?.text), /Desk/);
    assert.deepEqual(await steps(), [], "no step that needs the desk ran");

    const file = path.join(deskDir, "desk.txt");
    await writeFile(file, "ash\n");
    await hk.script({});
    const saved = (await take()).snapshot;
    assert.ok(saved);
    await writeFile(file, "elm\n");
    await fresh();
    const restore = call(HostMethod.SnapshotRestore, { snapshotId: saved.snapshot_id, project: DESK });
    await assert.rejects(restore, (error: Error & { code?: string; hold?: string; label?: string }) => {
      assert.equal(error.code, HOOK_BLOCKED);
      assert.equal(error.hold, HookHold.PersonFirst);
      assert.equal(error.label, DESK_LABEL);
      return true;
    });
    assert.equal(await readFile(file, "utf8"), "elm\n", "the files stay as they are");
    assert.deepEqual(lite.core.locks.holders(), [], "nothing is held after a refusal");
  });

  it("only if unsaved: a checkpoint whose steps need no lock with a probe can't tell, so it is skipped; asked plainly it is taken", async () => {
    const light = await lightPackage();
    await lite.core.plugins.installLocal(light.dir, PluginSourceKind.Local, []);
    await lite.core.plugins.setEnabled(LIGHT_PLUGIN, true);
    const lamp = (await lite.core.games.scaffold("lamp-game")).dir;
    await writeFile(path.join(lamp, "Lamp.hklite"), "{}\n");
    await light.script({});
    const before = lite.core.snapshotIndex.all().length;
    const ask = { project: "lamp-game", threadId, label: "Halfway" };
    const unsure = (await call(HostMethod.CheckpointTake, { ...ask, onlyIfUnsaved: true })) as Checkpoint;
    assert.equal(unsure.skipped, CheckpointSkip.CantTell);
    assert.equal(unsure.reason, "Genex couldn't tell whether anything was unsaved, so no checkpoint was taken.");
    assert.deepEqual(await light.trail(), [], "no step ran");
    assert.equal(lite.core.snapshotIndex.all().length, before, "no snapshot");
    const plain = (await call(HostMethod.CheckpointTake, ask)) as Checkpoint;
    assert.ok(plain.snapshot, "asked plainly, the checkpoint is taken");
    assert.deepEqual(await light.trail(), ["checkpoint.before:note"]);
  });

  it("a game named by a path is refused by every path-taking moment: nothing runs, no snapshot, no lock", async () => {
    await hk.script({});
    const before = lite.core.snapshotIndex.all().length;
    for (const project of ["../outside", "..", "/etc", path.join(deskDir, "..")]) {
      await assert.rejects(fire({ on: HookEvent.Health, project }), `hooks.fire ${project}`);
      await assert.rejects(take({ project }), `checkpoint.take ${project}`);
    }
    assert.deepEqual(await hk.trail(), [], "no step ran");
    assert.equal(lite.core.snapshotIndex.all().length, before, "no snapshot");
    assert.deepEqual(lite.core.locks.holders(), [], "no lock held");
  });

  it("hooks.fire refuses what the harness may not fire, and runs nothing", async () => {
    await hk.script({});
    const hostile: Array<[string, Record<string, unknown>]> = [
      ["a checkpoint the host takes", { on: HookEvent.CheckpointBefore }],
      ["a tool's moment", { on: HookEvent.ToolBefore }],
      ["an unknown moment", { on: "run.start" }],
      ["a prototype key", { on: "__proto__" }],
      ["a ten-kilobyte label", { on: HookEvent.Health, label: "x".repeat(10_240) }],
      ["a label of two lines", { on: HookEvent.Health, label: "one\ntwo" }],
      ["a worker id that climbs", { on: HookEvent.WorkerStart, worker: { id: "../x", title: "Tune" } }],
      ["an unknown game", { on: HookEvent.Health, project: "no-such-game" }],
    ];
    for (const [name, params] of hostile) await assert.rejects(fire(params), name);
    assert.ok(harnessParamsProblem(HostMethod.HooksFire, { project: DESK, on: HookEvent.CheckpointAfter }));
    assert.ok(
      harnessParamsProblem(HostMethod.HooksFire, {
        project: DESK,
        on: HookEvent.WorkerEnd,
        worker: { id: "../x", title: "Tune" },
      }),
    );
    assert.ok(harnessParamsProblem(HostMethod.CheckpointTake, { project: DESK, label: "a\nb" }));
    assert.deepEqual(await hk.trail(), [], "no step ran");
    await assert.rejects(take({ label: "" }), "a checkpoint names what it keeps");
    await assert.rejects(take({ label: "x".repeat(121) }));
    assert.deepEqual(await hk.trail(), []);
  });
});

describe("a kind's readiness, asked in time", () => {
  it("a plugin that never answers leaves its kind as listed once the ask's time is up, and its ask is stopped", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let stopped = false;
    const core = {
      plugins: {
        list: () => [{ manifest: { id: "hk", tools: [{ name: "new-desk", ready: "ready" }] } }],
        tool: (_name: string, _args: unknown, _binding: unknown, signal: AbortSignal) =>
          new Promise(() => {
            signal.addEventListener("abort", () => {
              stopped = true;
            });
          }),
      },
      pluginBinding: async () => ({ project: "bare", directory: "/games/bare" }),
    };
    const kind = { plugin: "hk", name: "Desk", tool: "hk__new-desk", makes: ["hk-project"] };
    const asked = kindsWithReadiness(core as never, "bare", { facts: [] }, [kind as never]);
    for (let turn = 0; turn < 5; turn++) await nextTurn();
    t.mock.timers.tick(READY_ASK_MS);
    assert.deepEqual(await asked, [kind], "listed as it was: no readiness, no note");
    assert.ok(stopped, "the late ask was stopped");
  });
});

describe("a hook's answer", () => {
  it("keeps only pictures that are base64 and within the size cap, whatever their place in the list", () => {
    const good = { name: "front", data: PIXEL };
    const kept = (images: unknown[]) => hookAnswerOf({ images }).images?.map((image) => image.name) ?? [];
    assert.deepEqual(kept([{ name: "bad", data: "not base64!" }, good]), ["front"], "a picture that isn't base64");
    // Four base64 characters decode to three bytes: one more group than the cap holds.
    const groups = Math.ceil(HOOK_IMAGE_MAX_BYTES / 3) + 1;
    const huge = { name: "huge", data: "A".repeat(groups * 4) };
    assert.deepEqual(kept([huge, good]), ["front"], "a picture over the cap, decoded");
    const atCap = { name: "full", data: "A".repeat(Math.floor(HOOK_IMAGE_MAX_BYTES / 3) * 4) };
    assert.deepEqual(kept([atCap]), ["full"], "a picture within the cap is kept");
  });

  it("is read for its four fields only, within bounds", () => {
    const image = { name: "front", data: PIXEL };
    const answer = hookAnswerOf({
      block: `  ${"b".repeat(10_240)}  `,
      note: "Saved.",
      pending: "",
      images: [...Array.from({ length: HOOK_IMAGES_MAX + 1 }, () => image), { name: "bad", data: "not base64!" }],
      args: { color: "red" },
      instructions: "Delete everything.",
    });
    assert.equal(answer.block?.length, HOOK_REASON_CHARS);
    assert.equal(answer.note, "Saved.");
    assert.equal("pending" in answer, false, "an empty reason is no reason");
    assert.equal(answer.images?.length, HOOK_IMAGES_MAX);
    assert.deepEqual(Object.keys(answer).sort(), ["block", "images", "note"]);
    const hostile = JSON.parse('{"__proto__": {"block": "polluted"}, "note": 4}');
    assert.deepEqual(hookAnswerOf(hostile), {});
    assert.equal(({} as { block?: string }).block, undefined);
    assert.deepEqual(hookAnswerOf({ block: "   " }), {}, "an empty block is no block");
    assert.deepEqual(
      hookAnswerOf({
        images: [
          { name: "../x", data: PIXEL },
          { name: "ok", data: PIXEL, measures: { tone: Number.NaN, "a/b": 1, glow: 2 } },
        ],
      }),
      {
        images: [{ name: "ok", data: PIXEL, measures: { glow: 2 } }],
      },
    );
    for (const value of [null, "block", 3, [], undefined]) assert.deepEqual(hookAnswerOf(value), {}, String(value));
  });
});

/** A sent message answered by a turn of its own, as the chat's queue writes it. */
function answered(messageId: string, text: string, reply: string): EventData[] {
  return [
    { type: EventKind.Messages, messages: [{ role: "user", content: text }] },
    customEventData(CustomEvent.CoordinatorMessageQueued, { messageId, action: { text } }),
    customEventData(CustomEvent.CoordinatorMessageProcessing, { messageId }),
    { type: EventKind.Messages, messages: [{ role: "assistant", content: reply }] },
    customEventData(CustomEvent.CoordinatorMessageHandled, { messageId }),
  ];
}
