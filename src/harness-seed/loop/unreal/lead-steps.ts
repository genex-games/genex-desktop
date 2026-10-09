/**
 * The Unreal lead's runner calling the Unreal plugin's tools for its game, as its own steps (never
 * an agent's call: the host runs the tools a plugin keeps for the harness only then): the C++
 * module's own flow, the one the runner still calls by name (every other editor step is the
 * plugin's own at Genex's moments, `../hooks.ts`). A read runs whatever the run's chat is doing; a
 * write (adding the module) is part of the runner's checkpoint, which Plan mode holds back while
 * the run's chat plans, as it holds a chat's own save. A held write throws, so whatever it was part
 * of is not done. A module of its own: a seed upgrade keeps an older `lead-journal.ts` the agent
 * edited, and the runner's parts import these names from here.
 */
import type { AnyRecord } from "../../types/harness.d.ts";
import { HostMethod } from "../host-methods.ts";
import { isPlainRecord } from "../json.ts";
import type { Lead } from "./lead-journal.ts";

/**
 * Why a plugin call answered without running (its answer, never an error, carries it as
 * `blocker`): the chat is in Plan mode, or a lock the tool needs was not given in time. A copy of
 * the app's `PluginCallBlocker` (`shared/plugins.ts`), held equal by `seed-contracts.test.ts`.
 * Never rename a value.
 */
export const PluginCallBlocker = {
  PlanMode: "plan_mode",
  Lock: "lock",
} as const;
export type PluginCallBlocker = (typeof PluginCallBlocker)[keyof typeof PluginCallBlocker];

const MESSAGE = {
  InPlan: "The chat is in Plan mode, so this step waits until the plan is approved",
} as const;

/** The runner's own step. */
const HARNESS_STEP = { step: true } as const;

/** The runner's own step and part of its checkpoint, which Plan mode holds back. */
const CHECKPOINT_STEP = { step: true, checkpoint: true } as const;

/** What a runner's call names: its game and chat. */
type StepLead = Pick<Lead, "ctx" | "run" | "threadId">;

/** The error a write held back by the chat's Plan mode throws. */
type HeldInPlan = Error & { blocker: typeof PluginCallBlocker.PlanMode };

/** Whether a runner's call failed because the chat's Plan mode held it back. */
export function heldInPlan(err: unknown): err is HeldInPlan {
  return err instanceof Error && (err as Partial<HeldInPlan>).blocker === PluginCallBlocker.PlanMode;
}

/** Calls one of the Unreal plugin's tools for this game, by its agent name, as the runner's own step. */
export function unrealTool(lead: StepLead, name: string, args: AnyRecord = {}): Promise<unknown> {
  const { ctx, run, threadId } = lead;
  return ctx.call(HostMethod.PluginsInvoke, { project: run.project, threadId, name, args, ...HARNESS_STEP });
}

/**
 * Calls one of the Unreal plugin's tools that writes, as the runner's own step and part of its
 * checkpoint; throws (`heldInPlan`) when the run's chat is in Plan mode and the host held it back.
 */
export async function unrealWrite(lead: StepLead, name: string, args: AnyRecord = {}): Promise<unknown> {
  const { ctx, run, threadId } = lead;
  const answer = await ctx.call(HostMethod.PluginsInvoke, {
    project: run.project,
    threadId,
    name,
    args,
    ...CHECKPOINT_STEP,
  });
  if (isPlainRecord(answer) && answer.blocker === PluginCallBlocker.PlanMode)
    throw Object.assign(new Error(MESSAGE.InPlan), { blocker: PluginCallBlocker.PlanMode });
  // A write that never ran is no write: whatever it was part of is not done. The error carries
  // Genex's hold (the lock refusal's code) and the lock's label, so the person's line is worded
  // from them, never from the message, which is written for agents.
  if (isPlainRecord(answer) && answer.blocker === PluginCallBlocker.Lock) {
    const held = { blocker: PluginCallBlocker.Lock, hold: answer.reason, label: answer.lock };
    throw Object.assign(new Error(String(answer.message ?? "")), held);
  }
  return answer;
}
