/**
 * What the engines share when a session gets a copy of a CLI's sign-in that it cannot renew for the
 * person (Grok Build on Windows, Pi on macOS and Linux): the person's own CLI renews a sign-in that
 * would not outlast a session, on the host, before the copy is made. These are the timings of that.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";

/**
 * How long a session's copy of the sign-in should still work: a token is renewed with this long
 * left, or half its life when that is less, so a new token is never counted due too.
 */
export const SESSION_SIGN_IN_HOLD_MS = 2 * HOUR_MS;
/** How long a run waits on the renewal before it gets what is there; the renewal goes on without it. */
export const RENEWAL_WAIT_MS = 20 * SECOND_MS;
/** How long the person's own CLI gets to renew before it is asked to stop: a run's wait never cuts it. */
export const RENEWAL_CAP_MS = 2 * MINUTE_MS;
/** How long a sign-in a renewal left as it was waits before it is tried again: offline, the provider down. */
export const RENEWAL_RETRY_MS = 5 * MINUTE_MS;

/** Waits for `work`, or `ms` if that comes first; the timer goes either way. */
export async function within(work: Promise<void>, ms: number): Promise<void> {
  const timer = new AbortController();
  await Promise.race([work, sleep(ms, undefined, { signal: timer.signal }).catch(() => {})]);
  timer.abort();
}
