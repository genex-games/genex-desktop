/**
 * The `finish-check` fixture: the fixture game's chat holds four Loops whose finish checks stand at
 * each of the owner's four looks, in the records the seed's finish check writes: one the reviewer
 * said yes to (Done); a timed one whose no's it went on past while it had time left, stopped by the
 * next near its end, each no naming what it found apart from what isn't done (Stopped); one sent back
 * once with two reasons, as an older record names them (Not yet); and, newest, one the reviewer is
 * checking now (Checking), so Builds opens on it.
 * The other three are in the Builds history.
 *
 * Three more games each end a Loop with something still to fix another way, as the harness closes
 * them (`run_finished.stillToFix`): a timed one whose hours ran out, one the person stopped (a pause,
 * which keeps Resume and no list), and a long one whose start lies beyond the chat's first page.
 *
 * It is written once the app has started: the start closes every run an earlier app left open, so
 * a Loop still going written before it would read as stopped.
 */
import { CustomEvent, customEventData, customRecord } from "../../shared/custom-events.ts";
import { type EventData, EventKind } from "../../shared/event-log.ts";
import { CHAT_PAGE_SIZE } from "../../shared/chat-history.ts";
import { HOUR_MS } from "../../shared/duration.ts";
import { FinishCheckStep, MAX_FINISH_REJECTIONS, StopWhy } from "../../shared/finish-check.ts";
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
const STILL_MET = "The car holds the road and the track reads fast, as before.";
const WHY_YES =
  "A full lap runs from start to the finish line, the timer counts on screen, and the car holds the road.";

/** The timed Loops' hours. */
const LOOP_HOURS = 5;
const LONG_LOOP_HOURS = 2;
/** Records between the long Loop's start and its close: more than a chat page holds. */
const LONG_LOOP_NOISE = CHAT_PAGE_SIZE + 40;
const DONE_ITEMS = ["The car is ported", "The track is built", "A full lap runs"];

/** The games whose Loops end another way, each with its own chat. */
export const LOOP_END_GAMES = {
  TimeUp: { name: "fixture-time-up", title: "Time Up Racer" },
  Stopped: { name: "fixture-stopped", title: "Stopped Racer" },
  Long: { name: "fixture-long-loop", title: "Long Racer" },
} as const;

/** Records of one run. */
type Scoped = ReturnType<typeof fixtureRun>;

const said = (role: "user" | "assistant", content: string): EventData => ({
  type: EventKind.Messages,
  messages: [{ role, content }],
});

/** A Loop's start with two workers whose work is in the game, as every Loop of the fixture begins. */
function loopStart(run: Scoped, hours: number | null = LOOP_HOURS): EventData[] {
  const car = { workerId: poolWorkerId("w1"), title: "Port the car", isolation: WorkerIsolation.Copy };
  const track = { workerId: poolWorkerId("w2"), title: "Build the track", isolation: WorkerIsolation.Copy };
  return [
    said("user", GOAL),
    run(CustomEvent.RunStarted, {
      goal: GOAL,
      engine: EngineId.ClaudeCode,
      model: FIXTURE_MODEL,
      ...(hours === null ? {} : { budgets: { wallClockMs: hours * HOUR_MS } }),
    }),
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

/** A no with its reasons (and what it found not done, when named), counted in the row; one with time left never stops. */
const no = (
  reasons: string[],
  rejections: number,
  more: { notDone?: string[]; done?: string[]; timeLeft?: boolean } = {},
) => ({
  step: FinishCheckStep.Rejected,
  reasons,
  ...(more.notDone ? { notDone: more.notDone } : {}),
  ...(more.done ? { done: more.done } : {}),
  rejections,
  ...(more.timeLeft ? { timeLeft: true } : {}),
  ...(!more.timeLeft && rejections >= MAX_FINISH_REJECTIONS ? { stopped: true } : {}),
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

/** The timed Loop that went on past three no's with time left, stopped by the next near its end. */
function stoppedLoop(project: string): EventData[] {
  const run = fixtureRun({ runId: STOPPED_RUN, project });
  const met = [STILL_MET];
  const done = DONE_ITEMS;
  return [
    ...loopStart(run),
    ...round(run, 1, no(met, 1, { notDone: [NO_FINISH_LINE, NO_TIMER], timeLeft: true })),
    ...round(run, 2, no(met, 2, { notDone: [NO_TIMER], timeLeft: true })),
    ...round(run, 3, no(met, MAX_FINISH_REJECTIONS, { notDone: [TIMER_RESETS], done, timeLeft: true })),
    ...round(run, 4, no(met, MAX_FINISH_REJECTIONS + 1, { notDone: [TIMER_RESETS], done })),
    run(CustomEvent.RunFinished, {
      victory: false,
      landed: false,
      executionStatus: ExecutionStatus.Completed,
      stoppedBecause: TIMER_RESETS,
      summary: `Still to fix: ${TIMER_RESETS}`,
      stillToFix: { done, notDone: [TIMER_RESETS], why: StopWhy.Stuck, hours: LOOP_HOURS },
    }),
  ];
}

/** A timed Loop's last no with time left, naming what is done and the timer still to fix. */
const lastNo = (run: Scoped) =>
  round(run, 1, no([STILL_MET], 1, { notDone: [TIMER_RESETS], done: DONE_ITEMS, timeLeft: true }));

/** A timed Loop whose hours ran out after a no: its close lists what is left and says its hours ran out. */
function timeUpLoop(project: string, hours = LOOP_HOURS, between: EventData[] = []): EventData[] {
  const run = fixtureRun({ runId: `fixture-finish-time-up-${project}`, project });
  return [
    ...loopStart(run, hours),
    ...between,
    ...lastNo(run),
    run(CustomEvent.RunFinished, {
      victory: false,
      landed: false,
      executionStatus: ExecutionStatus.Completed,
      stoppedBecause: "the time ran out",
      summary: `Still to fix: ${TIMER_RESETS}`,
      notDone: [TIMER_RESETS],
      stillToFix: { done: DONE_ITEMS, notDone: [TIMER_RESETS], why: StopWhy.Time, hours },
    }),
  ];
}

/** A Loop the person stopped after a no: a pause, which keeps its reason and Resume, with no list. */
function stoppedByPersonLoop(project: string): EventData[] {
  const run = fixtureRun({ runId: `fixture-finish-stopped-${project}`, project });
  return [
    ...loopStart(run),
    ...lastNo(run),
    run(CustomEvent.RunFinished, {
      victory: false,
      landed: false,
      executionStatus: ExecutionStatus.Paused,
      stoppedBecause: "stopped by the user",
    }),
    run(CustomEvent.AutopilotPaused, {}),
  ];
}

/** Each other game's Loop, as the harness would have closed it. */
export function loopEnds(): Array<{ game: { name: string; title: string }; events: EventData[] }> {
  const noise = Array.from({ length: LONG_LOOP_NOISE }, () =>
    customEventData(CustomEvent.FixtureNoise, { note: "Pushes the Loop's start past the chat's first page" }),
  );
  const { Long, Stopped, TimeUp } = LOOP_END_GAMES;
  return [
    { game: TimeUp, events: timeUpLoop(TimeUp.name) },
    { game: Stopped, events: stoppedByPersonLoop(Stopped.name) },
    { game: Long, events: timeUpLoop(Long.name, LONG_LOOP_HOURS, noise) },
  ];
}

/** Writes the other games' Loops once each; a profile reused after its first start keeps them. */
export async function seedLoopEnds(core: StudioCore): Promise<void> {
  for (const { game, events } of loopEnds()) {
    if (!(await core.games.exists(game.name))) await core.games.makeEmpty(game.name, { title: game.title });
    const thread = await core.threadForGame(game.name);
    const written = await core.store.listEvents(thread);
    if (!written.some((e) => customRecord(e.data)?.event_type === CustomEvent.RunFinished))
      await core.append(events, thread);
  }
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
