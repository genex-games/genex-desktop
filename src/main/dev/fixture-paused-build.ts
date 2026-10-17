/**
 * The `paused-build` fixture: a racing Loop your plan's usage limit paused while three workers
 * built, then resumed. On Builds one worker's try is Paused (its work kept, not added yet), one is
 * Added (the lead brought its kept work in after the resume) and one is Left out (the lead stopped
 * it itself). Written once the app has started: the start closes every run an earlier app left
 * open, so a Loop still going written before it would read as stopped.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { CustomEvent, customRecord } from "../../shared/custom-events.ts";
import { type EventData, EventKind } from "../../shared/event-log.ts";
import { EngineId } from "../../shared/providers.ts";
import { ExecutionStatus } from "../../shared/run-state.ts";
import { WorkerEnd, WorkerIsolation, WorkerStopCode } from "../../shared/workers.ts";
import type { StudioCore } from "../studio-core.ts";
import { FIXTURE_MODEL, fixtureRun, gradientShot, type Rgb, roundShotDir } from "./fixture-kit.ts";

const RUN_ID = "fixture-paused-build";
const GOAL = "Make a night street race on rain-slicked city streets.";
const PAUSE_REASON = "stopped by the director: the build is over";
const LEAD_REASON = "stopped by the director: the rival bodies wait for the new car";

/** One worker of the Loop: its part, its move, how its try stopped and its picture's colours. */
interface PausedPart {
  facetId: string;
  facetTitle: string;
  move: string;
  stopCode: WorkerStopCode;
  reason: string;
  from: Rgb;
  to: Rgb;
}

/** The three workers: kept and not added yet, added after the resume, and stopped by the lead. */
const PARTS: readonly PausedPart[] = [
  {
    facetId: "world",
    facetTitle: "Track and night city",
    move: "The ribbon-and-boxes circuit becomes a real street circuit in a lit night city",
    stopCode: WorkerStopCode.RunEnded,
    reason: PAUSE_REASON,
    from: [24, 28, 44],
    to: [214, 150, 72],
  },
  {
    facetId: "handling",
    facetTitle: "Driving model and cameras",
    move: "The bicycle model becomes a heavy, grippy car that drifts on the handbrake",
    stopCode: WorkerStopCode.RunEnded,
    reason: PAUSE_REASON,
    from: [30, 34, 52],
    to: [196, 62, 74],
  },
  {
    facetId: "carmodel",
    facetTitle: "Hero car and rival bodies",
    move: "The box-and-cylinder car becomes a modelled hero coupe with three rival bodies",
    stopCode: WorkerStopCode.StoppedByLead,
    reason: LEAD_REASON,
    from: [36, 40, 58],
    to: [120, 170, 210],
  },
];

/** The worker whose kept work the lead brought in after the resume. */
const ADDED = "handling";

/** Records of the run. */
type Scoped = ReturnType<typeof fixtureRun>;

/** One worker's first try: started, asked its move, stopped before a verdict with its picture, and its end. */
function stoppedTry(run: Scoped, part: PausedPart, shot: string): EventData[] {
  const { facetId, facetTitle, move, stopCode, reason } = part;
  const attemptBranch = `refs/studio/runs/${RUN_ID}/attempts/${facetId}/1-stopped`;
  const worker = { workerId: facetId, title: facetTitle };
  return [
    run(CustomEvent.WorkerStarted, { ...worker, isolation: WorkerIsolation.Copy, task: move }),
    run(CustomEvent.DirectorWorker, { ...worker, mode: "loop", state: "running" }),
    run(CustomEvent.FacetBuildStarted, { facetId, facetTitle, iteration: 1 }),
    run(CustomEvent.FacetMove, { facetId, facetTitle, iteration: 1, what: move, source: "milestone", delivered: null }),
    run(CustomEvent.FacetStopped, { facetId, iteration: 1, by: "director", reason, attemptBranch, stopCode }),
    run(CustomEvent.FacetIteration, {
      facetId,
      facetTitle,
      iteration: 1,
      winner: null,
      satisfied: false,
      verdictSource: "stopped",
      reason,
      attemptBranch,
      stopCode,
      shots: [{ camera: "default", path: shot }],
      flags: [],
      diffs: {},
    }),
    run(CustomEvent.DirectorWorker, { ...worker, mode: "loop", state: "stopped", stoppedBecause: reason }),
    run(CustomEvent.WorkerFinished, { ...worker, state: WorkerEnd.Stopped, stoppedBecause: reason, stopCode }),
  ];
}

/** Write a worker's picture where the loop keeps a round's captures, and answer its path. */
async function writeShot(core: StudioCore, part: PausedPart): Promise<string> {
  const dir = roundShotDir(core.layout.runs, RUN_ID, part.facetId, 1);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "c1_default.jpg");
  await fs.writeFile(file, gradientShot(part.from, part.to));
  return file;
}

/** The Loop: three workers, the limit's pause, the resume, and the lead bringing one's work in. */
async function pausedLoop(core: StudioCore, project: string): Promise<EventData[]> {
  const run = fixtureRun({ runId: RUN_ID, project });
  const tries: EventData[] = [];
  for (const part of PARTS) tries.push(...stoppedTry(run, part, await writeShot(core, part)));
  return [
    { type: EventKind.Messages, messages: [{ role: "user", content: GOAL }] },
    run(CustomEvent.RunStarted, { goal: GOAL, engine: EngineId.ClaudeCode, model: FIXTURE_MODEL }),
    run(CustomEvent.AutopilotStarted, { director: true, maxParallel: 3, facets: [], workerRecords: true }),
    ...tries,
    run(CustomEvent.RunFinished, { victory: false, landed: false, executionStatus: ExecutionStatus.Paused }),
    run(CustomEvent.AutopilotPaused, { reason: "limit" }),
    run(CustomEvent.RunAutoResumed, { cause: "limit-reset", attempt: 1 }),
    run(CustomEvent.RunStarted, { goal: GOAL, engine: EngineId.ClaudeCode, model: FIXTURE_MODEL }),
    run(CustomEvent.AutopilotStarted, {
      director: true,
      maxParallel: 3,
      facets: [],
      workerRecords: true,
      resumed: true,
    }),
    run(CustomEvent.IntegrationMerge, {
      facetId: ADDED,
      commit: "84547ed",
      head: "22948ef",
      conflict: false,
      stage: "director",
    }),
  ];
}

/** Writes the Loop into the game's chat once; a profile reused after its first start keeps it. */
export async function seedPausedBuild(core: StudioCore, project: string, threadId: string): Promise<void> {
  const events = await core.store.listEvents(threadId);
  if (events.some((e) => customRecord(e.data)?.payload.runId === RUN_ID)) return;
  await core.append(await pausedLoop(core, project), threadId);
}
