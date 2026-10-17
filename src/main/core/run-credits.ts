/**
 * A run's Genex credit cap (`HarnessDelegateParams.creditCap`). Every session of the run, its lead's
 * own and its sub-agents', counts the credits its Genex jobs were quoted or charged against one sum
 * for the run, and once the run's jobs have committed the cap its next paid job is refused before
 * Genex is asked. The harness that sends the cap is agent-editable, so a cap that is not a whole
 * number of credits fails closed: it allows no paid job.
 */
import { isJsonObject } from "../../substrate/fsx.ts";
import { GenexStudioTool } from "./genex-cli-prompts.ts";

/** A session's run and the Genex credits that run's paid jobs may commit. */
export type RunCreditCap = { runId: string; cap: number };

/** The paid Genex tools a cap holds back once it is spent. */
const PAID: ReadonlySet<string> = new Set([GenexStudioTool.Asset, GenexStudioTool.CliPaid]);

const MESSAGE = {
  overCap: (spent: number, cap: number) =>
    `This run's paid Genex jobs have committed ${spent} of its ${cap} Genex credits, so Genex made no more. Use Local Blender, or what was already made.`,
} as const;

/** The cap a delegation asked for its run, or null when it asked for none or names no run. */
export function runCreditCap(asked: unknown, runId: string | null | undefined): RunCreditCap | null {
  if (asked === undefined || !runId) return null;
  const whole = typeof asked === "number" && Number.isSafeInteger(asked) && asked >= 0;
  return { runId, cap: whole ? asked : 0 };
}

/** A job the asset tool answered: its id and the credits it was charged, else quoted; null for anything else. */
function jobCredits(result: unknown): { id: string; credits: number } | null {
  if (!isJsonObject(result) || typeof result.id !== "string") return null;
  const credits = [result.creditsCharged, result.creditsQuoted].find(
    (n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0,
  );
  return credits === undefined ? null : { id: result.id, credits };
}

/** The credits each run's Genex jobs committed, by job, while this core runs. */
export class RunCreditLedger {
  readonly #jobs = new Map<string, Map<string, number>>();

  /** What the run's jobs have committed so far. */
  spent(runId: string): number {
    let sum = 0;
    for (const credits of this.#jobs.get(runId)?.values() ?? []) sum += credits;
    return sum;
  }

  /** Why a call is refused before it runs (its run's cap is spent), or null when it may run. */
  refusal(name: string, cap: RunCreditCap | null): string | null {
    if (!cap || !PAID.has(name)) return null;
    const spent = this.spent(cap.runId);
    return spent >= cap.cap ? MESSAGE.overCap(spent, cap.cap) : null;
  }

  /** Counts the job an asset call answered under its run; a job asked about again counts once, at its most. */
  count(name: string, cap: RunCreditCap | null, result: unknown): void {
    const job = name === GenexStudioTool.Asset && cap ? jobCredits(result) : null;
    if (!cap || !job) return;
    const jobs = this.#jobs.get(cap.runId) ?? new Map<string, number>();
    jobs.set(job.id, Math.max(jobs.get(job.id) ?? 0, job.credits));
    this.#jobs.set(cap.runId, jobs);
  }
}
