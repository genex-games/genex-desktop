/**
 * Play-time AI's answer cache: an answer kept by the content of the call that got it (`callKey`:
 * op, site, system, prompt, player fields, memory, schema and tier — never the ticket or the grant),
 * per game, in memory, for {@link CACHE_TTL_MS} on the injected clock and at most
 * {@link CACHE_MAX_ENTRIES} answers, the least recently used dropped first. A hit costs nothing and
 * answers the new ticket marked `cached`. Only answers are kept: a refusal is not, and neither is a
 * streamed call, whose player watches it arrive. The service serves a hit only from the door the
 * call routes to now, so a model change or a verified call never gets another door's answer.
 */
import { MINUTE_MS } from "../../shared/duration.ts";
import type { AiCallAnswer, AiCallRequest, AiGameKey } from "../../shared/game-ai.ts";
import { callKey, callKeyInput } from "../../shared/game-ai-tape.ts";
import type { GameAiCache, GameAiClock } from "./types.ts";

/** How long a kept answer answers again. */
export const CACHE_TTL_MS = 10 * MINUTE_MS;
/** The most answers kept, across games. */
export const CACHE_MAX_ENTRIES = 512;

/** One kept answer and when it stops counting. */
interface Kept {
  answer: Extract<AiCallAnswer, { ok: true }>;
  until: number;
}

/** A new, empty cache; one per profile. */
export function createGameAiCache(options: { clock: GameAiClock }): GameAiCache {
  /** By `<game> <callKey>`, in use order: the first is the least recently used. */
  const kept = new Map<string, Kept>();
  const keyOf = async (game: AiGameKey, request: AiCallRequest) => `${game} ${await callKey(callKeyInput(request))}`;

  return {
    async get(game, request) {
      if (request.stream) return null;
      const key = await keyOf(game, request);
      const entry = kept.get(key);
      if (!entry) return null;
      kept.delete(key);
      if (entry.until <= options.clock.now()) return null;
      kept.set(key, entry);
      return { ...entry.answer, ticket: request.ticket, value: structuredClone(entry.answer.value), cached: true };
    },
    async put(game, request, answer) {
      if (!answer.ok || request.stream) return;
      const key = await keyOf(game, request);
      kept.delete(key);
      kept.set(key, {
        answer: { ...answer, value: structuredClone(answer.value) },
        until: options.clock.now() + CACHE_TTL_MS,
      });
      for (const oldest of kept.keys()) {
        if (kept.size <= CACHE_MAX_ENTRIES) break;
        kept.delete(oldest);
      }
    },
  };
}
