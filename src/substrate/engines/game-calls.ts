/**
 * What a game's call (`CompleteRequest.purpose = CompletePurpose.Game`, `main/game-ai`) asks of an
 * engine, in one place every engine reads: the calls refused before anything is sent, and the
 * structured output a reply schema becomes on an OpenAI-compatible wire.
 *
 * A game's call is text in, text out: no tools, no pictures. Its schema is genex.games' closed
 * dialect (`shared/game-ai-schema.ts`), already checked by the caller; an engine checks it again
 * because it is the last step before a provider spends anything, and a schema outside the dialect
 * would reach a provider as an instruction the game had no right to give.
 */
import os from "node:os";
import path from "node:path";
import { type CompleteRequest, CompletePurpose, EngineError } from "./types.ts";
import { type AiOutputSchema, AiSchemaType, checkSchema } from "../../shared/game-ai-schema.ts";
import { EngineFailureKind } from "../../shared/engine-requests.ts";
import { EngineId } from "../../shared/providers.ts";
import { SECOND_MS } from "../../shared/duration.ts";

/** The name every game reply's schema is sent under; OpenAI's rule is `^[A-Za-z0-9_-]{1,64}$`. */
export const GAME_REPLY_SCHEMA_NAME = "game_reply";

/**
 * The one directory a subscription CLI answers a game's call in: empty, in the OS's temp, apart
 * from the judges' (`JUDGE_CWD`), so no game folder and no home path is in reach or in its prompt.
 */
export const GAME_CALL_CWD = path.join(os.tmpdir(), "studio-game-calls");

/**
 * How long a game's call on a hosted provider waits for its connection (TCP and TLS): a provider
 * that cannot be reached fails the call at once instead of holding the player's turn.
 */
export const GAME_CONNECT_TIMEOUT_MS = 3 * SECOND_MS;

/**
 * The engines that answer a game's call: each one can run it with every tool taken away. Codex is
 * not one: its shell cannot be removed, so a player's text would sit one instruction away from
 * this Mac's files.
 */
const GAME_CALL_ENGINES: ReadonlySet<string> = new Set<EngineId>([
  EngineId.Bonsai,
  EngineId.Ollama,
  EngineId.LocalServer,
  EngineId.OpenRouter,
  EngineId.OpenCode,
  EngineId.ClaudeCode,
]);

/** What an engine says when it refuses a game's call. */
const MESSAGE = {
  NotAnswered: "this engine does not answer a game's calls: its tools cannot all be taken away",
  Tools: "a game's call carries no tools",
  Images: "a game's call carries no pictures",
  Schema: (problem: string) => `the reply schema is outside the game dialect (${problem})`,
} as const;

/** The bounds strict structured output does not take on every provider; a schema naming one is sent loose. */
const STRICT_UNSUPPORTED_KEYWORDS = [
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
] as const satisfies ReadonlyArray<keyof AiOutputSchema>;

/** Is this a game's call? */
export function isGameCall(request: CompleteRequest): boolean {
  return request.purpose === CompletePurpose.Game;
}

/** Does this engine answer a game's call? The plan door's readiness and each engine's refusal read it. */
export function answersGameCalls(engine: string): boolean {
  return GAME_CALL_ENGINES.has(engine);
}

/**
 * Refuse, before anything is sent, a request an engine must not run: a game's call on an engine
 * that does not answer one (unavailable), or with tools or pictures, or any request whose reply
 * schema is outside the dialect. Answers the schema to send, or null when the request names none.
 */
export function gameCallSchema(request: CompleteRequest, engine: string): AiOutputSchema | null {
  if (isGameCall(request)) {
    if (!answersGameCalls(engine)) throw new EngineError(EngineFailureKind.Unavailable, engine, MESSAGE.NotAnswered);
    if (request.tools?.length) throw new EngineError(EngineFailureKind.Other, engine, MESSAGE.Tools);
    if (request.messages.some((message) => message.images?.length))
      throw new EngineError(EngineFailureKind.Other, engine, MESSAGE.Images);
  }
  if (request.responseSchema === undefined) return null;
  const problem = checkSchema(request.responseSchema);
  if (problem !== null) throw new EngineError(EngineFailureKind.Other, engine, MESSAGE.Schema(problem));
  return request.responseSchema as AiOutputSchema;
}

/**
 * Whether strict structured output takes the schema as it stands: every object requires every
 * property it lists (the dialect already closes each with `additionalProperties: false`), and no
 * node names a bound some strict providers refuse. A schema that is not strict is sent loose: the
 * model is guided by it and the caller validates the reply either way.
 */
export function strictSchemaFits(schema: AiOutputSchema): boolean {
  if (STRICT_UNSUPPORTED_KEYWORDS.some((keyword) => schema[keyword] !== undefined)) return false;
  if (schema.items && !strictSchemaFits(schema.items)) return false;
  if (schema.type !== AiSchemaType.Object) return true;
  const properties = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  return properties.every(([key, child]) => required.has(key) && strictSchemaFits(child));
}

/** The schema as an OpenAI-compatible `response_format`, read by Ollama, llama.cpp, LM Studio, vLLM and OpenRouter. */
export function gameResponseFormat(schema: AiOutputSchema): {
  type: "json_schema";
  json_schema: { name: string; strict: boolean; schema: AiOutputSchema };
} {
  return {
    type: "json_schema",
    json_schema: { name: GAME_REPLY_SCHEMA_NAME, strict: strictSchemaFits(schema), schema },
  };
}

/** Whether the schema's root is an object, the only root a hosted provider's structured output takes. */
export function objectRoot(schema: AiOutputSchema): boolean {
  return schema.type === AiSchemaType.Object;
}
