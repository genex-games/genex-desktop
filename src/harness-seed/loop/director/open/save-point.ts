/**
 * The open lead's save points and what it asks of the turn's end. A save point is Genex's
 * checkpoint of the game folder (`checkpoint.take`) under the lead's label: the project's plugins run
 * their steps around Genex's snapshot (an app saves its work before, its pictures are taken after),
 * and the save point keeps the snapshot, the steps' notes and the pictures as its round's thumbnails
 * on the graph (the host keeps them as the observer's capture too). It waits for every git write
 * queued before it (a worker's merge). A step's block is a note the save point keeps (its app saved
 * nothing first, say): the snapshot is taken, and the lead reads what the steps said. Steps Genex
 * itself skipped (the person using the app) are said too: the snapshot holds the files on disk only.
 * Plan mode keeps nothing, and the lead hears why. `rewind` and `restart` only note what the turn's
 * end runs (`between.ts`): nothing is restored or restarted under a running turn.
 */
import type { AnyRecord } from "../../../types/harness.d.ts";
import type { CheckpointAnswer, HookImage } from "../../../types/host-api.d.ts";
import { type CheckpointAsk, type HookHeldBy, holdOf, notesText, runScope, takeCheckpoint } from "../../hooks.ts";
import { clip, hasText } from "../../text.ts";
import type { LoopRun } from "../loop-run.ts";
import { MAX_SAVE_POINT_LABEL, type OpenSavePoint } from "./contract.ts";
import { savePointRound } from "./graph.ts";
import { SHOWS_WORDS } from "./evidence-prompts.ts";
import { heldForLead } from "../held-words.ts";
import { OPEN_WORDS } from "./prompts.ts";
import { APP_NEWS } from "./app-prompts.ts";
import { shownPicture } from "./shown-picture.ts";

/** A taken checkpoint's answer. */
type Taken = Extract<CheckpointAnswer, { snapshot: unknown }>;

/** What a save point is asked for: its label and summary, and whether Genex asked for it (an autosave). */
export type SavePointAsk = { label: string; summary: string; auto: boolean };

/** A git write to the game folder after every one queued before it. */
export function queued<T>(loopRun: LoopRun, write: () => Promise<T>): Promise<T> {
  return loopRun.open.gitWrite(write);
}

/** Genex's checkpoint of the game folder under a label, after every git write queued before it. */
export function checkpointNow(loopRun: LoopRun, label: string, onlyIfUnsaved = false): Promise<CheckpointAnswer> {
  const ask: CheckpointAsk = { ...runScope(loopRun), label, ...(onlyIfUnsaved ? { onlyIfUnsaved: true } : {}) };
  return queued(loopRun, () => takeCheckpoint(loopRun.ctx, ask));
}

/**
 * What a taken checkpoint's steps said, as the save point keeps it: their notes, and that the app saved
 * nothing first when Genex skipped its steps (the person was using it, or Genex couldn't tell).
 */
function savePointNotes(taken: Taken): string[] {
  const skipped = taken.notes.some((note) => holdOf(note as HookHeldBy) !== null);
  return [...notesText(taken), ...(skipped ? [APP_NEWS.notSavedFirst] : [])];
}

/**
 * The save point a taken checkpoint makes: the journal's record and its round on the graph, led by
 * the picture the lead named as showing the change, when it named one Genex could read.
 */
export async function recordSavePoint(
  loopRun: LoopRun,
  ask: SavePointAsk,
  taken: Taken,
  shown: { rel: string; image: HookImage } | null = null,
): Promise<OpenSavePoint> {
  const journal = loopRun.open.journal;
  const point: OpenSavePoint = {
    label: ask.label,
    summary: ask.summary,
    snapshotId: taken.snapshot.snapshot_id,
    auto: ask.auto,
    at: loopRun.open.clock.now(),
    notes: savePointNotes(taken),
    ...(shown ? { shows: shown.rel } : {}),
  };
  journal.savePoints.push(point);
  await loopRun.saveJournal().catch(() => {});
  const round = journal.savePoints.length;
  await savePointRound(loopRun, point, round, taken.images ?? [], shown?.image ?? null).catch(() => {});
  return point;
}

/** Why a checkpoint kept nothing, for the lead: Genex's hold in its words, a step's block or a skip with its reason. */
function notKept(answer: Exclude<CheckpointAnswer, Taken>): string {
  if ("blocked" in answer) return heldForLead({ reason: answer.blocked, hold: answer.hold, label: answer.label });
  return answer.reason;
}

/** `save_point`: Genex's checkpoint now under the lead's label; what was kept and what the plugins said, or why nothing was. */
export async function savePointTool(loopRun: LoopRun, args: AnyRecord): Promise<string> {
  const label = hasText(args.label) ? clip(args.label.trim(), MAX_SAVE_POINT_LABEL) : "";
  if (!label) return OPEN_WORDS.needsLabel;
  const summary = hasText(args.summary) ? args.summary.trim() : "";
  // Read before the checkpoint: the picture is the one the lead looked at, as the save point keeps the folder.
  const rel = hasText(args.shows) ? args.shows.trim() : "";
  const picture = rel ? await shownPicture(loopRun.projectDir, rel) : null;
  const taken = await checkpointNow(loopRun, label);
  if (!("snapshot" in taken)) return OPEN_WORDS.notSaved(notKept(taken));
  const shown = picture && "image" in picture ? { rel, image: picture.image } : null;
  const point = await recordSavePoint(loopRun, { label, summary, auto: false }, taken, shown);
  return OPEN_WORDS.saved(point.label, point.notes, showsWords(rel, picture));
}

/** What the save point's answer says of its `shows`: nothing when it kept the picture or named none, else why not. */
function showsWords(rel: string, picture: { image: HookImage } | { problem: string } | null): string | null {
  if (!picture) return null;
  return "problem" in picture ? SHOWS_WORDS.refused(rel, picture.problem) : null;
}

/** The last save point with this label, or null. */
export function savePointNamed(loopRun: LoopRun, label: string): OpenSavePoint | null {
  return loopRun.open.journal.savePoints.findLast((point) => point.label === label) ?? null;
}

/** `rewind`: back to a save point when the turn ends; an unknown label answers the labels there are. */
export async function rewindTool(loopRun: LoopRun, args: AnyRecord): Promise<string> {
  const label = hasText(args.label) ? args.label.trim() : "";
  const journal = loopRun.open.journal;
  const point = savePointNamed(loopRun, label);
  if (!point) return OPEN_WORDS.noSuchPoint(label, [...new Set(journal.savePoints.map((one) => one.label))]);
  // The save point the label names now: an autosave the turn's end takes under the same label is not it.
  journal.between.rewind = { label, snapshotId: point.snapshotId };
  await loopRun.saveJournal().catch(() => {});
  return OPEN_WORDS.rewindLater(label);
}

/** `restart`: the project's app closed and reopened when the turn ends, with no file changed. */
export async function restartTool(loopRun: LoopRun): Promise<string> {
  loopRun.open.journal.between.restart = true;
  await loopRun.saveJournal().catch(() => {});
  return OPEN_WORDS.restartLater;
}
