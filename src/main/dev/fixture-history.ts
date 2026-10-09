/**
 * The build history of the fixture game (`build-history`, `run-controls`, `sentinel`,
 * `studio-activity`): a first run whose base failed, and a lead's run that landed its build.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { CustomEvent } from "../../shared/custom-events.ts";
import { EventKind } from "../../shared/event-log.ts";
import { EngineId } from "../../shared/providers.ts";
import type { StudioCore } from "../studio-core.ts";
import { FIXTURE_MODEL, fixtureRun, roundShotDir, SHOT } from "./fixture-kit.ts";

const FIRST_RUN = "fixture-build-1";
const LANDED_RUN = "fixture-build-2";

/** The first run: two facets planned, the base refused, one round started, then stopped. */
export async function seedFirstLoopRun(core: StudioCore, project: string, threadId: string): Promise<void> {
  const run = fixtureRun({ runId: FIRST_RUN });
  const append = (...args: Parameters<typeof run>) => core.append([run(...args)], threadId);
  await append(CustomEvent.RunStarted, {
    project,
    engine: EngineId.Codex,
    model: FIXTURE_MODEL,
    goal: "A village beside a river",
  });
  await append(CustomEvent.AutopilotStarted, {
    maxParallel: 2,
    facets: [
      { id: "river", title: "River and bridge", budgetShare: 0.5 },
      { id: "cottages", title: "Timber cottages", budgetShare: 0.5 },
    ],
  });
  await append(CustomEvent.AutopilotBase, { ok: false, error: "Fixture base: camera views were identical" });
  await append(CustomEvent.FacetBuildStarted, { facetId: "river", facetTitle: "River and bridge", iteration: 1 });
  const dir = roundShotDir(core.layout.runs, FIRST_RUN, "river", 1);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "c1_default.jpg"), SHOT);
  const baseDir = path.join(core.layout.runs, FIRST_RUN, "base/screenshots");
  await fs.mkdir(baseDir, { recursive: true });
  await fs.writeFile(path.join(baseDir, "default.jpg"), SHOT);
  await append(CustomEvent.RunFinished, { victory: false, stoppedBecause: "fixture history" });
}

/**
 * Has this thread the landed run yet? The key is the run's own first event — a profile of the
 * older fixture carries an empty `fixture-build-2` pair, so the run id alone would leave exactly
 * that developer with the history this replaced.
 */
export async function hasLandedLoopRun(core: StudioCore, threadId: string): Promise<boolean> {
  return (await core.store.listEvents(threadId)).some(
    (e) =>
      e.data.type === EventKind.Custom &&
      e.data.event_type === CustomEvent.DirectorWorker &&
      (e.data.payload as { runId?: string })?.runId === LANDED_RUN,
  );
}

/**
 * A lead's run that landed its build: no shared base, builders instead of rounds of a plan, a
 * merged build the health pass passed, and a morning card with the run's report. Nothing here
 * rewrites the game's files or the history it already has.
 */
export async function seedLandedLoopRun(core: StudioCore, project: string, threadId: string): Promise<void> {
  const run = fixtureRun({ runId: LANDED_RUN });
  const append = (...args: Parameters<typeof run>) => core.append([run(...args)], threadId);
  const shots = await writeLandedShots(core.layout.runs);
  // judgeModel: the RUN card names the judge only when the run says who it is (M3.10).
  await append(CustomEvent.RunStarted, {
    project,
    engine: EngineId.ClaudeCode,
    model: FIXTURE_MODEL,
    judgeModel: "opus",
    goal: "Make the river run at dusk",
  });
  await append(CustomEvent.AutopilotStarted, { maxParallel: 2, director: true, facets: [] });
  // The lead says what this run is for before a builder starts (M3.8). waitMinutes 0: this run
  // was not held for a go, so the card asks for a change rather than promising a wait.
  await append(CustomEvent.AutopilotPlanReview, {
    waitMinutes: 0,
    summary: "This run: crash damage you can feel, and dirt that lands where the hits do.",
    facets: [
      { id: "crumple", title: "Crash damage", identity: [], cameras: [], checks: [] },
      { id: "dirt", title: "Dirt", identity: [], cameras: [], checks: [] },
    ],
  });
  await append(CustomEvent.DirectorWorker, { ...RIVER_WORKER, mode: "loop", state: "running" });
  await append(CustomEvent.DirectorWorker, { ...COTTAGES_WORKER, mode: "loop", state: "running" });
  await appendRounds(append, shots);
  await append(CustomEvent.IntegrationMerge, {
    facetId: "river",
    commit: "c0ffee1234",
    head: "beef1234aa",
    conflict: false,
    stage: "director",
  });
  await append(CustomEvent.IntegrationHealth, { head: "beef1234aa", ok: true, problems: [] });
  // Every look the lead takes leaves the same record (M3.1), and the Builds drawer shows the
  // newest one for the build on the stage in place of the run-wide progress line.
  await append(CustomEvent.DirectorVerdict, healthVerdict());
  await append(CustomEvent.DirectorShow, { target: "integration", root: "/fixture/integration" });
  await append(CustomEvent.DirectorWorker, {
    ...RIVER_WORKER,
    mode: "loop",
    state: "done",
    stoppedBecause: "the work it was given is done",
  });
  await append(CustomEvent.DirectorWorker, {
    ...COTTAGES_WORKER,
    mode: "loop",
    state: "stopped",
    stoppedBecause: "stopped by the director: the windows were not getting better",
  });
  await append(CustomEvent.DirectorVerdict, closeVerdict());
  await append(CustomEvent.RunFinished, {
    victory: false,
    landed: true,
    integrationHead: "beef1234aa",
    baseCommit: "5719bbb111",
    stoppedBecause: "the director finished the run",
    project,
    learned:
      "1 of 2 rounds were kept, most of them on The river. The studio has written down what worked for next time.",
    summary:
      "The river now catches the last of the light and moves; the cottage windows were tried twice and neither version was better than what you had, so they were left alone. One round kept, one undone.",
  });
}

const RIVER_WORKER = { workerId: "river", title: "Dusk light on the water" } as const;
const COTTAGES_WORKER = { workerId: "cottages", title: "Lit windows in the cottages" } as const;

type Shots = Record<"river" | "cottages", Array<{ camera: string; path: string }>>;

/** One capture per builder's first round. */
async function writeLandedShots(runsRoot: string): Promise<Shots> {
  const shots: Shots = { river: [], cottages: [] };
  for (const facetId of ["river", "cottages"] as const) {
    const dir = roundShotDir(runsRoot, LANDED_RUN, facetId, 1);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "c1_default.jpg");
    await fs.writeFile(file, SHOT);
    shots[facetId] = [{ camera: "default", path: file }];
  }
  return shots;
}

/**
 * The plan's checks and the judge's own questions counted apart (M3.2), and a structural move
 * the round did not deliver and was kept anyway (M3.3): the two sentences a dev profile could
 * not show before, since the card reads them off the round's own payload.
 */
async function appendRounds(
  append: (...args: Parameters<ReturnType<typeof fixtureRun>>) => Promise<unknown>,
  shots: Shots,
): Promise<void> {
  await append(CustomEvent.FacetIteration, {
    facetId: RIVER_WORKER.workerId,
    facetTitle: RIVER_WORKER.title,
    iteration: 1,
    winner: "challenger",
    verdictSource: "checks",
    reason: "the checks it was given now pass",
    shots: shots.river,
    scoreboard: {
      total: 6,
      passing: 4,
      unmeasured: 0,
      plannedTotal: 4,
      plannedPassing: 4,
      plannedUnmeasured: 0,
      grownTotal: 2,
      flips: ["water-moves", "defect-bank-flat"],
      plannedFlips: ["water-moves"],
      regressions: [],
      results: [],
    },
    move: {
      what: "a jetty the player can walk out on",
      source: "planner",
      mandatory: false,
      delivered: false,
      note: "the move was not delivered, and it did not cost the round: a jetty the player can walk out on",
    },
  });
  await append(CustomEvent.FacetIteration, {
    facetId: COTTAGES_WORKER.workerId,
    facetTitle: COTTAGES_WORKER.title,
    iteration: 1,
    winner: "incumbent",
    verdictSource: "invisible",
    reason: "nothing visible changed",
    shots: shots.cottages,
  });
}

/** What the lead saw and nobody judged: nothing at all. */
function unseen(pick: string | null) {
  return {
    pick,
    veto: null,
    satisfied: null,
    question: null,
    answer: null,
    alive: null,
    aliveMax: null,
    judgeCalls: 0,
  };
}

const NOTHING_MEASURED = { planned: [], grown: [], flips: [], regressions: [], unmeasured: [] };

function healthVerdict() {
  return {
    pass: "health",
    at: "2026-09-07T22:41:00.000Z",
    build: { head: "beef1234aa", worker: "river", round: null },
    against: { head: null, what: null },
    observed: { ok: true, problems: [], cameras: ["default"], demos: [], consoleFresh: [], consoleInherited: [] },
    measured: NOTHING_MEASURED,
    seen: unseen(null),
    decision: { kept: true, rule: "starts" },
    because: "It starts and draws its first frame.",
  };
}

function closeVerdict() {
  return {
    pass: "close",
    at: "2026-09-07T23:05:00.000Z",
    build: { head: "beef1234aa", worker: null, round: null },
    against: { head: null, what: "the game you had" },
    observed: { ok: true, problems: [], cameras: [], demos: [], consoleFresh: [], consoleInherited: [] },
    measured: NOTHING_MEASURED,
    seen: unseen("challenger"),
    decision: { kept: true, rule: "landed" },
    because: "Made live — a judge preferred it.",
  };
}
