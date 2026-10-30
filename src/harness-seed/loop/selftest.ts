/**
 * The loop's self-test: the pure logic of the Loop against fixed inputs — when its lead is woken,
 * what the end of a turn means, the health check's line, which runner a run goes to, the run's clock, the
 * plain sentence a card falls back on, what a landing claims, the wrap-up's reserve and a reviewer's no. No engine, no preview, no network: seconds, deterministic.
 */
import { afterTurn, nextWake, TurnEnd, WakeCause } from "./director/wake-schedule.ts";
import { landingWords, plainly } from "./director/rules.ts";
import { wrapReserveMs } from "./director/journal.ts";
import { secondOpinionNo } from "./director/second-opinion-prompts.ts";
import { healthLine } from "./health-check.ts";
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
  softDeadline: now + HOUR_MS,
  wrapping: false,
  wakesAt: [],
});

/** The self-test, step by step, in the order it runs. */
const SELFTEST_STEPS: readonly SelftestStep[] = [
  [
    "wake: the user wakes the lead at once; a quiet run waits for the wrap-up",
    () => {
      const now = 1_000_000;
      const spoke = nextWake({ ...quietView(now), userWaiting: true });
      check("user wakes now", spoke?.at === now && spoke.reasons.includes(WakeCause.UserMessage));
      const quiet = nextWake(quietView(now));
      check("a quiet run waits for the wrap-up", quiet?.at === now + HOUR_MS && quiet.reasons[0] === WakeCause.WrapUp);
    },
  ],
  [
    "turn end: the lead rests, never wrapped up for being quiet; out of time wraps up",
    () => {
      const base = { ok: true, closed: false, workingTimeLeft: true, finishRequested: false };
      check("a turn end rests", afterTurn(base).next === TurnEnd.Sleep);
      check("out of time wraps up", afterTurn({ ...base, workingTimeLeft: false }).next === TurnEnd.WrapUp);
    },
  ],
  [
    "health: a check's line says it passed, or what is wrong",
    () => {
      check(
        "healthy",
        healthLine({ ok: true, problems: [], picture: null, unchecked: null }).startsWith("Health check:"),
      );
      const failed = healthLine({ ok: false, problems: ["1 uncaught error: x"], picture: null, unchecked: null });
      check("failed names it", failed.includes("1 uncaught error: x"));
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
  [
    "landing: a build is said to load only when it passed its health check",
    () => {
      check("passed says so", landingWords({ healthPassed: true }).line.includes("it loads"));
      check("unchecked says so", !landingWords({ healthPassed: false }).line.includes("it loads"));
      check("never a verdict", !landingWords({ healthPassed: true }).verified);
    },
  ],
  [
    "wrap-up: its reserve is a share of the run, bounded on both sides",
    () => {
      const hour = wrapReserveMs(HOUR_MS);
      check("inside the run", hour > 0 && hour < HOUR_MS);
      check("grows with the run, within its bounds", wrapReserveMs(24 * HOUR_MS) >= hour);
      check("never above a short run", wrapReserveMs(10 * MINUTE_MS) <= wrapReserveMs(HOUR_MS));
    },
  ],
  [
    "second opinion: a reviewer's no decides nothing, and the lead hears what it named",
    () => {
      const no = secondOpinionNo(["the timer never shows"], ["the third lap"]);
      check("decides nothing", no.includes("decides nothing"));
      check("names its reasons", no.includes("the timer never shows") && no.includes("the third lap"));
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
