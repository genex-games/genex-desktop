/**
 * What a Report captures of the game a person is playing (D9, `ReportCapture`), read from where it
 * runs: Play's game view or Create's Live preview. The page's state gives `genex-ai`'s status
 * (`state().ai`) and the world's seed; Studio's own capture gives one frame; the console gives its
 * errors; the build gives its commit. The page is hostile: a field out of shape is left out, a frame
 * over the bundle's cap is dropped, and a page that does not answer within {@link CAPTURE_WAIT_MS}
 * answers nothing. Report building reads every part again (`report.ts`); this only gathers them.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import { isPlainRecord } from "../../shared/game-ai.ts";
import { AI_REPORT_FRAME_MAX_CHARS, AiReportImage } from "../../shared/game-ai-report.ts";
import type { ReportCapture } from "./report.ts";

/** How long a capture waits for the page to answer. */
export const CAPTURE_WAIT_MS = 2 * SECOND_MS;

/** What a capture is read from. */
export interface CaptureParts {
  /** The page's `__studio.state()` (or what Play's page says of `genex-ai`, as `{ ai }`). */
  state: unknown;
  /** One JPEG of the game's view; null when none could be taken. */
  jpeg: Buffer | null;
  consoleErrors: readonly string[];
  /** The build's commit, when it is a clean one. */
  commit: string | null;
  engine: string;
}

/** A Report's capture from its parts, each in shape or left out. */
export function reportCaptureOf(parts: CaptureParts): Partial<ReportCapture> {
  const state = isPlainRecord(parts.state) ? parts.state : {};
  const seed = typeof state.seed === "number" && Number.isSafeInteger(state.seed) ? state.seed : null;
  const data = parts.jpeg ? parts.jpeg.toString("base64") : null;
  return {
    seed,
    commit: parts.commit,
    engine: parts.engine,
    aiState: isPlainRecord(state.ai) ? state.ai : null,
    consoleErrors: [...parts.consoleErrors],
    frame: data !== null && data.length <= AI_REPORT_FRAME_MAX_CHARS ? { mime: AiReportImage.Jpeg, data } : null,
  };
}

/** A page's answer within `waitMs`, or null when it fails or does not come. */
export async function withinCaptureWait<T>(read: Promise<T>, waitMs: number = CAPTURE_WAIT_MS): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  try {
    return await Promise.race([read.catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}
