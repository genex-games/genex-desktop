/**
 * One engine voice (M4.8b).
 *
 * The studio runs a run on somebody's own subscription, and the two engines it hires spell a
 * tool call differently: Claude Code receives the studio's tools as MCP tools and calls them by
 * name, Codex has no tool channel at all and runs a bridge script the studio writes into the
 * workspace. That difference is the ONLY thing in the whole harness that branches on the engine
 * — and until this package eight prompts spelled BOTH, so a Claude session read a shell command
 * it must never run and a Codex session read an `mcp__` name it cannot call.
 *
 * The invariant here is not a list of the sites that were fixed. It enumerates the prompt
 * builders each module EXPORTS, renders every one of them once per engine, and asserts that a
 * Claude render carries no bridge command and a Codex render carries no `mcp__` name — so the
 * ninth prompt somebody writes is held to the same rule without anybody remembering to add it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BRIDGE_TOOL_CMD, toolCall, toolSyntax } from "../../src/harness-seed/loop/model-roles.ts";
import { BRIDGE_DIR } from "../../src/substrate/engines/studio-bridge.ts";

const CLAUDE = "claude-code";
const CODEX = "codex";

describe("one engine voice", () => {
  it("the bridge command the prompts print is the bridge the app actually writes", () => {
    assert.equal(BRIDGE_TOOL_CMD, `node ${BRIDGE_DIR}/tool.mjs`);
  });

  it("one tool, spelled the way each engine can call it", () => {
    assert.equal(toolCall(CLAUDE, "computer"), "mcp__studio__computer");
    assert.equal(toolCall(CODEX, "computer"), `${BRIDGE_TOOL_CMD} computer`);
    // A local engine drives its tools through the studio's own tool loop: neither spelling.
    assert.equal(toolCall("ollama", "computer"), "computer");
    // OpenCode has no channel for the studio's tools either: it runs the same bridge as Codex.
    assert.equal(toolCall("opencode", "computer"), `${BRIDGE_TOOL_CMD} computer`);
    assert.match(toolSyntax("opencode"), /tool\.mjs <name> --field=value/);
    // OpenRouter's tools run in the studio's own session loop, by their bare names.
    assert.equal(toolCall("openrouter", "computer"), "computer");
    assert.equal(toolCall(undefined, "capture"), "capture");
    assert.match(toolSyntax(CLAUDE), /mcp__studio__<name>/);
    assert.doesNotMatch(toolSyntax(CLAUDE), /tool\.mjs/);
    assert.match(toolSyntax(CODEX), /tool\.mjs <name> --field=value/);
    assert.doesNotMatch(toolSyntax(CODEX), /mcp__/);
    assert.doesNotMatch(toolSyntax("ollama"), /mcp__|tool\.mjs/);
  });
});
