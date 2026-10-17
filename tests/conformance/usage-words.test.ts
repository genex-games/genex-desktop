/** The composer's context and usage panel: how full the context is, and each plan's limits. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { type ContextUsage, measuredContext } from "../../src/shared/context.ts";
import { contextReading, limitLevel, pendingPlans, planWords, resetWords } from "../../src/renderer/ui/usage-words.ts";

const context = (over: Partial<ContextUsage>): ContextUsage => ({ ...over }) as ContextUsage;

describe("the context reading", () => {
  it("reads the orchestrator's measure of the chat's own model and engine", () => {
    const reading = contextReading({
      modelKey: "claude-code::opus",
      contexts: [
        context({ role: "builder", model: "opus", promptTokens: 900, contextWindow: 1000 }),
        context({ model: "sonnet", promptTokens: 800, contextWindow: 1000 }),
        context({ engine: "codex", model: "opus", promptTokens: 700, contextWindow: 1000 }),
        context({
          role: "planner",
          engine: "claude-code",
          requestedModel: "opus",
          promptTokens: 250,
          contextWindow: 1000,
        }),
      ],
    });
    assert.deepEqual(reading, {
      engine: "claude-code",
      used: 250,
      capacity: 1000,
      percent: 25,
      summary: "25% used",
    });
  });

  it("falls back to the model's window, and says an estimate is one", () => {
    const measured = context({ model: "opus", promptTokens: 300, source: "estimated" });
    const own = contextReading({ modelKey: "claude-code::opus", contexts: [measured], modelWindow: 1000 });
    assert.deepEqual([own.capacity, own.percent, own.summary], [1000, 30, "About 30% used"]);
  });

  it("reads a default pick's measure under the default key, whichever way the key spells it", () => {
    const byDefault = context({
      role: "planner",
      engine: "claude-code",
      requestedModel: "default",
      model: "claude-opus-5-5[1m]",
      promptTokens: 50_000,
      contextWindow: 1_000_000,
      source: "estimated",
    });
    const byOpus = context({ role: "planner", engine: "claude-code", requestedModel: "opus", promptTokens: 10 });
    for (const modelKey of ["claude-code::default", "claude-code::"]) {
      const reading = contextReading({ modelKey, usage: byDefault, contexts: [] });
      assert.deepEqual(
        [reading.used, reading.capacity, reading.percent, reading.summary],
        [50_000, 1_000_000, 5, "About 5% used"],
        modelKey,
      );
      assert.equal(contextReading({ modelKey, usage: byOpus, contexts: [] }).summary, "Not measured yet", modelKey);
      const compacted = context({ ...byDefault, promptTokens: undefined, compacted: true });
      const words = contextReading({ modelKey, usage: compacted, contexts: [] }).summary;
      assert.equal(words, "Compacted · measured again after the next reply", modelKey);
    }
    const onOpus = contextReading({ modelKey: "claude-code::opus", usage: byDefault, contexts: [] });
    assert.deepEqual([onOpus.used, onOpus.summary], [undefined, "Not measured yet"]);
  });

  it("shows exactly the readings the chat's measure selects for its pick", () => {
    const readings = [
      { requestedModel: "default", model: "claude-opus-5-5[1m]" },
      { requestedModel: "opus", model: "claude-opus-5-5" },
      { model: "sonnet" },
      {},
    ].map((names) =>
      context({ engine: "claude-code", role: "planner", promptTokens: 10, contextWindow: 100, ...names }),
    );
    for (const pick of ["default", "", "opus", "sonnet"])
      for (const reading of readings) {
        const logged = { data: { type: "custom", event_type: "context_usage", payload: reading } };
        const selected = measuredContext([logged], "claude-code", pick);
        const shown = contextReading({ modelKey: `claude-code::${pick}`, usage: reading, contexts: [] });
        assert.equal(shown.used != null, selected != null, `${pick} ${JSON.stringify(reading)}`);
      }
  });

  it("says why there is no number yet", () => {
    assert.equal(contextReading({ modelKey: null, contexts: [] }).summary, "Not measured yet");
    const compacted = contextReading({
      modelKey: "claude-code::opus",
      contexts: [context({ model: "opus", compacted: true })],
    });
    assert.deepEqual([compacted.percent, compacted.summary], [null, "Compacted · measured again after the next reply"]);
  });
});

describe("a plan's limits", () => {
  it("names the plan by its brand", () => {
    assert.equal(planWords("claude-code", "claude_max"), "Claude Max plan");
    assert.equal(planWords("codex", "plus"), "ChatGPT Plus plan");
    assert.equal(planWords("codex"), "ChatGPT plan");
    assert.equal(planWords("other", "team-pro"), "other Team pro plan");
  });

  it("counts down to a reset within a day", () => {
    const now = Date.parse("2026-09-24T10:00:00Z");
    assert.equal(resetWords("2026-09-24T12:30:00Z", now), "Resets in 2 h 30 m");
    assert.equal(resetWords("2026-09-24T10:00:10Z", now), "Resets in 1 m");
    assert.equal(resetWords(undefined, now), null);
    assert.equal(resetWords("not a date", now), null);
  });

  it("marks a limit high from three quarters and full from nine tenths", () => {
    assert.deepEqual([null, 10, 75, 89, 90].map(limitLevel), [undefined, undefined, "high", "high", "full"]);
  });
});

describe("plans drawn while usage is read", () => {
  it("names each plan this setup uses, the main agent's first, and one unnamed plan when none is known", () => {
    assert.deepEqual(pendingPlans({ codex: ["builder"], "claude-code": ["planner", "judge"] }), [
      "claude-code",
      "codex",
    ]);
    assert.deepEqual(pendingPlans({ codex: ["planner"], "claude-code": [] }), ["codex"]);
    assert.deepEqual(pendingPlans({ opencode: ["planner"] }), [null], "a provider without plan limits draws no plan");
    assert.deepEqual(pendingPlans({}), [null]);
  });
});
