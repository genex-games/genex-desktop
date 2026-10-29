/**
 * A worker's start, weighed against the builder's plan limits. Two of gen3's workers stopped on
 * the weekly limit mid-round and the run sat 44 minutes waiting for an account switch: nothing
 * looked at the limits before handing out work. The host serves the same reports the app's usage
 * panel shows (`engine.usage`); a host without them, or a plan that shares none, says nothing.
 *
 * A new module: a kept older sibling can never shadow these names.
 */
import { HostMethod } from "../host-methods.ts";
import type { AnyRecord, HarnessCtx } from "../../types/harness.d.ts";

/** From this share of a plan window used, a worker's start says the window may stop it. */
export const USAGE_WARN_PERCENT = 85;

/** The fullest window of `engine`'s plan, from the host's reports, or null. */
export function fullestWindow(reports: unknown, engine: string): AnyRecord | null {
  const rows = Array.isArray(reports) ? (reports as AnyRecord[]) : [];
  const windows = (rows.find((row) => row?.engine === engine)?.usage?.windows ?? []) as AnyRecord[];
  const measured = windows.filter((window) => typeof window?.percent === "number");
  return measured.reduce<AnyRecord | null>(
    (worst, window) => (worst && worst.percent >= window.percent ? worst : window),
    null,
  );
}

/** The forecast for a worker of `rounds` rounds on `engine`, or "" when its plan has room. */
export function usageWarning(reports: unknown, engine: string, rounds: number | null): string {
  const window = fullestWindow(reports, engine);
  if (!window || window.percent < USAGE_WARN_PERCENT) return "";
  const resets = typeof window.resetsAt === "string" ? `, resetting ${window.resetsAt}` : "";
  const worker = rounds ? `a worker of ${rounds} round${rounds === 1 ? "" : "s"}` : "this worker";
  return `${engine}'s ${String(window.label ?? "plan")} limit is at ${Math.round(window.percent)}%${resets}: ${worker} may stop on it mid-round. Hand out fewer, smaller workers until it resets, or switch the builder's account`;
}

/** Asks the host for the plan limits and answers the forecast; "" when the host has none to give. */
export async function usageForecast(ctx: HarnessCtx, engine: string, rounds: number | null): Promise<string> {
  const reports = await ctx.call(HostMethod.EngineUsage, {}).catch(() => null);
  return usageWarning(reports, engine, rounds);
}
