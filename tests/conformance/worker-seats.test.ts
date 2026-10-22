/**
 * The host's worker seat: which delegation is a worker of a chat's lead (only by the host's own
 * finding, and only on an engine that carries a seat), the mode it runs in (the chat's), the
 * folders it writes and reads, what it never reaches, the Settings ceiling and depth one, and Stop
 * and interrupt reaching only it. Its questions are `worker-questions.test.ts`'s. Real core, fake
 * engines, no harness; every wait is on what happened, never on a clock.
 */
import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { CustomEvent, customRecord } from "../../src/shared/custom-events.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { normalGamesElsewhere } from "../../src/main/core/never-touch-list.ts";
import { NeverTouchKind, pathVerdict } from "../../src/substrate/engines/never-touch.ts";
import { writeEngineBinding } from "../../src/substrate/game-engine-binding.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { ENGINES, GODOT_ENGINE } from "../helpers/engines.ts";
import { gitFile } from "../helpers/git.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { CODEX, closeWorkerChats, LOCAL, RUN_ID, realNearest, workerChat } from "../helpers/worker-chat.ts";

after(closeWorkerChats);

/** A case that would hang on a regression fails within this instead; each case has its own. */
const CASE_TIMEOUT_MS = 60_000;

/** A turn that holds until the test lets it go, or until it is stopped; `holds` collects the releases. */
function holding(holds: Array<() => void>) {
  return (request: DelegateRequest) =>
    new Promise<void>((resolve) => {
      holds.push(resolve);
      request.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
}

describe("the host's worker seat", () => {
  it("a worker of a run started in this chat runs in the chat's mode, with the never-touch list and write roots", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    // The normal profile's games, when this launch keeps its own elsewhere (a development profile).
    const normalGames = await realpath(await tmpDir("worker-seats-normal-games-"));
    const { core, lite, other, threadId, worktree, seen, delegate, runWorker, grantFolder } = await workerChat({
      neverTouchGames: [normalGames],
    });
    const granted = await realpath(await tmpDir("worker-seats-granted-"));
    await grantFolder(granted);
    const pluginFolder = await realpath(await tmpDir("worker-seats-plugin-folder-"));
    const missing = path.join(pluginFolder, "not-made-yet");
    // The folders an enabled plugin declares for its engine programs (a fake registry answer).
    core.plugins.workerFolders = () => [pluginFolder, missing];
    const realWorktree = await realpath(worktree);
    // Flipped: a coding CLI's whole home is a sign-in, not only its credential file.
    const codexHome = await realNearest(path.join(os.homedir(), ".codex"));
    const userData = await realpath(lite.userData);
    const otherGame = await realpath(other.dir);
    for (const mode of Object.values(PermissionMode)) {
      await core.setPermissionMode(threadId, mode);
      await delegate(runWorker());
      const request = seen.at(-1)!;
      const seat = request.worker;
      assert.ok(seat, `${mode}: a worker seat`);
      assert.equal(seat.mode, mode, `${mode}: the chat's mode`);
      assert.deepEqual([seat.id, seat.title], ["w1", "Worker w1"]);
      for (const root of [realWorktree, granted, pluginFolder])
        assert.ok(seat.writeRoots.includes(root), `${mode}: writes ${root}`);
      assert.ok(!seat.writeRoots.includes(missing), `${mode}: a plugin folder that does not exist yet is left out`);
      const roots = seat.neverTouch.roots.map((root) => root.path);
      for (const root of [codexHome, userData, otherGame])
        assert.ok(roots.includes(root), `${mode}: never touches ${root}: ${JSON.stringify(roots)}`);
      const normal = seat.neverTouch.roots.find((root) => root.path === normalGames);
      assert.equal(normal?.kind, NeverTouchKind.OtherGame, `${mode}: the normal profile's games are other games`);
      assert.ok(seat.neverTouch.open.includes(realWorktree), `${mode}: its own copy stays open`);
      assert.equal(request.permissions, undefined, `${mode}: not the chat's own session`);
      assert.equal(request.leadAsks, undefined, `${mode}: not a lead`);
      assert.equal(request.denyReads, undefined, `${mode}: the never-touch list replaces the sibling deny list`);
      assert.equal(Boolean(seat.asks), mode !== PermissionMode.Plan, `${mode}: asks unless read-only`);
      if (seat.asks) assert.deepEqual(seat.asks.worker, { id: "w1", title: "Worker w1" });
    }
    await core.setPermissionMode(threadId, PermissionMode.Manual);
    await delegate(runWorker(), CODEX);
    const codex = seen.at(-1)!.worker;
    assert.ok(codex, "a worker on an engine that cannot ask still has its seat");
    assert.equal(codex.asks, undefined, "and no way to ask");
  });

  it("a launch that keeps its games elsewhere names the normal profile's games folder; the normal launch does not", () => {
    const home = path.join(path.sep, "Users", "alice");
    const normal = path.join(home, "AI Games");
    assert.deepEqual(normalGamesElsewhere(path.join(home, "dev", "games"), home), [normal]);
    assert.deepEqual(normalGamesElsewhere(undefined, home), [normal], "a launch with the core's own games folder");
    assert.deepEqual(normalGamesElsewhere(normal, home), [], "the normal launch's own games are its games");
    assert.deepEqual(normalGamesElsewhere(`${normal}${path.sep}`, home), [], "however it is spelled");
  });

  it("no folder that is, holds or sits in a never-touch root becomes a worker's write root, whatever granted it", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, lite, other, threadId, worktree, seen, delegate, runWorker, grantFolder } = await workerChat();
    const gamesRoot = await realpath(path.dirname(other.dir));
    const inData = path.join(await realpath(lite.userData), "plugin-output");
    await mkdir(inData, { recursive: true });
    const fine = await realpath(await tmpDir("worker-seats-fine-"));
    // The person granted the chat another game, and the games folder that holds it.
    await grantFolder(await realpath(other.dir));
    await grantFolder(gamesRoot);
    core.plugins.workerFolders = () => [gamesRoot, inData, fine];
    await core.setPermissionMode(threadId, PermissionMode.Auto);
    await delegate(runWorker());
    const seat = seen.at(-1)!.worker;
    assert.ok(seat);
    assert.deepEqual(seat.writeRoots, [await realpath(worktree), fine], "its copy and a folder that holds nothing");
    for (const root of seat.writeRoots)
      assert.equal(pathVerdict({ path: root, searches: true }, seat.neverTouch), null, `${root} reaches no root`);
  });

  it("a game linked to a Godot project outside its folder lets its workers write that project; never another game's", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, project, other, threadId, seen, delegate, runWorker } = await workerChat();
    const outside = await realpath(await tmpDir("worker-seats-godot-"));
    await writeFile(path.join(outside, "project.godot"), "config_version=5\n");
    await writeEngineBinding(project.dir, path.join(outside, "project.godot"), GODOT_ENGINE.id, ENGINES);
    await core.setPermissionMode(threadId, PermissionMode.Auto);
    await delegate(runWorker());
    assert.ok(seen.at(-1)?.worker?.writeRoots.includes(outside), "the linked project's folder");
    // A game linked to a Godot project inside another game's folder gains nothing there.
    const elsewhere = path.join(other.dir, "godot");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, "project.godot"), "config_version=5\n");
    await writeEngineBinding(project.dir, path.join(elsewhere, "project.godot"), GODOT_ENGINE.id, ENGINES);
    await delegate(runWorker());
    const roots = seen.at(-1)?.worker?.writeRoots ?? [];
    const otherGame = await realpath(other.dir);
    assert.ok(!roots.some((root) => root.startsWith(otherGame)), JSON.stringify(roots));
  });

  it("a session that changed its game's facts (a project it made, a web build) tells the app's game list at its end", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, project, threadId, delegate, runWorker, whileRunning } = await workerChat();
    const changed: unknown[] = [];
    const emit = core.emit.bind(core);
    core.emit = ((type: string, payload: unknown) => {
      if (type === UiEvent.GameChanged) changed.push(payload);
      return emit(type as never, payload as never);
    }) as typeof core.emit;
    await core.setPermissionMode(threadId, PermissionMode.Auto);
    whileRunning(async () => {
      await mkdir(path.join(project.dir, "godot"), { recursive: true });
      await writeFile(path.join(project.dir, "godot", "project.godot"), "config_version=5\n");
    });
    await delegate(runWorker());
    assert.deepEqual(changed, [{ project: project.name }]);
    changed.length = 0;
    whileRunning(async () => {});
    await delegate(runWorker());
    assert.deepEqual(changed, [], "a session that changed nothing says nothing");
  });

  it("a run worker reads the folders of its own run its harness hands it, and no other run's", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, seen, delegate, runWorker, copyOf } = await workerChat();
    // A spike worktree of this run, as a facet's builder is told to read it, and another run's.
    const spike = await copyOf(RUN_ID, "spike-lighting");
    const otherRun = await copyOf("run_not_this_one", "spike-x");
    await delegate(runWorker("w1", undefined, { extraReads: [spike, otherRun] }));
    const request = seen.at(-1)!;
    const seat = request.worker;
    assert.ok(seat);
    const [realSpike, realOther] = [await realpath(spike), await realpath(otherRun)];
    assert.ok(request.extraReads?.includes(realSpike), "its own run's spike worktree is read");
    assert.ok(seat.neverTouch.open.includes(realSpike), "and stays open inside Genex's data");
    assert.equal(pathVerdict({ path: path.join(realSpike, "src", "a.js"), searches: false }, seat.neverTouch), null);
    assert.ok(!request.extraReads?.includes(realOther), "another run's folder is not");
    assert.ok(
      pathVerdict({ path: path.join(realOther, "src", "a.js"), searches: false }, seat.neverTouch),
      "and stays on the never-touch list",
    );
    void core;
  });

  it("a worker is never handed the connector its game's kind brings (an engine's live editor); the chat's own session is", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, delegate, runWorker, personSays } = await workerChat();
    const asked: Array<{ kindServers?: boolean }> = [];
    const toolsFor = core.mcp.toolsFor.bind(core.mcp);
    core.mcp.toolsFor = async (project, options = {}) => {
      asked.push(options);
      return toolsFor(project, options);
    };
    await delegate(runWorker());
    await delegate({ chatTurn: { messageId: await personSays() } });
    assert.deepEqual(
      asked.map((options) => options.kindServers),
      [false, undefined],
      "the worker without, the chat's own session with",
    );
  });

  it("a worker grant the host cannot confirm runs unattended as before", { timeout: CASE_TIMEOUT_MS }, async () => {
    const { core, api, game, other, threadId, project, seen, delegate, startRun, copyOf, runWorker } =
      await workerChat();
    const otherChat = await core.threadForGame(other.name);
    await startRun("run_other_game", otherChat, other.name);
    const secondChat = await core.store.createThread({
      title: "Second chat",
      metadata: { kind: "game", project: game },
    });
    await startRun("run_second_chat", secondChat);
    await startRun("run_finished");
    await core.append(
      [{ type: "custom", event_type: "run_finished", payload: { runId: "run_finished", project: game } }] as never,
      threadId,
    );
    const studioThread = String(await api["thread.create"]!({ title: "x" }));
    const elsewhere = await copyOf("run_elsewhere", "w1");
    const grant = (runId: string, cwd: string) => ({ cwd, worker: { id: "w1", title: "Worker", runId } });
    const turnGrant = { cwd: project.dir, worker: { id: "w1", title: "Worker", turn: "msg-x" } };
    const rows: Array<{ label: string; extra: Record<string, unknown>; thread?: string; engine?: string }> = [
      { label: "a run of another game", extra: grant("run_other_game", await copyOf("run_other_game", "w1")) },
      {
        label: "a run started in another chat",
        extra: grant("run_second_chat", await copyOf("run_second_chat", "w1")),
      },
      { label: "a run that finished", extra: grant("run_finished", await copyOf("run_finished", "w1")) },
      { label: "a turn the chat is not answering", extra: turnGrant },
      { label: "a Studio thread", extra: turnGrant, thread: studioThread },
      { label: "a cwd outside the run's worktrees", extra: runWorker("w1", elsewhere) },
      // A local model's session never carries a seat: its work stays fenced as unattended work.
      { label: "a local model's engine", extra: runWorker(), engine: LOCAL },
    ];
    for (const { label, extra, thread, engine } of rows) {
      await delegate({ ...extra, ...(thread ? { threadId: thread } : {}) }, engine);
      const request = seen.at(-1)!;
      assert.equal(request.worker, undefined, `${label}: no seat`);
      assert.equal(request.permissions, undefined, `${label}: nobody asks`);
      assert.ok(request.denyReads?.length, `${label}: the unattended fence`);
    }
  });

  it("while the chat's own session answers one turn, a grant for another turn or for a copy of another game is not a seat", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, other, project, seen, delegate, personSays, whileRunning, untilSeen } = await workerChat();
    // A copy of another game under scratch, where a turn worker's own copy would sit.
    const otherCopy = path.join(core.layout.scratch, "chat-copies", "other-w1");
    await mkdir(path.dirname(otherCopy), { recursive: true });
    core.snapshots.register({ name: other.name, dir: other.dir });
    await core.snapshots.worktreeAt(other.name, "HEAD", otherCopy);
    const turnA = await personSays();
    const turnB = await personSays();
    const holds: Array<() => void> = [];
    const hold = holding(holds);
    whileRunning(async (request) => {
      if (request.permissions) await hold(request);
    });
    const chat = delegate({ chatTurn: { messageId: turnA } }).catch(() => null);
    try {
      await untilSeen(1);
      assert.ok(seen[0]?.permissions, "the chat's own session answers turn A");
      const turnGrant = (turn: string, cwd: string) => ({ cwd, worker: { id: "w1", title: "Worker", turn } });
      // Not seated, it would need the game folder's own lock, which the chat's own session holds.
      const count = seen.length;
      await assert.rejects(delegate(turnGrant(turnB, project.dir)), { code: "folder_busy" }, "turn B: no seat");
      assert.equal(seen.length, count, "turn B: no session");
      await delegate(turnGrant(turnA, otherCopy));
      const copied = seen.at(-1)!;
      assert.equal(copied.worker, undefined, "a copy of another game: no seat");
      assert.ok(copied.denyReads?.length, "a copy of another game: the unattended fence");
    } finally {
      for (const release of holds) release();
      await chat;
    }
  });

  it("Plan keeps a worker read-only, and a worker never starts workers", { timeout: CASE_TIMEOUT_MS }, async () => {
    const { core, game, threadId, worktree, seen, delegate, runWorker } = await workerChat();
    await core.setPermissionMode(threadId, PermissionMode.Plan);
    await delegate(runWorker());
    const planned = seen.at(-1)!;
    assert.equal(planned.worker?.mode, PermissionMode.Plan);
    assert.equal(planned.worker?.asks, undefined, "a reader asks nothing");
    await core.setPermissionMode(threadId, PermissionMode.Auto);
    const director = { runId: RUN_ID, threadId, project: game, root: worktree, setup: null, tools: [] };
    const lead = { name: "launch_build", description: "x", parameters: { type: "object", properties: {} } };
    await delegate(runWorker("w1", worktree, { director, interviewTools: [lead], runControls: { runId: RUN_ID } }));
    const deep = seen.at(-1)!;
    assert.ok(deep.worker, "still a worker");
    assert.equal(deep.director, undefined, "no director grant");
    assert.equal(deep.interviewTools, undefined, "no interview tools");
    assert.ok(!(deep.liveTools ?? []).some((tool) => tool.name === "run_status"), "no run controls");
  });

  it("a seated builder's plugin calls keep its round; a seated worker with no round is recorded on its own node", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, game, threadId, worktree, delegate, runWorker, whileRunning } = await workerChat();
    // No Blender on a test machine: the plugin's backend is stood in for.
    core.plugins.tool = (async () => ({ ok: true })) as typeof core.plugins.tool;
    whileRunning(async (request) => {
      await Promise.resolve(request.onLiveTool?.("blender__status", {})).catch(() => null);
    });
    // A director's builder: its round rides its capture grant, as the facet loop sends it.
    const round = { project: game, root: worktree, runId: RUN_ID, facetId: "plaza", iteration: 3 };
    await delegate(runWorker("plaza", worktree, { selfCapture: round, computer: false }));
    await delegate(runWorker("w2"));
    const started = (await core.store.listEvents(threadId)).flatMap((event) => {
      const custom = customRecord(event.data);
      return custom?.event_type === CustomEvent.PluginToolStarted ? [custom.payload as Record<string, unknown>] : [];
    });
    assert.deepEqual(
      started.map(({ runId, facetId, iteration }) => ({ runId, facetId, iteration })),
      [
        { runId: RUN_ID, facetId: "plaza", iteration: 3 },
        { runId: RUN_ID, facetId: "w2", iteration: undefined },
      ],
    );
  });

  it("refuses a worker past the Settings ceiling before taking a lock; readers count as writers do", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, api, delegate, runWorker, copyOf, whileRunning, seen, untilSeen } = await workerChat();
    await core.updateSettings({ buildersMax: 2 });
    const holds: Array<() => void> = [];
    whileRunning(holding(holds));
    const first = delegate(runWorker("w1"));
    const reader = delegate(runWorker("r1", await copyOf(RUN_ID, "r1"), { readOnly: true }));
    try {
      await untilSeen(2);
      const before = (await api["engine.delegations"]!(undefined)) as unknown[];
      const refusal = (error: { code?: string }) => error;
      const writer = await delegate(runWorker("w3", await copyOf(RUN_ID, "w3"))).then(() => ({ code: "ran" }), refusal);
      assert.equal(writer.code, "too_many_workers", "a writer past a writer and a reader");
      const another = await delegate(runWorker("r2", await copyOf(RUN_ID, "r2"), { readOnly: true })).then(
        () => ({ code: "ran" }),
        refusal,
      );
      assert.equal(another.code, "too_many_workers", "a reader past them too");
      assert.deepEqual(await api["engine.delegations"]!(undefined), before, "no lock taken");
      assert.equal(seen.length, 2, "no third session");
    } finally {
      for (const release of holds) release();
      await Promise.all([first, reader]);
    }
  });

  it("Stop and interrupt by a worker's id reach a copy worker whether or not the host seated it, and only by its id", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { api, delegate, runWorker, copyOf, whileRunning, seen, untilSeen } = await workerChat();
    const holds: Array<() => void> = [];
    whileRunning(holding(holds));
    const seatedCopy = await copyOf(RUN_ID, "w7");
    // A grant naming a run that was never started in this chat: the host runs it unseated.
    const unseatedCopy = await copyOf("run_elsewhere", "w8");
    const seated = delegate(runWorker("w7", seatedCopy)).catch(() => null);
    const unseated = delegate(runWorker("w8", unseatedCopy, {}, "run_elsewhere")).catch(() => null);
    try {
      await untilSeen(2);
      const byId = (id: string) => seen.find((request) => request.cwd === (id === "w7" ? seatedCopy : unseatedCopy));
      assert.ok(byId("w7")?.worker, "the run's worker is seated");
      assert.equal(byId("w8")?.worker, undefined, "the other is not");
      assert.deepEqual(await api["engine.abort"]!({ cwd: seatedCopy, worker: "w8" }), { aborted: 0 }, "a wrong id");
      assert.deepEqual(await api["engine.interrupt"]!({ cwd: unseatedCopy, worker: "w7" }), { interrupted: false });
      for (const request of seen) assert.equal(request.signal?.aborted, false, "nothing was reached");
      assert.deepEqual(await api["engine.abort"]!({ cwd: seatedCopy, worker: "w7" }), { aborted: 1 }, "seated");
      assert.deepEqual(await api["engine.abort"]!({ cwd: unseatedCopy, worker: "w8" }), { aborted: 1 }, "unseated");
      assert.equal(byId("w7")?.signal?.aborted, true);
      assert.equal(byId("w8")?.signal?.aborted, true);
    } finally {
      for (const release of holds) release();
      await Promise.all([seated, unseated]);
    }
  });

  it("making a build live waits while a worker writes in the game folder", { timeout: CASE_TIMEOUT_MS }, async () => {
    const { core, project, delegate, runWorker, whileRunning, seen, untilSeen } = await workerChat();
    const holds: Array<() => void> = [];
    whileRunning(holding(holds));
    // A run worker in place: it runs under its own lock, never the game folder's.
    const writer = delegate(runWorker("w1", project.dir)).catch(() => null);
    try {
      await untilSeen(1);
      assert.ok(seen[0]?.worker, "seated in place");
      const head = String((await gitFile(["rev-parse", "HEAD"], { cwd: project.dir })).stdout).trim();
      await assert.rejects(core.landBuild(project.name, head), /building/i, "a writer is in the folder");
    } finally {
      for (const release of holds) release();
      await writer;
    }
  });

  it("an in-place worker runs beside the chat's own session, and Stop and interrupt reach only the worker they name", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, api, project, threadId, delegate, personSays, whileRunning, seen, untilSeen } = await workerChat();
    await core.setPermissionMode(threadId, PermissionMode.AcceptEdits);
    const said = await personSays();
    const holds: Array<() => void> = [];
    whileRunning(holding(holds));
    const chat = delegate({ chatTurn: { messageId: said } }).catch(() => null);
    await untilSeen(1);
    const reader = (id: string) => ({ cwd: project.dir, readOnly: true, worker: { id, title: id, turn: said } });
    const w1 = delegate(reader("w1")).catch(() => null);
    const w2 = delegate(reader("w2")).catch(() => null);
    try {
      await untilSeen(3);
      const [chatRequest, ...workers] = seen;
      const byId = (id: string) => workers.find((request) => request.worker?.id === id);
      assert.ok(chatRequest?.permissions, "the chat's own session");
      assert.ok(byId("w1") && byId("w2"), "two in-place workers beside it");
      const at = { cwd: project.dir };
      assert.deepEqual(await api["engine.abort"]!({ ...at, worker: "nope" }), { aborted: 0 }, "no such worker");
      assert.deepEqual(await api["engine.interrupt"]!({ ...at, worker: "nope" }), { interrupted: false });
      for (const request of seen) assert.equal(request.signal?.aborted, false, "nothing was reached");
      assert.deepEqual(await api["engine.interrupt"]!({ ...at, worker: "w2" }), { interrupted: true });
      assert.equal(byId("w2")?.signal?.aborted, true, "the worker it names");
      assert.deepEqual(await api["engine.abort"]!({ ...at, worker: "w1" }), { aborted: 1 });
      assert.equal(byId("w1")?.signal?.aborted, true, "the worker Stop names");
      assert.equal(chatRequest.signal?.aborted, false, "the chat's own session goes on");
    } finally {
      for (const release of holds) release();
      await Promise.all([chat, w1, w2]);
    }
  });
});
