import { HostMethod } from "../host-methods.ts";
import { GoalBlocker, GoalStatus, goalDecision } from "./goals.ts";
import type { LoopRun } from "./loop-run.ts";

/** Resolve online prerequisites before allocating a worker; other required goals may still proceed. */
export async function requireMultiplayer(loopRun: LoopRun, goalId: string): Promise<string | null> {
  const ledger = loopRun.state.goals;
  const goal = ledger?.entries.find((entry) => entry.id === goalId);
  if (!goal?.multiplayer || !ledger) return null;
  const result = await loopRun.ctx.call(HostMethod.PluginsPreflightMultiplayer, {
    project: loopRun.run.project,
    threadId: loopRun.threadId,
  });
  if (result.ready) return null;
  goal.status = GoalStatus.Blocked;
  goal.blocker = GoalBlocker.Hosted;
  await loopRun.saveJournal();
  await loopRun.decision(result.reason, result.reason);
  if (goalDecision(ledger, loopRun.state.integrationHead) === GoalStatus.Blocked)
    await loopRun.finish({ summary: result.reason, land: "no", victory: "no" });
  return result.reason;
}
