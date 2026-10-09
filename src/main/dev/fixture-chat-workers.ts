/**
 * The `chat-workers` fixture: workers on the Builds graph and in the chat, in the records the
 * seed's worker pool and the app's jobs write. The fixture game's chat holds an earlier Loop, then
 * a chat message whose two workers ended (one checked, one's work added to the game), so Builds
 * opens on that chat turn. A second game holds a Loop still going: three workers, the lead's
 * background work and the finish check that has not run yet. A third game holds the build-graph
 * fixture's two web Loops, their builders writing the worker records a director writes today; a
 * fourth the lead-graph fixture's Unreal lead runs, their typed workers writing theirs.
 *
 * The Loop is written once the app has started ({@link seedChatWorkersLoop}): the start closes
 * every run an earlier app left open, so a Loop written before it would read as stopped.
 */
import { CustomEvent, customEventData, customRecord } from "../../shared/custom-events.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { type EventData, EventKind } from "../../shared/event-log.ts";
import { JobRole, JobState } from "../../shared/jobs.ts";
import { EngineId } from "../../shared/providers.ts";
import { ExecutionStatus } from "../../shared/run-state.ts";
import { poolWorkerId, WorkerEnd, WorkerIsolation, WorkerVerdict } from "../../shared/workers.ts";
import type { StudioCore } from "../studio-core.ts";
import { seedBuildGraph } from "./fixture-build-graph.ts";
import { seedLeadGraph } from "./fixture-lead-graph.ts";
import { FIXTURE_MODEL, fixtureRun } from "./fixture-kit.ts";

/** The earlier Loop of the fixture game: the key that says its chat is seeded. */
const EARLIER_LOOP = "fixture-workers-earlier";
/** The chat message whose workers Builds shows. */
const TURN = "fixture-workers-turn";
/** The second game and its Loop still going. */
const LOOP_GAME = { name: "fixture-loop", title: "Fixture Loop" } as const;
const LOOP_RUN = "fixture-workers-loop";
/** The third game: the build-graph fixture's web Loops, with the worker records their builders write. */
const WEB_LOOP_GAME = { name: "fixture-web-loop", title: "Fixture web Loop" } as const;
/** The web Loops' finished run: the key that says that game is seeded. */
const WEB_LOOP_RUN = "fixture-graph-run";
/** The fourth game: the lead-graph fixture's Unreal lead runs, with the worker records their typed workers write. */
const UNREAL_LOOP_GAME = { name: "fixture-unreal-loop", title: "Fixture Unreal Loop" } as const;
/** The Unreal lead's finished run: the key that says that game is seeded. */
const UNREAL_LOOP_RUN = "fixture-lead-done";

const ASK = "The car drifts left on straight roads. Find out why and fix it.";
const LOOP_ASK = "Port the racer's car and build a fast track for it.";

/** How long the fixture's jobs ran, and how long ago the running one started. */
const JOB_RAN_MS = 3 * MINUTE_MS;
const JOB_RUNNING_FOR_MS = 4 * MINUTE_MS;
/** How long a job may run before it is stopped, as the job service gives one. */
const JOB_DEADLINE_MS = 120 * MINUTE_MS;

/** One worker of the fixture: its graph id, title, how it stands in the game and its task. */
interface FixtureWorker {
  id: string;
  title: string;
  isolation: WorkerIsolation;
  task: string;
}

const PHYSICS: FixtureWorker = {
  id: poolWorkerId("w1"),
  title: "Check the physics",
  isolation: WorkerIsolation.Read,
  task: "Find why the car pulls left on a straight road; report the cause.",
};
const STEERING: FixtureWorker = {
  id: poolWorkerId("w2"),
  title: "Center the steering",
  isolation: WorkerIsolation.Copy,
  task: "Center the front wheels so the car holds a straight line.",
};
const STUDY: FixtureWorker = {
  id: poolWorkerId("w1"),
  title: "Study the web game",
  isolation: WorkerIsolation.Read,
  task: "Read the web game and list what the car and the track need.",
};
const CAR: FixtureWorker = {
  id: poolWorkerId("w2"),
  title: "Port the car",
  isolation: WorkerIsolation.Copy,
  task: "Port the car's handling and model into the game.",
};
const TRACK: FixtureWorker = {
  id: poolWorkerId("w3"),
  title: "Build the track",
  isolation: WorkerIsolation.Lock,
  task: "Build a fast track with long straights and two hairpins.",
};

const said = (role: "user" | "assistant", content: string): EventData => ({
  type: EventKind.Messages,
  messages: [{ role, content }],
});

/** A message the composer sent, the queue's receipt and the turn that answers it. */
function answered(messageId: string, text: string, answer: EventData[]): EventData[] {
  return [
    said("user", text),
    customEventData(CustomEvent.CoordinatorMessageQueued, { messageId, action: { text } }),
    customEventData(CustomEvent.CoordinatorMessageProcessing, { messageId }),
    ...answer,
    customEventData(CustomEvent.CoordinatorMessageHandled, { messageId }),
  ];
}

/** Records of one scope: a run's (`runId`) or a chat turn's (`turn`). */
type Scoped = ReturnType<typeof fixtureRun>;

/** A worker's start, as the pool writes it. */
function started(record: Scoped, worker: FixtureWorker, extra: { [key: string]: unknown } = {}): EventData {
  const { id, title, isolation, task } = worker;
  return record(CustomEvent.WorkerStarted, { workerId: id, title, isolation, task, ...extra });
}

/** A worker's end, or (with a verdict and no state) the lead's word on it. */
function finished(record: Scoped, worker: FixtureWorker, extra: { [key: string]: unknown }): EventData {
  return record(CustomEvent.WorkerFinished, { workerId: worker.id, title: worker.title, ...extra });
}

/**
 * Seeds the fixture game's chat once and adds the second game; a profile reused after its first
 * start keeps both.
 */
export async function seedChatWorkers(core: StudioCore, project: string, threadId: string): Promise<void> {
  if (await hasRun(core, threadId, EARLIER_LOOP)) return;
  await core.append([...earlierLoop(project), ...chatTurn(project)], threadId);
  const games = await core.games.list();
  for (const game of [LOOP_GAME, WEB_LOOP_GAME, UNREAL_LOOP_GAME]) {
    if (!games.some((known) => known.name === game.name)) await core.games.scaffold(game.name, { title: game.title });
    await core.threadForGame(game.name);
  }
}

/**
 * Writes the second game's Loop still going, the third game's web Loops and the fourth game's
 * Unreal lead runs, once, after the app has started.
 */
export async function seedChatWorkersLoop(core: StudioCore): Promise<void> {
  const threadId = await core.threadForGame(LOOP_GAME.name);
  if (!(await hasRun(core, threadId, LOOP_RUN)))
    await core.append(loopStillGoing(LOOP_GAME.name, Date.now()), threadId);
  const webThread = await core.threadForGame(WEB_LOOP_GAME.name);
  if (!(await hasRun(core, webThread, WEB_LOOP_RUN)))
    await seedBuildGraph(core, WEB_LOOP_GAME.name, webThread, { builderRecords: true });
  const unrealThread = await core.threadForGame(UNREAL_LOOP_GAME.name);
  if (!(await hasRun(core, unrealThread, UNREAL_LOOP_RUN)))
    await seedLeadGraph(core, UNREAL_LOOP_GAME.name, unrealThread, { workerRecords: true });
}

/** Whether the chat's log already holds a record of this run (the seed writes it once). */
async function hasRun(core: StudioCore, threadId: string, runId: string): Promise<boolean> {
  return (await core.store.listEvents(threadId)).some((e) => customRecord(e.data)?.payload.runId === runId);
}

/** An earlier Loop of the fixture game that started no worker and finished. */
function earlierLoop(project: string): EventData[] {
  const run = fixtureRun({ runId: EARLIER_LOOP, project });
  const goal = "Give the rally car a dust trail.";
  return answered("fixture-workers-loop-ask", goal, [
    run(CustomEvent.RunStarted, { goal, engine: EngineId.ClaudeCode, model: FIXTURE_MODEL }),
    run(CustomEvent.AutopilotStarted, { director: true, maxParallel: 1, facets: [] }),
    run(CustomEvent.RunFinished, {
      landed: false,
      stoppedBecause: "the lead finished",
      executionStatus: ExecutionStatus.Completed,
      summary: "The dust trail follows the car on gravel.",
    }),
  ]);
}

/** The chat message whose two workers ended: one found the cause, one's work was added to the game. */
function chatTurn(project: string): EventData[] {
  const turn = fixtureRun({ turn: TURN, project });
  return answered(TURN, ASK, [
    said("assistant", "I'll put two workers on it: one checks the physics, one centers the steering."),
    started(turn, PHYSICS, { ask: ASK }),
    started(turn, STEERING, { ask: ASK }),
    finished(turn, PHYSICS, {
      state: WorkerEnd.Done,
      summary: "Checked the physics: the front wheels sit off center.",
    }),
    finished(turn, STEERING, { state: WorkerEnd.Done, summary: "Centered the steering.", delivered: true }),
    finished(turn, STEERING, { verdict: WorkerVerdict.Used, merged: true }),
    said("assistant", "Fixed. The front wheels sat off center, so the car pulled left at speed."),
  ]);
}

/** The Loop still going: one worker done, one's work added, one working, and the lead's jobs. */
function loopStillGoing(project: string, now: number): EventData[] {
  const run = fixtureRun({ runId: LOOP_RUN, project });
  return answered("fixture-workers-loop-start", LOOP_ASK, [
    run(CustomEvent.RunStarted, { goal: LOOP_ASK, engine: EngineId.ClaudeCode, model: FIXTURE_MODEL }),
    run(CustomEvent.AutopilotStarted, { director: true, maxParallel: 3, facets: [], workerRecords: true }),
    started(run, STUDY),
    started(run, CAR),
    started(run, TRACK),
    ...finishedJob(run, project, { jobId: "fixture-job-1", title: "Texture bake", endedAt: now - 2 * JOB_RAN_MS }),
    ...finishedJob(run, project, { jobId: "fixture-job-2", title: "Audio mix", endedAt: now - JOB_RAN_MS }),
    jobStarted(run, project, { jobId: "fixture-job-3", title: "Track build", startedAt: now - JOB_RUNNING_FOR_MS }),
    finished(run, STUDY, { state: WorkerEnd.Done, summary: "Studied the web game." }),
    finished(run, CAR, { state: WorkerEnd.Done, summary: "Ported the car.", delivered: true }),
    finished(run, CAR, { verdict: WorkerVerdict.Used, merged: true }),
  ]);
}

/** A job the lead started, as the app records its start. */
function jobStarted(run: Scoped, project: string, job: { jobId: string; title: string; startedAt: number }) {
  return run(CustomEvent.JobStarted, {
    jobId: job.jobId,
    project,
    title: job.title,
    command: "npm run build",
    cwd: ".",
    startedAt: new Date(job.startedAt).toISOString(),
    role: JobRole.Lead,
    deadlineAt: new Date(job.startedAt + JOB_DEADLINE_MS).toISOString(),
  });
}

/** A job the lead started that finished on its own, its start and its end. */
function finishedJob(run: Scoped, project: string, job: { jobId: string; title: string; endedAt: number }) {
  const startedAt = job.endedAt - JOB_RAN_MS;
  return [
    jobStarted(run, project, { jobId: job.jobId, title: job.title, startedAt }),
    run(CustomEvent.JobEnded, {
      jobId: job.jobId,
      project,
      title: job.title,
      state: JobState.Succeeded,
      exitCode: 0,
      signal: null,
      endedAt: new Date(job.endedAt).toISOString(),
      durationMs: JOB_RAN_MS,
    }),
  ];
}
