/**
 * The studio's own browser window as a computer target: the hidden pooled preview every agent
 * already plays on, wrapped so the `computer` session reaches it only through the
 * {@link ComputerTarget} interface. Its clock, seed and cameras are the page's `window.__studio`
 * verbs (`src/page/shim.ts`, `src/game-template/src/studio.js`), called here and nowhere else.
 */
import { BROWSER_CAPABILITIES, InputRoute } from "../../shared/computer-target.ts";
import { type CaptureSurface, GameClock, GameView } from "../../shared/preview-contract.ts";
import { COMPUTER_VIEW } from "../../substrate/computer-tool.ts";
import type { ComputerTarget, TargetCameraAnswer } from "../../substrate/computer-target.ts";
import type { PreviewPort } from "../../substrate/preview-port.ts";
import { captureSurface } from "./capture.ts";

/** A browser target keeps its window in reach: the playtest shorthands and the director's look still drive the port. */
export interface BrowserPreviewTarget extends ComputerTarget {
  readonly port: PreviewPort;
}

/** What the page's `step()` answers (`src/page/shim.ts`): how many frames ran and whether it was cut short. */
interface PageStep {
  ok?: boolean;
  truncated?: boolean;
}

/** The page's answer to a camera switch, read field by field: a page may answer anything. */
function cameraAnswer(placed: unknown): TargetCameraAnswer {
  if (typeof placed !== "object" || placed === null) return { ok: true };
  const answer = placed as { ok?: unknown; reason?: unknown; available?: unknown };
  if (answer.ok !== false) return { ok: true };
  return {
    ok: false,
    ...(typeof answer.reason === "string" ? { reason: answer.reason } : {}),
    ...(Array.isArray(answer.available) ? { available: answer.available.map(String) } : {}),
  };
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
    state: () => port.studioState(),
    clock: {
      pause: async () => {
        await port.studioCall(GameClock.Pause).catch(() => null);
      },
      start: async () => {
        await port.studioCall(GameClock.Start).catch(() => null);
      },
      step: async (ms) => steppedMs(await port.studioCall(GameClock.Step, ms).catch(() => null), ms),
    },
    seed: async (seed) => {
      await port.studioCall(GameClock.Seed, seed).catch(() => null);
    },
    camera: async (name) => cameraAnswer(await port.studioCall(GameView.DebugCamera, name).catch(() => null)),
    console: (sinceMs) => port.consoleEntries(sinceMs),
  };
}
