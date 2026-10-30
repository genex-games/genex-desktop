/**
 * The one health check of a web game's Loop, before a worker's work is merged in and before the
 * build lands: the page loads, it logs no uncaught error, and its screenshot is not blank. Genex
 * looks from outside only — it serves the page in a window of its own, reads the window's console
 * and takes a screenshot of the whole page (its HTML included) — and asks nothing of the game's code.
 * It never throws: a window that never came is a check that could not be made, said so.
 */
import { WINDOW_RETRIES_MS } from "./config.ts";
import { HostMethod } from "./host-methods.ts";
import { isRecord } from "./json.ts";
import { PreviewConsoleSource } from "./preview-gone.ts";
import { CLIP_DETAIL, clip } from "./text.ts";
import { SECOND_MS, sleep } from "./time.ts";
import type { HarnessCtx } from "../types/harness.d.ts";
import type { PreviewConsoleEntry } from "../types/host-api.d.ts";

/** How long the page has to say it is ready before the check reads it anyway. */
const READY_TIMEOUT_MS = 20 * SECOND_MS;
/** A page that said it is ready runs this long before its console and its picture are read. */
const SETTLE_MS = 2 * SECOND_MS;
/** Below this spread of brightness (0–255) a screenshot is one flat colour: blank. */
const BLANK_CONTRAST = 1;
/** With no spread measured, a screenshot this dark all over is blank. */
const BLANK_LIT_FRACTION = 0.005;
/** The most errors a check names. */
const MAX_ERRORS = 5;
/** The console levels that are errors. */
const ERROR_LEVEL = "error";

/** What a health check found: whether the build is healthy, and each thing that is wrong in words. */
export interface HealthCheck {
  ok: boolean;
  /** The page loaded (no load error, no crashed window). */
  loaded: boolean;
  /** The errors the page logged, its own words. */
  errors: string[];
  /** The screenshot was one flat colour, or none could be taken. */
  blank: boolean;
  /** The screenshot the check took, when the host kept a file of it. */
  picture: string | null;
  /** Why the check could not be made (no window), else null. */
  unchecked: string | null;
  /** Each problem, a sentence. */
  problems: string[];
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

/** The words of a check's problems. */
export const HEALTH_WORDS = {
  loadFailed: (why: string) => `the page did not load: ${why}`,
  crashed: "the page's window crashed",
  errors: (lines: readonly string[]) => `the page logged errors: ${lines.join(" | ")}`,
  blank: "the screenshot is blank (one flat colour)",
  noPicture: "no screenshot could be taken",
  noWindow: "no window was free for the health check",
  failed: (why: string) => `the health check could not run: ${why}`,
} as const;

/** The page's own error lines, never the studio's notes about its window. */
export function pageErrors(entries: readonly PreviewConsoleEntry[] | unknown): string[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry): entry is PreviewConsoleEntry => isRecord(entry) && entry.level === ERROR_LEVEL)
    .filter((entry) => entry.source !== PreviewConsoleSource.WindowGone && entry.source !== PreviewConsoleSource.Observation)
    .map((entry) => clip(String(entry.message ?? ""), CLIP_DETAIL));
}

/** Whether a screenshot's pixel statistics say it is one flat colour (or black, where no spread was measured). */
export function blankPicture(stats: unknown): boolean {
  if (!isRecord(stats)) return true;
  if (typeof stats.contrast === "number") return stats.contrast < BLANK_CONTRAST;
  return typeof stats.litFraction === "number" ? stats.litFraction < BLANK_LIT_FRACTION : true;
}

/** A leased window, or null when none came after the retries. */
async function leaseWindow(ctx: HarnessCtx, label: string): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    const lease = await ctx.call(HostMethod.PreviewAcquire, { label }).catch(() => null);
    if (lease?.handle) return lease.handle;
    if (attempt >= WINDOW_RETRIES_MS.length || ctx.cancelled) return null;
    await sleep(WINDOW_RETRIES_MS[attempt]);
  }
}

/** The look itself, in a window of its own. */
async function lookIn(ctx: HarnessCtx, target: HealthTarget, handle: string): Promise<HealthCheck> {
  const h = { handle };
  const where = { ...(target.root ? { root: target.root } : {}), ...(target.entry ? { entry: target.entry } : {}) };
  await ctx.call(HostMethod.PreviewLoad, { project: target.project, ...where, ...h });
  await ctx.call(HostMethod.PreviewReady, { ...h, timeoutMs: READY_TIMEOUT_MS }).catch(() => null);
  await sleep(SETTLE_MS);
  const status = await ctx.call(HostMethod.PreviewStatus, { ...h }).catch(() => null);
  const problems: string[] = [];
  const loadError = typeof status?.loadError === "string" && status.loadError ? status.loadError : null;
  if (loadError) problems.push(HEALTH_WORDS.loadFailed(clip(loadError, CLIP_DETAIL)));
  if (status?.crashed) problems.push(HEALTH_WORDS.crashed);
  const errors = pageErrors(await ctx.call(HostMethod.PreviewConsole, { sinceMs: 0, ...h }).catch(() => []));
  if (errors.length) problems.push(HEALTH_WORDS.errors(errors.slice(0, MAX_ERRORS)));
  const shot = await ctx
    .call(HostMethod.PreviewScreenshot, {
      ...h,
      surface: "page",
      label: target.label,
      ...(target.runId ? { runId: target.runId } : {}),
    })
    .catch(() => null);
  const blank = !shot || blankPicture(shot.stats);
  if (blank) problems.push(shot ? HEALTH_WORDS.blank : HEALTH_WORDS.noPicture);
  const loaded = !loadError && status?.crashed !== true;
  return {
    ok: problems.length === 0,
    loaded,
    errors,
    blank,
    picture: typeof shot?.path === "string" ? shot.path : null,
    unchecked: null,
    problems,
  };
}

/** A check that could not be made, and why. */
function unchecked(why: string): HealthCheck {
  return { ok: false, loaded: false, errors: [], blank: true, picture: null, unchecked: why, problems: [why] };
}

/**
 * Check the build in `target`: the page loads, no uncaught error, a screenshot that is not blank.
 * The window is Genex's own (never the person's Live), and it is given back whatever happened.
 */
export async function checkHealth(ctx: HarnessCtx, target: HealthTarget): Promise<HealthCheck> {
  const handle = await leaseWindow(ctx, target.label);
  if (!handle) return unchecked(HEALTH_WORDS.noWindow);
  try {
    return await lookIn(ctx, target, handle);
  } catch (err) {
    return unchecked(HEALTH_WORDS.failed(clip(String((err as Error)?.message ?? err), CLIP_DETAIL)));
  } finally {
    await ctx.call(HostMethod.PreviewRelease, { handle }).catch(() => {});
  }
}

/** A check in one line for the lead: healthy, or what is wrong. */
export function healthLine(check: HealthCheck): string {
  if (check.ok) return "Health check: the page loads, logs no errors and shows a picture.";
  return `Health check failed: ${check.problems.join("; ")}.`;
}
