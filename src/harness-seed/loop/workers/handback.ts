/**
 * What a worker hands the lead when it ends: its own last words, kept whole on its record (clipped
 * long), and for a copy the files its work changes; the lead reads both in `worker_status` and
 * `worker_wait`, and a merge names the pictures among those files. A module of its own, so the
 * shipped pool needs no new name from a `contract.ts`, `pool-merge.ts` or `prompts.ts` an agent may
 * have kept.
 */
import { gitExec } from "../git.ts";
import { commitArg } from "../shell.ts";
import { clip, hasText } from "../text.ts";
import { firstSentence } from "./events.ts";
import { HANDBACK_WORDS } from "./handback-prompts.ts";
import { isWorking, type PoolState, type WorkerRecord } from "./records.ts";

/** The most characters of a worker's last words its record keeps, for the lead to read in full. */
const WORKER_REPORT_CHARS = 8_000;
/** The most changed files a copy worker's record names. */
const WORKER_CHANGED_FILES = 40;
/** The files a picture is spelled with, by extension: what a lead looks at before building on merged work. */
const PICTURE_FILE = /\.(png|jpe?g|webp)$/i;

/** The paths a copy's work changes from the commit the copy was made at, NUL-separated. */
const changedFrom = (base: unknown, commit: unknown): string =>
  `git diff --name-only -z ${commitArg(base)} ${commitArg(commit)}`;

/** A worker's own last words as its record keeps them, or null when it gave none. */
export function keptReport(summary: string | null): string | null {
  return hasText(summary) ? clip(summary.trim(), WORKER_REPORT_CHARS) : null;
}

/**
 * The files a copy worker's committed work changes: at most `WORKER_CHANGED_FILES`, or null when it
 * holds no work or git could not say.
 */
export async function changedFiles(state: PoolState, record: WorkerRecord): Promise<string[] | null> {
  const { worktree, base, commit } = record;
  if (!worktree || !base || !commit) return null;
  const changed = await gitExec(state.scope.ctx, worktree, changedFrom(base, commit)).catch(() => null);
  if (changed?.code !== 0) return null;
  const files = String(changed.stdout ?? "")
    .split("\0")
    .filter(Boolean);
  return files.slice(0, WORKER_CHANGED_FILES);
}

/** What a merge of a worker's work adds for the lead: the pictures it made, to look at; "" when none. */
export function picturesToLookAt(record: WorkerRecord): string {
  const pictures = (record.changed ?? []).filter((file) => PICTURE_FILE.test(file));
  return pictures.length ? HANDBACK_WORDS.lookAt(pictures) : "";
}

/** In a list of every worker, an ended one's report named by its first sentence; "" otherwise. */
export function saidOf(record: WorkerRecord): string {
  const said = isWorking(record) ? "" : firstSentence(record.report);
  return said ? HANDBACK_WORDS.said(said) : "";
}

/**
 * What an ended worker hands the lead, in full: its own report (or that it wrote none) and the
 * files a copy's work changes. Nothing while it still works.
 */
export function handedBack(record: WorkerRecord): string {
  if (isWorking(record)) return "";
  const report = hasText(record.report)
    ? HANDBACK_WORDS.report(record.id, record.report)
    : HANDBACK_WORDS.noReport(record.id);
  const changed = record.changed?.length ? [HANDBACK_WORDS.changes(record.id, record.changed)] : [];
  return [report, ...changed].join("\n");
}
