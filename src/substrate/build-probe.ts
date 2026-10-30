/**
 * The build health check: one look at a loaded build from outside. The page loaded, it threw no
 * error it did not catch, and its frame is not blank. The game is never stepped or asked about
 * itself: the load comes from the preview's status, the errors from the shim's own record of the
 * page's `error` and `unhandledrejection` events, and the frame from a page screenshot.
 */
import { CaptureSurface } from "../shared/preview-contract.ts";
import type { BuildObservation } from "../shared/preview-contract.ts";
import { isBlankFrame } from "./pixel-stats.ts";
import type { PreviewPort } from "./preview-port.ts";

export type { BuildObservation };

/** JPEG quality of the check's screenshot: only its pixel statistics are read. */
const PROBE_SCREENSHOT_QUALITY = 60;
/** How many of the page's uncaught errors a reason quotes. */
const QUOTED_UNCAUGHT = 3;
/** The shim's verb for its record of the page's uncaught errors (`src/page/shim.ts`). */
const UNCAUGHT_VERB = "errors";

const MESSAGE = {
  NotLoaded: (why: string) => `the page did not load: ${why}`,
  Crashed: "the page's renderer crashed",
  Uncaught: (count: number, messages: readonly string[]) =>
    `${count} uncaught error${count === 1 ? "" : "s"}: ${messages.slice(0, QUOTED_UNCAUGHT).join(" | ")}`,
  Blank: "the page's frame is blank: one flat colour, nothing drawn",
} as const;

/** The page's uncaught errors as the shim recorded them; none from a page the shim never reached. */
async function uncaughtErrors(preview: PreviewPort): Promise<{ count: number; messages: string[] }> {
  const answer = (await preview.studioCall(UNCAUGHT_VERB).catch(() => null)) as {
    count?: unknown;
    messages?: unknown;
  } | null;
  const count = typeof answer?.count === "number" && Number.isFinite(answer.count) ? answer.count : 0;
  const messages = Array.isArray(answer?.messages) ? answer.messages.map(String) : [];
  return { count, messages };
}

/** The shim's own frame report, for the record: whether its clock runs and at what rate. */
async function clockReport(preview: PreviewPort): Promise<{ running: boolean | null; fps: number | null }> {
  const state = (await preview.studioCall("state").catch(() => null)) as { running?: unknown; fps?: unknown } | null;
  const running = typeof state?.running === "boolean" ? state.running : null;
  const fps = typeof state?.fps === "number" && Number.isFinite(state.fps) ? state.fps : null;
  return { running, fps };
}

/** The health check: page loads, no uncaught errors, not blank. */
export async function observeBuild(preview: PreviewPort): Promise<BuildObservation> {
  const reasons: string[] = [];
  const status = preview.status();
  if (status.loadError) reasons.push(MESSAGE.NotLoaded(status.loadError));
  if (status.crashed) reasons.push(MESSAGE.Crashed);
  const uncaught = await uncaughtErrors(preview);
  if (uncaught.count > 0) reasons.push(MESSAGE.Uncaught(uncaught.count, uncaught.messages));
  const pixels = preview.screenshotWithStats
    ? (await preview.screenshotWithStats(PROBE_SCREENSHOT_QUALITY, { surface: CaptureSurface.Page })).stats
    : null;
  if (pixels && isBlankFrame(pixels)) reasons.push(MESSAGE.Blank);
  const clock = await clockReport(preview);
  return {
    ok: reasons.length === 0,
    reasons,
    pixels,
    // The game is never asked: there is no contract to miss, and no frame of its own to count.
    studioMissing: true,
    frameBefore: null,
    frameAfter: null,
    frameAdvanced: false,
    running: clock.running,
    fps: clock.fps,
  };
}
