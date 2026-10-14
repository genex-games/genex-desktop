/** Durable evidence for a disposable CI acceptance process, including an interrupted phase. */
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { SECOND_MS } from "../src/shared/duration.ts";

/** How long cleanup may take before the run fails with its saved results. */
const CLEANUP_MS = 10 * SECOND_MS;

type Report = Record<string, unknown>;

/** The acceptance report on disk: a JSONL journal of every checkpoint and an atomic summary. */
export class AcceptanceJournal {
  readonly folder: string;
  readonly report: Report;
  readonly log: (line: string) => void;

  constructor(folder: string, report: Report, log: (line: string) => void = console.log) {
    this.folder = folder;
    this.report = report;
    this.log = log;
    mkdirSync(folder, { recursive: true });
    this.checkpoint("start");
  }

  /** Record that the run entered `stage`. */
  phase(stage: string): void {
    this.report.stage = stage;
    this.checkpoint("phase", { stage });
  }

  /** Record that the run was told to stop: whatever finishes after this, it does not pass. */
  interrupt(signal: string): void {
    this.report.interrupted = { signal, stage: this.report.stage, at: new Date().toISOString() };
    this.report.passed = false;
    this.checkpoint("interrupted", { signal });
  }

  /** Append `event` to the journal and rewrite the summary in place. */
  checkpoint(event: string, facts: Report = {}): void {
    const record = { at: new Date().toISOString(), event, stage: this.report.stage, ...facts };
    appendFileSync(path.join(this.folder, "journal.jsonl"), `${JSON.stringify(record)}\n`);
    const summary = path.join(this.folder, "summary.json");
    writeFileSync(`${summary}.tmp`, `${JSON.stringify(this.report, null, 2)}\n`);
    renameSync(`${summary}.tmp`, summary);
    this.log(JSON.stringify(record));
  }
}

/** Save assertions before cleanup; a stuck proxy shutdown must leave its result and fail promptly. */
export async function finishAcceptance(
  journal: AcceptanceJournal,
  dispose: () => Promise<void>,
  cleanupMs = CLEANUP_MS,
): Promise<boolean> {
  const { report } = journal;
  // A phase that ignored the abort can still return and mark its checks: an interruption stands.
  const checksPassed = report.passed === true && report.interrupted === undefined;
  report.checksPassed = checksPassed;
  report.passed = false;
  report.resultAt = new Date().toISOString();
  journal.checkpoint("result");
  const cleanup: Report = { startedAt: new Date().toISOString(), completed: false };
  report.cleanup = cleanup;
  journal.checkpoint("cleanup-start");
  const timer = new AbortController();
  try {
    await Promise.race([
      dispose(),
      sleep(cleanupMs, undefined, { signal: timer.signal }).then(() => {
        throw new Error(`cleanup exceeded ${cleanupMs} ms`);
      }),
    ]);
    cleanup.completed = true;
    report.passed = checksPassed;
  } catch (error) {
    cleanup.error = error instanceof Error ? error.stack : String(error);
    report.error ??= cleanup.error;
  } finally {
    timer.abort();
    report.finishedAt = new Date().toISOString();
    journal.checkpoint("finished");
  }
  return report.passed === true;
}
