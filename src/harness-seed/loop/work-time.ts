/**
 * The time a person asks a Loop to work ("work 3h on that"). The chat's session names it when it
 * starts or resumes the Loop (`start_autopilot`, `resume_run`: `hours` and `minutes`), and the run
 * carries it in its budgets: `workMinutes`, counted from `workFromMs` of the run's worked time (its
 * journal keeps that as `director.worked`), so a resume asks from where the run stands and a pause
 * stops the count. Before that much work is done its lead's finish is refused (director/work-time.ts).
 * A lead that closed its Loop on its own word once ran 2 h 20 min of three hours asked, three times
 * over, and each summary said it had finished "the 3-hour loop" (sword duel).
 */
import { CompletionPolicy } from "./completion-policy.ts";
import { WORK_TIME_PARAM_WORDS } from "./work-time-prompts.ts";
import { MINUTE_MS } from "./time.ts";
import type { AnyRecord } from "../types/harness.d.ts";

/** The most time a Loop may be asked to work, in minutes: a day. Asked for more, it works a day. */
export const MAX_WORK_MINUTES = 24 * 60;
/** Minutes in an hour, for the person's hours. */
const MINUTES_PER_HOUR = 60;

/** The budget fields a time asked for writes on a run. Never rename one: journals keep them. */
const WORK_KEYS = ["workMinutes", "workFromMs", "completionPolicy"] as const;

/** The time the person asked for, as a run's budgets carry it. */
export interface WorkAsk {
  /** How long the person asked the Loop to work, in minutes. */
  minutes: number;
  /** The run's worked time when they asked, in ms: a resume asks from where the run stands. */
  fromMs: number;
}

/** The `hours` and `minutes` a Loop's start and resume take: only what the person named. */
export const WORK_TIME_PARAMS = {
  hours: { type: "number", description: WORK_TIME_PARAM_WORDS.hours },
  minutes: { type: "number", description: WORK_TIME_PARAM_WORDS.minutes },
} as const;

/** A tool's number above zero, from a number or its text (a bridge may send every argument as text); zero otherwise. */
function positive(value: unknown): number {
  const number = typeof value === "number" ? value : Number.parseFloat(String(value ?? ""));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** The whole minutes a tool call's `hours` and `minutes` name together (at most a day), or null when they name none. */
export function askedMinutes(args: AnyRecord | null | undefined): number | null {
  const total = Math.round(positive(args?.hours) * MINUTES_PER_HOUR + positive(args?.minutes));
  return total >= 1 ? Math.min(total, MAX_WORK_MINUTES) : null;
}

/** The budget fields `minutes` asked for writes on a run, from `fromMs` of its worked time: the time ends it. */
export function workBudget(minutes: number, fromMs = 0): AnyRecord {
  return { workMinutes: minutes, workFromMs: Math.max(0, fromMs), completionPolicy: CompletionPolicy.Duration };
}

/** The time a run's budgets carry, or null when none was asked. */
export function workAskOf(budgets: unknown): WorkAsk | null {
  const own = (budgets ?? {}) as AnyRecord;
  const minutes = own.workMinutes;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 1) return null;
  const from = own.workFromMs;
  const fromMs = typeof from === "number" && Number.isFinite(from) ? Math.max(0, from) : 0;
  return { minutes: Math.min(minutes, MAX_WORK_MINUTES), fromMs };
}

/** A run's budgets with no time asked: the rest of them, kept. */
export function withoutWork(budgets: unknown): AnyRecord {
  const rest: AnyRecord = { ...((budgets ?? {}) as AnyRecord) };
  for (const key of WORK_KEYS) delete rest[key];
  return rest;
}

/** The run's worked time at which the person's time is done. */
export const dueMs = (ask: WorkAsk): number => ask.fromMs + ask.minutes * MINUTE_MS;

/** The time asked for, as a span in ms. */
export const askedMs = (ask: WorkAsk): number => ask.minutes * MINUTE_MS;

/** A span as a person reads it, in whole minutes: "3 h", "2 h 20 min", "40 min". */
export function spanWords(ms: number): string {
  const total = Math.max(0, Math.round(ms / MINUTE_MS));
  const hours = Math.floor(total / MINUTES_PER_HOUR);
  const rest = total % MINUTES_PER_HOUR;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}
