/**
 * The one health check of a web game's Loop, before a worker's work is merged in and before the
 * build lands: the page loads, it throws no uncaught error, and its frame is not blank. Genex looks
 * from outside only: it serves the build in a window of its own, waits for it, and asks the host's
 * own check (`preview.observe`), which reads the window's load, the page's uncaught errors and a
 * screenshot of the whole page. A screenshot is kept as the check's picture. The page is loaded once,
 * with the `genex-shot` parameter on its address (`preview.load` `shot`): a game may read it, and
 * one that ignores it loses nothing. Nothing is asked of the game's code. It never throws: a window
 * that never came is a check that could not be made, said so.
 */
import { WINDOW_RETRIES_MS } from "./config.ts";
import { HostMethod } from "./host-methods.ts";
import { CLIP_DETAIL, clip } from "./text.ts";
import { SECOND_MS, sleep } from "./time.ts";
import type { HarnessCtx } from "../types/harness.d.ts";

/** How long the page has to say it is ready before the check reads it anyway. */
const READY_TIMEOUT_MS = 20 * SECOND_MS;
/** A page that said it is ready runs this long before it is checked, so an error in its first frames counts. */
const SETTLE_MS = 2 * SECOND_MS;

/** A wait of `ms` milliseconds. */
type Wait = (ms: number) => Promise<void>;

/** What a health check found: whether the build is healthy, and each thing that is wrong in words. */
export interface HealthCheck {
  ok: boolean;
  /** Each problem, a sentence: the host's own reasons, or why no check could be made. */
  problems: string[];
  /** The host's code for each of its own reasons (`not_loaded`, `crashed`, `uncaught`, `blank`), when it gave them. */
  findings?: string[];
  /** The screenshot the check kept, when the host kept a file of it. */
  picture: string | null;
  /** Why the check could not be made (no window, the host failed), else null. */
  unchecked: string | null;
}

/** What a check looks at: the project, the folder whose page it serves (a worktree), and the run that files its picture. */
export interface HealthTarget {
  project: string;
  /** The folder to serve; absent: the project's own folder. */
  root?: string | null;
  /** The page to load in it, when it is not the folder's own index.html. */
  entry?: string;
  runId?: string;
  label: string;
}

/** How a check waits: the run's own clock, so a test's clock moves its waits; the wall clock otherwise. */
export interface HealthOptions {
  sleep?: Wait;
}

/** The words of a check that could not be made. */
export const HEALTH_WORDS = {
  noWindow: "no window was free for the health check",
  noAnswer: "the host's health check did not answer",
  failed: (why: string) => `the health check could not run: ${why}`,
} as const;

/** A leased window, or null when none came after the retries. */
async function leaseWindow(ctx: HarnessCtx, label: string, wait: Wait): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    const lease = await ctx.call(HostMethod.PreviewAcquire, { label }).catch(() => null);
    if (lease?.handle) return lease.handle;
    if (attempt >= WINDOW_RETRIES_MS.length || ctx.cancelled) return null;
    await wait(WINDOW_RETRIES_MS[attempt]);
  }
}

/** The page's screenshot as a file for the record, or null when the host kept none. */
async function keepPicture(ctx: HarnessCtx, target: HealthTarget, handle: string): Promise<string | null> {
  const shot = await ctx
    .call(HostMethod.PreviewScreenshot, {
      handle,
      surface: "page",
      label: target.label,
      ...(target.runId ? { runId: target.runId } : {}),
    })
    .catch(() => null);
  return typeof shot?.path === "string" ? shot.path : null;
}

/** The look itself, in a window of its own. */
async function lookIn(ctx: HarnessCtx, target: HealthTarget, handle: string, wait: Wait): Promise<HealthCheck> {
  const where = { ...(target.root ? { root: target.root } : {}), ...(target.entry ? { entry: target.entry } : {}) };
  await ctx.call(HostMethod.PreviewLoad, { project: target.project, ...where, handle, shot: true });
  await ctx.call(HostMethod.PreviewReady, { handle, timeoutMs: READY_TIMEOUT_MS }).catch(() => null);
  await wait(SETTLE_MS);
  const observed = await ctx.call(HostMethod.PreviewObserve, { handle });
  if (!observed || typeof observed.ok !== "boolean") return unchecked(HEALTH_WORDS.noAnswer);
  const problems = (Array.isArray(observed.reasons) ? observed.reasons : []).map((reason) =>
    clip(String(reason), CLIP_DETAIL),
  );
  const ok = observed.ok && problems.length === 0;
  const findings = Array.isArray(observed.findings) ? { findings: observed.findings.map(String) } : {};
  return { ok, problems, ...findings, picture: await keepPicture(ctx, target, handle), unchecked: null };
}

/** A check that could not be made, and why. */
function unchecked(why: string): HealthCheck {
  return { ok: false, problems: [why], picture: null, unchecked: why };
}

/**
 * Check the build in `target`: the page loads, no uncaught error, a frame that is not blank. The
 * window is Genex's own (never the person's Live), and it is given back whatever happened.
 */
export async function checkHealth(
  ctx: HarnessCtx,
  target: HealthTarget,
  { sleep: wait = sleep }: HealthOptions = {},
): Promise<HealthCheck> {
  const handle = await leaseWindow(ctx, target.label, wait);
  if (!handle) return unchecked(HEALTH_WORDS.noWindow);
  try {
    return await lookIn(ctx, target, handle, wait);
  } catch (err) {
    return unchecked(HEALTH_WORDS.failed(clip(String((err as Error)?.message ?? err), CLIP_DETAIL)));
  } finally {
    await ctx.call(HostMethod.PreviewRelease, { handle }).catch(() => {});
  }
}

/** A check in one line for the lead: healthy, or what is wrong. */
export function healthLine(check: HealthCheck): string {
  if (check.ok) return "Health check: the page loads, throws no uncaught error and its frame is not blank.";
  return `Health check failed: ${check.problems.join("; ")}.`;
}
