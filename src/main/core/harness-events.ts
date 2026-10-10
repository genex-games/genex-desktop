/** Event ingress from editable harness code cannot forge host authority or recovery provenance. */
import { CustomEvent } from "../../shared/custom-events.ts";
import { EventKind } from "../../shared/event-log.ts";
import type { EventData } from "../../substrate/types.ts";
import { InteractionObjective } from "../../shared/run-summary.ts";
import { isVerified } from "./verified-traces.ts";

const MESSAGE = {
  hostOnly: "permission, consent, recovery and self-change rows are written by the studio only",
} as const;
const HOST_CUSTOM_EVENTS: ReadonlySet<unknown> = new Set([
  CustomEvent.ToolPermission,
  CustomEvent.PluginConsent,
  CustomEvent.SnapshotHealthy,
  // A self-change is recorded by the host that wrote it (`guardian.write_self`): Activity lists
  // it and Undo reverts the file it names, so the harness may neither forge one nor leave one out.
  CustomEvent.SelfEdit,
  CustomEvent.SkillEdited,
  CustomEvent.ToolInstalled,
  // The count of a run's automatic resumes bounds them (`core/auto-resume.ts`): only the host writes one.
  CustomEvent.RunAutoResumed,
]);

/** Refuse the entire batch before writing any row or updating the recovery index. */
export function refuseHostRecords(batch: readonly EventData[]): void {
  const forged = batch.some((data) => {
    if (data.type === EventKind.SnapshotCreated) return true;
    return data.type === EventKind.Custom && HOST_CUSTOM_EVENTS.has(data.event_type);
  });
  if (forged) throw new Error(MESSAGE.hostOnly);
}

/**
 * The batch with every interaction the harness calls `studio-verified` checked against the traces
 * the studio itself saw reach their goal (`verified-traces.ts`): one the studio did not see is
 * recorded as the model's word. The harness is agent-editable; the studio's word is only its own.
 */
export function vouchedInteractions(batch: readonly EventData[]): EventData[] {
  return batch.map((data) => {
    if (data.type !== EventKind.Custom || data.event_type !== CustomEvent.RunInteractionEvidence) return data;
    const payload = (data.payload ?? {}) as Record<string, unknown>;
    if (payload.objective !== InteractionObjective.StudioVerified || isVerified(payload.trace)) return data;
    return { ...data, payload: { ...payload, objective: InteractionObjective.ModelSaid } };
  });
}
