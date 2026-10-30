import { gitFile } from "../helpers/git.ts";
/**
 * The director — the run as one agent's decisions. The tools it is given, the brief
 * it opens with, the contract a worker is started on, and one run through the real core and
 * the real harness child: a scripted director session starts a worker, waits for it, looks at
 * its build, integrates it, judges the integrated build, shows it to the user, and finishes —
 * every call crossing the studio → harness dispatch that answers, the integration branch
 * landing in the live folder at the end.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, before, describe, it } from "node:test";
import {
  EngineError,
  type CompleteRequest,
  type CompleteResponse,
  type DelegateRequest,
  type DelegateResult,
  type LiveToolResult,
} from "../../src/substrate/engines/types.ts";
import {
  customEvents,
  makeFakePreview,
  startRig,
  waitForLog,
  type FakePreview,
  type Rig,
} from "../helpers/studio-rig.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { type CtxHandler, ctxRecorder } from "../helpers/ctx-recorder.ts";
import { fakeFinishReview, reviewerAnswer, seatedReviewer } from "../helpers/reviewer.ts";
import { StopWhy } from "../../src/harness-seed/loop/finish-contract.ts";
import { buildRunGraph } from "../../src/renderer/run-graph.ts";
import { EntryAction, EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { summarizeRun } from "../../src/shared/run-summary.ts";
import { directorTool } from "../../src/harness-seed/loop/director.ts";

const rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.stop().catch(() => {})));
});

/** git in a worktree, the way the director itself works in one: with its own hands. */
const git = async (cwd: string, args: string[]): Promise<string> => (await gitFile(args, { cwd })).stdout.trim();

const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);
const json = (result: LiveToolResult): Record<string, any> => JSON.parse(text(result));

/**
 * The run's plan, which every director now writes before its first builder (M3.8) — the card
 * the user reads. The scripted sessions below call it the way a real one would.
 */
const planFor = (...ids: string[]): Record<string, unknown> => ({
  summary: "This run: make the plaza somewhere you would want to skate.",
  workers: JSON.stringify(
    ids.map((id) => ({
      id,
      title: id,
      seam: `the ${id}`,
      owns: `src/${id}.js`,
      done: [`the ${id} is there to see`],
      minutes: 20,
    })),
  ),
  base: "the integration branch as it stands",
  risks: "one window at a time on this machine",
});

/**
 * The vision a plan with a module contract gives beside it (loop/vision.ts): a loop worker under a
 * contract waits for both.
 */
const PLAZA_VISION = JSON.stringify({
  scale: "a plaza 40 metres across, three streets off it",
  far: "rooftops and a church spire past the nearest buildings, a dusk sky",
  set_pieces: ["the fountain at the plaza's heart", "a stair down to the river"],
  headroom: "the river bank and a market street the plaza could grow into",
});

/**
 * The same plan with the parts `singles` names built by one session only (`"mode":"single"`): one
 * looping part is left, so no module contract is needed before its worker starts (contract-gate.ts).
 */
const planWithSingle = (singles: string[], ...ids: string[]): Record<string, unknown> => {
  const plan = planFor(...ids);
  const parts = JSON.parse(String(plan.workers)) as Array<{ id: string }>;
  return {
    ...plan,
    workers: JSON.stringify(parts.map((part) => (singles.includes(part.id) ? { ...part, mode: "single" } : part))),
  };
};

describe("the director's tools and brief", () => {
  it("answers a tool call for a run without a director with a sentence, never a throw", async () => {
    assert.match(
      String(await directorTool({ runId: "run_nobody", name: "run_status", args: {} })),
      /no director session for run run_nobody/,
    );
  });
});

/**
 * The contract a worker is started on. The first director run wrote ten worker_start calls
 * with checks and no weights: every board read identityTotal 0, "satisfied" was unreachable,
 * and thirteen probes over `state.<facet>.<field>` read `missing:` for six hours because
 * nothing had ever read one against a real state().
 */
describe("a worker's contract: done, compiled and dry-run", () => {
  it("turns a running worker to finishing with worker_steer stage=, and back to building with a move", async () => {
    const { handler } = await import("../../src/harness-seed/loop/director/tools.ts");
    const ladder = [{ id: "rain", what: "rain slicks the street" }];
    const worker = {
      id: "paint",
      title: "Paint",
      state: "running",
      mode: "loop",
      steering: [] as string[],
      spec: { id: "paint", checks: [], milestones: ladder, moveOwner: "director" } as Record<string, unknown>,
    };
    const steered: string[] = [];
    const loopRun = {
      ctx: { cancelled: false },
      toolCalls: 0,
      toolsInFlight: 0,
      run: { runId: "apex" },
      state: { workers: new Map([["paint", worker]]), integrationHead: null, finished: false },
      journal: null,
      saveJournal: async () => {},
      keepMemory: async () => {},
      syncHead: async () => {},
      appendRun: async (_type: string, payload: { text?: string }) => void steered.push(String(payload.text)),
      interruptWorker: async () => false,
    };
    const steer = async (args: Record<string, unknown>) =>
      String(await handler(loopRun as never, "worker_steer", { id: "paint", ...args }));
    assert.match(await steer({}), /worker_steer needs text, move or stage/);
    assert.match(await steer({ stage: "finish" }), /next round finishes/);
    assert.equal(worker.spec.stage, "finish", "the loop holds this spec: its next round reads it");
    assert.match(steered.at(-1)!, /stage: finish/, "the steer is on the record");
    assert.match(await steer({ stage: "polish" }), /stage: "polish" is not a stage/);
    assert.equal(worker.spec.stage, "finish", "a refused steer changes nothing");
    assert.match(await steer({ stage: "finish", move: "traffic weaves in both lanes" }), /contradict/);
    // The director's explicit move always wins: the worker is back in the build stage.
    assert.match(await steer({ move: "traffic weaves in both lanes" }), /THE MOVE/);
    assert.equal(worker.spec.stage, "build");
    assert.match(await steer({ stage: "finish" }), /next round finishes/);
    assert.match(await steer({ stage: "build" }), /next round builds/);
    assert.equal(worker.spec.stage, "build");
    const single = { ...worker, id: "solo", mode: "single", spec: null };
    loopRun.state.workers.set("solo", single as never);
    assert.match(
      String(await handler(loopRun as never, "worker_steer", { id: "solo", stage: "finish" })),
      /single session/,
    );
  });
});

/** `complete` is the run's judge (judge.ts `askJudge` asks the run's own engine); "{}" is a tie. */
function fakeEngine(
  rig: Rig,
  delegate: (request: DelegateRequest) => Promise<DelegateResult>,
  complete: (request: CompleteRequest) => Promise<CompleteResponse> = async () => ({
    message: { role: "assistant", content: "{}" },
    usage: {},
    model: "fixture",
    engine: "codex",
    stopReason: "stop",
  }),
): void {
  rig.core.engines.register({
    id: "codex",
    label: "codex",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    complete,
    delegate,
  } as never);
}

/** The custom event types a run wrote, each once, in the order they first appear. */
function runEventTypes(events: Awaited<ReturnType<typeof waitForLog>>, runId: string): string[] {
  const types: string[] = [];
  for (const event of events) {
    if (event.data.type !== "custom") continue;
    const payload = (event.data as { payload?: { runId?: unknown } }).payload;
    if (payload?.runId !== runId || types.includes(event.data.event_type)) continue;
    types.push(event.data.event_type);
  }
  return types;
}

/** A run as the director's tool handler reads it, with a builder `plaza` and a recording host (answering `handlers` too). */
function markingLoopRun(state: string, handlers: Record<string, CtxHandler> = {}) {
  const rec = ctxRecorder({
    handlers: {
      ...handlers,
      "artifact.read": () => null,
      "artifact.write": () => 1,
      "events.head": () => null,
      "events.list": () => [],
      "plugins.workerTypes": () => [],
      "engine.delegate": () => ({ ok: true, engine: "claude-code", summary: "read it", usage: {}, turns: 1 }),
    },
  });
  const integrated: unknown[] = [];
  const cards: string[] = [];
  const plains: Array<string | null> = [];
  const log: Array<{ seq: number; text: string }> = [];
  const plaza = { id: "plaza", title: "Plaza", state, mode: "loop" };
  const loopRun = {
    ctx: rec.ctx,
    toolCalls: 0,
    toolsInFlight: 0,
    run: { runId: `run-mark-${state}`, project: "skate", engine: "claude-code" },
    threadId: "t-mark",
    projectDir: "/games/skate",
    integrationWorktree: "/runs/skate/integration",
    gameFacts: undefined,
    state: { integrationHead: "aaa", finished: false, workers: new Map([["plaza", plaza]]), ledger: [] },
    journal: null,
    waitSeq: 0,
    softDeadline: Date.now() + 60_000,
    finalDeadline: Date.now() + 120_000,
    saveJournal: async () => {},
    keepMemory: async () => {},
    syncHead: async () => {},
    integrate: async (args: unknown) => {
      integrated.push(args);
      loopRun.state.integrationHead = "bbb";
      return "merged plaza";
    },
    decision: async (text: string, plain?: string | null) => {
      cards.push(text);
      plains.push(plain ?? null);
    },
    note: (text: string) => log.push({ seq: log.length + 1, text }),
    notesSince: (seq: number) => log.filter((entry) => entry.seq > seq),
    ledgerLines: () => [],
    routeUserSteers: async () => {},
    inbox: { steering: async () => [], finishing: async () => false },
  };
  return { loopRun, rec, integrated, cards, plains, log };
}

/** The `worker_finished` records a director appended, by their payloads. */
function workerFinishes(rec: { paramsOf: (method: string) => Array<Record<string, unknown>> }) {
  return rec
    .paramsOf("events.append")
    .flatMap((params) =>
      ((params.batch as Array<Record<string, unknown>>) ?? []).flatMap((data) =>
        data.event_type === "worker_finished" ? [data.payload as Record<string, unknown>] : [],
      ),
    );
}

describe("the director's worker_mark and readers, in Genex's one worker model", () => {
  it("worker_mark rejected refuses a builder whose work is in the game already", async () => {
    const { handler } = await import("../../src/harness-seed/loop/director/tools.ts");
    const usedFirst = markingLoopRun("done");
    await handler(usedFirst.loopRun as never, "worker_mark", { id: "plaza", verdict: "used" });
    const integratedFirst = markingLoopRun("done");
    const plaza = integratedFirst.loopRun.state.workers.get("plaza");
    assert.ok(plaza);
    Object.assign(plaza, { integrated: true });
    for (const [name, { loopRun, rec, cards }] of [
      ["marked used", usedFirst],
      ["integrated by the lead", integratedFirst],
    ] as const) {
      const before = workerFinishes(rec).length;
      const answer = String(await handler(loopRun as never, "worker_mark", { id: "plaza", verdict: "rejected" }));
      assert.match(answer, /already in the game/, name);
      assert.equal(workerFinishes(rec).length, before, `${name}: no verdict is recorded`);
      assert.deepEqual(cards, [], `${name}: the feed says nothing was set aside`);
    }
  });
});

/** The reviewer sessions the host started for each fake host's claims, with their params. */
const REVIEWERS = new WeakMap<ReturnType<typeof ctxRecorder>, Array<Record<string, unknown>>>();

/**
 * A run as the director's `finish` reads it, on a fake host whose reviewer answers from `answers`
 * (the host's finish check: `fakeFinishReview`, its records kept beside the harness's); `log` is the
 * chat's log as `events.list` answers it, `said` the inbox's messages to the run.
 */
function claimingLoopRun(
  answers: Array<Record<string, unknown>>,
  over: { finishing?: boolean; log?: Array<Record<string, unknown>>; said?: string[]; engines?: unknown[] } = {},
) {
  const records: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
  const logged = (over.log ?? []).map((event) => (event as { data: (typeof records)[number] }).data);
  const kept = () => [...logged, ...records].filter((r) => r.event_type === "finish_check").map((r) => r.payload);
  const review = fakeFinishReview({
    delegate: () => answers.shift() ?? reviewerAnswer("yes"),
    append: (payload) => records.push({ event_type: "finish_check", payload }),
    records: kept,
  });
  const rec = ctxRecorder({
    unknown: { value: null },
    handlers: {
      ...review.handlers,
      "engine.describe": () => over.engines ?? [{ id: "codex", kind: "delegated", supportsSessions: true, models: [] }],
      "events.list": () => over.log ?? [],
      "observers.capture": () => [],
      "jobs.list": () => ({ jobs: [], seq: 0 }),
      "run.artifact": (p) => `/runs/run_claim/${String(p.name)}`,
      "events.append": (p) => {
        for (const item of p.batch as typeof records) records.push(item);
        return "e1";
      },
    },
  });
  REVIEWERS.set(rec, review.asked);
  const closes: Array<Record<string, unknown>> = [];
  const state: Record<string, any> = { finish: null, finished: false, integrationHead: "a".repeat(40) };
  const loopRun: Record<string, any> = {
    ctx: rec.ctx,
    run: { runId: "run_claim", project: "claim-game", goal: "a red plaza", engine: "codex" },
    threadId: "chat-1",
    projectDir: "/games/claim-game",
    integrationWorktree: "/scratch/autopilot/run_claim/integration",
    softDeadline: Date.now() + 60 * 60_000,
    report: {},
    state,
    inbox: {
      finishing: async () => over.finishing === true,
      steering: async () => over.said ?? ["make the plaza red"],
    },
    syncHead: async () => state.integrationHead,
    protectHead: async () => {},
    saveJournal: async () => {},
    withLease: async (_label: string, fn: (handle: string | null) => Promise<unknown>) => fn(null),
    evidenceOf: async () => ({ ok: true, problems: [], warnings: [], consoleErrors: [], shots: [], motion: [] }),
    closeTheLoopRun: async (options: Record<string, unknown>) => {
      closes.push(options);
      state.finished = true;
      return { ok: true, line: "verified by a judge" };
    },
  };
  const checks = () => records.filter((r) => r.event_type === "finish_check").map((r) => r.payload);
  return { loopRun, rec, closes, checks, state };
}

describe("the director's finish claim", () => {
  const reviewers = (rec: ReturnType<typeof ctxRecorder>) => REVIEWERS.get(rec) ?? [];

  it("victory=no and the person's own finish make no claim and ask no reviewer", async () => {
    const { finish } = await import("../../src/harness-seed/loop/director/integrate.ts");
    const report = claimingLoopRun([]);
    await finish(report.loopRun as never, { summary: "where it stopped", land: "no", victory: "no" });
    assert.deepEqual(reviewers(report.rec), [], "victory=no is a report, not a claim");
    assert.equal(report.closes[0]?.victory, false);
    const theirs = claimingLoopRun([], { finishing: true });
    await finish(theirs.loopRun as never, { summary: "as far as it got", land: "no", victory: "yes", review: "yes" });
    assert.deepEqual(reviewers(theirs.rec), [], "a Finish asked of the run ends it with no check");
    // Flipped: the chat's agent's finish_run asks the same Finish, so only a reviewer's yes records a victory.
    assert.equal(theirs.closes[0]?.victory, false, "and with no victory nobody checked");
    assert.deepEqual(theirs.checks(), []);
  });

  it("a timed build's finish once its hours are spent closes as its time running out; an idle or asked-for wrap-up does not", async () => {
    const { finish } = await import("../../src/harness-seed/loop/director/integrate.ts");
    const timed = { wallClockMs: 60 * 60_000, completionPolicy: "duration" };
    // A wrap-up brings `softDeadline` to now whatever its cause; the run's own clock keeps its cap.
    const wrappedUp = (cap: number, over: { finishing?: boolean } = {}) => {
      const run = claimingLoopRun([], over);
      run.loopRun.run.budgets = timed;
      run.loopRun.softDeadline = Date.now() - 1000;
      run.loopRun.clock = { started: cap - 60 * 60_000, softDeadline: cap, finalDeadline: cap + 15 * 60_000 };
      return run;
    };
    const late = wrappedUp(Date.now() - 60_000);
    await finish(late.loopRun as never, { summary: "where it got to", land: "yes" });
    assert.equal(late.closes[0]?.ended, StopWhy.Time, "the wrap-up at the cap: the hours ran out");
    const idle = wrappedUp(Date.now() + 60 * 60_000);
    await finish(idle.loopRun as never, { summary: "nothing more to do", land: "yes" });
    assert.equal(idle.closes.length, 1, "an idle lead's wrap-up closes it");
    assert.equal(idle.closes[0]?.ended, undefined, "with an hour left, not as its time running out");
    const asked = wrappedUp(Date.now() + 60 * 60_000, { finishing: true });
    await finish(asked.loopRun as never, { summary: "as far as it got", land: "no", victory: "no" });
    assert.equal(asked.closes.length, 1, "the person's own finish closes it");
    assert.equal(asked.closes[0]?.ended, undefined, "the person's finish is no time-out");
  });

  it("the lead's quote of the person's words never stands in for a claim's check", async () => {
    const { finish } = await import("../../src/harness-seed/loop/director/integrate.ts");
    const { loopRun, rec, closes } = claimingLoopRun([reviewerAnswer("yes")]);
    await finish(loopRun as never, {
      summary: "red",
      land: "yes",
      victory: "yes",
      review: "yes",
      user_asked: "make the plaza red",
    });
    assert.equal(reviewers(rec).length, 1, "the reviewer checks the claim");
    assert.equal(closes[0]?.victory, true);
  });

  it("a close that joined one that then fails before its run is finished tries once more", async () => {
    const { latchClose } = await import("../../src/harness-seed/loop/director/close-latch.ts");
    const state: { finished?: boolean } = {};
    let fail: (error: Error) => void = () => {};
    const claims = latchClose(state, () => new Promise((_resolve, reject) => void (fail = reject)));
    const clocks = latchClose(state, async () => ({ ok: true, by: "the clock" }));
    fail(new Error("the merge timed out"));
    await assert.rejects(claims, /merge timed out/);
    assert.deepEqual(await clocks, { ok: true, by: "the clock" }, "the joiner closes the run itself");
    const finished: { finished?: boolean } = {};
    let failLate: (error: Error) => void = () => {};
    const landed = latchClose(finished, () => new Promise((_resolve, reject) => void (failLate = reject)));
    const joined = latchClose(finished, async () => ({ ok: true }));
    finished.finished = true;
    failLate(new Error("the report failed"));
    await assert.rejects(landed);
    await assert.rejects(joined, /report failed/, "a run that finished closes no second time");
  });

  it("a close that fails before its run is finished lets a later close try again", async () => {
    const { latchClose, closeUnderWay } = await import("../../src/harness-seed/loop/director/close-latch.ts");
    const state: { finished?: boolean } = {};
    const failed = latchClose(state, () => Promise.reject(new Error("the merge timed out")));
    await assert.rejects(failed, /merge timed out/);
    assert.equal(closeUnderWay(state), false, "the failed close lets go");
    assert.deepEqual(await latchClose(state, async () => ({ ok: true })), { ok: true }, "a fresh close runs");
    const finished: { finished?: boolean } = {};
    const late = latchClose(finished, async () => {
      finished.finished = true;
      throw new Error("the report failed");
    });
    await assert.rejects(late);
    assert.equal(closeUnderWay(finished), true, "a run that finished keeps its one close");
  });

  it("a claim numbers its round past every round the run's log holds, whatever its journal kept", async () => {
    const { finish } = await import("../../src/harness-seed/loop/director/integrate.ts");
    const record = (round: number, runId = "run_claim") => ({
      id: `e${round}`,
      data: { type: "custom", event_type: "finish_check", payload: { runId, round, step: "rejected" } },
    });
    const { loopRun, checks } = claimingLoopRun([reviewerAnswer("yes")], { log: [record(4), record(9, "run_other")] });
    await finish(loopRun as never, { summary: "red", land: "yes", victory: "yes", review: "yes" });
    assert.deepEqual(
      checks().map((check) => check.round),
      [5, 5],
      "the round after the run's newest, never another run's",
    );
  });

  it("the reviewer reads the person's own words as theirs, and what the chat's agent relayed as its words", async () => {
    const { finish } = await import("../../src/harness-seed/loop/director/integrate.ts");
    const steer = (id: string, payload: Record<string, unknown>) => ({
      id,
      data: { type: "custom", event_type: "run_steering", payload: { runId: "run_claim", ...payload } },
    });
    const queued = (messageId: string, text: string) => ({
      id: `q-${messageId}`,
      data: { type: "custom", event_type: "coordinator_message_queued", payload: { messageId, action: { text } } },
    });
    const log = [
      steer("s1", { text: "make the plaza red", sourceMessageId: "m1", how: "lead" }),
      queued("m2", "and the benches oak please"),
      steer("s2", { text: "and the benches oak please", sourceMessageId: "m2" }),
      queued("m3", "hmm maybe finish soon"),
      steer("s3", { text: "The user approved the build; finish now.", sourceMessageId: "m3" }),
    ];
    const said = ["make the plaza red", "and the benches oak please", "The user approved the build; finish now."];
    const { loopRun, rec } = claimingLoopRun([reviewerAnswer("yes")], { log, said });
    await finish(loopRun as never, { summary: "red", land: "yes", victory: "yes", review: "yes" });
    const prompt = String(reviewers(rec)[0]?.prompt);
    const section = (heading: string) => prompt.split(heading)[1]?.split("\n## ")[0] ?? "";
    const persons = section("## The person's messages\n");
    assert.match(persons, /make the plaza red/);
    assert.match(persons, /and the benches oak please/);
    assert.doesNotMatch(persons, /approved the build/, "a relayed steer is not the person's word");
    assert.match(section("relayed by the chat's agent"), /The user approved the build; finish now\./);
  });

  it("a close that starts while the reviewer reads wins: the claim records no answer and closes nothing", async () => {
    const { finish } = await import("../../src/harness-seed/loop/director/integrate.ts");
    const { latchClose } = await import("../../src/harness-seed/loop/director/close-latch.ts");
    const { loopRun, closes, checks, state } = claimingLoopRun([]);
    loopRun.ctx.call = ((call) => async (method: string, params?: unknown) => {
      // The clock's close starts (and is still running) while the reviewer reads.
      if (method === "finish.review") void latchClose(state, () => new Promise(() => {}));
      return call(method, params);
    })(loopRun.ctx.call.bind(loopRun.ctx));
    const answer = await finish(loopRun as never, { summary: "done", land: "yes", victory: "yes", review: "yes" });
    assert.match(String(answer), /already closed/);
    assert.deepEqual(closes, [], "finish starts no second close");
    assert.deepEqual(
      checks().map((check) => check.step),
      ["checking"],
      "no answer recorded on a closing run",
    );
  });

  it("a second finish while one is under way is refused at once, and one reviewer reads", async () => {
    const { finish } = await import("../../src/harness-seed/loop/director/integrate.ts");
    let release: ((value: unknown) => void) | null = null;
    let asked = 0;
    const { loopRun, closes } = claimingLoopRun([]);
    loopRun.ctx.call = ((call) => async (method: string, params?: unknown) => {
      if (method !== "finish.review") return call(method, params);
      asked += 1;
      return new Promise((resolve) => {
        release = resolve;
      }).then(() => call(method, params));
    })(loopRun.ctx.call.bind(loopRun.ctx));
    const first = finish(loopRun as never, { summary: "red", land: "yes", victory: "yes", review: "yes" });
    const second = await finish(loopRun as never, { summary: "red", land: "yes", victory: "yes", review: "yes" });
    assert.match(String(second), /already under way/);
    while (!release) await new Promise<void>((resolve) => setImmediate(resolve));
    (release as (value: unknown) => void)(null);
    await first;
    assert.equal(asked, 1, "one reviewer");
    assert.equal(closes.length, 1);
  });

  it("a yes for a head that moved while the reviewer read does not close: the lead claims again", async () => {
    const { finish } = await import("../../src/harness-seed/loop/director/integrate.ts");
    const { loopRun, closes, state, checks } = claimingLoopRun([]);
    loopRun.ctx.call = ((call) => async (method: string, params?: unknown) => {
      // A worker's branch is integrated while the reviewer reads.
      if (method === "finish.review") state.integrationHead = "b".repeat(40);
      return call(method, params);
    })(loopRun.ctx.call.bind(loopRun.ctx));
    const answer = await finish(loopRun as never, { summary: "red", land: "yes", victory: "yes", review: "yes" });
    assert.match(String(answer), /The build moved while the reviewer read/);
    assert.deepEqual(closes, []);
    assert.deepEqual(
      checks().map((check) => [check.step, check.why ?? null]),
      [
        ["checking", null],
        ["unanswered", "the build moved while the reviewer read the claim"],
      ],
      "the yes that no longer speaks for the head is no answer: the graph never says Done",
    );
    assert.equal(state.finishTally?.rejections, 0);
  });

  it("a claim the clock closed the run under answers that the run already closed", async () => {
    const { finish } = await import("../../src/harness-seed/loop/director/integrate.ts");
    const { loopRun, closes, state } = claimingLoopRun([]);
    loopRun.ctx.call = ((call) => async (method: string, params?: unknown) => {
      // The clock closes the run while the reviewer reads.
      if (method === "finish.review") state.finished = true;
      return call(method, params);
    })(loopRun.ctx.call.bind(loopRun.ctx));
    const answer = await finish(loopRun as never, { summary: "done", land: "no", victory: "yes", review: "yes" });
    assert.match(String(answer), /already closed/);
    assert.deepEqual(closes, [], "finish closes nothing a second time");
  });
});

describe("a director's run through the real core and harness", () => {
  it("starts a worker, waits, looks, integrates, judges, shows, finishes — and the integration branch lands", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    assert.equal(rig.core.host.hasCapability("director"), true, "the seed claims the director");
    const project = await rig.core.games.scaffold("director-smoke", { title: "Director smoke" });
    // Blender files beside the web game: the lead's identity must read the game's own facts, not
    // the web game a director builds by default.
    await mkdir(path.join(project.dir, "art"), { recursive: true });
    await writeFile(path.join(project.dir, "art", "tree.blend"), "BLENDER");
    // The user has the game open in Live: the one load in this test that is theirs.
    await rig.core.loadPreview({ project: project.name });
    const liveLoadsBefore = rig.preview.loads.length;
    const seen: { director: DelegateRequest[]; workers: DelegateRequest[] } = { director: [], workers: [] };
    const reviewers: DelegateRequest[] = [];
    const results: Record<string, any> = {};
    fakeEngine(rig, async (request) => {
      // Flipped: the lead's claim is checked by a reviewer first, which says yes here.
      if (seatedReviewer(request)) {
        reviewers.push(request);
        return reviewerAnswer("yes", ["The plaza is red and lit from the default camera."]) as never;
      }
      if (request.director) {
        seen.director.push(request);
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        results.tools = (request.liveTools ?? []).map((t) => t.name);
        results.status0 = json(await call("run_status", {}));
        results.shot = await call("computer", { action: "screenshot" });
        results.noPlan = text(await call("worker_start", { id: "plaza", brief: "paint the plaza red" }));
        results.planned = text(await call("plan", planFor("plaza")));
        results.started = json(
          await call("worker_start", {
            id: "plaza",
            title: "Plaza",
            brief: "paint the plaza red",
            mode: "single",
            minutes: "5",
            owns: "src/plaza.js",
          }),
        );
        results.refused = text(await call("worker_start", { id: "plaza", brief: "again" }));
        for (let i = 0; i < 30; i++) {
          results.waited = json(await call("worker_wait", { seconds: "5", worker: "plaza" }));
          if (results.waited.status.workers[0]?.state !== "running") break;
        }
        results.wstatus = json(await call("worker_status", { id: "plaza" }));
        // A `done` entry with no check is refused before anything is created for it.
        results.badDone = text(
          await call("worker_start", {
            id: "bins",
            brief: "knock the bins over",
            done: JSON.stringify([{ what: "the bins move" }]),
          }),
        );
        results.looked = await call("look", { target: "plaza" });
        results.captured = await request.onCapture!({ cameras: "default" });
        results.integrated = json(await call("integrate", { worker: "plaza" }));
        results.judged = json(
          await call("judge", {
            target: "integration",
            against: "none",
            checks: JSON.stringify([
              { id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.5", weight: "identity" },
            ]),
          }),
        );
        results.played = json(await call("playtest", { target: "integration", ask: "Can I walk across the plaza?" }));
        results.shown = text(await call("show", { target: "integration" }));
        results.noted = text(await call("note", { text: "plaza integrated and lit" }));
        results.bad = text(await call("integrate", { worker: "nobody" }));
        results.finished = text(
          await call("finish", { summary: "the plaza is red and lit", land: "yes", victory: "yes", review: "yes" }),
        );
        results.after = text(await call("worker_start", { id: "late", brief: "too late" }));
        return { ok: true, engine: "codex", turns: 14, usage: {}, sessionId: "director-1", summary: "run done" };
      }
      if (request.playtest)
        return {
          ok: true,
          engine: "codex",
          turns: 1,
          usage: {},
          sessionId: "playtester-1",
          summary: JSON.stringify({ answers: { "director-play": { answer: "yes", note: "Walked across the plaza" } } }),
        };
      seen.workers.push(request);
      assert.ok(request.selfCapture, "a worker has eyes");
      assert.ok(
        request.liveTools?.some((t) => t.name === "computer"),
        "and hands",
      );
      results.workerShot = await request.onLiveTool!("computer", { action: "screenshot" });
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "plaza.js"), "export const plaza = 'red';\n");
      await mkdir(path.join(request.cwd, "docs", "notes"), { recursive: true });
      await writeFile(path.join(request.cwd, "docs", "notes", "NOTES.plaza.md"), "# plaza\npainted red\n");
      return {
        ok: true,
        engine: "codex",
        turns: 3,
        usage: {},
        sessionId: "worker-1",
        summary: "painted the plaza red",
      };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a red plaza",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished",
    );
    // The session closes after the run does (finish answers from inside it): give the window its moment.
    await waitForLog(
      rig.core,
      () =>
        rig.events.some(
          (e) =>
            e.type === "preview.screen" &&
            (e.payload as { role: string; state: string }).role === "director" &&
            (e.payload as { state: string }).state === "closed",
        ),
      15_000,
      "the director's screen to close",
    );

    // The run announced itself as a director's, and the session got the tools.
    assert.equal(customEvents(events, "run_started").find((e) => e.runId === runId)?.mode, "director");
    assert.equal(customEvents(events, "autopilot_started").find((e) => e.runId === runId)?.director, true);
    assert.ok(
      results.played,
      JSON.stringify({
        integrated: results.integrated,
        judged: results.judged,
        status: results.status0,
        failed: customEvents(events, "run_failed"),
        errors: events.filter((e) => e.data.type === "error"),
      }),
    );
    assert.equal(results.played.answer, "yes", "reporting preserves the successful playtest tool answer");
    const interaction = customEvents(events, "run_interaction_evidence").find((e) => e.runId === runId)!;
    assert.equal(interaction.status, "passed");
    assert.equal(interaction.source, "independent-playtester");
    assert.equal(
      interaction.head,
      customEvents(events, "integration_merge").find((e) => e.runId === runId && e.conflict === false)?.head,
      "playtest evidence belongs to the revision actually tested",
    );
    assert.equal(seen.director.length, 1, "one director session");
    // Flipped: the lead's claim was checked by one reviewer before the close.
    assert.equal(reviewers.length, 1, "one reviewer");
    assert.equal(
      seen.workers.length,
      1,
      `one worker session — worker_start answered ${JSON.stringify(results.started)}; waited ${JSON.stringify(results.waited?.happened)}`,
    );
    const director = seen.director[0]!;
    // Its identity reads the game as the run found it ready: its folder and what it holds.
    const folderLabel = project.dir.split("/").slice(-2).join("/");
    assert.ok(director.prompt.includes(`the folder \`${folderLabel}\``), "the game's folder");
    assert.match(director.prompt, /it holds a web game at its root, Blender files in `art\/`/, "the game's facts");
    // Flipped (one session): the lead is its chat's own session — it sits in the game folder; the
    // integration worktree is the build it leads (its grant's root).
    const worktree = director.director!.root;
    assert.equal(await realpath(director.cwd), await realpath(project.dir), "the lead sits in the game folder");
    assert.ok(worktree.includes(path.join("autopilot", runId, "integration")), worktree);
    // Flipped (Loop phase 3): it only read; it builds in that worktree with its own hands now.
    assert.notEqual(director.readOnly, true, "never read-only");
    assert.equal(director.leadBuilds, worktree, "its box writes the build it leads");
    for (const name of [
      "computer",
      "look",
      "run_status",
      "worker_start",
      "judge",
      "integrate",
      "show",
      "note",
      "finish",
    ])
      assert.ok(results.tools.includes(name), `${name} offered`);
    // Flipped (Loop phase 3): a waking lead may wait explicitly inside its turn, or end it and be
    // woken (director/wake.ts), so `worker_wait` is offered. Its handler still answers the old name
    // `wait` too, for a playbook the agent kept that names it, which is not offered.
    assert.ok(results.tools.includes("worker_wait"), "worker_wait is offered to a waking lead");
    assert.ok(!results.tools.includes("wait"), "never the old name");
    assert.ok(results.tools.includes("worker_mark"), "worker_mark is offered");

    // Tool answers, across the studio → harness dispatch.
    // Flipped: the hours are the working time and a grace follows them (time-cap.ts), so the run's end is 15 minutes past its 15.
    assert.ok(
      results.status0.time.hardMinutesLeft <= 30 &&
        results.status0.time.sessionMinutesLeft < results.status0.time.hardMinutesLeft,
      JSON.stringify(results.status0.time),
    );
    assert.equal(results.status0.integration.worktree, worktree);
    assert.equal(results.status0.capacity.windowsMax, 2);
    assert.ok(
      typeof results.shot !== "string" && results.shot.images?.length === 1,
      "the director's screenshot is a picture",
    );
    // The plan comes first: the run is refused until the user has something to read (M3.8).
    assert.match(results.noPlan, /call plan first/, results.noPlan);
    assert.match(results.planned, /the plan is in the user's chat/, results.planned);
    const planCard = customEvents(events, "autopilot_plan_review").find((e) => e.runId === runId)!;
    assert.deepEqual(
      (planCard.facets as Array<{ id: string; title: string }>).map((f) => f.id),
      ["plaza"],
    );
    assert.match(String(planCard.summary), /This run/);
    assert.equal(planCard.waitMinutes, 0, "nobody asked to review this one, so nothing waits for a word");
    assert.equal(results.started.started, "plaza");
    assert.equal(results.started.mode, "single");
    assert.match(results.refused, /already exists/);
    assert.equal(results.waited.status.workers[0].state, "done", JSON.stringify(results.waited));
    assert.ok(
      results.waited.happened.some((h: string) => /worker plaza done/.test(h)),
      JSON.stringify(results.waited.happened),
    );
    assert.equal(results.wstatus.state, "done");
    assert.match(results.wstatus.summary, /painted the plaza red/);
    assert.match(results.badDone, /done: every entry is \{"what"/, results.badDone);
    assert.ok(results.wstatus.lastCommit, "the studio committed the worker's folder");
    assert.match(text(results.looked), /the window now shows plaza \(/);
    assert.ok(
      typeof results.looked !== "string" && results.looked.images?.length === 1,
      "look answers with a screenshot",
    );
    assert.match(results.captured, /c\d+_default\.jpg/);
    assert.equal(results.integrated.merged, true, JSON.stringify(results.integrated));
    assert.equal(results.integrated.health.ok, true, JSON.stringify(results.integrated.health));
    assert.equal(results.judged.ok, true, JSON.stringify(results.judged));
    assert.ok(results.judged.shots.length >= 1);
    assert.equal(results.judged.board.summary.passing, 1, JSON.stringify(results.judged.board));
    assert.match(results.shown, /Live's Reload now offers integration/);
    assert.equal(results.noted, "noted");
    assert.match(results.bad, /no worker "nobody"/);
    assert.match(results.finished, /the run is closed — the integrated build [0-9a-f]{10} is live/);
    assert.match(results.after, /finishing; no new workers/);

    // The feed: worker cards, the merge, the show, the decisions, the closure.
    const workerEvents = customEvents(events, "director_worker").filter((e) => e.runId === runId);
    assert.deepEqual(
      workerEvents.map((e) => e.state),
      ["running", "done"],
    );
    assert.ok(workerEvents[1]!.lastCommit);
    // The builder's own worker records, as its session left them: its start with the lead's brief,
    // its end with its session's first sentence; the integrate then puts its line in the game.
    const plazaRecords = (type: string) =>
      customEvents(events, type).filter((e) => e.runId === runId && e.workerId === "plaza");
    const [plazaStart, ...moreStarts] = plazaRecords("worker_started");
    assert.deepEqual(moreStarts, []);
    assert.equal(plazaStart?.title, "Plaza");
    assert.equal(plazaStart?.isolation, "copy");
    assert.equal(plazaStart?.task, "paint the plaza red");
    const [plazaEnd, ...moreEnds] = plazaRecords("worker_finished");
    assert.deepEqual(moreEnds, [], "integrate writes no worker record");
    assert.equal(plazaEnd?.state, "done");
    assert.equal(plazaEnd?.delivered, true, "it committed work of its own");
    assert.equal(plazaEnd?.stopCode, undefined);
    assert.equal(plazaEnd?.summary, "painted the plaza red", "the session's own words, as worker_status says them");
    const plazaLines = toEntries(events).flatMap((entry) =>
      entry.kind === EntryKind.Action && entry.action === EntryAction.Worker ? [entry.text] : [],
    );
    // Flipped: the run's worker had a line ("Painted the plaza red. Added to your game."); it is a row of the run's card now.
    assert.deepEqual(plazaLines, []);
    const plazaTask = summarizeRun(events as never, project.name, runId).tasks.find((task) => task.id === "plaza");
    assert.equal(plazaTask?.integrations, 1, "the card's row reads added");
    const merges = customEvents(events, "integration_merge").filter((e) => e.runId === runId);
    assert.equal(merges.length, 1);
    assert.equal(merges[0]!.stage, "director");
    assert.equal(merges[0]!.conflict, false);
    assert.equal(customEvents(events, "director_show").find((e) => e.runId === runId)?.target, "integration");
    const decisions = customEvents(events, "autopilot_decision")
      .filter((e) => e.runId === runId)
      .map((e) => String(e.decision));
    assert.ok(
      decisions.some((d) => /director started worker "Plaza" \(plaza, single, 5 min\)/.test(d)),
      decisions.join(" | "),
    );
    assert.ok(decisions.includes("director: plaza integrated and lit"));
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.mode, "director");
    assert.equal(finished.landed, true);
    assert.equal(finished.victory, true);
    assert.equal(finished.summary, "the plaza is red and lit");
    assert.equal((finished.workers as Record<string, { state: string }>).plaza.state, "done");
    assert.equal(finished.stoppedBecause, "the director finished the run");

    // The integration branch landed in the live folder; the worktrees are gone.
    assert.equal(await readFile(path.join(project.dir, "src", "plaza.js"), "utf8"), "export const plaza = 'red';\n");
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    const log = (await api["run.exec"]!({
      command: "git log --oneline -5",
      project: project.name,
      timeoutMs: 30_000,
    })) as { stdout: string };
    assert.match(log.stdout, /integrated build/);
    assert.match(log.stdout, /integrate plaza/);
    await assert.rejects(stat(results.started.worktree), "the worker's worktree is removed");
    await assert.rejects(stat(worktree), "the integration worktree is removed");
    // Flipped: the user's window used to be loaded by the show and by the landing,
    // under them. Live now keeps what they opened; the show offered the integrated build and the
    // landing the changed game folder, each on Live's Reload.
    assert.equal(rig.preview.loads.length, liveLoadsBefore, "nothing the run did loaded the user's Live");
    const behind = rig.events
      .filter((e) => e.type === "live.behind")
      .map((e) => (e.payload as { reason: string | null }).reason);
    assert.ok(behind.includes("build"), `the show waits for Reload: ${JSON.stringify(behind)}`);
    assert.equal(behind.at(-1), "changed", `the landing waits for Reload: ${JSON.stringify(behind)}`);
    // The director's own window was on the strip, and closed with the session.
    const screens = rig.events
      .filter((e) => e.type === "preview.screen")
      .map((e) => e.payload as { role: string; state: string; label: string });
    assert.ok(
      screens.some((s) => s.role === "director" && s.state === "opened"),
      JSON.stringify(screens),
    );
    assert.ok(
      screens.some((s) => s.role === "director" && s.state === "closed"),
      `screens: ${JSON.stringify(screens)}`,
    );
    assert.ok(
      typeof results.workerShot !== "string" && results.workerShot.images?.length === 1,
      "the worker's screenshot is a picture",
    );
    assert.ok(
      screens.some((s) => s.role === "builder" && s.label === "Plaza"),
      `the worker's window carried its title: ${JSON.stringify(screens)}`,
    );

    // The whole run, pinned: the tools a web lead is offered, the run's event types in the order
    // they first appear, and the Builds graph's node kinds. Later phases flip these by name.
    assert.deepEqual(
      [...results.tools].sort(),
      [
        // Flipped: a lead may look at an app window (look-only, in every mode).
        "app_look",
        // Flipped: Local Blender asks the person on a card to download its pinned Blender.
        "blender__install",
        "blender__model",
        "blender__retrieve",
        "blender__status",
        "computer",
        "finish",
        "genex__asset",
        "genex__cli",
        "genex__cli-paid",
        // Genex's cover tools (`genex-cover`), which a lead checks before it publishes.
        "genex__cover",
        "genex__cover-set",
        "genex__package",
        "genex__publish",
        "genex__publish-status",
        "genex__skill",
        "goal_update",
        "integrate",
        // Flipped: a lead may run long commands in the background, in its chat's mode.
        "job_start",
        "job_status",
        "job_stop",
        "job_tail",
        "judge",
        "look",
        "note",
        // Flipped: a lead may look for a Genex plugin and show the person its card, in the chat its
        // run was started in.
        "plan",
        "playtest",
        "plugins_find",
        "plugins_suggest",
        "run_status",
        "show",
        "worker_mark",
        "worker_start",
        "worker_status",
        "worker_steer",
        "worker_stop",
        // Flipped (Loop phase 3): a waking lead may wait for its workers explicitly.
        "worker_wait",
        // Flipped: the user's ask to finish is recorded by the lead, quoting them.
        "wrap_up",
      ],
      "the web lead's tools",
    );
    // `run_learning` is left out: the learning pass appends it after `run_finished`, so the snapshot
    // taken when `run_finished` lands holds it only when the poll happens to be late.
    assert.deepEqual(
      runEventTypes(events, runId).filter((type) => type !== "run_learning"),
      [
        "run_registered",
        "run_started",
        "autopilot_started",
        "session_activity",
        "autopilot_plan_review",
        "director_worker",
        // Flipped: a builder also leaves the worker records every lead's workers leave.
        "worker_started",
        "autopilot_decision",
        // Flipped (Loop phase 3): the fork gate's verdict follows the start, which no longer waits for it.
        "director_verdict",
        "worker_finished",
        "integration_merge",
        "integration_health",
        "run_interaction_evidence",
        "director_show",
        // Flipped: the lead's claim is checked before the close, from Genex's own look at the build;
        // the look is kept first, then Genex records the round as its reviewer starts.
        "observer_capture",
        "finish_check",
        // Flipped (Loop phase 4): the close asked a judge (`completion_call`) before it landed; it asks none.
        "optimization_updated",
        "run_finished",
      ],
      "the run's event types, in first-appearance order",
    );
    assert.deepEqual(
      buildRunGraph(events)
        ?.nodes.map((node) => node.kind)
        .sort(),
      // Flipped: a run whose builder left worker records is a tree with the lead at its root; its
      // lead's claim was checked, so the finish check stands at its end.
      ["base", "facet", "final", "finish_check", "integration", "lead", "optimization", "run"],
      "the Builds graph's node kinds",
    );
  });

  /** The lead's own edit in the build it leads, committed there, so the close has something to land. */
  async function leadCommits(cwd: string, file: string, content: string): Promise<void> {
    await mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
    await writeFile(path.join(cwd, file), content);
    await git(cwd, ["add", "-A"]);
    await git(cwd, [
      "-c",
      "user.name=Studio",
      "-c",
      "user.email=studio@ai-game-studio.local",
      "commit",
      "-q",
      "-m",
      file,
    ]);
  }

  /** A long-turn lead's run on a fresh game: `lead` is its session; a reviewer answers from `reviews`, in order. */
  async function claimRun(
    name: string,
    lead: (
      call: (tool: string, args: Record<string, unknown>) => Promise<LiveToolResult>,
      cwd: string,
    ) => Promise<void>,
    reviews: Array<ReturnType<typeof reviewerAnswer>>,
  ) {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold(name, { title: name });
    const order: string[] = [];
    const reviewers: DelegateRequest[] = [];
    let sessions = 0;
    fakeEngine(
      rig,
      async (request) => {
        if (seatedReviewer(request)) {
          order.push("reviewer");
          reviewers.push(request);
          return (reviews.shift() ?? reviewerAnswer("yes")) as never;
        }
        assert.ok(request.director, "no worker in this run");
        sessions += 1;
        if (sessions === 1) await lead((tool, args) => request.onLiveTool!(tool, args), request.cwd);
        return { ok: true, engine: "codex", turns: 3, usage: {}, sessionId: "director-claim", summary: "done" };
      },
      async () => {
        order.push("judge");
        return {
          message: { role: "assistant", content: "{}" },
          usage: {},
          model: "fixture",
          engine: "codex",
          stopReason: "stop",
        };
      },
    );
    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a red plaza",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
      directorLoop: "turn",
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      180_000,
      `${name} to finish`,
    );
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    const checks = customEvents(events, "finish_check").filter((e) => e.runId === runId);
    return { events, finished, checks, order, reviewers, runId, project };
  }

  const NOT_DONE = ["The plaza is still grey from the north camera.", "Nothing lights the plaza at dusk."];

  it("a lead's claim it asks a reviewer to check is read before the run closes, and the close lands with no judge", async () => {
    const said: Record<string, string> = {};
    const { finished, checks, order, reviewers, project } = await claimRun(
      "director-claim",
      async (call, cwd) => {
        await leadCommits(cwd, "src/plaza.js", "export const plaza = 'red';\n");
        await leadCommits(cwd, "docs/proof.txt", "plaza colour: red from every camera\n");
        // A test report the lead wrote to prove the claim, which git does not track.
        await mkdir(path.join(cwd, "reports"), { recursive: true });
        await writeFile(path.join(cwd, "reports", "tests.txt"), "12 passed, 0 failed\n");
        said.finished = text(
          await call("finish", {
            summary: "the plaza is red",
            land: "yes",
            victory: "yes",
            review: "yes",
            proof: "docs/proof.txt,reports/tests.txt",
          }),
        );
      },
      [reviewerAnswer("yes", ["The plaza reads red."])],
    );
    assert.equal(reviewers.length, 1, "one reviewer");
    const [reviewer] = reviewers;
    assert.equal(reviewer?.readOnly, true);
    assert.ok(reviewer?.prompt.includes("plaza colour: red from every camera"), "it reads the lead's proof");
    assert.ok(reviewer?.prompt.includes("12 passed, 0 failed"), "and the report it wrote for the claim");
    assert.ok(String(reviewer?.extraReads?.[0]).includes(path.join("autopilot")), "it reads the build the lead leads");
    // Flipped (Loop phase 4): the close judged after the reviewer's yes; it asks no judge.
    assert.ok(!order.slice(order.indexOf("reviewer")).includes("judge"), `no judge after: ${order.join(", ")}`);
    assert.deepEqual(
      checks.map((check) => check.step),
      ["checking", "accepted"],
    );
    assert.match(said.finished ?? "", /the run is closed — the integrated build [0-9a-f]{10} is live/);
    assert.equal(finished.landed, true, String(finished.stoppedBecause));
    assert.equal(finished.victory, true);
    assert.equal(finished.stoppedBecause, "the director finished the run");
    await assert.rejects(
      stat(path.join(project.dir, "reports", "tests.txt")),
      "the untracked proof is evidence, never part of the landed build",
    );
    assert.match(await readFile(path.join(project.dir, "src", "plaza.js"), "utf8"), /red/, "the build itself landed");
  });

  describe("a lead the reviewer turns down", () => {
    let outcome: Awaited<ReturnType<typeof claimRun>>;
    const said: string[] = [];
    const between: string[] = [];
    before(async () => {
      outcome = await claimRun(
        "director-turned-down",
        async (call, cwd) => {
          await leadCommits(cwd, "src/plaza.js", "export const plaza = 'grey';\n");
          for (let round = 0; round < 3; round++) {
            said.push(
              text(await call("finish", { summary: "the plaza is red", land: "yes", victory: "yes", review: "yes" })),
            );
            between.push(text(await call("run_status", {})));
          }
        },
        [0, 1, 2].map(() => reviewerAnswer("no", NOT_DONE)),
      );
    });

    it("a no comes back to the lead with its reasons, and the run keeps working", () => {
      // Flipped (Loop phase 4): each no was counted toward three that closed the run; it decides nothing.
      assert.match(said[0] ?? "", /decides nothing/);
      for (const reason of NOT_DONE) assert.ok(said[0]?.includes(reason), said[0]);
      assert.match(said[1] ?? "", /decides nothing/);
      assert.ok(JSON.parse(between[0] ?? "{}").time, "run_status still answers after a no");
      const closedAt = outcome.events.findIndex(
        (e) => e.data.type === "custom" && e.data.event_type === "run_finished",
      );
      const firstNo = outcome.events.findIndex(
        (e) =>
          e.data.type === "custom" &&
          e.data.event_type === "finish_check" &&
          (e.data.payload as { step?: string }).step === "rejected",
      );
      assert.ok(firstNo >= 0 && firstNo < closedAt, "the first no came well before the close");
    });

    it("three no's in a row stop nothing: the run ends with the lead's session, naming what isn't done", async () => {
      assert.equal(outcome.reviewers.length, 3);
      assert.deepEqual(
        outcome.checks.filter((check) => check.step === "rejected").map((check) => check.rejections),
        [1, 2, 3],
      );
      // Flipped (Loop phase 4): the third no stopped the Loop and closed it as the reviewer's
      // ("the reviewer did not accept the finish", why: stuck); a no decides nothing. The app's
      // record still marks the row of three (the Unreal runner, a dev switch, stops on it); the
      // director closes nothing on it.
      assert.equal(outcome.checks.at(-1)?.stopped, true, JSON.stringify(outcome.checks.at(-1)));
      assert.doesNotMatch(said[2] ?? "", /the run is closed/);
      assert.match(said[2] ?? "", /decides nothing/);
      assert.equal(outcome.finished.victory, false, "the lead never closed it on its own word");
      assert.notEqual(outcome.finished.stoppedBecause, "the reviewer did not accept the finish");
      assert.deepEqual(outcome.finished.notDone, NOT_DONE, "what isn't done, in its own field");
      assert.deepEqual(
        outcome.finished.stillToFix,
        { done: [], notDone: NOT_DONE, why: StopWhy.Ended, hours: null },
        "its result card's list, and that the session ended it",
      );
      for (const reason of NOT_DONE)
        assert.ok(String(outcome.finished.summary).includes(reason), String(outcome.finished.summary));
      // The build that runs still lands by the close's own rule, as a clock's close does.
      assert.equal(outcome.finished.landed, true, "it loaded at the close, so it landed");
      const landed = await readFile(path.join(outcome.project.dir, "src", "plaza.js"), "utf8");
      assert.match(landed, /grey/, "the lead's last build reached the game folder");
    });
  });

  it("a lead's session that ends after a no makes no claim and names what the reviewer found not done", async () => {
    const said: string[] = [];
    const { finished, reviewers } = await claimRun(
      "director-timed-out",
      async (call, cwd) => {
        await leadCommits(cwd, "src/plaza.js", "export const plaza = 'grey';\n");
        said.push(
          text(await call("finish", { summary: "the plaza is red", land: "yes", victory: "yes", review: "yes" })),
        );
      },
      [reviewerAnswer("no", NOT_DONE)],
    );
    // Flipped (Loop phase 4): the no was counted toward three that closed the run; it decides nothing.
    assert.match(said[0] ?? "", /decides nothing/);
    assert.equal(reviewers.length, 1, "the run's own close asks no reviewer");
    assert.equal(finished.victory, false);
    assert.deepEqual(finished.notDone, NOT_DONE, "the report names what the reviewer found not done");
    // The lead's session ended within seconds of a quarter hour: its card says it stopped, not that its time ran out.
    assert.deepEqual(
      finished.stillToFix,
      { done: [], notDone: NOT_DONE, why: StopWhy.Ended, hours: null },
      "its card lists what the no found not done",
    );
    for (const reason of NOT_DONE)
      assert.ok(String(finished.summary).includes(reason), `the card's summary names it: ${finished.summary}`);
    for (const reason of NOT_DONE)
      assert.ok(!String(finished.stoppedBecause).includes(reason), String(finished.stoppedBecause));
  });

  /**
   * A game with a repository of its own inside it, which the studio was not allowed to version.
   * The merged build runs — it always did — and carries none of the work done inside that folder,
   * and `git status` cannot see the difference, because git does not walk into a gitlink. That is
   * a silent loss: a run's work reported as integrated and made live, and gone.
   * The health pass asks the commit instead, and says so in words the user reads.
   */
  it("fails the health pass on a merge that carries nothing from a repository inside the game", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-nested", { title: "Director nested" });
    // The user's own game, inside the folder they opened: its own repository, a pointer in this one.
    const nested = path.join(project.dir, "wreckage");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "car.js"), "export const car = 'wreck';\n");
    const asSomebody = ["-c", "user.email=you@example.com", "-c", "user.name=You"];
    await git(nested, ["init", "-q"]);
    await git(nested, ["add", "-A"]);
    await git(nested, [...asSomebody, "commit", "-q", "-m", "the game so far"]);
    await git(project.dir, ["add", "wreckage"]);
    await git(project.dir, [...asSomebody, "commit", "-q", "-m", "the game inside the folder"]);

    const results: Record<string, any> = {};
    let brief = "";
    fakeEngine(rig, async (request) => {
      if (request.director) {
        brief = request.prompt;
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        await call("plan", planFor("plaza"));
        results.started = json(
          await call("worker_start", {
            id: "plaza",
            title: "Plaza",
            brief: "paint the plaza red",
            mode: "single",
            minutes: "5",
            owns: "src/plaza.js",
          }),
        );
        for (let i = 0; i < 30; i++) {
          const waited = json(await call("wait", { seconds: "5", worker: "plaza" }));
          if (waited.status.workers[0]?.state !== "running") break;
        }
        results.integrated = json(await call("integrate", { worker: "plaza" }));
        results.finished = text(await call("finish", { summary: "the plaza is red", land: "yes" }));
        return { ok: true, engine: "codex", turns: 6, usage: {}, sessionId: "director-nested", summary: "run done" };
      }
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "plaza.js"), "export const plaza = 'red';\n");
      // …and a change inside the folder the studio does not version, which no commit will hold.
      await writeFile(path.join(request.cwd, "wreckage", "car.js"), "export const car = 'repaired';\n");
      return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "worker-nested", summary: "painted it" };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a red plaza",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished",
    );

    // The lead was told where to ask, rather than told a falsehood in either direction. Flipped (one
    // session): a lead that writes nothing is told the health pass says so, not to run git itself.
    assert.match(brief, /NESTED REPOSITORIES: wreckage/, brief.slice(0, 2000));
    assert.match(brief, /a health pass says this build carries nothing from inside it/);
    // The merge happened and the build runs; the health pass fails it anyway, and says why.
    assert.equal(results.integrated.merged, true, JSON.stringify(results.integrated));
    assert.equal(results.integrated.health.ok, false, JSON.stringify(results.integrated.health));
    assert.ok(
      (results.integrated.health.problems as string[]).some((p) =>
        /wreckage\/ is the user's own repository and this build carries nothing from inside it/.test(p),
      ),
      JSON.stringify(results.integrated.health.problems),
    );
    const health = customEvents(events, "integration_health").find((e) => e.runId === runId)!;
    assert.equal(health.ok, false);
    // And the card the user reads says what actually happened, not "it did not start".
    const cards = customEvents(events, "autopilot_decision")
      .filter((e) => e.runId === runId)
      .map((e) => String(e.plain));
    assert.ok(
      cards.some((c) => /carries nothing from the folder inside your game that keeps its own history/.test(c)),
      cards.join(" | "),
    );
    assert.ok(!cards.some((c) => /did not start when it was checked/.test(c)), cards.join(" | "));
    // What the run still may do: the folder and this build hold that repository the same way,
    // so landing it is an ordinary merge and the rest of the run's work goes live as usual.
    assert.match(results.finished, /the run is closed — the integrated build [0-9a-f]{10} is live/, results.finished);
    assert.equal(await readFile(path.join(project.dir, "src", "plaza.js"), "utf8"), "export const plaza = 'red';\n");
  });

  /**
   * The same folder, with the consent the Open Game sheet records: the
   * fork versions that repository, so an edit inside it is committed, merged and healthy like any
   * other. What the run still may not do is add it to the *user's* history — that renames their
   * own `.git` aside, and belongs to their own button (`landBuild`), not to a merge at 4 a.m.
   */
  it("versions a consented repository inside the game, and leaves the landing of it to the user", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-consented", { title: "Director consented" });
    const nested = path.join(project.dir, "wreckage");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, "car.js"), "export const car = 'wreck';\n");
    const asSomebody = ["-c", "user.email=you@example.com", "-c", "user.name=You"];
    await git(nested, ["init", "-q"]);
    await git(nested, ["add", "-A"]);
    await git(nested, [...asSomebody, "commit", "-q", "-m", "the game so far"]);
    // "Keep this folder", as the sheet writes it into the game's own studio.json.
    const meta = JSON.parse(await readFile(path.join(project.dir, "studio.json"), "utf8"));
    await writeFile(
      path.join(project.dir, "studio.json"),
      `${JSON.stringify({ ...meta, versionNested: true }, null, 2)}\n`,
    );
    await git(project.dir, ["add", "wreckage", "studio.json"]);
    await git(project.dir, [...asSomebody, "commit", "-q", "-m", "the game inside the folder"]);

    const results: Record<string, any> = {};
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        await call("plan", planFor("plaza"));
        results.started = json(
          await call("worker_start", {
            id: "plaza",
            title: "Plaza",
            brief: "repair the car",
            mode: "single",
            minutes: "5",
            owns: "wreckage/car.js",
          }),
        );
        for (let i = 0; i < 30; i++) {
          const waited = json(await call("wait", { seconds: "5", worker: "plaza" }));
          if (waited.status.workers[0]?.state !== "running") break;
        }
        results.integrated = json(await call("integrate", { worker: "plaza" }));
        results.finished = text(await call("finish", { summary: "the car is repaired", land: "yes" }));
        return {
          ok: true,
          engine: "codex",
          turns: 6,
          usage: {},
          sessionId: "director-consented",
          summary: "run done",
        };
      }
      await writeFile(path.join(request.cwd, "wreckage", "car.js"), "export const car = 'repaired';\n");
      return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "worker-consented", summary: "repaired it" };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "repair the car",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "car", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished",
    );

    // The edit inside the folder is ordinary versioned work: merged, and healthy.
    assert.equal(results.integrated.merged, true, JSON.stringify(results.integrated));
    assert.equal(results.integrated.health.ok, true, JSON.stringify(results.integrated.health));
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    const head = customEvents(events, "run_finished").find((e) => e.runId === runId)!.integrationHead as string;
    const carried = (await api["run.exec"]!({
      command: `git show ${head}:wreckage/car.js`,
      project: project.name,
      timeoutMs: 30_000,
    })) as { stdout: string };
    assert.match(carried.stdout, /repaired/, "the run's work inside that folder is in the build");

    // …and the landing of it is the user's to make, in words that name no branch.
    assert.match(
      results.finished,
      /not landed: wreckage\/ is the user's own repository inside the game folder/,
      results.finished,
    );
    assert.match(results.finished, /make this build live from the outcome card/, results.finished);
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, false);
    assert.equal((finished.landingResult as { why: string }).why, "nested-not-versioned");
    const close = customEvents(events, "director_verdict")
      .filter((e) => e.runId === runId)
      .find((e) => e.pass === "close")!;
    assert.match(
      String(close.because),
      /^Nothing was made live: part of this game keeps its own version history/,
      String(close.because),
    );
    assert.equal(
      await readFile(path.join(project.dir, "wreckage", "car.js"), "utf8"),
      "export const car = 'wreck';\n",
      "the user's own folder is untouched",
    );
  });

  it("a session limit ends the director: the head is kept on a ref, nothing is landed, and the run pauses — then the user can play or land any build", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-limit", { title: "Director limit" });
    const results: Record<string, any> = {};
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        results.status0 = json(await call("run_status", {}));
        await call("plan", planFor("sign"));
        results.started = json(
          await call("worker_start", {
            id: "sign",
            title: "Sign",
            brief: "hang a sign",
            mode: "single",
            minutes: "5",
            owns: "src/sign.js",
          }),
        );
        for (let i = 0; i < 30; i++) {
          results.waited = json(await call("wait", { seconds: "5", worker: "sign" }));
          if (results.waited.status.workers[0]?.state !== "running") break;
        }
        results.integrated = json(await call("integrate", { worker: "sign" }));
        results.judged = json(await call("judge", { target: "integration", against: "none" }));
        results.status1 = json(await call("run_status", {}));
        // The engine's own limit, as the CLI reports it: a rate limit that resets hours away.
        throw new EngineError(
          "rate_limit",
          "codex",
          "You've hit your session limit · resets 9:50pm (Europe/Belgrade)",
          4 * 3_600_000,
        );
      }
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "sign.js"), "export const sign = 'open';\n");
      return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "worker-2", summary: "hung the sign" };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a sign",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "sign", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished after a limit",
    );

    // The run's tools worked; the base was gated before the worker started.
    assert.equal(results.started.started, "sign", JSON.stringify(results.started));
    assert.equal(results.integrated.merged, true, JSON.stringify(results.integrated));
    assert.equal(results.judged.ok, true, JSON.stringify(results.judged));
    assert.match(results.status1.integration.ref, new RegExp(`refs/studio/runs/${runId}/integration`));
    assert.equal(results.status1.integration.lastJudge?.ok, true, JSON.stringify(results.status1.integration));
    const head: string = results.status1.integration.head;

    // The close: the limit named honestly, the run paused for Resume — and nothing landed (a close
    // on a lost provider cannot have the build checked, and Resume carries it on from its head).
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, false, String(finished.stoppedBecause));
    assert.equal((finished.landingResult as { why?: string }).why, "paused");
    assert.match(String(finished.stoppedBecause), /session limit/);
    assert.match(String(finished.stoppedBecause), /paused/);
    assert.match(String(finished.stoppedBecause), /nothing was landed/);
    assert.doesNotMatch(String(finished.stoppedBecause), /ran out of time/);
    assert.equal((finished.limit as { kind: string }).kind, "rate_limit");
    // When the limit was hit, so the host's auto-resume counts the reset from then, not from the close.
    const hitAt = (finished.limit as { at?: unknown }).at;
    assert.equal(typeof hitAt, "number", `limit.at: ${JSON.stringify(finished.limit)}`);
    assert.ok((hitAt as number) <= Date.parse(String(finished.finishedAt ?? new Date().toISOString())));
    assert.equal(finished.integrationRef, `refs/studio/runs/${runId}/integration`);
    assert.ok(String(finished.integrationHead).startsWith(head));
    assert.ok(
      customEvents(events, "autopilot_paused").some((e) => e.runId === runId),
      "the run is paused, not done",
    );
    const decisions = customEvents(events, "autopilot_decision")
      .filter((e) => e.runId === runId)
      .map((e) => String(e.decision));
    assert.ok(
      decisions.some((d) => /the engine hit its session limit/.test(d)),
      decisions.join(" | "),
    );
    await assert.rejects(
      readFile(path.join(project.dir, "src", "sign.js"), "utf8"),
      "the game folder is as the user left it until the run resumes",
    );
    await assert.rejects(
      stat(path.join(rig.core.layout.runs, runId, "director", `close_${head.slice(0, 8)}`, "verdict.json")),
      "the paused close looks at nothing and judges nothing",
    );

    // The ref outlives the worktree: the head is reachable in the game's repo.
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    const refs = (await api["run.exec"]!({
      command: `git show-ref refs/studio/runs/${runId}/integration`,
      project: project.name,
      timeoutMs: 30_000,
    })) as { stdout: string };
    assert.match(refs.stdout, new RegExp(`^${head}`));

    // After the run, the user plays a build from a copy and lands it — the same calls the chat's tools and the buttons make.
    const loadsBefore = rig.preview.loads.length;
    const [shown, repeated] = await Promise.all([
      rig.core.showBuild(project.name, head),
      rig.core.showBuild(project.name, head),
    ]);
    assert.deepEqual(repeated, shown, "overlapping Play requests share one scratch creation");
    assert.equal(rig.preview.loads.length, loadsBefore + 1, "one navigation for identical concurrent requests");
    await rig.core.showBuild(project.name, head);
    assert.ok(shown.commit.startsWith(head));
    assert.ok(shown.dir.includes(path.join("show", project.name)));
    assert.equal(await readFile(path.join(shown.dir, "src", "sign.js"), "utf8"), "export const sign = 'open';\n");
    assert.ok(rig.preview.loads.length > loadsBefore, "the user's window loaded the build");
    const landed = await rig.core.landBuild(project.name, head);
    assert.notEqual(landed.how, "already", "the paused close had landed nothing; the user's Make it live does");
    assert.equal(await readFile(path.join(project.dir, "src", "sign.js"), "utf8"), "export const sign = 'open';\n");
    await assert.rejects(rig.core.showBuild(project.name, "deadbeef"), /not in/);
    await assert.rejects(rig.core.landBuild(project.name, "nonsense"), /not a commit hash/);
  });
  /**
   * A game from scratch. Until now the run began on the empty scaffold: the fork gate refused
   * every worker ("every camera renders effectively black"), `judge against=start` answered "the
   * other build could not be observed", and the director hand-built the world for twelve minutes
   * before anyone could fork. The studio builds the starting point first now — the same stage the
   * classic pipeline always had — and everything that looks at it knows what it is looking at.
   */
  it("a run from scratch: the studio builds the starting point, workers fork from it, and judging against the start says first build", async () => {
    /** The empty scaffold as a window sees it: nothing drawn, and an inspection that proves it. */
    const asEmptyScaffold = (preview: FakePreview): FakePreview => {
      preview.pixelStatsNext = { width: 800, height: 600, sampled: 480_000, meanLuma: 0, litFraction: 0, canvas: true };
      preview.evaluations.push({ match: "isScene", value: true }, { match: "matrixWorld", value: "[1,0,0,1]" });
      return preview;
    };
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => asEmptyScaffold(makeFakePreview()) },
    );
    rigs.push(rig);
    asEmptyScaffold(rig.preview);
    const project = await rig.core.games.scaffold("director-scratch", { title: "From scratch" });
    const seen: { director: DelegateRequest[]; base: DelegateRequest[]; workers: DelegateRequest[] } = {
      director: [],
      base: [],
      workers: [],
    };
    const results: Record<string, any> = {};
    fakeEngine(rig, async (request) => {
      // Before the run's first session of any kind: the snapshots of this game taken so far.
      results.snapshotsAtFirstSession ??= (await rig.core.listAllEvents()).filter(
        (event) => event.data.type === "snapshot_created" && /director starting point/.test(String(event.data.reason)),
      ).length;
      if (request.director) {
        seen.director.push(request);
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        results.judged = json(await call("judge", { target: "integration", against: "start" }));
        // Flipped (module contract): plaza is a single session, so the plan has one looping part.
        await call("plan", planWithSingle(["plaza"], "plaza", "sky"));
        results.started = json(
          await call("worker_start", {
            id: "plaza",
            title: "Plaza",
            brief: "paint the plaza red",
            mode: "single",
            minutes: "5",
            owns: "src/plaza.js",
          }),
        );
        for (let i = 0; i < 30; i++) {
          results.waited = json(await call("wait", { seconds: "5", worker: "plaza" }));
          if (results.waited.status.workers[0]?.state !== "running") break;
        }
        // A fork from the worker's own commit is gated too — and that one is not a starting point.
        // Flipped (one session): the gate refuses a loop worker; a single one is a lead's repair
        // and starts on a build that does not run.
        // Flipped (Loop phase 3): worker_start answers at once and the gate runs in the background:
        // the refusal comes back as that worker's end.
        results.refusedFork = text(
          await call("worker_start", { id: "sky", brief: "a sky", mode: "loop", from: "plaza" }),
        );
        for (let i = 0; i < 30; i++) {
          results.skyWait = json(await call("worker_wait", { seconds: "5", worker: "sky" }));
          const sky = results.skyWait.status.workers.find((w: { id: string }) => w.id === "sky");
          if (sky?.state !== "running") break;
        }
        results.workers = json(await call("worker_status", {}));
        // A single worker is a lead's hands: it starts on that same build, to repair it.
        results.repair = json(
          await call("worker_start", {
            id: "repair",
            title: "Repair",
            brief: "make the plaza draw",
            mode: "single",
            minutes: "5",
            from: "plaza",
            owns: "src/plaza.js",
          }),
        );
        results.finished = text(
          await call("finish", { summary: "the starting point stands; the plaza is next", land: "no" }),
        );
        return {
          ok: true,
          engine: "codex",
          turns: 9,
          usage: {},
          sessionId: "director-scratch",
          summary: "built the world's shape",
        };
      }
      if (path.basename(request.cwd) === "integration") {
        seen.base.push(request);
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "world.js"), "export const world = { groups: ['plaza'] };\n");
        return {
          ok: true,
          engine: "codex",
          turns: 2,
          usage: {},
          sessionId: "base-1",
          summary: "cameras, palette, empty groups",
        };
      }
      seen.workers.push(request);
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "plaza.js"), "export const plaza = 'red';\n");
      return {
        ok: true,
        engine: "codex",
        turns: 3,
        usage: {},
        sessionId: "worker-scratch",
        summary: "painted the plaza red",
      };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a plaza to skate",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished on a fresh scaffold",
    );

    // A web Loop snapshots the game before its first session, whatever that session is.
    assert.equal(results.snapshotsAtFirstSession, 1, "the director's starting snapshot came first");
    // The starting point: one base session, in the run's integration worktree, on the base brief.
    assert.equal(seen.base.length, 1, `one base session, got ${seen.base.length}`);
    assert.match(seen.base[0]!.prompt, /You are building the starting scene/);
    assert.match(seen.base[0]!.prompt, /Do not spend this stage designing a large framework/);
    // Flipped: a third of the working time, which is now the whole 15 minutes (time-cap.ts), less the start.
    assert.match(seen.base[0]!.prompt, /PREPARATION BUDGET: 4 minutes/);
    assert.match(seen.base[0]!.prompt, /^You are working inside Genex/, "the base builder is told first who runs it");
    assert.ok(seen.base[0]!.timeoutMs! <= 300_000, "preparation leaves most working time to the lead");
    assert.doesNotMatch(seen.base[0]!.prompt, /0 facets/, "a director's run has no facet roll call");
    assert.ok(
      customEvents(events, "autopilot_base_started").some((e) => e.runId === runId),
      "the graph sees the base while its builder is running",
    );
    const base = customEvents(events, "autopilot_base").find((e) => e.runId === runId)!;
    assert.equal(base.ok, true, JSON.stringify(base));
    assert.equal(base.empty, true, "an empty world with working cameras is a valid starting point");
    assert.equal(typeof base.commit, "string");

    // The director opens on it, knowing what it is.
    assert.equal(seen.director.length, 1);
    assert.match(seen.director[0]!.prompt, /THE STARTING POINT: this game was an empty project/);
    assert.ok(
      seen.director[0]!.prompt.includes(String(base.commit).slice(0, 10)),
      "the brief names the commit it stands on",
    );

    // Judged before anyone builds: observed (blank pixels and all), with nothing to compare it to.
    assert.equal(results.judged.ok, true, JSON.stringify(results.judged.problems));
    assert.equal(results.judged.verdict.firstBuild, true, JSON.stringify(results.judged.verdict));
    assert.match(results.judged.verdict.note, /first build — nothing to compare/);

    // The first worker is accepted — the refusal that used to end a run from scratch is gone.
    assert.equal(results.started.started, "plaza", JSON.stringify(results.started));
    assert.ok(
      String(base.commit).startsWith(results.started.forkedFrom),
      `${results.started.forkedFrom} is the starting point ${base.commit}`,
    );
    assert.equal(
      seen.workers.filter((request) => request.selfCapture?.facetId === "plaza").length,
      1,
      "the worker session ran",
    );
    const plaza = seen.workers.find((request) => request.selfCapture?.facetId === "plaza");
    assert.match(String(plaza?.prompt), /^You are working inside Genex/, "and so is the worker");
    assert.deepEqual(
      [plaza?.worker?.id, plaza?.worker?.title],
      ["plaza", "Plaza"],
      "a single session's builder carries the run's worker grant, which the host honoured",
    );

    // Every other fork is gated as well, and the worker's own build is not a starting point.
    // Flipped (Loop phase 3): the start answered at once; the gate's refusal ended the worker.
    assert.match(results.refusedFork, /"started":"sky"/);
    assert.match(results.refusedFork, /looked at before it builds/);
    const sky = results.workers.find((w: { id: string }) => w.id === "sky");
    assert.equal(sky?.state, "failed", JSON.stringify(results.workers));
    const ended = JSON.stringify(results.skyWait);
    assert.match(ended, /does not run/, ended);
    assert.match(ended, /from=plaza/);
    assert.match(ended, /renders effectively black/);
    assert.equal(
      seen.workers.filter((request) => request.selfCapture?.facetId === "sky").length,
      0,
      "no session ran on the fork that does not run",
    );
    // A lead's single worker starts on the build that does not run: repairing it is the job.
    assert.equal(results.repair.started, "repair", JSON.stringify(results.repair));
    assert.ok(
      String(results.started.forkedFrom) !== String(results.repair.forkedFrom),
      "from the worker's own build, not the starting point",
    );

    // Every card the lead wrote reaches the chat as a sentence, with the record beside it.
    const cards = customEvents(events, "autopilot_decision").filter((e) => e.runId === runId);
    assert.ok(cards.length >= 2, "the run wrote decision cards");
    for (const card of cards) {
      assert.equal(card.text, card.decision, "the record itself is unchanged");
      assert.equal(typeof card.plain, "string", JSON.stringify(card));
      assert.doesNotMatch(String(card.plain), /\b[0-9a-f]{7,40}\b|run_[a-z0-9]{6,}|refs\//, String(card.plain));
    }
    assert.ok(
      cards.some((c) => String(c.plain) === "this game is empty, so the studio is building the starting point first"),
      cards.map((c) => c.plain).join(" | "),
    );

    // Nothing landed (the director said so), and the starting point outlives the worktree.
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, false);
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    const world = (await api["run.exec"]!({
      command: `git show refs/studio/runs/${runId}/integration:src/world.js`,
      project: project.name,
      timeoutMs: 30_000,
    })) as { stdout: string };
    assert.match(world.stdout, /groups: \['plaza'\]/);
  });

  /**
   * The base session that dies mid-file. Its half-written edits used to stay in the integration
   * worktree while the brief told the director it stood on the empty scaffold — and then
   * `integrate` and `playtest` both refused it for uncommitted work it had never made.
   */
  it("a starting point that could not be built leaves nothing half-written behind it", async () => {
    const asEmptyScaffold = (preview: FakePreview): FakePreview => {
      preview.pixelStatsNext = { width: 800, height: 600, sampled: 480_000, meanLuma: 0, litFraction: 0, canvas: true };
      preview.evaluations.push({ match: "isScene", value: true }, { match: "matrixWorld", value: "[1,0,0,1]" });
      return preview;
    };
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => asEmptyScaffold(makeFakePreview()) },
    );
    rigs.push(rig);
    asEmptyScaffold(rig.preview);
    const project = await rig.core.games.scaffold("director-base-fail", { title: "Base fails" });
    const results: Record<string, any> = {};
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        await call("plan", planFor("plaza"));
        results.started = json(
          await call("worker_start", {
            id: "plaza",
            title: "Plaza",
            brief: "paint the plaza red",
            mode: "single",
            minutes: "5",
            owns: "src/plaza.js",
          }),
        );
        results.finished = text(await call("finish", { summary: "the starting point did not build", land: "no" }));
        return {
          ok: true,
          engine: "codex",
          turns: 3,
          usage: {},
          sessionId: "director-base-fail",
          summary: "carried on",
        };
      }
      if (path.basename(request.cwd) === "integration") {
        // The base builder writes half of the world and its clock runs out.
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "world.js"), "export const world = { groups: [\n");
        return {
          ok: false,
          engine: "codex",
          turns: 1,
          usage: {},
          stopReason: "deadline",
          errorText: "the base session ran out of time",
          summary: "",
        };
      }
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "plaza.js"), "export const plaza = 'red';\n");
      return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "worker-base-fail", summary: "painted it" };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a plaza to skate",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished after a failed base",
    );

    const base = customEvents(events, "autopilot_base").find((e) => e.runId === runId)!;
    assert.equal(base.ok, false, JSON.stringify(base));
    assert.equal(base.commit, null);
    // What the director is told, and what is true of its worktree, are the same thing: the
    // reply carries no "uncommitted edits" note, because there are none.
    assert.equal(results.started.started, "plaza", JSON.stringify(results.started));
    assert.equal(results.started.note, undefined, JSON.stringify(results.started));
    const card = customEvents(events, "autopilot_decision")
      .filter((e) => e.runId === runId)
      .map((e) => String(e.plain));
    assert.ok(
      card.some((line) => /could not be built/.test(line)),
      card.join(" | "),
    );
  });

  /**
   * A game from scratch on a run with room for a team: the studio builds no starting scene, and
   * the lead lays its contract and crude stubs first.
   */
  it("a run from scratch with room for a team builds no starting scene: the lead's first brief hands it the foundation", async () => {
    const asEmptyScaffold = (preview: FakePreview): FakePreview => {
      preview.pixelStatsNext = { width: 800, height: 600, sampled: 480_000, meanLuma: 0, litFraction: 0, canvas: true };
      preview.evaluations.push({ match: "isScene", value: true }, { match: "matrixWorld", value: "[1,0,0,1]" });
      return preview;
    };
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 6, createHeadlessPreview: async () => asEmptyScaffold(makeFakePreview()) },
    );
    rigs.push(rig);
    asEmptyScaffold(rig.preview);
    const project = await rig.core.games.scaffold("director-foundation", { title: "Foundation first" });
    const seen: { director: DelegateRequest[]; others: DelegateRequest[] } = { director: [], others: [] };
    fakeEngine(rig, async (request) => {
      if (!request.director) {
        seen.others.push(request);
        return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "other", summary: "nothing" };
      }
      seen.director.push(request);
      await request.onLiveTool!("finish", { summary: "the foundation is the lead's", land: "no" });
      return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "director-foundation", summary: "done" };
    });
    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a neon street race",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "street race", shots: [] },
      budgets: { wallClockMs: 3 * 60 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished with the foundation left to the lead",
    );
    assert.deepEqual(seen.others, [], "no starting-scene session, nor any other");
    assert.deepEqual(
      customEvents(events, "autopilot_base_started").filter((e) => e.runId === runId),
      [],
      "no starting point is built",
    );
    assert.match(seen.director[0]!.prompt, /THE FOUNDATION IS YOURS/);
    assert.match(seen.director[0]!.prompt, /plan with contract= and vision=/);
    const cards = customEvents(events, "autopilot_decision")
      .filter((e) => e.runId === runId)
      .map((e) => String(e.plain));
    assert.ok(
      cards.some((line) => /the lead lays the foundation first/.test(line)),
      cards.join(" | "),
    );
  });

  /**
   * A game the user brought that never loads the studio contract. Nothing in it can be photographed, checked or compared: `window.__studio` is
   * missing, so every evidence pass reports a build that does not run, the fork gate refuses
   * every builder, and `judge against=start` can only say the other build could not be observed.
   * The run's first step now wires the contract in, inside the run's own worktree, and that
   * commit becomes the "before" every later build is judged against. The folder the user sees is
   * not touched until finish lands the branch.
   */
  it("a game that cannot be judged: the contract is installed first, in the worktree, and that commit is the run's before", async () => {
    /** No window can see a game whose page never installed the contract — live or pooled. */
    const previews: FakePreview[] = [];
    let wired = false;
    const running = {
      version: 1,
      seed: 1,
      frame: 0,
      fps: 60,
      phase: "playing",
      entities: {},
      player: { x: 0, y: 0, z: 0, yaw: 0 },
    };
    const watch = (preview: FakePreview): FakePreview => {
      preview.next = wired ? { ...running } : { __missing: true };
      previews.push(preview);
      return preview;
    };
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => watch(makeFakePreview()) },
    );
    rigs.push(rig);
    watch(rig.preview);
    const contractNowLoads = (): void => {
      wired = true;
      for (const preview of previews) preview.next = { ...running };
    };

    // Somebody's own Vite game: its own entry, its own build, and no call to installStudio.
    const dir = path.join(await tmpDir("studio-unjudgeable-"), "wreckage");
    const build = "mkdir -p dist && cp index.html dist/index.html";
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(
      path.join(dir, "index.html"),
      '<!doctype html><title>WRECKAGE</title><script type="module" src="/src/main.ts"></script>\n',
    );
    await writeFile(path.join(dir, "src", "main.ts"), "const scene = {};\nexport { scene };\n");
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "wreckage", type: "module", scripts: { build } }),
    );
    await writeFile(
      path.join(dir, "studio.json"),
      JSON.stringify({
        name: "wreckage",
        title: "Wreckage",
        createdAt: "",
        contractVersion: 1,
        entry: "dist/index.html",
        main: "src/main.ts",
        build,
        serve: "dist",
        own: true,
        kind: "three-vite",
      }),
    );
    const project = await rig.core.adoptProject(dir);
    assert.equal(project.built, true, "the folder is somebody's own game");
    assert.equal(
      (await rig.core.games.validate(project.name)).contract,
      "missing",
      "and its page never loads the contract",
    );

    const seen: { director: DelegateRequest[]; contract: DelegateRequest[]; workers: DelegateRequest[] } = {
      director: [],
      contract: [],
      workers: [],
    };
    const judgeCalls: string[][] = [];
    const results: Record<string, any> = {};
    fakeEngine(
      rig,
      async (request) => {
        if (request.director) {
          seen.director.push(request);
          const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
          // What the branch stands on the moment the session opens, and what the user's own
          // folder still holds while it does.
          results.status = json(await call("run_status", {}));
          // Flipped (one session): the branch is the worktree the lead leads, not the folder it sits in.
          const worktree = request.director.root;
          results.subject = await git(worktree, ["log", "-1", "--format=%s"]);
          results.sinceStart = await git(worktree, ["rev-list", "--count", `${results.status.integration.base}..HEAD`]);
          results.wiredAtHead = await git(worktree, ["show", "HEAD:src/main.ts"]);
          results.liveDuringTheLoopRun = await readFile(path.join(project.dir, "src", "main.ts"), "utf8");
          await call("plan", planFor("crumple"));
          results.started = json(
            await call("worker_start", {
              id: "crumple",
              title: "Crash damage",
              brief: "make the crashes crumple",
              mode: "single",
              minutes: "5",
              owns: "src/crumple.ts",
            }),
          );
          // M4.6 — the two refusals a game the user brought earns while a worker is running:
          // a second owner of an entry with no wiring block for them to meet in, and a worker
          // with no seam, which in somebody's own repository means nearly every file in it.
          results.refusedSecondOwner = text(
            await call("worker_start", {
              id: "sky",
              title: "Sky",
              brief: "a sky",
              mode: "single",
              minutes: "5",
              owns: "src/sky.ts",
              owns_main: "yes",
            }),
          );
          results.refusedNoSeam = text(
            await call("worker_start", {
              id: "loose",
              title: "Loose",
              brief: "anything",
              mode: "single",
              minutes: "5",
            }),
          );
          for (let i = 0; i < 30; i++) {
            results.waited = json(await call("wait", { seconds: "5", worker: "crumple" }));
            if (results.waited.status.workers[0]?.state !== "running") break;
          }
          results.integrated = json(await call("integrate", { worker: "crumple" }));
          results.judged = json(await call("judge", { target: "integration", against: "start" }));
          results.finished = text(
            await call("finish", { summary: "the crashes crumple now", land: "yes", victory: "no" }),
          );
          return {
            ok: true,
            engine: "codex",
            turns: 11,
            usage: {},
            sessionId: "director-wreck",
            summary: "wired, built, landed",
          };
        }
        if (request.selfCapture?.facetId === "contract") {
          seen.contract.push(request);
          await writeFile(
            path.join(request.cwd, "src", "main.ts"),
            'import { installStudio } from "./studio.js";\nconst scene = {};\ninstallStudio({ scene, renderer: {}, camera: {}, player: () => ({ x: 0, y: 0, z: 0, yaw: 0 }) });\nexport { scene };\n',
          );
          contractNowLoads();
          return {
            ok: true,
            engine: "codex",
            turns: 4,
            usage: {},
            sessionId: "contract-1",
            summary: "installStudio is called from src/main.ts",
          };
        }
        seen.workers.push(request);
        await writeFile(path.join(request.cwd, "src", "crumple.ts"), "export const crumple = true;\n");
        return {
          ok: true,
          engine: "codex",
          turns: 3,
          usage: {},
          sessionId: "worker-wreck",
          summary: "the panels crumple",
        };
      },
      // The judge: it never sees a label, only the pixels of two builds.
      async (request) => {
        judgeCalls.push((request.messages[0]?.images ?? []).map((image) => image.label ?? ""));
        return {
          engine: "codex",
          model: "fixture",
          stopReason: "stop",
          usage: {},
          message: {
            role: "assistant" as const,
            content: JSON.stringify({
              facets: { works: "A", visuals: "A", feel: "A", play: "A" },
              defects: ["the wing mirror floats"],
              reason: "one build shows more of the street",
            }),
          },
        };
      },
    );

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "make the crashes hurt",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "Burnout", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      180_000,
      "director run_finished on an unjudgeable game",
    );

    // One session, on the wiring task alone, in the run's own worktree.
    assert.equal(seen.contract.length, 1, `one contract session, got ${seen.contract.length}`);
    // Flipped (one session): the lead sits in the game folder; the worktree is its grant's root.
    assert.equal(
      seen.contract[0]!.cwd,
      seen.director[0]!.director!.root,
      "in the integration worktree, never the live folder",
    );
    assert.match(seen.contract[0]!.prompt, /making the game "wreckage" judgeable/);
    // The ask is two lines now (M4.2b/M4.6): the studio's own code is already on the page and
    // finds the scene, the camera and the frames; the renderer and the player are what it cannot guess.
    assert.match(seen.contract[0]!.prompt, /Add the two lines to src\/main\.ts \(or a module it imports\)/);
    assert.match(seen.contract[0]!.prompt, /installStudio\(\{ renderer, player \}\)/);
    assert.match(seen.contract[0]!.prompt, /Change nothing else/);

    // Its commit is the run's first, and it is the wiring.
    assert.equal(results.subject, "studio: install contract", `the branch's first commit: ${results.subject}`);
    assert.equal(Number(results.sinceStart), 1, "one commit beyond the game the user brought, and it is that one");
    assert.match(results.wiredAtHead, /installStudio\(/, "the commit carries the wiring");
    assert.match(results.status.integration.head, /^[0-9a-f]{10}$/);
    assert.notEqual(
      results.status.integration.head,
      results.status.integration.base,
      "the branch has moved past what the user had",
    );

    // The director is told what happened, and no longer that its start could not be observed.
    assert.match(seen.director[0]!.prompt, /THE GAME IS JUDGEABLE NOW: it arrived without the studio contract/);
    assert.ok(
      seen.director[0]!.prompt.includes(results.status.integration.head),
      "the brief names the commit it stands on",
    );
    assert.doesNotMatch(seen.director[0]!.prompt, /THE START COULD NOT BE OBSERVED/);
    // (The playbook mentions the fallback by name; only the brief's own block is a heading.)
    assert.doesNotMatch(seen.director[0]!.prompt, /CONTRACT NOT INSTALLED — DO THIS FIRST/);

    // The builder forks from it — the gate that used to refuse every fork on this game.
    assert.equal(results.started.started, "crumple", JSON.stringify(results.started));
    assert.ok(
      results.status.integration.head.startsWith(String(results.started.forkedFrom).slice(0, 10)) ||
        String(results.started.forkedFrom).startsWith(results.status.integration.head),
      `${results.started.forkedFrom} is the contract commit`,
    );
    assert.equal(seen.workers.length, 1, "the builder session ran");
    // M4.6 — a single-session worker carries the seam the director typed all the way to the
    // engine, where the hook (Claude) and the locks (Codex) read it. It used to carry nothing.
    assert.deepEqual(seen.workers[0]!.ownership?.owns, ["src/crumple.ts"], JSON.stringify(seen.workers[0]!.ownership));
    assert.equal(seen.workers[0]!.ownership?.ownsMain, true);
    // …and the two refusals a game of its own earns while somebody is already building in it.
    assert.match(results.refusedSecondOwner, /already owns src\/main\.ts/, results.refusedSecondOwner);
    assert.match(results.refusedSecondOwner, /no FACET WIRING block/, results.refusedSecondOwner);
    assert.match(results.refusedNoSeam, /needs a seam/, results.refusedNoSeam);
    assert.equal(results.integrated.merged, true, JSON.stringify(results.integrated));

    // And `judge against=start` compares two builds that were both looked at.
    assert.equal(results.judged.ok, true, JSON.stringify(results.judged.problems));
    assert.equal(results.judged.verdict.against, "start", JSON.stringify(results.judged.verdict));
    assert.equal(results.judged.verdict.error, undefined, JSON.stringify(results.judged.verdict));
    assert.equal(results.judged.verdict.note, undefined, "there is a before, so nothing excuses the comparison");
    assert.ok(
      ["challenger", "incumbent"].includes(String(results.judged.verdict.pick)),
      JSON.stringify(results.judged.verdict),
    );
    assert.deepEqual(results.judged.verdict.defects, ["the wing mirror floats"], "the judge answered on what it saw");
    const compared = judgeCalls.find(
      (labels) => labels.some((l) => l.startsWith("BUILD A")) && labels.some((l) => l.startsWith("BUILD B")),
    );
    assert.ok(compared, `the judge was shown both builds: ${JSON.stringify(judgeCalls)}`);

    // The live folder was untouched for the whole run, and holds the wiring only after finish landed it.
    assert.doesNotMatch(results.liveDuringTheLoopRun, /installStudio/, "the user's own folder is not edited mid-run");
    assert.match(
      await readFile(path.join(project.dir, "src", "main.ts"), "utf8"),
      /installStudio\(/,
      "the landed build brought it",
    );
    assert.equal(await readFile(path.join(project.dir, "src", "crumple.ts"), "utf8"), "export const crumple = true;\n");
    assert.equal((await rig.core.games.validate(project.name)).contract, "loaded", "the game is judgeable from now on");
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, true, JSON.stringify(finished.stoppedBecause));

    // And the user was told, in words that name no contract and no commit.
    const cards = customEvents(events, "autopilot_decision")
      .filter((e) => e.runId === runId)
      .map((e) => String(e.plain));
    assert.ok(
      cards.some((line) => /your game doesn't have the studio's connection yet/i.test(line)),
      cards.join(" | "),
    );
    assert.ok(
      cards.some((line) => /your game is connected to the studio now/i.test(line)),
      cards.join(" | "),
    );
  });

  /**
   * The other half of the same step: a session that says it wired the contract in but left a
   * page that still cannot be looked at. The proof is the game answering, never the session's
   * word — so nothing is committed, nothing half-written is left for a builder to fork from,
   * and the director is told, in the brief, that this is its own first job.
   */
  it("a contract session whose page still does not answer commits nothing, and the lead is told to wire it itself", async () => {
    const blind = (preview: FakePreview): FakePreview => {
      preview.next = { __missing: true };
      return preview;
    };
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => blind(makeFakePreview()) },
    );
    rigs.push(rig);
    blind(rig.preview);
    const dir = path.join(await tmpDir("studio-unwired-"), "wreckage");
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(
      path.join(dir, "index.html"),
      '<!doctype html><title>WRECKAGE</title><script type="module" src="/src/main.js"></script>\n',
    );
    await writeFile(path.join(dir, "src", "main.js"), "const scene = {};\nexport { scene };\n");
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "wreckage", type: "module" }));
    await writeFile(
      path.join(dir, "studio.json"),
      JSON.stringify({
        name: "wreckage",
        title: "Wreckage",
        createdAt: "",
        contractVersion: 1,
        entry: "index.html",
        main: "src/main.js",
        build: null,
        serve: ".",
        own: true,
        kind: "three-modules",
      }),
    );
    const project = await rig.core.adoptProject(dir);
    const seen: { director: DelegateRequest[] } = { director: [] };
    const results: Record<string, any> = {};
    fakeEngine(rig, async (request) => {
      if (request.director) {
        seen.director.push(request);
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        // Flipped (one session): the worktree is the build the lead leads, not the folder it sits in.
        results.dirty = await git(request.director.root, ["status", "--porcelain"]);
        await call("plan", planFor("crumple"));
        // Flipped (one session): a loop worker is refused; a single one is how a lead has it wired.
        results.refused = text(
          await call("worker_start", {
            id: "crumple",
            title: "Crash damage",
            brief: "make the crashes crumple",
            mode: "loop",
            minutes: "5",
          }),
        );
        results.finished = text(await call("finish", { summary: "the game still cannot be judged", land: "no" }));
        return {
          ok: true,
          engine: "codex",
          turns: 4,
          usage: {},
          sessionId: "director-unwired",
          summary: "nothing to land",
        };
      }
      // It writes a note to itself and calls the job done; the page never installs anything.
      await writeFile(path.join(request.cwd, "NOTES.wiring.md"), "# wiring\nlooked at it\n");
      return {
        ok: true,
        engine: "codex",
        turns: 2,
        usage: {},
        sessionId: "contract-blind",
        summary: "wired it (it says)",
      };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "make the crashes hurt",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "Burnout", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      240_000,
      "director run_finished after an unwired contract",
    );

    assert.equal(
      results.dirty,
      "",
      `nothing half-written is left in the worktree; terminal=${JSON.stringify(customEvents(events, "run_finished").find((e) => e.runId === runId))}`,
    );
    assert.match(seen.director[0]!.prompt, /CONTRACT NOT INSTALLED — DO THIS FIRST/);
    // Flipped (the lead builds with its own hands): it adds the two lines itself, in the
    // integration worktree it leads, and commits them.
    assert.match(
      seen.director[0]!.prompt,
      /wire it yourself in the integration worktree — `import \{ installStudio \} from "\.\/studio\.js"`/,
      "and exactly what to do",
    );
    assert.match(seen.director[0]!.prompt, /installStudio\(\{ renderer, player \}\)/, "which is the whole ask");
    assert.match(
      results.refused,
      /does not run/,
      `a fork from a page nobody can see is still refused: ${results.refused}`,
    );
    assert.equal(customEvents(events, "run_finished").find((e) => e.runId === runId)!.landed, false);
    const cards = customEvents(events, "autopilot_decision")
      .filter((e) => e.runId === runId)
      .map((e) => String(e.plain));
    assert.ok(
      cards.some((line) => /the studio could not add its connection to your game/i.test(line)),
      cards.join(" | "),
    );
  });

  it("a worker the director stops keeps its work: no evidence pass, no verdict, no strike, and the round says who stopped it", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 3, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-stop", { title: "Director stop" });
    const results: Record<string, any> = {};
    const building: Record<string, boolean> = {};
    const grants: Record<string, DelegateRequest["worker"]> = {};
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        // Flipped (module contract): sky is a single session, so the plan has one looping part.
        await call("plan", planWithSingle(["sky"], "plaza", "sky"));
        results.started = json(
          await call("worker_start", {
            id: "plaza",
            title: "Plaza",
            brief: "paint the plaza red",
            minutes: "10",
            owns: "src/plaza.js",
            done: JSON.stringify([
              {
                what: "the plaza is lit",
                check: { id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.2" },
              },
            ]),
          }),
        );
        // Wait until the builder is actually mid-edit — a stop before the build turn would
        // prove nothing about the round it was in.
        for (let i = 0; i < 60 && !building.plaza; i++) await call("wait", { seconds: "1", worker: "plaza" });
        results.building = building.plaza === true;
        results.stopped = text(await call("worker_stop", { id: "plaza", why: "fixing the starting point" }));
        for (let i = 0; i < 30; i++) {
          results.waited = json(await call("wait", { seconds: "5", worker: "plaza" }));
          if (results.waited.status.workers[0]?.state !== "running") break;
        }
        results.wstatus = json(await call("worker_status", { id: "plaza" }));
        // What the builder had written, read from the worktree before the run tears it down.
        results.onDisk = await readFile(path.join(results.started.worktree, "src", "plaza.js"), "utf8").catch((err) =>
          String(err),
        );
        // A single session stopped the same way: it obeyed, so its record says so too.
        results.startedSky = json(
          await call("worker_start", {
            id: "sky",
            title: "Sky",
            brief: "a dusk sky",
            mode: "single",
            minutes: "10",
            owns: "src/sky.js",
          }),
        );
        for (let i = 0; i < 60 && !building.sky; i++) await call("wait", { seconds: "1", worker: "sky" });
        await call("worker_stop", { id: "sky", why: "the plaza comes first" });
        for (let i = 0; i < 30; i++) {
          const waited = json(await call("wait", { seconds: "5", worker: "sky" }));
          if (waited.status.workers.find((w: { id: string }) => w.id === "sky")?.state !== "running") break;
        }
        results.skystatus = json(await call("worker_status", { id: "sky" }));
        results.finished = text(
          await call("finish", { summary: "the plaza needs a starting point first", land: "no" }),
        );
        return {
          ok: true,
          engine: "codex",
          turns: 6,
          usage: {},
          sessionId: "director-stop",
          summary: "stopped the plaza",
        };
      }
      // The worker's build turn: half an edit, then the abort the director sends.
      assert.ok(request.signal, "a delegated build carries the abort signal the director stops it with");
      const who = path.basename(request.cwd);
      grants[who] = request.worker;
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", `${who}.js`), `export const ${who} = 'half-painted';\n`);
      building[who] = true;
      await new Promise<void>((resolve) => {
        if (request.signal!.aborted) return resolve();
        request.signal!.addEventListener("abort", () => resolve(), { once: true });
      });
      // Exactly what claude-code reports for an aborted turn: not ok, but not an error either.
      return {
        ok: false,
        engine: "codex",
        turns: 2,
        usage: {},
        stopReason: "stopped",
        errorText: "stopped by you",
        sessionId: "worker-stopped",
        summary: "half the plaza",
      };
    });

    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    const inGame = async (command: string): Promise<string> =>
      (
        (await api["run.exec"]!({ command, project: project.name, timeoutMs: 30_000 })) as { stdout: string }
      ).stdout.trim();
    // What the user's repository looks like the evening before, to compare with the morning.
    const before = {
      branches: await inGame("git branch --format='%(refname:short)'"),
      tags: await inGame("git tag --list"),
    };

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a red plaza",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished after a stopped worker",
    );

    assert.equal(results.started.started, "plaza", JSON.stringify(results.started));
    assert.equal(results.building, true, "the builder was mid-edit when the director stopped it");
    // A loop builder's build turn is a worker of the run, seated by the host in the chat's mode.
    assert.deepEqual(
      [grants.plaza?.id, grants.plaza?.title],
      ["plaza", "Plaza"],
      "the facet loop's builder carries the run's worker grant",
    );

    // The round: recorded as stopped, with no winner, no board and no shots — nobody looked.
    const rounds = customEvents(events, "facet_iteration").filter((e) => e.runId === runId);
    assert.equal(rounds.length, 1, JSON.stringify(rounds));
    assert.equal(rounds[0]!.verdictSource, "stopped", JSON.stringify(rounds[0]));
    assert.equal(rounds[0]!.winner, null, "a round nobody judged has no winner");
    assert.equal(rounds[0]!.scoreboard, null);
    assert.deepEqual(rounds[0]!.shots, []);
    assert.match(String(rounds[0]!.reason), /stopped by the director: fixing the starting point/);
    assert.equal(rounds[0]!.attemptBranch, `refs/studio/runs/${runId}/attempts/plaza/1-stopped`);
    const stops = customEvents(events, "facet_stopped").filter((e) => e.runId === runId);
    assert.equal(stops.length, 1, JSON.stringify(stops));
    assert.equal(stops[0]!.by, "director");

    // Zero evidence passes for that iteration: the frames of a facet's look land under
    // runs/<run>/facet_<id>/iter_<n>/, and there are none.
    await assert.rejects(
      stat(path.join(rig.core.layout.runs, runId, "facet_plaza", "iter_001")),
      "the stopped round cost no evidence pass",
    );

    // No strike, no rollback, no blame: the loop ended on the stop itself.
    assert.equal(results.wstatus.state, "stopped");
    assert.match(
      results.wstatus.stoppedBecause,
      /^stopped by the director: fixing the starting point/,
      results.wstatus.stoppedBecause,
    );
    assert.match(results.wstatus.stoppedBecause, new RegExp(`refs/studio/runs/${runId}/attempts/plaza/1-stopped`));
    assert.doesNotMatch(results.wstatus.stoppedBecause, /unjudgeable|at the user/);
    assert.equal(results.wstatus.accepted, 0);
    assert.equal(results.wstatus.stoppedRounds, 1, JSON.stringify(results.wstatus));
    const decisions = customEvents(events, "autopilot_decision")
      .filter((e) => e.runId === runId)
      .map((e) => String(e.decision));
    assert.ok(
      decisions.some((d) => /director stopped worker plaza: fixing the starting point/.test(d)),
      decisions.join(" | "),
    );
    assert.ok(!decisions.some((d) => /unjudgeable builds/.test(d)), "no circuit-breaker strike for a stop");

    // The edits are where the director was told they are: still in the worktree, and on a ref.
    assert.equal(results.onDisk, "export const plaza = 'half-painted';\n", results.onDisk);
    assert.match(results.stopped, new RegExp(`refs/studio/runs/${runId}/attempts/plaza/1-stopped`), results.stopped);
    assert.match(results.stopped, /nothing is reset/);
    assert.match(
      await inGame(`git show refs/studio/runs/${runId}/attempts/plaza/1-stopped:src/plaza.js`),
      /half-painted/,
    );

    // …and the morning after, the game's repository looks exactly as the user left it: the
    // run's bookkeeping is all on refs of the studio's own. A first real run left eleven
    // `attempt/*` branches and a `snap/*` tag in somebody's game (M2.7).
    assert.equal(await inGame("git branch --format='%(refname:short)'"), before.branches, "the run added a branch");
    assert.equal(await inGame("git tag --list"), before.tags, "the run added a tag `git push --tags` would ship");
    assert.equal(before.branches, "main");
    assert.equal(before.tags, "");
    const studioRefs = (await inGame("git for-each-ref --format='%(refname)' refs/studio/"))
      .split("\n")
      .filter(Boolean);
    assert.ok(studioRefs.includes(`refs/studio/runs/${runId}/attempts/plaza/1-stopped`), studioRefs.join(" | "));
    assert.ok(
      studioRefs.some((ref) => ref.startsWith("refs/studio/snap/")),
      `the run's own starting-point snapshot: ${studioRefs.join(" | ")}`,
    );
    // One committer, not the five a run used to leave in `git log`.
    const committers = new Set((await inGame("git log --format='%an|%cn'")).split("\n").filter(Boolean));
    assert.deepEqual([...committers], ["AI Game Studio|AI Game Studio"], [...committers].join(" | "));

    // A single session the director stops says the same thing: the engine's "stopped by you"
    // is the engine's word for an abort, not a report about the owner.
    assert.equal(results.skystatus.state, "stopped");
    assert.equal(
      results.skystatus.stoppedBecause,
      "stopped by the director: the plaza comes first",
      JSON.stringify(results.skystatus),
    );

    const workerEvents = customEvents(events, "director_worker").filter(
      (e) => e.runId === runId && e.workerId === "plaza",
    );
    assert.equal(workerEvents.at(-1)!.state, "stopped");
    assert.match(String(workerEvents.at(-1)!.stoppedBecause), /stopped by the director/);
  });

  /**
   * Steering that arrives in a minute (M3.4). A build turn is one long delegation, so a steer
   * used to wait for the next round boundary — fifteen to twenty-three minutes on the first real
   * run, and for one worker it never arrived at all. Worse, a steer the user addressed to a
   * worker was filtered out of the director's own drain and delivered to nobody. Now the turn is
   * interrupted and the same session — everything it has read still in it — carries on with the
   * instruction in front of everything, and an addressed steer takes that path without the
   * director's hop.
   */
  it("a steer that cannot wait interrupts the build turn, and the user's own steer reaches the worker it names", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 3, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-steer", { title: "Director steer" });
    const results: Record<string, any> = {};
    const SESSION = "plaza-session";
    const turns: Array<{ at: number; prompt: string; resume: string | null }> = [];
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        await call("plan", planFor("plaza"));
        results.started = json(
          await call("worker_start", {
            id: "plaza",
            title: "Plaza",
            brief: "paint the plaza",
            minutes: "8",
            owns: "src/plaza.js",
            owns_main: "no",
            done: JSON.stringify([
              {
                what: "the plaza is lit",
                check: { id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.2" },
              },
            ]),
            // Flipped (Loop phase 4): a judge that was not satisfied kept the worker past its first
            // round, where the queued steer lands; its ladder does now.
            milestones: JSON.stringify([{ what: "benches ring the square" }, { what: "trees shade the benches" }]),
          }),
        );
        for (let i = 0; i < 60 && turns.length < 1; i++) await call("wait", { seconds: "1", worker: "plaza" });
        // The director sees the grade while the builder is mid-turn. Waiting for the boundary
        // would spend the whole round on the colour it has just been told is wrong.
        results.steerAt = Date.now();
        results.steered = text(
          await call("worker_steer", {
            id: "plaza",
            text: "the plaza is far too orange — take it greener",
            now: "yes",
          }),
        );
        // While it is still building, the user types into the run and names this worker.
        for (let i = 0; i < 120 && turns.length < 3; i++) await call("wait", { seconds: "1", worker: "plaza" });
        results.queued = text(await call("worker_steer", { id: "plaza", text: "and mind the kerbs" }));
        for (let i = 0; i < 60; i++) {
          results.waited = json(await call("wait", { seconds: "5", worker: "plaza" }));
          const line = results.waited.status.workers[0];
          if (line?.state !== "running" || (line?.round ?? 1) > 1) break;
        }
        results.wstatus = json(await call("worker_status", { id: "plaza" }));
        await call("worker_stop", { id: "plaza", why: "one round is enough this run" });
        for (let i = 0; i < 30; i++) {
          const waited = json(await call("wait", { seconds: "5", worker: "plaza" }));
          if (waited.status.workers[0]?.state !== "running") break;
        }
        results.finished = text(await call("finish", { summary: "the plaza is greener than it was", land: "no" }));
        return {
          ok: true,
          engine: "codex",
          turns: 9,
          usage: {},
          sessionId: "director-steer",
          summary: "steered the plaza",
        };
      }
      turns.push({ at: Date.now(), prompt: request.prompt, resume: request.resume ?? null });
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      // The steer the user sent is the one it acts on — in the session it never left.
      if (/THE USER ASKS: .*greener still/.test(request.prompt)) {
        await writeFile(path.join(request.cwd, "src", "plaza.js"), "export const plaza = 'greener still';\n");
        return { ok: true, engine: "codex", turns: 3, usage: {}, sessionId: SESSION, summary: "greener still" };
      }
      await writeFile(path.join(request.cwd, "src", "plaza.js"), "export const plaza = 'orange';\n");
      await new Promise<void>((resolve) => {
        if (request.signal!.aborted) return resolve();
        request.signal!.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        ok: false,
        engine: "codex",
        turns: 2,
        usage: {},
        stopReason: "stopped",
        errorText: "stopped by you",
        sessionId: SESSION,
        summary: "half a plaza",
      };
    });

    const runId = rig.core.newRunId();
    void rig.core
      .dispatchRun({
        runId,
        goal: "a green plaza",
        project: project.name,
        mode: "autopilot",
        engine: "codex",
        reference: { name: "plaza", shots: [] },
        budgets: { wallClockMs: 15 * 60_000 },
      })
      .catch(() => {});
    // The user's own steer, addressed to the worker, typed while it is building.
    await waitForLog(rig.core, () => turns.length >= 2, 120_000, "the director's steer to reach the build session");
    const threadId = (await rig.core.store.listThreads()).find(
      (t) => (t.metadata as { project?: string })?.project === project.name,
    )!.id;
    const userSteerAt = Date.now();
    await rig.core.runFeedback({ threadId, runId, facetId: "plaza", text: "make it greener still" });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      240_000,
      "director run_finished after two steers",
    );

    // The director's steer: the turn was interrupted, and the answer says so rather than
    // promising a boundary the round would never reach.
    assert.match(results.steered, /build turn was interrupted and it is carrying on/, results.steered);
    assert.ok(
      turns.length >= 3,
      `three build turns: the first, the director's steer, the user's — ${JSON.stringify(turns.map((t) => t.resume))}`,
    );
    assert.equal(turns[1]!.resume, SESSION, "the same session, not a fresh one");
    assert.match(turns[1]!.prompt, /A STEER ARRIVED WHILE YOU WERE WORKING/);
    assert.match(turns[1]!.prompt, /far too orange — take it greener/);
    assert.match(turns[1]!.prompt, /Continue where you were/);
    assert.ok(
      turns[1]!.at - results.steerAt < 60_000,
      `the steer reached the session in ${turns[1]!.at - results.steerAt}ms`,
    );

    // The user's steer, addressed to the worker: delivered to it, not to nobody.
    assert.equal(turns[2]!.resume, SESSION);
    assert.match(turns[2]!.prompt, /THE USER ASKS: .*make it greener still/);
    assert.ok(
      turns[2]!.at - userSteerAt < 60_000,
      `the user's steer reached the session in ${turns[2]!.at - userSteerAt}ms`,
    );
    const delivered = customEvents(events, "run_steering_delivered").filter(
      (e) => e.runId === runId && e.facetId === "plaza",
    );
    assert.equal(delivered.length, 1, JSON.stringify(delivered));
    assert.equal(delivered[0]!.stage, "now");
    const handed = customEvents(events, "facet_steered").filter((e) => e.runId === runId);
    assert.deepEqual(
      handed.map((e) => e.delivered),
      ["mid-round", "mid-round"],
    );

    // Neither interruption cost the round: it ran on to a verdict, and what the builder wrote
    // after the last steer is what was judged.
    const rounds = customEvents(events, "facet_iteration").filter((e) => e.runId === runId && e.facetId === "plaza");
    assert.equal(rounds[0]!.iteration, 1);
    assert.notEqual(rounds[0]!.verdictSource, "stopped", JSON.stringify(rounds[0]));
    assert.equal(rounds[0]!.winner, "challenger", String(rounds[0]!.reason));
    const accepted = String((rounds[0]!.verdict as { build: { head?: string } }).build.head ?? "");
    assert.match(accepted, /^[0-9a-f]{7,40}$/, "the round it kept has a commit");
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    const show = (await api["run.exec"]!({
      command: `git show ${accepted}:src/plaza.js`,
      project: project.name,
      timeoutMs: 30_000,
    })) as { stdout: string };
    assert.match(show.stdout, /greener still/, "the accepted build is the one the steers asked for");

    // A steer that can wait still waits: the default is the top of the next round.
    assert.match(results.queued, /queued for plaza's next round/, results.queued);
    assert.equal(
      results.wstatus.iterationMinutes >= 0,
      true,
      `a measured round: ${JSON.stringify(results.wstatus.iterationMinutes)}`,
    );
  });

  /**
   * The other half of the same fix (M3.4): a single session used to be refused a steer outright
   * — "wait for it, or stop it and start another with the instruction in its brief" — because
   * there was no round boundary to queue one against. Interrupt-and-resume needs no boundary, so
   * a single session is steered like anything else, and always now.
   */
  it("a single session interrupted with no steer left to hand it carries on instead of failing", async () => {
    // Two steers in quick succession: the first interrupt's resume already took both, so the
    // second interrupt cuts a turn that has nothing new to hear. That turn used to end the worker.
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-empty-interrupt", { title: "Director empty interrupt" });
    const results: Record<string, any> = {};
    const turns: Array<{ prompt: string; resume: string | null }> = [];
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        await call("plan", planFor("sky"));
        await call("worker_start", {
          id: "sky",
          title: "Sky",
          brief: "a dusk sky",
          mode: "single",
          minutes: "5",
          owns: "src/sky.js",
        });
        for (let i = 0; i < 30; i++) {
          const waited = json(await call("wait", { seconds: "2", worker: "sky" }));
          if (waited.status.workers[0]?.state !== "running") break;
        }
        results.wstatus = json(await call("worker_status", { id: "sky" }));
        await call("finish", { summary: "the sky is done", land: "no" });
        return { ok: true, engine: "codex", turns: 3, usage: {}, sessionId: "director-empty", summary: "done" };
      }
      turns.push({ prompt: request.prompt, resume: request.resume ?? null });
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'blue';\n");
      if (turns.length > 1)
        return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "sky-session", summary: "blue" };
      // The late interrupt: nothing is waiting in the worker's queue when it lands.
      setImmediate(() => void api["engine.interrupt"]!({ cwd: request.cwd }));
      await new Promise<void>((resolve) => {
        if (request.signal!.aborted) return resolve();
        request.signal!.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        ok: false,
        engine: "codex",
        turns: 1,
        usage: {},
        stopReason: "stopped",
        errorText: "stopped by you",
        sessionId: "sky-session",
        summary: "half a sky",
      };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a dusk sky",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "dusk", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      180_000,
      "director run_finished after an empty interrupt",
    );

    assert.equal(turns.length, 2, `the session was resumed: ${JSON.stringify(turns.map((t) => t.resume))}`);
    assert.equal(turns[1]!.resume, "sky-session", "the same session carries on");
    assert.equal(results.wstatus.state, "done", JSON.stringify(results.wstatus));
  });

  it("a single session is steered too: no boundary to wait for, so the steer is handed over at once", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-steer-single", { title: "Director steer single" });
    const results: Record<string, any> = {};
    const turns: Array<{ prompt: string; resume: string | null }> = [];
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        await call("plan", planFor("sky"));
        await call("worker_start", {
          id: "sky",
          title: "Sky",
          brief: "a dusk sky",
          mode: "single",
          minutes: "5",
          owns: "src/sky.js",
        });
        for (let i = 0; i < 60 && turns.length < 1; i++) await call("wait", { seconds: "1", worker: "sky" });
        // No `now`: a single session has no next round, so this is the only delivery there is.
        results.steered = text(
          await call("worker_steer", { id: "sky", text: "the sky is too purple — pull it back to blue" }),
        );
        results.movedToo = text(await call("worker_steer", { id: "sky", move: "the sky has stars" }));
        for (let i = 0; i < 60 && turns.length < 2; i++) await call("wait", { seconds: "1", worker: "sky" });
        for (let i = 0; i < 30; i++) {
          const waited = json(await call("wait", { seconds: "5", worker: "sky" }));
          if (waited.status.workers[0]?.state !== "running") break;
        }
        results.wstatus = json(await call("worker_status", { id: "sky" }));
        results.finished = text(await call("finish", { summary: "the sky came back to blue", land: "no" }));
        return {
          ok: true,
          engine: "codex",
          turns: 5,
          usage: {},
          sessionId: "director-single-steer",
          summary: "steered the sky",
        };
      }
      turns.push({ prompt: request.prompt, resume: request.resume ?? null });
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      if (/back to blue/.test(request.prompt)) {
        await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'blue';\n");
        return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "sky-session", summary: "blue" };
      }
      await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'purple';\n");
      await new Promise<void>((resolve) => {
        if (request.signal!.aborted) return resolve();
        request.signal!.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        ok: false,
        engine: "codex",
        turns: 1,
        usage: {},
        stopReason: "stopped",
        errorText: "stopped by you",
        sessionId: "sky-session",
        summary: "a purple sky",
      };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a dusk sky",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "dusk", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      180_000,
      "director run_finished after steering a single session",
    );

    assert.doesNotMatch(results.steered, /cannot be steered/, results.steered);
    assert.match(results.steered, /sky's build turn was interrupted and it is carrying on/, results.steered);
    assert.equal(
      turns.length,
      2,
      `the session was resumed, not restarted: ${JSON.stringify(turns.map((t) => t.resume))}`,
    );
    assert.equal(turns[1]!.resume, "sky-session");
    assert.match(turns[1]!.prompt, /A STEER ARRIVED WHILE YOU WERE WORKING/);
    assert.match(turns[1]!.prompt, /too purple — pull it back to blue/);
    // A ladder is the loop's, and saying so is not the same as refusing to steer at all.
    assert.match(results.movedToo, /no ladder to add a move to/, results.movedToo);
    assert.equal(results.wstatus.state, "done", JSON.stringify(results.wstatus));
    assert.equal(
      customEvents(events, "facet_steered").filter((e) => e.runId === runId && e.delivered === "mid-session").length,
      1,
    );
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    const show = (await api["run.exec"]!({
      command: `git show ${results.wstatus.lastCommit}:src/sky.js`,
      project: project.name,
      timeoutMs: 30_000,
    })) as { stdout: string };
    assert.match(show.stdout, /blue/, "what it committed is what the steer asked for");
  });

  /**
   * One head. The director edits in its own worktree and commits — and `integrationHead` used
   * to move only on `integrate`, so the judge, the close's health pass and the merge could each
   * be talking about a different build. The first real run committed a grade fix at 17:54,
   * judged it ("grounded daylight? yes"), hit its session limit — and `git fsck` found that
   * commit unreachable in the morning while the report said the judge had passed what landed.
   */
  it("a commit the director makes with its own hands becomes the head that is judged, closed and landed", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-head", { title: "Director head" });
    const results: Record<string, any> = {};
    let sessions = 0;
    fakeEngine(rig, async (request) => {
      if (request.director) {
        // The wrap-up session the harness offers when a director stops without finishing.
        if (++sessions > 1)
          return {
            ok: true,
            engine: "codex",
            turns: 1,
            usage: {},
            sessionId: "director-wrap",
            summary: "nothing left to do",
          };
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        await call("plan", planFor("sign"));
        results.started = json(
          await call("worker_start", {
            id: "sign",
            title: "Sign",
            brief: "hang a sign",
            mode: "single",
            minutes: "5",
            owns: "src/sign.js",
          }),
        );
        for (let i = 0; i < 30; i++) {
          results.waited = json(await call("wait", { seconds: "5", worker: "sign" }));
          if (results.waited.status.workers[0]?.state !== "running") break;
        }
        results.integrated = json(await call("integrate", { worker: "sign" }));
        // What the director does for itself: a fix quicker to make than to delegate, committed.
        await writeFile(path.join(request.cwd, "src", "haze.js"), "export const haze = 0.38;\n");
        await git(request.cwd, ["add", "-A"]);
        await git(request.cwd, [
          "-c",
          "user.name=AI Game Studio",
          "-c",
          "user.email=studio@ai-game-studio.local",
          "commit",
          "-q",
          "-m",
          "director: haze peak 0.62 to 0.38",
        ]);
        results.ownCommit = await git(request.cwd, ["rev-parse", "HEAD"]);
        results.status = json(await call("run_status", {}));
        results.judged = json(await call("judge", { target: "integration", against: "none" }));
        return {
          ok: true,
          engine: "codex",
          turns: 8,
          usage: {},
          sessionId: "director-head",
          summary: "fixed the haze",
        };
      }
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "sign.js"), "export const sign = 'open';\n");
      return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "worker-head", summary: "hung the sign" };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a lit plaza",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
      // Flipped (one session): a director's own commit is the long turn's: a waking lead writes nothing.
      directorLoop: "turn",
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished",
    );

    const head: string = results.ownCommit;
    assert.ok(head && head !== results.integrated.head, "the director's commit is past the last merge");
    assert.equal(
      results.status.integration.head,
      head.slice(0, 10),
      "the next tool call sees what the director committed",
    );
    assert.equal(results.judged.head, head, "the judge names the sha it looked at");

    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, true, String(finished.stoppedBecause));
    assert.equal(finished.integrationHead, head, "the close landed the head it observed, not the last merge");
    // The close's own verdict, filed under the sha it looked at — the join key for both.
    const verdict = JSON.parse(
      await readFile(
        path.join(rig.core.layout.runs, runId, "director", `close_${head.slice(0, 8)}`, "verdict.json"),
        "utf8",
      ),
    );
    assert.equal(verdict.head, head);
    assert.equal(verdict.ok, true);
    // Both files are live: the worker's merge and the director's own commit on top of it.
    assert.equal(await readFile(path.join(project.dir, "src", "haze.js"), "utf8"), "export const haze = 0.38;\n");
    assert.equal(await readFile(path.join(project.dir, "src", "sign.js"), "utf8"), "export const sign = 'open';\n");

    // And the landing claims only what happened: nobody compared this build with anything.
    const landing = finished.landingResult as { ok: boolean; how: string; verified: boolean; line: string };
    assert.equal(landing.ok, true);
    assert.equal(landing.verified, false, "a health pass is not a judge's preference");
    assert.equal(landing.how, "fresh-health-pass");
    assert.equal(landing.line, "made live, not judged better");
    assert.doesNotMatch(String(finished.stoppedBecause), /the judge had passed it/);
    assert.match(String(finished.stoppedBecause), /landed \(fresh-health-pass\)/);
  });

  /**
   * The user's own evening, in the folder the run was going to land in. Landing merged
   * `--no-ff` into their branch and, when that conflicted, ran `git reset --hard` onto the run's
   * head — the studio throwing away commits nobody asked it to touch, in somebody's own
   * repository. Now the conflict is an answer: nothing is forced,
   * the build waits on its ref, and the close says why in words the user reads.
   */
  it("a landing that conflicts with the user's own commits lands nothing and leaves their branch exactly as it was", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-conflict", { title: "Director conflict" });
    const results: Record<string, any> = {};
    let sessions = 0;
    fakeEngine(rig, async (request) => {
      if (request.director) {
        if (++sessions > 1)
          return {
            ok: true,
            engine: "codex",
            turns: 1,
            usage: {},
            sessionId: "director-wrap",
            summary: "nothing left to do",
          };
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        await call("plan", planFor("sign"));
        await call("worker_start", {
          id: "sign",
          title: "Sign",
          brief: "hang a sign",
          mode: "single",
          minutes: "5",
          owns: "src/sign.js",
        });
        for (let i = 0; i < 30; i++) {
          const waited = json(await call("wait", { seconds: "5", worker: "sign" }));
          if (waited.status.workers[0]?.state !== "running") break;
        }
        results.integrated = json(await call("integrate", { worker: "sign" }));
        // The user's evening: they wrote the same file, in their own folder, under their own
        // name, while the run worked in its worktree.
        await writeFile(path.join(project.dir, "src", "sign.js"), "export const sign = 'closed for repairs';\n");
        await git(project.dir, ["add", "-A"]);
        await git(project.dir, [
          "-c",
          "user.name=Simeon",
          "-c",
          "user.email=me@example.com",
          "commit",
          "-q",
          "-m",
          "mine: the sign says closed",
        ]);
        results.userHead = await git(project.dir, ["rev-parse", "HEAD"]);
        results.finished = text(await call("finish", { summary: "the sign is up", land: "yes" }));
        return {
          ok: true,
          engine: "codex",
          turns: 6,
          usage: {},
          sessionId: "director-conflict",
          summary: "hung the sign",
        };
      }
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "sign.js"), "export const sign = 'open';\n");
      return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "worker-conflict", summary: "hung the sign" };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a lit plaza",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished after a conflicting landing",
    );

    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, false, String(finished.stoppedBecause));
    const landing = finished.landingResult as { ok: boolean; how: string; line: string };
    assert.equal(landing.ok, false);
    assert.equal(landing.line, "nothing was made live");
    // The lead is told what happened in git's own terms; the user gets the close verdict's
    // sentence, which never mentions a merge.
    assert.match(
      results.finished,
      /not landed: merge into the live folder conflicted with changes of your own/,
      results.finished,
    );
    const close = (finished.verdicts as Array<{ pass: string; because: string }>).find((v) => v.pass === "close")!;
    assert.equal(
      close.because,
      "Nothing was made live: your game folder had changes of its own, so this build was left beside it.",
    );

    // The user's branch: their commit, their file, no merge in flight, nothing reset.
    assert.equal(await git(project.dir, ["rev-parse", "HEAD"]), results.userHead, "the run moved the user's branch");
    assert.equal(
      await readFile(path.join(project.dir, "src", "sign.js"), "utf8"),
      "export const sign = 'closed for repairs';\n",
    );
    assert.equal(await git(project.dir, ["status", "--porcelain"]), "", "no half-merged tree left behind");
    assert.equal(await git(project.dir, ["log", "-1", "--format=%an"]), "Simeon");

    // And the build is not lost: it is on the run's ref, for "Make it live" to land once the
    // folder is theirs to merge into.
    const onRef = await git(project.dir, ["rev-parse", `refs/studio/runs/${runId}/integration`]);
    assert.equal(onRef, finished.integrationHead, "the integrated build is still reachable");
    assert.match(await git(project.dir, ["show", `${onRef}:src/sign.js`]), /open/);
  });

  /**
   * The run the user quits the app on (or the Mac loses power). The next boot closes the run
   * as PAUSED, with the head it reached and the ref that keeps it reachable, so the chat can
   * offer the build; and the resumed run lands what the first one merged. Before this, the
   * boot repair gated its pause on `mode` — a director's run is registered "autopilot" and
   * started "director" — so the run was closed dead, and a resumed director called its fork
   * point "the starting point", answering `finish land=yes` with "nothing beyond the starting
   * point" while eight merges sat on a ref nobody was shown.
   */
  for (const interruption of ["restart", "stop-queue"] as const)
    it(
      interruption === "restart"
        ? "a run the app died inside pauses with its head, and the resumed run lands what it merged"
        : "Stop interrupts a live director and sends its queued instruction with the same plan and integration head",
      async () => {
        const rig = await startRig(
          { replies: [] },
          { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
        );
        rigs.push(rig);
        const project = await rig.core.games.scaffold("director-resume", { title: "Director resume" });
        const results: Record<string, any> = {};
        const prompts: string[] = [];
        let sessions = 0;
        // Quitting the app takes the whole process: the harness child and the delegation it was
        // waiting on. This rig outlives its harness, so the director's session is released by hand
        // at the same moment the child is killed.
        let quit = () => {};
        const appQuit = new Promise<void>((resolve) => {
          quit = resolve;
        });
        fakeEngine(rig, async (request) => {
          // After the pause the chat's own session answers, in the game folder, with the paused
          // run's resume bridged in: it records the resume, and the studio resumes the run when
          // its reply ends.
          if (!request.director && request.liveTools?.some((tool) => tool.name === "run_status")) {
            results.afterLoopRun = request;
            assert.match(request.prompt, /PAUSED/);
            assert.match(request.prompt, /Keep going and land the saved sign/);
            assert.deepEqual(
              (request.interviewTools ?? []).map((tool) => tool.name),
              // Named flip: a new Loop's start, for one asked in words, sits beside the resume.
              ["start_autopilot", "resume_run"],
            );
            return {
              ok: true,
              engine: "codex",
              turns: 1,
              usage: {},
              sessionId: "chat-after-pause",
              summary: "Continuing the saved plan.",
              studioToolCalls: [{ name: "resume_run", args: { text: "Keep going and land the saved sign" } }],
            };
          }
          if (request.director) {
            prompts.push(request.prompt);
            const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
            if (++sessions === 1) {
              await call("plan", planFor("sign"));
              results.started = json(
                await call("worker_start", {
                  id: "sign",
                  title: "Sign",
                  brief: "hang a sign",
                  mode: "single",
                  minutes: "5",
                  owns: "src/sign.js",
                }),
              );
              for (let i = 0; i < 30; i++) {
                results.waited = json(await call("wait", { seconds: "5", worker: "sign" }));
                if (results.waited.status.workers[0]?.state !== "running") break;
              }
              results.integrated = json(await call("integrate", { worker: "sign" }));
              results.judged = json(await call("judge", { target: "integration", against: "none" }));
              // The real Stop signal releases this session; the restart case kills its harness first.
              if (interruption === "stop-queue") {
                if (request.signal?.aborted) quit();
                else request.signal?.addEventListener("abort", quit, { once: true });
              }
              await appQuit;
              return {
                ok: false,
                engine: "codex",
                turns: 4,
                usage: {},
                stopReason: "stopped",
                errorText: "the app quit",
                summary: "",
              };
            }
            results.status2 = json(await call("run_status", {}));
            results.finished2 = text(await call("finish", { summary: "landing what last run merged", land: "yes" }));
            return {
              ok: true,
              engine: "codex",
              turns: 3,
              usage: {},
              sessionId: "director-resumed",
              summary: "landed the run's work",
            };
          }
          await mkdir(path.join(request.cwd, "src"), { recursive: true });
          await writeFile(path.join(request.cwd, "src", "sign.js"), "export const sign = 'open';\n");
          return {
            ok: true,
            engine: "codex",
            turns: 2,
            usage: {},
            sessionId: "worker-resume",
            summary: "hung the sign",
          };
        });

        const runId = rig.core.newRunId();
        void rig.core
          .dispatchRun({
            runId,
            goal: "a sign",
            project: project.name,
            mode: "autopilot",
            engine: "codex",
            reference: { name: "sign", shots: [] },
            budgets: { wallClockMs: 30 * 60_000 },
          })
          .catch(() => {});
        await waitForLog(rig.core, () => Boolean(results.judged), 120_000, "the first session's merge and judge");
        const head: string = results.integrated.head;
        const threadId = (await rig.core.store.listThreads()).find(
          (t) => (t.metadata as { project?: string })?.project === project.name,
        )!.id;

        if (interruption === "restart") {
          // Cmd+Q at 2am: the harness dies mid-run, the director's session with it.
          await rig.core.host.stop();
          quit();
          await new Promise((resolve) => setTimeout(resolve, 500));
          await rig.core.start();
        } else {
          await rig.core.sendUserMessage("Keep going and land the saved sign", {
            thread: threadId,
            engine: "codex",
            reviewPlan: true,
          });
          assert.equal(sessions, 1, "no second session answers a follow-up while the first director is building");
          const sent = await rig.core.store.listEvents(threadId);
          assert.equal(customEvents(sent, "coordinator_message_queued").length, 1);
          // Live chat: handed to the lead, whose first turn — a fresh session, none to resume yet —
          // cannot be cut short to read it.
          assert.deepEqual(
            customEvents(sent, "coordinator_message_delivered").map((e) => [e.into, e.how]),
            [[runId, "lead"]],
          );
          await rig.core.stopThread(threadId);
        }
        const paused = await waitForLog(
          rig.core,
          (log) => customEvents(log, "autopilot_paused").some((e) => e.runId === runId),
          30_000,
          "autopilot_paused",
        );

        const closure = customEvents(paused, "run_finished").find((e) => e.runId === runId)!;
        if (interruption === "restart") assert.equal(closure.stoppedBecause, "interrupted by restart");
        else assert.match(String(closure.stoppedBecause), /stopped by the user/);
        assert.equal(closure.landed, false, "an interrupted run landed nothing, and says so");
        assert.ok(
          String(closure.integrationHead).startsWith(head),
          `${String(closure.integrationHead)} is the head the run reached (${head})`,
        );
        assert.equal(closure.integrationRef, `refs/studio/runs/${runId}/integration`);
        assert.notEqual(
          closure.integrationHead,
          closure.baseCommit,
          "the Play this build / Make it live card has a build to offer",
        );
        if (interruption === "restart") {
          assert.equal(
            ((await rig.core.store.readArtifact(threadId, `autopilot_${runId}`)) as { phase?: string }).phase,
            "paused",
          );
          // An ordinary message resumes the saved run; no Resume button or fresh plan.
          await rig.core.sendUserMessage("Keep going and land the saved sign", { thread: threadId, engine: "codex" });
        }
        const after = await waitForLog(
          rig.core,
          (log) =>
            Boolean(results.finished2) &&
            customEvents(log, "run_finished").some((e) => e.runId === runId && e.landed === true),
          120_000,
          "the resumed run's closure and finish reply",
        );

        assert.equal(sessions, 2, "one resumed session");
        assert.equal(results.afterLoopRun?.coordinator, undefined, "the chat's own session resumed it, no coordinator");
        assert.notEqual(results.afterLoopRun?.readOnly, true);
        if (interruption === "stop-queue")
          assert.equal(
            customEvents(after, "coordinator_message_requeued").length,
            1,
            "the lead never heard it: Stop gave it back to the chat, which resumed the run with it",
          );
        assert.ok(
          customEvents(after, "run_steering").some(
            (e) => e.runId === runId && e.text === "Keep going and land the saved sign",
          ),
          "new guidance is saved before resumed builders start",
        );
        assert.match(prompts[1]!, /YOU WERE RESUMED/);
        assert.match(
          prompts[1]!,
          /THE USER SAYS[^\n]*\n- Keep going and land the saved sign/,
          "the resumed lead is told the instruction the chat resumed it with",
        );
        assert.match(
          prompts[1]!,
          /2 commits beyond the starting point/,
          "the resumed brief counts what is there to land (the worker's commit and its merge)",
        );
        assert.notEqual(
          results.status2.integration.head,
          results.status2.integration.base,
          "the resumed run knows the branch is ahead of the base",
        );
        assert.match(
          results.finished2,
          /the run is closed — the integrated build [0-9a-f]{10} is live/,
          results.finished2,
        );

        const landed = customEvents(after, "run_finished")
          .filter((e) => e.runId === runId)
          .at(-1)!;
        assert.equal(landed.landed, true, String(landed.stoppedBecause));
        assert.ok(String(landed.integrationHead).startsWith(head), "it landed the head the first session left");
        assert.notEqual(
          landed.integrationHead,
          landed.baseCommit,
          "the base is the run's own starting point, not last session's fork point",
        );
        assert.equal(
          await readFile(path.join(project.dir, "src", "sign.js"), "utf8"),
          "export const sign = 'open';\n",
          "the first session's merge is live",
        );
        const landing = landed.landingResult as { verified: boolean; how: string; line: string };
        assert.equal(landing.verified, false, "nobody preferred it to anything — the morning says so");
        assert.equal(landing.line, "made live, not judged better");
        // The close looks for itself before it lands (M4.10) — `finish land=yes` used to land
        // whatever HEAD was — so the fresh pass is what this landing rests on. Last run's judge
        // survived the crash all the same: it is on the resumed session's run_status, where it is
        // the other half of the landing rule for a build the close could not photograph.
        assert.equal(landing.how, "fresh-health-pass", "the close took its own look at the head it landed");
        assert.ok(results.status2.integration.lastJudge, "last run's judge survived the crash in the journal");
        assert.ok(
          String(head).startsWith(String(results.status2.integration.lastJudge.head)),
          `${JSON.stringify(results.status2.integration.lastJudge)} is about the head the first session left (${head})`,
        );
      },
    );

  /**
   * A start nobody could photograph. The run began on a game that draws a black frame (not an
   * empty scaffold, which is allowed to be blank): there is no "before" to compare with. The
   * director used to be told nothing and answered `judge against=start` with "the other build
   * could not be observed", once per judge call it wasted.
   */
  it("a start nobody could photograph is said once: the brief warns, and judge against=start answers instead of failing", async () => {
    // The game folder itself — the run's "before" — draws nothing at all, in whichever window
    // it is photographed (the harness's own stand-in, not the user's Live); a build of the run
    // in a worktree draws as usual.
    const blindAtStart = (preview: FakePreview): FakePreview => {
      const lit = preview.pixelStatsNext;
      const black = { ...lit, meanLuma: 0, litFraction: 0 };
      Object.defineProperty(preview, "pixelStatsNext", {
        get: () => (preview.loadRoot === null ? black : lit),
        set: () => {},
      });
      return preview;
    };
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => blindAtStart(makeFakePreview()) },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-blind", { title: "Director blind" });
    const results: Record<string, any> = {};
    const prompts: string[] = [];
    fakeEngine(rig, async (request) => {
      if (request.director) {
        prompts.push(request.prompt);
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        results.judged = json(await call("judge", { target: "integration", against: "start" }));
        results.finished = text(await call("finish", { summary: "there is nothing to compare this with", land: "no" }));
        return { ok: true, engine: "codex", turns: 3, usage: {}, sessionId: "director-blind", summary: "looked" };
      }
      return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "none", summary: "" };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "make it visible",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "dusk", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished",
    );

    assert.match(prompts[0]!, /THE START COULD NOT BE OBSERVED/, "the brief says so before the first call is spent");
    assert.equal(results.judged.ok, true, JSON.stringify(results.judged.problems));
    assert.equal(results.judged.verdict.pick, null);
    assert.match(String(results.judged.verdict.note), /no start evidence: the starting build rendered black/);
    assert.doesNotMatch(
      JSON.stringify(results.judged.verdict),
      /could not be observed/,
      "a sentence the director can act on, not a failure",
    );

    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, false);
    assert.equal((finished.landingResult as { how: string; line: string }).how, "not-landed");
    assert.equal((finished.landingResult as { line: string }).line, "nothing was made live");
  });

  /**
   * The blind build turn. `wait` wakes on notes, and between "worker started" and "iteration 1"
   * nothing wrote one: a director asking for news was told "nothing yet" while every worker was
   * editing files it did not own, and found out only afterwards. Now the studio looks into each running worker's worktree
   * itself, with the reviewer it already has, and says what changed.
   */
  it("looks into a running worker's worktree: an edit outside its own files wakes the director's wait, once", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 3, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-monitor", { title: "Director monitor" });
    const results: Record<string, any> = {};
    const monitorCommands: unknown[] = [];
    const sandboxRun = rig.core.sandbox.run.bind(rig.core.sandbox);
    rig.core.sandbox.run = async (request) => {
      try {
        const result = await sandboxRun(request);
        if (request.label?.includes(":monitor:"))
          monitorCommands.push({
            command: request.command,
            code: result.code,
            stdout: result.stdout.slice(0, 2000),
            stderr: result.stderr.slice(0, 2000),
          });
        return result;
      } catch (error) {
        if (request.label?.includes(":monitor:"))
          monitorCommands.push({ command: request.command, error: String(error) });
        throw error;
      }
    };
    let building = false;
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        await call("plan", planFor("plaza"));
        results.started = json(
          await call("worker_start", {
            id: "plaza",
            title: "Plaza",
            brief: "paint the plaza red",
            minutes: "4",
            owns: "src/plaza.js",
            owns_main: "no",
            done: JSON.stringify([
              {
                what: "the plaza is lit",
                check: { id: "lit", kind: "pixel", camera: "default", expr: "litFraction > 0.2" },
              },
            ]),
          }),
        );
        // The director's own loop: wait, and read what happened. Nothing else wakes it here —
        // the builder never finishes its turn, so there is no iteration and no judge.
        const violation = /outside this facet's ownership \(src\/sky\.js\)/;
        for (let i = 0; i < 10; i++) {
          results.waited = json(await call("wait", { seconds: "15", worker: "plaza" }));
          if ((results.waited.happened as string[]).some((h) => violation.test(h))) break;
        }
        results.status = json(await call("run_status", {}));
        // The same violation is not news twice: two more looks pass in silence.
        results.again = json(await call("wait", { seconds: "40", worker: "plaza" }));
        results.stopped = text(await call("worker_stop", { id: "plaza", why: "it is editing the sky" }));
        for (let i = 0; i < 30; i++) {
          const waited = json(await call("wait", { seconds: "5", worker: "plaza" }));
          if (waited.status.workers[0]?.state !== "running") break;
        }
        results.finished = text(await call("finish", { summary: "the plaza went wandering", land: "no" }));
        return {
          ok: true,
          engine: "codex",
          turns: 8,
          usage: {},
          sessionId: "director-monitor",
          summary: "watched the plaza",
        };
      }
      // The builder: its own module, and one that belongs to nobody here. Then it works on,
      // as a real forty-minute turn does, until the director pulls it off.
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "plaza.js"), "export const plaza = 'red';\n");
      await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'dusk';\n");
      building = true;
      await new Promise<void>((resolve) => {
        if (request.signal!.aborted) return resolve();
        request.signal!.addEventListener("abort", () => resolve(), { once: true });
      });
      return {
        ok: false,
        engine: "codex",
        turns: 2,
        usage: {},
        stopReason: "stopped",
        errorText: "stopped by you",
        sessionId: "worker-monitor",
        summary: "half a plaza",
      };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a red plaza",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      180_000,
      "director run_finished after the monitor spoke",
    ).catch(async (error: Error) => {
      const log = await rig.core.listAllEvents();
      const lifecycle = log
        .filter((e) => e.data.type === "custom" && /error|finished|stopped|failed/.test(e.data.event_type))
        .slice(-12)
        .map((e) => e.data);
      error.message += `\nMonitor diagnostics: ${JSON.stringify({ building, results, monitorCommands, lifecycle })}`;
      throw error;
    });

    assert.equal(building, true, "the builder was mid-turn the whole time");
    // The note: which worker, how long it has been in this round, and what the reviewer saw.
    const spoke = (results.waited.happened as string[]).filter((h) => /^worker plaza: \d+ min into round 1/.test(h));
    assert.equal(spoke.length, 1, JSON.stringify({ building, results, monitorCommands }));
    assert.match(spoke[0]!, /edited a file outside this facet's ownership \(src\/sky\.js\)/);
    assert.match(spoke[0]!, /touched .*src\/plaza\.js/);
    // …and the wait it woke carries the same three facts as a line, for every worker.
    const line = results.waited.status.workers[0];
    assert.equal(line.id, "plaza");
    assert.equal(line.round, 1);
    assert.ok(line.filesChanged >= 2, JSON.stringify(line));
    assert.deepEqual(line.violations, ["edited a file outside this facet's ownership (src/sky.js)"]);
    assert.equal(typeof line.minutesInRound, "number");
    // The status blob has it too, so the director never has to ask twice for what it just read.
    assert.deepEqual(results.status.workers[0].violations, line.violations);
    // A wait answers with the news and a line per worker — not the whole run's status.
    assert.ok(
      JSON.stringify(results.waited.status).length * 2 < JSON.stringify(results.status).length,
      `wait ${JSON.stringify(results.waited.status).length} vs run_status ${JSON.stringify(results.status).length}`,
    );
    assert.ok(!JSON.stringify(results.waited.status).includes(results.started.worktree), "no worktree paths in a wait");
    // Nothing changed in the worktree since, so nothing was said again: the director keeps its turn.
    assert.deepEqual(
      (results.again.happened as string[]).filter((h) => /outside this facet's ownership/.test(h)),
      [],
      JSON.stringify(results.again.happened),
    );
  });

  /**
   * Nothing the run made is lost with the worktree it was made in. A worker's worktree is
   * detached, so every commit nobody integrated was unreferenced the moment the close removed
   * it: in one morning's repo `git for-each-ref --contains` was empty for the very shas the
   * report named as the workers' `lastCommit`, and git would have collected them.
   */
  it("a plan the user asked to review holds the first worker until they say go — and the restart it names is the same part", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-review", { title: "Director review" });
    const runId = rig.core.newRunId();
    const results: Record<string, any> = {};
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        results.brief = request.prompt;
        results.planned = text(await call("plan", planFor("plaza")));
        // The user reads the card in their chat and says the one word. It lands in the run's
        // inbox exactly as the coordinator's steering does.
        await rig.core.runFeedback({ threadId: await rig.core.threadForGame(project.name), runId, text: "go" });
        results.started = json(
          await call("worker_start", {
            id: "plaza",
            title: "Plaza",
            brief: "paint the plaza red",
            mode: "single",
            minutes: "5",
            owns: "src/plaza.js",
          }),
        );
        for (let i = 0; i < 30; i++) {
          results.waited = json(await call("wait", { seconds: "5", worker: "plaza" }));
          if (results.waited.status.workers[0]?.state !== "running") break;
        }
        // The plaza is restarted: the same part, a second builder. Nothing waits this time —
        // the window closed the moment the user answered.
        results.restarted = json(
          await call("worker_start", {
            id: "plaza2",
            title: "Plaza again",
            brief: "paint the plaza red, properly",
            mode: "single",
            minutes: "5",
            owns: "src/plaza.js",
            replaces: "plaza",
          }),
        );
        results.badRestart = text(
          await call("worker_start", { id: "gone", brief: "nothing to continue", mode: "single", replaces: "nobody" }),
        );
        for (let i = 0; i < 30; i++) {
          const waited = json(await call("wait", { seconds: "5", worker: "plaza2" }));
          if (waited.status.workers.find((w: { id: string }) => w.id === "plaza2")?.state !== "running") break;
        }
        results.finished = text(await call("finish", { summary: "the plaza is red", land: "no" }));
        return { ok: true, engine: "codex", turns: 7, usage: {}, sessionId: "director-review", summary: "run done" };
      }
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "plaza.js"), "export const plaza = 'red';\n");
      return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "worker-review", summary: "painted it" };
    });

    // `reviewPlan` rides on the run the harness builds (loop/main.ts writes it from the
    // composer's tick); the dispatch carries the run through untouched.
    await rig.core.dispatchRun({
      runId,
      goal: "a red plaza",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
      reviewPlan: true,
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished",
    );

    assert.match(results.brief, /THE USER ASKED TO READ IT FIRST/, "the lead is told the run is holding for them");
    assert.match(results.planned, /waits for their word — up to \d+ min/, results.planned);
    const planCard = customEvents(events, "autopilot_plan_review").find((e) => e.runId === runId)!;
    assert.ok(
      Number(planCard.waitMinutes) > 0,
      `the card says how long it waits: ${JSON.stringify(planCard.waitMinutes)}`,
    );
    assert.equal(results.started.started, "plaza", JSON.stringify(results.started));
    const decisions = customEvents(events, "autopilot_decision")
      .filter((e) => e.runId === runId)
      .map((e) => String(e.decision));
    assert.ok(
      decisions.some((d) => /plan review: the user said go/.test(d)),
      decisions.join(" | "),
    );
    assert.equal(
      decisions.filter((d) => /^plan review:/.test(d)).length,
      1,
      "the window closes once; the second worker never waits again",
    );
    // The restart is the same part, and only a part of this run can be continued.
    assert.equal(results.restarted.started, "plaza2", JSON.stringify(results.restarted));
    assert.match(results.badRestart, /replaces: no worker "nobody"/, results.badRestart);
    const cards = customEvents(events, "director_worker").filter((e) => e.runId === runId);
    assert.equal(cards.find((e) => e.workerId === "plaza2" && e.state === "running")?.replaces, "plaza");
    assert.equal(
      cards.find((e) => e.workerId === "plaza" && e.state === "running")?.replaces,
      undefined,
      "a first attempt continues nothing",
    );
    // What the Builds page then draws for those two builders is one part: run-graph.test.ts.
  });

  /**
   * The other ending. A user who answers the plan with anything but "go" has still read it, and
   * their words outrank it — but the hold used to stay armed, so the next worker_start blocked
   * another four-minute slice and answered "the user asked to read the plan first and has not
   * answered yet", a minute after the studio had told the lead they answered. Fifteen minutes of
   * a run could go that way, on two contradictory sentences.
   */
  it("a plan the user answers with their own words releases the hold too, and says so once", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-answered", { title: "Director answered" });
    const runId = rig.core.newRunId();
    const results: Record<string, any> = {};
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        await call("plan", planFor("plaza"));
        await rig.core.append(
          [
            {
              type: "custom",
              event_type: "run_steering",
              payload: { runId, text: "make the benches oak", at: new Date().toISOString() },
            },
          ],
          await rig.core.threadForGame(project.name),
        );
        const start = {
          id: "plaza",
          title: "Plaza",
          brief: "paint the plaza red",
          mode: "single",
          minutes: "5",
          owns: "src/plaza.js",
        };
        results.answered = text(await call("worker_start", start));
        const at = Date.now();
        results.started = json(await call("worker_start", start));
        results.tookMs = Date.now() - at;
        for (let i = 0; i < 30; i++) {
          const waited = json(await call("wait", { seconds: "5", worker: "plaza" }));
          if (waited.status.workers[0]?.state !== "running") break;
        }
        await call("finish", { summary: "the benches are oak", land: "no" });
        return {
          ok: true,
          engine: "codex",
          turns: 5,
          usage: {},
          sessionId: "director-answered",
          summary: "run done",
        };
      }
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "plaza.js"), "export const plaza = 'oak';\n");
      return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "worker-answered", summary: "oak benches" };
    });

    await rig.core.dispatchRun({
      runId,
      goal: "a red plaza",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
      reviewPlan: true,
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished",
    );

    assert.match(results.answered, /the user answered your plan: "make the benches oak"/, results.answered);
    assert.equal(results.started.started, "plaza", JSON.stringify(results.started));
    assert.ok(
      results.tookMs < 60_000,
      `the second start builds instead of waiting out another slice (${results.tookMs} ms)`,
    );
    const cards = customEvents(events, "autopilot_decision").filter((e) => e.runId === runId);
    const review = cards.filter((e) => /^plan review:/.test(String(e.decision)));
    assert.equal(review.length, 1, cards.map((e) => e.decision).join(" | "));
    assert.match(String(review[0]!.decision), /plan review: the user answered the plan/);
    assert.doesNotMatch(String(review[0]!.decision), /said go/, "the card never puts a word in their mouth");
    assert.match(String(review[0]!.plain), /^you answered the plan, so the builders are starting with what you said/);
  });

  it("a worker's commit outlives its worktree: the close refs it, and the user can still play it", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-keep", { title: "Director keep" });
    const results: Record<string, any> = {};
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        await call("plan", planFor("bench"));
        results.started = json(
          await call("worker_start", {
            id: "bench",
            title: "Bench",
            brief: "put an oak bench in the plaza",
            mode: "single",
            minutes: "5",
            owns: "src/bench.js",
          }),
        );
        for (let i = 0; i < 30; i++) {
          results.waited = json(await call("wait", { seconds: "5", worker: "bench" }));
          if (results.waited.status.workers[0]?.state !== "running") break;
        }
        results.wstatus = json(await call("worker_status", { id: "bench" }));
        // The bench is never integrated — the director does not think it is ready — and the
        // run ends. Its commit is exactly the kind that used to disappear.
        results.finished = text(await call("finish", { summary: "the bench is not right yet", land: "no" }));
        return {
          ok: true,
          engine: "codex",
          turns: 5,
          usage: {},
          sessionId: "director-keep",
          summary: "left the bench where it is",
        };
      }
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "bench.js"), "export const bench = 'oak';\n");
      return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "worker-keep", summary: "put the bench in" };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a bench",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "bench", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished",
    );

    const commit: string = results.wstatus.lastCommit;
    assert.ok(commit, `the worker committed: ${JSON.stringify(results.wstatus)}`);
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, false, "nothing was integrated or landed");
    assert.equal(
      (finished.workers as Record<string, { lastCommit: string }>).bench.lastCommit,
      commit,
      "the report names the commit",
    );
    await assert.rejects(stat(results.started.worktree), "the worktree it was made in is gone");

    // The acceptance: something in the game's repo still contains that commit.
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    const containing = (await api["run.exec"]!({
      command: `git for-each-ref --contains ${commit}`,
      project: project.name,
      timeoutMs: 30_000,
    })) as { stdout: string };
    assert.match(
      containing.stdout,
      new RegExp(`refs/studio/runs/${runId}/workers/bench`),
      `no ref contains ${commit}: "${containing.stdout}"`,
    );
    const shown = (await api["run.exec"]!({
      command: `git show refs/studio/runs/${runId}/workers/bench:src/bench.js`,
      project: project.name,
      timeoutMs: 30_000,
    })) as { stdout: string };
    assert.match(shown.stdout, /bench = 'oak'/);
    // Which is what "Play this build" needs in the morning: the sha the report named, playable.
    const copy = await rig.core.showBuild(project.name, commit);
    assert.equal(await readFile(path.join(copy.dir, "src", "bench.js"), "utf8"), "export const bench = 'oak';\n");
  });

  /**
   * The director's memory. Its brief tells it to keep `.studio/DIRECTOR.md` current, and a
   * resumed session is told to read that file — but `.studio/` is ignored by git in every
   * worktree, so the file is never committed, and the worktree it lives in is removed at the
   * close. The run that paused on a session limit left no DIRECTOR.md anywhere under its run
   * folder, and the morning's resume opened by telling the director to read it.
   */
  it("the memory file the resumed run is told to read is there: kept at the close, restored into the fresh worktree", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-memory", { title: "Director memory" });
    const memory =
      "# what I know\n- the plaza camera is the one the user judges by\n- the haze peak above 0.5 washes the sky out\n";
    const results: Record<string, any> = {};
    const prompts: string[] = [];
    let sessions = 0;
    fakeEngine(rig, async (request) => {
      if (!request.director) return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "none", summary: "" };
      prompts.push(request.prompt);
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (++sessions === 1) {
        await mkdir(path.join(request.cwd, ".studio"), { recursive: true });
        await writeFile(path.join(request.cwd, ".studio", "DIRECTOR.md"), memory);
        await call("note", {
          text: "wrote down what I know about the plaza camera",
          plain: "made a note of what it learned",
        });
        // The engine's limit ends the session here: the run pauses with the file on disk.
        throw new EngineError(
          "rate_limit",
          "codex",
          "You've hit your session limit · resets 9:50pm (Europe/Belgrade)",
          4 * 3_600_000,
        );
      }
      results.memoryOnResume = await readFile(path.join(request.cwd, ".studio", "DIRECTOR.md"), "utf8").catch((err) =>
        String(err),
      );
      results.finished = text(await call("finish", { summary: "read my notes and stopped", land: "no" }));
      return {
        ok: true,
        engine: "codex",
        turns: 3,
        usage: {},
        sessionId: "director-memory-2",
        summary: "picked up where I left off",
      };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a plaza at dusk",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "dusk", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
      // Flipped (one session): the memory file is the long turn's: a waking lead keeps none (the journal carries its run).
      directorLoop: "turn",
    });
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "autopilot_paused").some((e) => e.runId === runId),
      120_000,
      "the run to pause on the limit",
    );

    // Kept as a run artefact — the record a developer, or the next run, can read.
    assert.equal(await readFile(path.join(rig.core.layout.runs, runId, "director", "DIRECTOR.md"), "utf8"), memory);

    await rig.core.resumeAutopilot(runId);
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").filter((e) => e.runId === runId).length >= 2,
      120_000,
      "the resumed run's closure",
    );

    assert.equal(sessions, 2, "one resumed session");
    // The worktree is new (the close removed the old one) and the notes are in it.
    assert.equal(results.memoryOnResume, memory, results.memoryOnResume);
    assert.match(prompts[1]!, /YOU WERE RESUMED/);
    assert.match(
      prompts[1]!,
      /Read \.studio\/DIRECTOR\.md — the notes you kept last session, restored into this worktree/,
      prompts[1]!.slice(0, 4_000),
    );
    assert.match(results.finished, /the run is closed/);
  });

  /**
   * The pool never lends the user's window (M3.7; flipped). Here it has none to give at all, so
   * every pass meets an exhausted pool. A
   * judge and a playtest are choices the director can make a minute later: they are told there is
   * no window. The close cannot be skipped — nobody else will ever look at this build — so it used
   * to borrow the user's window, say so on the run's thread and put their game back. It looks
   * through the studio's own stand-in now, and the user's window keeps what they opened.
   */
  it("with no window free: judge and playtest are told so, and the close looks without touching the user's window", async () => {
    // Every hidden window the run opens, and every folder it was pointed at.
    const windows: FakePreview[] = [];
    const looked: Array<string | null> = [];
    let blind = false;
    const rig = await startRig(
      { replies: [] },
      {
        previewPoolMax: 0,
        createHeadlessPreview: async () => {
          const window = makeFakePreview();
          if (blind) window.pixelStatsNext = { ...window.pixelStatsNext, litFraction: 0, meanLuma: 0 };
          const load = window.load.bind(window);
          window.load = async (name: string, entry?: string, root?: string, options?: { loopback?: boolean }) => {
            looked.push(root ?? null);
            return load(name, entry, root, options);
          };
          windows.push(window);
          return window;
        },
      },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-borrow", { title: "Director borrow" });
    // Every load of the user's own window, and what it was pointed at.
    const shown: Array<{ project: string; root: string | null }> = [];
    const load = rig.preview.load.bind(rig.preview);
    rig.preview.load = async (name: string, entry?: string, root?: string, options?: { loopback?: boolean }) => {
      shown.push({ project: name, root: root ?? null });
      return load(name, entry, root, options);
    };
    // The user opens the game: the one load of their window that is theirs.
    await rig.core.loadPreview({ project: project.name });
    const results: Record<string, any> = {};
    let sessions = 0;
    fakeEngine(rig, async (request) => {
      if (!request.director) return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "none", summary: "" };
      // The wrap-up session has nothing to add; the close below is this test's subject.
      if (++sessions > 1)
        return {
          ok: true,
          engine: "codex",
          turns: 1,
          usage: {},
          sessionId: "director-borrow-2",
          summary: "nothing left to do",
        };
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      results.capacity = json(await call("run_status", {})).capacity;
      await call("plan", planFor("sign"));
      results.noWorker = text(
        await call("worker_start", {
          id: "sign",
          title: "Sign",
          brief: "hang a sign",
          minutes: "5",
          owns: "src/sign.js",
        }),
      );
      const loadsBefore = shown.length;
      results.judged = text(await call("judge", { target: "integration" }));
      results.played = text(await call("playtest", { target: "integration", ask: "does the sign light up?" }));
      results.borrowedForJudging = shown.length - loadsBefore;
      // The lead's own commit, so the close has something beyond the starting point to look at.
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "sign.js"), "export const sign = 'lit';\n");
      await git(request.cwd, ["add", "-A"]);
      await git(request.cwd, [
        "-c",
        "user.name=Studio",
        "-c",
        "user.email=studio@ai-game-studio.local",
        "commit",
        "-q",
        "-m",
        "the lead's own edit",
      ]);
      // The lead offers its own build to the user's Live; the user never presses Reload here.
      results.shown = text(await call("show", { target: "integration" }));
      // And the build now draws nothing wherever the close looks, so its look fails and nothing lands.
      blind = true;
      for (const window of windows) window.pixelStatsNext = { ...window.pixelStatsNext, litFraction: 0, meanLuma: 0 };
      return {
        ok: true,
        engine: "codex",
        turns: 5,
        usage: {},
        sessionId: "director-borrow",
        summary: "left it to the close",
      };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a lit sign",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "sign", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
      // Flipped (one session): the lead's own commit is the long turn's: a waking lead writes nothing.
      directorLoop: "turn",
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      180_000,
      "the borrowed close to finish",
    );

    // Nothing to lend: the worker gate says so in the same words, and the judges wait their turn.
    assert.equal(results.capacity.windowsMax, 0);
    assert.match(results.noWorker, /no worker window free \(0 of 0 in use/, results.noWorker);
    assert.match(results.judged, /^no window free/, results.judged);
    assert.match(results.judged, /wait for one to finish or stop one/, results.judged);
    assert.match(results.played, /^no window free/, results.played);
    assert.equal(results.borrowedForJudging, 0, "neither pass touched the window the user is watching");

    // The close had to look, and it looked through the studio's own window: no borrow to announce.
    assert.deepEqual(customEvents(events, "director_window"), []);
    const worktree = path.join("autopilot", runId, "integration");
    assert.match(results.shown, /Live's Reload now offers integration/);
    assert.ok(
      looked.some((root) => root?.includes(worktree)),
      `the close never looked: ${JSON.stringify(looked)}`,
    );
    // The user's window kept what they opened, through the show, the close and the teardown.
    assert.deepEqual(shown, [{ project: project.name, root: null }], JSON.stringify(shown));

    // Nothing landed (the close's look found a black page).
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, false, String(finished.stoppedBecause));
    assert.equal(rig.preview.loadRoot, null, "the run did not end with the user's window on a removed worktree");
    await assert.rejects(
      stat(path.join(rig.core.layout.scratch, "autopilot", runId, "integration")),
      "the integration worktree is removed",
    );
  });

  /**
   * A game that already knows what it is (M4.4/M4.6). The kind lives in the user's own
   * studio.json — the one declaration source that survives a run — and the director wrote it
   * there without ever reading it back: a second run on a declared board game drove mouse-look
   * and WASD before every judgement and put no HUD, look or movement check on any board. Three
   * more things this run proves: the kind the plan declares reaches the card the user reads
   * before the builders start; the write into their folder is COMMITTED where it was made, so
   * the morning's "Make it my game" is not refused over an edit only the studio made; and a
   * worker with no seam runs alone whichever end of the run it was started from.
   */
  it("reads the kind the game already declares, commits the one it writes, and keeps a seamless worker alone", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const dir = path.join(await tmpDir("studio-declared-"), "boardgame");
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(
      path.join(dir, "index.html"),
      '<!doctype html><title>BOARD</title><script type="module" src="/src/main.js"></script>\n',
    );
    await writeFile(
      path.join(dir, "src", "main.js"),
      'import { installStudio } from "./studio.js";\nconst scene = {};\ninstallStudio({ scene, renderer: {}, camera: {}, player: () => ({ x: 0, y: 0, z: 0, yaw: 0 }) });\nexport { scene };\n',
    );
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "boardgame", type: "module" }));
    // What an earlier run wrote into their file, and what this run must open knowing.
    await writeFile(
      path.join(dir, "studio.json"),
      JSON.stringify({
        name: "boardgame",
        title: "Board game",
        createdAt: "",
        contractVersion: 1,
        entry: "index.html",
        main: "src/main.js",
        build: null,
        serve: ".",
        own: true,
        kind: "three-modules",
        game: { kind: "top-down", hud: true, mouseLook: false, keyboardMove: true, declaredBy: "an earlier run" },
      }),
    );
    const project = await rig.core.adoptProject(dir);
    const seen: { director: DelegateRequest[]; workers: DelegateRequest[] } = { director: [], workers: [] };
    const results: Record<string, any> = {};
    fakeEngine(rig, async (request) => {
      if (request.director) {
        seen.director.push(request);
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        // The director looked and decided this is not the top-down game the file says.
        results.planned = text(await call("plan", { ...planFor("core"), kind: "first-person" }));
        // A worker with no seam owns nearly the whole repository, so it starts alone…
        results.startedCore = json(
          await call("worker_start", {
            id: "core",
            title: "The core",
            brief: "make the board read",
            mode: "single",
            minutes: "5",
          }),
        );
        // …and nobody may start beside it, seam of their own or not.
        results.refusedBeside = text(
          await call("worker_start", {
            id: "hud",
            title: "The HUD",
            brief: "a hud",
            mode: "single",
            minutes: "5",
            owns: "src/hud.js",
          }),
        );
        for (let i = 0; i < 30; i += 1) {
          results.waited = json(await call("wait", { seconds: "5", worker: "core" }));
          if (results.waited.status.workers[0]?.state !== "running") break;
        }
        results.finished = text(await call("finish", { summary: "looked at the board", land: "no" }));
        return {
          ok: true,
          engine: "codex",
          turns: 7,
          usage: {},
          sessionId: "director-declared",
          summary: "read what the game says it is",
        };
      }
      seen.workers.push(request);
      await writeFile(path.join(request.cwd, "src", "core.js"), "export const core = true;\n");
      return {
        ok: true,
        engine: "codex",
        turns: 2,
        usage: {},
        sessionId: "worker-declared",
        summary: "the board reads",
      };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "make the board read",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "chess", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      180_000,
      "director run_finished on a game that declares its kind",
    );

    // The declaration the studio wrote last time is read back before the session opens, and the
    // brief says so — the director confirms or corrects it instead of guessing again.
    assert.match(
      seen.director[0]!.prompt,
      /THIS GAME ALREADY SAYS WHAT IT IS: its studio\.json declares a top-down game/,
      seen.director[0]!.prompt.slice(0, 4_000),
    );

    // What the run decided is on the plan card the user reads before any builder starts.
    const card = customEvents(events, "autopilot_plan_review").find((e) => e.runId === runId)!;
    assert.equal((card.game as { kind?: string })?.kind, "first-person", JSON.stringify(card));

    // …and it is in their studio.json, committed by the studio that wrote it: the folder ends
    // the run exactly as clean as it began.
    const stored = JSON.parse(await readFile(path.join(project.dir, "studio.json"), "utf8"));
    assert.equal(stored.game.kind, "first-person", JSON.stringify(stored.game));
    assert.equal(stored.game.declaredBy, "plan");
    assert.equal(stored.name, "boardgame", "every key the file already had survived");
    assert.equal(
      await git(project.dir, ["status", "--porcelain"]),
      "",
      "no edit of the studio's own is left for the user to explain",
    );
    assert.match(await git(project.dir, ["log", "-1", "--format=%s"]), /studio: this game is a first-person game/);

    // The second worker was refused by name, and never started.
    assert.equal(results.startedCore.started, "core", JSON.stringify(results.startedCore));
    assert.match(results.refusedBeside, /worker "core" is running with no seam/, results.refusedBeside);
    assert.match(results.refusedBeside, /stop it or wait for it before starting "hud"/, results.refusedBeside);
    assert.equal(seen.workers.length, 1, "one builder session ran");
  });
});

describe("the selected direction-build duration", () => {
  it("refuses an early finish that claims nothing, resumes the director, starts a worker, and honors an explicit user finish", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 3, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("timed-director", { title: "Timed director" });
    const runId = rig.core.newRunId();
    let turns = 0,
      workers = 0;
    let refusal = "";
    fakeEngine(rig, async (request) => {
      // Flipped: the lead's claim is checked by a reviewer first, which says yes here.
      if (seatedReviewer(request)) return reviewerAnswer("yes") as never;
      if (!request.director) {
        workers++;
        await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'dusk';\n");
        return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "worker", summary: "Dusk sky" };
      }
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (++turns === 1) {
        // Flipped: a claim (victory=yes) is checked whenever it comes (time-cap.ts); a finish that claims nothing is still refused.
        refusal = text(await call("finish", { summary: "The starting point is playable", land: "yes" }));
        assert.match(refusal, /finish refused.*working minutes remain/);
        return {
          ok: true,
          engine: "codex",
          turns: 1,
          usage: {},
          sessionId: "timed-session",
          summary: "First playable",
        };
      }
      assert.equal(request.resume, "timed-session");
      assert.match(request.prompt, /timed build still has/);
      await call("plan", planFor("sky"));
      await call("worker_start", {
        id: "sky",
        title: "Dusk sky",
        brief: "Build a dusk sky",
        mode: "single",
        owns: "src/sky.js",
        minutes: "5",
      });
      for (let i = 0; i < 30; i++) {
        const status = json(await call("wait", { seconds: "1", worker: "sky" }));
        if (status.status.workers[0]?.state !== "running") break;
      }
      // The user's Finish, where the run's inbox reads it: the game's own thread, not the studio's.
      await rig.core.append(
        [{ type: "custom", event_type: "run_control", payload: { runId, action: "finish" } }],
        await rig.core.threadForGame(project.name),
      );
      assert.match(
        text(await call("finish", { summary: "Stopped early at the user’s request", land: "no" })),
        /run is closed/,
      );
      return {
        ok: true,
        engine: "codex",
        turns: 4,
        usage: {},
        sessionId: "timed-session",
        summary: "Finished as requested",
      };
    });
    await rig.core.dispatchRun({
      runId,
      goal: "A dusk scene",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "Dusk", kind: "direction", shots: [] },
      budgets: { wallClockMs: 3_600_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "timed direction completion",
    );
    assert.equal(turns, 2);
    assert.ok(workers >= 1);
    assert.equal(customEvents(events, "director_continued").length, 1);
    // The lead was woken once, to be asked what next (director/wake.ts): nothing else woke it.
    assert.deepEqual(customEvents(events, "director_continued")[0]!.reasons, ["idle_ask"]);
    assert.equal(customEvents(events, "run_finished").filter((e) => e.runId === runId).length, 1);
  });
});

/**
 * A plan of several looping parts holds its loop workers to a module contract, so parallel workers
 * never rewrite each other's modules around a shared state object nobody wrote down. Through the
 * real core and harness, no worker starts here — what is
 * proved is every refusal, and the contract the plan commits on the integration branch.
 */
describe("a module contract before loop workers", () => {
  it("MC1. refuses a loop worker until the plan carries a contract, its stubs exist and its seam leaves the other part alone", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 3, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("director-contract", { title: "Director contract" });
    const results: Record<string, any> = {};
    const contract = {
      conventions: ["the plaza is 40 metres across"],
      modules: [
        { path: "src/plaza.js", owner: "plaza", api: ["export function buildPlaza(scene)"] },
        { path: "src/sky.js", owner: "sky", api: ["export function buildSky(scene)"] },
      ],
    };
    fakeEngine(rig, async (request) => {
      if (!request.director)
        return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "worker", summary: "nothing" };
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      await call("plan", planFor("plaza", "sky"));
      results.noContract = text(await call("worker_start", { id: "plaza", brief: "pave it", owns: "src/plaza.js" }));
      results.badPath = text(
        await call("plan", {
          ...planFor("plaza", "sky"),
          contract: '{"modules":[{"path":"../x.js","owner":"plaza"}]}',
        }),
      );
      results.planned = text(
        await call("plan", { ...planFor("plaza", "sky"), contract: JSON.stringify(contract), vision: PLAZA_VISION }),
      );
      results.noStubs = text(await call("worker_start", { id: "plaza", brief: "pave it" }));
      results.wide = text(await call("worker_start", { id: "sky", brief: "a dusk sky", owns: "src/" }));
      results.finished = text(await call("finish", { summary: "a contract and nothing built", land: "no" }));
      return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "director-contract", summary: "done" };
    });
    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a plaza under a dusk sky",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished",
    );
    assert.match(results.noContract, /2 parts that loop, and no module contract yet: call plan again with contract=/);
    assert.match(results.badPath, /^plan: contract path \.\.\/x\.js is not one file relative to the game/);
    assert.match(
      results.planned,
      /The module contract is committed on integration as docs\/MODULE-CONTRACT\.md \([0-9a-f]{10}\).*Stubs still to write before their loop workers start: src\/plaza\.js, src\/sky\.js/,
    );
    assert.match(
      results.noStubs,
      /the contract gives "plaza" src\/plaza\.js, which does not exist at [0-9a-f]{10}: write the stubs first/,
    );
    assert.match(results.wide, /owns= would reach other parts' modules \(src\/ → src\/plaza\.js, plaza's\)/);
    assert.deepEqual(
      customEvents(events, "director_worker").filter((e) => e.runId === runId),
      [],
      "nobody started",
    );
    const architecture = await git(project.dir, [
      "show",
      `refs/studio/runs/${runId}/integration:docs/MODULE-CONTRACT.md`,
    ]);
    assert.match(architecture, /### src\/plaza\.js — owned by `plaza` \(plaza\)/);
    assert.match(architecture, /- the plaza is 40 metres across/);
    const vision = await git(project.dir, ["show", `refs/studio/runs/${runId}/integration:docs/VISION.md`]);
    assert.match(vision, /## Headroom\n\nthe river bank and a market street/, "the vision is committed beside it");
  });

  /**
   * A game from scratch under a contract (review): the base stage accepted an empty world, the
   * plan's contract was committed on top of it, and every loop worker had to fork from that
   * commit — which the fork gate looked at as a game, not a start, and refused as "does not run".
   */
  it("MC2. a loop worker forks from the contract written on an empty starting point, and the close lands nothing", async () => {
    /** The empty scaffold as a window sees it: nothing drawn, and an inspection that proves it. */
    const asEmptyScaffold = (preview: FakePreview): FakePreview => {
      preview.pixelStatsNext = { width: 800, height: 600, sampled: 480_000, meanLuma: 0, litFraction: 0, canvas: true };
      preview.evaluations.push({ match: "isScene", value: true }, { match: "matrixWorld", value: "[1,0,0,1]" });
      return preview;
    };
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => asEmptyScaffold(makeFakePreview()) },
    );
    rigs.push(rig);
    asEmptyScaffold(rig.preview);
    const project = await rig.core.games.scaffold("director-contract-scratch", { title: "Contract from scratch" });
    const results: Record<string, any> = {};
    const contract = {
      modules: [
        { path: "src/world.js", owner: "plaza", api: ["export const world"] },
        { path: "src/sky.js", owner: "sky", api: ["export function buildSky(scene)"] },
      ],
    };
    fakeEngine(rig, async (request) => {
      if (request.director) {
        const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
        results.planned = text(
          await call("plan", { ...planFor("plaza", "sky"), contract: JSON.stringify(contract), vision: PLAZA_VISION }),
        );
        results.started = json(await call("worker_start", { id: "plaza", brief: "pave the plaza", minutes: "5" }));
        if (results.started.started) {
          await call("worker_stop", { id: "plaza", why: "the start is what this proves" });
          for (let i = 0; i < 30; i++) {
            const waited = json(await call("wait", { seconds: "5", worker: "plaza" }));
            if (waited.status.workers[0]?.state !== "running") break;
          }
        }
        results.finished = text(await call("finish", { summary: "a contract on the start", land: "yes" }));
        return { ok: true, engine: "codex", turns: 4, usage: {}, sessionId: "director-cs", summary: "done" };
      }
      if (path.basename(request.cwd) === "integration") {
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "world.js"), "export const world = { groups: ['plaza'] };\n");
        return { ok: true, engine: "codex", turns: 2, usage: {}, sessionId: "base-cs", summary: "empty groups" };
      }
      return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "worker-cs", summary: "nothing yet" };
    });
    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a plaza under a dusk sky",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "plaza", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "director run_finished on a contract from scratch",
    );
    const base = customEvents(events, "autopilot_base").find((e) => e.runId === runId)!;
    assert.equal(base.empty, true, "the starting point is an empty world");
    assert.match(results.planned, /The module contract is committed on integration as docs\/MODULE-CONTRACT\.md/);
    // Red before the fix: "the build you would fork from does not run … renders effectively black".
    assert.equal(results.started.started, "plaza", JSON.stringify(results.started));
    const contractCommit = await git(project.dir, ["rev-parse", `refs/studio/runs/${runId}/integration`]);
    assert.ok(contractCommit.startsWith(results.started.forkedFrom), "from the contract's commit");
    const finished = customEvents(events, "run_finished").find((e) => e.runId === runId)!;
    assert.equal(finished.landed, false, "the start and a document are nothing to land");
  });
});

describe("a game that keeps its own edited HUD", () => {
  it("notes the first-generation HUD it leaves alone, and keeps the owner's copy", async () => {
    const rig = await startRig(
      { replies: [] },
      { previewPoolMax: 2, createHeadlessPreview: async () => makeFakePreview() },
    );
    rigs.push(rig);
    const project = await rig.core.games.scaffold("held-hud", { title: "Held HUD" });
    // The game's first HUD, with the owner's own gauge helper in it: theirs, so the upgrade keeps it.
    const hudFile = path.join(project.dir, "src", "hud.js");
    const first = await readFile(path.join(import.meta.dirname, "..", "fixtures", "hud-generation-1.js.txt"), "utf8");
    const edited = `${first}// the main owner's own gauge helper\n`;
    await writeFile(hudFile, edited);
    fakeEngine(rig, async (request) => {
      if (!request.director) throw new Error("no worker is started");
      await request.onLiveTool!("finish", { summary: "nothing to build", land: "no" });
      return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "director-held", summary: "finished" };
    });

    const runId = rig.core.newRunId();
    await rig.core.dispatchRun({
      runId,
      goal: "a dashboard",
      project: project.name,
      mode: "autopilot",
      engine: "codex",
      reference: { name: "dash", shots: [] },
      budgets: { wallClockMs: 15 * 60_000 },
    });
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
      120_000,
      "held-HUD run_finished",
    );
    const cards = customEvents(events, "autopilot_decision").filter((e) => e.runId === runId);
    const held = cards.find((e) => /left src\/hud\.js at HUD generation 1/.test(String(e.decision)));
    assert.ok(held, cards.map((e) => String(e.decision)).join(" | "));
    assert.match(String(held.plain), /text, bars and the crosshair/);
    assert.equal(await readFile(hudFile, "utf8"), edited, "the owner's HUD is untouched");
  });
});
