/**
 * Assets first, on a run whose ask sets a visual bar. Gen3 ran no stage that sourced models up
 * front: its first model search came five hours in, its builders wrote 73 box-and-cone bpy scripts,
 * and its yard spread across four parts before any of them had one finished frame.
 *
 * Two holds on `worker_start`, each timeboxed so a run never waits on them for good:
 * - sourcing: until `docs/ASSETS.md` in the integration names every model the art pass plans (by its
 *   draw tag, one `- <tag>: <file>` line each), only the sourcing worker (`sourcing=yes`) starts — or
 *   the lead sources them itself with the asset tools;
 * - look-dev: once one part builds, a second waits for the art director's review of a hero shot
 *   (`judge ship=yes`) with no blocker on it, so one area reaches its finished look before breadth.
 *
 * A new module: a kept older sibling can never shadow these names.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { asksForLook, ArtKind, runArtPass, type ArtAsset } from "../look-bar.ts";
import { DefectSeverity } from "../ship-review.ts";
import { MINUTE_MS } from "../time.ts";
import { yes } from "./args.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { LoopRun } from "./loop-run.ts";

/** How long the sourcing hold stands after the art pass is planned. */
export const SOURCING_MS = 30 * MINUTE_MS;
/** How long the look-dev hold stands after the first part starts. */
export const LOOK_DEV_MS = 45 * MINUTE_MS;
/** The sourcing stage's ledger in the integration: one `- <tag>: <file>` line per sourced model. */
export const ASSETS_LEDGER = "docs/ASSETS.md";

/** The kinds whose models are sourced before builders start: what a box script stood in for. */
const SOURCED_KINDS: ReadonlySet<string> = new Set([ArtKind.Prop, ArtKind.Organic, ArtKind.Character]);

/** The draw tags of the models the art pass plans, in plan order. */
export function plannedModelTags(assets: readonly ArtAsset[]): string[] {
  const tags = assets.filter((asset) => SOURCED_KINDS.has(asset.kind ?? "")).flatMap((asset) => asset.tags ?? []);
  return [...new Set(tags)];
}

/** The tags `docs/ASSETS.md` names a file for: its `- <tag>: <file>` lines. */
export function sourcedTags(ledger: string | null): Set<string> {
  const out = new Set<string>();
  for (const line of String(ledger ?? "").split("\n")) {
    const match = /^\s*[-*]\s*`?([A-Za-z0-9_.:-]+)`?\s*:\s*\S/.exec(line);
    if (match?.[1]) out.add(match[1]);
  }
  return out;
}

/** When a hold that began `since` ends; a hold with no start (a Resume of an older journal) has ended. */
const holdOver = (since: unknown, ms: number, now: number): boolean => typeof since !== "number" || now >= since + ms;

const minutesLeft = (since: number, ms: number, now: number): number =>
  Math.max(1, Math.ceil((since + ms - now) / MINUTE_MS));

/** Why `worker_start` waits for the sourcing stage, or null. */
export async function sourcingRefusal(loopRun: LoopRun, args: AnyRecord, now: number): Promise<string | null> {
  const { integrationWorktree, run, state } = loopRun;
  const art = runArtPass(run);
  if (!art || !asksForLook(run) || yes(args.sourcing, false)) return null;
  const since = (state as AnyRecord).artPlannedAt;
  if (holdOver(since, SOURCING_MS, now)) return null;
  const planned = plannedModelTags(art.assets);
  const ledger = await readFile(path.join(integrationWorktree, ASSETS_LEDGER), "utf8").catch(() => null);
  const sourced = sourcedTags(ledger);
  const missing = planned.filter((tag) => !sourced.has(tag));
  if (!missing.length) return null;
  return `worker_start waits for the sourcing stage (up to ${minutesLeft(since as number, SOURCING_MS, now)} more min): ${ASSETS_LEDGER} in the integration names no file for ${missing.join(", ")}. Source the art pass's models first — generate them (genex__asset model / character), fetch CC0 models, decimate heavy ones — and write one "- <tag>: <file>" line per model, or start the sourcing worker with worker_start sourcing=yes owns=assets/,${ASSETS_LEDGER}. Builders then place, light and wire delivered assets instead of greyboxing.`;
}

/** Why a second part waits for the first one's look-dev hero shot, or null. */
export function spreadRefusal(loopRun: LoopRun, id: string, now: number): string | null {
  const { run, state } = loopRun;
  if (!runArtPass(run) || !asksForLook(run)) return null;
  const others = [...state.workers.values()].filter((worker) => worker.id !== id && !(worker as AnyRecord).sourcing);
  if (!others.length) return null;
  const since = (state as AnyRecord).lookDevSince;
  if (holdOver(since, LOOK_DEV_MS, now)) return null;
  const last = state.lastShip as AnyRecord | null | undefined;
  const passed =
    last && Array.isArray(last.defects) && !last.defects.some((d: AnyRecord) => d?.severity === DefectSeverity.Blocker);
  if (passed) return null;
  return `worker_start waits for the look-dev hero shot (up to ${minutesLeft(since as number, LOOK_DEV_MS, now)} more min): one area reaches its finished look before more parts spread. When ${others[0]?.id}'s hero camera shows it, integrate it and call judge ship=yes; once the art director's review names no blocker, start the next part.`;
}

/** The hero cameras the plan's parts name (`hero`), for every whole-game look. */
export function heroCameras(plan: AnyRecord | null | undefined): string[] {
  const parts = Array.isArray(plan?.workers) ? (plan.workers as AnyRecord[]) : [];
  return [...new Set(parts.map((part) => String(part?.hero ?? "").trim()).filter(Boolean))];
}
