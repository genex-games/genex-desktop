/**
 * Settled play-time AI calls as the service hands them to its trace sink (`AiCallTrace`), and the
 * callers main derives, for the Report, model-check and fit-count suites. Every builder takes the
 * fields a test cares about and fills the rest with a valid call.
 */
import { AiContext } from "../../src/shared/game-ai-route.ts";
import {
  AiAuthority,
  AiDoor,
  type AiGameKey,
  AiOp,
  AiProvenance,
  AiTier,
  type AiCallRequest,
  GAME_AI_WIRE_VERSION,
} from "../../src/shared/game-ai.ts";
import { AiValidation } from "../../src/shared/game-ai-report.ts";
import type { AiCallTrace, GameAiCaller, GameAiClock } from "../../src/main/game-ai/types.ts";

/** A game a person plays in Play. */
export const PLAY_GAME: AiGameKey = "play:p1";
/** A game in the creator's library. */
export const CREATE_GAME: AiGameKey = "create:Lantern Run";

/** A caller main derived for `game`. */
export function callerFor(game: AiGameKey, overrides: Partial<GameAiCaller> = {}): GameAiCaller {
  const create = game.startsWith("create:");
  return {
    game,
    title: create ? "Lantern Run" : "Crowns of 1444",
    context: create ? AiContext.CreateLive : AiContext.DesktopPlay,
    ownGame: create,
    replaying: false,
    channel: "wc-1",
    ...overrides,
  };
}

let tickets = 0;

/** A game's call request: an `ask` with a schema unless the overrides say otherwise. */
export function requestOf(overrides: Partial<AiCallRequest> = {}): AiCallRequest {
  tickets += 1;
  return {
    v: GAME_AI_WIRE_VERSION,
    op: AiOp.Ask,
    site: "innkeeper.reply",
    ticket: `ticket-${String(tickets).padStart(6, "0")}`,
    grantId: "grant-000001",
    system: "You are the innkeeper of the Lantern.",
    prompt: "The player asks what is on the menu.",
    untrusted: { said: "what's good tonight?" },
    memory: null,
    schema: {
      type: "object",
      properties: { line: { type: "string" } },
      required: ["line"],
      additionalProperties: false,
    },
    tier: AiTier.Fast,
    authority: AiAuthority.Local,
    maxOutputTokens: 256,
    stream: false,
    ...overrides,
  };
}

/** A settled call that fit the game's shape on a model on this Mac. */
export function traceOf(overrides: Partial<AiCallTrace> = {}): AiCallTrace {
  return {
    request: requestOf(),
    rawOutput: '{"line":"Stew and bread."}',
    value: { line: "Stew and bread." },
    validation: AiValidation.Valid,
    code: null,
    door: AiDoor.Local,
    model: { door: AiDoor.Local, engine: "ollama", model: "qwen3:8b" },
    servedModel: "qwen3:8b",
    provenance: AiProvenance.Unverified,
    usage: { inputTokens: 120, outputTokens: 9 },
    costMicros: 0,
    latencyMs: 800,
    frame: 480,
    tick: null,
    ...overrides,
  };
}

/** A clock a test moves by hand. */
export function heldClock(start = Date.parse("2026-10-20T18:00:00.000Z")): GameAiClock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}
