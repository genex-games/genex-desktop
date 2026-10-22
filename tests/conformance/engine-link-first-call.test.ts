/**
 * A connector's first call never links a game. A game takes an engine project only through what
 * the person or a tool that declares it does (Use in this game, a `makes` tool): never as a side
 * effect of a call to a `game-engine` plugin's MCP server, even from a plugin that still declares
 * the `link-default` action older hosts ran at that call.
 */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";
import { CustomEvent, customEvent } from "../../src/shared/custom-events.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { readEngineBinding } from "../../src/substrate/game-engine-binding.ts";
import { ENGINES } from "../helpers/engines.ts";
import { coreLite } from "../helpers/core-lite.ts";

const SERVER = path.resolve("tests/fixtures/mcp/plugin-server.mjs");
const TOOL = "enginedemo-editor__echo";
/** Where the test plugin came from: GitHub, so it starts on and its server follows the chat's mode. */
const FROM_GITHUB = { kind: "github", repo: "studio-tests/enginedemo", sha: "a".repeat(40) } as const;

/** A local plugin with `game-engine`, an MCP server per game, and a `link-default` action that would link `project`. */
async function enginePackage(project: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "studio-engine-plugin-"));
  const manifest = {
    apiVersion: 3,
    id: "enginedemo",
    version: "1.0.0",
    name: "Engine demo",
    publisher: "Studio tests",
    description: "Links games to an engine project.",
    backend: "backend.mjs",
    capabilities: ["game-engine"],
    tools: [],
    skills: [],
    panels: [],
    settings: [],
    actions: [{ name: "link-default", label: "Link this game" }],
    mcpServers: [
      {
        id: "editor",
        transport: "stdio",
        command: "node",
        args: ["server.mjs"],
        cwd: "storage:project",
        description: "Echoes.",
      },
    ],
  };
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
  await writeFile(
    path.join(dir, "backend.mjs"),
    `export async function activate(){return {async action(name,args,c){
      if (name !== "link-default") throw new Error("unknown");
      return c.host("game.engine.link", { project: ${JSON.stringify(project)}, auto: true });
    }};}\n`,
  );
  await cp(SERVER, path.join(dir, "server.mjs"));
  return dir;
}

async function uproject(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-uproject-")));
  await mkdir(path.join(dir, "Lantern"));
  const file = path.join(dir, "Lantern", "Lantern.uproject");
  await writeFile(file, '{"FileVersion":3}\n');
  return file;
}

it("a game's first call to a game-engine plugin's server never links it", async () => {
  const lite = await coreLite();
  try {
    const project = "valley";
    await lite.core.games.scaffold(project);
    const threadId = await lite.core.createGameThread(project);
    await lite.core.setPermissionMode(threadId, PermissionMode.Bypass);
    const file = await uproject();
    // From GitHub, so its server follows the chat's Bypass: a local plugin's server asks every call.
    await lite.core.plugins.installLocal(await enginePackage(file), "github", ["game-engine"], FROM_GITHUB);
    await lite.core.plugins.setEnabled("enginedemo", true);
    await lite.core.mcp.toolsFor(project);
    const api = lite.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    const linked = async () =>
      (await lite.core.listAllEvents()).flatMap((event) => {
        const payload = customEvent(event, CustomEvent.EngineLinked);
        return payload ? [payload] : [];
      });

    assert.equal(await api["mcp.invoke"]!({ project, threadId, name: TOOL, args: { text: "one" } }), "one");
    assert.equal(
      await readEngineBinding(lite.core.games.dirFor(project), ENGINES),
      undefined,
      "the game is not linked",
    );
    assert.deepEqual(await linked(), [], "no engine_linked line");
  } finally {
    // A core-lite never started, so its stop() leaves the plugin backend to the test.
    lite.core.plugins.cancel();
    await lite.core.mcp.close();
    await lite.close();
  }
});

it("a connector call never links a game when its plugin lacks game-engine", async () => {
  const lite = await coreLite();
  try {
    const project = "plain";
    await lite.core.games.scaffold(project);
    const threadId = await lite.core.createGameThread(project);
    await lite.core.setPermissionMode(threadId, PermissionMode.Bypass);
    const file = await uproject();
    const dir = await enginePackage(file);
    const manifestFile = path.join(dir, "plugin.json");
    const { readFile } = await import("node:fs/promises");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest.capabilities = [];
    await writeFile(manifestFile, JSON.stringify(manifest));
    await lite.core.plugins.installLocal(dir, "github", [], FROM_GITHUB);
    await lite.core.plugins.setEnabled("enginedemo", true);
    await lite.core.mcp.toolsFor(project);
    const api = lite.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    assert.equal(await api["mcp.invoke"]!({ project, threadId, name: TOOL, args: { text: "one" } }), "one");
    assert.equal(await readEngineBinding(lite.core.games.dirFor(project), ENGINES), undefined);
  } finally {
    // A core-lite never started, so its stop() leaves the plugin backend to the test.
    lite.core.plugins.cancel();
    await lite.core.mcp.close();
    await lite.close();
  }
});
