/**
 * The art director (loop/ship-review.ts, director/art-direction.ts), without a rig: one absolute
 * look at the whole game — every camera it registered, its eyes, its demos' end frames and its
 * motion — asked "would you ship this as the user's demo today?", with each defect typed to the
 * plan part that owns it. The lead can ask for it (`judge ship=yes`); the studio runs it itself at
 * the finish mark of a timed build, and once for a goal build whose lead idles or finishes with no
 * review on its head. Its defects go to their owners' boards as the director's own checks. It is
 * reported, never a landing veto. Every clock here is a number the test chooses, and the judge is
 * a host that answers what the row needs.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { HostMethod } from "../../src/harness-seed/loop/host-methods.ts";
import { blindCompare, tasteVeto } from "../../src/harness-seed/loop/judge.ts";
import { renderBrief } from "../../src/harness-seed/loop/library.ts";
import { createGoals, GoalStatus } from "../../src/harness-seed/loop/director/goals.ts";
import { createScope } from "../../src/harness-seed/loop/scope.ts";
import { CheckOrigin, CheckWeight } from "../../src/harness-seed/loop/spec.ts";
import { strongFlips } from "../../src/harness-seed/loop/facet/rules.ts";
import { FacetStage, finishDone } from "../../src/harness-seed/loop/facet/stage.ts";
import { summarizeScoreboard } from "../../src/harness-seed/loop/checks.ts";
import { hudBudgetFor } from "../../src/harness-seed/loop/hud-budget.ts";
import {
  DefectSeverity,
  readShipReview,
  SHIP_REVIEW_IMAGES,
  SHIP_VIEW,
  shipReview,
} from "../../src/harness-seed/loop/ship-review.ts";
import * as loopRunFunctions from "../../src/harness-seed/loop/director/loop-run.ts";
import * as toolFunctions from "../../src/harness-seed/loop/director/tools.ts";
import * as workerFunctions from "../../src/harness-seed/loop/director/workers.ts";
import * as integrateFunctions from "../../src/harness-seed/loop/director/integrate.ts";
import * as artDirectionFunctions from "../../src/harness-seed/loop/director/art-direction.ts";
import {
  ART_DIRECTION_JUDGE_MS,
  SHIP_LOOK_EVERY_MS,
  shipDefectsToChecks,
} from "../../src/harness-seed/loop/director/art-direction.ts";
import { SHIP_QUESTION, shipFinishLine } from "../../src/harness-seed/loop/director/art-direction-prompts.ts";
import { finishMarkMs } from "../../src/harness-seed/loop/director/budgets.ts";
import { priorWorkersStatus, restoreLoopRun } from "../../src/harness-seed/loop/director/journal.ts";
import { runWakeLoop, type DirectorTalk, type WakeClock } from "../../src/harness-seed/loop/director/wake.ts";
import { WakeCause } from "../../src/harness-seed/loop/director/wake-schedule.ts";
import { HOUR_MS, MINUTE_MS } from "../../src/harness-seed/loop/time.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

const T0 = Date.UTC(2026, 9, 6, 1, 0, 0);
const FORK = "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f";
const HEAD = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
/** The integration head after a later wave. */
const HEAD2 = "b2c3d4e5f60718293a4b5c6d7e8f9012345678a1";
const BRIEF = () => "You are the DIRECTOR of run run_ad";

/** The plan's parts, as `plan` keeps them. */
const PARTS = [
  { id: "hud", title: "The race HUD", seam: "the screen", owns: ["src/hud.js"] },
  { id: "track", title: "The track", seam: "the road", owns: ["src/track.js"] },
];

/** A frame with pixels. */
const shot = (camera: string) => ({ camera, path: `/frames/${camera}.jpg`, base64: `px-${camera}` });

/** A whole game's evidence: registered cameras, the player's eyes, a demo's end, the user's view and motion. */
function gameEvidence(cameras: readonly string[] = ["default", "chase", "side", "top", "finish", "pit"]) {
  return {
    ok: true,
    problems: [],
    warnings: [],
    consoleErrors: [],
    shots: [
      ...cameras.map(shot),
      shot("eye:spawn"),
      shot("eye:here"),
      shot("eye:down"),
      shot("demo:lap"),
      shot("user:view"),
    ],
    motion: Array.from({ length: 6 }, (_, i) => ({ base64: `motion-${i + 1}` })),
    state: { speed: 41, lap: 2 },
    registeredCameras: [...cameras],
  };
}

/** The art director's answer: a blocker in the HUD, a visible fault in the track, a nit nobody owns. */
const SHIP_NO = {
  ship: false,
  defects: [
    { what: "the speed digits are cut off at the right edge", camera: "default", part: "hud", severity: "blocker" },
    { what: "the road texture swims as the car moves", camera: "chase", part: "track", severity: "visible" },
    { what: "one stray pixel above the sky", camera: "top", part: null, severity: "nit" },
  ],
  strengths: ["the dusk light"],
  reason: "the HUD is broken at a glance",
};

/** The seed's own folder, as a workspace laid down from it reads it. */
const SEED = path.resolve(import.meta.dirname, "../../src/harness-seed");

/** A blind pick over the start the lead already won on HEAD. */
const LEAD_PICK = {
  head: HEAD,
  ok: true,
  against: "start",
  pick: "challenger",
  answer: null,
  boardAllPass: null,
  at: T0,
};

/** What the fake host saw: every call, and each journal as it was written. */
interface FakeHost {
  calls: Array<{ method: string; params: Record<string, any> }>;
  journals: Array<Record<string, any>>;
}
const fakeHost = (): FakeHost => ({ calls: [], journals: [] });

/** The judge's reply, as the engine would give it. */
const replying = (reply: unknown) => () => ({
  message: { content: typeof reply === "string" ? reply : JSON.stringify(reply) },
  model: "judge-model",
});

/** A loop worker building its part, with a board the router can add to. */
function loopWorker(id: string, over: Record<string, unknown> = {}) {
  let settle = () => {};
  return {
    id,
    title: id,
    mode: "loop",
    brief: `Build ${id}`,
    owns: [`src/${id}.js`],
    ownsMain: false,
    cameras: ["default"],
    identity: [],
    setup: null,
    from: FORK,
    replaces: null,
    baseConsole: [],
    worktree: `/runs/run_ad/${id}`,
    handle: null,
    threadId: `t-${id}`,
    startedAt: T0,
    endedAt: null,
    deadline: T0 + 4 * HOUR_MS,
    state: "running",
    stopRequested: false,
    stopWhy: null,
    iterationsCap: undefined,
    steering: [] as string[],
    iterations: [],
    roundMs: [],
    lastIterationAt: null,
    monitor: null,
    result: null,
    lastCommit: null,
    summary: "",
    error: null,
    spec: { id, title: id, intent: "", brief: "", checks: [] as Array<Record<string, unknown>>, cameras: ["default"] },
    problems: [],
    unsatisfiable: [],
    stateKeys: null,
    notVerified: null,
    rarelyMeasurable: [],
    policy: {},
    policyOverrides: {},
    loop: null,
    settled: false,
    settle: new Promise<void>((resolve) => {
      settle = resolve;
    }),
    resolveSettle: () => settle(),
    ...over,
  };
}

/**
 * A run as prepareLoopRun leaves it — its data plain, its parts the real ones, bound the way
 * `bindLoopRun` binds them — on a host that records what it is asked. Its looks are the given
 * evidence (`seen` keeps what each look was asked), on a window it is always lent.
 */
function fakeLoopRun(
  host: FakeHost,
  {
    over = {},
    answers = {},
    evidence = gameEvidence(),
    budgets = { wallClockMs: 5 * HOUR_MS, completionPolicy: "duration" },
    clock = { started: T0, softDeadline: T0 + 4 * HOUR_MS, finalDeadline: T0 + 4 * HOUR_MS + 15 * MINUTE_MS },
  }: {
    over?: Record<string, unknown>;
    answers?: Record<string, unknown>;
    evidence?: Record<string, unknown>;
    budgets?: Record<string, unknown>;
    clock?: { started: number; softDeadline: number; finalDeadline: number };
  } = {},
) {
  const run = {
    runId: "run_ad",
    project: "derby",
    goal: "a night race around the plaza",
    engine: "codex",
    reference: { name: "Night race", shots: [] },
    budgets,
  };
  const ctx = {
    threadId: "t1",
    cancelled: false,
    workspace: "/nowhere",
    setStatus: () => {},
    notify: () => {},
    call: async (method: string, params: Record<string, any>) => {
      host.calls.push({ method, params });
      if (method === HostMethod.ArtifactWrite) host.journals.push(structuredClone(params.value));
      if (method === HostMethod.PreviewScreens) return [];
      const answer = answers[method];
      return typeof answer === "function" ? answer(params) : (answer ?? null);
    },
  };
  const data = {
    ctx,
    threadId: "t1",
    run,
    resume: false,
    inbox: {
      steering: async () => [],
      finishing: async () => false,
      addressed: async () => [],
      backlog: async () => [],
    },
    started: clock.started,
    softDeadline: clock.softDeadline,
    finalDeadline: clock.finalDeadline,
    clock: { ...clock },
    priorJournal: null,
    report: { notes: [], workers: {}, iterations: [], verdicts: [] },
    integrationWorktree: "/runs/run_ad/integration",
    integrationRef: "refs/studio/runs/run_ad/integration",
    baseCommit: FORK,
    projectDir: "/games/derby",
    state: {
      run,
      workers: new Map(),
      ledger: [] as Array<Record<string, unknown>>,
      log: [] as Array<Record<string, unknown>>,
      plan: { summary: "A night race.", workers: PARTS } as Record<string, unknown> | null,
      planReviewUntil: null as number | null,
      planGo: true,
      planSaidFrom: 0,
      integrationHead: HEAD,
      integrationHealthy: true as boolean | null,
      workerLimit: null as Record<string, unknown> | null,
      limit: null,
      lastJudge: null,
      finish: null,
      finished: false,
      monitor: null as Promise<unknown> | null,
      fromScratch: false,
      startEvidence: null as Record<string, unknown> | null,
      healthByHead: new Map<string, boolean>([[HEAD, true]]),
      consoleByHead: new Map<string, string[]>(),
      evidenceByHead: new Map(),
      baseHeads: new Set<string>([FORK]),
      facetSpecs: [],
      judges: 0,
      plays: 0,
      softDeadline: clock.softDeadline,
      finalDeadline: clock.finalDeadline,
    },
    journal: { runId: "run_ad", run, director: { sessionId: null, workers: {}, notes: [] }, plan: {} },
    logSeq: 0,
    waitSeq: 0,
    runLedger: [],
    priorLedger: [],
    ledgerWrites: Promise.resolve(),
    ...over,
  };
  const loopRun = loopRunFunctions.bindLoopRun(data as never, [
    loopRunFunctions,
    workerFunctions,
    toolFunctions,
    integrateFunctions,
    artDirectionFunctions,
  ]) as any;
  const seen: Array<Record<string, any>> = [];
  loopRun.withLease = async (_label: string, fn: (handle: string | null) => Promise<unknown>) => fn("h1");
  loopRun.patientEvidence = async (root: string, options: Record<string, any>) => {
    seen.push({ root, ...options });
    return structuredClone(evidence);
  };
  return { loopRun, seen };
}

/** Is this judge call the art director's: it is shown the motion strip, which no other judge here is. */
const isShipCall = (params: Record<string, any>): boolean =>
  (params.messages?.[0]?.images ?? []).some((image: { label: string }) => image.label.startsWith("MOTION"));

/** A judge that answers the art director with `ship` and any vision question with a sure yes. */
const shipAndQuestion =
  (ship: unknown = SHIP_NO) =>
  (params: Record<string, any>) =>
    replying(isShipCall(params) ? ship : { answer: "yes", confidence: 0.9, note: "a race at dusk" })();

/** The judge calls the art director made. */
const shipCalls = (host: FakeHost) =>
  host.calls.filter((c) => c.method === HostMethod.EngineComplete && isShipCall(c.params));

/** The labels of the images the judge was shown, call by call. */
const imageLabels = (host: FakeHost): string[][] =>
  host.calls
    .filter((c) => c.method === HostMethod.EngineComplete)
    .map((c) => (c.params.messages?.[0]?.images ?? []).map((image: { label: string }) => image.label));

/** The loop's clock, moved by its own sleeps; `onSleep` runs after each. */
function fakeClock(start: number, onSleep: (now: number) => void = () => {}): WakeClock & { at: number } {
  const clock = {
    at: start,
    now: () => clock.at,
    sleep: async (ms: number) => {
      clock.at += ms;
      onSleep(clock.at);
    },
  };
  return clock;
}

/** The lead's session: each turn answered by `script`, every prompt kept. */
function lead(script: (turn: number) => Record<string, unknown>) {
  const turns: Array<{ prompt: string }> = [];
  const talk: DirectorTalk = {
    sessionId: "lead-1",
    keep: async () => {},
    session: async (prompt) => {
      turns.push({ prompt });
      return script(turns.length);
    },
  };
  return { talk, turns };
}

describe("the art director's question (loop/ship-review.ts)", () => {
  it("AD-1. the ship review is shown every camera the build registered and the motion strip, is asked an absolute question with no BUILD B, and keeps a defect's part only when it is one of the plan's parts", async () => {
    const recorder = ctxRecorder({
      handlers: {
        "engine.complete": replying({
          ...SHIP_NO,
          defects: [
            SHIP_NO.defects[0],
            { what: "the radio hisses", camera: "default", part: "radio", severity: "loud" },
          ],
        }),
      },
    });
    const run = {
      runId: "run_ad",
      project: "derby",
      goal: "a night race around the plaza",
      reference: { name: "Night race", shots: [] },
      scope: createScope({ asked: ["a night race around the plaza"], cut: ["online multiplayer"] }),
    };
    const review = await shipReview(recorder.ctx as never, {
      run: run as never,
      evidence: gameEvidence() as never,
      parts: PARTS,
    });

    const request = recorder.paramsOf("engine.complete")[0] as Record<string, any>;
    const labels: string[] = request.messages[0].images.map((image: { label: string }) => image.label);
    for (const camera of [
      "default",
      "chase",
      "side",
      "top",
      "finish",
      "pit",
      "eye:spawn",
      "eye:here",
      "eye:down",
      "demo:lap",
    ])
      assert.ok(
        labels.some((label) => label.endsWith(camera)),
        `${camera} is shown: ${labels.join(", ")}`,
      );
    assert.ok(!labels.some((label) => label.includes("user:view")), "the user's view is not the art director's frame");
    assert.equal(labels.filter((label) => /MOTION/.test(label)).length, 3, "first, middle and last motion frames");
    assert.ok(labels.length <= SHIP_REVIEW_IMAGES, `${labels.length} images`);
    const asked = String(request.messages[0].content);
    assert.doesNotMatch(asked, /BUILD B/, "one build, no comparison");
    assert.match(asked, /hud/, "the plan's parts are named as data");
    assert.match(asked, /online multiplayer/, "the user's cut is in the review's scope, so it is never asked for");

    assert.equal(review.ship, false);
    assert.deepEqual(
      review.defects.map((d) => [d.part, d.severity]),
      [
        ["hud", DefectSeverity.Blocker],
        [null, DefectSeverity.Visible],
      ],
      "a part that is not the plan's is nobody's, and an unknown severity is visible",
    );

    const prose = ctxRecorder({ handlers: { "engine.complete": replying("Looks great, ship it!") } });
    const unusable = await shipReview(prose.ctx as never, {
      run: run as never,
      evidence: gameEvidence() as never,
      parts: PARTS,
    });
    assert.equal(unusable.ship, null, "an answer nobody can read is no verdict, never a no");
    assert.deepEqual(unusable.defects, []);
    assert.equal(unusable.parse, "invalid");
  });

  it("AD-1b. a workspace laid down from the seed asks the art director with its own judge/ship-review.md", async () => {
    const recorder = ctxRecorder({ workspace: SEED, handlers: { "engine.complete": replying(SHIP_NO) } });
    await shipReview(recorder.ctx as never, {
      run: { runId: "run_ad", goal: "a night race", reference: null } as never,
      evidence: gameEvidence() as never,
      parts: PARTS,
    });
    const request = recorder.paramsOf("engine.complete")[0] as Record<string, any>;
    assert.equal(request.systemPrompt, await readFile(path.join(SEED, "judge", "ship-review.md"), "utf8"));
  });

  it("AD-1c. the art director reads the HUD's coverage against the kind's budget, as the taste judges do", async () => {
    const recorder = ctxRecorder({ handlers: { "engine.complete": replying(SHIP_NO) } });
    const evidence = { ...gameEvidence(), state: { hud: { coverage: 0.25, count: 9, overlaps: [] } } };
    await shipReview(recorder.ctx as never, {
      run: { runId: "run_ad", goal: "a night race", reference: null, game: { kind: "racing" } } as never,
      evidence: evidence as never,
      parts: PARTS,
    });
    const asked = String((recorder.paramsOf("engine.complete")[0] as Record<string, any>).messages[0].content);
    const budget = hudBudgetFor({ kind: "racing" });
    assert.ok(budget !== null, "a racer has a HUD budget");
    assert.ok(
      asked.includes(`covers 25% of the frame (budget ${Math.round(budget * 100)}%)`),
      asked.split("\n").find((line) => line.startsWith("HUD:")) ?? asked,
    );
  });
});

describe("the lead's judge ship=yes (director/tools.ts)", () => {
  it("AD-2. judge ship=yes on integration answers ship and the defects grouped by the part that owns them, writes them into judge_<n>/verdict.json and keeps them for that head across a Resume", async () => {
    const host = fakeHost();
    const { loopRun, seen } = fakeLoopRun(host, { answers: { [HostMethod.EngineComplete]: replying(SHIP_NO) } });
    loopRun.state.workers.set("hud", loopWorker("hud"));
    loopRun.state.workers.set("track", loopWorker("track", { state: "done", endedAt: T0 + HOUR_MS }));

    const answer = JSON.parse(await loopRun.judge({ target: "integration", against: "none", ship: "yes" }));

    assert.deepEqual(seen[0]!.viewport, SHIP_VIEW, "AD-6: the whole game is looked at at 1600×900");
    assert.deepEqual(SHIP_VIEW, { width: 1600, height: 900 });
    assert.equal(answer.ship.ship, false);
    assert.match(answer.ship.defectsByPart.hud.join(" "), /speed digits/);
    assert.match(answer.ship.defectsByPart.track.join(" "), /road texture/);
    assert.equal(Object.keys(answer.ship.defectsByPart).length, 3, "the unowned nit has a group of its own");
    assert.match(answer.ship.next, /stage=finish/);

    const written = host.calls.find(
      (c) => c.method === HostMethod.RunArtifact && c.params.name === "director/judge_1/verdict.json",
    )!;
    const verdict = JSON.parse(Buffer.from(written.params.base64, "base64").toString("utf8"));
    assert.equal(verdict.ship.ship, false);
    assert.equal(verdict.ship.defects.length, 3);
    const judged = loopRun.report.verdicts.filter((v: Record<string, unknown>) => v.pass === "judge");
    assert.equal(judged.length, 1, "one look, one judge verdict: the chat says it once");
    assert.ok(
      JSON.stringify(judged[0]).includes(SHIP_QUESTION),
      "the ship review is a judge verdict on the record, asked its own question",
    );

    // Each defect went to its owner: the running hud worker's board, the finished track's ledger line, the lead's.
    const hud = loopRun.state.workers.get("hud");
    const routed = hud.spec.checks.find((c: Record<string, unknown>) => /speed digits/.test(String(c.defect)));
    assert.equal(routed?.origin, CheckOrigin.Director);
    assert.equal(routed?.weight, CheckWeight.Identity);
    assert.ok(
      hud.steering.some((line: string) => /speed digits/.test(line)),
      "and the worker is told",
    );
    assert.deepEqual(
      loopRun.state.ledger.map((d: Record<string, unknown>) => d.owner).sort(),
      ["integration", "track"],
      "a finished part's defect waits under that part, an unowned one is the lead's",
    );

    assert.equal(loopRun.state.lastShip.head, HEAD);
    assert.equal(loopRun.state.lastShip.ship, false);
    const saved = host.journals.at(-1)!;
    const resumed = fakeLoopRun(fakeHost(), { over: { resume: true, priorJournal: saved } }).loopRun;
    restoreLoopRun(resumed);
    assert.equal(resumed.state.lastShip.head, HEAD, "a Resume keeps the review of that head");
    assert.equal(resumed.state.lastShip.defects.length, 3);
  });

  it("AD-4. a ship defect lands on the board of the running worker whose part it names as a director check, weighted by severity, and its fix is a strong flip", () => {
    const hud = loopWorker("hud");
    const workers = new Map<string, any>([
      ["hud", hud],
      ["track", loopWorker("track", { state: "done" })],
    ]);
    const routes = shipDefectsToChecks(
      {
        ship: false,
        defects: [...SHIP_NO.defects, { ...SHIP_NO.defects[0]!, what: "the lap counter flickers", severity: "nit" }],
      } as never,
      workers as never,
    );
    assert.deepEqual(
      routes.map((r) => r.part),
      ["hud", "track", null, "hud"],
    );
    const [blocker, , nit, hudNit] = routes;
    assert.equal(blocker!.check.origin, CheckOrigin.Director);
    assert.equal(blocker!.check.kind, "vision");
    assert.equal(blocker!.check.expect, "yes");
    assert.equal(blocker!.check.camera, "default");
    assert.match(String(blocker!.check.ask), /^Is this gone\?/);
    assert.equal(blocker!.check.weight, CheckWeight.Identity);
    assert.equal(hudNit!.check.weight, CheckWeight.Normal, "a nit counts, but decides nothing");
    assert.equal(nit!.check.camera, "top");
    assert.notEqual(blocker!.check.id, hudNit!.check.id, "two checks on one board never share an id");
    // The director's own question flipping keeps the round: it is not the judge agreeing with itself.
    const spec = { checks: [blocker!.check] };
    assert.deepEqual(
      strongFlips(spec, { [blocker!.check.id]: { kind: "vision", origin: "director" } }, [blocker!.check.id]),
      [blocker!.check.id],
    );
  });

  it("AD-4b. a part restarted to finish (worker_start replaces=<its id>) gets its ship defects on the new worker's board", async () => {
    const host = fakeHost();
    const { loopRun } = fakeLoopRun(host, { answers: { [HostMethod.EngineComplete]: replying(SHIP_NO) } });
    loopRun.state.workers.set("track", loopWorker("track", { state: "done", endedAt: T0 + HOUR_MS }));
    loopRun.state.workers.set("track-2", loopWorker("track-2", { replaces: "track", state: "done" }));
    loopRun.state.workers.set("track-3", loopWorker("track-3", { replaces: "track-2" }));
    await loopRun.judge({ target: "integration", ship: "yes" });
    const finisher = loopRun.state.workers.get("track-3");
    assert.ok(
      finisher.spec.checks.some((c: Record<string, unknown>) => /road texture/.test(String(c.defect))),
      "the running worker that replaced the part's last owner takes its defect",
    );
    assert.ok(
      !loopRun.state.ledger.some((d: Record<string, unknown>) => d.owner === "track"),
      "and it is not left on the ledger",
    );
  });

  /**
   * A run whose track part finished before the finish mark: the art director's look shelves the
   * track's defect on the ledger, and the lead starts a finish worker on the part as the rule says.
   */
  async function finishedTrackNight() {
    const host = fakeHost();
    // worker_start budgets from the wall clock: the run's working time is around it.
    const now = Date.now();
    const { loopRun } = fakeLoopRun(host, {
      clock: { started: now, softDeadline: now + 4 * HOUR_MS, finalDeadline: now + 4 * HOUR_MS + 15 * MINUTE_MS },
      answers: {
        [HostMethod.EngineComplete]: replying(SHIP_NO),
        [HostMethod.SnapshotWorktree]: (params: Record<string, any>) => ({ path: `/runs/run_ad/${params.name}` }),
        [HostMethod.ThreadCreate]: "t-finish",
        [HostMethod.PreviewCapacity]: { headless: true, max: 12, free: 12, inUse: 0 },
        [HostMethod.PreviewAcquire]: { handle: "h" },
      },
    });
    // One looping part, so no module contract stands between the lead and its finish worker.
    loopRun.state.plan = { summary: "A night race.", workers: [{ ...PARTS[0], single: true }, PARTS[1]] };
    loopRun.state.workers.set("track", loopWorker("track", { state: "done", endedAt: T0 + HOUR_MS }));
    await loopRun.judge({ target: "integration", ship: "yes" });
    assert.ok(
      loopRun.state.ledger.some((d: Record<string, unknown>) => d.owner === "track"),
      "nobody runs the track: its defect waits on the ledger",
    );
    loopRun.runWorker = async () => {};
    loopRun.startMonitor = () => {};
    return loopRun;
  }

  /** `worker_start` for a loop worker that finishes, as the finish mark's rule asks for it. */
  const startFinisher = async (loopRun: any, args: Record<string, unknown>) =>
    JSON.parse(
      String(
        await loopRun.startWorker({
          mode: "loop",
          stage: "finish",
          owns: "src/track.js",
          from: "integration",
          brief: "Finish the track",
          ...args,
        }),
      ),
    );

  it("AD-4c. a finished part's shelved ship defect goes on the board of the finish worker started on it (replaces=<its id>), off the ledger, and its finish waits for the fix", async () => {
    const loopRun = await finishedTrackNight();
    const started = await startFinisher(loopRun, { id: "track-finish", replaces: "track" });
    assert.equal(started.started, "track-finish", JSON.stringify(started));

    const finisher = loopRun.state.workers.get("track-finish");
    const ship = finisher.spec.checks.find((c: Record<string, unknown>) => /road texture/.test(String(c.defect)));
    assert.ok(ship, "the finisher is asked about the art director's defect in its part");
    assert.equal(ship.origin, CheckOrigin.Director);
    assert.equal(ship.weight, CheckWeight.Identity, "a visible defect decides whether the part is done");
    assert.equal(ship.camera, "chase", "asked on the camera the art director saw it through");
    assert.ok(
      finisher.steering.some((line: string) => /road texture/.test(line)),
      "and the finisher is told",
    );
    assert.ok(
      !loopRun.state.ledger.some((d: Record<string, unknown>) => d.owner === "track"),
      "the ledger no longer says nobody is building it",
    );
    assert.ok(
      loopRun.state.ledger.some((d: Record<string, unknown>) => d.owner === "integration"),
      "the lead's own defect stays the lead's",
    );

    // A round the judge prefers ends a finisher only once the defect is gone.
    const board = (shipPass: boolean) =>
      Object.fromEntries(
        finisher.spec.checks.map((c: Record<string, unknown>) => [
          c.id,
          { id: c.id, kind: c.kind, weight: c.weight, pass: c.id === ship.id ? shipPass : true },
        ]),
      );
    assert.equal(finishDone({ won: true, summary: summarizeScoreboard(board(false), finisher.spec) }), null);
    assert.ok(finishDone({ won: true, summary: summarizeScoreboard(board(true), finisher.spec) }));
  });

  it("AD-4f. a shelved defect from a review that would ship tells the worker that takes it that the art director would ship, and a worker still building fixes it beside its move", async () => {
    const wouldShip = {
      ship: true,
      defects: [
        { what: "the road texture swims as the car moves", camera: "chase", part: "track", severity: "visible" },
      ],
      strengths: ["the dusk light"],
      reason: "a demo as it stands",
    };
    const host = fakeHost();
    const now = Date.now();
    const { loopRun } = fakeLoopRun(host, {
      clock: { started: now, softDeadline: now + 4 * HOUR_MS, finalDeadline: now + 4 * HOUR_MS + 15 * MINUTE_MS },
      answers: {
        [HostMethod.EngineComplete]: replying(wouldShip),
        [HostMethod.SnapshotWorktree]: (params: Record<string, any>) => ({ path: `/runs/run_ad/${params.name}` }),
        [HostMethod.ThreadCreate]: "t-track",
        [HostMethod.PreviewCapacity]: { headless: true, max: 12, free: 12, inUse: 0 },
        [HostMethod.PreviewAcquire]: { handle: "h" },
      },
    });
    loopRun.state.plan = { summary: "A night race.", workers: [{ ...PARTS[0], single: true }, PARTS[1]] };
    loopRun.state.workers.set("track", loopWorker("track", { state: "done", endedAt: T0 + HOUR_MS }));
    await loopRun.judge({ target: "integration", ship: "yes" });
    assert.ok(
      loopRun.state.ledger.some((d: Record<string, unknown>) => d.owner === "track"),
      "shelved: nobody runs it",
    );
    loopRun.runWorker = async () => {};
    loopRun.startMonitor = () => {};

    const started = await startFinisher(loopRun, { id: "track-2", replaces: "track", stage: "build" });
    assert.equal(started.started, "track-2", JSON.stringify(started));
    const told = loopRun.state.workers.get("track-2").steering.find((line: string) => /road texture/.test(line)) ?? "";
    assert.match(told, /would ship/, "the review it came from would ship the build");
    assert.doesNotMatch(told, /would not ship/);
    assert.match(told, /beside your move, never instead of it/, "a worker still building keeps its move");
  });

  it("AD-4d. a finish worker that names the part by its goal, not replaces=, takes the part's shelved defects too", async () => {
    const loopRun = await finishedTrackNight();
    const started = await startFinisher(loopRun, { id: "track-polish", goal: "track" });
    assert.equal(started.started, "track-polish", JSON.stringify(started));
    const finisher = loopRun.state.workers.get("track-polish");
    assert.ok(finisher.spec.checks.some((c: Record<string, unknown>) => /road texture/.test(String(c.defect))));
    assert.ok(!loopRun.state.ledger.some((d: Record<string, unknown>) => d.owner === "track"));
  });

  it("AD-4c. a worker started for a part under another id (worker_start goal=<part>) takes that part's ship defects, as the contract gate reads its part", async () => {
    const host = fakeHost();
    const { loopRun } = fakeLoopRun(host, { answers: { [HostMethod.EngineComplete]: replying(SHIP_NO) } });
    loopRun.state.workers.set("hud-gauges", loopWorker("hud-gauges", { goal: "hud" }));
    // A worker whose own id is a plan part builds that part, whatever goal it advances.
    loopRun.state.workers.set("track", loopWorker("track", { goal: "hud", state: "done" }));
    await loopRun.judge({ target: "integration", ship: "yes" });
    const gauges = loopRun.state.workers.get("hud-gauges");
    assert.ok(
      gauges.spec.checks.some((c: Record<string, unknown>) => /speed digits/.test(String(c.defect))),
      "the running worker whose goal is the hud part takes its defect",
    );
    assert.deepEqual(
      loopRun.state.ledger.map((d: Record<string, unknown>) => d.owner).sort(),
      ["integration", "track"],
      "the hud defect is not shelved as nobody's work",
    );
  });

  it("AD-4c. a new ship review swaps the art director's questions on running boards: a reworded defect replaces the old one, a gone one leaves, a repeated one keeps its id, and an unread review changes nothing", async () => {
    const reviews: unknown[] = [
      SHIP_NO,
      {
        ...SHIP_NO,
        defects: [
          { what: "the speed readout is clipped at the right", camera: "default", part: "hud", severity: "blocker" },
        ],
      },
      {
        ...SHIP_NO,
        defects: [
          { what: "the speed readout is clipped at the right", camera: "default", part: "hud", severity: "blocker" },
        ],
      },
      "the judge could not answer",
    ];
    const host = fakeHost();
    const answer = () => replying(reviews.shift())();
    const { loopRun } = fakeLoopRun(host, { answers: { [HostMethod.EngineComplete]: answer } });
    loopRun.state.workers.set("hud", loopWorker("hud"));
    loopRun.state.workers.set("track", loopWorker("track"));
    const asked = (id: string): Array<Record<string, unknown>> =>
      loopRun.state.workers
        .get(id)
        .spec.checks.filter((c: Record<string, unknown>) => c.origin === CheckOrigin.Director);

    await loopRun.judge({ target: "integration", ship: "yes" });
    assert.equal(asked("hud").length, 1);
    assert.equal(asked("track").length, 1);

    await loopRun.judge({ target: "integration", ship: "yes" });
    assert.deepEqual(
      asked("hud").map((c) => c.defect),
      ["the speed readout is clipped at the right"],
      "the reworded defect replaces the old question instead of piling up beside it",
    );
    assert.deepEqual(asked("track"), [], "a defect the newest review no longer names leaves the board");
    const kept = asked("hud")[0]!.id;

    await loopRun.judge({ target: "integration", ship: "yes" });
    assert.deepEqual(
      asked("hud").map((c) => c.id),
      [kept],
      "the same defect again keeps its question",
    );

    await loopRun.judge({ target: "integration", ship: "yes" });
    assert.deepEqual(
      asked("hud").map((c) => c.id),
      [kept],
      "a review with no verdict retires nothing",
    );
  });

  it("AD-4e. the art director's word to an owner follows its verdict and the defect's severity: a nit is optional polish, a build it would ship never reads as one it would not, and a build-stage worker is never told to fix it ahead of its move", async () => {
    const reviews: unknown[] = [
      {
        ship: true,
        defects: [
          { what: "the lap counter sits a hair too high", camera: "default", part: "hud", severity: "nit" },
          { what: "the bridge seams show as the car crosses", camera: "chase", part: "track", severity: "visible" },
        ],
        strengths: ["the dusk light"],
        reason: "a demo as it stands",
      },
      SHIP_NO,
    ];
    const host = fakeHost();
    const { loopRun } = fakeLoopRun(host, {
      answers: { [HostMethod.EngineComplete]: () => replying(reviews.shift())() },
    });
    loopRun.state.workers.set("hud", loopWorker("hud"));
    const finishing = { ...loopWorker("track").spec, stage: FacetStage.Finish };
    loopRun.state.workers.set("track", loopWorker("track", { spec: finishing }));
    const told = (id: string): string => loopRun.state.workers.get(id).steering.at(-1) ?? "";

    await loopRun.judge({ target: "integration", ship: "yes" });
    const nit = told("hud");
    assert.match(nit, /lap counter/);
    assert.match(nit, /optional/, "a nit is optional polish");
    assert.doesNotMatch(nit, /would not ship/, "the art director would ship this build");
    assert.doesNotMatch(nit, /this iteration/, "a build-stage worker keeps its move");
    assert.match(nit, /never ahead of your move/, "a builder never puts a nit ahead of its move");
    const visible = told("track");
    assert.match(visible, /bridge seams/);
    assert.match(visible, /would ship/);
    assert.doesNotMatch(visible, /would not ship/);
    assert.doesNotMatch(visible, /optional/, "a defect a player notices is the finisher's work");

    await loopRun.judge({ target: "integration", ship: "yes" });
    const blocker = told("hud");
    assert.match(blocker, /speed digits/);
    assert.match(blocker, /would not ship/);
    assert.doesNotMatch(blocker, /optional/);
    assert.doesNotMatch(blocker, /this iteration/, "a build-stage worker is not told to put it ahead of its move");
    assert.match(blocker, /beside your move, never instead of it/, "a builder fixes it beside its move");
  });

  it("AD-10. judge ship=yes looks at one build alone: with a start picture it makes no blind call and leaves no pick, and ship=yes against a build is refused in one line", async () => {
    const host = fakeHost();
    const { loopRun } = fakeLoopRun(host, { answers: { [HostMethod.EngineComplete]: replying(SHIP_NO) } });
    loopRun.state.startEvidence = gameEvidence();
    const answer = JSON.parse(await loopRun.judge({ target: "integration", ship: "yes" }));
    assert.equal(answer.verdict, undefined, "no blind verdict between a 1600×900 look and a 960×600 one");
    assert.equal(host.calls.filter((c) => c.method === HostMethod.EngineComplete).length, 1, "the ship review alone");
    assert.equal(loopRun.state.lastJudge?.pick ?? null, null);

    const refused = await loopRun.judge({ target: "integration", against: "start", ship: "yes" });
    assert.throws(() => JSON.parse(refused), "a refusal is a line, not a judge's answer");
    assert.match(refused, /against/);
    assert.equal(host.calls.filter((c) => c.method === HostMethod.EngineComplete).length, 1, "nothing looked at");
  });

  it("AD-11. the studio's own ship look keeps the lead's blind pick over the start on that head, so the close does not judge again", async () => {
    const host = fakeHost();
    const { loopRun } = fakeLoopRun(host, { answers: { [HostMethod.EngineComplete]: replying(SHIP_NO) } });
    loopRun.state.startEvidence = gameEvidence();
    loopRun.state.lastJudge = { ...LEAD_PICK };
    loopRun.journal.director.lastJudge = { ...LEAD_PICK };
    const { review } = await loopRun.artDirectionPass();
    assert.equal(review?.ship, false, "the art director looked");
    assert.equal(loopRun.state.lastJudge.pick, "challenger", "the lead's pick stands");
    assert.equal(host.journals.at(-1)!.director.lastJudge.pick, "challenger", "and the journal keeps it");
    const calls = host.calls.filter((c) => c.method === HostMethod.EngineComplete).length;
    await loopRun.judgeTheLanding(HEAD);
    assert.equal(host.calls.filter((c) => c.method === HostMethod.EngineComplete).length, calls, "no second judge");
  });

  it("AD-12. a defect's camera is one the review was shown, or the default: an invented camera never reaches a board", async () => {
    const invented = {
      ship: false,
      defects: [
        { what: "the speed digits are cut off", camera: "chase camera", part: "hud", severity: "blocker" },
        { what: "the needle stutters", camera: "MOTION 2", part: "hud", severity: "visible" },
        { what: "the gauge is unlit", camera: "eye:here", part: "hud", severity: "visible" },
      ],
      strengths: [],
      reason: "",
    };
    const host = fakeHost();
    const { loopRun } = fakeLoopRun(host, { answers: { [HostMethod.EngineComplete]: replying(invented) } });
    loopRun.state.workers.set("hud", loopWorker("hud"));
    await loopRun.judge({ target: "integration", ship: "yes" });
    const hud = loopRun.state.workers.get("hud");
    assert.deepEqual(
      hud.spec.checks.map((c: Record<string, unknown>) => c.camera),
      ["default", "default", "eye:here"],
    );
    assert.deepEqual(hud.spec.cameras, ["default"], "no camera the game never registered is added to its spec");
  });

  it("AD-13. the art director is told the size it looks at only when the window it looked through was sized", async () => {
    const host = fakeHost();
    const { loopRun } = fakeLoopRun(host, { answers: { [HostMethod.EngineComplete]: replying(SHIP_NO) } });
    loopRun.withLease = async (_label: string, fn: (handle: string | null) => Promise<unknown>) => fn(null);
    await loopRun.judge({ target: "integration", ship: "yes" });
    const [asked] = shipCalls(host);
    assert.doesNotMatch(String(asked!.params.messages[0].content), /captured at/);
  });
});

describe("a whole-game judge sees every camera", () => {
  it("AD-5. a lead's judge against the start with no cameras named shows the judge every camera both builds registered, cut alike", async () => {
    const host = fakeHost();
    const cameras = ["default", "chase", "side", "top"];
    const blind = '{"facets":{"works":"A","visuals":"A","feel":"tie","play":"tie"},"defects":[],"reason":"steadier"}';
    const { loopRun } = fakeLoopRun(host, {
      evidence: gameEvidence(cameras),
      answers: { [HostMethod.EngineComplete]: replying(blind) },
    });
    loopRun.state.startEvidence = gameEvidence([...cameras, "only-in-the-start"]);
    await loopRun.judge({ target: "integration", against: "start" });
    const [labels] = imageLabels(host);
    for (const side of ["BUILD A", "BUILD B"])
      for (const camera of cameras)
        assert.ok(labels!.includes(`${side} / ${camera}`), `${side} / ${camera} in ${labels!.join(", ")}`);
    assert.ok(!labels!.some((label) => label.endsWith("only-in-the-start")), "a camera one side lacks is cut");
    const a = labels!.filter((label) => label.startsWith("BUILD A")).map((label) => label.slice(10));
    const b = labels!.filter((label) => label.startsWith("BUILD B")).map((label) => label.slice(10));
    assert.deepEqual(a.sort(), b.sort(), "cut alike");
  });

  it("AD-5b. blindCompare's every-camera cut keeps both sides alike within its image cap", async () => {
    const recorder = ctxRecorder({ handlers: { "engine.complete": replying({ pick: "A" }) } });
    const many = ["default", "a", "b", "c", "d", "e", "f"];
    await blindCompare(
      recorder.ctx as never,
      {
        run: { runId: "r", reference: { name: "bar" } } as never,
        challenger: gameEvidence(many) as never,
        incumbentEvidence: gameEvidence(many) as never,
        cameras: many,
        everyCamera: true,
      } as never,
    );
    const labels: string[] = (recorder.paramsOf("engine.complete")[0] as any).messages[0].images.map(
      (image: { label: string }) => image.label,
    );
    const perSide = (tag: string) => labels.filter((label) => label.startsWith(tag)).length;
    assert.equal(perSide("BUILD A"), perSide("BUILD B"));
    assert.ok(perSide("BUILD A") > 4, `more than the taste judge's four: ${labels.join(", ")}`);
  });
});

describe("the finish mark (director/budgets.ts, wake.ts, art-direction.ts)", () => {
  it("finishMarkMs: a timed build keeps 30% of its working time for finishing, 30 to 120 minutes, none under an hour and a half; a goal build has no mark", () => {
    const timed = { reference: null, budgets: { completionPolicy: "duration" } } as never;
    const goal = { reference: null, budgets: { completionPolicy: "goal" } } as never;
    assert.equal(finishMarkMs(timed, 4 * HOUR_MS), 72 * MINUTE_MS);
    assert.equal(finishMarkMs(timed, 90 * MINUTE_MS), 30 * MINUTE_MS);
    assert.equal(finishMarkMs(timed, 10 * HOUR_MS), 120 * MINUTE_MS);
    assert.equal(finishMarkMs(timed, 89 * MINUTE_MS), null);
    assert.equal(finishMarkMs(goal, 10 * HOUR_MS), null);
  });

  it("AD-3. a timed build reaching its finish mark is judged ship-or-not by the studio itself, and the lead is woken once with the defects by part", async () => {
    const host = fakeHost();
    const { loopRun, seen } = fakeLoopRun(host, { answers: { [HostMethod.EngineComplete]: replying(SHIP_NO) } });
    loopRun.state.workers.set("hud", loopWorker("hud"));
    const mark = loopRun.clock.softDeadline - finishMarkMs(loopRun.run, 4 * HOUR_MS)!;
    const { talk, turns } = lead((turn) => {
      if (turn === 2) loopRun.state.finished = true;
      return { ok: true, sessionId: "lead-1", turns: 1 };
    });
    await runWakeLoop(loopRun, talk, BRIEF, fakeClock(mark - 2 * MINUTE_MS));

    assert.equal(turns.length, 2, turns.map((t) => t.prompt.slice(0, 120)).join("\n---\n"));
    const woken = turns[1]!.prompt;
    assert.match(woken, /finish mark/i);
    assert.match(woken, /would not ship/);
    assert.match(woken, /hud[^\n]*speed digits/);
    assert.match(woken, /stage=finish/);
    assert.match(woken, /no new parts or systems/);
    assert.equal(imageLabels(host).length, 1, "one review");
    assert.deepEqual(seen[0]!.viewport, SHIP_VIEW);
    assert.equal(loopRun.state.lastShip.head, HEAD);
    const continued = host.calls
      .filter((c) => c.method === HostMethod.EventsAppend)
      .flatMap((c) => c.params.batch)
      .filter((e: Record<string, any>) => e.event_type === "director_continued");
    assert.ok(continued.some((e: Record<string, any>) => e.payload.reasons.includes(WakeCause.FinishMark)));
    assert.equal(host.journals.at(-1)!.director.wake.finishMarkSaid, true, "said once, and the journal keeps it");
  });

  it("AD-3c. past the finish mark every later wake repeats the finish rule: the room for workers and the idle question never ask for new parts", async () => {
    const host = fakeHost();
    const { loopRun } = fakeLoopRun(host, { answers: { [HostMethod.EngineComplete]: replying(SHIP_NO) } });
    loopRun.capacity = { max: 4, headless: true };
    loopRun.state.workers.set("hud", loopWorker("hud"));
    const mark = loopRun.clock.softDeadline - finishMarkMs(loopRun.run, 4 * HOUR_MS)!;
    const { talk, turns } = lead((turn) => {
      // The owner finished its part during the mark's turn: the next turn ends with nothing running.
      if (turn === 2) loopRun.state.workers.get("hud").state = "done";
      if (turn === 3) loopRun.state.finished = true;
      return { ok: true, sessionId: "lead-1", turns: 1 };
    });
    await runWakeLoop(loopRun, talk, BRIEF, fakeClock(mark - 2 * MINUTE_MS));

    assert.equal(turns.length, 3, turns.map((t) => t.prompt.slice(0, 160)).join("\n---\n"));
    const [atMark, idle] = [turns[1]!.prompt, turns[2]!.prompt];
    for (const prompt of [atMark, idle]) {
      assert.doesNotMatch(prompt, /next one the ask names/, "no new area offered past the mark");
      assert.match(prompt, /past the finish mark/);
    }
    assert.match(idle, /What next\?/);
    assert.doesNotMatch(idle, /most valuable unfinished feature/, "the idle question asks for no new feature");
    assert.match(idle, /no new parts or systems/);
    assert.match(idle, /stage=finish/);
    assert.match(idle, /judge ship=yes/);
  });

  it("AD-3d. past the finish mark a wake offers no reviewer's next big step, names a finishing worker's stage, and a timed build's card says the finish stage instead of spending the time building", async () => {
    const host = fakeHost();
    const { loopRun } = fakeLoopRun(host, { answers: { [HostMethod.EngineComplete]: replying(SHIP_NO) } });
    const proposed = [{ iteration: 1, won: true, ideas: ["reviewer: rivals that race as a pack"] }];
    loopRun.state.workers.set("hud", loopWorker("hud", { iterations: proposed }));
    const finishing = { ...loopWorker("track").spec, stage: FacetStage.Finish };
    loopRun.state.workers.set("track", loopWorker("track", { spec: finishing }));
    const mark = loopRun.clock.softDeadline - finishMarkMs(loopRun.run, 4 * HOUR_MS)!;
    const { talk, turns } = lead((turn) => {
      if (turn === 2) loopRun.state.finished = true;
      return { ok: true, sessionId: "lead-1", turns: 1 };
    });
    await runWakeLoop(loopRun, talk, BRIEF, fakeClock(mark - 2 * MINUTE_MS));

    assert.equal(turns.length, 2, turns.map((t) => t.prompt.slice(0, 160)).join("\n---\n"));
    const atMark = turns[1]!.prompt;
    assert.doesNotMatch(atMark, /next big step|rivals that race as a pack/, "no new system offered past the mark");
    assert.match(atMark, /- worker track \(track\): running · stage finish/);
    assert.doesNotMatch(atMark, /spend the working time building/);
    assert.match(atMark, /BUILD CARD:[\s\S]*finish stage[^\n]*no new parts or systems/);
    // The mark's own look routes its defects before the lead flips hud to stage=finish: hud is
    // told as a finisher, never to keep its move first.
    const hudTold = loopRun.state.workers.get("hud").steering.at(-1) ?? "";
    assert.match(hudTold, /speed digits/);
    assert.doesNotMatch(hudTold, /beside your move|ahead of your move/, "past the mark no move comes first");
    assert.match(hudTold, /this round's work/);
  });

  it("AD-3c. a timed build that slept through its finish mark and its wrap-up wraps up without the art director's pass", async () => {
    const host = fakeHost();
    const { loopRun } = fakeLoopRun(host, { answers: { [HostMethod.EngineComplete]: replying(SHIP_NO) } });
    loopRun.state.workers.set("hud", loopWorker("hud"));
    const mark = loopRun.clock.softDeadline - finishMarkMs(loopRun.run, 4 * HOUR_MS)!;
    const { talk, turns } = lead((turn) => {
      if (turn === 2) loopRun.state.finished = true;
      return { ok: true, sessionId: "lead-1", turns: 1 };
    });
    // The Mac sleeps through both: the first rest wakes a minute past the wrap-up.
    let slept = false;
    const clock = fakeClock(mark - 2 * MINUTE_MS, () => {
      if (slept) return;
      slept = true;
      clock.at = loopRun.softDeadline + MINUTE_MS;
    });
    await runWakeLoop(loopRun, talk, BRIEF, clock);

    assert.equal(turns.length, 2, turns.map((t) => t.prompt.slice(0, 120)).join("\n---\n"));
    const woken = turns[1]!.prompt;
    assert.match(woken, /wrap-up/i);
    assert.doesNotMatch(woken, /stage=finish/, "no art paragraph that contradicts the wrap-up");
    assert.equal(shipCalls(host).length, 0, "the wrap-up reserve is not spent on a ship review");
    const continued = host.calls
      .filter((c) => c.method === HostMethod.EventsAppend)
      .flatMap((c) => c.params.batch)
      .filter((e: Record<string, any>) => e.event_type === "director_continued");
    assert.ok(continued.every((e: Record<string, any>) => !e.payload.reasons.includes(WakeCause.FinishMark)));
  });

  it("AD-3b. a goal build whose lead idles twice with no ship review on its head is reviewed once before its wrap-up", async () => {
    const host = fakeHost();
    const { loopRun } = fakeLoopRun(host, {
      answers: { [HostMethod.EngineComplete]: replying(SHIP_NO) },
      budgets: { wallClockMs: 2 * HOUR_MS, completionPolicy: "goal" },
      clock: { started: T0, softDeadline: T0 + HOUR_MS, finalDeadline: T0 + HOUR_MS + 10 * MINUTE_MS },
    });
    const { talk, turns } = lead((turn) => {
      if (turn === 4) loopRun.state.finished = true;
      return { ok: true, sessionId: "lead-1", turns: 1 };
    });
    await runWakeLoop(loopRun, talk, BRIEF, fakeClock(T0 + MINUTE_MS));

    assert.equal(turns.length, 4, turns.map((t) => t.prompt.slice(0, 160)).join("\n---\n"));
    assert.match(turns[1]!.prompt, /What next\?/, "asked what next first");
    assert.match(
      turns[1]!.prompt,
      /BUILD CARD:[\s\S]*art director's blocker and visible defects[^\n]*not optional polish/,
      "a goal commission's card says the art director's defects are not optional polish",
    );
    assert.match(turns[2]!.prompt, /would not ship/, "then sent to art direction");
    // A goal build's completion rule does not change at its mark, so its card is not sent again.
    assert.doesNotMatch(turns[2]!.prompt, /BUILD CARD/, "the goal card did not change at the mark");
    assert.match(turns[3]!.prompt, /wrap-up/i, "then the wrap-up");
    assert.equal(imageLabels(host).length, 1, "reviewed once");
  });
});

describe("the ship verdict on the record (director/integrate.ts)", () => {
  it("AD-7. the report says whether the art director would ship the head that was made live, and nothing when its review was of another head", async () => {
    const reported = async (reviewedHead: string) => {
      const { loopRun } = fakeLoopRun(fakeHost());
      loopRun.state.lastShip = { head: reviewedHead, ship: false, defects: SHIP_NO.defects, at: T0 };
      await loopRun.closeRun({ ok: true, line: "made live", verified: false, how: "fresh-health-pass" });
      return loopRun.report;
    };
    const live = await reported(HEAD);
    assert.equal(live.shipReview.head, HEAD);
    assert.equal(live.shipReview.ship, false);
    assert.equal(live.shipReview.defectsLeft, 3);
    assert.equal(live.shipReview.blockers, 1);
    assert.equal((await reported(FORK)).shipReview, undefined, "a review of another head says nothing of this one");
  });

  it("AD-8. a goal build's finish with no ship review on its head is reviewed once and refused once on a no; the next finish closes and says how many defects are left", async () => {
    const host = fakeHost();
    const { loopRun } = fakeLoopRun(host, {
      answers: { [HostMethod.EngineComplete]: shipAndQuestion() },
      budgets: { wallClockMs: 2 * HOUR_MS, completionPolicy: "goal" },
      clock: { started: Date.now(), softDeadline: Date.now() + HOUR_MS, finalDeadline: Date.now() + 2 * HOUR_MS },
    });
    const closes: unknown[] = [];
    loopRun.closeTheLoopRun = async (options: unknown) => {
      closes.push(options);
      return { ok: true, line: "made live" };
    };
    const first = await loopRun.finish({ summary: "the race is ready" });
    assert.match(first, /would not ship/);
    assert.equal(closes.length, 0, "the first finish is turned back once, with the defects");
    const second = await loopRun.finish({ summary: "the race is ready" });
    assert.equal(closes.length, 1, "never refused twice");
    assert.match(second, /would not ship this build; 3 defects left/);
    assert.equal(shipCalls(host).length, 1, "reviewed once");
    // The finish call holds the look and the close: the gate's judging ends by its own bound, and
    // its one look answered the close's own question, so the close does not judge it again.
    for (const call of host.calls.filter((c) => c.method === HostMethod.EngineComplete))
      assert.ok(call.params.timeoutMs <= ART_DIRECTION_JUDGE_MS, `${call.params.timeoutMs} ms`);
    assert.equal(loopRun.state.lastJudge.final, true);
    const before = host.calls.length;
    await loopRun.judgeTheLanding(HEAD);
    assert.equal(host.calls.length, before, "the close does not judge the head again");

    // A user who asks to finish is never turned back, and nothing is looked at for it.
    const quick = fakeHost();
    const asked = fakeLoopRun(quick, {
      answers: { [HostMethod.EngineComplete]: replying(SHIP_NO) },
      budgets: { wallClockMs: 2 * HOUR_MS, completionPolicy: "goal" },
      clock: { started: Date.now(), softDeadline: Date.now() + HOUR_MS, finalDeadline: Date.now() + 2 * HOUR_MS },
    }).loopRun;
    asked.inbox.finishing = async () => true;
    asked.closeTheLoopRun = async () => ({ ok: true, line: "made live" });
    assert.doesNotMatch(await asked.finish({ summary: "done" }), /refused|would not ship/);
    assert.equal(imageLabels(quick).length, 0);
  });

  it("AD-8b. a goal build's finish whose close still owes a blind judge against the start is not held for the art director: the finish call has no time for both", async () => {
    const goalLoopRun = (host: FakeHost) =>
      fakeLoopRun(host, {
        answers: { [HostMethod.EngineComplete]: replying(SHIP_NO) },
        budgets: { wallClockMs: 2 * HOUR_MS, completionPolicy: "goal" },
        clock: { started: Date.now(), softDeadline: Date.now() + HOUR_MS, finalDeadline: Date.now() + 2 * HOUR_MS },
      }).loopRun;
    const host = fakeHost();
    const loopRun = goalLoopRun(host);
    loopRun.state.startEvidence = gameEvidence();
    const closes: unknown[] = [];
    loopRun.closeTheLoopRun = async (options: unknown) => {
      closes.push(options);
      return { ok: true, line: "made live" };
    };
    await loopRun.finish({ summary: "the race is ready" });
    assert.equal(closes.length, 1, "it closes");
    assert.equal(shipCalls(host).length, 0, "and the art director did not look inside the finish call");

    // With the lead's pick over the start already on the head, the close owes no judge and the art director looks.
    const picked = fakeHost();
    const second = goalLoopRun(picked);
    second.state.startEvidence = gameEvidence();
    second.state.lastJudge = { ...LEAD_PICK };
    second.closeTheLoopRun = async () => ({ ok: true, line: "made live" });
    assert.match(await second.finish({ summary: "the race is ready" }), /would not ship/);
    assert.equal(second.state.lastJudge.pick, "challenger");
  });

  it("AD-8c. the finish gate asks whether there is time to act on the clock it is given, not the wall clock", async () => {
    const host = fakeHost();
    const softDeadline = Date.now() + HOUR_MS;
    const { loopRun } = fakeLoopRun(host, {
      answers: { [HostMethod.EngineComplete]: shipAndQuestion() },
      budgets: { wallClockMs: 2 * HOUR_MS, completionPolicy: "goal" },
      clock: { started: softDeadline - HOUR_MS, softDeadline, finalDeadline: softDeadline + HOUR_MS },
    });
    // On the loop's clock the working time is over, though the wall clock still has an hour of it.
    assert.equal(await loopRun.shipFinishGate(false, () => softDeadline + MINUTE_MS), null, "no time to act on a no");
    assert.equal(shipCalls(host).length, 0, "and nothing is looked at for it");
  });

  it("the finish answer counts the defects left whether or not the art director would ship", () => {
    const nits = [SHIP_NO.defects[2]!, { ...SHIP_NO.defects[2]!, what: "a seam in the sky" }];
    assert.match(shipFinishLine({ ship: true, defects: nits as never }), /would ship this build; 2 defects left/);
    assert.match(shipFinishLine({ ship: true, defects: [] }), /would ship this build\.$/);
  });

  it("AD-9. worker_status names a finishing worker's stage after a Resume", async () => {
    const host = fakeHost();
    const { loopRun } = fakeLoopRun(host);
    loopRun.state.workers.set(
      "hud",
      loopWorker("hud", { spec: { ...loopWorker("hud").spec, stage: FacetStage.Finish } }),
    );
    loopRun.state.workers.set("track", loopWorker("track"));
    await loopRun.saveJournal();
    const workers = host.journals.at(-1)!.director.workers;
    assert.equal(workers.hud.stage, FacetStage.Finish);
    assert.equal(workers.track.stage, undefined, "a building worker's record is as it was");
    const resumed = fakeLoopRun(fakeHost(), { over: { resume: true, priorJournal: host.journals.at(-1) } }).loopRun;
    restoreLoopRun(resumed);
    const before = priorWorkersStatus(resumed);
    assert.equal(before.find((w) => w.id === "hud")?.stage, FacetStage.Finish, "worker_status names it");
  });
});

/** An ∞ build: a goal commission whose ceiling is a day. */
const INFINITE = {
  budgets: { wallClockMs: 24 * HOUR_MS, completionPolicy: "goal" },
  clock: { started: T0, softDeadline: T0 + 23 * HOUR_MS, finalDeadline: T0 + 24 * HOUR_MS },
};

/** A lead's turn that decides and ends. */
const DECIDED = { ok: true, sessionId: "lead-1", turns: 1 };

/** Loop workers building their parts, each with kept work merged into integration unless named in `notIn`. */
function busyWorkers(loopRun: any, ids: readonly string[], notIn: readonly string[] = []): void {
  for (const id of ids) loopRun.state.workers.set(id, loopWorker(id, notIn.includes(id) ? {} : { integrated: true }));
}

/** A judge that answers the art director with SHIP_NO and keeps the loop clock's time of each look. */
const shipAt = (times: number[], clock: { at: number }) => (params: Record<string, any>) => {
  if (isShipCall(params)) times.push(clock.at);
  return replying(SHIP_NO)();
};

/** The reasons of every wake the run recorded. */
const wakeReasons = (host: FakeHost): string[][] =>
  host.calls
    .filter((c) => c.method === HostMethod.EventsAppend)
    .flatMap((c) => c.params.batch)
    .filter((e: Record<string, any>) => e.event_type === "director_continued")
    .map((e: Record<string, any>) => e.payload.reasons);

describe("the art director's regular look at the whole game (director/art-direction.ts, wake.ts)", () => {
  it("AD-14. an ∞ build with four busy workers is looked at once the first wave is in, while its lead is busy, and the defects reach their owners as building work", async () => {
    const host = fakeHost();
    const { loopRun } = fakeLoopRun(host, { answers: { [HostMethod.EngineComplete]: replying(SHIP_NO) }, ...INFINITE });
    busyWorkers(loopRun, ["hud", "track", "car", "city"]);
    const { talk, turns } = lead((turn) => {
      if (turn === 2) loopRun.state.finished = true;
      return DECIDED;
    });
    await runWakeLoop(loopRun, talk, BRIEF, fakeClock(T0 + 30 * MINUTE_MS));

    assert.equal(shipCalls(host).length, 1, "the art director looked at the whole game");
    assert.equal(turns.length, 2, turns.map((t) => t.prompt.slice(0, 160)).join("\n---\n"));
    const woken = turns[1]!.prompt;
    assert.match(woken, /art director's look at the whole game/i);
    assert.match(woken, /would not ship/);
    assert.match(woken, /hud[^\n]*speed digits/);
    assert.doesNotMatch(woken, /FINISH MARK|no new parts or systems|past the finish mark/, "not the finish stage");
    const hudTold = loopRun.state.workers.get("hud").steering.at(-1) ?? "";
    assert.match(hudTold, /speed digits/);
    assert.match(hudTold, /beside your move/, "a building owner fixes it beside its move");
    assert.ok(
      wakeReasons(host).some((reasons) => reasons.includes(WakeCause.ShipLook)),
      "the wake says why",
    );
    assert.equal(host.journals.at(-1)!.director.wake.finishMarkSaid, undefined, "the regular look is no finish mark");
  });

  it("AD-14c. the user is never kept waiting for a regular look: their words wake the lead first, and the look comes with the next wake", async () => {
    const host = fakeHost();
    const { loopRun } = fakeLoopRun(host, { answers: { [HostMethod.EngineComplete]: replying(SHIP_NO) }, ...INFINITE });
    busyWorkers(loopRun, ["hud", "track"]);
    let untold: string[] = [];
    loopRun.inbox.steering = async (_worker: unknown, take: boolean) => {
      const words = [...untold];
      if (take) untold = [];
      return words;
    };
    const looksBefore: number[] = [];
    const { talk, turns } = lead((turn) => {
      looksBefore.push(shipCalls(host).length);
      if (turn === 1) untold = ["make the sky darker"];
      if (turn === 3) loopRun.state.finished = true;
      return DECIDED;
    });
    await runWakeLoop(loopRun, talk, BRIEF, fakeClock(T0 + 30 * MINUTE_MS));

    assert.equal(turns.length, 3, turns.map((t) => t.prompt.slice(0, 160)).join("\n---\n"));
    assert.match(turns[1]!.prompt, /make the sky darker/);
    assert.doesNotMatch(turns[1]!.prompt, /art director's look at the whole game/i, "the user's turn is not held");
    assert.deepEqual(looksBefore, [0, 0, 1], "the look comes with the next wake");
    assert.match(turns[2]!.prompt, /art director's look at the whole game/i);
  });

  it("AD-14b. the first look waits for every running worker's kept work to be merged — at most 90 working minutes", async () => {
    const host = fakeHost();
    const looks: number[] = [];
    const clock = fakeClock(T0 + 30 * MINUTE_MS);
    const { loopRun } = fakeLoopRun(host, {
      answers: { [HostMethod.EngineComplete]: shipAt(looks, clock) },
      ...INFINITE,
    });
    busyWorkers(loopRun, ["hud", "track", "car", "city"], ["city"]);
    const { talk } = lead(() => {
      if (clock.at >= T0 + 95 * MINUTE_MS) loopRun.state.finished = true;
      return DECIDED;
    });
    await runWakeLoop(loopRun, talk, BRIEF, clock);

    assert.deepEqual(looks, [T0 + SHIP_LOOK_EVERY_MS], "no look before the wave is in, one at 90 working minutes");
  });

  it("AD-15. the art director looks again 90 working minutes after its last look, once the head has moved — never sooner, never twice at one head", async () => {
    const host = fakeHost();
    const looks: number[] = [];
    const clock = fakeClock(T0 + 30 * MINUTE_MS);
    const { loopRun } = fakeLoopRun(host, {
      answers: { [HostMethod.EngineComplete]: shipAt(looks, clock) },
      ...INFINITE,
    });
    busyWorkers(loopRun, ["hud", "track", "car", "city"]);
    const { talk } = lead((turn) => {
      // The lead integrates the next wave early on: the next look still waits for its time.
      if (turn === 3) {
        loopRun.state.integrationHead = HEAD2;
        loopRun.state.healthByHead.set(HEAD2, true);
      }
      if (clock.at >= T0 + 30 * MINUTE_MS + SHIP_LOOK_EVERY_MS + 40 * MINUTE_MS) loopRun.state.finished = true;
      return DECIDED;
    });
    await runWakeLoop(loopRun, talk, BRIEF, clock);

    assert.deepEqual(looks, [T0 + 30 * MINUTE_MS, T0 + 30 * MINUTE_MS + SHIP_LOOK_EVERY_MS]);
    assert.equal(loopRun.state.lastShip.head, HEAD2);
  });

  it("AD-15b. a timed build's regular look never comes within 30 minutes before its finish mark: the mark's own look takes its place", async () => {
    const host = fakeHost();
    const looks: number[] = [];
    const timed = { reference: null, budgets: { completionPolicy: "duration" } } as never;
    const mark = T0 + 4 * HOUR_MS - finishMarkMs(timed, 4 * HOUR_MS)!;
    // Twenty minutes before the mark: inside the gap the mark keeps clear of a second look.
    const clock = fakeClock(mark - 20 * MINUTE_MS);
    const { loopRun } = fakeLoopRun(host, { answers: { [HostMethod.EngineComplete]: shipAt(looks, clock) } });
    busyWorkers(loopRun, ["hud", "track"]);
    const { talk, turns } = lead(() => {
      if (clock.at >= mark) loopRun.state.finished = true;
      return DECIDED;
    });
    await runWakeLoop(loopRun, talk, BRIEF, clock);

    assert.deepEqual(looks, [mark], "one look, at the mark");
    assert.match(turns.at(-1)!.prompt, /THE FINISH MARK/);
  });

  it("AD-16. the art director names at most eight things that already work and must stay, each cut at a word, and a rubric that still says strengths is read the same way", async () => {
    const long =
      "the wet asphalt reflects every neon sign along the boulevard with a believable falloff that sells the rain";
    const named = [long, ...Array.from({ length: 9 }, (_, i) => `strength ${i + 1}`)];
    const read = readShipReview({ ship: true, defects: [], doNotRegress: named, reason: "fine" }, PARTS);
    assert.equal(read.doNotRegress.length, 8, "at most eight");
    const cut = String(read.doNotRegress[0]);
    assert.ok(cut.length < long.length && cut.endsWith("…"), cut);
    assert.ok(long.startsWith(cut.slice(0, -1)) && long.charAt(cut.length - 1) === " ", `cut at a word: ${cut}`);
    const older = readShipReview({ ship: false, defects: [], strengths: ["the dusk light"], reason: "r" }, PARTS);
    assert.deepEqual(older.doNotRegress, ["the dusk light"], "an older rubric's strengths are the list");

    const recorder = ctxRecorder({ workspace: SEED, handlers: { "engine.complete": replying(SHIP_NO) } });
    await shipReview(recorder.ctx as never, {
      run: { runId: "run_ad", goal: "a night race", reference: null } as never,
      evidence: gameEvidence() as never,
      parts: PARTS,
    });
    const request = recorder.paramsOf("engine.complete")[0] as Record<string, any>;
    assert.match(String(request.systemPrompt), /"doNotRegress"/, "the shipped rubric asks for the list");
    assert.match(String(request.messages[0].content), /"doNotRegress"/, "and so does the question");
  });

  it("AD-16b. the latest do-not-regress list stays with the run — every running loop worker's brief, a worker started later, the report and a Resume — and an unreadable review keeps it", async () => {
    const host = fakeHost();
    const keep = ["night lighting", "rain on the windscreen"];
    let reply: unknown = { ...SHIP_NO, doNotRegress: keep };
    const { loopRun } = fakeLoopRun(host, { answers: { [HostMethod.EngineComplete]: () => replying(reply)() } });
    loopRun.state.workers.set("hud", loopWorker("hud"));
    await loopRun.judge({ target: "integration", ship: "yes" });

    assert.deepEqual(loopRun.state.lastShip.doNotRegress, keep);
    const hud = loopRun.state.workers.get("hud");
    const brief = renderBrief({ run: loopRun.run, spec: hud.spec, iteration: 3 });
    assert.match(brief, /## Do not regress[^\n]*\n- night lighting\n- rain on the windscreen/, brief);
    const track: Record<string, any> = loopWorker("track");
    loopRun.takeShelvedShipDefects(track);
    assert.deepEqual(track.spec.doNotRegress, keep, "a loop worker started later brings the list into its brief");

    reply = "Looks great, ship it!";
    await loopRun.judge({ target: "integration", ship: "yes" });
    assert.equal(loopRun.state.lastShip.ship, null);
    assert.deepEqual(loopRun.state.lastShip.doNotRegress, keep, "an answer nobody could read keeps the list");
    assert.deepEqual(hud.spec.doNotRegress, keep);

    assert.deepEqual(loopRun.shipReport().doNotRegress, keep, "the report keeps it");
    const resumed = fakeLoopRun(fakeHost(), { over: { resume: true, priorJournal: host.journals.at(-1) } }).loopRun;
    restoreLoopRun(resumed);
    assert.deepEqual(resumed.state.lastShip.doNotRegress, keep, "a Resume keeps it");
  });

  it("AD-16c. the taste judge is handed the do-not-regress list as part of its regression guard: a lost item is a regression it must name", async () => {
    const answer = { pick: "A", satisfied: false, regression: null, newCheck: null, defects: [], reason: "same" };
    const judgeOf = () => ctxRecorder({ handlers: { "engine.complete": replying(answer) } });
    const run = { runId: "run_ad", goal: "a night race", reference: null };
    const sides = { run, challenger: { state: { lap: 1 } }, incumbentEvidence: { state: { lap: 1 } } };
    const facet = { id: "hud", title: "The race HUD", intent: "a race HUD" };
    const asked = (recorder: ReturnType<typeof ctxRecorder>) =>
      String((recorder.paramsOf("engine.complete")[0] as Record<string, any>).messages[0].content);

    const guarded = judgeOf();
    const doNotRegress = ["night lighting", "rain on the windscreen"];
    await tasteVeto(guarded.ctx as never, { ...sides, facet: { ...facet, doNotRegress }, random: () => 0.1 } as never);
    const user = asked(guarded);
    assert.match(user, /DO NOT REGRESS[^\n]*\n- night lighting\n- rain on the windscreen/, user);
    assert.match(user, /build A[^\n]*lost[^\n]*regression/i, "the build the checks accepted may not lose one");

    const bare = judgeOf();
    await tasteVeto(bare.ctx as never, { ...sides, facet, random: () => 0.1 } as never);
    assert.doesNotMatch(asked(bare), /DO NOT REGRESS/, "a part with no list hears nothing of it");
  });
});

describe("the goal ledger on every wake (director/progress.ts, wake.ts)", () => {
  it("AD-17. a goal build's lead hears how many required outcomes are verified on every wake, and is nudged to playtest the rest every 60 working minutes and after each ship review", async () => {
    const host = fakeHost();
    const clock = fakeClock(T0);
    const { loopRun } = fakeLoopRun(host, { answers: { [HostMethod.EngineComplete]: replying(SHIP_NO) }, ...INFINITE });
    loopRun.state.goals = createGoals([
      { id: "hud", done: ["the speed reads at a glance"] },
      { id: "track", done: ["a lap closes"] },
      { id: "radio", done: ["a station plays"], added: true },
    ]);
    const track = loopRun.state.goals.entries[1];
    track.status = GoalStatus.Passed;
    track.head = HEAD;
    // Its kept work is not merged yet: the art director's first look comes at 90 working minutes.
    busyWorkers(loopRun, ["hud"], ["hud"]);
    const at: number[] = [];
    const { talk, turns } = lead(() => {
      at.push(clock.at);
      if (clock.at >= T0 + 150 * MINUTE_MS) loopRun.state.finished = true;
      return DECIDED;
    });
    await runWakeLoop(loopRun, talk, BRIEF, clock);

    const minute = (ms: number) => Math.round((ms - T0) / MINUTE_MS);
    const wakes = turns.slice(1).map((t) => t.prompt);
    for (const prompt of wakes) assert.match(prompt, /required outcomes: 1\/2 verified[^\n]*hud/, prompt.slice(0, 600));
    assert.deepEqual(at.map(minute), [0, 20, 40, 60, 80, 90, 110, 130, 150]);
    const nudged = wakes.map((prompt, i) => (/VERIFY THE OUTCOMES/.test(prompt) ? minute(at[i + 1]!) : null));
    assert.deepEqual(
      nudged.filter((m) => m !== null),
      [60, 90, 150],
      "every 60 working minutes, and after the look at 90",
    );
    assert.match(wakes[2]!, /playtest goal=hud/);
  });
});
