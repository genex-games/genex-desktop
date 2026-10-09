/** Runs: starting, stopping and wrapping up a run, and what the Builds tab reads about one. */
import { lastLoopRunForProject } from "../../shared/run-review.ts";
import { graphEventsSince } from "../../shared/run-summary-feed.ts";
import { RunSummaryCache } from "../run-summary-cache.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import type { KeepAwake } from "../keep-awake.ts";
import type { RunSummaryReader } from "../run-summary-reader.ts";
import type { StudioCore } from "../studio-core.ts";
import type { IpcHandle } from "./registrar.ts";
import { errorMessage } from "../../shared/errors.ts";
import { EventKind } from "../../shared/event-log.ts";
import { HOUR_MS, SECOND_MS } from "../../shared/duration.ts";
import { DispatchActionType, type DispatchAction } from "../../shared/protocol.ts";
import type { StudioInvokePayload } from "../../shared/ipc-channels.ts";

/** Why a run request from the renderer is refused. */
const MESSAGE = {
  projectAndRunRequired: "Project and run are required",
} as const;

/** How long `run.stop` waits for the harness to take the request. */
const RUN_STOP_TIMEOUT_MS = 30 * SECOND_MS;
/** The most reference frames a run keeps; a "beat a real game" run needs at least two. */
const MAX_REFERENCE_FRAMES = 8;
const MIN_REFERENCE_FRAMES = 2;

type RunStartPayload = StudioInvokePayload<"studio:run.start">;
type ReferenceFrame = NonNullable<RunStartPayload["reference"]["frames"]>[number];
type RunRequest = Extract<DispatchAction, { type: typeof DispatchActionType.RunStart }>["run"];

export interface RunsIpcDeps {
  core: Pick<
    StudioCore,
    | "runFeedback"
    | "mainThread"
    | "layout"
    | "runPreviewIdentity"
    | "activityItems"
    | "newRunId"
    | "saveRunArtifact"
    | "dispatchRun"
    | "threadForGame"
    | "requestRunFinish"
    | "resumeAutopilot"
    | "stopRun"
  >;
  runSummaryReader: Pick<RunSummaryReader, "forProject">;
  keepAwake: Pick<KeepAwake, "hold" | "armFallback">;
  pushUiEvent(event: UiEvent): void;
  appendErrorDurably(threadId: string | undefined, message: string): Promise<void>;
}

export function registerRunsIpc(
  handle: IpcHandle,
  { core, runSummaryReader, keepAwake, pushUiEvent, appendErrorDurably }: RunsIpcDeps,
): void {
  const summaries = new RunSummaryCache();
  handle("studio:run.feedback", async (payload) => core.runFeedback(payload));
  handle("studio:run.summary", async (payload) => {
    const malformed = !payload || typeof payload.project !== "string" || typeof payload.runId !== "string";
    if (malformed) throw new Error(MESSAGE.projectAndRunRequired);
    const events = await runSummaryReader.forProject(payload.project, core.mainThread);
    const summary = await summaries.read(events, payload.project, payload.runId, core.layout.runs);
    // Only what follows the events the renderer already holds (shared/run-summary-feed.ts); the
    // memoized summary itself is shared, so the reply is a copy.
    const { from, events: since } = graphEventsSince(summary.graphEvents ?? [], payload.graphFrom);
    return { ...summary, graphEvents: since, graphEventsFrom: from, preview: core.runPreviewIdentity() };
  });
  handle("studio:activity", async () => core.activityItems());
  handle("studio:run.review", async (payload) => {
    const events = await runSummaryReader.forProject(payload.project, core.mainThread);
    return lastLoopRunForProject(
      payload.runId
        ? events.filter(
            (event) =>
              event.data.type === EventKind.Custom &&
              (event.data.payload as { runId?: string })?.runId === payload.runId,
          )
        : events,
      payload.project,
    );
  });
  handle("studio:run.start", async (payload) => {
    const frames = (payload.reference.frames ?? []).filter((frame) => frame?.data).slice(0, MAX_REFERENCE_FRAMES);
    if (payload.reference.kind === "reference" && frames.length < MIN_REFERENCE_FRAMES) {
      throw new Error('A "beat a real game" run needs at least two screenshots of the reference.');
    }
    const runId = core.newRunId();
    const shots = [...(payload.reference.shots ?? []), ...(await saveReferenceFrames(core, runId, frames))];
    // Unattended-first: hold off App Nap for the duration of the run.
    keepAwake.hold();
    // The dispatch acknowledges when the whole run COMPLETES — hours later. Fire it and return;
    // the run narrates itself through events, and run.finished/run.failed release the blocker.
    void core.dispatchRun(runRequest(payload, runId, shots, frames)).catch(async (err: unknown) => {
      // The dispatch only rejects when the harness never got to close the run itself — a UI
      // push alone would leave the log claiming whatever it claimed when the host died.
      const error = String(errorMessage(err));
      const threadId = await core.threadForGame(payload.project).catch(() => undefined);
      await appendErrorDurably(threadId, `run ${runId} failed: ${error}`);
      pushUiEvent({ type: UiEvent.RunFailed, payload: { runId, error } });
    });
    return { runId };
  });

  handle("studio:run.stop", async (payload) => {
    // Asking a run to stop is not the run ending: the harness still settles its workers,
    // runs a close health pass, lands what it can and writes the report — minutes of work that
    // used to happen on a Mac already free to sleep. `run.settled` releases the blocker; this
    // timer is only for the harness child that died and will never send it — which is exactly
    // the child whose dispatch throws or never answers, so it is armed in the finally and the
    // wait is bounded. Arming is safe either way: it no-ops with no blocker held, and the next
    // run's `run.keepawake` disarms it.
    try {
      // Through the core: the user's stop also means the run never resumes on its own afterwards.
      await core.stopRun(payload.runId, RUN_STOP_TIMEOUT_MS);
    } finally {
      keepAwake.armFallback();
    }
    return true;
  });

  // Wrap up: the same request the coordinator's `finish_run` tool makes.
  // Current attempts finish, then the run integrates, checks and shows — no reset, no abort.
  handle("studio:run.finish", async (payload) => {
    // A request can arrive after the run has already ended:
    // StudioCore refuses it for a build that is already over, so a later Resume cannot inherit
    // a wrap-up meant for a session that is gone.
    await core.requestRunFinish(payload.threadId, payload.runId);
    return true;
  });

  handle("studio:autopilot.resume", async (payload) => {
    // The harness re-notifies run.keepawake as the resumed run starts, so no acquire here.
    await core.resumeAutopilot(payload.runId);
    return true;
  });
}

/** Save the uploaded reference frames beside the run; the paths they were saved at. */
async function saveReferenceFrames(
  core: Pick<StudioCore, "saveRunArtifact">,
  runId: string,
  frames: ReferenceFrame[],
): Promise<string[]> {
  const saved: string[] = [];
  for (const [index, frame] of frames.entries()) {
    const ext = extFromMime(frame.mimeType);
    const label = safeLabel(frame.label) || `frame-${index + 1}`;
    const file = `reference/${String(index + 1).padStart(2, "0")}-${label}.${ext}`;
    saved.push(await core.saveRunArtifact(runId, file, Buffer.from(frame.data, "base64")));
  }
  return saved;
}

/** What the harness is asked to run: the goal, the reference, the budget and the models chosen. */
function runRequest(payload: RunStartPayload, runId: string, shots: string[], frames: ReferenceFrame[]): RunRequest {
  const { reference } = payload;
  return {
    runId,
    goal: payload.goal,
    project: payload.project,
    reference: {
      name: reference.name,
      shots,
      kind: reference.kind,
      ...(reference.notes ? { notes: reference.notes } : {}),
      ...(frames.length ? { frames } : {}),
    },
    budgets: { wallClockMs: Math.round(payload.hours * HOUR_MS) },
    ...(payload.engine ? { engine: payload.engine } : {}),
    ...(payload.model ? { model: payload.model } : {}),
    ...(payload.judgeEngine ? { judgeEngine: payload.judgeEngine } : {}),
    ...(payload.judgeModel ? { judgeModel: payload.judgeModel } : {}),
  };
}

/** The file extension a reference frame is saved under. */
export function extFromMime(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  return "jpg";
}

/** A frame's label as a file-name fragment: lowercase words joined by dashes, at most 40 characters. */
export function safeLabel(label: string | undefined): string {
  return (label ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
