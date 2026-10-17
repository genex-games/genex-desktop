/**
 * The calls making an asset right now, in this process, by call id: a plugin tool or a connector
 * tool that says what it makes, from the moment its record opens until it closes. Each is one job
 * of the game's Assets inventory while it runs (`ProjectAssets.jobs`, its `jobId` the call's id).
 * Memory only: a call the app never saw end (it quit under it) is never shown as still being made,
 * and the log keeps the facts. Genex's own calls are not here: its job records are its jobs.
 */
import { type CallMaking, isGenexSource, type MakingJob, MakingPhase } from "../../shared/asset-making.ts";

/** One call in flight, with the game it was made for. */
export interface AssetCall {
  project: string;
  job: MakingJob;
}

/** What the host knows of a call as it goes out. */
export interface OpenedCall {
  callId: string;
  project: string | null | undefined;
  /** The plugin's id, or a connector's for a server no plugin ships. */
  source: string;
  sourceName?: string;
  at: string;
  making: CallMaking;
}

/** Note a call making an asset; false when it is not one the inventory shows (no game, or Genex's). */
export function openAssetCall(calls: Map<string, AssetCall>, call: OpenedCall): boolean {
  if (!call.project || isGenexSource(call.source)) return false;
  const { kind, tool, prompt } = call.making;
  calls.set(call.callId, {
    project: call.project,
    job: {
      source: call.source,
      ...(call.sourceName ? { sourceName: call.sourceName } : {}),
      jobId: call.callId,
      at: call.at,
      kind,
      phase: MakingPhase.Making,
      ...(tool ? { tool } : {}),
      ...(prompt ? { prompt } : {}),
    },
  });
  return true;
}

/** The call ended: its game, when it was one making an asset, else null. */
export function closeAssetCall(calls: Map<string, AssetCall>, callId: string): string | null {
  const open = calls.get(callId);
  if (!open) return null;
  calls.delete(callId);
  return open.project;
}

/** A game's calls making an asset, oldest first. */
export function assetCallJobs(calls: ReadonlyMap<string, AssetCall>, project: string): MakingJob[] {
  return [...calls.values()].filter((call) => call.project === project).map((call) => ({ ...call.job }));
}
