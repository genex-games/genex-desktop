/**
 * The conversation coordinator's contract with the host: the tools a game chat's coordinator may
 * call on a run, the run a conversation is on as the coordinator sees it, the state it reads
 * back from `run_status`, and the slice of the conversation a queued message may see.
 *
 * The host is authoritative for these: it hands the tools to the coordinator session, answers
 * them (`main/core/conversation.ts`) and builds the chat transcript. The harness keeps its own
 * copy in `src/harness-seed/loop/run-inbox.ts` for its run inbox — the app must not load the
 * agent's editable code — and `tests/conformance/seed-contracts.test.ts` holds the two to the
 * same tool list and the same readings of the same logs.
 */
import { CustomEvent, customRecord, type CustomEventData } from "./custom-events.ts";
import type { StudioToolSpec } from "./engine-requests.ts";
import { EventKind, type EventData } from "./event-log.ts";
import { messageQueueState, type QueueView } from "./message-queue.ts";
import { RUN_START_EVENTS } from "./run-state.ts";

/** What a `run_control` record asks of a run. Persisted: never rename a value (the harness's copy is in `loop/run-inbox.ts`). */
export const RunControlAction = {
  /** Wrap up: let the current attempts finish, then integrate and show what is ready. */
  Finish: "finish",
} as const;
export type RunControlAction = (typeof RunControlAction)[keyof typeof RunControlAction];

/**
 * The coordinator's tools, by name, in menu order: the host's own tools a run's coordinator calls,
 * some of which the chat's own session keeps after a run it led (`RunControl`). The model calls
 * them by these names, and the log records them so: never rename one (the harness's copy of the
 * specs is `loop/run-inbox.ts` `coordinatorTools`).
 */
export const CoordinatorTool = {
  RunStatus: "run_status",
  SteerRun: "steer_run",
  FinishRun: "finish_run",
  ResumeRun: "resume_run",
  ContinueBuild: "continue_build",
  ShowBuild: "show_build",
  LandBuild: "land_build",
} as const;
export type CoordinatorTool = (typeof CoordinatorTool)[keyof typeof CoordinatorTool];

/**
 * The tool name a game chat's delegation is logged under (`tool_requested` … `tool_result`), from
 * the brief it hands a contractor to the build's result. The harness writes it (its copy is
 * `loop/delegated-turn.ts` `DELEGATE_TOOL`): never rename it.
 */
export const DELEGATE_TOOL = "delegate_to_contractor";

/** Durable run identity and addressed control messages: the coordinator's tools, in menu order. */
export const coordinatorTools: readonly StudioToolSpec[] = [
  {
    name: CoordinatorTool.RunStatus,
    description: "Read the current run, worker progress and recent checks. This does not start or stop work.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: CoordinatorTool.SteerRun,
    description:
      "Send a concrete instruction to the existing workers at their next iteration boundary. Use only for requested changes, not questions or status requests.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The user's requested change, with enough context for a worker." },
        facetId: { type: "string", description: "Optional facet id; omit to address every worker." },
      },
      required: ["text"],
    },
  },
  {
    name: CoordinatorTool.FinishRun,
    description:
      "Finish the current attempts, then integrate and check the accepted work and show it live. No new facet rounds, no reset, no cancellation. Use when the user asks to wrap up or wait for the remaining workers and show what is ready.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: CoordinatorTool.ResumeRun,
    description:
      "Continue a paused run with its saved plan and completed work when the user requests further work, including a new instruction after Stop. Supply that instruction as text before builders resume. Questions alone do not resume work.",
    parameters: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "Optional run id from availableRuns, when resuming an earlier paused build.",
        },
        text: {
          type: "string",
          description: "The latest requested change or continuation, preserving the user's intent.",
        },
      },
    },
  },
  {
    name: CoordinatorTool.ContinueBuild,
    description:
      "Continue implementation in this game's existing conversation after the run has finished. Use for a requested change or unfinished work, never a question. The saved plan and results are retained; this does not repeat intake or create a new timed run.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to implement next, incorporating the latest user message." },
        build: {
          type: "boolean",
          description:
            "false for a contained change (a fix, a tweak, one feature): one builder makes it in this chat and the build stays finished. Omit to continue the build itself.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: CoordinatorTool.ShowBuild,
    description:
      "Open a build in Live, the game view on the right of this chat, without changing the game folder: integration (what the run built, landed or not), live (the game folder as it is), or a commit hash. Use only when the user asks to see, run, play or launch what a run made, including after the run has finished or paused; never to show your own edits, which the stage's Reload button offers by itself. Afterwards say what it answered: open in Live, or waiting behind Reload while the user watches Live.",
    parameters: {
      type: "object",
      properties: { build: { type: "string", description: "live, integration (default), or a commit hash." } },
    },
  },
  {
    name: CoordinatorTool.LandBuild,
    description:
      "Put a build in the game folder: merge what the run built (integration, the default) or a named commit into the folder the user plays from; Live shows it at once or through its Reload button, as the answer says. Only for a run that has finished or paused; use finish_run while it is running. Refuses when the game folder has uncommitted edits.",
    parameters: {
      type: "object",
      properties: { build: { type: "string", description: "integration (default) or a commit hash." } },
    },
  },
];

const COORDINATOR_TOOLS: ReadonlySet<string> = new Set<string>(Object.values(CoordinatorTool));

/** Is this one of the coordinator's tools? */
export function isCoordinatorTool(name: string): name is CoordinatorTool {
  return COORDINATOR_TOOLS.has(name);
}

/**
 * The run's controls the chat's own session keeps after a run it led (`runControls`), answered
 * live by the host: some of the coordinator's tools, by their names there. Its `resume_run` is not
 * one: the harness bridges it in and does it once the reply ends, since the resumed run's lead is
 * that same session.
 */
export const RunControl = {
  RunStatus: CoordinatorTool.RunStatus,
  ShowBuild: CoordinatorTool.ShowBuild,
  LandBuild: CoordinatorTool.LandBuild,
} as const satisfies Partial<Record<keyof typeof CoordinatorTool, CoordinatorTool>>;
export type RunControl = (typeof RunControl)[keyof typeof RunControl];

const RUN_CONTROLS: ReadonlySet<string> = new Set<string>(Object.values(RunControl));

/** The run's controls as the chat's own session is handed them: the coordinator's own specs. */
export const runControlTools: readonly StudioToolSpec[] = coordinatorTools.filter((tool) =>
  RUN_CONTROLS.has(tool.name),
);

/** Is this one of the run's controls the chat's own session keeps? */
export function isRunControl(name: string): name is RunControl {
  return RUN_CONTROLS.has(name);
}

/**
 * The builds a chat's own session records to start, which the harness starts once its reply ends:
 * a Loop's launch (the seed's `tools/game-tools.ts`), a finished build reopened
 * (`loop/reopen-run-prompts.ts` `REOPEN_RUN`) and a paused one resumed (`resume_run`). While the
 * chat is in Plan the host holds them behind the plan card (`main/core/plan-approval.ts`). The model
 * calls them by these names: never rename one (`seed-contracts.test.ts` holds them to the seed's).
 */
export const BuildLaunch = {
  StartAutopilot: "start_autopilot",
  StartUnattendedRun: "start_unattended_run",
  ReopenRun: "reopen_run",
  ResumeRun: CoordinatorTool.ResumeRun,
} as const;
export type BuildLaunch = (typeof BuildLaunch)[keyof typeof BuildLaunch];

const BUILD_LAUNCHES: ReadonlySet<string> = new Set<string>(Object.values(BuildLaunch));

/** Is this recorded call a build the chat's session asked to start? */
export function isBuildLaunch(name: string): name is BuildLaunch {
  return BUILD_LAUNCHES.has(name);
}

/** The coordinator's reading of a run: its start payload merged with later closes, and a state. */
export type CoordinatorRunState = "running" | "paused" | "finished";
export type CoordinatorRun = Record<string, unknown> & {
  runId?: string;
  project?: string;
  goal?: string;
  state: CoordinatorRunState;
};

type LogRecord = { readonly id: string; readonly data: CustomEventData };

/**
 * The run a conversation is on — the one started last, or the named one — with the fields its
 * start and its close carried. A close is `finished` whatever it says; a pause and a resume move
 * it between `paused` and `running`. This is the coordinator's view, not the Builds graph's
 * (`run-state.ts` `runExecution` reads a paused close as paused); the two answer different
 * questions and are kept apart on purpose.
 */
export function latestRun(events: readonly LogRecord[], targetRunId: string | null = null): CoordinatorRun | null {
  let run: CoordinatorRun | null = null;
  for (const event of events) {
    const custom = customRecord(event.data);
    if (!custom) continue;
    if (targetRunId && custom.payload.runId !== targetRunId) continue;
    run = coordinatorRunStep(run, custom.event_type, custom.payload);
  }
  return run;
}

/** One record applied to the coordinator's run: a start, a close, a pause or a resume. */
function coordinatorRunStep(
  run: CoordinatorRun | null,
  event_type: string,
  p: Record<string, unknown>,
): CoordinatorRun | null {
  const started: CoordinatorRun | null = RUN_START_EVENTS.has(event_type)
    ? { ...(run && run.runId === p.runId ? run : {}), ...p, state: "running" }
    : run;
  if (p.runId !== started?.runId) return started;
  // A close or a pause with no run id and no run before it still reads as a run (as it always has).
  if (event_type === CustomEvent.RunFinished) return { ...started, ...p, state: "finished" };
  if (event_type === CustomEvent.AutopilotPaused) return { ...started, state: "paused" };
  if (event_type === CustomEvent.AutopilotResumed) return { ...started, state: "running" };
  return started;
}

/**
 * Has the run's current session been asked to wrap up? Only a `finish` after the run's latest
 * `run_registered` counts: a resume registers the run again, and a resumed run that inherited
 * an earlier session's ask would skip every builder. The harness's inbox reads it the same way.
 */
export function finishRequested(events: readonly LogRecord[], runId: string): boolean {
  let finishing = false;
  for (const event of events) {
    const custom = customRecord(event.data);
    if (custom?.payload.runId !== runId) continue;
    if (custom.event_type === CustomEvent.RunRegistered) finishing = false;
    if (custom.event_type === CustomEvent.RunControl && custom.payload.action === RunControlAction.Finish)
      finishing = true;
  }
  return finishing;
}

const PROGRESS = /facet_|autopilot_|integration_|director_|optimization_updated|run_control|run_steering/;
/**
 * Events that look like progress and are not: a wake of the lead is the lead being told, not the
 * run moving, and with up to thirty an hour they pushed the workers' own events off the list; so
 * did a steer's hand-over, two for every chat message a run's lead takes (live chat). The
 * seed's copy is loop/run-inbox.ts `NOT_PROGRESS`.
 */
const NOT_PROGRESS: ReadonlySet<string> = new Set([CustomEvent.DirectorContinued, CustomEvent.RunSteeringDelivered]);

/** Does a snapshot show this event as the run's progress? */
const isProgress = (eventType: string): boolean => PROGRESS.test(eventType) && !NOT_PROGRESS.has(eventType);

export interface RunSnapshot {
  run: CoordinatorRun | { runId: string | undefined; state: "superseded" } | null;
  availableRuns: Array<{ runId: unknown; project: unknown; goal: unknown; state: CoordinatorRunState | undefined }>;
  progress: Array<Record<string, unknown> & { type: string }>;
}

/** What `run_status` answers: the run (or that it was superseded), every run here, recent progress. */
export function runSnapshot(events: readonly LogRecord[], runId: string | undefined): RunSnapshot {
  const current = latestRun(events);
  const recent = events.flatMap((event) => {
    const custom = customRecord(event.data);
    return custom && custom.payload.runId === runId ? [custom] : [];
  });
  const started = events.flatMap((event) => {
    const custom = customRecord(event.data);
    return custom && RUN_START_EVENTS.has(custom.event_type) && custom.payload.runId ? [custom.payload.runId] : [];
  });
  return {
    run: current?.runId === runId ? current : { runId, state: "superseded" },
    availableRuns: [...new Set(started)].map((id) => {
      const run = latestRun(events, id as string);
      return { runId: id, project: run?.project, goal: run?.goal, state: run?.state };
    }),
    progress: recent
      .filter((custom) => isProgress(custom.event_type))
      .slice(-24)
      .map((custom) => ({ type: custom.event_type, ...custom.payload })),
  };
}

/**
 * The conversation as a queued message may see it: messages removed from the queue are left out,
 * and so is everything queued after `messageId` (future input must not leak into an earlier
 * coordinator turn's prompt). A message edited in the queue reads with its edited text.
 */
export function conversationThrough<T extends { readonly id: string; readonly data: EventData }>(
  events: readonly T[],
  messageId?: string | null,
  queue?: QueueView,
): T[] {
  const { messages } = queue ?? messageQueueState(events);
  const byEvent = new Map([...messages.values()].filter((m) => m.eventId).map((m) => [m.eventId, m]));
  let reached = false;
  const omit = new Set<string | null>();
  for (const message of messages.values()) {
    if (message.state === "removed" || reached) omit.add(message.eventId);
    if (messageId && message.messageId === messageId) reached = true;
  }
  return events
    .filter((e) => !omit.has(e.id))
    .map((e) => {
      const message = byEvent.get(e.id);
      const text = message?.action?.text;
      if (!text || e.data.type !== EventKind.Messages) return e;
      return {
        ...e,
        data: { ...e.data, messages: e.data.messages.map((m) => (m.role === "user" ? { ...m, content: text } : m)) },
      };
    });
}
