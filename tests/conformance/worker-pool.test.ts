/**
 * Genex's one worker pool behind the six worker tools: readers in place, writers in their own copy
 * made after a snapshot and merged back on `worker_mark used`, the one writer in place, the cap,
 * a worker waiting on the person, Stop and steer reaching only that worker, worker types, the close
 * that keeps a copy's work for a later turn, and a copy too large to make. A fake host (ctx-recorder)
 * answers the delegations the test drives; copies are real git worktrees of a temporary repository.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { buildChallenger } from "../../src/harness-seed/loop/facet/phases/build.ts";
import { withWorkerRoom } from "../../src/harness-seed/loop/workers/room.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import {
  poolWorkerId,
  WorkerEnd,
  WorkerIsolation,
  WorkerTool,
  type WorkerType,
  WorkerVerdict,
} from "../../src/shared/workers.ts";
import { gitFile } from "../helpers/git.ts";
import {
  CLAUDE,
  chatPool,
  delegation,
  finish,
  gameRepo,
  grantOf,
  leadCommits,
  PROJECT,
  poolHost,
  settle,
  shell,
  start,
  THREAD,
  TURN,
} from "../helpers/worker-pool-host.ts";

/** A test that would hang on a regression fails within this instead. */
const TEST_TIMEOUT_MS = 60_000;

describe("the worker pool", { timeout: TEST_TIMEOUT_MS }, () => {
  it("a reader works in place, read-only, and a research reader is offered web search", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    const reader = await start(pool, { title: "Read the code", task: "Find the game loop.", isolation: "read" });
    const researcher = await start(pool, {
      title: "Look up shaders",
      task: "Find how others light caves.",
      isolation: "read",
      research: "yes",
    });
    for (const id of [reader, researcher]) {
      const params = delegation(host, id);
      assert.equal(params.cwd, undefined, `${id} works in the game folder`);
      assert.equal(params.readOnly, true, `${id} only reads`);
      assert.equal(params.threadId, THREAD);
      assert.match(String(params.prompt), /^You are working inside Genex/, "the brief opens with Genex's identity");
    }
    assert.deepEqual(grantOf(host, reader), { id: reader, title: "Read the code", turn: TURN, research: false });
    assert.equal(grantOf(host, researcher).research, true);
    assert.match(String(delegation(host, reader).prompt), /Find the game loop\./);
    assert.deepEqual(host.recorder.sequence("snapshot."), [], "a reader needs no snapshot and no copy");
  });

  it("a writer works in its own copy made after a snapshot, and worker_mark used merges it back", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    const id = await start(pool, { title: "Add an enemy", task: "Add enemy.js.", isolation: "copy" });
    assert.deepEqual(host.recorder.sequence("snapshot."), [HostMethod.SnapshotCreate, HostMethod.SnapshotWorktree]);
    const copy = String(delegation(host, id).cwd);
    assert.notEqual(copy, repo, "it works in a copy");
    assert.equal(delegation(host, id).readOnly, undefined, "a writer may write");
    await writeFile(path.join(copy, "enemy.js"), "export const enemy = 1;\n");
    await finish(host, pool, id, { ok: true, sessionId: "s1", summary: "added" });
    assert.match(await pool.call(WorkerTool.Wait, { id }), /done.*worker_mark/);
    assert.match(await pool.call(WorkerTool.Mark, { id, verdict: "used" }), /Merged w1/);
    assert.equal(await readFile(path.join(repo, "enemy.js"), "utf8"), "export const enemy = 1;\n");
    assert.match((await shell("git log -1 --format=%s", repo)).stdout, /worker w1: Add an enemy/);
    assert.equal(existsSync(copy), false, "the copy goes after a clean merge");
  });

  it("never merges a copy's work that plants Claude Code's settings or hooks in the game, however it spells the folder", async () => {
    for (const planted of [".claude/settings.json", ".CLAUDE/hooks/pre.sh", "src/.claude/agents/helper.md"]) {
      const repo = await gameRepo();
      const host = poolHost(repo);
      const pool = await chatPool(host, repo);
      const id = await start(pool, { title: "Settings", task: "Tidy the settings.", isolation: "copy" });
      const copy = String(delegation(host, id).cwd);
      await mkdir(path.dirname(path.join(copy, planted)), { recursive: true });
      await writeFile(path.join(copy, planted), '{"hooks":{}}\n');
      await writeFile(path.join(copy, "enemy.js"), "export const enemy = 1;\n");
      await finish(host, pool, id, { ok: true, sessionId: "s1", summary: "tidied" });
      const answer = await pool.call(WorkerTool.Mark, { id, verdict: "used" });
      assert.match(answer, /^Not merged: .*Claude Code/, `${planted}: ${answer}`);
      assert.equal(existsSync(path.join(repo, planted)), false, `${planted} never reaches the game`);
      assert.equal(existsSync(path.join(repo, "enemy.js")), false, `${planted}: nothing of it merges`);
      assert.match(await pool.call(WorkerTool.Status, { id }), /worker_mark w1 used/, `${planted}: no verdict`);
    }
  });

  it("a conflicting merge is aborted and handed back to the lead with its files", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    const first = await start(pool, { title: "Change a", task: "Edit a.txt.", isolation: "copy" });
    const second = await start(pool, { title: "Change b", task: "Edit b.txt.", isolation: "copy" });
    await writeFile(path.join(String(delegation(host, first).cwd), "a.txt"), "worker\n");
    await writeFile(path.join(String(delegation(host, second).cwd), "b.txt"), "worker\n");
    for (const id of [first, second]) await finish(host, pool, id, { ok: true, sessionId: id });
    await leadCommits(repo, "a.txt", "lead\n");
    const conflict = await pool.call(WorkerTool.Mark, { id: first, verdict: "used" });
    assert.match(conflict, /conflicts with yours in a\.txt/);
    assert.match(conflict, /resolve them yourself in your folder, or start a worker on it/i);
    assert.equal(existsSync(path.join(repo, ".git", "MERGE_HEAD")), false, "the merge was undone");
    assert.equal(await readFile(path.join(repo, "a.txt"), "utf8"), "lead\n");
    // The lead's uncommitted change to a file the worker changed: git would refuse; nothing merges.
    await writeFile(path.join(repo, "b.txt"), "lead, not committed\n");
    const dirty = await pool.call(WorkerTool.Mark, { id: second, verdict: "used" });
    assert.match(dirty, /changes in b\.txt/);
    assert.equal(await readFile(path.join(repo, "b.txt"), "utf8"), "lead, not committed\n");
    assert.match(await pool.call(WorkerTool.Status, { id: first }), /worker_mark w1 used/, "no verdict yet");
  });

  it("a verdict stands once given, and work that went into the game can no longer be rejected", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    const copied = await start(pool, { title: "Add an enemy", task: "Add enemy.js.", isolation: "copy" });
    await writeFile(path.join(String(delegation(host, copied).cwd), "enemy.js"), "export const enemy = 1;\n");
    await finish(host, pool, copied, { ok: true, sessionId: "s1", summary: "added" });
    assert.match(await pool.call(WorkerTool.Mark, { id: copied, verdict: "used" }), /Merged w1/);
    const inPlace = await start(pool, { title: "Tune", task: "Tune the jump.", isolation: "lock" });
    await finish(host, pool, inPlace, { ok: true, sessionId: "s2", summary: "tuned" });
    const verdicts = () =>
      host.appended.filter((row) => row.type === CustomEvent.WorkerFinished && row.payload.verdict !== undefined);
    const rows: Array<[string, string, RegExp]> = [
      ["merged, then rejected", copied, /already marked used/],
      ["merged, then used again", copied, /already marked used/],
      ["written in place, then rejected", inPlace, /in your folder already/],
    ];
    for (const [name, id, refusal] of rows) {
      const verdict = name.endsWith("rejected") ? "rejected" : "used";
      assert.match(await pool.call(WorkerTool.Mark, { id, verdict }), refusal, name);
    }
    assert.deepEqual(
      verdicts().map((row) => [row.payload.workerId, row.payload.verdict]),
      [[poolWorkerId(copied), WorkerVerdict.Used]],
      "no refused verdict is recorded",
    );
    assert.equal(await readFile(path.join(repo, "enemy.js"), "utf8"), "export const enemy = 1;\n");
  });

  it("one writer in place at a time", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    const writer = await start(pool, { title: "Tune", task: "Tune the jump.", isolation: "lock" });
    assert.equal(delegation(host, writer).cwd, undefined, "it writes in the game folder");
    assert.equal(delegation(host, writer).readOnly, undefined);
    assert.match(
      await pool.call(WorkerTool.Start, { title: "More", task: "x", isolation: "lock" }),
      /w1 is writing in place/,
    );
    await start(pool, { title: "Read", task: "x", isolation: "read" });
    await finish(host, pool, writer);
    await start(pool, { title: "Next", task: "x", isolation: "lock" });
  });

  it("at most eight at once, and the ninth is told why", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    for (let n = 1; n <= 8; n++) await start(pool, { title: `Reader ${n}`, task: "x", isolation: "read" });
    const ninth = await pool.call(WorkerTool.Start, { title: "Reader 9", task: "x", isolation: "read" });
    assert.match(ninth, /Not started: 8 workers are running, and at most 8 run at once/);
    await settle();
    assert.equal(host.sessions.length, 8, "nothing was delegated for the ninth");
  });

  it("a worker waiting for the person is shown as waiting, and worker_wait wakes for it", async () => {
    const repo = await gameRepo();
    const log: unknown[] = [];
    const host = poolHost(repo, { log });
    const pool = await chatPool(host, repo);
    const id = await start(pool, { title: "Install", task: "Install the deps.", isolation: "lock" });
    const row = (state: string) => ({
      id: `e-${log.length + 1}`,
      data: {
        type: "custom",
        event_type: "tool_permission",
        payload: { requestId: "r1", state, title: "Claude wants to run npm install", worker: { id, title: "Install" } },
      },
    });
    log.push(row("pending"));
    const woke = await pool.call(WorkerTool.Wait, { seconds: "200" });
    assert.match(woke, /waiting for the person: Claude wants to run npm install\. Stop it, or work around it/);
    log.push(row("allowed"));
    assert.doesNotMatch(await pool.call(WorkerTool.Status, { id }), /waiting for the person/);
    assert.match(await pool.call(WorkerTool.Status, { id }), /running/);
  });

  it("a worker with two questions pending still waits for the person when one of them is answered", async () => {
    const repo = await gameRepo();
    const log: unknown[] = [];
    const host = poolHost(repo, { log });
    const pool = await chatPool(host, repo);
    const id = await start(pool, { title: "Install", task: "Install the deps.", isolation: "lock" });
    const row = (requestId: string, state: string, title: string) => ({
      id: `e-${log.length + 1}`,
      data: {
        type: "custom",
        event_type: "tool_permission",
        payload: { requestId, state, title, worker: { id, title: "Install" } },
      },
    });
    log.push(row("r1", "pending", "Claude wants to run npm install"));
    log.push(row("r2", "pending", "Claude wants to read ../shared"));
    log.push(row("r1", "allowed", "Claude wants to run npm install"));
    assert.match(
      await pool.call(WorkerTool.Status, { id }),
      /waiting for the person: Claude wants to read \.\.\/shared/,
      "the other question still waits",
    );
    log.push(row("r2", "denied", "Claude wants to read ../shared"));
    assert.match(await pool.call(WorkerTool.Status, { id }), /running/);
    assert.doesNotMatch(await pool.call(WorkerTool.Status, { id }), /waiting for the person/);
  });

  it("stop and steer reach only that worker", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    const writer = await start(pool, { title: "Build", task: "Build the level.", isolation: "copy" });
    const reader = await start(pool, { title: "Read", task: "Read the level.", isolation: "read" });
    const copy = String(delegation(host, writer).cwd);
    assert.match(await pool.call(WorkerTool.Steer, { id: writer, text: "Use stone, not wood." }), /reads this now/);
    assert.deepEqual(host.recorder.paramsOf(HostMethod.EngineInterrupt), [{ cwd: copy, worker: writer }]);
    await settle();
    const resumed = delegation(host, writer);
    assert.equal(resumed.resume, `s-${writer}`, "the same session goes on");
    assert.equal(resumed.prompt, "Use stone, not wood.");
    assert.match(await pool.call(WorkerTool.Stop, { id: reader }), /Stopped w2/);
    assert.deepEqual(host.recorder.paramsOf(HostMethod.EngineAbort), [{ cwd: repo, worker: reader }]);
    assert.match(await pool.call(WorkerTool.Status, { id: writer }), /running/, "the other worker goes on");
    assert.match(await pool.call(WorkerTool.Status, { id: reader }), /stopped/);
  });

  it("a type gives its tools and isolation; an unknown type lists the known ones", async () => {
    const repo = await gameRepo();
    const types: WorkerType[] = [
      {
        pluginId: "blender",
        id: "blender_model",
        description: "Models one prop in Blender.",
        tools: ["blender__"],
        isolation: WorkerIsolation.Copy,
      },
    ];
    const host = poolHost(repo, { types });
    const pool = await chatPool(host, repo);
    const id = await start(pool, { title: "Crate", task: "Model a crate.", type: "blender_model" });
    assert.deepEqual(delegation(host, id).toolAllow, ["blender__"]);
    assert.ok(delegation(host, id).cwd, "the type's isolation: its own copy");
    assert.match(String(delegation(host, id).prompt), /Models one prop in Blender\./);
    const unknown = await pool.call(WorkerTool.Start, { title: "x", task: "x", type: "texture" });
    assert.match(unknown, /no plugin that is on declares the worker type texture\. Known types: blender_model\./);
  });

  it("closing the pool stops running workers and keeps a copy's work for a later worker_mark", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    const running = await start(pool, { title: "Still at it", task: "x", isolation: "copy" });
    const finished = await start(pool, { title: "Done one", task: "x", isolation: "copy" });
    await writeFile(path.join(String(delegation(host, running).cwd), "half.txt"), "half\n");
    await writeFile(path.join(String(delegation(host, finished).cwd), "whole.txt"), "whole\n");
    await finish(host, pool, finished);
    await pool.close();
    assert.deepEqual(
      host.recorder.paramsOf(HostMethod.EngineAbort).map((p) => p.worker),
      [running],
      "only the running one is stopped",
    );
    for (const id of [running, finished]) {
      const ref = `refs/studio/chat/${THREAD}/workers/${id}`;
      assert.equal((await shell(`git rev-parse --verify -q ${ref}`, repo)).code, 0, `${id}'s work is kept on its ref`);
      assert.equal(existsSync(String(delegation(host, id).cwd)), false, `${id}'s copy is removed`);
    }
    const later = await chatPool(host, repo, "msg-2");
    assert.match(await later.call(WorkerTool.Status, {}), /w1 · Still at it · copy · stopped/);
    assert.match(await later.call(WorkerTool.Mark, { id: finished, verdict: "used" }), /Merged w2/);
    assert.equal(await readFile(path.join(repo, "whole.txt"), "utf8"), "whole\n");
    const finishedRecords = host.appended.filter((row) => row.type === CustomEvent.WorkerFinished);
    const verdict = finishedRecords.find((row) => row.payload.verdict === WorkerVerdict.Used);
    assert.equal(verdict?.payload.workerId, poolWorkerId(finished));
    assert.equal(verdict?.payload.turn, TURN, "a later turn's verdict lands on the turn that started the worker");
    const stopped = finishedRecords.find((row) => row.payload.workerId === poolWorkerId(running));
    assert.equal(stopped?.payload.state, WorkerEnd.Stopped);
    assert.equal(stopped?.payload.turn, TURN, "and so does the end of the worker its turn's close stopped");
  });

  it("a stop that reached the host before the worker's session registered is sent again until one is found", async () => {
    const repo = await gameRepo();
    let calls = 0;
    // The first stop finds no session yet (it was still being seated); the next one does.
    const host = poolHost(repo, {
      abort: (_p, end) => {
        calls += 1;
        if (calls === 1) return { aborted: 0 };
        end();
        return { aborted: 1 };
      },
    });
    const pool = await chatPool(host, repo);
    const id = await start(pool, { title: "Read", task: "Read the level.", isolation: "read" });
    assert.match(await pool.call(WorkerTool.Stop, { id }), /Stopped w1/);
    assert.equal(host.recorder.paramsOf(HostMethod.EngineAbort).length, 2, "sent again once nothing was found");
    assert.match(await pool.call(WorkerTool.Status, { id }), /stopped/);
    assert.equal(host.sessions.length, 1, "and it took no further leg");
  });

  it("a copy whose session is still writing at the close is handed back once that session ends", async () => {
    const repo = await gameRepo();
    // Its session ignores the stop for a while: the close may not take its copy from under it.
    const host = poolHost(repo, { abort: () => ({ aborted: 1 }) });
    const pool = await chatPool(host, repo);
    const id = await start(pool, { title: "Slow", task: "x", isolation: "copy" });
    const copy = String(delegation(host, id).cwd);
    await pool.close();
    assert.equal(existsSync(copy), true, "its copy stays while its session runs");
    await writeFile(path.join(copy, "late.txt"), "late\n");
    host.sessionOf(id).end({ ok: false, stopReason: "stopped" });
    const ref = `refs/studio/chat/${THREAD}/workers/${id}`;
    await pool.state.handingBack.get(id);
    assert.equal(existsSync(copy), false, "then it is removed");
    assert.equal(
      await gitFile(["show", `${ref}:late.txt`], { cwd: repo }).then(({ stdout }) => String(stdout)),
      "late\n",
    );
  });

  it("a copy still being made when the pool closes is removed once made, and no session starts in it", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    let made: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      made = resolve;
    });
    let asked: () => void = () => {};
    const copying = new Promise<void>((resolve) => {
      asked = resolve;
    });
    let copy = "";
    host.recorder.handle(HostMethod.SnapshotWorktree, async (p) => {
      asked();
      await gate;
      copy = path.join(path.dirname(repo), `${path.basename(repo)}-${String(p.name)}`);
      await gitFile(["worktree", "add", "-q", "--detach", copy, String(p.commit ?? "HEAD")], { cwd: repo });
      return { path: copy, commit: (await shell("git rev-parse HEAD", copy)).stdout.trim() };
    });
    const started = pool.call(WorkerTool.Start, { title: "Late", task: "x", isolation: "copy" });
    await copying;
    await pool.close();
    made();
    await started;
    await Promise.all(pool.state.runs.values());
    assert.ok(copy, "the copy was made");
    assert.equal(existsSync(copy), false, "and removed");
    assert.equal(host.sessions.length, 0, "no session started in it");
  });

  it("a builder the chat has no room for yet waits for room and tries again, until its deadline", async () => {
    let now = 0;
    const waits: number[] = [];
    const clock = {
      now: () => now,
      wait: async (ms: number) => {
        waits.push(ms);
        now += ms;
      },
      stopped: () => false,
    };
    const full = () => Object.assign(new Error("This chat already runs 2 workers"), { code: "too_many_workers" });
    let tries = 0;
    const ran = await withWorkerRoom(
      async () => {
        tries += 1;
        if (tries < 3) throw full();
        return "built";
      },
      60_000,
      clock,
    );
    assert.equal(ran, "built", "a full chat is a wait, never a broken build");
    assert.equal(waits.length, 2);
    now = 0;
    await assert.rejects(
      withWorkerRoom(async () => Promise.reject(full()), 15_000, clock),
      { code: "too_many_workers" },
      "past its deadline the refusal stands",
    );
    await assert.rejects(
      withWorkerRoom(async () => Promise.reject(new Error("the build broke")), 60_000, clock),
      /the build broke/,
      "any other failure is the build's",
    );
    const stopping = { ...clock, stopped: () => true };
    await assert.rejects(
      withWorkerRoom(async () => Promise.reject(full()), 60_000, stopping),
      {
        code: "too_many_workers",
      },
    );
  });

  it("a director's facet builder waits for room on the loop's own clock; a stop meanwhile ends the wait", async () => {
    /** A facet loop's builder whose host refuses its first `refusals` turns for room. */
    const facetBuilder = (refusals: number, stopAfterWaits = Infinity) => {
      const delegations: Array<Record<string, unknown>> = [];
      const waits: number[] = [];
      let refused = refusals;
      const ctx = {
        cancelled: false,
        setStatus: () => {},
        call: async (method: string, params: Record<string, unknown>) => {
          if (method !== HostMethod.EngineDelegate) return null;
          delegations.push(params);
          if (refused-- > 0)
            throw Object.assign(new Error("This chat already runs 2 workers"), { code: "too_many_workers" });
          return { ok: true, sessionId: "s1", summary: "built" };
        },
      };
      const loop = {
        ctx,
        deadline: Date.now() + 60 * 60_000,
        delegated: true,
        extraReadRoots: [],
        spikeRoots: [],
        facet: { id: "plaza", title: "Plaza" },
        run: { runId: "run_room", project: PROJECT, model: null },
        engineId: CLAUDE,
        facetThreadId: THREAD,
        worktree: "/runs/run_room/plaza",
        spec: { owns: [] },
        result: {},
        windDownMs: 0,
        emaAfterMs: 0,
        sessionId: null,
        outageRetries: 0,
        iterationsThisRound: 1,
        options: { worker: { id: "plaza", title: "Plaza", runId: "run_room" } },
        stoppedHere: async () => true,
        steering: async () => [],
        appendRun: async () => {},
        // A stop the director asks for while the builder waits: the loop's finish check says so.
        finishRequested: async () => (waits.length >= stopAfterWaits ? { by: "director", reason: "stopped" } : false),
        sleepFor: async (ms: number) => {
          waits.push(ms);
        },
      };
      const round: Record<string, unknown> = {
        acceptedShots: [],
        prompt: "Build the plaza.",
        promptImages: null,
        iteration: 2,
        userSteering: [],
      };
      return { loop, round, delegations, waits };
    };
    const waited = facetBuilder(1);
    await buildChallenger(waited.loop as never, waited.round as never);
    assert.equal(waited.round.buildFailed, null, String(waited.round.buildFailed));
    assert.equal(waited.delegations.length, 2, "asked again once there was room");
    assert.equal(waited.waits.length, 1, "it waited on the loop's own clock");
    assert.deepEqual(waited.delegations[1]?.worker, { id: "plaza", title: "Plaza", runId: "run_room" });

    const stopped = facetBuilder(1_000, 1);
    await buildChallenger(stopped.loop as never, stopped.round as never);
    assert.equal(stopped.delegations.length, 1, "no turn after the stop");
    assert.match(String(stopped.round.buildFailed), /already runs 2 workers/);
  });

  it("a copy too large to make is answered by its code, pointing at in-place work", async () => {
    const repo = await gameRepo();
    const tooLarge = Object.assign(new Error("This game is too large to copy (3 GB; the most is 2 GB)."), {
      code: "copy-too-large",
    });
    const host = poolHost(repo, { copyRefused: tooLarge });
    const pool = await chatPool(host, repo);
    const answer = await pool.call(WorkerTool.Start, { title: "Big", task: "x", isolation: "copy" });
    assert.match(answer, /too large to copy/, "the host's own words");
    assert.match(answer, /isolation lock/);
    assert.match(answer, /reader \(isolation read\)/);
    await settle();
    assert.equal(host.sessions.length, 0, "nothing was delegated");
    assert.match(await pool.call(WorkerTool.Status, {}), /No workers yet/);
  });

  it("refuses inputs that are not paths inside the project, with nothing made", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    for (const inputs of ["/etc/passwd", "~/.ssh/id_rsa", "../other/game.js", "src/../../x", "a\\b", "src//x"]) {
      const answer = await pool.call(WorkerTool.Start, { title: "x", task: "x", isolation: "copy", inputs });
      assert.match(answer, /is not a path inside the project/, inputs);
    }
    await settle();
    assert.deepEqual(host.recorder.sequence("snapshot."), [], "no snapshot, no copy");
    assert.equal(host.sessions.length, 0, "no delegation");
  });
});
