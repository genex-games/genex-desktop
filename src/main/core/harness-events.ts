/** Event ingress from editable harness code cannot forge host authority or recovery provenance. */
import { CustomEvent } from "../../shared/custom-events.ts";
import { EventKind } from "../../shared/event-log.ts";
import type { EventData } from "../../substrate/types.ts";

const MESSAGE = {
  hostOnly:
    "permission, consent, recovery, self-change, plugin suggestion, don't-wait, unsaved-file, job, app access and automatic resume rows are written by the studio only",
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
  // A turn-it-on card is shown by `plugins_suggest` only, after its checks: its button turns a plugin on.
  CustomEvent.PluginSuggested,
  // Files too large to save are reported by the host that took the checkpoint or the rewind.
  CustomEvent.CheckpointSkipped,
  // "Don't wait for me" is the person's alone: its card is shown by `offer_dont_wait`, its switch
  // by the person's click, so the harness may write neither.
  CustomEvent.DontWaitOffer,
  CustomEvent.DontWaitSet,
  // A job's start and end are recorded by the app that owns the job (`substrate/jobs.ts`).
  CustomEvent.JobStarted,
  CustomEvent.JobEnded,
  // What macOS access `app_look` still needs is the app's own finding.
  CustomEvent.AppLookAccess,
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
