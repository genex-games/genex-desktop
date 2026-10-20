/** Event ingress from editable harness code cannot forge host authority or recovery provenance. */
import { CustomEvent } from "../../shared/custom-events.ts";
import { EventKind } from "../../shared/event-log.ts";
import type { EventData } from "../../substrate/types.ts";

const MESSAGE = {
  hostOnly:
    "permission, consent, recovery, self-change, plugin suggestion, don't-wait, unsaved-file, job, app access, automatic resume, finish check, extension-ladder and game crash rows are written by the studio only",
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
  // The extension ladder's records (M3.15, M7): the conformance gate opens on a `conformance_run`
  // and the escape report counts ejects and trust, so only the host that ran or decided them writes one.
  CustomEvent.ConformanceRun,
  CustomEvent.EngineEjected,
  CustomEvent.GameTrust,
  CustomEvent.CrateRequest,
  CustomEvent.CrateDecision,
  CustomEvent.DeviceLaunch,
  // A crash record is the host's: it kept the file `game_crashed` names (`core/game-crashes.ts`).
  CustomEvent.GameCrashed,
  CustomEvent.SeedRetake,
  // A turn-it-on card is shown by `plugins_suggest` only, after its checks: its button turns a plugin on.
  CustomEvent.PluginSuggested,
  // Files too large to save are reported by the host that took the checkpoint or the rewind.
  CustomEvent.CheckpointSkipped,
  // A job's start and end are recorded by the app that owns the job (`substrate/jobs.ts`).
  CustomEvent.JobStarted,
  CustomEvent.JobEnded,
  // What macOS access `app_look` still needs is the app's own finding.
  CustomEvent.AppLookAccess,
  // The count of a run's automatic resumes bounds them (`core/auto-resume.ts`): only the host writes one.
  CustomEvent.RunAutoResumed,
  // The reviewer's verdict is the app's, from the session it seated (`core/finish-review.ts`): the
  // harness asks for a check and settles it, but a yes it wrote itself would read as Done.
  CustomEvent.FinishCheck,
]);

/** Refuse the entire batch before writing any row or updating the recovery index. */
export function refuseHostRecords(batch: readonly EventData[]): void {
  const forged = batch.some((data) => {
    if (data.type === EventKind.SnapshotCreated) return true;
    return data.type === EventKind.Custom && HOST_CUSTOM_EVENTS.has(data.event_type);
  });
  if (forged) throw new Error(MESSAGE.hostOnly);
}
