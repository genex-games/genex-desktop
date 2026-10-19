/**
 * A fixture play-time AI service for engine conformance: it answers every bridge op the way the
 * fixture door does — `hello` on, a call with the first value its schema allows (a `say` with fixed
 * text) — one macrotask later, as a real door answers, and records what it was asked. Used where a
 * test needs the broker's answers without the broker.
 */
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  AiBridgeOp,
  AiDoor,
  AiErrorCode,
  AiProvenance,
  AiSource,
  GAME_AI_WIRE_VERSION,
  refusedAnswer,
} from "../../src/shared/game-ai.ts";
import type { AiBridgeMessage } from "../../src/shared/game-ai-bridge.ts";
import { type AiOutputSchema, isAiOutputSchema, validateValue } from "../../src/shared/game-ai-schema.ts";
import {
  type AiBridgeAnswer,
  type NativeAiHost,
  type NativeAiService,
  nativeAiHost,
} from "../../src/main/game-ai/bridge-native.ts";
import type { GameAiCaller } from "../../src/main/game-ai/types.ts";

/** What a fixture `say` answers. */
export const FIXTURE_SAY_TEXT = "fixture";

/** The first value a schema of the closed dialect allows. */
export function fixtureValue(schema: AiOutputSchema): unknown {
  if (schema.enum?.length) return schema.enum[0];
  switch (schema.type) {
    case "object":
      return Object.fromEntries(
        Object.entries(schema.properties ?? {}).map(([key, inner]) => [key, fixtureValue(inner)]),
      );
    case "array":
      return Array.from({ length: schema.minItems ?? 0 }, () => (schema.items ? fixtureValue(schema.items) : null));
    case "string":
      return "x".repeat(schema.minLength ?? 0);
    case "number":
    case "integer":
      return schema.minimum ?? 0;
    case "boolean":
      return false;
    case "null":
      return null;
  }
}

/** The fixture door's answer to one message. */
function answer(message: AiBridgeMessage): AiBridgeAnswer {
  switch (message.op) {
    case AiBridgeOp.Hello:
      return { v: GAME_AI_WIRE_VERSION, on: true };
    case AiBridgeOp.Doors:
      return { on: true, door: AiDoor.Fixture };
    case AiBridgeOp.Call: {
      const { ticket, schema } = message.body;
      const value = schema === null ? FIXTURE_SAY_TEXT : isAiOutputSchema(schema) ? fixtureValue(schema) : undefined;
      const fits = schema === null || (value !== undefined && validateValue(schema, value));
      if (!fits) return refusedAnswer(ticket, AiErrorCode.InvalidSchema);
      return {
        v: GAME_AI_WIRE_VERSION,
        ok: true,
        ticket,
        value,
        source: AiSource.Fixture,
        provenance: AiProvenance.Fixture,
        latencyMs: 0,
        cached: false,
      };
    }
    case AiBridgeOp.Cancel:
      return { canceled: false };
    case AiBridgeOp.BudgetActive:
    case AiBridgeOp.BudgetRequest:
      return { view: null, code: null };
    case AiBridgeOp.BudgetStop:
      return { stopped: false };
  }
}

/** A fixture service and what it was asked, by whom, and which processes it was told went away. */
export function fixtureAiService() {
  const asked: Array<{ caller: GameAiCaller; message: AiBridgeMessage }> = [];
  const abandoned: string[] = [];
  const service: NativeAiService = {
    handle: async (caller, message) => {
      asked.push({ caller, message });
      await nextTurn();
      return answer(message);
    },
    abandon: (channel) => {
      abandoned.push(channel);
    },
  };
  return { service, asked, abandoned };
}

/** A native host over the fixture service: the game is the library's `name`, replaying when asked. */
export function fixtureNativeHost(name: string, options: { replaying?: boolean } = {}) {
  const fixture = fixtureAiService();
  const host: NativeAiHost = nativeAiHost(
    fixture.service,
    { name, title: name },
    { replaying: options.replaying ?? false },
  );
  return { host, ...fixture };
}
