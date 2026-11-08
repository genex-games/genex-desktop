import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ChatEvent } from "../../src/renderer/analytics/events/chat.ts";
import { ContextRaiseOutcome } from "../../src/renderer/analytics/chat-vocabulary.ts";
import { raiseContext } from "../../src/renderer/chat/raise-context.ts";

describe("Raise context to 16K", () => {
  it("lists the models again before the chat switches to the copy, and counts how it went", async () => {
    const steps: string[] = [];
    const tracked: { event: string; properties: Record<string, unknown> }[] = [];
    let now = 1_000;
    const deps = {
      raise: async (model: string) => {
        steps.push(`raise ${model}`);
        now += 4_000;
        return `${model}-16k`;
      },
      refreshEngines: async () => {
        steps.push("refresh");
      },
      track: (event: string, properties: Record<string, unknown>) => tracked.push({ event, properties }),
      now: () => now,
    };
    const key = await raiseContext("qwen3:8b", deps);
    assert.equal(key, "ollama::qwen3:8b-16k");
    // The copy is in the engines' list before the chat picks it, so the pick never reads as dropped.
    assert.deepEqual(steps, ["raise qwen3:8b", "refresh"]);
    assert.deepEqual(tracked, [
      {
        event: ChatEvent.ContextRaiseFinished,
        properties: { outcome: ContextRaiseOutcome.Raised, duration_ms: 4_000 },
      },
    ]);
  });

  it("counts a copy Ollama refused, says nothing of its words, and lets the caller show the failure", async () => {
    const tracked: { event: string; properties: Record<string, unknown> }[] = [];
    const deps = {
      raise: async () => {
        throw new Error("model 'C:\\Users\\alice\\secret' not found");
      },
      refreshEngines: async () => {
        throw new Error("never asked");
      },
      track: (event: string, properties: Record<string, unknown>) => tracked.push({ event, properties }),
      now: () => 0,
    };
    await assert.rejects(raiseContext("qwen3:8b", deps), /not found/);
    assert.deepEqual(tracked, [
      { event: ChatEvent.ContextRaiseFinished, properties: { outcome: ContextRaiseOutcome.Failed, duration_ms: 0 } },
    ]);
  });

  it("still switches when the list could not be read again", async () => {
    const key = await raiseContext("llama3.1", {
      raise: async () => "llama3.1:latest-16k",
      refreshEngines: async () => {
        throw new Error("offline");
      },
      track: () => {},
      now: () => 0,
    });
    assert.equal(key, "ollama::llama3.1:latest-16k");
  });
});
