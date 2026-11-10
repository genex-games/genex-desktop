/**
 * Genex's look at a web game's page from outside, as a build's picture is taken: a pooled window of
 * its own (never the person's Live), the page loaded once with the `genex-shot` parameter on its
 * address (`preview.load` `shot`), waited for and let run a moment, then photographed whole. The
 * finish's health check (`health-check.ts`) looks this way before it asks the host's check, and a
 * save point with no picture of its own looks this way for one (`pagePicture`). A module of its own,
 * so a `health-check.ts` an agent kept from before still loads beside it.
 */
import { WINDOW_RETRIES_MS } from "./config.ts";
import { HostMethod } from "./host-methods.ts";
import { SECOND_MS, sleep } from "./time.ts";
import type { HarnessCtx } from "../types/harness.d.ts";

/** How long the page has to say it is ready before the look reads it anyway. */
const READY_TIMEOUT_MS = 20 * SECOND_MS;
/** A page that said it is ready runs this long before it is read, so an error in its first frames counts. */
const SETTLE_MS = 2 * SECOND_MS;

/** A wait of `ms` milliseconds. */
export type Wait = (ms: number) => Promise<void>;

/** What a look is at: the project, the folder whose page it serves (a worktree), and the run that files its picture. */
export interface PageTarget {
  project: string;
  /** The folder to serve; absent: the project's own folder. */
  root?: string | null;
  /** The page to load in it, when it is not the folder's own index.html. */
  entry?: string;
  runId?: string;
  /** The window's label, and the picture's name in the run's folder. */
  label: string;
}

/** A leased window, or null when none came after the retries. */
async function leaseWindow(ctx: HarnessCtx, label: string, wait: Wait): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    const lease = await ctx.call(HostMethod.PreviewAcquire, { label }).catch(() => null);
    if (lease?.handle) return lease.handle;
    if (attempt >= WINDOW_RETRIES_MS.length || ctx.cancelled) return null;
    await wait(WINDOW_RETRIES_MS[attempt]);
  }
}

/** The page loaded once in the window as a build's picture is taken, ready and settled. */
export async function loadAsShot(ctx: HarnessCtx, target: PageTarget, handle: string, wait: Wait): Promise<void> {
  const where = { ...(target.root ? { root: target.root } : {}), ...(target.entry ? { entry: target.entry } : {}) };
  await ctx.call(HostMethod.PreviewLoad, { project: target.project, ...where, handle, shot: true });
  await ctx.call(HostMethod.PreviewReady, { handle, timeoutMs: READY_TIMEOUT_MS }).catch(() => null);
  await wait(SETTLE_MS);
}

/**
 * `look` in a leased window of Genex's own, given back whatever happened: its answer, else
 * `noWindow()` when none came after the retries, or `failed(error)` when the look threw.
 */
export async function inPageWindow<T>(
  ctx: HarnessCtx,
  label: string,
  wait: Wait,
  look: (handle: string) => Promise<T>,
  otherwise: { noWindow: () => T; failed: (error: unknown) => T },
): Promise<T> {
  const handle = await leaseWindow(ctx, label, wait);
  if (!handle) return otherwise.noWindow();
  try {
    return await look(handle);
  } catch (error) {
    return otherwise.failed(error);
  } finally {
    await ctx.call(HostMethod.PreviewRelease, { handle }).catch(() => {});
  }
}

/** The page's screenshot as a file for the record, or null when the host kept none. */
export async function keepPicture(ctx: HarnessCtx, target: PageTarget, handle: string): Promise<string | null> {
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

/**
 * A picture of the page in `target`, with no check: the screenshot's file under the run, or null
 * when no window came, the run was stopped meanwhile or the host kept none. Never throws, and the
 * window is given back whatever happened.
 */
export async function pagePicture(
  ctx: HarnessCtx,
  target: PageTarget,
  { sleep: wait = sleep }: { sleep?: Wait } = {},
): Promise<string | null> {
  // A Stop or a pause while the window came, or while the page loaded, takes no picture.
  const photographed = async (handle: string) => {
    if (ctx.cancelled) return null;
    await loadAsShot(ctx, target, handle, wait);
    return ctx.cancelled ? null : keepPicture(ctx, target, handle);
  };
  return inPageWindow(ctx, target.label, wait, photographed, { noWindow: () => null, failed: () => null });
}
