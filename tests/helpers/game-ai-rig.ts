/**
 * A play-time AI service over real grants, settings, queue, ledger, cache and cards, with scripted
 * doors and a held clock (`main/game-ai/service.ts`), for the service's and the IPC host's tests.
 * Nothing here opens a socket or reaches an account.
 */
import path from "node:path";
import { createGameAiConsents } from "../../src/main/game-ai/approvals.ts";
import { createGameAiGrants, createGameAiSettings } from "../../src/main/game-ai/budgets.ts";
import { createGameAiCache } from "../../src/main/game-ai/cache.ts";
import { createFixtureDoor } from "../../src/main/game-ai/doors/fixture.ts";
import { createTapeDoor } from "../../src/main/game-ai/doors/tape.ts";
import { createGameAiLedger } from "../../src/main/game-ai/ledger.ts";
import { createGameAiQueue } from "../../src/main/game-ai/queue.ts";
import { createGameAiService, menuOffers } from "../../src/main/game-ai/service.ts";
import { createGameAiTapes } from "../../src/main/game-ai/tapes.ts";
import {
  AiWatcherState,
  type AiDoorAnswer,
  type GameAiCaller,
  type GameAiDoorImpl,
  type GameAiTraceSink,
  type GenexAiPlatform,
} from "../../src/main/game-ai/types.ts";
import {
  AiAuthority,
  AiBridgeOp,
  AiConsent,
  AiDoor,
  AiFunding,
  AiOp,
  AiRequirement,
  AiTier,
  GAME_AI_WIRE_VERSION,
  type AiCallAnswer,
  type AiCallRequest,
  type AiErrorCode,
  type AiGameKey,
  type AiModelRef,
} from "../../src/shared/game-ai.ts";
import { AiContext } from "../../src/shared/game-ai-route.ts";
import type { AiModelMenu, GameAiSettingsPatch } from "../../src/shared/game-ai-views.ts";
import type { PlayAiBar } from "../../src/shared/play-bar.ts";
import {
  BYOK_HAIKU,
  callCounter,
  heldClock,
  LOCAL_QWEN,
  menuOf,
  menuRow,
  noticeLog,
  PLAN_HAIKU,
  type ScriptedRun,
  scriptedDoor,
} from "./game-ai-fakes.ts";
import { tmpDir } from "./tmp.ts";

export const CROWNS: AiGameKey = "play:proj_crowns";
export const MOSS: AiGameKey = "create:Moss Garden";
export const SCHEMA = {
  type: "object",
  properties: { move: { type: "string" } },
  required: ["move"],
  additionalProperties: false,
};
export const GOOD: AiDoorAnswer = {
  text: '{"move":"march"}',
  model: "m",
  usage: { inputTokens: 300, outputTokens: 20 },
  costMicros: 4_000,
};
export const BAD: AiDoorAnswer = {
  text: "I think Burgundy marches.",
  model: "m",
  usage: { inputTokens: 300, outputTokens: 20 },
  costMicros: 4_000,
};

let tickets = 0;
export function call(patch: Partial<AiCallRequest> = {}): AiCallRequest {
  tickets += 1;
  return {
    v: GAME_AI_WIRE_VERSION,
    op: AiOp.Ask,
    site: "turn.resolve",
    ticket: `t_${String(tickets).padStart(8, "0")}`,
    grantId: "g_placeholder",
    system: "You narrate a 1444 Europe.",
    prompt: "What does Burgundy do?",
    untrusted: {},
    memory: null,
    schema: SCHEMA,
    tier: AiTier.Fast,
    authority: AiAuthority.Local,
    maxOutputTokens: 200,
    stream: false,
    ...patch,
  };
}

export function caller(patch: Partial<GameAiCaller> = {}): GameAiCaller {
  return {
    game: CROWNS,
    title: "Crowns of 1444",
    context: AiContext.DesktopPlay,
    ownGame: false,
    replaying: false,
    channel: "wc:1",
    ...patch,
  };
}

export const LOCAL_ROW = menuRow(LOCAL_QWEN, AiFunding.Free);
export const BYOK_ROW = menuRow(BYOK_HAIKU, AiFunding.Key);
export const PLAN_ROW = menuRow(PLAN_HAIKU, AiFunding.Plan);

/** genex.games, unused by these tests: every call refuses. */
export function noPlatform(): GenexAiPlatform {
  const offline = () => Promise.reject(new Error("offline"));
  return {
    balanceCredits: offline,
    packs: offline,
    checkoutUrl: offline,
    autoTopUp: offline,
    setAutoTopUp: offline,
    confirmTerms: offline,
    answerConfirm: offline,
    sendReport: offline,
    sendFitCounts: offline,
    pausedGames: offline,
    resumeGame: offline,
  };
}

export interface RigOptions {
  menu?: (game: AiGameKey) => AiModelMenu;
  /** genex.games' calls the test answers; every other one refuses. */
  platform?: Partial<GenexAiPlatform>;
  scripts?: Partial<Record<AiDoor, ScriptedRun[]>>;
  ready?: Partial<Record<AiDoor, boolean>>;
  settings?: GameAiSettingsPatch;
  moderate?: (text: string, door: AiDoor) => Promise<boolean>;
  worstMicros?: number;
  /** Hears every settled call with its text (`GameAiDeps.traces`). */
  traces?: GameAiTraceSink;
}

export async function rig(options: RigOptions = {}) {
  const dir = await tmpDir("game-ai-service-");
  const clock = heldClock();
  const settings = createGameAiSettings({ file: path.join(dir, "settings.json"), platform: noPlatform() });
  await settings.load();
  if (options.settings) await settings.save(options.settings);
  const calls = callCounter();
  const grantsFile = path.join(dir, "grants.json");
  const grants = createGameAiGrants({ file: grantsFile, clock, calls, limits: () => settings.limits() });
  await grants.load();
  const ledger = createGameAiLedger({ dir, clock, record: () => undefined });
  const notices = noticeLog();
  const bars: PlayAiBar[] = [];
  const menuFor = options.menu ?? ((game: AiGameKey) => menuOf(game, [LOCAL_ROW, BYOK_ROW, PLAN_ROW]));
  const consents = createGameAiConsents({
    clock,
    notify: notices.notify,
    assertNative: () => undefined,
    usable: async (game, model) => menuOffers(menuFor(game), model) !== null,
  });
  const door = (id: AiDoor) =>
    scriptedDoor(id, options.scripts?.[id] ?? [], {
      ready: { ready: options.ready?.[id] ?? true },
      worstMicros: options.worstMicros ?? 50_000,
    });
  const local = door(AiDoor.Local);
  const byok = door(AiDoor.Byok);
  const plan = door(AiDoor.Plan);
  const dev = door(AiDoor.GenexDev);
  const tape = createTapeDoor();
  const tapes = createGameAiTapes();
  const doors = new Map<AiDoor, GameAiDoorImpl>([
    [AiDoor.Local, local],
    [AiDoor.Byok, byok],
    [AiDoor.Plan, plan],
    [AiDoor.GenexDev, dev],
    [AiDoor.Tape, tape],
    [AiDoor.Fixture, createFixtureDoor()],
  ]);
  const service = createGameAiService({
    clock,
    grants,
    queue: createGameAiQueue({ slotWaitMs: 200, buildWaitMs: 50 }),
    doors,
    ledger,
    cache: createGameAiCache({ clock }),
    tapes,
    platform: { ...noPlatform(), ...options.platform },
    watcher: {
      state: () => ({ state: AiWatcherState.Off, runners: [], resetsAt: null }),
      start: async () => undefined,
      stop: async () => undefined,
      nudge: () => undefined,
      building: () => undefined,
    },
    consents,
    settings,
    assertNative: () => undefined,
    notify: notices.notify,
    drawPill: (_game, bar) => void bars.push(bar),
    menu: async (game) => menuFor(game),
    moderate: options.moderate ?? (async () => true),
    // A Play game is its own genex.games project; a library game here was never published.
    projectIdOf: async (game) => (game.startsWith("play:") ? game.slice("play:".length) : null),
    ...(options.traces ? { traces: options.traces } : {}),
  });
  const ask = (request: AiCallRequest, who = caller(), onDelta?: (text: string) => void) =>
    service.handle(who, { op: AiBridgeOp.Call, body: request }, onDelta);
  return {
    tapes,
    service,
    grants,
    grantsFile,
    calls,
    ledger,
    notices,
    bars,
    clock,
    consents,
    ask,
    local,
    byok,
    plan,
    dev,
    tape,
    settings,
  };
}

export const doorRuns = (r: Awaited<ReturnType<typeof rig>>) =>
  r.local.runs.length + r.byok.runs.length + r.plan.runs.length + r.dev.runs.length;

export function refusal(answer: AiCallAnswer): AiErrorCode | null {
  return answer.ok ? null : answer.code;
}

/** The game's grant on `model`, as a person's yes would leave it. */
export async function granted(r: Awaited<ReturnType<typeof rig>>, model: AiModelRef, game: AiGameKey = CROWNS) {
  return r.grants.grant(game, model, AiConsent.Card, AiRequirement.Optional);
}
