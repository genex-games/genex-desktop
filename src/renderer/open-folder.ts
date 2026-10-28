/**
 * Opening a folder the user already has, in two steps that never merge: the picker's answer is a
 * folder to look at, and only the open sheet's answer adopts it. The sheet asks the question and
 * App answers it through {@link adoptPickedFolder}, so nothing is written before the user has
 * seen what the studio found (tests/conformance/project-shape.test.ts).
 */
import type { OpenChoice } from "../shared/shape-words.ts";
import type { WorkspaceEvent, WorkspaceEventProperties } from "./analytics/events/workspace.ts";
import { elapsedMs } from "./analytics/properties.ts";
import { workspaceCode } from "./analytics/workspace-properties.ts";
import { FolderPickOutcome } from "./analytics/workspace-vocabulary.ts";
import type { FolderInspection, GameProject } from "./types.ts";

/** How the picker and the inspection went, for usage analytics: how each ended and how long each took. */
export type FolderPicked = WorkspaceEventProperties[typeof WorkspaceEvent.OpenFolderPicked];

/** What hears how a pick went; by default nothing does. */
type PickReport = (picked: FolderPicked) => void;

/**
 * Home's Open a folder…: pick a folder and inspect it. Cancelling the picker inspects nothing.
 * `report` hears how it went, refusals included, before a refusal is thrown on.
 */
export async function inspectPickedFolder(
  api: {
    pickProject(): Promise<string | null>;
    inspectFolder(dir: string): Promise<FolderInspection>;
  },
  report: PickReport = () => undefined,
  now: () => number = Date.now,
): Promise<FolderInspection | null> {
  const started = now();
  const dir = await api.pickProject().catch((error: unknown) => {
    report({ outcome: FolderPickOutcome.Refused, pick_ms: elapsedMs(started, now()), code: workspaceCode(error) });
    throw error;
  });
  const picked = now();
  const pickMs = elapsedMs(started, picked);
  if (!dir) {
    report({ outcome: FolderPickOutcome.Cancelled, pick_ms: pickMs });
    return null;
  }
  const inspected = (outcome: FolderPickOutcome, failure: unknown = null): void =>
    report({
      outcome,
      pick_ms: pickMs,
      inspect_ms: elapsedMs(picked, now()),
      ...(outcome === FolderPickOutcome.Refused ? { code: workspaceCode(failure) } : {}),
    });
  const inspection = await api.inspectFolder(dir).catch((error: unknown) => {
    inspected(FolderPickOutcome.Refused, error);
    throw error;
  });
  inspected(FolderPickOutcome.Picked);
  return inspection;
}

/** The open sheet's answer: adopt the inspected folder the way the user chose. */
export function adoptPickedFolder(
  api: { adoptFolder(dir: string, options?: OpenChoice): Promise<GameProject> },
  dir: string,
  choice: OpenChoice,
): Promise<GameProject> {
  return api.adoptFolder(dir, choice);
}
