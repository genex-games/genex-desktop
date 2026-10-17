import { useEffect, useState } from "react";
import { SECOND_MS } from "../../shared/duration.ts";
import { type RunGraph, runIdOf } from "../run-graph.ts";
import { IMAGE_OUTLINE } from "./inspector/pictures.tsx";
import { pollWhile } from "./run-stills.ts";

/** How often a working stage looks for a newer saved frame. */
const CAPTURE_POLL_MS = 3 * SECOND_MS;

let latestCaptureAvailable = true;

/** The newest capture the host serves for a stage, or null when an older main process has no handler for it. */
async function latestCapture(
  graph: RunGraph,
  facetId: string,
  iteration: number,
): Promise<{ file: string | null; caption: string } | null> {
  const runId = runIdOf(graph);
  if (!runId || !latestCaptureAvailable || typeof window.studio.buildPreview !== "function") return null;
  try {
    const latest = await window.studio.buildPreview({ runId, facetId, iteration });
    if (!latest) return { file: null, caption: "Recorded check capture" };
    return {
      file: latest.path ?? null,
      caption: `${latest.camera} · captured ${new Date(latest.capturedAt).toLocaleTimeString()}`,
    };
  } catch (error) {
    if (/No handler registered|not a function/i.test(String(error))) latestCaptureAvailable = false;
    return latestCaptureAvailable ? { file: null, caption: "Recorded check capture" } : null;
  }
}

/** The still a stage's capture shows: the fallback, the host's latest, or — with no handler — the session's first. */
async function captureFile(
  graph: RunGraph,
  facetId: string,
  iteration: number,
  fallback: string | null,
): Promise<{ file: string | null; caption: string }> {
  if (fallback) return { file: fallback, caption: "Recorded check capture" };
  const latest = await latestCapture(graph, facetId, iteration);
  if (latest || !graph.runDir) return latest ?? { file: null, caption: "Recorded check capture" };
  return {
    file: `${graph.runDir}/facet_${facetId}/self/iter_${String(iteration).padStart(3, "0")}/c1_default.jpg`,
    caption: "First saved capture (this session)",
  };
}

/** A saved frame and what the capture says about it. */
interface SavedFrame {
  src: string;
  caption: string;
}

/**
 * The stage's newest saved frame, re-read while the stage works: null until one is saved, or when
 * not `wanted`; `looked` once the first read has answered, so "none saved" is never said before.
 */
function useSavedFrame(
  graph: RunGraph,
  facetId: string,
  iteration: number,
  fallback: string | null | undefined,
  active: boolean,
  wanted: boolean,
): { frame: SavedFrame | null; looked: boolean } {
  const [frame, setFrame] = useState<SavedFrame | null>(null);
  const [looked, setLooked] = useState(false);
  useEffect(() => {
    setFrame(null);
    setLooked(false);
    if (!wanted) return;
    const read = async (isCurrent: () => boolean): Promise<void> => {
      try {
        const { file, caption } = await captureFile(graph, facetId, iteration, fallback ?? null);
        const still = file ? await window.studio.readRunStill(file) : null;
        if (isCurrent() && still) setFrame({ src: `data:${still.mimeType};base64,${still.data}`, caption });
      } catch {
        /* retry; a capture can be in the middle of being written */
      } finally {
        if (isCurrent()) setLooked(true);
      }
    };
    return pollWhile(read, active, CAPTURE_POLL_MS);
  }, [graph.runId, graph.runDir, facetId, iteration, fallback, active, wanted]);
  return { frame, looked };
}

/** What the empty frame says: the agent is working, none was saved, or nothing while the first read runs. */
function missingFrameNote(active: boolean, looked: boolean): string | null {
  if (active) return "Agent is working. The first preview appears after it saves a screenshot.";
  return looked ? "No screenshot was saved for this stage." : null;
}

/**
 * Poll disk evidence, not the model. A running older main process can serve its first still.
 * A `still` the caller already shows elsewhere (the graph's node) is shown as it is, unpolled.
 */
export function BuildCapture({
  graph,
  facetId,
  iteration,
  fallback,
  still = null,
  active,
}: {
  graph: RunGraph;
  facetId: string;
  iteration: number;
  fallback?: string | null;
  still?: string | null;
  active: boolean;
}) {
  const saved = useSavedFrame(graph, facetId, iteration, fallback, active, !still);
  const frame = still ? { src: still, caption: null } : saved.frame;
  return (
    <div className="flex flex-col gap-2" data-testid="build-capture">
      {frame ? (
        <img
          src={frame.src}
          alt={`Saved preview for ${facetId}`}
          className="block aspect-video w-full rounded-[10px] bg-inset object-cover"
          style={{ boxShadow: IMAGE_OUTLINE }}
        />
      ) : (
        <div
          className="hatch grid aspect-video place-items-center rounded-[10px] px-6 text-center text-body-sm text-ink-3"
          style={{ boxShadow: IMAGE_OUTLINE }}
        >
          {missingFrameNote(active, saved.looked)}
        </div>
      )}
      {frame?.caption ? (
        <span className="text-micro leading-relaxed text-ink-3">
          {frame.caption} · A screenshot does not establish that gameplay checks passed.
        </span>
      ) : null}
    </div>
  );
}
