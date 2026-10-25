import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type AgentPlayMarker, NO_AGENT_PLAY } from "../../src/plugins/unity/agent-play.ts";
import { createEditorMcp, EditorTool } from "../../src/plugins/unity/editor-mcp.ts";
import type { GatePlace } from "../../src/plugins/unity/pipeline-gate.ts";
import type { PipelineDeps } from "../../src/plugins/unity/pipeline.ts";
import { ENGINE_PLAY_VIEW } from "../../src/shared/engine-play.ts";
import { CONNECTOR_OUTCOME_META } from "../../src/shared/mcp.ts";
import {
  droppedConnection,
  editor,
  json,
  openProject,
  type Reply,
  refusedConnection,
  STAND_IN,
  unityProject,
} from "../helpers/unity-editor-stand-in.ts";

type ToolAnswer = {
  isError?: boolean;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  _meta?: Record<string, unknown>;
};

const parameter = (name: string, type: string, required = false) => ({ name, type, required, description: `${name}.` });

/** The editor's catalogue as Pipeline 0.8 answers it: each command with its tags and typed parameters. */
const catalogue = () =>
  json(200, {
    count: 6,
    total: 6,
    commands: [
      { name: "editor_play", description: "Enter Play mode", tags: ["editor/playmode"], parameters: [] },
      {
        name: "open_scene",
        description: "Open a scene",
        tags: ["scenes"],
        parameters: [parameter("path", "String", true), parameter("additive", "Boolean")],
      },
      {
        name: "capture_game_view",
        description: "Capture the Game view",
        tags: ["capture"],
        parameters: [parameter("save_path", "String"), parameter("width", "Int32")],
      },
      { name: "eval", description: "Run C#", tags: ["scripts/eval"], parameters: [parameter("code", "String", true)] },
      { name: "quit", description: "Quit the editor", tags: ["editor"], parameters: [] },
      {
        name: "batch",
        description: "Run several",
        tags: ["batch"],
        parameters: [parameter("operations", "List`1", true)],
      },
    ],
  });

/** The editor's main thread answering a look: awake, in Edit mode. */
const look = () => json(200, { status: "ready", playMode: "stopped", compiling: false });

/** The catalogue with the commands that save and list scenes, enter Play mode and capture. */
const savingCatalogue = () =>
  json(200, {
    commands: [
      { name: "save_all", description: "Save all scenes", tags: ["scenes"], parameters: [] },
      { name: "save_scene", description: "Save a scene", tags: ["scenes"], parameters: [parameter("path", "String")] },
      { name: "list_open_scenes", description: "List open scenes", tags: ["scenes"], parameters: [] },
      { name: "editor_play", description: "Enter Play mode", tags: ["editor/playmode"], parameters: [] },
      { name: "editor_stop", description: "Leave Play mode", tags: ["editor/playmode"], parameters: [] },
      {
        name: "batch",
        description: "Run several",
        tags: ["batch"],
        parameters: [parameter("operations", "List`1", true)],
      },
      {
        name: "capture_game_view",
        description: "Capture",
        tags: ["capture"],
        parameters: [parameter("save_path", "String")],
      },
    ],
  });
const openScenes = (...paths: string[]) =>
  json(200, { success: true, result: { scenes: paths.map((path) => ({ path, isLoaded: true, isDirty: false })) } });
const commandsSent = (seen: Array<{ body: unknown }>) =>
  seen.map((request) => (request.body as { command?: string } | undefined)?.command).filter(Boolean);

/** An agent's session with the bridge, over the project `findProject` answers. */
async function connect(
  findProject: () => Promise<GatePlace | undefined>,
  deps: PipelineDeps,
  agentPlay: AgentPlayMarker = NO_AGENT_PLAY,
) {
  const bridge = createEditorMcp(findProject, deps, agentPlay);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([bridge.server.connect(serverSide), client.connect(clientSide)]);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as ToolAnswer;
  return { client, call, close: bridge.close };
}

/** A session with a project that is open in the stand-in editor and is its game's own folder. */
async function openEditor(replies: Reply[]) {
  const root = await openProject();
  const stand = editor(replies);
  return { root, ...stand, ...(await connect(async () => ({ root, game: root }), stand.deps)) };
}

const textOf = (answer: ToolAnswer) => answer.content.map((part) => part.text ?? "").join("\n");

describe("the Unity editor connector", () => {
  it("offers its three tools before any editor is open", async () => {
    const { client, close } = await connect(async () => undefined, editor([]).deps);
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [EditorTool.ListCommands, EditorTool.DescribeCommand, EditorTool.RunCommand],
    );
    assert.deepEqual(
      tools.map((tool) => tool.inputSchema.required),
      [undefined, ["command"], ["command"]],
    );
    await close();
  });

  it("lists the editor's commands with their tags, without the ones agents never run", async () => {
    const { call, seen, close } = await openEditor([catalogue()]);
    const answer = await call(EditorTool.ListCommands);
    assert.equal(answer.isError, undefined);
    assert.deepEqual(JSON.parse(textOf(answer)), [
      { name: "editor_play", description: "Enter Play mode", tags: ["editor/playmode"] },
      { name: "open_scene", description: "Open a scene", tags: ["scenes"] },
      { name: "capture_game_view", description: "Capture the Game view", tags: ["capture"] },
      { name: "batch", description: "Run several", tags: ["batch"] },
    ]);
    assert.equal(seen.length, 1);
    await close();
  });

  it("describes one command's parameters, and nothing of a command agents never run", async () => {
    const { call, seen, close } = await openEditor([catalogue(), catalogue(), catalogue()]);
    const described = await call(EditorTool.DescribeCommand, { command: "open_scene" });
    assert.equal(described.isError, undefined);
    assert.deepEqual(JSON.parse(textOf(described)), {
      name: "open_scene",
      description: "Open a scene",
      tags: ["scenes"],
      parameters: [
        { name: "path", type: "String", required: true, description: "path." },
        { name: "additive", type: "Boolean", required: false, description: "additive." },
      ],
    });
    const denied = await call(EditorTool.DescribeCommand, { command: "eval" });
    assert.equal(denied.isError, true);
    assert.match(textOf(denied), /eval is not available to agents/);
    const unknown = await call(EditorTool.DescribeCommand, { command: "fly_away" });
    assert.equal(unknown.isError, true);
    assert.match(textOf(unknown), /command must be the name of a command from list_commands/);
    assert.deepEqual(
      seen.map((request) => request.method),
      ["GET", "GET", "GET"],
      "describing sends the editor no command",
    );
    await close();
  });

  it("runs a command in the game's own project and answers its result as JSON", async () => {
    const { call, seen, close } = await openEditor([
      catalogue(),
      look(),
      json(200, { success: true, result: { scene: "Assets/Scenes/Main.unity", objects: 12 } }),
      catalogue(),
      look(),
      json(200, { success: true, result: "playing" }),
    ]);
    const answer = await call(EditorTool.RunCommand, {
      command: "open_scene",
      parameters: { path: "Assets/Scenes/Main.unity" },
    });
    assert.equal(answer.isError, undefined);
    assert.deepEqual(JSON.parse(textOf(answer)), { scene: "Assets/Scenes/Main.unity", objects: 12 });
    assert.equal(seen[1]?.url, `http://127.0.0.1:${STAND_IN.port}/api/editor_status`, "a look at the main thread");
    assert.deepEqual(seen[2]?.body, { command: "open_scene", parameters: { path: "Assets/Scenes/Main.unity" } });
    assert.equal(seen[2]?.url, `http://127.0.0.1:${STAND_IN.port}/api/exec`);
    assert.equal(textOf(await call(EditorTool.RunCommand, { command: "editor_play" })), "playing");
    await close();
  });

  it("cuts a result too long for a prompt and says so", async () => {
    const { call, close } = await openEditor([
      catalogue(),
      look(),
      json(200, { success: true, result: "x".repeat(200_000) }),
    ]);
    const text = textOf(await call(EditorTool.RunCommand, { command: "editor_play" }));
    assert.ok(text.length < 61_000, `${text.length} characters`);
    assert.match(text, /cut: the result was 200000 characters/);
    await close();
  });

  it("refuses a call the gate refuses, sending the editor no command", async () => {
    const refused: Array<[Record<string, unknown>, RegExp]> = [
      [{ command: "eval", parameters: { code: 'System.IO.File.Delete("x")' } }, /eval is not available to agents/],
      [{ command: "quit" }, /quit is not available to agents/],
      [{ command: "batch", parameters: { operations: [{ command: "eval" }] } }, /eval is not available to agents/],
      [{ command: "Editor Play" }, /command must be the name of a command from list_commands/],
      [{ command: "fly_away" }, /command must be the name of a command from list_commands/],
      [{}, /command must be the name of a command from list_commands/],
      [{ command: "editor_play", parameters: "now" }, /parameters must be an object/],
      [
        { command: "open_scene", parameters: { path: "../../elsewhere.unity" } },
        /path must name a file or folder inside/,
      ],
      [{ command: "capture_game_view", parameters: { save_path: "/tmp/shot.png" } }, /save_path must name a file/],
    ];
    const { call, seen, close } = await openEditor(refused.map(catalogue));
    for (const [args, message] of refused) {
      const answer = await call(EditorTool.RunCommand, args);
      assert.equal(answer.isError, true, JSON.stringify(args));
      assert.match(textOf(answer), message);
    }
    assert.deepEqual([...new Set(seen.map((request) => request.method))], ["GET"]);
    await close();
  });

  it("takes the game's folder, not only the Unity project in it, as where a command's files may be", async () => {
    const root = await openProject();
    const shot = { command: "capture_game_view", parameters: { save_path: "../shot.png" } };
    const inGame = editor([catalogue(), look(), json(200, { success: true, result: "saved" })]);
    const wide = await connect(async () => ({ root, game: path.dirname(root) }), inGame.deps);
    assert.equal(textOf(await wide.call(EditorTool.RunCommand, shot)), "saved");
    await wide.close();

    const ownFolder = editor([catalogue()]);
    const narrow = await connect(async () => ({ root, game: root }), ownFolder.deps);
    const refused = await narrow.call(EditorTool.RunCommand, shot);
    assert.match(textOf(refused), /save_path must name a file or folder inside this game's folder/);
    assert.equal(ownFolder.seen.length, 1, "only the catalogue was read");
    await narrow.close();
  });

  it("says what stands between the agent and the editor, in words that name the fix", async () => {
    const closed = await unityProject();
    const cases: Array<[string, () => Promise<GatePlace | undefined>, RegExp]> = [
      ["no project found", async () => undefined, /has not found a Unity project in this game's folder/],
      [
        "a project not open",
        async () => ({ root: closed, game: closed }),
        /is not open in Unity, or it has no Pipeline package \(com\.unity\.pipeline\)/,
      ],
    ];
    for (const [what, find, message] of cases) {
      const stand = editor([]);
      const { call, close } = await connect(find, stand.deps);
      for (const tool of Object.values(EditorTool)) {
        const answer = await call(tool, { command: "editor_play" });
        assert.equal(answer.isError, true, `${what}: ${tool}`);
        assert.match(textOf(answer), message, `${what}: ${tool}`);
      }
      assert.deepEqual(stand.seen, [], what);
      await close();
    }
  });

  it("tells a busy, a silent and a refusing editor apart, and a command that failed or may have run", async () => {
    const busy = () => json(503, { error: "Server Busy", status: "busy", busyReason: "blocked_by_dialog" });
    const outcomes: Array<[string, Reply[], RegExp]> = [
      ["busy", [catalogue(), look(), ...Array.from({ length: 80 }, busy)], /Unity stayed busy \(blocked_by_dialog\)/],
      ["silent", Array.from({ length: 80 }, refusedConnection), /Unity did not answer/],
      ["refusing", [json(401, {}), json(401, {})], /Unity refused Genex's token/],
      [
        "failed",
        [
          catalogue(),
          look(),
          json(400, { success: false, error: "Command Execution Failed", errorDetails: "No camera found" }),
        ],
        /capture_game_view failed: Command Execution Failed: No camera found/,
      ],
      [
        "no answer",
        [catalogue(), look(), droppedConnection()],
        /whether it took effect is unknown\. Look before you repeat it/,
      ],
    ];
    for (const [what, replies, message] of outcomes) {
      const { call, close } = await openEditor(replies);
      const answer = await call(EditorTool.RunCommand, { command: "capture_game_view" });
      assert.equal(answer.isError, true, what);
      assert.match(textOf(answer), message, what);
      // Only a command that may have run is recorded by the host as outcome unknown.
      const unknown = what === "no answer" ? CONNECTOR_OUTCOME_META.Unknown : undefined;
      assert.equal(answer._meta?.[CONNECTOR_OUTCOME_META.Key], unknown, what);
      await close();
    }
  });

  it("says the main thread is stalled instead of sending a command into an editor that runs nothing", async () => {
    const root = await openProject();
    const stand = editor([
      catalogue(),
      new Error("timed out"),
      catalogue(),
      look(),
      json(400, {
        success: false,
        error: "Internal Server Error",
        errorDetails: "Main thread operation timed out after 60000ms",
      }),
    ]);
    const stalled = { ...stand.deps, timeout: () => AbortSignal.abort() };
    const before = await connect(async () => ({ root, game: root }), stalled);
    const refused = await before.call(EditorTool.RunCommand, { command: "editor_play" });
    assert.equal(refused.isError, true);
    assert.match(textOf(refused), /main thread ran nothing.* a dialog nobody answered.* unity__restart-editor/);
    assert.deepEqual(commandsSent(stand.seen), [], "the command itself was never sent");
    await before.close();

    const during = await connect(async () => ({ root, game: root }), stand.deps);
    const answer = await during.call(EditorTool.RunCommand, { command: "editor_play" });
    assert.match(textOf(answer), /main thread ran nothing/, "Pipeline's own give-up on its main thread reads the same");
    assert.equal(answer._meta, undefined, "a command the main thread never ran did not take effect");
    await during.close();
  });

  it("never asks Unity to save a scene that has no name: the save panel nobody answers stalls the editor", async () => {
    const unnamed: Array<[string, Record<string, unknown>]> = [
      ["save_all", { command: "save_all" }],
      ["save_scene with no path", { command: "save_scene", parameters: {} }],
      ["a batch that saves", { command: "batch", parameters: { operations: [{ command: "save_all" }] } }],
    ];
    for (const [what, args] of unnamed) {
      const replies = [savingCatalogue(), look(), openScenes("Assets/Scenes/Main.unity", "")];
      const { call, seen, close } = await openEditor(replies);
      const answer = await call(EditorTool.RunCommand, args);
      assert.equal(answer.isError, true, what);
      assert.match(textOf(answer), /has never been saved.* save_scene with a path under Assets\//, what);
      assert.deepEqual(commandsSent(seen), ["list_open_scenes"], `${what}: only the scenes were listed`);
      await close();
    }
  });

  it("saves as asked once every open scene has a name, and a scene given a path without looking", async () => {
    const { call, seen, close } = await openEditor([
      savingCatalogue(),
      look(),
      openScenes("Assets/Scenes/Main.unity"),
      json(200, { success: true, result: { saved: true } }),
      savingCatalogue(),
      look(),
      json(200, { success: true, result: { saved: true } }),
    ]);
    assert.equal(textOf(await call(EditorTool.RunCommand, { command: "save_all" })), '{"saved":true}');
    const withPath = { command: "save_scene", parameters: { path: "Scenes/Level2.unity" } };
    assert.equal(textOf(await call(EditorTool.RunCommand, withPath)), '{"saved":true}');
    assert.deepEqual(commandsSent(seen), ["list_open_scenes", "save_all", "save_scene"]);
    await close();
  });

  it("hands a captured picture to the agent as an image, not as text too long to read", async () => {
    const png = Buffer.from("\x89PNG\r\n\x1a\nfake-pixels").toString("base64");
    const shot = { width: 320, height: 180, encoding: "png", base64: png, bytes: 19, source: "camera:Main Camera" };
    const { call, close } = await openEditor([
      savingCatalogue(),
      look(),
      json(200, { success: true, result: shot }),
      savingCatalogue(),
      look(),
      json(200, {
        success: true,
        result: { results: [{ command: "capture_game_view", result: shot }, { result: 7 }] },
      }),
    ]);
    const single = await call(EditorTool.RunCommand, { command: "capture_game_view" });
    assert.deepEqual(single.content, [
      { type: "text", text: JSON.stringify({ ...shot, base64: "[image 1 attached]" }) },
      { type: "image", data: png, mimeType: "image/png" },
    ]);
    const batched = await call(EditorTool.RunCommand, {
      command: "batch",
      parameters: { operations: [{ command: "capture_game_view" }] },
    });
    assert.deepEqual(
      batched.content.map((part) => part.type),
      ["text", "image"],
    );
    assert.match(textOf(batched), /\[image 1 attached\]/);
    await close();
  });

  it("sizes a capture that names no size as Genex's own looks at the game, keeping a size the agent names", async () => {
    const sizedCatalogue = (...sizes: string[]) =>
      json(200, {
        commands: [
          {
            name: "batch",
            description: "Run several",
            tags: ["batch"],
            parameters: [parameter("operations", "List`1", true)],
          },
          {
            name: "capture_game_view",
            description: "Capture",
            tags: ["capture"],
            parameters: [parameter("source", "String"), ...sizes.map((size) => parameter(size, "Int32"))],
          },
        ],
      });
    const done = () => json(200, { success: true, result: {} });
    const { call, seen, close } = await openEditor([
      sizedCatalogue("width", "height"),
      look(),
      done(),
      sizedCatalogue("width", "height"),
      look(),
      done(),
      sizedCatalogue("width", "height"),
      look(),
      done(),
      sizedCatalogue("width"),
      look(),
      done(),
      sizedCatalogue(),
      look(),
      done(),
    ]);
    const capture = (parameters?: Record<string, unknown>) =>
      call(EditorTool.RunCommand, { command: "capture_game_view", ...(parameters ? { parameters } : {}) });
    await capture({ source: "camera:Main Camera" });
    await capture({ width: 640 });
    await call(EditorTool.RunCommand, {
      command: "batch",
      parameters: {
        operations: [{ command: "capture_game_view" }, { command: "capture_game_view", params: { height: 90 } }],
      },
    });
    await capture();
    await capture();
    const exec = seen.filter((request) => request.url.endsWith("/api/exec")).map((request) => request.body);
    assert.deepEqual(exec, [
      { command: "capture_game_view", parameters: { ...ENGINE_PLAY_VIEW, source: "camera:Main Camera" } },
      { command: "capture_game_view", parameters: { width: 640 } },
      {
        command: "batch",
        parameters: {
          operations: [
            { command: "capture_game_view", params: { ...ENGINE_PLAY_VIEW } },
            { command: "capture_game_view", params: { height: 90 } },
          ],
        },
      },
      { command: "capture_game_view", parameters: { width: ENGINE_PLAY_VIEW.width } },
      { command: "capture_game_view", parameters: {} },
    ]);
    await close();
  });

  it("marks the agent's own play while it runs, so the editor lock can tell it from the person's", async () => {
    const root = await openProject();
    const marks: string[] = [];
    const marker: AgentPlayMarker = {
      started: async () => void marks.push("started"),
      stopped: async () => void marks.push("stopped"),
    };
    const stand = editor([
      savingCatalogue(),
      look(),
      json(200, { success: true, result: "Entered play mode" }),
      savingCatalogue(),
      look(),
      json(400, { success: false, error: "Command Execution Failed", errorDetails: "Not playing" }),
      savingCatalogue(),
      look(),
      json(200, { success: true, result: "Exited play mode" }),
    ]);
    const { call, close } = await connect(async () => ({ root, game: root }), stand.deps, marker);
    await call(EditorTool.RunCommand, { command: "editor_play" });
    assert.deepEqual(marks, ["started"]);
    await call(EditorTool.RunCommand, { command: "editor_stop" });
    assert.deepEqual(marks, ["started"], "a stop that failed ends nothing");
    await call(EditorTool.RunCommand, { command: "editor_stop" });
    assert.deepEqual(marks, ["started", "stopped"]);
    await close();
  });

  it("marks the agent's play before Unity gets the command, alone or in a batch: the lock may ask while Play starts", async () => {
    const root = await openProject();
    const stand = editor([
      savingCatalogue(),
      look(),
      json(200, { success: true, result: "Entered play mode" }),
      savingCatalogue(),
      look(),
      json(200, { success: true, result: { results: [] } }),
    ]);
    const marks: string[] = [];
    const marker: AgentPlayMarker = {
      started: async () => void marks.push(`started, ${commandsSent(stand.seen).length} commands sent`),
      stopped: async () => void marks.push("stopped"),
    };
    const { call, close } = await connect(async () => ({ root, game: root }), stand.deps, marker);
    await call(EditorTool.RunCommand, { command: "editor_play" });
    await call(EditorTool.RunCommand, {
      command: "batch",
      parameters: { operations: [{ command: "editor_play", params: {} }] },
    });
    assert.deepEqual(marks, ["started, 0 commands sent", "started, 1 commands sent"]);
    assert.deepEqual(commandsSent(stand.seen), ["editor_play", "batch"]);
    await close();
  });

  it("forgets the agent's play when a batch stops it", async () => {
    const root = await openProject();
    const marks: string[] = [];
    const marker: AgentPlayMarker = {
      started: async () => void marks.push("started"),
      stopped: async () => void marks.push("stopped"),
    };
    const stand = editor([savingCatalogue(), look(), json(200, { success: true, result: { results: [] } })]);
    const { call, close } = await connect(async () => ({ root, game: root }), stand.deps, marker);
    await call(EditorTool.RunCommand, {
      command: "batch",
      parameters: { operations: [{ command: "editor_stop", params: {} }] },
    });
    assert.deepEqual(marks, ["stopped"]);
    await close();
  });

  it("refuses a tool it does not have", async () => {
    const { call, seen, close } = await openEditor([]);
    const answer = await call("delete_everything");
    assert.equal(answer.isError, true);
    assert.match(textOf(answer), /Unknown tool delete_everything/);
    assert.deepEqual(seen, []);
    await close();
  });
});
