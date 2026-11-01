/** Event ingress from editable harness code cannot forge host authority or recovery provenance. */
import { CustomEvent } from "../../shared/custom-events.ts";
import { EventKind } from "../../shared/event-log.ts";
import type { EventData } from "../../substrate/types.ts";

const MESSAGE = {
  hostOnly:
    "permission, consent, recovery, self-change, plugin suggestion, don't-wait, unsaved-file, job, app access, automatic resume, finish check, chat judge, interaction evidence, tag result and listing draft rows are written by the studio only",
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
  // A job's start and end are recorded by the app that owns the job (`substrate/jobs.ts`).
  CustomEvent.JobStarted,
  CustomEvent.JobEnded,
  // What macOS access `app_look` still needs is the app's own finding.
  CustomEvent.AppLookAccess,
  // That an agent went ahead of the person is the lock table's finding, from the plugin's probe.
  CustomEvent.AgentWentAhead,
  // A chat's judge line and an interaction's evidence may read "verified by the studio", and nothing
  // in the studio verifies one any more: old logs still show them, and the harness may not add one.
  CustomEvent.ChatJudgeResult,
  CustomEvent.RunInteractionEvidence,
  // The count of a run's automatic resumes bounds them (`core/auto-resume.ts`): only the host writes one.
  CustomEvent.RunAutoResumed,
  // A message's @ tag results come from the host that resolved them (`core/mention-tags.ts`), and
  // their card offers Try again.
  CustomEvent.MentionTagged,
  // The reviewer's verdict is the app's, from the session it seated (`core/finish-review.ts`): the
  // harness asks for a check and settles it, but a yes it wrote itself would read as Done.
  CustomEvent.FinishCheck,
  // A Listing draft card puts an item on sale from its button: only a real `genex shop add` result
  // that main read (`core/item-draft.ts`) draws one, never the harness or what an agent wrote.
  CustomEvent.ItemDrafted,
]);

/** Refuse the entire batch before writing any row or updating the recovery index. */
export function refuseHostRecords(batch: readonly EventData[]): void {
  const forged = batch.some((data) => {
    if (data.type === EventKind.SnapshotCreated) return true;
    return data.type === EventKind.Custom && HOST_CUSTOM_EVENTS.has(data.event_type);
  });
  if (forged) throw new Error(MESSAGE.hostOnly);
}
