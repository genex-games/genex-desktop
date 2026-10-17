/**
 * A connector call's records say what ran, so the chat can say it in words: a
 * `connector_tool_started` when the call goes out and a `connector_tool` when it ends, paired by
 * `callId`, each naming the plugin that ships the connector, the toolset and tool a toolset
 * gateway (Epic's Unreal MCP) reached, and the call's own arguments clipped and redacted. The
 * pictures it answers with are kept in the game's `.studio/captures/`, and the record lists them;
 * the captures folder never reaches outside the game, and pruning only touches its own files.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { keepCaptures } from "../../src/main/core/connector-record.ts";
import { CustomEvent, customEvent } from "../../src/shared/custom-events.ts";
import { CONNECTOR_ARGS_RECORD_MAX, CONNECTOR_CAPTURES_DIR } from "../../src/shared/mcp.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { coreLite } from "../helpers/core-lite.ts";

/** A 1×1 PNG: the smallest thing that is honestly a picture. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
/** Base64 of bytes that are not a picture, whatever their type says. */
const NOT_A_PICTURE = Buffer.from("not a picture at all").toString("base64");

/**
 * A plugin's MCP server, dependency-free: `echo` says its text back, `shot` answers with a real
 * picture and a part that only claims to be one.
 */
const SERVER = `
const TOOLS = [
  { name: "echo", description: "Echo.", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
  { name: "shot", description: "A picture.", inputSchema: { type: "object", properties: {} } },
];
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
function answer(name, args) {
  if (name === "echo") return { content: [{ type: "text", text: String(args?.text ?? "") }] };
  return { content: [
    { type: "text", text: "took it" },
    { type: "image", mimeType: "image/png", data: ${JSON.stringify(PIXEL)} },
    { type: "image", mimeType: "image/png", data: ${JSON.stringify(NOT_A_PICTURE)} },
  ] };
}
process.stdin.setEncoding("utf8");
let buffer = "";
for await (const chunk of process.stdin) {
  buffer += chunk;
  for (let i = buffer.indexOf("\\n"); i >= 0; i = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const { id, method, params } = JSON.parse(line);
    if (id === undefined || id === null) continue;
    if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "record-fixture", version: "1.0.0" } } });
    else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    else if (method === "tools/call") send({ jsonrpc: "2.0", id, result: answer(params?.name, params?.arguments) });
    else send({ jsonrpc: "2.0", id, result: {} });
  }
}
`;

/** A local plugin that ships one MCP server, `editor`, as Unreal's plugin does. */
async function recordPackage(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "studio-record-plugin-"));
  const manifest = {
    apiVersion: 3,
    id: "recorddemo",
    version: "1.0.0",
    name: "Record demo",
    publisher: "Studio tests",
    description: "Answers with words and pictures.",
    backend: "backend.mjs",
    capabilities: [],
    tools: [],
    skills: [],
    panels: [],
    settings: [],
    actions: [],
    mcpServers: [
      {
        id: "editor",
        transport: "stdio",
        command: "node",
        args: ["server.mjs"],
        cwd: "storage:project",
        description: "Words and pictures.",
      },
    ],
  };
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(dir, "backend.mjs"), "export async function activate(){return {};}\n");
  await writeFile(path.join(dir, "server.mjs"), SERVER);
  return dir;
}

type Lite = Awaited<ReturnType<typeof coreLite>>;

/** A game in Bypass with the plugin installed, and a way to call its connector as the harness does. */
async function connectedGame(lite: Lite, project: string) {
  await lite.core.games.scaffold(project);
  const threadId = await lite.core.createGameThread(project);
  await lite.core.setPermissionMode(threadId, PermissionMode.Bypass);
  // From GitHub, so its server follows the chat's mode: a local plugin's server asks every call.
  await lite.core.plugins.installLocal(await recordPackage(), "github", [], {
    kind: "github",
    repo: "studio-tests/record",
    sha: "a".repeat(40),
  });
  // Loaded from a folder, it starts off: the person turns it on.
  await lite.core.plugins.setEnabled("recorddemo", true);
  await lite.core.mcp.toolsFor(project);
  const api = lite.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
  const invoke = (tool: string, args: Record<string, unknown>) =>
    api["mcp.invoke"]!({ project, threadId, name: `recorddemo-editor__${tool}`, args });
  const records = async () => {
    const events = await lite.core.listAllEvents();
    return {
      started: events.flatMap((event) => {
        const payload = customEvent(event, CustomEvent.ConnectorToolStarted);
        return payload ? [{ id: event.id, ...payload }] : [];
      }),
      finished: events.flatMap((event) => {
        const payload = customEvent(event, CustomEvent.ConnectorTool);
        return payload ? [{ id: event.id, ...payload }] : [];
      }),
    };
  };
  return { invoke, records, dir: lite.core.games.dirFor(project) };
}

async function stopLite(lite: Lite): Promise<void> {
  // A core-lite never started, so its stop() leaves the plugin backend to the test.
  lite.core.plugins.cancel();
  await lite.core.mcp.close();
  await lite.close();
}

it("a connector call is recorded going out and coming back, with its toolset, tool and clipped, redacted arguments", async () => {
  const lite = await coreLite();
  try {
    const game = await connectedGame(lite, "valley");
    const refPath = "/Game/Valley/BP_Lamp.BP_Lamp:EventGraph";
    const answer = await game.invoke("echo", {
      text: "wrote it",
      toolset_name: "editor_toolset.toolsets.blueprint.BlueprintTools",
      tool_name: "write_graph_dsl",
      arguments: { graph: { refPath }, code: "(event Tick ".repeat(600), api_key: "abcdefgh12345678" },
    });
    assert.equal(answer, "wrote it");
    const { started, finished } = await game.records();
    assert.equal(started.length, 1, "one record when the call goes out");
    assert.equal(finished.length, 1, "one when it comes back");
    const [out] = started;
    const [back] = finished;
    assert.ok(out && back);
    assert.ok(out.id < back.id, "the start is written first");
    assert.equal(typeof out.callId, "string");
    assert.equal(back.callId, out.callId, "the two records pair by callId");
    for (const record of [out, back]) {
      assert.equal(record.pluginId, "recorddemo");
      assert.equal(record.connectorName, "Record demo");
      assert.equal(record.toolset, "editor_toolset.toolsets.blueprint.BlueprintTools");
      assert.equal(record.toolName, "write_graph_dsl");
      const args = record.args as { graph?: { refPath?: string }; code?: string; api_key?: string };
      assert.equal(args.graph?.refPath, refPath, "a short argument is kept whole");
      assert.ok(args.code && args.code.length < 600 && args.code.endsWith("…"), "a long text keeps its opening");
      assert.equal(args.api_key, "[redacted]", "a credential-named field is never kept");
      assert.ok(JSON.stringify(record.args).length <= CONNECTOR_ARGS_RECORD_MAX);
    }
    assert.equal(back.ok, true);

    await game.invoke("echo", { text: "plain" });
    const plain = (await game.records()).finished.at(-1);
    assert.equal(plain?.toolset, undefined, "a call that names no toolset records none");
    assert.equal(plain?.toolName, undefined);
    assert.deepEqual(plain?.args, { text: "plain" });
  } finally {
    await stopLite(lite);
  }
});

it("the pictures a connector answers with are kept in the game's captures, and its record lists them", async () => {
  const lite = await coreLite();
  try {
    const game = await connectedGame(lite, "shots");
    await game.invoke("shot", {});
    const { finished } = await game.records();
    const [record] = finished;
    assert.equal(record?.ok, true);
    assert.equal(record?.images, 2, "every image part is counted");
    assert.equal(record?.captures?.length, 1, "only the real picture is kept");
    const [kept] = record?.captures ?? [];
    assert.ok(kept?.startsWith(`${CONNECTOR_CAPTURES_DIR}/`) && kept.endsWith(".png"));
    assert.deepEqual(await readFile(path.join(game.dir, kept)), Buffer.from(PIXEL, "base64"));
    assert.doesNotMatch(JSON.stringify(record), new RegExp(PIXEL.slice(0, 24)), "the bytes never enter the log");
  } finally {
    await stopLite(lite);
  }
});

/** A game folder and a folder outside it, both real paths. */
async function gameAndOutside(): Promise<{ game: string; outside: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "studio-captures-")));
  const game = path.join(root, "game");
  const outside = path.join(root, "outside");
  await mkdir(game);
  await mkdir(outside);
  await writeFile(path.join(outside, "keep.png"), Buffer.from(PIXEL, "base64"));
  return { game, outside };
}

const picture = { data: PIXEL };

describe("the captures folder stays inside the game and prunes only its own files", () => {
  const hostile: Array<{ name: string; plant: (game: string, outside: string) => Promise<void> }> = [
    {
      name: ".studio is a link out of the game",
      plant: (game, outside) => symlink(outside, path.join(game, ".studio")),
    },
    {
      name: "captures is a link out of the game",
      plant: async (game, outside) => {
        await mkdir(path.join(game, ".studio"));
        await symlink(outside, path.join(game, ".studio", "captures"));
      },
    },
    {
      name: "captures is a file",
      plant: async (game) => {
        await mkdir(path.join(game, ".studio"));
        await writeFile(path.join(game, ".studio", "captures"), "not a folder");
      },
    },
  ];
  for (const row of hostile)
    it(`${row.name}: nothing is saved, nothing outside changes`, async () => {
      const { game, outside } = await gameAndOutside();
      await row.plant(game, outside);
      assert.deepEqual(await keepCaptures(game, [picture], { kept: 0, totalBytes: 0 }), []);
      assert.deepEqual(await readdir(outside), ["keep.png"]);
    });

  it("past the count cap the oldest go first, and files it did not write stay", async () => {
    const { game, outside } = await gameAndOutside();
    const dir = path.join(game, CONNECTOR_CAPTURES_DIR);
    const saved: string[] = [];
    for (let i = 0; i < 3; i++) saved.push(...(await keepCaptures(game, [picture], { kept: 2 })));
    await writeFile(path.join(dir, "notes.txt"), "mine");
    // A link named like a capture is not one of its files: never followed, never removed.
    await symlink(path.join(outside, "keep.png"), path.join(dir, "shot_00000000000000000000.png"));
    saved.push(...(await keepCaptures(game, [picture], { kept: 2 })));
    const left = (await readdir(dir)).sort();
    const kept = saved.slice(-2).map((file) => path.basename(file));
    assert.deepEqual(left, ["notes.txt", "shot_00000000000000000000.png", ...kept].sort());
    assert.ok((await lstat(path.join(dir, "shot_00000000000000000000.png"))).isSymbolicLink());
    assert.deepEqual(await readdir(outside), ["keep.png"]);
  });

  it("past the size cap the oldest go first; a part that is not a picture is skipped", async () => {
    const { game } = await gameAndOutside();
    const size = Buffer.from(PIXEL, "base64").length;
    const first = await keepCaptures(game, [picture, { data: NOT_A_PICTURE }], { totalBytes: size * 2 });
    assert.equal(first.length, 1);
    const later = await keepCaptures(game, [picture, picture], { totalBytes: size * 2 });
    const left = await readdir(path.join(game, CONNECTOR_CAPTURES_DIR));
    assert.deepEqual(left.sort(), later.map((file) => path.basename(file)).sort());
  });
});
