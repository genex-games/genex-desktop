/**
 * The one place the service hands each settled call with its text (`GameAiDeps.traces`): it keeps
 * the call in its game's Report session (D9), saves a model-check moment of the creator's own
 * playtest (D10), counts it for fit from play and sends the counts when due (D12), and asks for an
 * automatic Report when the reply was still invalid after its repair (Reports send one per call).
 * Every part runs apart: none can fail another, and none throws back into the call.
 */
import { AiValidation } from "../../shared/game-ai-report.ts";
import type { GameAiFitCounts } from "./fit-counts.ts";
import type { GameAiMoments } from "./moments.ts";
import type { GameAiReportService } from "./report.ts";
import type { GameAiTraceSink } from "./types.ts";

/** What the sink hands each call to. */
export interface TraceSinkParts {
  reports: Pick<GameAiReportService, "observe" | "automatic">;
  moments: Pick<GameAiMoments, "remember">;
  fitCounts: GameAiFitCounts;
}

/** Run a part that may fail, never letting it reach the call. */
function apart(part: () => Promise<unknown>): void {
  try {
    part().catch(() => {});
  } catch {
    // A part that throws before its promise exists fails alone, as one that rejects does.
  }
}

/** The trace sink over `parts`. */
export function createTraceSink(parts: TraceSinkParts): GameAiTraceSink {
  return (caller, trace) => {
    apart(async () => parts.reports.observe(caller, trace));
    apart(() => parts.moments.remember(caller, trace));
    apart(async () => {
      await parts.fitCounts.record(caller, trace);
      await parts.fitCounts.flush();
    });
    if (trace.validation === AiValidation.Invalid) apart(() => parts.reports.automatic(caller, trace.request.ticket));
  };
}
