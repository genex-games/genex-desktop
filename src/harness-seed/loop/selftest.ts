/**
 * The loop's self-test: the pure logic of the Loop against fixed inputs — when its lead is woken,
 * what the end of a turn means, the health check's reading of a page, which runner a run goes to, and
 * the plain sentence a card falls back on. No engine, no preview, no network: seconds, deterministic.
 */
import { afterTurn, nextWake, TurnEnd, WakeCause, WrapCause } from "./director/wake-schedule.ts";
import { plainly } from "./director/rules.ts";
import { blankPicture, pageErrors } from "./health-check.ts";
import { chooseRunner } from "./run-dispatch.ts";
import { RunnerKind } from "./studio-state.ts";
import { LoopProfile } from "./folder-facts.ts";
import { capClock } from "./time-cap.ts";
import { HOUR_MS, MINUTE_MS } from "./time.ts";
import type { Run } from "../types/harness.d.ts";

function check(name: string, condition: unknown): void {
  if (!condition) throw new Error(`selftest failed: ${name}`);
}

/** One self-test step: its name, and the checks it runs over fixed inputs (it throws on the first failure). */
type SelftestStep = readonly [name: string, run: () => void];

/** A view of a resting lead with nothing going on, at `now`. */
const quietView = (now: number) => ({
  now,
  unread: [],
  asleepFromSeq: 0,
  asleepSince: now,
  userWaiting: false,
  finishNew: false,
  running: 0,
  softDeadline: now + HOUR_MS,
  wrapping: false,
  idleDue: false,
  idleAsked: false,
  wakesAt: [],
});

/** The self-test, step by step, in the order it runs. */
const SELFTEST_STEPS: readonly SelftestStep[] = [
  [
    "wake: the user wakes the lead at once; a quiet run asks once what next",
    () => {
      const now = 1_000_000;
      const spoke = nextWake({ ...quietView(now), userWaiting: true });
      check("user wakes now", spoke?.at === now && spoke.reasons.includes(WakeCause.UserMessage));
      const idle = nextWake(quietView(now));
      check("idle run is asked", idle?.reasons.includes(WakeCause.IdleAsk));
      const busy = nextWake({ ...quietView(now), running: 1 });
      check("a busy run waits for the wrap-up", busy?.at === now + HOUR_MS);
    },
  ],
  [
    "turn end: busy rests, idle is asked once, then wraps up",
    () => {
      const base = { ok: true, closed: false, running: 0, idleAsked: false, workingTimeLeft: true, finishRequested: false };
      check("busy sleeps", afterTurn({ ...base, running: 2 }).next === TurnEnd.Sleep);
      check("idle asks", afterTurn(base).next === TurnEnd.AskIdle);
      const twice = afterTurn({ ...base, idleAsked: true });
      check("idle twice wraps up", twice.next === TurnEnd.WrapUp && twice.wrapCause === WrapCause.Idle);
      check("out of time wraps up", afterTurn({ ...base, workingTimeLeft: false }).next === TurnEnd.WrapUp);
    },
  ],
  [
    "health: a flat picture is blank, the page's own errors count",
    () => {
      check("flat is blank", blankPicture({ contrast: 0, litFraction: 1 }));
      check("varied is not blank", !blankPicture({ contrast: 30, litFraction: 0.4 }));
      const errors = pageErrors([
        { at: 1, level: "error", message: "Uncaught TypeError: x is undefined" },
        { at: 2, level: "error", message: "window gone", source: "studio:window-gone" },
        { at: 3, level: "log", message: "hello" },
      ]);
      check("one page error", errors.length === 1 && errors[0].includes("TypeError"));
    },
  ],
  [
    "runner: a session engine leads; one without a session is refused",
    () => {
      const run = { runId: "r", goal: "g", project: "p", engine: "claude" } as unknown as Run;
      const seated = [{ id: "claude", kind: "delegated" }] as never[];
      const plain = [{ id: "claude", kind: "direct", supportsSessions: false }] as never[];
      check("session leads", chooseRunner(run, seated, LoopProfile.Web) === RunnerKind.Director);
      check("no session refused", chooseRunner(run, plain, LoopProfile.Web) === RunnerKind.NeedsSession);
    },
  ],
  [
    "clock: a resumed Loop goes on with the time it had left",
    () => {
      const now = 10 * HOUR_MS;
      const clock = capClock({ saved: { workedMs: 30 * MINUTE_MS }, now, totalMs: HOUR_MS });
      check("cap is half an hour away", clock.softDeadline - now === 30 * MINUTE_MS);
    },
  ],
  [
    "cards: shas and paths are taken out of the plain sentence",
    () => {
      const plain = plainly("merged w1 at 0123456789abcdef into /Users/me/game");
      check("no sha or path", !plain.includes("0123456789") && !plain.includes("/Users"));
    },
  ],
];

export async function runSelftest() {
  const started = Date.now();
  const passed: string[] = [];
  for (const [name, run] of SELFTEST_STEPS) {
    run();
    passed.push(name);
  }
  return { ok: true, passed, durationMs: Date.now() - started };
}
