/**
 * A fixture profile's scripted engines (`main/dev/fixture-engines.ts`) answer a game's call
 * (`CompletePurpose.Game`) the way the fixture door does: the plainest value that fits the reply
 * schema, or the fixed line when there is none, streamed when asked; never a chat reply, never the
 * network. That is what the Play and Create fixture tests see from play-time AI.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fixtureEngines } from "../../src/main/dev/fixture-engines.ts";
import { FIXTURE_SAID } from "../../src/main/game-ai/doors/fixture.ts";
import { validateValue } from "../../src/shared/game-ai-schema.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { CompletePurpose } from "../../src/substrate/engines/types.ts";

const SCHEMA = {
  type: "object",
  properties: { move: { type: "string", enum: ["march", "hold"] }, troops: { type: "integer", minimum: 1 } },
  required: ["move", "troops"],
  additionalProperties: false,
};

describe("fixture engines on a game's call", () => {
  for (const id of [EngineId.Ollama, EngineId.OpenRouter, EngineId.ClaudeCode, EngineId.LocalServer]) {
    it(`${id} answers the schema's plainest fitting value`, async () => {
      const engine = fixtureEngines().find((candidate) => candidate.id === id);
      assert.ok(engine?.complete);
      const reply = await engine.complete({
        purpose: CompletePurpose.Game,
        responseSchema: SCHEMA,
        systemPrompt: "game framing",
        messages: [{ role: "user", content: "fixture:stream What does Burgundy do?" }],
      });
      const value: unknown = JSON.parse(reply.message.content);
      assert.ok(validateValue(SCHEMA, value), reply.message.content);
      assert.deepEqual(value, { move: "march", troops: 1 });
    });
  }

  it("says the fixed line, streamed, when the call has no schema", async () => {
    const engine = fixtureEngines().find((candidate) => candidate.id === EngineId.Ollama);
    assert.ok(engine?.complete);
    const pieces: string[] = [];
    const reply = await engine.complete({
      purpose: CompletePurpose.Game,
      messages: [{ role: "user", content: "Greet the traveller." }],
      onDelta: (text) => pieces.push(text),
    });
    assert.equal(reply.message.content, FIXTURE_SAID);
    assert.equal(pieces.join(""), FIXTURE_SAID);
  });
});
