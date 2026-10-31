/**
 * The studio's own browser window as a computer target: the hidden pooled preview every agent
 * already plays on, wrapped so the `computer` session reaches it only through the
 * {@link ComputerTarget} interface. Its clock is the page shim's own (`src/page/shim.ts`); the
 * game is never asked about itself, so the target has no state, seed or cameras.
 */
import { BROWSER_CAPABILITIES, InputRoute } from "../../shared/computer-target.ts";
import { type CaptureSurface, GameClock } from "../../shared/preview-contract.ts";
import { COMPUTER_VIEW } from "../../substrate/computer-tool.ts";
import type { ComputerTarget } from "../../substrate/computer-target.ts";
import type { PreviewPort } from "../../substrate/preview-port.ts";
import { captureSurface } from "./capture.ts";

/** A browser target keeps its window in reach: the director's look still drives the port. */
export interface BrowserPreviewTarget extends ComputerTarget {
  readonly port: PreviewPort;
}

/** What the page's `step()` answers (`src/page/shim.ts`): how many frames ran and whether it was cut short. */
interface PageStep {
  ok?: boolean;
  truncated?: boolean;
}

/** The simulated milliseconds of a page step: what was asked, unless the page cut it short or never stepped. */
function steppedMs(answer: unknown, ms: number): number | null {
  if (typeof answer !== "object" || answer === null) return null;
  const step = answer as PageStep;
  return step.ok === true && step.truncated !== true ? ms : null;
}

/** The pooled preview window behind one session, as the computer tool's target. */
export function browserPreviewTarget(port: PreviewPort): BrowserPreviewTarget {
  const zoomer = port.zoom;
  return {
    port,
    caps: BROWSER_CAPABILITIES,
    viewSize: () => port.viewSize?.() ?? COMPUTER_VIEW,
    pointer: () => port.pointer?.() ?? null,
    screenshot: ({ quality, surface }) => captureSurface(port, quality, surface),
    input: async (actions) => {
      const done = await port.input(actions);
      return { applied: done.applied, route: InputRoute.Browser };
    },
    ...(zoomer
      ? {
          zoom: (region: [number, number, number, number], { surface }: { surface: CaptureSurface }) =>
            zoomer.call(port, region, undefined, { surface }),
        }
      : {}),
    clock: {
      pause: async () => {
        await port.studioCall(GameClock.Pause).catch(() => null);
      },
      start: async () => {
        await port.studioCall(GameClock.Start).catch(() => null);
      },
      step: async (ms) => steppedMs(await port.studioCall(GameClock.Step, ms).catch(() => null), ms),
    },
    console: (sinceMs) => port.consoleEntries(sinceMs),
  };
}
