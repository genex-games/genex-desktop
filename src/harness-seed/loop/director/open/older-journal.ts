/**
 * A Loop the Unreal runner from before the one Loop paused, resumed in the one Loop: its journal
 * (`kind: "unreal-lead"`) is read field by field for what the one Loop goes on with (the run, the
 * time it worked, its save points, the reviewer's no's, the lines its next message owed the lead, the
 * credits its jobs spent, which lower the run's credit cap once) and turned into a director journal
 * with the open Loop's record. Its lead's own session is not resumed: the chat's own session leads. A
 * journal it can't read closes the run at once, saying so; so does one of another kind of Loop (a web
 * game's director's, another runner's), which an open Loop never picks up. Nothing here imports the
 * runner: the kind is a name it reads, never writes.
 */
import type { AnyRecord } from "../../../types/harness.d.ts";
import type { FinishTally } from "../../finish-check.ts";
import { newOpenJournal, type OpenJournal, type OpenSavePoint } from "./contract.ts";

/** The journal kind the Unreal runner wrote: read, never written. */
export const OLDER_LEAD_JOURNAL_KIND = "unreal-lead";

/** The words the run and the lead are told about a run an earlier version paused. */
export const MESSAGE = {
  cannotResumeOlder:
    "This Loop was paused by an earlier version and can't be picked up. Start a new Loop: it goes on from the project as it is now, with every save point kept.",
  /** A paused Loop of another kind (a web game's, before the project read as another kind): it stays paused. */
  cannotResumeOtherLoop:
    "This Loop was paused as another kind of Loop than this project reads as now, so it can't go on now. It stays paused: once the project reads as it did, Resume picks it up.",
  resumedOlder: (labels: readonly string[], spent: number) =>
    `This Loop was started by an earlier version and paused; its save points are kept: ${labels.map((label) => `"${label}"`).join(", ") || "none"}. Its paid jobs had spent ${spent} Genex credits.`,
} as const;

/** One save point as the Unreal runner kept it, of the fields the one Loop reads. */
type OlderSavePoint = Pick<OpenSavePoint, "label" | "summary" | "snapshotId" | "auto">;

/** What the one Loop reads of the Unreal runner's journal. */
export interface OlderLeadJournal {
  run: AnyRecord;
  workedMs: number;
  savePoints: OlderSavePoint[];
  finishTally: FinishTally | null;
  carried: string[];
  creditsSpent: number;
}

/** Whether a value is a plain record. */
const isRecord = (value: unknown): value is AnyRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A whole number of zero or more. */
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** A save point the Unreal runner kept, or null when it is not one. */
function olderSavePoint(value: unknown): OlderSavePoint | null {
  if (!isRecord(value)) return null;
  const { label, summary, snapshotId, auto } = value;
  if (typeof label !== "string" || typeof snapshotId !== "string") return null;
  if (typeof summary !== "string" || typeof auto !== "boolean") return null;
  return { label, summary, snapshotId, auto };
}

/** The reviewer's no's the Unreal runner kept: absent (it never claimed), or the tally's own shape. */
function olderTally(value: unknown): FinishTally | null | undefined {
  if (value === undefined) return null;
  if (!isRecord(value) || !isCount(value.round) || !isCount(value.rejections)) return undefined;
  const reasons = Array.isArray(value.reasons) ? value.reasons : [];
  if (!reasons.every((reason) => typeof reason === "string")) return undefined;
  return { round: value.round, rejections: value.rejections, checking: false, reasons: [...reasons], notDone: [] };
}

/** The lines the Unreal runner's next digest owed its lead, or null when the digest is not one. */
function olderCarried(digest: unknown): string[] | null {
  if (!isRecord(digest) || !Array.isArray(digest.carried)) return null;
  return digest.carried.every((line) => typeof line === "string") ? [...digest.carried] : null;
}

/**
 * The Unreal runner's journal, of the fields the one Loop reads: `kind`, `run`, `workedMs`,
 * `savePoints`, `finishTally`, `digest.carried` and `credits.spent`. Anything missing or of the wrong
 * shape: null.
 */
export function olderLeadJournal(saved: unknown): OlderLeadJournal | null {
  if (!isRecord(saved) || saved.kind !== OLDER_LEAD_JOURNAL_KIND) return null;
  if (!isRecord(saved.run) || !isCount(saved.workedMs) || !Array.isArray(saved.savePoints)) return null;
  const savePoints = saved.savePoints.map(olderSavePoint);
  const finishTally = olderTally(saved.finishTally);
  const carried = olderCarried(saved.digest);
  const spent = isRecord(saved.credits) ? saved.credits.spent : undefined;
  const pointsRead = savePoints.every((point) => point !== null);
  if (!pointsRead || finishTally === undefined || carried === null || !isCount(spent)) return null;
  return {
    run: saved.run,
    workedMs: saved.workedMs,
    savePoints: savePoints as OlderSavePoint[],
    finishTally,
    carried,
    creditsSpent: spent,
  };
}

/** The open Loop's record from the Unreal runner's: its save points, its carried lines and one naming what was kept. */
export function openJournalFromOlder(older: OlderLeadJournal, at: number): OpenJournal {
  const labels = older.savePoints.map((point) => point.label);
  return {
    ...newOpenJournal(),
    savePoints: older.savePoints.map((point) => ({ ...point, at, notes: [] })),
    carried: [...older.carried, MESSAGE.resumedOlder(labels, older.creditsSpent)],
  };
}

/** A resumed open Loop's journal as it reads it: the journal, why it can't be picked up, and the credits spent before. */
export interface ResumedOpenJournal {
  prior: AnyRecord | null;
  /** Why the run closes at once instead (the person's words), or null. */
  refused: string | null;
  /**
   * The refused run stays paused, its journal untouched (another kind of Loop's, which a Resume picks
   * up once the project reads as it did); otherwise it closes for good (a journal no version reads).
   */
  staysPaused?: boolean;
  /** Credits the Unreal runner's jobs spent, which the run's cap is lowered by once; 0 otherwise. */
  spentBefore: number;
}

/** Whether a saved journal is an open Loop's own (`director.open`). */
const isOpenLoopJournal = (saved: AnyRecord): boolean => isRecord(saved.director) && isRecord(saved.director.open);

/**
 * The journal a resumed open Loop reads: none (a fresh run); an open Loop's own as is; the Unreal
 * runner's turned into a director journal (its run, the time it worked, its no's, the open Loop's
 * record); refused with words when it was the Unreal runner's and can't be read, or is another kind
 * of Loop's.
 */
export function resumedOpenJournal(saved: AnyRecord | null, at: number): ResumedOpenJournal {
  if (saved === null || saved === undefined) return { prior: null, refused: null, spentBefore: 0 };
  if (saved.kind === OLDER_LEAD_JOURNAL_KIND) return fromOlderRunner(saved, at);
  if (saved.kind !== undefined || !isOpenLoopJournal(saved))
    return { prior: null, refused: MESSAGE.cannotResumeOtherLoop, staysPaused: true, spentBefore: 0 };
  return { prior: saved, refused: null, spentBefore: 0 };
}

/** The Unreal runner's journal as the one Loop picks it up, or refused when it can't be read. */
function fromOlderRunner(saved: AnyRecord, at: number): ResumedOpenJournal {
  const older = olderLeadJournal(saved);
  if (!older) return { prior: null, refused: MESSAGE.cannotResumeOlder, spentBefore: 0 };
  const director = {
    clock: { workedMs: older.workedMs },
    ...(older.finishTally ? { finishTally: older.finishTally } : {}),
    open: openJournalFromOlder(older, at),
  };
  const prior = { runId: older.run.runId, run: older.run, director };
  return { prior, refused: null, spentBefore: older.creditsSpent };
}
