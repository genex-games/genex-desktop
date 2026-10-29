/**
 * Stand-ins for play-time AI's broker tests (`main/game-ai/*`): a clock the test moves, a call
 * counter in place of the budget ledger, scripted doors that record every run, a menu, settings,
 * and the deps of `createGameAiService` with every part replaceable. Nothing here opens a socket.
 */
import {
  AiConsent,
  AiDoor,
  type AiFunding,
  AiRequirement,
  type AiGameKey,
  type AiModelRef,
} from "../../src/shared/game-ai.ts";
import type { DoorReadiness } from "../../src/shared/game-ai-route.ts";
import {
  AI_DEFAULT_KEEP_FOR_BUILDING_PERCENT,
  AiPickPolicy,
  type AiModelMenu,
  type AiMenuRow,
  type GameAiNotice,
  type GameAiSettingsView,
} from "../../src/shared/game-ai-views.ts";
import type { AiDoorAnswer, AiDoorRequest, GameAiClock, GameAiDoorImpl } from "../../src/main/game-ai/types.ts";

/** A clock the test moves by hand. */
export function heldClock(startIso = "2026-10-20T10:00:00.000Z") {
  let now = Date.parse(startIso);
  const clock: GameAiClock & { set(iso: string): void; advance(ms: number): void } = {
    now: () => now,
    set: (iso) => {
      now = Date.parse(iso);
    },
    advance: (ms) => {
      now += ms;
    },
  };
  return clock;
}

/** The budget ledger's game bucket, counted in memory. */
export function callCounter() {
  const calls = new Map<string, number>();
  const tokens = new Map<string, number>();
  return {
    calls,
    tokens,
    admitGame(game: string, cap: number | null) {
      const made = calls.get(game) ?? 0;
      if (cap !== null && !(made < cap)) return { ok: false as const, reason: "cap" };
      calls.set(game, made + 1);
      return { ok: true as const };
    },
    recordGame(game: string, used: number) {
      tokens.set(game, (tokens.get(game) ?? 0) + used);
    },
  };
}

/** What a scripted door answers, run by run. */
export type ScriptedRun = AiDoorAnswer | Error | ((call: AiDoorRequest, signal: AbortSignal) => Promise<AiDoorAnswer>);

/** A door that answers from a script and records every call it ran. */
export function scriptedDoor(
  door: AiDoor,
  script: ScriptedRun[] = [],
  options: { ready?: Partial<DoorReadiness>; worstMicros?: number; models?: AiModelRef[] } = {},
) {
  const runs: AiDoorRequest[] = [];
  const queue = [...script];
  const impl: GameAiDoorImpl & { runs: AiDoorRequest[]; push(run: ScriptedRun): void } = {
    door,
    runs,
    push: (run) => void queue.push(run),
    readiness: async () => ({
      door,
      ready: true,
      json: true,
      loading: false,
      maxInputTokens: 100_000,
      ...options.ready,
    }),
    models: async () => options.models ?? [{ door, engine: `${door}-engine`, model: `${door}-model` }],
    worstCaseMicros: () => options.worstMicros ?? 0,
    run: async (call, signal) => {
      runs.push(call);
      const next = queue.shift() ?? { text: '{"ok":true}', model: "m", usage: null, costMicros: 0 };
      if (next instanceof Error) throw next;
      if (typeof next === "function") return next(call, signal);
      return next;
    },
  };
  return impl;
}

/** A menu row. */
export function menuRow(model: AiModelRef, funding: AiFunding, ready = true): AiMenuRow {
  return { model, label: model.model, shortLabel: model.model, funding, tag: null, fit: null, ready };
}

/** A game's model menu with these rows in one group. */
export function menuOf(game: AiGameKey, rows: AiMenuRow[], extra: Partial<AiModelMenu> = {}): AiModelMenu {
  return {
    game,
    title: "Crowns of 1444",
    current: null,
    usage: null,
    genex: { signedIn: false, balanceCredits: null, recommended: null, recommendedLabel: null },
    groups: [{ maker: "other", funding: null, rows }],
    struggling: [],
    off: false,
    leaderboard: false,
    requires: AiRequirement.Optional,
    ...extra,
  };
}

/** Settings → Play-time AI as a fresh profile has it. */
export function defaultSettings(patch: Partial<GameAiSettingsView> = {}): GameAiSettingsView {
  return {
    pick: AiPickPolicy.Best,
    signedIn: false,
    balanceCredits: null,
    pro: null,
    autoTopUp: null,
    dailyAlertCredits: 500,
    keepForBuildingPercent: AI_DEFAULT_KEEP_FOR_BUILDING_PERCENT,
    openRouterMonthlyMicros: null,
    createRouteEnabled: false,
    allowPlan: false,
    shareFitCounts: false,
    pausedGames: [],
    ...patch,
  };
}

/** Records every notice. */
export function noticeLog() {
  const notices: GameAiNotice[] = [];
  return { notices, notify: (notice: GameAiNotice) => void notices.push(notice) };
}

export const LOCAL_QWEN: AiModelRef = { door: AiDoor.Local, engine: "ollama", model: "qwen3:8b" };
export const BYOK_HAIKU: AiModelRef = { door: AiDoor.Byok, engine: "openrouter", model: "anthropic/claude-haiku-4.5" };
export const PLAN_HAIKU: AiModelRef = { door: AiDoor.Plan, engine: "claude-code", model: "claude-haiku-4-5" };
export const CREDITS_HAIKU: AiModelRef = {
  door: AiDoor.GenexCredits,
  engine: "genex",
  model: "anthropic/claude-haiku-4.5",
};
export const SILENT = AiConsent.Silent;
