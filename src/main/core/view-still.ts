/**
 * A plugin's still (`observe` with `still`, plugin API 3): a plain frame of the bound game's page,
 * photographed on a hidden window of its own at the size the plugin asked for. Nothing is asked of
 * the page: it is served as Live serves it, played a moment and photographed as a player sees it.
 * It never borrows Live: a build with no hidden windows answers `unavailable` before anything is
 * loaded. The window takes the asked size for this lease only, and is given back (and closed) in
 * `finally` however the still ends; the whole still has one budget. The request reaching here was
 * checked field by field (`stillOrder` in `plugins/services.ts`).
 */
import { setTimeout as sleep } from "node:timers/promises";
import { SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import {
  PLUGIN_STILL_DEFAULT_VIEW,
  PluginStillProblemCode,
  type PluginBinding,
  type PluginStillAnswer,
  type PluginStillOrder,
  type PluginStillProblem,
} from "../../shared/plugins.ts";
import { isBlankStill } from "../../shared/preview-contract.ts";
import type { PreviewPool } from "../../substrate/preview-pool.ts";
import type { PreviewPort } from "../../substrate/preview-port.ts";
import type { PreviewService } from "./previews.ts";
import type { SessionPort } from "./session-port.ts";

/** The whole still (window, load and picture) answers within this, or answers `timeout`. */
export const STILL_TIMEOUT_MS = 60 * SECOND_MS;
/** How many more pictures a still takes while the page is still a blank or loading screen. */
export const STILL_RETAKES = 3;
/** How long the game plays between two of those pictures: time to load and draw its first frames. */
export const STILL_RETAKE_GAP_MS = 2 * SECOND_MS;
/** The long side of the JPEG preview that comes with every still. */
const STILL_PREVIEW_MAX_PX = 1280;

const MESSAGE = {
  noHiddenWindow: "this build has no hidden window to take a still on, and a still never borrows the person's own",
  noStillCapture: "this window cannot take a still",
  noLease: "the still's window was not leased",
  tooLarge: (smallest: number, limit: number) =>
    `the smallest encoding was ${smallest} bytes, over the ${limit}-byte limit`,
  timedOut: (ms: number) => `the still did not finish within ${Math.round(ms / SECOND_MS)} s`,
} as const;

/** The still's budget and its clock: a test seam (`StudioCoreOptions.pluginStill`). */
export interface ViewStillOptions {
  /** The whole still's budget; {@link STILL_TIMEOUT_MS} unless a test gives another. */
  timeoutMs?: number;
  /** Resolves once `ms` have passed and rejects when `signal` aborts: the budget's clock. */
  wait?: (ms: number, signal: AbortSignal) => Promise<unknown>;
}

/** The parts of the core's previews a still uses. */
export type ViewPreviews = Pick<PreviewService, "pool" | "sessionPortFor" | "loadServed" | "applySetup">;
/** A port that can take a still. */
type StillPort = PreviewPort & { still: NonNullable<PreviewPort["still"]> };

/** A promise that never settles: the losing side of the budget's race, made per still so nothing piles onto one. */
const never = () => new Promise<never>(() => {});
const waitFor = (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal });

/** A still's answer when it took no picture. */
type StillRefusal = { stillProblem: PluginStillProblem };

function problem(code: PluginStillProblemCode, detail: Omit<PluginStillProblem, "code"> = {}): StillRefusal {
  return { stillProblem: { code, ...detail } };
}

const canStill = (port: PreviewPort): port is StillPort => typeof port.still === "function";

/**
 * The still's window as its steps reach it: every call is refused once the budget has given the
 * still up. A step already waiting on the page (its load, a ready probe) goes on when the page
 * answers, but nothing it then asks reaches a window already given back, where a closed preview
 * would build itself a new view to answer.
 */
function untilAbandoned<P extends PreviewPort>(port: P, abandoned: AbortSignal): P {
  return new Proxy(port, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        abandoned.throwIfAborted();
        return value.apply(target, args);
      };
    },
  });
}

/** The pool, when it has hidden windows; null when the only window is the person's own, or none. */
function hiddenPool(previews: ViewPreviews): PreviewPool | null {
  try {
    const pool = previews.pool();
    return pool.headless ? pool : null;
  } catch {
    return null;
  }
}

/** The lease's own window at the asked size, or why there is none. */
async function sizedWindow(
  pool: PreviewPool,
  session: SessionPort,
  size: { width: number; height: number },
): Promise<{ port: StillPort } | { refused: PluginStillProblem }> {
  try {
    const port = await session.get();
    const handle = session.handle();
    if (!canStill(port))
      return { refused: { code: PluginStillProblemCode.Unavailable, reason: MESSAGE.noStillCapture } };
    if (!handle) return { refused: { code: PluginStillProblemCode.Unavailable, reason: MESSAGE.noLease } };
    pool.resize(handle, { width: size.width, height: size.height });
    return { port };
  } catch (err) {
    return { refused: { code: PluginStillProblemCode.Unavailable, reason: errorMessage(err) } };
  }
}

/**
 * Load the bound game in a leased window and put it in play, or answer why it did not load. A lease
 * its budget gave up on (`abandoned`) stops here, between the steps as inside them.
 */
async function openGame(
  previews: ViewPreviews,
  port: PreviewPort,
  binding: PluginBinding,
  abandoned: AbortSignal,
): Promise<PluginStillProblem | null> {
  const loaded = await previews
    .loadServed(port, binding.project, binding.directory, undefined, true)
    .catch((err: unknown) => ({ problem: errorMessage(err) }));
  abandoned.throwIfAborted();
  if (loaded.problem) return { code: PluginStillProblemCode.LoadFailed, reason: loaded.problem };
  await previews.applySetup(port, null);
  abandoned.throwIfAborted();
  return null;
}

/** The picture of the page now on screen, never larger than asked. */
async function photograph(port: StillPort, order: PluginStillOrder): Promise<PluginStillAnswer> {
  let taken: Awaited<ReturnType<StillPort["still"]>>;
  try {
    taken = await port.still({
      width: order.width,
      height: order.height,
      maxBytes: order.maxBytes,
      previewMaxPx: STILL_PREVIEW_MAX_PX,
    });
  } catch (err) {
    return problem(PluginStillProblemCode.CaptureFailed, { reason: errorMessage(err) });
  }
  if ("tooLarge" in taken)
    return problem(PluginStillProblemCode.TooLarge, {
      reason: MESSAGE.tooLarge(taken.tooLarge.smallestBytes, order.maxBytes),
    });
  const { image, mimeType, width, height, source, stats, preview } = taken.still;
  return { still: { image, mimeType, width, height, source, stats, preview } };
}

/**
 * The picture of the page, taken again after a short while of play while it is still a blank or
 * loading screen (a canvas that has not drawn, a splash cleared to one colour): at most
 * {@link STILL_RETAKES} more, then the last one is the answer, so the plugin sees what the game shows.
 */
async function photographDrawn(
  port: StillPort,
  order: PluginStillOrder,
  { abandoned, wait }: { abandoned: AbortSignal; wait: NonNullable<ViewStillOptions["wait"]> },
): Promise<PluginStillAnswer> {
  let answer = await photograph(port, order);
  for (let retake = 0; retake < STILL_RETAKES && "still" in answer && isBlankStill(answer.still.stats); retake++) {
    await wait(STILL_RETAKE_GAP_MS, abandoned);
    answer = await photograph(port, order);
  }
  return answer;
}

/**
 * Size the window, load the game, put it in play and photograph it. A still its budget gave up on
 * (`abandoned`) stops where it is: its window is already given back, and nothing may load, play or
 * photograph in it again, inside a step or between two.
 */
async function shoot(
  previews: ViewPreviews,
  pool: PreviewPool,
  session: SessionPort,
  {
    binding,
    order,
    abandoned,
    wait,
  }: {
    binding: PluginBinding;
    order: PluginStillOrder;
    abandoned: AbortSignal;
    wait: NonNullable<ViewStillOptions["wait"]>;
  },
): Promise<PluginStillAnswer> {
  const window = await sizedWindow(pool, session, order);
  if ("refused" in window) return { stillProblem: window.refused };
  const port = untilAbandoned(window.port, abandoned);
  const unopened = await openGame(previews, port, binding, abandoned);
  if (unopened) return { stillProblem: unopened };
  return photographDrawn(port, order, { abandoned, wait });
}

/**
 * One still of the page, on a hidden window leased for it alone. Answers the still or the problem
 * that stopped it, within the budget; the window is given back before it answers. A request naming
 * a view other than the default is refused `view_unknown` before a window is leased.
 */
export async function viewStill(
  previews: ViewPreviews,
  binding: PluginBinding,
  order: PluginStillOrder,
  options: ViewStillOptions = {},
): Promise<PluginStillAnswer> {
  if (order.camera !== PLUGIN_STILL_DEFAULT_VIEW)
    return problem(PluginStillProblemCode.ViewUnknown, { available: [PLUGIN_STILL_DEFAULT_VIEW] });
  const pool = hiddenPool(previews);
  if (!pool) return problem(PluginStillProblemCode.Unavailable, { reason: MESSAGE.noHiddenWindow });
  const timeoutMs = options.timeoutMs ?? STILL_TIMEOUT_MS;
  const budget = new AbortController();
  const session = previews.sessionPortFor({ label: `still:${binding.project}` });
  const wait = options.wait ?? waitFor;
  const work = shoot(previews, pool, session, { binding, order, abandoned: budget.signal, wait });
  // Work abandoned at its deadline stops at its next step; nobody reads what it settles to.
  work.catch(() => {});
  const late = wait(timeoutMs, budget.signal).then(
    () => problem(PluginStillProblemCode.Timeout, { reason: MESSAGE.timedOut(timeoutMs) }),
    never,
  );
  try {
    return await Promise.race([work, late]);
  } finally {
    budget.abort();
    await session.release();
  }
}
