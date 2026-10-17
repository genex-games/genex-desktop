/**
 * The open Loop as the Builds graph reads it, in the shapes it already draws for a lead that builds
 * in place: the lead's own part row ("Lead"), at work once the lead keeps its first save point and
 * done at the close, one kept round (`facet_iteration`, verdict source `lead`) and its merge into the
 * game folder for every save point, with the checkpoint's pictures as its thumbnails, and the close's own record (whether the Loop kept anything, each part's last
 * word, one sentence naming the save points). The pool's workers leave their own records
 * (`workers/events.ts`). Every record is a courtesy to the log: a write that fails never costs the run.
 */
import type { AnyRecord } from "../../../types/harness.d.ts";
import type { HookImage } from "../../../types/host-api.d.ts";
import { HostMethod } from "../../host-methods.ts";
import { Side } from "../../judge.ts";
import { WorkerMode, WorkerState } from "../../outcomes.ts";
import { RunEvent } from "../../run-events.ts";
import type { LoopRun } from "../loop-run.ts";
import type { OpenJournal, OpenSavePoint } from "./contract.ts";

/** The lead's own part on the graph, as a lead that builds in place names it. Never rename a value. */
export const OPEN_LEAD_PART = "lead";

/**
 * The verdict source a save point's round carries: `verdict.ts`'s `VerdictSource.Lead`, spelled here
 * too because a `verdict.ts` an agent kept from before has none. Persisted: never rename the value.
 */
export const SAVE_POINT_VERDICT_SOURCE = "lead";

/** A save point keeps at most this many of its checkpoint's pictures as thumbnails. */
const MAX_THUMBNAILS = 4;

/** The graph's words: the lead's row, and the close's sentence. */
const WORDS = {
  lead: "Lead",
  /** The save points, and the last one's summary when the lead gave one (without its own full stop). */
  saves: (count: number, label: string, summary: string) => {
    if (count === 1) return summary ? `One save point: ${label} (${summary}).` : `One save point: ${label}.`;
    return summary
      ? `${count} save points; the last, ${label}: ${summary}.`
      : `${count} save points; the last, ${label}.`;
  },
  noSaves: "No save point was made, so the project is as the Loop left it.",
  lastKept: "Genex kept the last work in a checkpoint at the close.",
} as const;

/** The lead's row: at work, or done. */
export async function leadRow(loopRun: LoopRun, state: WorkerState): Promise<void> {
  const payload = { workerId: OPEN_LEAD_PART, title: WORDS.lead, mode: WorkerMode.Single, state };
  await loopRun.appendRun(RunEvent.DirectorWorker, payload).catch(() => {});
}

/** One thumbnail: the picture saved in the run's folder; its path, or null when it couldn't be kept. */
async function thumbnailOf(
  loopRun: LoopRun,
  round: number,
  image: HookImage,
): Promise<{ camera: string; path: string } | null> {
  const name = `open/save-${round}/${image.name.replace(/[^a-z0-9-]+/gi, "-")}.png`;
  const params = { runId: loopRun.run.runId, name, base64: image.data };
  const path = await loopRun.ctx.call(HostMethod.RunArtifact, params).catch(() => null);
  return typeof path === "string" ? { camera: image.name, path } : null;
}

/** The camera name of the picture the lead named as showing a save point's change. */
const SHOWN_CAMERA = "shows";

/**
 * A save point on the graph: the lead's row at work at the first one, a kept round of the lead's part
 * with its label, summary, snapshot and thumbnails (the picture the lead named as showing the change
 * apart, as `shown`: the graph's picture of the save point), and its merge into the game folder (the
 * live project), which names its snapshot and no build of its own.
 */
export async function savePointRound(
  loopRun: LoopRun,
  point: OpenSavePoint,
  round: number,
  images: readonly HookImage[],
  shownImage: HookImage | null = null,
) {
  if (round === 1) await leadRow(loopRun, WorkerState.Running);
  const shots = [];
  for (const image of images.slice(0, MAX_THUMBNAILS)) {
    const shot = await thumbnailOf(loopRun, round, image);
    if (shot) shots.push(shot);
  }
  const shown = shownImage ? await thumbnailOf(loopRun, round, { ...shownImage, name: SHOWN_CAMERA }) : null;
  const iteration = {
    facetId: OPEN_LEAD_PART,
    facetTitle: WORDS.lead,
    iteration: round,
    winner: Side.Challenger,
    verdictSource: SAVE_POINT_VERDICT_SOURCE,
    reason: point.summary,
    satisfied: false,
    summary: point.summary,
    label: point.label,
    snapshot: point.snapshotId,
    shots,
    ...(shown ? { shown } : {}),
    auto: point.auto,
    move: { what: point.summary ? `${point.label}: ${point.summary}` : point.label, delivered: true },
  };
  await loopRun.appendRun(RunEvent.FacetIteration, iteration).catch(() => {});
  const merge = {
    project: loopRun.run.project,
    facetId: OPEN_LEAD_PART,
    round,
    iteration: round,
    snapshot: point.snapshotId,
    conflict: false,
  };
  await loopRun.appendRun(RunEvent.IntegrationMerge, merge).catch(() => {});
}

/** The close's sentence: the save points and the last one's summary, and whether the close kept the last work. */
function closeSentence(journal: OpenJournal, lastKept: boolean): string {
  const last = journal.savePoints.at(-1);
  const summary = last?.summary.trim().replace(/\.+$/, "") ?? "";
  const saves = last ? WORDS.saves(journal.savePoints.length, last.label, summary) : WORDS.noSaves;
  return lastKept ? `${saves} ${WORDS.lastKept}` : saves;
}

/**
 * The close as the graph and the run's summary read it: a Loop that ended kept something when it
 * made a save point or the close kept the last work (the game folder is the live project); a paused
 * one is not over, so nothing of it reads as landed yet, on any surface. The lead's row's last word,
 * and the sentence.
 */
export function openCloseOf(journal: OpenJournal, lastKept: boolean, paused = false): AnyRecord {
  const iterations = journal.savePoints.length;
  return {
    landed: !paused && (iterations > 0 || lastKept),
    facets: iterations ? { [OPEN_LEAD_PART]: { stoppedBecause: null, iterations, satisfied: null } } : {},
    summary: closeSentence(journal, lastKept),
  };
}

/** The lead's row at the close: done, unless the Loop pauses (a resume picks it up), and only once it was drawn. */
export async function leadRowAtClose(loopRun: LoopRun, journal: OpenJournal, paused: boolean): Promise<void> {
  if (paused || !journal.savePoints.length) return;
  await leadRow(loopRun, WorkerState.Done);
}
