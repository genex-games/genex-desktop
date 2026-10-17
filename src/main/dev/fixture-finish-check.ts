/**
 * The `finish-check` fixture: the fixture game's chat holds four Loops whose finish checks stand at
 * each of the owner's four looks, in the records the seed's finish check writes: one the reviewer
 * said yes to (Done), one stopped by three no's in a row (Stopped), one sent back once with two
 * reasons (Not yet) and, newest, one the reviewer is checking now (Checking), so Builds opens on it.
 * The other three are in the Builds history.
 *
 * It is written once the app has started: the start closes every run an earlier app left open, so
 * a Loop still going written before it would read as stopped.
 */
import { CustomEvent, customRecord } from "../../shared/custom-events.ts";
import { type EventData, EventKind } from "../../shared/event-log.ts";
import { FinishCheckStep, MAX_FINISH_REJECTIONS } from "../../shared/finish-check.ts";
import { EngineId } from "../../shared/providers.ts";
import { ExecutionStatus } from "../../shared/run-state.ts";
import { poolWorkerId, WorkerEnd, WorkerIsolation, WorkerVerdict } from "../../shared/workers.ts";
import type { StudioCore } from "../studio-core.ts";
import { FIXTURE_MODEL, fixtureRun } from "./fixture-kit.ts";

/** The four Loops, oldest first; the first one's id says the chat is seeded. */
const DONE_RUN = "fixture-finish-done";
const STOPPED_RUN = "fixture-finish-stopped";
const NOT_YET_RUN = "fixture-finish-not-yet";
const CHECKING_RUN = "fixture-finish-checking";

const GOAL = "Port the web racer and make the track feel fast.";
const CLAIM = "A full lap runs from the start to the finish line, and the lap timer counts on screen.";
const NO_FINISH_LINE = "The track has no finish line, so a lap never ends.";
const NO_TIMER = "The lap timer isn't on screen in any shot.";
const TIMER_RESETS = "The finish line triggers, but the lap timer still resets when the car respawns.";
const WHY_YES =
  "A full lap runs from start to the finish line, the timer counts on screen, and the car holds the road.";

/** Records of one run. */
type Scoped = ReturnType<typeof fixtureRun>;

const said = (role: "user" | "assistant", content: string): EventData => ({
  type: EventKind.Messages,
  messages: [{ role, content }],
});

/** A Loop's start with two workers whose work is in the game, as every Loop of the fixture begins. */
function loopStart(run: Scoped): EventData[] {
  const car = { workerId: poolWorkerId("w1"), title: "Port the car", isolation: WorkerIsolation.Copy };
  const track = { workerId: poolWorkerId("w2"), title: "Build the track", isolation: WorkerIsolation.Copy };
  return [
    said("user", GOAL),
    run(CustomEvent.RunStarted, { goal: GOAL, engine: EngineId.ClaudeCode, model: FIXTURE_MODEL }),
    run(CustomEvent.AutopilotStarted, { director: true, maxParallel: 2, facets: [], workerRecords: true }),
    ...[car, track].flatMap((worker) => [
      run(CustomEvent.WorkerStarted, { ...worker, task: `${worker.title}, then report.` }),
      run(CustomEvent.WorkerFinished, {
        ...worker,
        state: WorkerEnd.Done,
        summary: `${worker.title}.`,
        delivered: true,
      }),
      run(CustomEvent.WorkerFinished, { ...worker, verdict: WorkerVerdict.Used, merged: true }),
    ]),
  ];
}

/** One round of the check: the reviewer starts with the lead's claim, then answers (when it has). */
function round(run: Scoped, n: number, answer: { [key: string]: unknown } | null): EventData[] {
  const checking = run(CustomEvent.FinishCheck, { round: n, step: FinishCheckStep.Checking, claim: CLAIM });
  return answer ? [checking, run(CustomEvent.FinishCheck, { round: n, ...answer })] : [checking];
}

/** A no with its reasons, counted in the row. */
const no = (reasons: string[], rejections: number) => ({
  step: FinishCheckStep.Rejected,
  reasons,
  rejections,
  ...(rejections >= MAX_FINISH_REJECTIONS ? { stopped: true } : {}),
});

/** The Loop the reviewer said yes to, closed with its goal reached. */
function doneLoop(project: string): EventData[] {
  const run = fixtureRun({ runId: DONE_RUN, project });
  return [
    ...loopStart(run),
    ...round(run, 1, no([NO_FINISH_LINE], 1)),
    ...round(run, 2, { step: FinishCheckStep.Accepted, reasons: [WHY_YES], rejections: 0 }),
    run(CustomEvent.RunFinished, {
      victory: true,
      landed: true,
      executionStatus: ExecutionStatus.Completed,
      summary: "A full lap runs and the timer counts on screen.",
    }),
  ];
}

/** The Loop three no's in a row stopped, closed with what isn't done. */
function stoppedLoop(project: string): EventData[] {
  const run = fixtureRun({ runId: STOPPED_RUN, project });
  return [
    ...loopStart(run),
    ...round(run, 1, no([NO_FINISH_LINE, NO_TIMER], 1)),
    ...round(run, 2, no([NO_TIMER], 2)),
    ...round(run, 3, no([TIMER_RESETS], 3)),
    run(CustomEvent.RunFinished, {
      victory: false,
      landed: false,
      executionStatus: ExecutionStatus.Completed,
      stoppedBecause: TIMER_RESETS,
      summary: `Not done: ${TIMER_RESETS}`,
    }),
  ];
}

/** The Loop sent back once with two reasons; its lead goes on working. */
function notYetLoop(project: string): EventData[] {
  const run = fixtureRun({ runId: NOT_YET_RUN, project });
  return [...loopStart(run), ...round(run, 1, no([NO_FINISH_LINE, NO_TIMER], 1))];
}

/** The Loop whose lead just claimed the goal: the reviewer is checking. */
function checkingLoop(project: string): EventData[] {
  const run = fixtureRun({ runId: CHECKING_RUN, project });
  return [...loopStart(run), ...round(run, 1, null)];
}

/** Writes the four Loops into the game's chat once; a profile reused after its first start keeps them. */
export async function seedFinishCheck(core: StudioCore, project: string, threadId: string): Promise<void> {
  const events = await core.store.listEvents(threadId);
  if (events.some((e) => customRecord(e.data)?.payload.runId === DONE_RUN)) return;
  await core.append(
    [...doneLoop(project), ...stoppedLoop(project), ...notYetLoop(project), ...checkingLoop(project)],
    threadId,
  );
}
