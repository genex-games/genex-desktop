/**
 * A Loop lead's run tools as its engine sees them: their names (`DirectorTool`), the web Loop's
 * schemas (`directorTools`, flat string properties — every bridge carries them), and the registry the
 * studio's `director_tool` dispatch forwards a call through to the live session's handler (tools.ts).
 * The worker tools are Genex's one worker model (`loop/workers/specs.ts`).
 */
import { secondOpinionSpec } from "../second-opinion.ts";
import { WorkerTool } from "../workers/contract.ts";
import { workerTools } from "../workers/specs.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { LiveToolSpec, WorkerType } from "../../types/host-api.d.ts";

/**
 * Every run tool a lead's session calls, by the name its engine sends. The studio forwards them as
 * they are, and the feed and the tests read them: never rename a value.
 */
export const DirectorTool = {
  RunStatus: "run_status",
  WorkerStart: WorkerTool.Start,
  WorkerStatus: WorkerTool.Status,
  WorkerSteer: WorkerTool.Steer,
  WorkerStop: WorkerTool.Stop,
  Wait: WorkerTool.Wait,
  Judge: "judge",
  Show: "show",
  Note: "note",
  /** The user asked to finish: the lead records it, quoting them (wrap-up.ts). */
  WrapUp: "wrap_up",
  Finish: "finish",
  /** Not a lead's tool: the studio asking where a target lives (it is in no schema below). */
  ResolveRoot: "resolve_root",
} as const;
export type DirectorTool = (typeof DirectorTool)[keyof typeof DirectorTool];

/** `run_status` as the lead's engine sees it. */
export const RUN_STATUS_SPEC: LiveToolSpec = {
  name: DirectorTool.RunStatus,
  description: "Where the run stands: its time, the integration branch and its last health check, and the workers.",
  parameters: { type: "object", properties: {} },
};

/** `note` as the lead's engine sees it. */
export const NOTE_SPEC: LiveToolSpec = {
  name: DirectorTool.Note,
  description: "Leave a card in the run's feed: what you decided and why. The user reads these.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The card; shas, worker ids and file paths are fine." },
      plain: {
        type: "string",
        description: "The same in one sentence for someone who has never seen a terminal: no shas, ids or error text.",
      },
    },
    required: ["text"],
  },
};

/** `wrap_up` as the lead's engine sees it. */
export const WRAP_UP_SPEC: LiveToolSpec = {
  name: DirectorTool.WrapUp,
  description:
    "The user asked to finish or wrap up: call this first, quoting them. No worker starts after it; the wrap-up starts when this turn ends. To stop at once: finish user_asked.",
  parameters: {
    type: "object",
    properties: {
      user_asked: { type: "string", description: "Their words asking to finish, quoted exactly." },
      next_goal: {
        type: "string",
        description: "Asked to start a new Loop after: what it builds (it starts once this run closes).",
      },
      next_hours: { type: "string", description: "Its hours, if named." },
    },
    required: ["user_asked"],
  },
};

/** The web Loop's `show` and `finish`. */
const WEB_TOOLS: LiveToolSpec[] = [
  {
    name: DirectorTool.Show,
    description:
      "Offer a build to Live, the user's game view: integration (default), live, or a worker id. Live never changes under the user; its Reload button plays it when pressed.",
    parameters: { type: "object", properties: { target: { type: "string" } } },
  },
  {
    name: DirectorTool.Finish,
    description:
      "Close the Loop: the integration branch gets one health check (the page loads, no uncaught errors, the screenshot is not blank) and lands in the game folder when it passes (land=no: not landed); the workers stop and the report is written.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "What was built and what remains: the user's report." },
        land: { type: "string", description: "yes (default) or no." },
        victory: { type: "string", description: "yes says the goal is reached (default no)." },
        user_asked: {
          type: "string",
          description: "To stop now: the user's words asking for it, quoted exactly.",
        },
      },
      required: ["summary"],
    },
  },
];

/**
 * A web game's Loop's run tools: `run_status`, the worker tools (a copy forks from the integration
 * head and merges back with `worker_mark used`, with a health check of the merged build), the second
 * opinion, `show`, `note`, `wrap_up` and `finish`.
 */
export function directorTools(types: readonly WorkerType[] = [], allowed?: number): LiveToolSpec[] {
  return [
    RUN_STATUS_SPEC,
    ...workerTools(types, allowed),
    secondOpinionSpec({ picturesOptional: true }),
    ...WEB_TOOLS.slice(0, 1),
    NOTE_SPEC,
    WRAP_UP_SPEC,
    ...WEB_TOOLS.slice(1),
  ];
}

/** runId → the tool handler of the live lead session (the dispatch `director_tool` lands here). */
export const directors = new Map<string, (name: string, args: AnyRecord) => Promise<unknown>>();

/** The studio forwards a lead's tool call; a run without a lead answers with a sentence. */
export async function directorTool({
  runId,
  name,
  args,
}: {
  runId: string;
  name: unknown;
  args: unknown;
}): Promise<unknown> {
  const handler = directors.get(runId);
  if (!handler) return `no lead session for run ${runId} — the run is not active in this harness`;
  return handler(String(name ?? ""), args && typeof args === "object" ? (args as AnyRecord) : {});
}

/** Does this tool start at the integration worktree's real HEAD? Every lead tool does; `resolve_root` is the studio's. */
export function headSynced(name: unknown): boolean {
  return String(name ?? "") !== DirectorTool.ResolveRoot;
}
