/**
 * A connector that answers a session with no tools, or not at all (an engine's editor connection
 * whose editor isn't there yet), is no longer silent: the registry names it with why, the studio's
 * log says so, and the session's brief tells the agent its tools are missing this turn, so it
 * doesn't look for them. Real core, the echo server as the connectors.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { HostMethod } from "../../src/shared/harness-api.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";

const SERVER = path.resolve("tests/fixtures/mcp/echo-server.mjs");
const EMPTY = { id: "studio", name: "Roblox Studio", command: "ignored", args: [], reads: [] };
const BROKEN = { id: "editor", name: "Toy Editor", command: "ignored", args: [], reads: [] };

describe("a connector that answers with no tools", () => {
  let lite: CoreLite;
  const logged: string[] = [];
  const project = "silent";

  before(async () => {
    lite = await coreLite({ onLog: (line: string) => void logged.push(line) });
    await lite.core.games.scaffold(project);
    await lite.core.mcp.registerPluginServer("roblox", EMPTY, {
      execPath: process.execPath,
      extraArgs: [SERVER, "--none"],
    });
    await lite.core.mcp.registerPluginServer("toy", BROKEN, {
      execPath: process.execPath,
      extraArgs: [SERVER, "--leak"],
    });
  });

  after(async () => {
    await lite.core.mcp.close();
    await lite.close();
  });

  it("is named, with why, beside the tools the others gave", async () => {
    const report = await lite.core.mcp.toolsReport(project);
    assert.deepEqual(report.tools, []);
    const silent = Object.fromEntries(report.silent.map((connector) => [connector.name, connector.why]));
    assert.equal(silent["Roblox Studio"], null, "it answered, with no tools");
    assert.equal(typeof silent["Toy Editor"], "string", "it failed, and says why");
  });

  it("is logged, and the session's brief tells the agent its tools are missing this turn", async () => {
    const threadId = await lite.core.createGameThread(project);
    const prompts: string[] = [];
    lite.core.engines.register({
      id: "fixture-delegate",
      label: "Fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "Fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        prompts.push(String(request.prompt));
        return { ok: true, engine: "fixture-delegate", summary: "done", turns: 1, usage: {} };
      },
    } as never);
    const api = lite.core.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    await api[HostMethod.EngineDelegate]!({ engine: "fixture-delegate", project, threadId, prompt: "build it" });
    assert.match(prompts[0] ?? "", /Roblox Studio connection answered with no tools this turn/);
    assert.match(prompts[0] ?? "", /don't search for them/);
    assert.ok(
      logged.some((line) => line.includes("Roblox Studio") && line.includes("no tools")),
      "the studio's log says so",
    );
  });
});
