/**
 * Quality-bar intake, and the critic is whoever the user picked to build.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickJudge } from "../../src/renderer/reference-frames.ts";

describe("pickJudge", () => {
  const engines = [
    {
      id: "claude-code",
      kind: "delegated",
      status: { code: "ready" },
      models: [{ id: "opus", supportsVision: true }],
    },
    {
      id: "ollama",
      kind: "direct",
      status: { code: "ready" },
      models: [
        { id: "qwen3.6:27b", supportsVision: false },
        { id: "qwen3.8:27b-mlx", supportsVision: true },
      ],
    },
  ];

  it("a local builder is judged by a local vision model on the same engine", () => {
    assert.deepEqual(pickJudge(engines, "ollama", "qwen3.6:27b"), {
      judgeEngine: "ollama",
      judgeModel: "qwen3.8:27b-mlx",
    });
  });

  it("a Claude Code builder is judged by Claude Code, even when a local vision model exists", () => {
    // Which Claude model judges is the harness's role policy, not the picker's — a Fable pick
    // must judge on Opus, so the renderer names only the engine.
    assert.deepEqual(pickJudge(engines, "claude-code", "opus"), { judgeEngine: "claude-code" });
  });

  it("never picks a metered engine as the judge on its own", () => {
    const metered = {
      id: "openrouter",
      kind: "direct",
      status: { code: "ready" },
      models: [{ id: "v", supportsVision: true }],
    };
    assert.deepEqual(pickJudge([metered, ...engines]), {
      judgeEngine: "ollama",
      judgeModel: "qwen3.8:27b-mlx",
    });
    // The person's own pick of OpenRouter as the builder is theirs to make.
    assert.deepEqual(pickJudge([metered], "openrouter", "x"), { judgeEngine: "openrouter", judgeModel: "v" });
  });

  it("falls back to the builder model when nothing on that engine can see", () => {
    assert.deepEqual(
      pickJudge(
        [{ id: "ollama", kind: "direct", status: { code: "ready" }, models: [{ id: "qwen3.6:27b" }] }],
        "ollama",
        "qwen3.6:27b",
      ),
      { judgeEngine: "ollama", judgeModel: "qwen3.6:27b" },
    );
  });
});
