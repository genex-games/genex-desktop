import { useEffect, useState } from "react";
import type { RunSummary } from "../shared/run-summary.ts";

/** How many runs' last summaries outlive their views; summaries can be large, so few. */
const KEPT_SUMMARIES_MAX = 8;
const keptSummaries = new Map<string, RunSummary>();
const summaryKey = (project: string, runId: string): string => JSON.stringify([project, runId]);

/** Keep the newest summary a run sent, so a view of it that mounts again draws it at once. */
export function keepSummary(summary: RunSummary): void {
  const key = summaryKey(summary.project, summary.runId);
  keptSummaries.delete(key);
  keptSummaries.set(key, summary);
  while (keptSummaries.size > KEPT_SUMMARIES_MAX) {
    const oldest = keptSummaries.keys().next().value;
    if (oldest !== undefined) keptSummaries.delete(oldest);
  }
}

/** The newest summary this run sent while a view had it open, or null before any. */
export function keptSummary(project: string | null, runId: string | null): RunSummary | null {
  return project && runId ? (keptSummaries.get(summaryKey(project, runId)) ?? null) : null;
}

/**
 * A run's recorded summary, kept fresh by its feed. A view that mounts again (the Builds tab coming
 * back) starts from the newest one already received instead of an empty canvas while the feed answers.
 */
export function useRunSummary(project: string | null, runId: string | null): RunSummary | null {
  const [summary, setSummary] = useState<RunSummary | null>(() => keptSummary(project, runId));
  useEffect(() => {
    setSummary(keptSummary(project, runId));
    if (!window.studio.onRunSummary) return;
    if (!project || !runId) return;
    return window.studio.onRunSummary(project, runId, (next) => {
      keepSummary(next);
      setSummary((current) => {
        const sameRevision = current?.revision !== undefined && current.revision === next.revision;
        const samePreview = JSON.stringify(current?.preview) === JSON.stringify(next.preview);
        return sameRevision && samePreview ? current : next;
      });
    });
  }, [project, runId]);
  if (summary?.project === project && summary.runId === runId) return summary;
  return keptSummary(project, runId);
}
