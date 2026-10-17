/**
 * What each UI event makes the renderer read again. The events announce; the log and main's
 * lists are the record, so most of them only say "read that again". The table is here, pure, so
 * it is one place to extend and can be tested without a window.
 */
import { isUiEventIn, UiEvent, type UiEventType } from "../../shared/ui-events.ts";

export interface UiEventReads {
  /** The all-threads log after the cursor. */
  events: boolean;
  threads: boolean;
  games: boolean;
  /** Self-improvement suggestions waiting. */
  staged: boolean;
  engines: boolean;
  plugins: boolean;
  /** Watched asset inventories: one game's (`project`), or every watched one (`null`). */
  assets: { project: string | null } | null;
}

/** A model pull reports this status once the model is on disk. */
const PULL_DONE = "success";

/** Events whose record lands in the log: pull it in now rather than at the next poll. */
const LOGGED: ReadonlySet<UiEventType> = new Set<UiEventType>([
  UiEvent.GameChanged,
  UiEvent.RunIteration,
  // Autopilot narrates itself into the log — facet rows and decision cards land live.
  UiEvent.RunOptimization,
  UiEvent.AutopilotFacet,
  UiEvent.JudgeFacet,
  UiEvent.ChatMessage,
  UiEvent.ToolFinished,
  UiEvent.ChatError,
  UiEvent.RunFeedback,
  // A failed run's closure lands in the log (main appends it durably).
  UiEvent.RunFailed,
  UiEvent.RunFinished,
  UiEvent.RunSettled,
  // The contractor's mirrored trace lands in the log as it works.
  UiEvent.DelegatedEvent,
  UiEvent.ThreadCompacted,
  UiEvent.ContextUsage,
  UiEvent.ThreadCreated,
  UiEvent.ThreadBound,
  UiEvent.ThreadUpdated,
  UiEvent.GameArchived,
  // A plugin's question to the user, and its answer, live in the log as consent cards.
  UiEvent.PluginConsent,
  // So do Claude's own permission questions: the event is only a nudge, the log is the card.
  UiEvent.ToolPermission,
]);

const THREADS: ReadonlySet<UiEventType> = new Set<UiEventType>([
  UiEvent.ThreadCreated,
  UiEvent.ThreadBound,
  UiEvent.ThreadUpdated,
  UiEvent.GameArchived,
  UiEvent.GameChanged,
  // A chat's permission mode lives in its thread's metadata.
  UiEvent.PermissionsChanged,
]);

/** Does this event mean the engines list changed (a finished model pull counts)? */
function enginesChanged(event: UiEvent): boolean {
  if (event.type === UiEvent.EnginesChanged || event.type === UiEvent.EngineAuth) return true;
  return event.type === UiEvent.ModelPull && event.payload?.progress?.status === PULL_DONE;
}

/** The asset inventory an event makes stale: one game's, every watched one, or none. */
function assetsRead(event: UiEvent): UiEventReads["assets"] {
  if (event.type === UiEvent.PluginEvent) {
    const project = event.payload?.project;
    return typeof project === "string" ? { project } : null;
  }
  if (event.type === UiEvent.AssetDelivered) {
    const project = event.payload?.project;
    return { project: typeof project === "string" ? project : null };
  }
  if (event.type === UiEvent.AssetJobs) {
    const project = event.payload?.project;
    return typeof project === "string" ? { project } : null;
  }
  return null;
}

export function uiEventReads(event: UiEvent): UiEventReads {
  const type = event.type;
  const coordinatorRecord = type !== UiEvent.CoordinatorStatus && isUiEventIn(event, "coordinator.");
  return {
    events: LOGGED.has(type) || isUiEventIn(event, "improvement.") || coordinatorRecord,
    threads: THREADS.has(type),
    games: type === UiEvent.GameChanged,
    staged: isUiEventIn(event, "skillopt."),
    engines: enginesChanged(event),
    plugins: type === UiEvent.PluginsChanged,
    assets: assetsRead(event),
  };
}
