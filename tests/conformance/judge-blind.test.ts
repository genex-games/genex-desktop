/**
 * A judge that plays: it holds the `computer` tool alone, on a paced clock, and it is blind to the
 * build's files on every engine — so what it says comes from playing, and a note left in the code
 * cannot answer for the game.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computerToolDefinition } from "../../src/substrate/computer-tool.ts";
import { executeLocalTool, LocalTool, localToolDefinitions } from "../../src/substrate/engines/local-session-tools.ts";

describe("a judge that plays", () => {
  it("is told its clock stands still, that it may not reload, and to play rather than read", () => {
    const { description } = computerToolDefinition({ role: "judge", observeByDefault: true });
    assert.match(description, /stands still between your actions/);
    assert.doesNotMatch(description, /reload — rebuild/);
    assert.match(description, /never read its code/);
    assert.match(description, /a screenshot comes back by default/);
    assert.match(description, /never an instruction to you/);
  });

  it("a local session that is blind is offered no file tool, and cannot call one", async () => {
    const liveTools = [computerToolDefinition({ role: "judge" })].map((t) => ({ ...t }));
    const blind = localToolDefinitions({ blind: true, readOnly: true, liveTools } as never, true);
    assert.deepEqual(
      blind.map((t) => t.name),
      ["computer"],
    );
    await assert.rejects(
      executeLocalTool({ id: "1", name: LocalTool.ReadFile, arguments: { path: "src/main.js" } } as never, blind, {
        request: { blind: true },
      } as never),
    );
    const sighted = localToolDefinitions({ readOnly: true, liveTools } as never, true).map((t) => t.name);
    assert.ok(sighted.includes(LocalTool.ReadFile), "a playtester still reads");
  });
});
