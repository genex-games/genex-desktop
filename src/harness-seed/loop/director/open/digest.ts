/**
 * An open Loop's wake message, read from the run at the moment of the wake (`openDigest`): what woke
 * the lead, its time, the person's words, the news, the lines Genex carried for it (what it did
 * between turns, what the project's plugins said), its save points, and the work at hand. The carried lines are told
 * once: the message takes them off the journal. Also how such a message ends (`openClosing`).
 */
import type { LoopRun } from "../loop-run.ts";
import type { WakeReason, WrapCause } from "../wake-schedule.ts";
import { workAtHand } from "./active-work.ts";
import { openClosing, openDigest } from "./prompts.ts";

/** What the wake loop read for this message. */
export interface OpenWake {
  now: number;
  reasons: readonly WakeReason[];
  userSays: readonly string[];
  happened: readonly string[];
  closing: string;
  resumed?: boolean;
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
    closing: wake.closing,
  });
}

/** How an open wake message ends: the wrap-up (saying why), or the ordinary closing. */
export function openClosingOf(how: { wrapping: boolean; wrapCause?: WrapCause | null }): string {
  return openClosing({ wrapping: how.wrapping, wrapCause: how.wrapCause ?? null });
}
