/**
 * The harness's changes to its own files, as the host reads them from the log: which file each
 * change wrote, and the snapshots around it an undo works between. The harness edits its own code,
 * so a record's file is taken only when it is a plain path inside the workspace.
 */
import type { EventEnvelope } from "../substrate/types.ts";
import { EventKind } from "../shared/event-log.ts";
import { agentChangedFile } from "../shared/self-change-files.ts";

/** One applied change to Studio's own files, as the log recorded it. */
export interface ChangeRecord {
  /** The snapshot taken just before the change: its identity, and the version an undo returns to. */
  snapshotId: string;
  /** The snapshot taken just after it, when the change recorded one. */
  postSnapshotId?: string;
  /** The file the change wrote; an undo touches nothing else. */
  file: string;
  at: string;
}

/** Every applied change in the log, oldest first. */
export function changeRecords(events: EventEnvelope[]): ChangeRecord[] {
  return events.flatMap((event) => {
    const change = changeRecord(event);
    return change ? [change] : [];
  });
}

/** The change one log record describes: one the agent made to its own files (`write_own_file`, `write_skill`, `install_tool`). */
function changeRecord(event: EventEnvelope): ChangeRecord | null {
  if (event.data.type !== EventKind.Custom) return null;
  const p = (event.data.payload ?? {}) as Record<string, unknown>;
  if (typeof p.snapshot_id !== "string" || !p.snapshot_id) return null;
  const file = agentChangedFile(event.data.event_type, p);
  if (!file) return null;
  const post =
    typeof p.post_snapshot_id === "string" && p.post_snapshot_id ? { postSnapshotId: p.post_snapshot_id } : {};
  return { snapshotId: p.snapshot_id, ...post, file, at: event.created_at };
}

/**
 * Files the harness runs. A snapshot that differs from a healthy one only in files it reads —
 * skills, prompts, the library — boots and turns exactly as that one did.
 */
export const RUNS_AS_CODE = /\.(?:mjs|cjs|js|ts)$|(?:^|\/)package\.json$/;
