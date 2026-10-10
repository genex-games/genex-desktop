/**
 * A plugin's still (`observe` with `still`, plugin API 3): one named view of the bound game, a
 * demo run to its end state or a camera placed, photographed on a hidden window of its own at the
 * size the plugin asked for. It never borrows Live: a build with no hidden windows answers
 * `unavailable` before anything is loaded. The window takes the asked size for this lease only, and
 * is given back (and closed) in `finally` however the still ends; the whole still has one budget.
 * The request reaching here was checked field by field (`stillOrder` in `plugins/services.ts`).
 */
import { setTimeout as sleep } from "node:timers/promises";
import { SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import {
  PLUGIN_STILL_AVAILABLE_MAX,
  PLUGIN_STILL_VIEW_NAME,
  PluginStillProblemCode,
  type PluginBinding,
  type PluginStillAnswer,
  type PluginStillOrder,
  type PluginStillProblem,
  type PluginStillView,
} from "../../shared/plugins.ts";
import { GameView } from "../../shared/preview-contract.ts";
import type { PreviewPool } from "../../substrate/preview-pool.ts";
import type { PreviewPort } from "../../substrate/preview-port.ts";
import type { PreviewService } from "./previews.ts";
import type { SessionPort } from "./session-port.ts";

/** The whole still (window, load, view and picture) answers within this, or answers `timeout`. */
export const STILL_TIMEOUT_MS = 60 * SECOND_MS;
/** The long side of the JPEG preview that comes with every still. */
const STILL_PREVIEW_MAX_PX = 1280;
/** How much of the page's own words about a view a problem quotes. */
const PAGE_REASON_CHARS = 240;
/** The view the game renders itself: the page places it whatever names its cameras have. */
const DEFAULT_CAMERA = "default";

const MESSAGE = {
  noHiddenWindow: "this build has no hidden window to take a still on, and a still never borrows the person's own",
  noStillCapture: "this window cannot take a still",
  noLease: "the still's window was not leased",
  viewSilent: "the page gave no answer about the view",
  viewRefused: "the page refused the view without a reason",
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
type StillPreviews = Pick<PreviewService, "pool" | "sessionPortFor" | "loadServed" | "applySetup">;
/** A port that can take a still. */
type StillPort = PreviewPort & { still: NonNullable<PreviewPort["still"]> };
/** What the page answered a `__studio` call, or why the call itself failed. */
type PageAnswer = { answer: unknown } | { threw: string };

/** A promise that never settles: the losing side of the budget's race, made per still so nothing piles onto one. */
const never = () => new Promise<never>(() => {});
const waitFor = (ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal });

function problem(code: PluginStillProblemCode, detail: Omit<PluginStillProblem, "code"> = {}): PluginStillAnswer {
  return { stillProblem: { code, ...detail } };
}

const canStill = (port: PreviewPort): port is StillPort => typeof port.still === "function";

/**
 * The still's window as its steps reach it: every call is refused once the budget has given the
 * still up. A step already waiting on the page (its load, a ready probe, `start`, `demos`) goes on
 * when the page answers, but nothing it then asks reaches a window already given back, where a
 * closed preview would build itself a new view to answer.
 */
function untilAbandoned(port: StillPort, abandoned: AbortSignal): StillPort {
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
function hiddenPool(previews: StillPreviews): PreviewPool | null {
  try {
    const pool = previews.pool();
    return pool.headless ? pool : null;
  } catch {
    return null;
  }
}

/** The names among a page's answer a still could ask for, each once, at most {@link PLUGIN_STILL_AVAILABLE_MAX}. */
function viewNames(listed: readonly unknown[]): string[] {
  const names = listed.filter((name): name is string => typeof name === "string" && PLUGIN_STILL_VIEW_NAME.test(name));
  return [...new Set(names)].slice(0, PLUGIN_STILL_AVAILABLE_MAX);
}

/** The page's own words, cut to a length an answer can carry. */
const pageReason = (text: string) => text.slice(0, PAGE_REASON_CHARS);

async function pageCall(port: PreviewPort, method: GameView, arg?: string): Promise<PageAnswer> {
  try {
    return { answer: await port.studioCall(method, arg) };
  } catch (err) {
    return { threw: errorMessage(err) };
  }
}

/**
 * A demo or camera call's outcome: null when the view is on screen; `view_unknown` with the names
 * the page has when it has none by that one (or no contract at all); `view_failed` otherwise.
 */
function viewOutcome(called: PageAnswer): PluginStillAnswer | null {
  if ("threw" in called) return problem(PluginStillProblemCode.ViewFailed, { reason: called.threw });
  const { answer } = called;
  if (answer === null || typeof answer !== "object")
    return problem(PluginStillProblemCode.ViewFailed, { reason: MESSAGE.viewSilent });
  const said = answer as Record<string, unknown>;
  if (typeof said.__error === "string")
    return problem(PluginStillProblemCode.ViewFailed, { reason: pageReason(said.__error) });
  if (said.ok === true) return null;
  if (said.__missing === true) return problem(PluginStillProblemCode.ViewUnknown, { available: [] });
  if (Array.isArray(said.available))
    return problem(PluginStillProblemCode.ViewUnknown, { available: viewNames(said.available) });
  const reason = typeof said.reason === "string" ? pageReason(said.reason) : MESSAGE.viewRefused;
  return problem(PluginStillProblemCode.ViewFailed, { reason });
}

/** The names a page lists for `method`, none when it has no such list, or why the call failed. */
async function listedNames(port: PreviewPort, method: GameView): Promise<{ names: unknown[] } | { threw: string }> {
  const listed = await pageCall(port, method);
  if ("threw" in listed) return listed;
  return { names: Array.isArray(listed.answer) ? listed.answer : [] };
}

/** Run a demo the game lists, to its end state; a name it does not list is never called. */
async function runDemo(port: PreviewPort, name: string): Promise<PluginStillAnswer | null> {
  const listed = await listedNames(port, GameView.Demos);
  if ("threw" in listed) return problem(PluginStillProblemCode.ViewFailed, { reason: listed.threw });
  if (!listed.names.includes(name))
    return problem(PluginStillProblemCode.ViewUnknown, { available: viewNames(listed.names) });
  return viewOutcome(await pageCall(port, GameView.Demo, name));
}

/**
 * Place a camera the game lists (its own `cameras()` and the built-in `eyes()`), or its own view
 * by `default`; any other name is never called. Every game looks a camera up on a plain object, so
 * an unlisted `constructor` or `toString` would otherwise "place" a camera the game never had.
 */
async function placeCamera(port: PreviewPort, name: string): Promise<PluginStillAnswer | null> {
  const cameras = await listedNames(port, GameView.Cameras);
  if ("threw" in cameras) return problem(PluginStillProblemCode.ViewFailed, { reason: cameras.threw });
  const eyes = await listedNames(port, GameView.Eyes);
  if ("threw" in eyes) return problem(PluginStillProblemCode.ViewFailed, { reason: eyes.threw });
  const names = [...cameras.names, ...eyes.names];
  if (name !== DEFAULT_CAMERA && !names.includes(name))
    return problem(PluginStillProblemCode.ViewUnknown, { available: viewNames(names) });
  return viewOutcome(await pageCall(port, GameView.DebugCamera, name));
}

/** The view a checked order names, as the answer echoes it. */
function viewOf(order: PluginStillOrder): PluginStillView {
  return order.demo !== undefined ? { demo: order.demo } : { camera: order.camera };
}

/** The still's own window at the asked size, or why there is none. */
async function sizedWindow(
  pool: PreviewPool,
  session: SessionPort,
  order: PluginStillOrder,
): Promise<{ port: StillPort } | { refused: PluginStillAnswer }> {
  try {
    const port = await session.get();
    const handle = session.handle();
    if (!canStill(port))
      return { refused: problem(PluginStillProblemCode.Unavailable, { reason: MESSAGE.noStillCapture }) };
    if (!handle) return { refused: problem(PluginStillProblemCode.Unavailable, { reason: MESSAGE.noLease }) };
    pool.resize(handle, { width: order.width, height: order.height });
    return { port };
  } catch (err) {
    return { refused: problem(PluginStillProblemCode.Unavailable, { reason: errorMessage(err) }) };
  }
}

/** The picture of the view now on screen, never larger than asked. */
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
  return { still: { image, mimeType, width, height, source, view: viewOf(order), stats, preview } };
}

/**
 * Size the window, load the game, put it in play, place the view and photograph it. A still its
 * budget gave up on (`abandoned`) stops where it is: its window is already given back, and nothing
 * may load, probe, play or photograph in it again, inside a step or between two.
 */
async function shoot(
  previews: StillPreviews,
  pool: PreviewPool,
  session: SessionPort,
  { binding, order, abandoned }: { binding: PluginBinding; order: PluginStillOrder; abandoned: AbortSignal },
): Promise<PluginStillAnswer> {
  const window = await sizedWindow(pool, session, order);
  if ("refused" in window) return window.refused;
  const port = untilAbandoned(window.port, abandoned);
  const loaded = await previews
    .loadServed(port, binding.project, binding.directory, undefined, true)
    .catch((err: unknown) => ({ problem: errorMessage(err) }));
  abandoned.throwIfAborted();
  if (loaded.problem) return problem(PluginStillProblemCode.LoadFailed, { reason: loaded.problem });
  await previews.applySetup(port, null);
  abandoned.throwIfAborted();
  const placed = order.demo !== undefined ? await runDemo(port, order.demo) : await placeCamera(port, order.camera);
  abandoned.throwIfAborted();
  if (placed) return placed;
  return photograph(port, order);
}

/**
 * One still of the view `order` names, on a hidden window leased for it alone. Answers the still
 * or the problem that stopped it, within the budget; the window is given back before it answers.
 */
export async function viewStill(
  previews: StillPreviews,
  binding: PluginBinding,
  order: PluginStillOrder,
  options: ViewStillOptions = {},
): Promise<PluginStillAnswer> {
  const pool = hiddenPool(previews);
  if (!pool) return problem(PluginStillProblemCode.Unavailable, { reason: MESSAGE.noHiddenWindow });
  const timeoutMs = options.timeoutMs ?? STILL_TIMEOUT_MS;
  const budget = new AbortController();
  const session = previews.sessionPortFor({ label: `still:${binding.project}` });
  const shot = shoot(previews, pool, session, { binding, order, abandoned: budget.signal });
  // A still abandoned at its deadline stops at its next step; nobody reads what it settles to.
  shot.catch(() => {});
  const late = (options.wait ?? waitFor)(timeoutMs, budget.signal).then(
    () => problem(PluginStillProblemCode.Timeout, { reason: MESSAGE.timedOut(timeoutMs) }),
    never,
  );
  try {
    return await Promise.race([shot, late]);
  } finally {
    budget.abort();
    await session.release();
  }
}
