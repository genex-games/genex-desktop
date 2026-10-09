/**
 * A worker's one line in the chat, read from its records (`worker_started`, `worker_finished` with
 * its end, then the lead's verdict) that may be old or partial: a field of the wrong type is left
 * out, and a record that names no worker or no task draws nothing. How a worker stands in the game
 * (`isolation`) never reaches the line; the engine it works in picks "in Unreal".
 */
import { GameEngine, isGameEngine } from "../../shared/game-engine.ts";
import {
  isWorkerEnd,
  isWorkerStopCode,
  isWorkerVerdict,
  WorkerEnd,
  type WorkerFinishedPayload,
  type WorkerStartedPayload,
  type WorkerStopCode,
  WorkerVerdict,
} from "../../shared/workers.ts";
import { GAME_ENGINE_WORDS, WORKER_LINE_WORDS } from "../words.ts";

/** What a worker's records said so far, and the line they make. */
export interface WorkerLine {
  title: string;
  /** the engine it works in, when not the web's */
  in: GameEngine | null;
  summary: string | null;
  ended: WorkerEnd | null;
  /** why it stopped short, as its end record's code: the record's own text is for the lead, never shown */
  because: WorkerStopCode | null;
  verdict: WorkerVerdict | null;
  note: string | null;
  merged: boolean;
  text: string;
  /** its work ended well (done, used or added): the line's mark is ticked */
  done: boolean;
}

/** A field as trimmed, non-empty text, or null. */
const textOf = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

const endOf = (value: unknown): WorkerEnd | null => (isWorkerEnd(value) ? value : null);
const verdictOf = (value: unknown): WorkerVerdict | null => (isWorkerVerdict(value) ? value : null);
/** An engine other than the web's, when the record names one. */
const engineOf = (value: unknown): GameEngine | null =>
  isGameEngine(value) && value !== GameEngine.Web ? value : null;

const stopCodeOf = (value: unknown): WorkerStopCode | null => (isWorkerStopCode(value) ? value : null);

/** What the records said, before the line is made of it. */
type WorkerSaid = Omit<WorkerLine, "text" | "done">;

/**
 * Whether the lead set the worker's work aside. A rejection of work already in the game takes
 * nothing out of it, so it sets nothing aside, as on the worker's row.
 */
const setAside = (line: WorkerSaid): boolean => line.verdict === WorkerVerdict.Rejected && !line.merged;

/**
 * Whether work of the worker is in the game and the worker is no longer at it: however it ended
 * after that (stopped, failed, or cut off by its run's end), the work stays added, as on its row.
 * A worker still working on another round is still working, as its row says.
 */
const addedAndOver = (line: WorkerSaid): boolean => line.merged && (line.ended !== null || line.verdict !== null);

/** Whether the worker's work ended well: added, or it finished or was used and the lead did not set it aside. */
const endedWell = (line: WorkerSaid): boolean =>
  addedAndOver(line) || (!setAside(line) && (line.ended === WorkerEnd.Done || line.verdict === WorkerVerdict.Used));

/** The line, and its mark, for what the records said. */
const madeLine = (line: WorkerSaid): WorkerLine => ({ ...line, text: lineText(line), done: endedWell(line) });

/**
 * The line for what the records said: work in the game first, then the lead's verdict, then how
 * the worker ended, else that it works.
 */
function lineText(line: WorkerSaid): string {
  const said = line.summary ?? line.title;
  if (addedAndOver(line)) return WORKER_LINE_WORDS.added(said);
  if (setAside(line)) return WORKER_LINE_WORDS.notUsed(said, line.note);
  if (line.ended === WorkerEnd.Failed) return WORKER_LINE_WORDS.didntFinish(line.title, line.because);
  if (line.ended === WorkerEnd.Stopped) return WORKER_LINE_WORDS.stopped(line.title);
  if (endedWell(line)) return WORKER_LINE_WORDS.done(said);
  if (line.in) return WORKER_LINE_WORDS.workingIn(line.title, GAME_ENGINE_WORDS[line.in]);
  return WORKER_LINE_WORDS.working(line.title);
}

/** Whether a worker's line has reached its end, or the lead's word on it: a start after it is a new attempt. */
export const workerLineEnded = (line: WorkerLine): boolean => line.ended !== null || line.verdict !== null;

/** A `worker_started` record's line: "Port the car…"; null without a task title. */
export function workerStartLine(payload: Partial<WorkerStartedPayload>): WorkerLine | null {
  const title = textOf(payload.title);
  if (!title) return null;
  const line = {
    title,
    in: engineOf(payload.in),
    summary: null,
    ended: null,
    because: null,
    verdict: null,
    note: null,
    merged: false,
  };
  return madeLine(line);
}

/**
 * A `worker_finished` record folded onto the worker's line so far (its end, or the lead's verdict
 * after it): what the record says wins, what it leaves out is kept. Null with no title anywhere.
 */
export function workerEndLine(payload: Partial<WorkerFinishedPayload>, previous?: WorkerLine): WorkerLine | null {
  const title = previous?.title ?? textOf(payload.title);
  if (!title) return null;
  const line = {
    title,
    in: previous?.in ?? null,
    summary: textOf(payload.summary) ?? previous?.summary ?? null,
    ended: endOf(payload.state) ?? previous?.ended ?? null,
    because: stopCodeOf(payload.stopCode) ?? previous?.because ?? null,
    verdict: verdictOf(payload.verdict) ?? previous?.verdict ?? null,
    note: textOf(payload.note) ?? previous?.note ?? null,
    // Added by the lead, or written in place by the worker itself: either way its work is in the game.
    merged: payload.merged === true || payload.inGame === true || previous?.merged === true,
  };
  return madeLine(line);
}
