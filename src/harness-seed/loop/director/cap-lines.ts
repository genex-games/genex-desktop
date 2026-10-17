/**
 * What a Loop's lead hears of its cap (time-cap.ts), the same for the web director and the open Loop:
 * `HEADS_UP_MS` before the cap, "about 15 minutes left", and at the cap, "time's up". Each goes into
 * the turn under way (`engine.steer`), once: the heads-up never cuts the turn short; the time's-up
 * cuts a session that can't read it mid-turn (its engine takes no input as it works), never one
 * inside a tool call or a claim's check, so its wrap-up turn opens with it — as the cap's deadline
 * cut it before. A turn that read the time's-up goes on into the grace (`turnEndAtCap`). A line the
 * session took but never read (absent from its `steered`), or one no turn took, opens the lead's next
 * message (`capWords`). From the cap on no worker starts (`capRefusesWorker`). A run whose clock a
 * kept older setup made (no `headsUpAt`) hears none of this and keeps the cap's deadline, and so
 * does a wrap-up that began before the cap. A module no earlier harness had.
 */
import { setTimeout as idle } from "node:timers/promises";
import type { DelegateResult } from "../../types/host-api.d.ts";
import { HostMethod } from "../host-methods.ts";
import { minutes, SECOND_MS } from "../time.ts";
import type { CapClock } from "../time-cap.ts";
import { TIME_CAP_WORDS } from "../time-cap-prompts.ts";
import { closeUnderWay, finishUnderWay } from "./close-latch.ts";
import type { LoopRun } from "./loop-run.ts";
import { WRAP_UP_MARGIN_MS } from "./wake-schedule.ts";

/** How often a web lead's turn under way is looked at for a line of its cap (real time). */
const CAP_WATCH_MS = SECOND_MS;

/** The two lines of a Loop's cap, as the steer ids name them. */
export const CapLine = {
  HeadsUp: "heads_up",
  TimesUp: "times_up",
} as const;
export type CapLine = (typeof CapLine)[keyof typeof CapLine];

/** What the lead has heard of its cap, and what the session call under way took in, by steer id. */
type CapHeard = { heard: Set<CapLine>; taken: Map<string, CapLine> };

/** Each run's, by its run object. */
const HEARD = new WeakMap<object, CapHeard>();
/** Each run's own clock (the wake loop's), by its run object. */
const RUN_CLOCKS = new WeakMap<object, () => number>();

/** The run's own clock, for what reads its time outside a turn's own reading (a worker asked for). */
export function keepRunClock(loopRun: LoopRun, now: () => number): void {
  RUN_CLOCKS.set(loopRun, now);
}

/** Now on the run's own clock, else the wall clock. */
export function runNow(loopRun: LoopRun): number {
  return RUN_CLOCKS.get(loopRun)?.() ?? Date.now();
}

/** The run's record of what its lead heard of its cap. */
function heardOf(loopRun: LoopRun): CapHeard {
  let heard = HEARD.get(loopRun);
  if (!heard) {
    heard = { heard: new Set(), taken: new Map() };
    HEARD.set(loopRun, heard);
  }
  return heard;
}

/** The run's cap and heads-up, or null for a clock a kept older setup made (it has no `headsUpAt`). */
function capOf(loopRun: LoopRun): { capAt: number; headsUpAt: number | null } | null {
  const clock = loopRun.clock as Partial<CapClock> | undefined;
  if (!clock || !("headsUpAt" in clock) || typeof clock.softDeadline !== "number") return null;
  return { capAt: clock.softDeadline, headsUpAt: typeof clock.headsUpAt === "number" ? clock.headsUpAt : null };
}

/** Whether the run's lead hears its cap's lines, and a turn that reads them goes on into the grace. */
export function capWatched(loopRun: LoopRun): boolean {
  return capOf(loopRun) !== null;
}

/**
 * The line due at `now` that the lead has neither heard nor taken in this call, or null. None once a
 * wrap-up began before the cap (the person's Finish, an idle lead, a failed turn moved the working
 * deadline up): the wrap-up's own message says to wrap up, and its turn is never cut for the cap.
 */
function dueLine(loopRun: LoopRun, now: number): CapLine | null {
  const cap = capOf(loopRun);
  if (!cap || loopRun.softDeadline < cap.capAt) return null;
  const { heard, taken } = heardOf(loopRun);
  const pending = (line: CapLine) => !heard.has(line) && ![...taken.values()].includes(line);
  if (now >= cap.capAt) return pending(CapLine.TimesUp) ? CapLine.TimesUp : null;
  const headsUp = cap.headsUpAt !== null && now >= cap.headsUpAt;
  return headsUp && pending(CapLine.HeadsUp) ? CapLine.HeadsUp : null;
}

/** A line's words at `now`. */
function lineText(loopRun: LoopRun, line: CapLine, now: number): string {
  if (line === CapLine.TimesUp) return TIME_CAP_WORDS.timesUp;
  return TIME_CAP_WORDS.headsUp(minutes((capOf(loopRun)?.capAt ?? now) - now));
}

/** The time's-up may cut a session that can't read it: never inside a tool call, a claim's check or a close. */
const mayCutAtCap = (loopRun: LoopRun): boolean =>
  (loopRun.toolsInFlight ?? 0) === 0 && !finishUnderWay(loopRun.state) && !closeUnderWay(loopRun.state);

/** Whether the run is over for its lead: it hears nothing more. */
const over = (loopRun: LoopRun): boolean => loopRun.state.finished || closeUnderWay(loopRun.state);

/**
 * Says the line due now into the lead's turn under way, once (the module's header). A session that
 * read it mid-turn has it taken (settled against `steered`); one cut short for it hears it in its
 * wrap-up turn's message, as does one no session took.
 */
export async function steerCapLine(loopRun: LoopRun, now: number): Promise<void> {
  const line = dueLine(loopRun, now);
  if (!line || over(loopRun)) return;
  const id = `cap_${loopRun.run.runId}_${line}`;
  const interrupt = line === CapLine.TimesUp && mayCutAtCap(loopRun);
  const params = {
    threadId: loopRun.threadId,
    into: loopRun.run.runId,
    messages: [{ id, text: lineText(loopRun, line, now) }],
    interrupt,
  };
  const answer = await loopRun.ctx.call(HostMethod.EngineSteer, params).catch(() => null);
  if (!answer?.accepted?.includes(id)) return;
  // Taken: read mid-turn (settled when the call ends), or the session was cut short for it (`SteerDelivery.Interrupt`):
  // then it never read it, and its wrap-up turn's message says it.
  heardOf(loopRun).taken.set(id, line);
}

/** The session call ended: the lines it read are heard; the ones it took and never read open the next message. */
export function settleCapLines(loopRun: LoopRun, result: Partial<DelegateResult> | undefined): void {
  const state = heardOf(loopRun);
  const read = new Set(result?.steered ?? []);
  for (const [id, line] of state.taken) if (read.has(id)) state.heard.add(line);
  state.taken.clear();
}

/**
 * The lines due at `now` that the lead has not heard, for the top of its next message, then heard:
 * the time's-up opens a wrap-up turn the cap began. The heads-up is not said once the cap has come.
 */
export function capWords(loopRun: LoopRun, now: number): string {
  const line = dueLine(loopRun, now);
  if (!line) return "";
  heardOf(loopRun).heard.add(line);
  return lineText(loopRun, line, now);
}

/** A message with the cap's due lines at its top. */
export function withCapWords(loopRun: LoopRun, prompt: string, now: number): string {
  const said = capWords(loopRun, now);
  return said ? `${said}\n\n${prompt}` : prompt;
}

/**
 * When a turn that reaches the cap must be over: for a run that hears its cap, the end of the grace
 * (the time's-up reaches it mid-turn, or cuts it short); else the cap itself, as before.
 */
export function turnEndAtCap(loopRun: LoopRun): number {
  return capWatched(loopRun) ? loopRun.finalDeadline - WRAP_UP_MARGIN_MS : loopRun.softDeadline;
}

/** Why a worker may not start now: from the cap on, none does (null before it). */
export function capRefusesWorker(loopRun: LoopRun, now: number): string | null {
  const cap = capOf(loopRun);
  if (!cap || now < Math.min(cap.capAt, loopRun.softDeadline)) return null;
  return TIME_CAP_WORDS.noNewWorkers;
}

/**
 * One session call of a web lead's, watched for its cap's lines while it runs (on `now`, looked at
 * every `CAP_WATCH_MS` of real time); what it read is heard once it ends.
 */
export async function withCapWatch(
  loopRun: LoopRun,
  now: () => number,
  call: () => Promise<Partial<DelegateResult>>,
): Promise<Partial<DelegateResult>> {
  if (!capWatched(loopRun)) return call();
  let ended = false;
  let end = () => {};
  const stopped = new Promise<void>((resolve) => {
    end = resolve;
  });
  const watching = (async () => {
    while (!ended) {
      await steerCapLine(loopRun, now()).catch(() => {});
      await Promise.race([idle(CAP_WATCH_MS, undefined, { ref: false }), stopped]);
    }
  })();
  let result: Partial<DelegateResult> | undefined;
  try {
    result = await call();
    return result;
  } finally {
    ended = true;
    end();
    await watching;
    settleCapLines(loopRun, result);
  }
}
