/**
 * A chat turn's workers when the person writes or switches the Loop on while they work: a worker
 * wait ends as soon as the person's words are handed to the session (it reads them, then may wait
 * again); a Loop launched from the turn takes its workers over when it works in the same game
 * folder (they keep going as the run's), and otherwise lets them finish before the build starts.
 * Real git in a temporary game, worker sessions the test ends.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { personWrote } from "../../src/harness-seed/loop/person-wrote.ts";
import { WAIT_ENDED } from "../../src/harness-seed/loop/steer-switch-prompts.ts";
import {
  CARRY_TAKE_MS,
  carriedEnd,
  carryPool,
  closeCarriedPool,
  landWorkers,
  WorkersEnd,
} from "../../src/harness-seed/loop/workers/carry.ts";
import {
  chatWorkersCarry,
  chatWorkerTool,
  runningChatWorkers,
  withChatWorkers,
} from "../../src/harness-seed/loop/workers/chat-workers.ts";
import { runWorkersArtifact } from "../../src/harness-seed/loop/workers/records.ts";
import { closeRunPool, runPool } from "../../src/harness-seed/loop/workers/run-pool.ts";
import { WorkerTool } from "../../src/shared/workers.ts";
import {
  CLAUDE,
  chatPool,
  fastClock,
  finish,
  gameRepo,
  PROJECT,
  poolHost,
  settle,
  start,
  THREAD,
  TURN,
} from "../helpers/worker-pool-host.ts";

/** A copy worker, as a lead starts one. */
const COPY = { title: "Boss fight", task: "Build the boss.", isolation: "copy" };
/** A writer in the game folder itself. */
const IN_PLACE = { title: "Level", task: "Shape the level.", isolation: "lock" };

/** The run's seat over the same game folder, as an open Loop opens its pool. */
function runSeat(host: ReturnType<typeof poolHost>, repo: string, runId: string) {
  return {
    ctx: host.recorder.ctx as never,
    project: PROJECT,
    threadId: THREAD,
    runId,
    engine: CLAUDE,
    gameDir: repo,
    leadFolder: { project: PROJECT },
    identity: { folderLabel: "AI Games/garden", facts: [{ id: "unity-project", path: "." }] },
    clock: fastClock(),
  };
}

describe("a worker wait ends when the person writes", () => {
  it("worker_wait answers at once, says why, and the worker keeps going", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    const id = await start(pool, COPY);
    const waiting = pool.call(WorkerTool.Wait, { seconds: "240" });
    await settle();
    personWrote(THREAD);
    const answer = await waiting;
    assert.ok(answer.startsWith(WAIT_ENDED.workers), answer);
    assert.match(answer, new RegExp(`${id}`));
    assert.equal(pool.state.records[0]?.state, "running", "the worker was not stopped");
    await finish(host, pool, id);
    await pool.close();
  });

  it("another chat's words leave the wait alone", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    const id = await start(pool, COPY);
    const waiting = pool.call(WorkerTool.Wait, { seconds: "1" });
    personWrote("another chat");
    const answer = await waiting;
    assert.ok(!answer.startsWith(WAIT_ENDED.workers));
    await finish(host, pool, id);
    await pool.close();
  });
});

describe("a Loop launched from a turn whose workers still work", () => {
  it("a Loop in the same game folder takes them over: they keep going as the run's, and the chat keeps its earlier ones", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const earlier = await chatPool(host, repo, "msg-0");
    const done = await start(earlier, COPY);
    await finish(host, earlier, done);
    await earlier.close();
    const pool = await chatPool(host, repo);
    const id = await start(pool, COPY);
    assert.equal(carriedEnd(pool), WorkersEnd.Carry);
    carryPool(THREAD, TURN, pool);
    const run = await runPool(runSeat(host, repo, "run_carry"));
    assert.equal(run, pool, "the run's pool is the turn's own");
    assert.equal(run.state.scope.runId, "run_carry");
    assert.deepEqual(
      run.state.records.map((record) => [record.id, record.state]),
      [[id, "running"]],
    );
    const runRecords = host.artifacts.get(runWorkersArtifact("run_carry")) as { workers: Array<{ id: string }> };
    assert.deepEqual(
      runRecords.workers.map((record) => record.id),
      [id],
    );
    const chatRecords = host.artifacts.get("chat-workers") as { workers: Array<{ id: string }> };
    assert.deepEqual(
      chatRecords.workers.map((record) => record.id),
      [done],
      "the chat keeps its earlier turns' workers",
    );
    assert.equal(host.sessions.filter((s) => s.params.worker && (s.params.worker as any).id === id).length, 1);
    await finish(host, run, id);
    const ended = host.appended.filter((entry) => entry.type === "worker_finished").at(-1);
    assert.equal(ended?.payload.runId, "run_carry", "its end is the run's");
    await closeRunPool("run_carry");
  });

  it("a carried pool no run takes in time closes, its workers stopped as a turn's would be", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    await start(pool, COPY);
    carryPool(THREAD, TURN, pool);
    await pool.state.scope.clock.sleep(CARRY_TAKE_MS);
    await settle();
    assert.equal(pool.state.closing, true);
    assert.equal(pool.state.records[0]?.state, "stopped");
  });

  it("a launch that did not start closes the pool it was to take over", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    await start(pool, COPY);
    carryPool(THREAD, TURN, pool);
    await closeCarriedPool(THREAD);
    assert.equal(pool.state.records[0]?.state, "stopped");
  });

  it("a run over another folder never takes the pool: it closes, and the run opens its own", async () => {
    const repo = await gameRepo();
    const other = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    await start(pool, COPY);
    carryPool(THREAD, TURN, pool);
    const run = await runPool(runSeat(host, other, "run_other"));
    assert.notEqual(run, pool);
    await settle();
    assert.equal(pool.state.records[0]?.state, "stopped");
    await closeRunPool("run_other");
  });

  it("a writer in the game folder itself is never carried: the launch lets it finish first", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    await start(pool, IN_PLACE);
    assert.equal(carriedEnd(pool), WorkersEnd.Land);
    await pool.close();
  });

  it("finishing first: the launch waits for a writer in the game folder, and a Stop stops it at once", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    const id = await start(pool, IN_PLACE);
    const statuses: string[] = [];
    const landing = landWorkers(pool, { cancelled: false, setStatus: (status) => statuses.push(status) });
    await settle();
    assert.equal(pool.state.closing, false, "still waiting for the writer");
    assert.equal(statuses.length, 1, "the chat says why it waits");
    host.sessionOf(id).end({ ok: true, sessionId: "s" });
    await landing;
    assert.equal(pool.state.records[0]?.state, "done", "it finished its part");

    const stopped = await chatPool(host, repo, "msg-2");
    const second = await start(stopped, IN_PLACE);
    const ctx = { cancelled: false };
    const stopping = landWorkers(stopped, ctx);
    await settle();
    ctx.cancelled = true;
    await stopping;
    assert.equal(stopped.state.records.find((record) => record.id === second)?.state, "stopped");
  });

  it("a copy nobody is left to mark is not waited for: it stops as the build starts, its work kept", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    await start(pool, COPY);
    const statuses: string[] = [];
    await landWorkers(pool, { cancelled: false, setStatus: (status) => statuses.push(status) });
    assert.equal(pool.state.records[0]?.state, "stopped");
    assert.deepEqual(statuses, [], "nothing to wait for");
  });
});

describe("a chat turn's workers as the turn ends", () => {
  it("a turn that launched a Loop in place hands its workers on instead of stopping them; any other end stops them", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const seat = {
      threadId: THREAD,
      turn: TURN,
      engine: CLAUDE,
      project: PROJECT,
      gameDir: repo,
      folderLabel: "AI Games/garden",
      facts: [{ id: "unity-project", path: "." }],
    };
    let id = "";
    await withChatWorkers(
      host.recorder.ctx as never,
      seat,
      async () => {
        const answer = await chatWorkerTool({ threadId: THREAD, turn: TURN, name: WorkerTool.Start, args: COPY });
        id = /Started (w\d+)/.exec(answer)?.[1] ?? "";
        await settle();
        assert.equal(runningChatWorkers(THREAD, TURN), 1);
        return "launched";
      },
      (result) => (result === "launched" ? WorkersEnd.Carry : WorkersEnd.Stop),
      fastClock(),
    );
    const run = await runPool(runSeat(host, repo, "run_from_turn"));
    assert.deepEqual(
      run.state.records.map((record) => [record.id, record.state]),
      [[id, "running"]],
    );
    await closeRunPool("run_from_turn");
    assert.equal(run.state.records[0]?.state, "stopped", "the run's close stops what is left, as it would its own");

    await withChatWorkers(
      host.recorder.ctx as never,
      { ...seat, turn: "msg-3" },
      async () => {
        await chatWorkerTool({ threadId: THREAD, turn: "msg-3", name: WorkerTool.Start, args: COPY });
        await settle();
        return "answered";
      },
      undefined,
      fastClock(),
    );
    assert.equal(runningChatWorkers(THREAD, "msg-3"), 0);
  });

  it("what the session is told matches what the launch does: a writer in the game folder is let finish, never carried", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const seat = {
      threadId: THREAD,
      turn: "msg-4",
      engine: CLAUDE,
      project: PROJECT,
      gameDir: repo,
      folderLabel: "AI Games/garden",
      facts: [{ id: "unity-project", path: "." }],
    };
    const carries: boolean[] = [];
    await withChatWorkers(
      host.recorder.ctx as never,
      seat,
      async () => {
        await chatWorkerTool({ threadId: THREAD, turn: "msg-4", name: WorkerTool.Start, args: COPY });
        await settle();
        carries.push(chatWorkersCarry(THREAD, "msg-4"));
        await chatWorkerTool({ threadId: THREAD, turn: "msg-4", name: WorkerTool.Start, args: IN_PLACE });
        await settle();
        carries.push(chatWorkersCarry(THREAD, "msg-4"));
        return "answered";
      },
      undefined,
      fastClock(),
    );
    assert.deepEqual(carries, [true, false]);
    assert.equal(chatWorkersCarry(THREAD, "msg-5"), false, "another turn's pool is not this one");
  });
});
