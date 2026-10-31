/**
 * The Loop's lead on a web game. Through the real core and the real harness child: a scripted lead
 * starts a worker in its own copy, waits, looks, merges it (one health check of the merged build),
 * asks a second opinion, shows the build, leaves a note and finishes — and the integration branch
 * lands in the game folder; a repository of the user's own inside the game; the lead's engine limit,
 * a restart and a Stop that pause the run, and the resume that lands what it merged; a landing over
 * the user's own commits; a worker the lead stops or steers; a commit of the lead's own; what a
 * closed run keeps on its refs; and a run with no window to look through. The finish's own rules
 * (the person's finish, the time cap, one finish at a time, one close) are checked on a fake run.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  EngineError,
  type CompleteRequest,
  type CompleteResponse,
  type DelegateRequest,
  type DelegateResult,
  type LiveToolResult,
} from "../../src/substrate/engines/types.ts";
import { gitFile } from "../helpers/git.ts";
import {
  customEvents,
  makeFakePreview,
  startRig,
  waitForLog,
  type FakePreview,
  type Rig,
} from "../helpers/studio-rig.ts";
import { StopWhy } from "../../src/harness-seed/loop/finish-contract.ts";
import { buildRunGraph } from "../../src/renderer/run-graph.ts";
import { directorTool } from "../../src/harness-seed/loop/director.ts";

/** How long a test waits for its run's close. */
const CLOSE_WAIT_MS = 180_000;
/** The longest a scripted lead waits for its worker in one call. */
const WORKER_WAIT_S = "120";

/**
 * The tools a web lead is offered, sorted. Flipped (Loop phase 5): no plan, integrate, playtest or
 * goal_update; a second opinion is `judge`.
 */
const PINNED_LEAD_TOOLS: string[] = [
  "app_look",
  "blender__install",
  "blender__model",
  "blender__retrieve",
  "blender__status",
  "computer",
  "finish",
  "genex__asset",
  "genex__cli",
  "genex__cli-paid",
  "genex__cover",
  "genex__cover-set",
  "genex__package",
  "genex__publish",
  "genex__publish-status",
  "genex__skill",
  "job_start",
  "job_status",
  "job_stop",
  "job_tail",
  "judge",
  "look",
  "note",
  "plugins_find",
  "plugins_suggest",
  "run_status",
  "show",
  "worker_mark",
  "worker_start",
  "worker_status",
  "worker_steer",
  "worker_stop",
  "worker_wait",
  "wrap_up",
];
/**
 * A web run's event types, in the order they first appear. Flipped (Loop phase 5): no plan review,
 * director_worker, fork gate, playtest evidence, finish check or optimization; the second opinion is
 * a `completion_call`, and the merge's health check is a `director_progress` line first.
 */
const PINNED_EVENT_TYPES: string[] = [
  "run_registered",
  "run_started",
  "autopilot_started",
  "session_activity",
  "worker_started",
  "worker_finished",
  "director_progress",
  "integration_health",
  "director_verdict",
  "completion_call",
  "director_show",
  "autopilot_decision",
  "run_finished",
];
/**
 * The Builds graph's node kinds of a web run, sorted. Flipped (Loop phase 5): no finish check and no
 * optimization node; the worker is a `facet` node under the lead.
 */
const PINNED_GRAPH_KINDS: string[] = ["base", "facet", "final", "integration", "lead", "run"];

const rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.stop().catch(() => {})));
});

/** git in a folder, the way the lead itself works in one: with its own hands. */
const git = async (cwd: string, args: string[]): Promise<string> => (await gitFile(args, { cwd })).stdout.trim();
/** `git commit` under a name of its own, as a person or the lead makes one. */
const commitAs = (name: string, message: string) => [
  "-c",
  `user.name=${name}`,
  "-c",
  "user.email=someone@example.com",
  "commit",
  "-q",
  "-m",
  message,
];

const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);

/** A writer in its own copy of the integration branch, as a lead starts one. */
const copyWorker = (title: string, task: string) => ({ title, task, isolation: "copy" });

/** A lead's run tools, answering text. */
type Call = (name: string, args: Record<string, unknown>) => Promise<string>;
const liveCall =
  (request: DelegateRequest): Call =>
  async (name, args) =>
    text(await request.onLiveTool!(name, args));

/** A session's result, as the engine reports one. */
const result = (sessionId: string, summary: string): DelegateResult => ({
  ok: true,
  engine: "codex",
  turns: 1,
  usage: {},
  sessionId,
  summary,
});

/** A worker that writes one file in its copy. */
async function writes(request: DelegateRequest, file: string, content: string): Promise<DelegateResult> {
  await mkdir(path.dirname(path.join(request.cwd, file)), { recursive: true });
  await writeFile(path.join(request.cwd, file), content);
  return result(`worker-${request.worker?.id ?? "x"}`, `wrote ${file}`);
}

/** A worker session that ends only when it is stopped. */
const untilStopped = (request: DelegateRequest, sessionId: string, summary: string): Promise<DelegateResult> =>
  new Promise((resolve) => {
    const stopped = () =>
      resolve({ ok: false, engine: "codex", turns: 1, usage: {}, stopReason: "stopped", sessionId, summary });
    if (request.signal?.aborted) stopped();
    else request.signal?.addEventListener("abort", stopped, { once: true });
  });

/** `complete` answers a second opinion: it opens with yes. */
const SECOND_OPINION = "yes: the plaza is red";

/** The fake engine every run here leads and works on. */
function fakeEngine(
  rig: Rig,
  delegate: (request: DelegateRequest) => Promise<DelegateResult>,
  complete: (request: CompleteRequest) => Promise<CompleteResponse> = async () => ({
    message: { role: "assistant", content: SECOND_OPINION },
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

/** What a web run is started with beside its lead and workers. */
interface WebRunOptions {
  /** Prepares the game before the run starts. */
  setup?: (rig: Rig, project: { name: string; dir: string }) => Promise<void>;
  /** How many windows the run may borrow (default 2). */
  windows?: number;
  createHeadlessPreview?: () => Promise<FakePreview>;
  goal?: string;
}

/** A Loop on a fresh game, its sessions answered by `delegate`; resolves once the run closed. */
async function webRun(
  name: string,
  delegate: (request: DelegateRequest) => Promise<DelegateResult>,
  options: WebRunOptions = {},
) {
  const rig = await startRig(
    { replies: [] },
    {
      previewPoolMax: options.windows ?? 2,
      createHeadlessPreview: options.createHeadlessPreview ?? (async () => makeFakePreview()),
    },
  );
  rigs.push(rig);
  const project = await rig.core.games.scaffold(name, { title: name });
  await options.setup?.(rig, project);
  fakeEngine(rig, delegate);
  const runId = rig.core.newRunId();
  await rig.core.dispatchRun({
    runId,
    goal: options.goal ?? "a red plaza",
    project: project.name,
    mode: "autopilot",
    engine: "codex",
    reference: { name: "plaza", shots: [] },
    budgets: { wallClockMs: 15 * 60_000 },
  });
  const events = await waitForLog(
    rig.core,
    (log) => customEvents(log, "run_finished").some((e) => e.runId === runId),
    CLOSE_WAIT_MS,
    `${name} run_finished`,
  );
  const finished = customEvents(events, "run_finished").find((e) => e.runId === runId) as Record<string, any>;
  return { rig, project, runId, events, finished };
}

/** One worker in a copy, waited for and merged: the merge's answer. */
async function mergedWorker(call: Call, title: string, task: string): Promise<string> {
  await call("worker_start", copyWorker(title, task));
  await call("worker_wait", { id: "w1", seconds: WORKER_WAIT_S });
  return call("worker_mark", { id: "w1", verdict: "used" });
}

/** A repository of the user's own at `wreckage/` inside the game, committed there as a pointer (or, consented, as files). */
async function nestedRepository(dir: string, { consented }: { consented: boolean }): Promise<void> {
  const nested = path.join(dir, "wreckage");
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, "car.js"), "export const car = 'wreck';\n");
  await git(nested, ["init", "-q"]);
  await git(nested, ["add", "-A"]);
  await git(nested, commitAs("You", "the game so far"));
  const staged = ["wreckage"];
  if (consented) {
    // "Keep this folder", as the Open Game sheet writes it into the game's own studio.json.
    const meta = JSON.parse(await readFile(path.join(dir, "studio.json"), "utf8"));
    await writeFile(path.join(dir, "studio.json"), `${JSON.stringify({ ...meta, versionNested: true }, null, 2)}\n`);
    staged.push("studio.json");
  }
  await git(dir, ["add", ...staged]);
  await git(dir, commitAs("You", "the game inside the folder"));
}

describe("the lead's tools", () => {
  it("answers a tool call for a run without a lead with a sentence, never a throw", async () => {
    // Flipped (Loop phase 5): the sentence names a lead session, no director.
    assert.match(
      String(await directorTool({ runId: "run_nobody", name: "run_status", args: {} })),
      /no lead session for run run_nobody/,
    );
  });
});

/** A run as the lead's `finish` reads it, closing without a landing (`land=no` needs no health check). */
function finishingLoopRun(over: { finishing?: boolean; hold?: Promise<void> } = {}) {
  const closes: Array<Record<string, unknown>> = [];
  const state: Record<string, any> = { finish: null, finished: false, integrationHead: "a".repeat(40) };
  const loopRun: Record<string, any> = {
    ctx: { cancelled: false },
    run: { runId: "run_finish", project: "finish-game", goal: "a red plaza", engine: "codex" },
    softDeadline: Date.now() + 60 * 60_000,
    report: {},
    state,
    inbox: { finishing: async () => over.finishing === true, steering: async () => [] },
    closeTheLoopRun: async (options: Record<string, unknown>) => {
      closes.push(options);
      await over.hold;
      state.finished = true;
      return { ok: false, reason: "land=no" };
    },
  };
  return { loopRun, closes, state };
}

describe("the lead's finish", () => {
  it("victory=no is a report; the lead's yes is its own claim; the person's own finish claims nothing", async () => {
    const { finish } = await import("../../src/harness-seed/loop/director/integrate.ts");
    const report = finishingLoopRun();
    await finish(report.loopRun as never, { summary: "where it stopped", land: "no", victory: "no" });
    assert.equal(report.closes[0]?.victory, false);
    // Flipped (Loop phase 5): no reviewer reads the claim: the lead's victory=yes is its word.
    const claimed = finishingLoopRun();
    await finish(claimed.loopRun as never, { summary: "it is red", land: "no", victory: "yes" });
    assert.equal(claimed.closes[0]?.victory, true, "nobody else has to agree");
    const theirs = finishingLoopRun({ finishing: true });
    await finish(theirs.loopRun as never, { summary: "as far as it got", land: "no", victory: "yes" });
    assert.equal(theirs.closes[0]?.victory, false, "a Finish the person asked for claims nothing");
  });

  it("a timed build's finish once its hours are spent closes as its time running out; an idle or asked-for wrap-up does not", async () => {
    const { finish } = await import("../../src/harness-seed/loop/director/integrate.ts");
    const timed = { wallClockMs: 60 * 60_000, completionPolicy: "duration" };
    // A wrap-up brings `softDeadline` to now whatever its cause; the run's own clock keeps its cap.
    const wrappedUp = (cap: number, over: { finishing?: boolean } = {}) => {
      const run = finishingLoopRun(over);
      run.loopRun.run.budgets = timed;
      run.loopRun.softDeadline = Date.now() - 1000;
      run.loopRun.clock = { started: cap - 60 * 60_000, softDeadline: cap, finalDeadline: cap + 15 * 60_000 };
      return run;
    };
    const late = wrappedUp(Date.now() - 60_000);
    await finish(late.loopRun as never, { summary: "where it got to", land: "no" });
    assert.equal(late.closes[0]?.ended, StopWhy.Time, "the wrap-up at the cap: the hours ran out");
    const idle = wrappedUp(Date.now() + 60 * 60_000);
    await finish(idle.loopRun as never, { summary: "nothing more to do", land: "no" });
    assert.equal(idle.closes.length, 1, "an idle lead's wrap-up closes it");
    assert.equal(idle.closes[0]?.ended, undefined, "with an hour left, not as its time running out");
    const asked = wrappedUp(Date.now() + 60 * 60_000, { finishing: true });
    await finish(asked.loopRun as never, { summary: "as far as it got", land: "no", victory: "no" });
    assert.equal(asked.closes.length, 1, "the person's own finish closes it");
    assert.equal(asked.closes[0]?.ended, undefined, "the person's finish is no time-out");
  });

  it("a finish with no summary closes nothing; a second finish while one is under way is refused at once, and the run closes once", async () => {
    const { finish } = await import("../../src/harness-seed/loop/director/integrate.ts");
    let release = () => {};
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { loopRun, closes } = finishingLoopRun({ hold });
    assert.match(String(await finish(loopRun as never, { summary: " ", land: "no" })), /finish needs a summary/);
    assert.deepEqual(closes, []);
    const first = finish(loopRun as never, { summary: "red", land: "no" });
    assert.match(String(await finish(loopRun as never, { summary: "red", land: "no" })), /already under way/);
    release();
    assert.match(String(await first), /^The Loop is closed/);
    assert.equal(closes.length, 1);
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
});

describe("a Loop's lead through the real core and harness", () => {
  it("starts a worker in its own copy, waits, looks, merges it, asks a second opinion, shows, notes, finishes — and the integration branch lands", async () => {
    const seen: { lead: DelegateRequest[]; workers: DelegateRequest[] } = { lead: [], workers: [] };
    const results: Record<string, any> = {};
    let liveLoadsBefore = 0;
    const { rig, project, runId, events, finished } = await webRun(
      "director-smoke",
      async (request) => {
        if (!request.director) {
          seen.workers.push(request);
          return writes(request, "src/plaza.js", "export const plaza = 'red';\n").then((done) => ({
            ...done,
            summary: "painted the plaza red",
          }));
        }
        seen.lead.push(request);
        const call = liveCall(request);
        results.tools = (request.liveTools ?? []).map((tool) => tool.name);
        results.status0 = JSON.parse(await call("run_status", {}));
        results.shot = await request.onLiveTool!("computer", { action: "screenshot" });
        results.noTask = await call("worker_start", { title: "Plaza" });
        results.started = await call("worker_start", copyWorker("Plaza", "paint the plaza red"));
        results.waited = await call("worker_wait", { id: "w1", seconds: WORKER_WAIT_S });
        results.looked = await request.onLiveTool!("look", { target: "w1" });
        results.integrated = await call("worker_mark", { id: "w1", verdict: "used", note: "the plaza is red" });
        results.judged = await call("judge", { question: "is the plaza red?" });
        results.shown = await call("show", { target: "integration" });
        results.noted = await call("note", { text: "plaza merged and red" });
        results.bad = await call("worker_mark", { id: "nobody", verdict: "used" });
        results.finished = await call("finish", { summary: "the plaza is red", land: "yes", victory: "yes" });
        return result("lead-1", "run done");
      },
      {
        setup: async (rig, game) => {
          // Blender files beside the web game: the lead's identity reads the game's own facts.
          await mkdir(path.join(game.dir, "art"), { recursive: true });
          await writeFile(path.join(game.dir, "art", "tree.blend"), "BLENDER");
          await git(game.dir, ["add", "-A"]);
          await git(game.dir, commitAs("You", "a tree"));
          // The user has the game open in Live: the one load in this test that is theirs.
          await rig.core.loadPreview({ project: game.name });
          liveLoadsBefore = rig.preview.loads.length;
        },
      },
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
      "the lead's screen to close",
    );

    assert.equal(customEvents(events, "run_started").find((e) => e.runId === runId)?.mode, "director");
    assert.equal(customEvents(events, "autopilot_started").find((e) => e.runId === runId)?.director, true);
    assert.equal(seen.lead.length, 1, "one lead session");
    assert.equal(seen.workers.length, 1, `one worker session — worker_start answered ${results.started}`);

    // The lead's identity reads the game as the run found it: its folder and what it holds.
    const lead = seen.lead[0]!;
    const folderLabel = project.dir.split("/").slice(-2).join("/");
    assert.ok(lead.prompt.includes(`the folder \`${folderLabel}\``), "the game's folder");
    assert.match(lead.prompt, /it holds a web game at its root, Blender files in `art\/`/, "the game's facts");
    // It sits in the game folder and builds in the integration worktree it leads.
    const worktree = lead.director!.root;
    assert.equal(await realpath(lead.cwd), await realpath(project.dir), "the lead sits in the game folder");
    assert.ok(worktree.includes(path.join("autopilot", runId, "integration")), worktree);
    assert.notEqual(lead.readOnly, true, "never read-only");
    assert.equal(lead.leadBuilds, worktree, "its box writes the build it leads");
    // A worker works in a copy of its own, in the chat's mode, as the pool's worker w1.
    const worker = seen.workers[0]!;
    assert.equal(worker.worker?.id, "w1");
    assert.equal(worker.worker?.title, "Plaza");
    assert.notEqual(path.resolve(worker.cwd), path.resolve(worktree), "in a copy, not the lead's worktree");
    assert.ok(worker.cwd.includes(path.join("autopilot", runId)), worker.cwd);

    // Tool answers, across the studio → harness dispatch.
    assert.ok(results.status0.time.hardMinutesLeft <= 30, JSON.stringify(results.status0.time));
    assert.equal(results.status0.integration.worktree, worktree);
    assert.deepEqual(results.status0.workers, []);
    assert.ok(
      typeof results.shot !== "string" && results.shot.images?.length === 1,
      "the lead's screenshot is a picture",
    );
    assert.match(results.noTask, /^Not started: give the worker a title and a task/);
    assert.match(results.started, /^Started w1 \(copy\)/);
    assert.match(results.waited, /w1 · Plaza · copy · done/, results.waited);
    assert.match(text(results.looked), /the window now shows w1/, text(results.looked));
    assert.ok(
      typeof results.looked !== "string" && results.looked.images?.length === 1,
      "look answers with a screenshot",
    );
    assert.match(
      results.integrated,
      /^Merged w1's work into your folder\. Health check: the page loads, throws no uncaught error and its frame is not blank\./,
      results.integrated,
    );
    assert.match(results.judged, new RegExp(`Second opinion: ${SECOND_OPINION}`), results.judged);
    assert.match(results.shown, /Live's Reload now offers integration/);
    assert.equal(results.noted, "noted");
    assert.match(results.bad, /^No worker nobody/);
    assert.match(
      results.finished,
      /^The Loop is closed — the integrated build [0-9a-f]{10} is live in the game folder/,
    );

    // The worker's records: its start with the lead's task, its end, and the lead's verdict.
    const workerRecords = (type: string) => customEvents(events, type).filter((e) => e.runId === runId);
    const [start, ...moreStarts] = workerRecords("worker_started");
    assert.deepEqual(moreStarts, []);
    assert.equal(start?.title, "Plaza");
    assert.equal(start?.isolation, "copy");
    assert.equal(start?.task, "paint the plaza red");
    const ends = workerRecords("worker_finished");
    assert.deepEqual(
      ends.map((end) => [end.state ?? null, end.verdict ?? null]),
      [
        ["done", null],
        [null, "used"],
      ],
      JSON.stringify(ends),
    );
    assert.equal(ends[1]?.merged, true, "the verdict says it was merged");
    const health = customEvents(events, "integration_health").filter((e) => e.runId === runId);
    assert.ok(health.length >= 1 && health.every((check) => check.ok === true), JSON.stringify(health));
    assert.equal(customEvents(events, "director_show").find((e) => e.runId === runId)?.target, "integration");
    const decisions = customEvents(events, "autopilot_decision")
      .filter((e) => e.runId === runId)
      .map((e) => String(e.decision));
    assert.ok(decisions.includes("lead: plaza merged and red"), decisions.join(" | "));
    assert.equal(finished.mode, "director");
    assert.equal(finished.landed, true);
    assert.equal(finished.victory, true);
    assert.equal(finished.summary, "the plaza is red");
    // Flipped (Loop phase 5): the close names the lead.
    assert.equal(finished.stoppedBecause, "the lead finished the run");
    const landing = finished.landingResult as { ok: boolean; how: string; verified: boolean; line: string };
    assert.deepEqual(
      [landing.ok, landing.how, landing.verified, landing.line],
      [true, "fresh-health-pass", false, "made live; it loads and shows a picture"],
    );

    // The integration branch landed in the live folder; the worktrees are gone.
    assert.equal(await readFile(path.join(project.dir, "src", "plaza.js"), "utf8"), "export const plaza = 'red';\n");
    const subjects = await git(project.dir, ["log", "--format=%s", "-5"]);
    assert.match(subjects, /integrated build/);
    assert.match(subjects, /worker w1: Plaza/);
    await assert.rejects(stat(worker.cwd), "the worker's copy is removed");
    await assert.rejects(stat(worktree), "the integration worktree is removed");
    // Live keeps what the user opened: the show and the landing each wait on its Reload.
    assert.equal(rig.preview.loads.length, liveLoadsBefore, "nothing the run did loaded the user's Live");
    const behind = rig.events
      .filter((e) => e.type === "live.behind")
      .map((e) => (e.payload as { reason: string | null }).reason);
    assert.ok(behind.includes("build"), `the show waits for Reload: ${JSON.stringify(behind)}`);
    assert.equal(behind.at(-1), "changed", `the landing waits for Reload: ${JSON.stringify(behind)}`);
    const screens = rig.events
      .filter((e) => e.type === "preview.screen")
      .map((e) => e.payload as { role: string; state: string; label: string });
    assert.ok(
      screens.some((s) => s.role === "director" && s.state === "opened"),
      JSON.stringify(screens),
    );

    // The whole run, pinned: the tools a web lead is offered, the run's event types in the order
    // they first appear, and the Builds graph's node kinds. Later phases flip these by name.
    assert.deepEqual([...results.tools].sort(), PINNED_LEAD_TOOLS, "the web lead's tools");
    // `run_learning` is left out: the learning pass appends it after `run_finished`.
    assert.deepEqual(
      runEventTypes(events, runId).filter((type) => type !== "run_learning"),
      PINNED_EVENT_TYPES,
      "the run's event types, in first-appearance order",
    );
    assert.deepEqual(
      buildRunGraph(events)
        ?.nodes.map((node) => node.kind)
        .sort(),
      PINNED_GRAPH_KINDS,
      "the Builds graph's node kinds",
    );
  });

  it("a merge that carries nothing from a repository inside the game fails its health check, and the finish lands nothing that fails it", async () => {
    const results: Record<string, any> = {};
    const { project, runId, events, finished } = await webRun(
      "director-nested",
      async (request) => {
        if (!request.director) {
          await writes(request, "src/plaza.js", "export const plaza = 'red';\n");
          // …and a change inside the folder the studio does not version, which no commit will hold.
          await mkdir(path.join(request.cwd, "wreckage"), { recursive: true });
          await writeFile(path.join(request.cwd, "wreckage", "car.js"), "export const car = 'repaired';\n");
          return result("worker-nested", "painted it");
        }
        const call = liveCall(request);
        results.integrated = await mergedWorker(call, "Plaza", "paint the plaza red");
        results.refused = await call("finish", { summary: "the plaza is red", land: "yes" });
        results.finished = await call("finish", { summary: "the plaza is red, kept beside the game", land: "no" });
        return result("lead-nested", "run done");
      },
      { setup: (_rig, game) => nestedRepository(game.dir, { consented: false }) },
    );

    // The merge happened; its health check fails it, and says why.
    assert.match(results.integrated, /^Merged w1's work into your folder\. Health check failed: /, results.integrated);
    assert.match(
      results.integrated,
      /wreckage\/ is the user's own repository and this build carries nothing from inside it/,
    );
    const health = customEvents(events, "integration_health").filter((e) => e.runId === runId);
    assert.ok(health.length >= 1 && health.every((check) => check.ok === false), JSON.stringify(health));
    // Flipped (Loop phase 5): a build that fails its health check is not made live: finish says so
    // and the lead closes it unlanded (it used to land as an ordinary merge).
    assert.match(results.refused, /^Not finished: the build fails its health check/, results.refused);
    assert.match(results.finished, /^The Loop is closed — not landed: land=no/, results.finished);
    assert.equal(finished.landed, false);
    await assert.rejects(readFile(path.join(project.dir, "src", "plaza.js"), "utf8"), "nothing was made live");
  });

  /**
   * The same folder, with the consent the Open Game sheet records: the fork versions that
   * repository, so an edit inside it is committed, merged and healthy like any other. What the run
   * still may not do is add it to the *user's* history — that renames their own `.git` aside, and
   * belongs to their own button (`landBuild`), not to a merge at 4 a.m.
   */
  it("versions a consented repository inside the game, and leaves the landing of it to the user", async () => {
    const results: Record<string, any> = {};
    const { rig, project, runId, events, finished } = await webRun(
      "director-consented",
      async (request) => {
        if (!request.director) {
          await writeFile(path.join(request.cwd, "wreckage", "car.js"), "export const car = 'repaired';\n");
          return result("worker-consented", "repaired it");
        }
        const call = liveCall(request);
        results.integrated = await mergedWorker(call, "Car", "repair the car");
        results.finished = await call("finish", { summary: "the car is repaired", land: "yes" });
        return result("lead-consented", "run done");
      },
      { setup: (_rig, game) => nestedRepository(game.dir, { consented: true }), goal: "repair the car" },
    );

    // The edit inside the folder is ordinary versioned work: merged, and healthy.
    assert.match(results.integrated, /^Merged w1's work into your folder\. Health check: the page loads/);
    const api = rig.core.api() as unknown as Record<string, (p: unknown) => Promise<unknown>>;
    const carried = (await api["run.exec"]!({
      command: `git show ${String(finished.integrationHead)}:wreckage/car.js`,
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
    assert.equal(finished.landed, false);
    assert.equal((finished.landingResult as { why: string }).why, "nested-not-versioned");
    const close = customEvents(events, "director_verdict")
      .filter((e) => e.runId === runId)
      .find((e) => e.pass === "close");
    assert.match(
      String(close?.because),
      /^Nothing was made live: part of this game keeps its own version history/,
      String(close?.because),
    );
    assert.equal(
      await readFile(path.join(project.dir, "wreckage", "car.js"), "utf8"),
      "export const car = 'wreck';\n",
      "the user's own folder is untouched",
    );
  });

  it("a session limit ends the lead: the head is kept on a ref, nothing is landed, and the run pauses — then the user can play or land any build", async () => {
    const results: Record<string, any> = {};
    const { rig, project, runId, events, finished } = await webRun(
      "director-limit",
      async (request) => {
        if (!request.director) return writes(request, "src/sign.js", "export const sign = 'open';\n");
        const call = liveCall(request);
        results.integrated = await mergedWorker(call, "Sign", "hang a sign");
        results.judged = await call("judge", { question: "is the sign up?" });
        results.status1 = JSON.parse(await call("run_status", {}));
        // The engine's own limit, as the CLI reports it: a rate limit that resets hours away.
        throw new EngineError(
          "rate_limit",
          "codex",
          "You've hit your session limit · resets 9:50pm (Europe/Belgrade)",
          4 * 3_600_000,
        );
      },
      { goal: "a sign" },
    );

    assert.match(results.integrated, /^Merged w1's work into your folder/, results.integrated);
    assert.match(results.judged, /Second opinion: /, results.judged);
    assert.match(results.status1.integration.ref, new RegExp(`refs/studio/runs/${runId}/integration`));
    assert.equal(results.status1.integration.lastHealthCheck, true, JSON.stringify(results.status1.integration));
    const head: string = results.status1.integration.head;

    // The close: the limit named honestly, the run paused for Resume — and nothing landed.
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
    await assert.rejects(
      readFile(path.join(project.dir, "src", "sign.js"), "utf8"),
      "the game folder is as the user left it until the run resumes",
    );

    // The ref outlives the worktree: the head is reachable in the game's repo.
    assert.match(await git(project.dir, ["show-ref", `refs/studio/runs/${runId}/integration`]), new RegExp(`^${head}`));

    // After the run, the user plays a build from a copy and lands it — the same calls the chat's tools and the buttons make.
    const loadsBefore = rig.preview.loads.length;
    const [shown, repeated] = await Promise.all([
      rig.core.showBuild(project.name, head),
      rig.core.showBuild(project.name, head),
    ]);
    assert.deepEqual(repeated, shown, "overlapping Play requests share one scratch creation");
    assert.equal(rig.preview.loads.length, loadsBefore + 1, "one navigation for identical concurrent requests");
    assert.ok(shown.commit.startsWith(head));
    assert.ok(shown.dir.includes(path.join("show", project.name)));
    assert.equal(await readFile(path.join(shown.dir, "src", "sign.js"), "utf8"), "export const sign = 'open';\n");
    const landed = await rig.core.landBuild(project.name, head);
    assert.notEqual(landed.how, "already", "the paused close had landed nothing; the user's Make it live does");
    assert.equal(await readFile(path.join(project.dir, "src", "sign.js"), "utf8"), "export const sign = 'open';\n");
    await assert.rejects(rig.core.showBuild(project.name, "deadbeef"), /not in/);
    await assert.rejects(rig.core.landBuild(project.name, "nonsense"), /not a commit hash/);
  });

  it("a worker the lead stops keeps its work so far, and worker_mark used merges it", async () => {
    const results: Record<string, any> = {};
    let building = false;
    const { project, runId, events, finished } = await webRun("director-stop", async (request) => {
      if (!request.director) {
        await writes(request, "src/plaza.js", "export const plaza = 'half red';\n");
        building = true;
        return untilStopped(request, "worker-stop", "half a plaza");
      }
      const call = liveCall(request);
      results.started = await call("worker_start", copyWorker("Plaza", "paint the plaza red"));
      // Wait until the worker is mid-edit: a stop before it wrote anything would prove nothing.
      for (let i = 0; i < 60 && !building; i++) await call("worker_wait", { id: "w1", seconds: "1" });
      results.building = building;
      results.stopped = await call("worker_stop", { id: "w1", why: "the lead finishes it itself" });
      results.waited = await call("worker_wait", { id: "w1", seconds: WORKER_WAIT_S });
      results.integrated = await call("worker_mark", { id: "w1", verdict: "used" });
      results.finished = await call("finish", { summary: "the plaza is half red", land: "yes" });
      return result("lead-stop", "run done");
    });

    assert.equal(results.building, true, "the worker was mid-edit when it was stopped");
    assert.match(results.stopped, /^Stopped w1\. A copy's work so far is kept for worker_mark\./, results.stopped);
    assert.match(results.waited, /w1 · Plaza · copy · stopped/, results.waited);
    assert.match(results.integrated, /^Merged w1's work into your folder/, results.integrated);
    const ended = customEvents(events, "worker_finished").filter((e) => e.runId === runId)[0];
    assert.equal(ended?.state, "stopped", JSON.stringify(ended));
    assert.equal(finished.landed, true, String(finished.stoppedBecause));
    assert.equal(
      await readFile(path.join(project.dir, "src", "plaza.js"), "utf8"),
      "export const plaza = 'half red';\n",
      "what it wrote before the stop is live",
    );
  });

  it("worker_steer reaches a worker mid-turn: its turn is cut short and resumed in the same session with the words", async () => {
    const results: Record<string, any> = {};
    const turns: Array<{ prompt: string; resume: string | null }> = [];
    const SESSION = "plaza-session";
    const { project, finished } = await webRun("director-steer", async (request) => {
      if (!request.director) {
        turns.push({ prompt: request.prompt, resume: request.resume ?? null });
        if (request.resume === SESSION) {
          await writes(request, "src/plaza.js", "export const plaza = 'green';\n");
          return result(SESSION, "took it greener");
        }
        await writes(request, "src/plaza.js", "export const plaza = 'orange';\n");
        return untilStopped(request, SESSION, "an orange plaza");
      }
      const call = liveCall(request);
      await call("worker_start", copyWorker("Plaza", "paint the plaza"));
      for (let i = 0; i < 60 && turns.length < 1; i++) await call("worker_wait", { id: "w1", seconds: "1" });
      results.steered = await call("worker_steer", { id: "w1", text: "the plaza is far too orange — take it greener" });
      results.waited = await call("worker_wait", { id: "w1", seconds: WORKER_WAIT_S });
      results.integrated = await call("worker_mark", { id: "w1", verdict: "used" });
      results.finished = await call("finish", { summary: "the plaza is green", land: "yes" });
      return result("lead-steer", "run done");
    });

    assert.match(results.steered, /^w1 reads this now\./, results.steered);
    assert.equal(turns.length, 2, JSON.stringify(turns.map((turn) => turn.resume)));
    assert.equal(turns[1]?.resume, SESSION, "the same session goes on");
    assert.match(String(turns[1]?.prompt), /take it greener/, "with the lead's words");
    assert.match(results.waited, /w1 · Plaza · copy · done/, results.waited);
    assert.equal(finished.landed, true, String(finished.stoppedBecause));
    assert.equal(await readFile(path.join(project.dir, "src", "plaza.js"), "utf8"), "export const plaza = 'green';\n");
  });

  it("a commit the lead makes with its own hands becomes the head that is checked, closed and landed", async () => {
    const results: Record<string, any> = {};
    const { project, runId, events, finished } = await webRun("director-head", async (request) => {
      if (!request.director) return writes(request, "src/sign.js", "export const sign = 'open';\n");
      const call = liveCall(request);
      results.integrated = await mergedWorker(call, "Sign", "hang a sign");
      // What the lead does for itself: a fix quicker to make than to hand out, committed.
      const root = request.director.root;
      await writeFile(path.join(root, "src", "haze.js"), "export const haze = 0.38;\n");
      await git(root, ["add", "-A"]);
      await git(root, commitAs("Lead", "lead: haze peak 0.62 to 0.38"));
      results.ownCommit = await git(root, ["rev-parse", "HEAD"]);
      results.status = JSON.parse(await call("run_status", {}));
      results.finished = await call("finish", { summary: "the sign is up and the haze is lighter", land: "yes" });
      return result("lead-head", "fixed the haze");
    });

    const head: string = results.ownCommit;
    assert.equal(results.status.integration.head, head.slice(0, 10), "the next tool call sees what the lead committed");
    assert.equal(finished.landed, true, String(finished.stoppedBecause));
    assert.equal(finished.integrationHead, head, "the close landed the head it checked, not the last merge");
    const checked = customEvents(events, "integration_health").filter((e) => e.runId === runId);
    assert.ok(
      checked.some((check) => check.head === head && check.ok === true),
      `the finish checked the lead's commit: ${JSON.stringify(checked)}`,
    );
    // Both files are live: the worker's merge and the lead's own commit on top of it.
    assert.equal(await readFile(path.join(project.dir, "src", "haze.js"), "utf8"), "export const haze = 0.38;\n");
    assert.equal(await readFile(path.join(project.dir, "src", "sign.js"), "utf8"), "export const sign = 'open';\n");
    const landing = finished.landingResult as { verified: boolean; how: string };
    assert.equal(landing.verified, false, "a health check is not a judge's preference");
    assert.equal(landing.how, "fresh-health-pass");
  });

  /**
   * The user's own evening, in the folder the run was going to land in. A conflict is an answer:
   * nothing is forced, the build waits on its ref, and the close says why in words the user reads.
   */
  it("a landing that conflicts with the user's own commits lands nothing and leaves their branch exactly as it was", async () => {
    const results: Record<string, any> = {};
    const { project, runId, finished } = await webRun("director-conflict", async (request) => {
      if (!request.director) return writes(request, "src/sign.js", "export const sign = 'open';\n");
      const call = liveCall(request);
      results.integrated = await mergedWorker(call, "Sign", "hang a sign");
      // The user's evening: they wrote the same file, in their own folder, under their own name.
      const gameDir = request.cwd;
      await mkdir(path.join(gameDir, "src"), { recursive: true });
      await writeFile(path.join(gameDir, "src", "sign.js"), "export const sign = 'closed for repairs';\n");
      await git(gameDir, ["add", "-A"]);
      await git(gameDir, commitAs("Simeon", "mine: the sign says closed"));
      results.userHead = await git(gameDir, ["rev-parse", "HEAD"]);
      results.finished = await call("finish", { summary: "the sign is up", land: "yes" });
      return result("lead-conflict", "hung the sign");
    });

    assert.equal(finished.landed, false, String(finished.stoppedBecause));
    const landing = finished.landingResult as { ok: boolean; line: string };
    assert.equal(landing.ok, false);
    assert.equal(landing.line, "nothing was made live");
    // The lead is told what happened in git's own terms; the user gets the close verdict's
    // sentence, which never mentions a merge.
    assert.match(
      results.finished,
      /not landed: merge into the live folder conflicted with changes of your own/,
      results.finished,
    );
    const close = (finished.verdicts as Array<{ pass: string; because: string }>).find((v) => v.pass === "close");
    assert.equal(
      close?.because,
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
    // And the build is not lost: it is on the run's ref, for "Make it live" once the folder is theirs.
    const onRef = await git(project.dir, ["rev-parse", `refs/studio/runs/${runId}/integration`]);
    assert.equal(onRef, finished.integrationHead, "the integrated build is still reachable");
    assert.match(await git(project.dir, ["show", `${onRef}:src/sign.js`]), /open/);
  });

  it("a worker's commit outlives its copy: a worker the lead never merged is kept on the run's ref, and the user can still play it", async () => {
    const results: Record<string, any> = {};
    const { rig, project, runId, finished } = await webRun("director-keep", async (request) => {
      if (!request.director) return writes(request, "src/bench.js", "export const bench = 'oak';\n");
      const call = liveCall(request);
      results.started = await call("worker_start", copyWorker("Bench", "put an oak bench in the plaza"));
      results.waited = await call("worker_wait", { id: "w1", seconds: WORKER_WAIT_S });
      // The bench is never merged — the lead does not think it is ready — and the run ends.
      results.finished = await call("finish", { summary: "the bench is not right yet", land: "no" });
      return result("lead-keep", "left the bench where it is");
    });

    assert.match(results.waited, /w1 · Bench · copy · done/, results.waited);
    assert.equal(finished.landed, false, "nothing was merged or landed");
    // Flipped (Loop phase 5): the pool keeps a copy's work on the run's `pool/<id>` ref, not `workers/<id>`.
    const ref = `refs/studio/runs/${runId}/pool/w1`;
    assert.match(await git(project.dir, ["show", `${ref}:src/bench.js`]), /bench = 'oak'/);
    const commit = await git(project.dir, ["rev-parse", ref]);
    // Which is what "Play this build" needs in the morning.
    const copy = await rig.core.showBuild(project.name, commit);
    assert.equal(await readFile(path.join(copy.dir, "src", "bench.js"), "utf8"), "export const bench = 'oak';\n");
  });

  it("with no window free: the merge's health check and the second opinion say so, the finish lands nothing it could not check, and the user's Live is never touched", async () => {
    const results: Record<string, any> = {};
    const shown: Array<{ project: string; root: string | null }> = [];
    const { rig, project, finished } = await webRun(
      "director-borrow",
      async (request) => {
        if (!request.director) return writes(request, "src/sign.js", "export const sign = 'lit';\n");
        const call = liveCall(request);
        results.status = JSON.parse(await call("run_status", {}));
        results.integrated = await mergedWorker(call, "Sign", "light the sign");
        results.judged = await call("judge", { question: "does the sign light up?" });
        results.shown = await call("show", { target: "integration" });
        results.finished = await call("finish", { summary: "the sign is lit", land: "yes" });
        return result("lead-borrow", "left it to the close");
      },
      {
        windows: 0,
        setup: async (rig, game) => {
          // Every load of the user's own window, and what it was pointed at.
          const load = rig.preview.load.bind(rig.preview);
          rig.preview.load = async (name: string, entry?: string, root?: string, options?: { loopback?: boolean }) => {
            shown.push({ project: name, root: root ?? null });
            return load(name, entry, root, options);
          };
          // The user opens the game: the one load of their window that is theirs.
          await rig.core.loadPreview({ project: game.name });
        },
      },
    );

    assert.equal(results.status.integration.lastHealthCheck, null, JSON.stringify(results.status.integration));
    assert.match(
      results.integrated,
      /^Merged w1's work into your folder\. Health check failed: no window was free for the health check\./,
      results.integrated,
    );
    assert.match(results.judged, /no window was free for the health check/, results.judged);
    assert.match(results.shown, /Live's Reload now offers integration/);
    // A check that could not be made does not hold the finish; nothing unchecked is made live.
    assert.match(
      results.finished,
      /^The Loop is closed — not landed: the integrated build failed its health check at the close \(no window was free/,
      results.finished,
    );
    assert.equal(finished.landed, false, String(finished.stoppedBecause));
    // The user's window kept what they opened, through the show, the close and the teardown.
    assert.deepEqual(shown, [{ project: project.name, root: null }], JSON.stringify(shown));
    assert.equal(rig.preview.loadRoot, null, "the run did not end with the user's window on a removed worktree");
    await assert.rejects(
      readFile(path.join(project.dir, "src", "sign.js"), "utf8"),
      "the unchecked build is not in the game folder",
    );
  });

  it("a lead that ends its turn with nothing running is never asked what next: the person's Finish closes the run", async () => {
    // Flipped (phase 5 audit): the lead was woken once with "idle_ask" (what next) before the Finish.
    let turns = 0;
    let finishedAnswer = "";
    let finishAsked: (runId: string, threadId: string) => Promise<void> = async () => {};
    const { events } = await webRun(
      "director-idle",
      async (request) => {
        if (!request.director) return result("worker", "nothing");
        turns += 1;
        if (turns === 1) {
          await finishAsked(request.director.runId, request.director.threadId);
          return result("timed-session", "first look");
        }
        assert.equal(request.resume, "timed-session");
        finishedAnswer = await liveCall(request)("finish", {
          summary: "Stopped early at the user's request",
          land: "no",
        });
        return result("timed-session", "Finished as requested");
      },
      {
        setup: async (rig) => {
          // The person's Finish, where the run's inbox reads it: the game's own thread.
          finishAsked = async (runId, threadId) => {
            await rig.core.append(
              [{ type: "custom", event_type: "run_control", payload: { runId, action: "finish" } }],
              threadId,
            );
          };
        },
      },
    );
    assert.equal(turns, 2);
    assert.match(finishedAnswer, /^The Loop is closed/, finishedAnswer);
    const reasons = customEvents(events, "director_continued").flatMap((event) => (event.reasons as string[]) ?? []);
    assert.ok(!reasons.includes("idle_ask"), `the lead was never asked what next: ${reasons.join(", ")}`);
  });
});

/**
 * The run the user quits the app on (or Stops with a message waiting). The next boot closes the
 * run as PAUSED, with the head it reached and the ref that keeps it reachable, so the chat can offer
 * the build; and the resumed run, led by the same chat, lands what the first one merged.
 */
describe("a Loop interrupted and resumed", () => {
  for (const interruption of ["restart", "stop-queue"] as const)
    it(
      interruption === "restart"
        ? "a run the app died inside pauses with its head, and the resumed run lands what it merged"
        : "Stop interrupts a live lead and its queued instruction resumes the run with the same integration head",
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
        // waiting on. This rig outlives its harness, so the lead's session is released by hand at
        // the same moment the child is killed.
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
              ["start_autopilot", "resume_run"],
            );
            return {
              ...result("chat-after-pause", "Continuing the saved work."),
              studioToolCalls: [{ name: "resume_run", args: { text: "Keep going and land the saved sign" } }],
            };
          }
          if (request.director) {
            prompts.push(request.prompt);
            const call = liveCall(request);
            if (++sessions === 1) {
              results.integrated = await mergedWorker(call, "Sign", "hang a sign");
              results.head = JSON.parse(await call("run_status", {})).integration.head;
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
            results.status2 = JSON.parse(await call("run_status", {}));
            results.finished2 = await call("finish", { summary: "landing what last run merged", land: "yes" });
            return result("lead-resumed", "landed the run's work");
          }
          return writes(request, "src/sign.js", "export const sign = 'open';\n");
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
        await waitForLog(rig.core, () => Boolean(results.head), 120_000, "the first session's merge");
        const head: string = results.head;
        const threadId = await rig.core.threadForGame(project.name);

        if (interruption === "restart") {
          // Cmd+Q at 2am: the harness dies mid-run, the lead's session with it.
          await rig.core.host.stop();
          quit();
          await new Promise((resolve) => setTimeout(resolve, 500));
          await rig.core.start();
        } else {
          await rig.core.sendUserMessage("Keep going and land the saved sign", { thread: threadId, engine: "codex" });
          assert.equal(sessions, 1, "no second session answers a follow-up while the first lead is building");
          const sent = await rig.core.store.listEvents(threadId);
          assert.equal(customEvents(sent, "coordinator_message_queued").length, 1);
          // Live chat: handed to the lead, whose first turn cannot be cut short to read it.
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
        assert.ok(String(closure.integrationHead).startsWith(head), `${String(closure.integrationHead)} ≠ ${head}`);
        assert.equal(closure.integrationRef, `refs/studio/runs/${runId}/integration`);
        assert.notEqual(closure.integrationHead, closure.baseCommit, "the outcome card has a build to offer");
        if (interruption === "restart") {
          assert.equal(
            ((await rig.core.store.readArtifact(threadId, `autopilot_${runId}`)) as { phase?: string }).phase,
            "paused",
          );
          // An ordinary message resumes the saved run; no Resume button or fresh start.
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
          "new guidance is saved before the run resumes",
        );
        // Flipped (Loop phase 5): the resumed brief says THE RUN RESUMES, no YOU WERE RESUMED.
        assert.match(prompts[1]!, /THE RUN RESUMES/);
        assert.match(
          prompts[1]!,
          /THE USER SAYS[^\n]*\n- Keep going and land the saved sign/,
          "the resumed lead is told the instruction the chat resumed it with",
        );
        assert.match(prompts[1]!, /2 commits beyond the starting point/, "the worker's commit and its merge");
        assert.match(
          results.finished2,
          /^The Loop is closed — the integrated build [0-9a-f]{10} is live/,
          results.finished2,
        );
        const landed = customEvents(after, "run_finished")
          .filter((e) => e.runId === runId)
          .at(-1)!;
        assert.equal(landed.landed, true, String(landed.stoppedBecause));
        assert.ok(String(landed.integrationHead).startsWith(head), "it landed the head the first session left");
        assert.notEqual(landed.integrationHead, landed.baseCommit, "the base is the run's own starting point");
        assert.equal(
          await readFile(path.join(project.dir, "src", "sign.js"), "utf8"),
          "export const sign = 'open';\n",
          "the first session's merge is live",
        );
        const landing = landed.landingResult as { verified: boolean; how: string };
        assert.equal(landing.verified, false);
        assert.equal(landing.how, "fresh-health-pass", "the close took its own look at the head it landed");
      },
    );
});
