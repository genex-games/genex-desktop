/**
 * A plugin's clip (`observe` with `clip`, plugin API 3): a few seconds of the bound game running,
 * from the start of a moment one of its demos stages. The window, its size, the load, putting the
 * game in play and the demo are a still's (`view-still.ts`), and so is the discipline: a hidden
 * window of its own, given back however the clip ends, within one budget. The demo stages the
 * moment and returns; the host then starts the game's clock (`__studio.start()`: the template's
 * own loop, and the studio shim's clock for a game without one) and records `seconds` of it in real
 * time. The game drives itself while it records; the host sends no input. The request reaching
 * here was checked field by field (`clipOrder` in `plugins/services.ts`).
 */
import { SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import {
  type PluginBinding,
  type PluginClipAnswer,
  type PluginClipOrder,
  PluginStillProblemCode,
  type PluginStillProblem,
} from "../../shared/plugins.ts";
import { GameClock } from "../../shared/preview-contract.ts";
import type { PreviewPool } from "../../substrate/preview-pool.ts";
import type { PreviewPort } from "../../substrate/preview-port.ts";
import type { SessionPort } from "./session-port.ts";
import {
  leased,
  openGame,
  runDemo,
  sizedWindow,
  untilAbandoned,
  type ViewPreviews,
  type ViewStillOptions,
  type WindowNeed,
} from "./view-still.ts";

/** Switches the template's canvas HUD off for a recording; a page without one answers null. */
export const CLIP_HUD_OFF = "window.__studio?.hud?.enable?.(false) ?? null";

/** What a clip's budget allows beside its own seconds: the window, the load, the demo and the encoding. */
export const CLIP_LOAD_ALLOWANCE_MS = 60 * SECOND_MS;
/** The long side of the JPEG poster that comes with every clip. */
const CLIP_POSTER_MAX_PX = 1280;

const MESSAGE = {
  noHiddenWindow: "this build has no hidden window to record a clip on, and a clip never borrows the person's own",
  noClipCapture: "this window cannot record a clip",
  tooLarge: (smallest: number, limit: number) =>
    `the smallest recording was ${smallest} bytes, over the ${limit}-byte limit`,
  timedOut: (ms: number) => `the clip did not finish within ${Math.round(ms / SECOND_MS)} s`,
} as const;

/** The clip's budget and its clock: a test seam (`StudioCoreOptions.pluginClip`). */
export type ViewClipOptions = ViewStillOptions;

/** A port that can record a clip. */
type ClipPort = PreviewPort & { clip: NonNullable<PreviewPort["clip"]> };
const CLIP_NEED: WindowNeed<ClipPort> = {
  capable: (port): port is ClipPort => typeof port.clip === "function",
  incapable: MESSAGE.noClipCapture,
};

function problem(code: PluginStillProblemCode, detail: Omit<PluginStillProblem, "code"> = {}): PluginClipAnswer {
  return { clipProblem: { code, ...detail } };
}

/** The whole clip's budget: its own seconds and the allowance. */
export const clipBudgetMs = (order: PluginClipOrder) => CLIP_LOAD_ALLOWANCE_MS + order.seconds * SECOND_MS;

/** Record the moment now running, never more than asked. */
async function record(port: ClipPort, order: PluginClipOrder): Promise<PluginClipAnswer> {
  let taken: Awaited<ReturnType<ClipPort["clip"]>>;
  try {
    taken = await port.clip({
      seconds: order.seconds,
      fps: order.fps,
      maxBytes: order.maxBytes,
      posterMaxPx: CLIP_POSTER_MAX_PX,
    });
  } catch (err) {
    return problem(PluginStillProblemCode.CaptureFailed, { reason: errorMessage(err) });
  }
  if ("tooLarge" in taken)
    return problem(PluginStillProblemCode.TooLarge, {
      reason: MESSAGE.tooLarge(taken.tooLarge.smallestBytes, order.maxBytes),
    });
  const { video, mimeType, width, height, durationMs, poster, motion } = taken.clip;
  return { clip: { video, mimeType, width, height, durationMs, view: { demo: order.demo }, poster, motion } };
}

/**
 * Size the window, load the game, put it in play, stage the demo, start the clock and record. A
 * clip its budget gave up on (`abandoned`) stops where it is, exactly as a still does.
 */
async function film(
  previews: ViewPreviews,
  pool: PreviewPool,
  session: SessionPort,
  { binding, order, abandoned }: { binding: PluginBinding; order: PluginClipOrder; abandoned: AbortSignal },
): Promise<PluginClipAnswer> {
  const window = await sizedWindow(pool, session, order, CLIP_NEED);
  if ("refused" in window) return { clipProblem: window.refused };
  const port = untilAbandoned(window.port, abandoned);
  const unopened = await openGame(previews, port, binding, abandoned);
  if (unopened) return { clipProblem: unopened };
  const staged = await runDemo(port, order.demo);
  abandoned.throwIfAborted();
  if (staged) return { clipProblem: staged.stillProblem };
  // The clip is the game as a player sees it on a card: no readouts over it. A template game's HUD
  // repaints every frame, so it is switched off for the recording rather than cleared once.
  await port.evaluate(CLIP_HUD_OFF).catch(() => null);
  abandoned.throwIfAborted();
  // A demo leaves the game paused on the moment it staged; the clip is that moment playing out.
  // A page without the clock verb answers `{__missing}`: it was never paused, and records as it runs.
  await port.studioCall(GameClock.Start).catch(() => null);
  abandoned.throwIfAborted();
  return record(port, order);
}

/**
 * One clip of the moment `order`'s demo stages, on a hidden window leased for it alone. Answers the
 * clip or the problem that stopped it, within the budget; the window is given back before it answers.
 */
export async function viewClip(
  previews: ViewPreviews,
  binding: PluginBinding,
  order: PluginClipOrder,
  options: ViewClipOptions = {},
): Promise<PluginClipAnswer> {
  const timeoutMs = options.timeoutMs ?? clipBudgetMs(order);
  return leased(previews, {
    label: `clip:${binding.project}`,
    timeoutMs,
    ...(options.wait ? { wait: options.wait } : {}),
    run: (pool, session, abandoned) => film(previews, pool, session, { binding, order, abandoned }),
    unavailable: () => problem(PluginStillProblemCode.Unavailable, { reason: MESSAGE.noHiddenWindow }),
    late: () => problem(PluginStillProblemCode.Timeout, { reason: MESSAGE.timedOut(timeoutMs) }),
  });
}
