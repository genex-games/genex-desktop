/**
 * The lead's tool calls, answered: its notes (decision cards on the run's feed), its status (save
 * points, workers, the run's jobs, what the folder holds), Genex's worker tools through the run's own
 * pool (its copies merged into the game folder on the git-write queue the lead's saves share), its
 * save points, rewinds and restarts (save-point.ts), its pause for the person, and its `finish`
 * (finish.ts). A call is counted while it runs, so the chat never cuts the lead's turn short inside
 * one (wake.ts).
 */
import type { AnyRecord } from "../../../types/harness.d.ts";
import { HostMethod } from "../../host-methods.ts";
import { judgedPictures } from "../../judge-frames.ts";
import { askSecondOpinion, SECOND_OPINION_TOOL, SECOND_OPINION_WORDS } from "../../second-opinion.ts";
import { WorkerTool } from "../../workers/contract.ts";
import type { LoopRun } from "../loop-run.ts";
import { plainly } from "../rules.ts";
import { DirectorTool } from "../tool-specs.ts";
import { workAtHand } from "./active-work.ts";
import { closeUnderWay } from "../close-latch.ts";
import { OpenTool, restartsApp } from "./contract.ts";
import { openFinish } from "./finish.ts";
import { OPEN_WORDS } from "./prompts.ts";
import { restartTool, rewindTool, savePointTool } from "./save-point.ts";
import { finishAsked, wrapUp } from "../wrap-up.ts";
import { WRAP_UP_WORDS } from "../wrap-up-prompts.ts";

/** The longest note Genex keeps, and its plain sentence. */
const NOTE_CHARS = 2_000;
const NOTE_PLAIN_CHARS = 400;
/** The longest reason a pause gives the person. */
const PAUSE_CHARS = 600;

/** The worker tools the run's pool answers. */
const WORKER_TOOLS: readonly string[] = Object.values(WorkerTool);

/**
 * The lead's acts on the folder and the Loop: none once the lead paused the Loop, or it is closing. The
 * worker tools that change the folder (a start, a mark that merges) are among them; a worker's status,
 * its words and its stop are not.
 */
const LOOP_ACTS: ReadonlySet<string> = new Set<string>([
  ...Object.values(OpenTool),
  DirectorTool.Finish,
  WorkerTool.Start,
  WorkerTool.Mark,
]);

/** Why the lead's act is refused now (the Loop paused or closing; a worker once anybody asked to finish), or null. */
async function refusedAct(loopRun: LoopRun, name: string): Promise<string | null> {
  if (!LOOP_ACTS.has(name)) return null;
  if (loopRun.open.halted) return OPEN_WORDS.paused;
  const { state } = loopRun;
  const closing = state.finished || Boolean(state.finish) || closeUnderWay(state);
  if (closing) return OPEN_WORDS.ending;
  if (name !== WorkerTool.Start) return null;
  return (await finishAsked(loopRun)) ? WRAP_UP_WORDS.noWorkers : null;
}

/** A decision card on the run's feed, kept in the journal too. */
async function noteTool(loopRun: LoopRun, args: AnyRecord): Promise<string> {
  const text = String(args.text ?? "").trim();
  if (!text) return OPEN_WORDS.needsText;
  const plain = String(args.plain ?? "").trim();
  loopRun.journal.director.notes.push({
    at: new Date().toISOString(),
    text: text.slice(0, NOTE_CHARS),
    plain: plainly(plain || text).slice(0, NOTE_PLAIN_CHARS),
  });
  await loopRun.saveJournal();
  await loopRun.decision(text, plain || null);
  return OPEN_WORDS.noted;
}

/**
 * `pause`: the Loop pauses with the lead's words as its reason once this turn ends (the director's
 * close reads `open.halted`), so a block only the person can lift waits for them. The lead's time to
 * end its turn itself starts once the call has answered (`haltAnsweredAt`, director/news.ts).
 */
async function pauseTool(loopRun: LoopRun, args: AnyRecord): Promise<string> {
  const why = String(args.why ?? "").trim();
  if (!why) return OPEN_WORDS.needsWhy;
  const open = loopRun.open;
  open.halted = why.slice(0, PAUSE_CHARS);
  open.haltedAt = open.clock.now();
  try {
    await loopRun.saveJournal();
  } finally {
    open.haltAnsweredAt = open.clock.now();
  }
  return OPEN_WORDS.pausing;
}

/** The run's jobs as `run_status` lists them, or what the host said instead. */
async function jobsOf(loopRun: LoopRun): Promise<unknown> {
  const { ctx, run } = loopRun;
  const listed = await ctx.call(HostMethod.JobsList, { project: run.project, runId: run.runId }).catch(() => null);
  return Array.isArray(listed?.jobs) ? listed.jobs.map(({ id, title, state }) => ({ id, title, state })) : [];
}

/** `run_status`: the Loop's save points, its workers and jobs, and what the folder holds. */
export async function openStatus(loopRun: LoopRun): Promise<AnyRecord> {
  const { gameFacts, open } = loopRun;
  const pool = open.pool;
  return {
    savePoints: open.journal.savePoints.map(({ label, summary, auto }) => ({ label, summary, auto })),
    atWork: workAtHand(loopRun),
    workers: pool?.state.records.length ? await pool.call(WorkerTool.Status, {}) : "none started",
    jobs: await jobsOf(loopRun),
    facts: gameFacts ?? [],
    crashes: open.journal.crashes,
  };
}

/** A worker tool's answer from the run's pool. */
async function workerAnswer(loopRun: LoopRun, name: string, args: AnyRecord): Promise<unknown> {
  const pool = loopRun.open.pool;
  return pool ? pool.call(name, args) : OPEN_WORDS.unknownTool(name);
}

/**
 * A second opinion: the pictures the lead names in the project's folder (a motion strip's frames
 * among them, each with its game time) and its question, to a model that did none of the work.
 */
async function judgeTool(loopRun: LoopRun, args: AnyRecord): Promise<string> {
  const question = String(args.question ?? "").trim();
  if (!question) return SECOND_OPINION_WORDS.noQuestion;
  const pictures = await judgedPictures(loopRun.projectDir, args);
  if ("refused" in pictures) return pictures.refused;
  return askSecondOpinion(loopRun.ctx, { run: loopRun.run, question, ...pictures });
}

/** The Loop's save points, rewinds and restarts (a restart only where a plugin restarts the project's app); null for any other tool. */
function saveAnswer(loopRun: LoopRun, name: string, args: AnyRecord): Promise<string> | null {
  if (name === OpenTool.SavePoint) return savePointTool(loopRun, args);
  if (name === OpenTool.Rewind) return rewindTool(loopRun, args);
  if (name === OpenTool.Restart && restartsApp(loopRun.game)) return restartTool(loopRun);
  return null;
}

/** One tool call's answer: the pool's for a worker tool, else the Loop's own. */
async function answer(loopRun: LoopRun, name: string, args: AnyRecord): Promise<unknown> {
  const refused = await refusedAct(loopRun, name);
  if (refused) return refused;
  if (WORKER_TOOLS.includes(name)) return workerAnswer(loopRun, name, args);
  const saved = saveAnswer(loopRun, name, args);
  if (saved) return saved;
  if (name === OpenTool.Pause) return pauseTool(loopRun, args);
  if (name === DirectorTool.Note) return noteTool(loopRun, args);
  if (name === DirectorTool.WrapUp) return wrapUp(loopRun, args);
  if (name === DirectorTool.RunStatus) return JSON.stringify(await openStatus(loopRun));
  if (name === DirectorTool.Finish) return openFinish(loopRun, args);
  if (name === SECOND_OPINION_TOOL) return judgeTool(loopRun, args);
  return OPEN_WORDS.unknownTool(name);
}

/** The value the run's tool dispatch takes (`directors.set`): each call counted while it runs. */
export function openHandler(loopRun: LoopRun): (name: string, args: AnyRecord) => Promise<unknown> {
  return async (name, args) => {
    if (loopRun.ctx.cancelled) return OPEN_WORDS.stopped;
    loopRun.toolCalls++;
    loopRun.toolsInFlight = (loopRun.toolsInFlight ?? 0) + 1;
    try {
      return await answer(loopRun, name, args);
    } catch (err) {
      return `${name} failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      loopRun.toolsInFlight = (loopRun.toolsInFlight ?? 1) - 1;
    }
  };
}
