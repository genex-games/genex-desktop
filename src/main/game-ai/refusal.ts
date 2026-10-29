/**
 * Why a door gave a game no answer, as the code the game is told: a door refuses with an
 * {@link AiRefusal} it names itself (a plan resting, a model not on this Mac), and any other
 * failure is read by its kind (`AI_CODE_OF_FAILURE`). No error text ever reaches a game: an
 * engine's message can quote a provider, a path or a key.
 */
import { AI_CODE_OF_FAILURE, AiErrorCode } from "../../shared/game-ai.ts";
import { EngineError } from "../../substrate/engines/types.ts";

/** A door's own refusal: the code a game is told, and when it may try again. */
export class AiRefusal extends Error {
  readonly code: AiErrorCode;
  readonly retryAfterMs: number | null;
  constructor(code: AiErrorCode, retryAfterMs: number | null = null) {
    super(code);
    this.name = "AiRefusal";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

/** What a game is told for a failure. */
export interface AiFailure {
  code: AiErrorCode;
  retryAfterMs: number | null;
}

/** A wait the game may be told: a whole, positive number of ms, else none. */
const waitOf = (ms: number | undefined | null): number | null =>
  typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.ceil(ms) : null;

/** The code and wait a failure answers a game with; an abort is a cancel, anything unknown the provider's. */
export function failureOf(error: unknown): AiFailure {
  if (error instanceof AiRefusal) return { code: error.code, retryAfterMs: waitOf(error.retryAfterMs) };
  if (error instanceof EngineError)
    return { code: AI_CODE_OF_FAILURE[error.kind], retryAfterMs: waitOf(error.retryAfterMs) };
  if (error instanceof Error && error.name === "AbortError") return { code: AiErrorCode.Canceled, retryAfterMs: null };
  return { code: AiErrorCode.Provider, retryAfterMs: null };
}
