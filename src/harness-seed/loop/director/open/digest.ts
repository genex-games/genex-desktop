/**
 * An open Loop's wake message, read from the run at the moment of the wake (`openDigest`): what woke
 * the lead, its time, the person's words, the news, the lines Genex carried for it (what it did
 * between turns, what the project's plugins said), its save points, the work at hand and, after
 * `FRESH_EYES_MS` with no read-only worker, the reminder of a fresh look. The carried lines are told
 * once: the message takes them off the journal. Also how such a message ends (`openClosing`).
 */
import type { LoopRun } from "../loop-run.ts";
import { WakeCause, type WakeReason, type WrapCause } from "../wake-schedule.ts";
import { workAtHand } from "./active-work.ts";
import { FRESH_EYES_MS, type OpenLoop } from "./contract.ts";
import { openClosing, openDigest } from "./prompts.ts";
import { minutes } from "../../time.ts";

/** What the wake loop read for this message. */
export interface OpenWake {
  now: number;
  reasons: readonly WakeReason[];
  userSays: readonly string[];
  happened: readonly string[];
  closing: string;
  resumed?: boolean;
}

/** Whether the fresh-look reminder is due now: no reader for `FRESH_EYES_MS`, and not said for as long. Said, it is marked. */
function freshEyesDue(open: OpenLoop, now: number): boolean {
  const since = Math.max(open.journal.lastReaderAt ?? 0, open.since);
  const quiet = now - since >= FRESH_EYES_MS && now - (open.freshEyesAt ?? since) >= FRESH_EYES_MS;
  if (quiet) open.freshEyesAt = now;
  return quiet;
}

/** The open lead's wake message (the module's header). */
export function openDigestOf(loopRun: LoopRun, wake: OpenWake): string {
  const open = loopRun.open;
  return openDigest({
    reasons: wake.reasons,
    resumed: wake.resumed === true,
    now: wake.now,
    softDeadline: loopRun.softDeadline,
    userSays: wake.userSays,
    happened: wake.happened,
    carried: open ? open.journal.carried.splice(0) : [],
    savePoints: open?.journal.savePoints ?? [],
    atWork: workAtHand(loopRun),
    freshEyes: open ? freshEyesDue(open, wake.now) : false,
    closing: wake.closing,
  });
}

/** How an open wake message ends: the wrap-up, the question of what next, or carry on. */
export function openClosingOf(
  loopRun: LoopRun,
  how: { wrapping: boolean; wrapCause?: WrapCause | null; reasons: readonly WakeReason[]; now: number },
): string {
  return openClosing({
    wrapping: how.wrapping,
    wrapCause: how.wrapCause ?? null,
    idleAsk: how.reasons.includes(WakeCause.IdleAsk),
    minutesLeft: Math.max(0, minutes(loopRun.softDeadline - how.now)),
  });
}
