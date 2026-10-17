/**
 * Which of the game's waiting jobs a piece of work in the chat made, and whether the chat needs to
 * keep reading them. Pure: the chat's cards (`MakingTiles.tsx`) draw what this finds.
 */
import { isUnderWay, type MakingJob } from "../../shared/asset-making.ts";
import { ToolState } from "../ui/tool-state.ts";
import { type ActivityItem, ActivityItemKind } from "./conversation-entries.ts";

/** One step of the work that makes an asset: the ids its job may go by, and whether the step still runs. */
export interface MakingCall {
  ids: readonly string[];
  running: boolean;
}

/** A work's steps that make an asset: the ids each one's job may go by, and whether it still runs. */
export function makingCalls(items: readonly ActivityItem[]): MakingCall[] {
  return items.flatMap((item) =>
    item.kind === ActivityItemKind.Tool && item.tool.making
      ? [{ ids: item.tool.making.ids, running: item.tool.state === ToolState.Running }]
      : [],
  );
}

/** The inventory's waiting jobs these steps made, once each, in the order the steps ran. */
export function jobsOfCalls(jobs: readonly MakingJob[], calls: readonly MakingCall[]): MakingJob[] {
  const found: MakingJob[] = [];
  for (const call of calls) {
    const job = jobs.find((waiting) => call.ids.includes(waiting.jobId));
    if (job && !found.includes(job)) found.push(job);
  }
  return found;
}

/** Whether the inventory needs reading while these cards show: not read yet, or something still on its way. */
export const keepsReading = (loaded: boolean, calls: readonly MakingCall[], shown: readonly MakingJob[]): boolean =>
  !loaded || calls.some((call) => call.running) || shown.some((job) => isUnderWay(job.phase));
