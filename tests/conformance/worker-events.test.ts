/**
 * Every worker a lead starts leaves a record when it starts and when it ends, on the chat's log,
 * scoped to its run or the chat turn that started it. The pool's records on a fake host
 * (`worker-pool-host.ts`: real git, sessions the test ends, every appended record kept), and the
 * key a graph of those records is drawn under.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { firstSentence } from "../../src/harness-seed/loop/workers/events.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { graphKeyOf, turnGraphKey, turnOfGraphKey } from "../../src/shared/run-graph-events.ts";
import {
  POOL_WORKER_PREFIX,
  poolWorkerId,
  WORKER_ASK_CHARS,
  WORKER_SUMMARY_CHARS,
  WORKER_TASK_CHARS,
  WorkerEnd,
  WorkerStopCode,
  WorkerTool,
  WorkerVerdict,
} from "../../src/shared/workers.ts";
import {
  chatPool,
  delegation,
  finish,
  gameRepo,
  type Host,
  leadCommits,
  PROJECT,
  poolHost,
  start,
  TURN,
} from "../helpers/worker-pool-host.ts";

/** A test that would hang on a regression fails within this instead. */
const TEST_TIMEOUT_MS = 60_000;
const RUN_ID = "run_garden";
const UNREAL_FACTS = [{ id: "unreal-project", path: "." }];

/** One worker's records, in order, each as its type and its payload without the time it was written. */
function recordsOf(host: Host, workerId: string) {
  const worker = [CustomEvent.WorkerStarted, CustomEvent.WorkerFinished] as string[];
  return host.appended
    .filter((record) => worker.includes(record.type) && record.payload.workerId === workerId)
    .map(({ type, payload }) => {
      const { at, ...rest } = payload;
      assert.equal(typeof at, "string", `${type} says when`);
      assert.ok(!Number.isNaN(Date.parse(String(at))), `${type}'s time is a date`);
      return { type, payload: rest };
    });
}

/** Every worker record the pool appended, as types. */
const workerRecordTypes = (host: Host) =>
  host.appended
    .map((record) => record.type)
    .filter((type) => type === CustomEvent.WorkerStarted || type === CustomEvent.WorkerFinished);

describe("a worker's start and end", { timeout: TEST_TIMEOUT_MS }, () => {
  it("records a run's worker when it starts and when it ends, under its pool id", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo, { runId: RUN_ID });
    const reader = await start(pool, { title: "Read the code", task: "Find the game loop.", isolation: "read" });
    const writer = await start(pool, { title: "Add an enemy", task: "Add enemy.js.", isolation: "copy" });
    await writeFile(path.join(String(delegation(host, writer).cwd), "enemy.js"), "export const enemy = 1;\n");
    const long = `${"The loop lives in main.js and ".repeat(20)}more.`;
    await finish(host, pool, reader, { ok: true, sessionId: "s1", summary: `${long} Second sentence.` });
    await finish(host, pool, writer, {
      ok: true,
      sessionId: "s2",
      summary: "Added an enemy that walks the left edge. It also tunes the spawn timer.",
    });
    const readerRecords = recordsOf(host, poolWorkerId(reader));
    assert.equal(poolWorkerId(reader), `${POOL_WORKER_PREFIX}${reader}`);
    assert.deepEqual(readerRecords[0], {
      type: CustomEvent.WorkerStarted,
      payload: {
        runId: RUN_ID,
        project: PROJECT,
        workerId: "pool.w1",
        title: "Read the code",
        isolation: "read",
        task: "Find the game loop.",
      },
    });
    const readerEnd = readerRecords[1]?.payload ?? {};
    assert.equal(readerRecords.length, 2);
    assert.equal(readerEnd.state, WorkerEnd.Done);
    assert.equal(readerEnd.delivered, undefined, "a reader delivers nothing");
    assert.ok(String(readerEnd.summary).length <= WORKER_SUMMARY_CHARS, "its summary is clipped");
    assert.ok(String(readerEnd.summary).startsWith("The loop lives in main.js"));
    assert.equal(readerEnd.turn, undefined, "a run's worker names its run, not a turn");
    assert.deepEqual(recordsOf(host, poolWorkerId(writer)), [
      {
        type: CustomEvent.WorkerStarted,
        payload: {
          runId: RUN_ID,
          project: PROJECT,
          workerId: "pool.w2",
          title: "Add an enemy",
          isolation: "copy",
          task: "Add enemy.js.",
        },
      },
      {
        type: CustomEvent.WorkerFinished,
        payload: {
          runId: RUN_ID,
          project: PROJECT,
          workerId: "pool.w2",
          title: "Add an enemy",
          state: WorkerEnd.Done,
          summary: "Added an enemy that walks the left edge.",
          delivered: true,
        },
      },
    ]);
  });

  it("records a chat turn's worker under that turn, with the request clipped", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const ask = "Make the car feel heavier. ".repeat(40);
    const pool = await chatPool(host, repo, { turn: TURN, ask });
    const task = "Check the physics. ".repeat(60);
    const id = await start(pool, { title: "Check the physics", task, isolation: "read" });
    await finish(host, pool, id, { ok: false, errorText: "the session ended early" });
    const [started, ended] = recordsOf(host, poolWorkerId(id));
    assert.equal(started?.payload.turn, TURN);
    assert.equal(started?.payload.runId, undefined, "no run");
    assert.equal(String(started?.payload.ask).length, WORKER_ASK_CHARS);
    assert.ok(ask.startsWith(String(started?.payload.ask)));
    assert.equal(String(started?.payload.task).length, WORKER_TASK_CHARS);
    assert.deepEqual(ended?.payload, {
      project: PROJECT,
      workerId: "pool.w1",
      title: "Check the physics",
      state: WorkerEnd.Failed,
      stoppedBecause: "the session ended early",
      stopCode: WorkerStopCode.Error,
      turn: TURN,
    });
  });
});

describe("a worker's verdict and the end of its turn", { timeout: TEST_TIMEOUT_MS }, () => {
  it("records the lead's verdict as a second end record; a used copy says it was added", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    const used = await start(pool, { title: "Center the steering", task: "Edit b.txt.", isolation: "copy" });
    const empty = await start(pool, { title: "Look again", task: "Change nothing.", isolation: "copy" });
    const reader = await start(pool, { title: "Read the code", task: "Read.", isolation: "read" });
    const clash = await start(pool, { title: "Change a", task: "Edit a.txt.", isolation: "copy" });
    await writeFile(path.join(String(delegation(host, used).cwd), "b.txt"), "worker\n");
    await writeFile(path.join(String(delegation(host, clash).cwd), "a.txt"), "worker\n");
    for (const id of [used, empty, reader, clash]) await finish(host, pool, id, { ok: true, sessionId: id });
    await leadCommits(repo, "a.txt", "lead\n");
    await pool.call(WorkerTool.Mark, { id: used, verdict: WorkerVerdict.Used });
    await pool.call(WorkerTool.Mark, { id: empty, verdict: WorkerVerdict.Used });
    await pool.call(WorkerTool.Mark, { id: reader, verdict: WorkerVerdict.Rejected, note: "Off topic" });
    assert.match(await pool.call(WorkerTool.Mark, { id: clash, verdict: WorkerVerdict.Used }), /conflicts/);
    const verdictOf = (id: string) => recordsOf(host, poolWorkerId(id)).slice(2);
    assert.deepEqual(verdictOf(used), [
      {
        type: CustomEvent.WorkerFinished,
        payload: {
          project: PROJECT,
          workerId: poolWorkerId(used),
          title: "Center the steering",
          verdict: WorkerVerdict.Used,
          merged: true,
          turn: TURN,
        },
      },
    ]);
    assert.equal(verdictOf(empty)[0]?.payload.verdict, WorkerVerdict.Used);
    assert.equal(verdictOf(empty)[0]?.payload.merged, undefined, "nothing of it was added");
    assert.deepEqual(verdictOf(reader), [
      {
        type: CustomEvent.WorkerFinished,
        payload: {
          project: PROJECT,
          workerId: poolWorkerId(reader),
          title: "Read the code",
          verdict: WorkerVerdict.Rejected,
          note: "Off topic",
          turn: TURN,
        },
      },
    ]);
    assert.deepEqual(verdictOf(clash), [], "a merge that failed leaves no verdict");
  });

  it("records an in-place worker that finished as work already in the game; one that failed, and a reader, as not", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    const tuned = await start(pool, { title: "Tune the jump", task: "Tune it.", isolation: "lock" });
    await finish(host, pool, tuned, { ok: true, sessionId: "s1", summary: "Tuned the jump." });
    const broke = await start(pool, { title: "Tune the brakes", task: "Tune them.", isolation: "lock" });
    await finish(host, pool, broke, { ok: false, errorText: "the session ended early" });
    const reader = await start(pool, { title: "Study", task: "Read.", isolation: "read" });
    await finish(host, pool, reader, { ok: true, sessionId: "s3", summary: "Read it." });
    const endOf = (id: string) => recordsOf(host, poolWorkerId(id))[1]?.payload ?? {};
    assert.equal(endOf(tuned).inGame, true, "its writes went straight into the game folder");
    assert.equal(endOf(tuned).delivered, undefined, "and there is nothing to hand back");
    assert.equal(endOf(broke).inGame, undefined, "a worker that did not finish is not counted");
    assert.equal(endOf(reader).inGame, undefined, "a reader writes nothing");
  });

  it("records workers stopped by the turn's end as stopped, and a worker waiting for the person as nothing", async () => {
    const repo = await gameRepo();
    const log: unknown[] = [];
    const host = poolHost(repo, { log });
    const pool = await chatPool(host, repo);
    const id = await start(pool, { title: "Install", task: "Install the deps.", isolation: "lock" });
    log.push({
      id: "e-1",
      data: {
        type: "custom",
        event_type: "tool_permission",
        payload: { requestId: "r1", state: "pending", title: "Claude wants to run npm install", worker: { id } },
      },
    });
    assert.match(await pool.call(WorkerTool.Status, { id }), /waiting for the person/);
    assert.deepEqual(workerRecordTypes(host), [CustomEvent.WorkerStarted], "waiting is no end");
    await pool.close();
    const ended = recordsOf(host, poolWorkerId(id)).slice(1);
    assert.deepEqual(ended, [
      {
        type: CustomEvent.WorkerFinished,
        payload: {
          project: PROJECT,
          workerId: poolWorkerId(id),
          title: "Install",
          state: WorkerEnd.Stopped,
          stoppedBecause: "the chat turn that started it ended",
          stopCode: WorkerStopCode.TurnEnded,
          turn: TURN,
        },
      },
    ]);
  });
});

describe("a worker an earlier chat turn left without an end", { timeout: TEST_TIMEOUT_MS }, () => {
  /** The `worker_finished` records of one worker, without the time each was written. */
  const endsOf = (host: Host, id: string) =>
    recordsOf(host, poolWorkerId(id))
      .filter((record) => record.type === CustomEvent.WorkerFinished)
      .map((record) => record.payload);
  const stoppedByTheTurn = (id: string, title: string) => ({
    project: PROJECT,
    workerId: poolWorkerId(id),
    title,
    state: WorkerEnd.Stopped,
    stoppedBecause: "the chat turn that started it ended",
    stopCode: WorkerStopCode.TurnEnded,
    turn: TURN,
  });

  it("is ended on the turn that started it when the next pool opens, once", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const first = await chatPool(host, repo);
    const id = await start(first, { title: "Read the code", task: "Find the game loop.", isolation: "read" });
    // The harness restarted under it: the first pool never closed, its record says it works.
    await chatPool(host, repo, "msg-2");
    assert.deepEqual(endsOf(host, id), [stoppedByTheTurn(id, "Read the code")]);
    await chatPool(host, repo, "msg-3");
    assert.equal(endsOf(host, id).length, 1, "a second open writes no second end");
  });

  it("is ended when the close stopped it but its session outlived the wait", async () => {
    const repo = await gameRepo();
    // The host takes the stop but the session never ends while the close waits.
    const host = poolHost(repo, { abort: () => ({ aborted: 1 }) });
    const first = await chatPool(host, repo);
    const id = await start(first, { title: "Read the code", task: "Find the game loop.", isolation: "read" });
    await first.close();
    assert.deepEqual(endsOf(host, id), [], "nothing ended it at the close");
    await chatPool(host, repo, "msg-2");
    assert.deepEqual(endsOf(host, id), [stoppedByTheTurn(id, "Read the code")]);
    await chatPool(host, repo, "msg-3");
    assert.equal(endsOf(host, id).length, 1, "a second open writes no second end");
  });
});

describe("why a worker stopped short, as a code the app words itself", { timeout: TEST_TIMEOUT_MS }, () => {
  it("names a refusal by the host, a stop by the lead and the end of a run by their codes", async () => {
    const repo = await gameRepo();
    const full = Object.assign(new Error("this chat already runs 3 workers, the most the person's Settings allow"), {
      code: "too_many_workers",
    });
    const refusing = poolHost(repo, { delegateRefused: full });
    const refusedPool = await chatPool(refusing, repo);
    const refused = await start(refusedPool, { title: "Port the car", task: "Port it.", isolation: "read" });
    await refusedPool.state.runs.get(refused);
    const codeOf = (host: Host, id: string) => recordsOf(host, poolWorkerId(id))[1]?.payload.stopCode;
    assert.equal(codeOf(refusing, refused), WorkerStopCode.HostRefused);

    const host = poolHost(await gameRepo());
    const pool = await chatPool(host, repo, { runId: RUN_ID });
    const stopped = await start(pool, { title: "Tune the jump", task: "Tune it.", isolation: "read" });
    await pool.call(WorkerTool.Stop, { id: stopped, why: "the person changed their mind" });
    await pool.state.runs.get(stopped);
    assert.equal(codeOf(host, stopped), WorkerStopCode.StoppedByLead);
    const left = await start(pool, { title: "Bake the lights", task: "Bake them.", isolation: "read" });
    await pool.close();
    assert.equal(codeOf(host, left), WorkerStopCode.RunEnded);
  });
});

describe("where a worker works, and a log that cannot be written", { timeout: TEST_TIMEOUT_MS }, () => {
  it("says a worker in the game folder of an Unreal project works in Unreal", async () => {
    const repo = await gameRepo();
    const unreal = poolHost(repo);
    const pool = await chatPool(unreal, repo, { facts: UNREAL_FACTS });
    const inPlace = await start(pool, { title: "Build the track", task: "Lay the track.", isolation: "lock" });
    const reader = await start(pool, { title: "Study", task: "Read.", isolation: "read" });
    const copy = await start(pool, { title: "Port the car", task: "Port it.", isolation: "copy" });
    const inOf = (host: Host, id: string) => recordsOf(host, poolWorkerId(id))[0]?.payload.in;
    assert.equal(inOf(unreal, inPlace), "unreal");
    assert.equal(inOf(unreal, reader), undefined, "a reader");
    assert.equal(inOf(unreal, copy), undefined, "a copy");
    const webRepo = await gameRepo();
    const web = poolHost(webRepo);
    const webPool = await chatPool(web, webRepo);
    const webInPlace = await start(webPool, { title: "Tune", task: "Tune it.", isolation: "lock" });
    assert.equal(inOf(web, webInPlace), undefined, "a web game");
    for (const [host, each] of [
      [unreal, pool],
      [web, webPool],
    ] as const)
      for (const id of each.state.records.map((record) => record.id)) await finish(host, each, id);
  });

  it("a failed write never stops the pool", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo, {
      append: () => {
        throw new Error("the log is full");
      },
    });
    const pool = await chatPool(host, repo);
    const id = await start(pool, { title: "Add an enemy", task: "Add enemy.js.", isolation: "copy" });
    await writeFile(path.join(String(delegation(host, id).cwd), "enemy.js"), "export const enemy = 1;\n");
    await finish(host, pool, id, { ok: true, sessionId: "s1", summary: "Added it." });
    assert.match(await pool.call(WorkerTool.Mark, { id, verdict: WorkerVerdict.Used }), /Merged w1/);
    await pool.close();
    assert.ok(
      host.recorder.paramsOf("events.append").length >= 3,
      "the start, the end and the verdict were each tried",
    );
  });
});

describe("the key a worker's graph is drawn under", () => {
  it("is its run, else the chat turn that started it, else none", () => {
    assert.equal(turnGraphKey("msg-1"), "turn:msg-1");
    assert.equal(turnOfGraphKey("turn:msg-1"), "msg-1");
    const rows: Array<[payload: { runId?: unknown; turn?: unknown }, key: string | null]> = [
      [{ runId: RUN_ID }, RUN_ID],
      [{ runId: RUN_ID, turn: "msg-1" }, RUN_ID],
      [{ turn: "msg-1" }, "turn:msg-1"],
      [{ runId: "", turn: "msg-1" }, "turn:msg-1"],
      [{ runId: 7, turn: "msg-1" }, "turn:msg-1"],
      [{ turn: "" }, null],
      [{ turn: ["msg-1"] }, null],
      [{}, null],
    ];
    for (const [payload, key] of rows) assert.equal(graphKeyOf(payload), key, JSON.stringify(payload));
    for (const key of [RUN_ID, "turn:", "", "turns:msg-1", "run_turn:msg-1"])
      assert.equal(turnOfGraphKey(key), null, `${key} names no turn`);
  });
});

it("a worker's sentence is its report's first plain sentence: markdown marks go, a long one is cut at a word", () => {
  const long = `${"The track bends left and right ".repeat(8)}then ends.`;
  const cases: Array<[string, unknown, string]> = [
    ["plain", "Centered the steering. Tests pass.", "Centered the steering."],
    ["a heading first", "## Summary\n\nI centered the steering. Tests pass.", "I centered the steering."],
    ["bold opening", "**Done.** Centered it.", "Done."],
    ["a list item", "- Centered the *steering* wheel\n- Tests pass", "Centered the steering wheel"],
    ["a quote after a rule", "---\n> Checked the `physics` first. Then more.", "Checked the physics first."],
    ["a heading with words", "# Ported the car", "Ported the car"],
    ["nothing but marks", "##\n---\n", ""],
    ["none", undefined, ""],
  ];
  for (const [name, text, expected] of cases) assert.equal(firstSentence(text), expected, name);
  const cut = firstSentence(long);
  assert.ok(cut.length <= WORKER_SUMMARY_CHARS, "a long sentence is clipped");
  assert.ok(cut.endsWith("…"), "a cut sentence says it was cut");
  assert.ok(long.startsWith(cut.slice(0, -1).trimEnd()) && /\s/.test(long.charAt(cut.length - 1)), "at a word");
});
