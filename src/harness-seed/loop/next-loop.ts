/**
 * A new Loop asked for while one runs ("stop it and start a new one"): the lead records it with the
 * user's ask to finish (`wrap_up` with `next_goal`, wrap-up.ts), on the same `run_control` record,
 * and the studio starts it on the same game once this run has closed (run-dispatch.ts
 * `handleRunStart`), with the run's engine, model and roles. A Stop pressed since wins: nothing starts.
 */
import { launchFromIntake } from "./chat-dispatch.ts";
import { HostMethod } from "./host-methods.ts";
import { EventKind } from "./run-events.ts";
import { nextLoopOf, type NextLoop } from "./next-loop-record.ts";
import { tools as gameTools } from "../tools/game-tools.ts";
import type { AnyRecord, Run } from "../types/harness.d.ts";
import type { Studio } from "./studio-state.ts";

/** What the chat is told when the new Loop can't start. */
const MESSAGE = {
  notStarted: (why: string) => `The new Loop didn't start: ${why}`,
} as const;

/**
 * Start the new Loop `run`'s finish ask carried, once `run` has closed: on its game, with its engine,
 * model and roles, as a launch from the chat would. Nothing when none was asked or a Stop was pressed.
 */
export async function startNextLoop(studio: Studio, threadId: string, run: Run): Promise<void> {
  if (studio.cancels.has(threadId)) return;
  const events = await studio.host.call(HostMethod.EventsList, { threadId }).catch(() => []);
  const next = nextLoopOf(Array.isArray(events) ? events : [], run.runId);
  if (!next) return;
  const ctx = studio.scoped(threadId);
  try {
    const spec = await nextRunSpec(run, next);
    const action = {
      threadId,
      project: run.project,
      engine: run.engine,
      text: next.goal,
      ...(run.effort ? { effort: run.effort } : {}),
      ...(run.preferences ? { preferences: run.preferences } : {}),
    };
    await launchFromIntake(studio, ctx, action, spec);
  } catch (err: any) {
    const why = err?.message ?? String(err);
    await studio.host
      .call(HostMethod.EventsAppend, {
        threadId,
        batch: [{ type: EventKind.Messages, messages: [{ role: "assistant", content: MESSAGE.notStarted(why) }] }],
      })
      .catch(() => {});
  }
}

/** The new run's spec, as the Loop's own start (`start_autopilot`) writes it for the run's engine and model. */
async function nextRunSpec(run: Run, next: NextLoop): Promise<AnyRecord> {
  const start = gameTools.find((tool) => tool.name === "start_autopilot");
  if (!start) throw new Error("this harness has no Loop start");
  const autopilot = { ...(next.hours ? { hours: next.hours } : {}), ...(run.roles ? { roles: run.roles } : {}) };
  const ctx = { engine: run.engine, model: run.model, project: run.project, autopilot };
  const outcome = (await start.execute({ goal: next.goal, direction: next.direction }, ctx as never)) as AnyRecord;
  const spec = outcome?.details?.run;
  if (!spec) throw new Error(String(outcome?.content ?? "the Loop's start answered no run"));
  return spec;
}
