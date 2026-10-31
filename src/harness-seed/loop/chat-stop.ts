/**
 * The chat's stop of a build (the run's coordinator's `stop_run`). The host records it for the
 * message (a `run_control` of action `stop`); the chat does it once the reply has ended, since a stop
 * reaches the thread's own work too and would cut the reply short. It is the same stop as Builds'
 * (main.ts `run_stop`): the run's Stop, the chat's Stop and its engine work aborted. With `restart`
 * the build goes on again once it has stopped, through the host's own `resume_run`, which records the
 * instruction given on the run before it resumes.
 */
import { HostMethod } from "./host-methods.ts";
import { stopRun } from "./live-chat.ts";
import { EventKind, RunEvent } from "./run-events.ts";
import { RunControlAction } from "./run-inbox.ts";
import { heldRuns, type Studio } from "./studio-state.ts";
import type { AnyRecord, HarnessEvent, Host } from "../types/harness.d.ts";

/** The host's resume of a paused run, as the chat's restart asks it. */
const RESUME_RUN = "resume_run";

/** What the chat said when the stopped build did not go on again. */
const MESSAGE = {
  notRestarted: (why: string) => `The build stopped, but it did not go on again: ${why}`,
} as const;

/** The stop the run's coordinator recorded for a message: whether the build goes on again, and with what. */
export interface StopAsk {
  restart: boolean;
  text: string | null;
}

/** The stop recorded for this message on this run (`stop_run`), or null when none was. */
export async function stopAskedFor(
  host: Pick<Host, "call">,
  { threadId, runId, messageId }: { threadId: string; runId: string; messageId?: string | null },
): Promise<StopAsk | null> {
  if (!messageId) return null;
  const events: HarnessEvent[] = await host.call(HostMethod.EventsList, { threadId }).catch(() => []);
  const asked = events.findLast((event) => isStopOf(event, runId, messageId))?.data?.payload as AnyRecord | undefined;
  if (!asked) return null;
  return { restart: asked.restart === true, text: typeof asked.text === "string" && asked.text ? asked.text : null };
}

/** Is this record the stop of `runId` asked for by the message `messageId`? */
function isStopOf(event: HarnessEvent, runId: string, messageId: string): boolean {
  const data = event?.data;
  if (data?.type !== EventKind.Custom || data.event_type !== RunEvent.RunControl) return false;
  const payload = data.payload ?? {};
  return payload.action === RunControlAction.Stop && payload.runId === runId && payload.sourceMessageId === messageId;
}

/** Stop the run now, as Builds' Stop does; with `restart`, resume it once it has closed. */
export async function stopAfterReply(
  studio: Studio,
  { threadId, runId, messageId }: { threadId: string; runId: string; messageId?: string | null },
  ask: StopAsk,
): Promise<void> {
  const active = heldRuns(studio).find((held) => held.run?.runId === runId && !held.done);
  if (active) {
    stopRun(active);
    studio.cancels.add(threadId);
    await studio.host.call(HostMethod.EngineAbort, { threadId }).catch(() => {});
    // The lead and its workers are delegations of the project, not completions of the thread.
    void studio.host.call(HostMethod.EngineAbort, { project: active.run.project }).catch(() => {});
    if (ask.restart) await (active.closed ?? active.settled);
  }
  if (!ask.restart) return;
  await studio.host
    .call(HostMethod.CoordinatorTool, {
      threadId,
      runId,
      ...(messageId ? { messageId } : {}),
      name: RESUME_RUN,
      args: ask.text ? { text: ask.text } : {},
    })
    .catch((err: unknown) => say(studio.host, threadId, MESSAGE.notRestarted(errorText(err))));
}

/** A line the chat says about the stop, durably. */
async function say(host: Pick<Host, "call" | "notify">, threadId: string, content: string): Promise<void> {
  await host
    .call(HostMethod.EventsAppend, {
      threadId,
      batch: [{ type: EventKind.Messages, messages: [{ role: "assistant", content }] }],
    })
    .catch(() => {});
  host.notify("chat.message", { threadId, role: "assistant", content });
}

/** An error's words. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
