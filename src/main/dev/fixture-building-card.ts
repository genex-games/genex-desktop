/**
 * The `building-card` fixture: a racing Loop still going, for the chat's Building card and its list
 * of parts, after five earlier Loops of the same chat that finished, so Builds holds its six builds
 * in the picker (more than its three tabs). Of the
 * plan's five parts two are added, one works on its second round with its time left, one was
 * stopped and restarted (`replaces`, one row) and works on its first round, and one has not
 * started; the Loop was given 4 hours, and its lead takes the chat's messages (live chat). Written
 * once the app has started: the start closes every run an earlier app left open, so a Loop still
 * going written before it would read as stopped.
 */
import { CustomEvent, customRecord } from "../../shared/custom-events.ts";
import { HOUR_MS, MINUTE_MS } from "../../shared/duration.ts";
import { type EventData, EventKind } from "../../shared/event-log.ts";
import { EngineId } from "../../shared/providers.ts";
import { WorkerEnd, WorkerIsolation, WorkerStopCode } from "../../shared/workers.ts";
import type { StudioCore } from "../studio-core.ts";
import { FIXTURE_MODEL, fixtureRun } from "./fixture-kit.ts";

const RUN_ID = "fixture-building-card";
const GOAL = "Make a night street race on rain-slicked city streets.";
/** One of the chat's earlier Loops, finished: what was asked, its plan, and each part's merged build. */
interface EarlierLoop {
  runId: string;
  goal: string;
  summary: string;
  parts: ReadonlyArray<[id: string, title: string, head: string]>;
}

/** The chat's earlier Loops, oldest first: with this one, more builds than Builds shows as tabs. */
const EARLIER: readonly EarlierLoop[] = [
  {
    runId: "fixture-building-card-earlier",
    goal: "Give the cars arcade handling and a drift boost.",
    summary: "Arcade handling for every car, and a boost for holding a drift.",
    parts: [
      ["handling", "Arcade handling", "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d"],
      ["drift", "Drift boost", "0b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e"],
    ],
  },
  {
    runId: "fixture-building-card-laps",
    goal: "Add a lap timer and a ghost car of my best lap.",
    summary: "A lap timer, and a ghost replaying the best lap.",
    parts: [["laps", "Lap timer and best-lap ghost", "0c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f"]],
  },
  {
    runId: "fixture-building-card-camera",
    goal: "Please fix the camera shaking on sharp turns.",
    summary: "A chase camera that stays steady through tight corners.",
    parts: [["camera", "Steady chase camera", "0d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60"]],
  },
  {
    runId: "fixture-building-card-rain",
    goal: "Put rain and puddle reflections on the night streets.",
    summary: "Rain over the city, and the street lights in its puddles.",
    parts: [["rain", "Rain and puddle reflections", "0e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6071"]],
  },
  {
    runId: "fixture-building-card-garage",
    goal: "Add a garage screen where I can pick my car's color.",
    summary: "A garage before each race, with a paint picker.",
    parts: [["garage", "Garage and paint picker", "0f60718293a4b5c6d7e8f90a1b2c3d4e5f607182"]],
  },
];
/** The time the Loop was given, shown under the card's clock ("up to 4h"). */
const LOOP_MS = 4 * HOUR_MS;
/** How long the car part's round has left when the fixture is written. */
const CARS_LEFT_MS = 25 * MINUTE_MS;

/** The plan's parts, in its order: id and title. */
const PLAN: ReadonlyArray<[string, string]> = [
  ["hud", "Speed and lap HUD"],
  ["track", "Track and night city"],
  ["cars", "Cars: clear-coat finish"],
  ["world", "World: building facades"],
  ["sound", "Engine, tyres and rain"],
];

/** Records of the run. */
type Scoped = ReturnType<typeof fixtureRun>;

/** A worker starting its first round. */
function begins(run: Scoped, workerId: string, title: string, extra: Record<string, unknown> = {}): EventData[] {
  return [
    run(CustomEvent.WorkerStarted, { workerId, title, isolation: WorkerIsolation.Copy, task: title }),
    run(CustomEvent.DirectorWorker, { workerId, title, mode: "loop", state: "running", ...extra }),
    run(CustomEvent.FacetBuildStarted, { facetId: workerId, facetTitle: title, iteration: 1 }),
  ];
}

/** A round's end: judged and kept, or stopped before a verdict. */
function roundEnds(run: Scoped, workerId: string, title: string, stopped: string | null): EventData {
  return run(CustomEvent.FacetIteration, {
    facetId: workerId,
    facetTitle: title,
    iteration: 1,
    winner: stopped ? null : "challenger",
    satisfied: false,
    verdictSource: stopped ? "stopped" : "checks",
    reason: stopped ?? "the checks it was given now pass",
    shots: [],
    flags: [],
    diffs: {},
  });
}

/** A worker whose kept round the lead merged into the build. */
function added(run: Scoped, workerId: string, title: string, head: string): EventData[] {
  return [
    ...begins(run, workerId, title),
    roundEnds(run, workerId, title, null),
    run(CustomEvent.DirectorWorker, { workerId, title, mode: "loop", state: "done" }),
    run(CustomEvent.WorkerFinished, { workerId, title, state: WorkerEnd.Done }),
    run(CustomEvent.IntegrationMerge, { facetId: workerId, commit: head, head, conflict: false, stage: "director" }),
  ];
}

/** One of the chat's earlier Loops: its ask, its plan, every part added, and its close. */
function finishedLoop(project: string, loop: EarlierLoop): EventData[] {
  const run = fixtureRun({ runId: loop.runId, project });
  return [
    { type: EventKind.Messages, messages: [{ role: "user", content: loop.goal }] },
    run(CustomEvent.RunStarted, { goal: loop.goal, engine: EngineId.ClaudeCode, model: FIXTURE_MODEL }),
    run(CustomEvent.AutopilotStarted, { director: true, maxParallel: 2, facets: [], workerRecords: true }),
    run(CustomEvent.AutopilotPlanReview, {
      summary: loop.summary,
      waitMinutes: 0,
      facets: loop.parts.map(([id, title]) => ({ id, title, identity: [], cameras: [], checks: [] })),
    }),
    ...loop.parts.flatMap(([id, title, head]) => added(run, id, title, head)),
    run(CustomEvent.RunFinished, { stoppedBecause: "every part was added and checked" }),
  ];
}

/** The Loop: its plan, two parts added, one at work with its time left, one restarted, one waiting. */
function buildingLoop(project: string, now: number): EventData[] {
  const run = fixtureRun({ runId: RUN_ID, project });
  const stopped = "stopped by the director: the facades start again on the new street grid";
  return [
    { type: EventKind.Messages, messages: [{ role: "user", content: GOAL }] },
    run(CustomEvent.RunStarted, {
      goal: GOAL,
      engine: EngineId.ClaudeCode,
      model: FIXTURE_MODEL,
      budgets: { wallClockMs: LOOP_MS },
    }),
    run(CustomEvent.AutopilotStarted, {
      director: true,
      maxParallel: 3,
      facets: [],
      workerRecords: true,
      liveChat: true,
    }),
    run(CustomEvent.AutopilotPlanReview, {
      summary: "A night street race: a lit circuit, cars with a wet finish, and their sound.",
      waitMinutes: 0,
      facets: PLAN.map(([id, title]) => ({ id, title, identity: [], cameras: [], checks: [] })),
    }),
    ...added(run, "hud", "Speed and lap HUD", "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d"),
    ...added(run, "track", "Track and night city", "2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e"),
    run(CustomEvent.WorkerStarted, {
      workerId: "cars",
      title: "Cars: clear-coat finish",
      isolation: WorkerIsolation.Copy,
    }),
    run(CustomEvent.DirectorWorker, {
      workerId: "cars",
      title: "Cars: clear-coat finish",
      mode: "loop",
      state: "running",
    }),
    run(CustomEvent.FacetBuildStarted, {
      facetId: "cars",
      facetTitle: "Cars: clear-coat finish",
      iteration: 2,
      deadlineMs: now + CARS_LEFT_MS,
    }),
    ...begins(run, "world", "World: building facades"),
    roundEnds(run, "world", "World: building facades", stopped),
    run(CustomEvent.DirectorWorker, {
      workerId: "world",
      title: "World: building facades",
      mode: "loop",
      state: "stopped",
      stoppedBecause: stopped,
    }),
    run(CustomEvent.WorkerFinished, {
      workerId: "world",
      title: "World: building facades",
      state: WorkerEnd.Stopped,
      stopCode: WorkerStopCode.StoppedByLead,
    }),
    ...begins(run, "world-2", "World: building facades", { replaces: "world" }),
  ];
}

/** Writes the Loop into the game's chat once; a profile reused after its first start keeps it. */
export async function seedBuildingCard(core: StudioCore, project: string, threadId: string): Promise<void> {
  const events = await core.store.listEvents(threadId);
  if (events.some((e) => customRecord(e.data)?.payload.runId === RUN_ID)) return;
  const earlier = EARLIER.flatMap((loop) => finishedLoop(project, loop));
  await core.append([...earlier, ...buildingLoop(project, Date.now())], threadId);
}
