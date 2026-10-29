/**
 * The door to the person's Claude plan through Claude Code (D2: under the legal hold, on the
 * creator's own game in Create Live only, which routing enforces). Claude Code only: Codex is never
 * used, because its shell tool cannot be removed. The engine runs a game's call with no tools, no MCP
 * and no settings, in a neutral folder, without the judge framing (`CompletePurpose.Game`).
 *
 * Games rest before they eat into the share of the plan the person keeps for building (default
 * half): the plan's own usage, read at most once a minute, answers `waiting_for_plan` with the real
 * reset when the busiest window is past the line. No extra cost, so nothing is reserved.
 */
import { MINUTE_MS } from "../../../shared/duration.ts";
import { AiDoor, AiErrorCode } from "../../../shared/game-ai.ts";
import { MODEL_LIMIT_PREFIX, type ProviderUsage } from "../../../shared/provider-usage.ts";
import { EngineId } from "../../../shared/providers.ts";
import { AiRefusal } from "../refusal.ts";
import type { GameAiDoorImpl } from "../types.ts";
import {
  assertOffered,
  cachedRows,
  type EngineSource,
  engineReady,
  readinessOf,
  refOf,
  runOnEngine,
  usableModels,
} from "./engine.ts";

/** How long the plan's usage is kept before it is read again. */
const USAGE_TTL_MS = MINUTE_MS;
/** The wait a resting plan names when its window gives no reset. */
const UNKNOWN_RESET_MS = 5 * MINUTE_MS;

/** What the plan door runs on. */
export interface PlanDoorOptions {
  engines: EngineSource;
  /** D2: the person allowed the plan in Settings. */
  allowed(): boolean;
  /** The share of each plan kept for building, 0–100. */
  keepForBuildingPercent(): number;
  now?: () => number;
}

/** The plan's busiest window that counts for every model: its share used and when it resets. */
export function planShare(usage: ProviderUsage | null): { usedPercent: number; resetsAt: string | null } | null {
  const windows = (usage?.windows ?? []).filter(
    (window) => window.percent !== null && !window.id.startsWith(MODEL_LIMIT_PREFIX),
  );
  let busiest: { usedPercent: number; resetsAt: string | null } | null = null;
  for (const window of windows) {
    const usedPercent = window.percent ?? 0;
    if (!busiest || usedPercent > busiest.usedPercent) busiest = { usedPercent, resetsAt: window.resetsAt ?? null };
  }
  return busiest;
}

/** The Claude plan's door over `engines`. */
export function createPlanDoor(options: PlanDoorOptions): GameAiDoorImpl {
  const now = options.now ?? Date.now;
  const claude = () => options.engines(EngineId.ClaudeCode);
  const rows = cachedRows(now, async () => {
    const engine = claude();
    return options.allowed() && engine && (await engineReady(engine)) ? usableModels(engine) : [];
  });
  let usageRead: { at: number; share: ReturnType<typeof planShare> } | null = null;
  const usage = async () => {
    if (usageRead && now() - usageRead.at < USAGE_TTL_MS) return usageRead.share;
    const share = planShare(
      (await claude()
        ?.readUsage?.()
        .catch(() => null)) ?? null,
    );
    usageRead = { at: now(), share };
    return share;
  };
  /** Refuse while the plan is past the share games may use, until its window resets. */
  const assertNotResting = async () => {
    const share = await usage();
    if (!share || share.usedPercent < 100 - options.keepForBuildingPercent()) return;
    const resets = share.resetsAt ? Date.parse(share.resetsAt) - now() : Number.NaN;
    throw new AiRefusal(AiErrorCode.WaitingForPlan, resets > 0 ? resets : UNKNOWN_RESET_MS);
  };
  return {
    door: AiDoor.Plan,
    readiness: async () => readinessOf(AiDoor.Plan, await rows()),
    models: async () => (await rows()).map((row) => refOf(AiDoor.Plan, EngineId.ClaudeCode, row)),
    worstCaseMicros: () => 0,
    usage,
    run: async (call, signal, onDelta) => {
      const engine = call.model.engine === EngineId.ClaudeCode && options.allowed() ? claude() : null;
      if (!engine) throw new AiRefusal(AiErrorCode.PlanNotAllowed);
      assertOffered(await rows(), call.model.model);
      await assertNotResting();
      return (await runOnEngine(engine, call, signal, onDelta)).answer;
    },
  };
}
