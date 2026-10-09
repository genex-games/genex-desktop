/**
 * The Unreal editor's lock gives way to the person: their play, not the agent's. `editor-activity`
 * is the lock's probe: with no editor of the game running nobody is using it and nothing is unsaved;
 * a play session counts as the person's unless the agent started it through the editor connector
 * (which leaves a marker beside the game's storage while it plays) or the plugin's own queue is
 * playing a check; an editor that runs but doesn't answer can't tell. The editor, its MCP server,
 * the computer's processes and the clock are stand-ins; the marker is a real file.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { PluginContext } from "../../src/plugin-sdk/index.d.ts";
import {
  AGENT_PLAY_FILE,
  AGENT_PLAY_MAX_MS,
  agentPlayFolder,
  agentPlayMarker,
} from "../../src/plugins/unreal/agent-play.ts";
import { createEditorMcp, EditorTool } from "../../src/plugins/unreal/editor-mcp.ts";
import { LoopTool, PartRunState } from "../../src/plugins/unreal/editor-queue.ts";
import { EditorStart } from "../../src/plugins/unreal/editor-status.ts";
import {
  createLoopTools,
  LeadLoopToolName,
  LiveLoopToolName,
  LoopToolName,
} from "../../src/plugins/unreal/loop-tools.ts";
import { XcodeState } from "../../src/plugins/unreal/xcode.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { playable } from "../helpers/unreal-editor-stand-in.ts";

const GAME = "dirt-track";
const PORT = 8000;
const EDITOR_EXEC = "/Users/Shared/Epic Games/UE_5.8/Engine/Binaries/Mac/UnrealEditor.app/Contents/MacOS/UnrealEditor";
const LAUNCHD = { pid: 1, exec: "/sbin/launchd", args: "/sbin/launchd" };
const PLAY_TOOLSET = "EditorToolset.EditorAppToolset";

type Probe = { personActive: boolean; unsaved: number; pie: boolean; dirty: number };

/**
 * A game linked to its project, whose editor answers (or runs without answering, or isn't running,
 * or can't be listed); `held` holds a play-check's settle until the test lets it go.
 */
async function personWorld(
  options: {
    answering?: boolean;
    running?: boolean | null;
    held?: Promise<unknown>;
    unlinked?: boolean;
    starting?: EditorStart | null;
  } = {},
) {
  const root = await realpath(await tmpDir("studio-unreal-person-first-"));
  const storage = path.join(root, "storage");
  const project = path.join(root, "AI Games", GAME, "unreal", "DirtTrack.uproject");
  await mkdir(path.dirname(project), { recursive: true });
  await mkdir(storage, { recursive: true });
  await writeFile(project, JSON.stringify({ FileVersion: 3, EngineAssociation: "5.8" }));
  const answering = options.answering ?? true;
  const state = { answering, running: options.running === undefined ? answering : options.running, dirty: 0 };
  const held = options.held;
  const editor = playable({}, held ? { [LoopTool.Settle]: () => held.then(() => ({ watching: true })) } : {});
  const tools = createLoopTools({
    platform: "darwin",
    engine: async () => ({ version: "5.8", directory: path.join(root, "engine") }),
    project: async () => (options.unlinked ? undefined : project),
    starting: async () => options.starting ?? null,
    xcode: async () => ({ state: XcodeState.Ready }),
    editorCall: async (_storage, _game, tool, args) => {
      if (tool === LoopTool.EditorActivity)
        return {
          camera: [0, 0, 0],
          selection: [],
          dirty: Array(state.dirty).fill("/Game/X"),
          pie: editor.editor.state.pie,
        };
      return editor.editor.port.call(tool as LoopTool, args);
    },
    editorAnswers: async () => state.answering,
    restart: { editors: async () => (state.running ? 1 : 0), quit: async () => {}, open: async () => {} },
    processes: {
      home: path.join(root, "home"),
      list: async () => {
        if (state.running === null) return [];
        const own = { pid: 9100, exec: EDITOR_EXEC, args: `${EDITOR_EXEC} ${project}` };
        return [LAUNCHD, ...(state.running ? [own] : [])];
      },
      signal: () => {},
    },
    now: editor.deps.now,
    sleep: editor.deps.sleep,
  });
  const context: PluginContext = {
    project: GAME,
    directory: path.dirname(path.dirname(project)),
    signal: new AbortController().signal,
    callId: 1,
    host: (async () => storage) as never,
  };
  const call = (name: string, args: Record<string, unknown> = {}) =>
    tools.call(name as LoopToolName, args, context, storage);
  const probe = async () => (await call(LeadLoopToolName.EditorActivity)) as Probe;
  return { root, storage, project, state, editor, call, probe };
}

type World = Awaited<ReturnType<typeof personWorld>>;

/**
 * A stand-in for Epic's MCP server on the game's port: sessions per `initialize`, the Genex editor
 * helper naming the project, the background-throttle setting already off, and play started and
 * stopped as asked.
 */
function epicServer(project: string): typeof fetch {
  let sessions = 0;
  const result = (id: unknown, value: unknown) =>
    Response.json({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify({ returnValue: value }) }] },
    });
  return async (_input, init) => {
    if (init?.method === "GET") return new Response("", { status: 405 });
    if (init?.method === "DELETE") return new Response(null, { status: 200 });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (body?.method === "initialize") {
      const answer = {
        protocolVersion: body.params.protocolVersion,
        capabilities: { resources: {}, tools: { listChanged: true } },
        serverInfo: { name: "", title: "", version: "" },
      };
      sessions += 1;
      return Response.json(
        { jsonrpc: "2.0", id: body.id, result: answer },
        { headers: { "mcp-session-id": `s${sessions}` } },
      );
    }
    if (body?.id === undefined) return new Response(null, { status: 202 });
    const tool = body.params?.arguments?.tool_name;
    if (tool === "project_file") return result(body.id, project);
    if (tool === "get_properties") return result(body.id, JSON.stringify({ bThrottleCPUWhenNotForeground: false }));
    return result(body.id, true);
  };
}

/** A stand-in Epic server that refuses one tool (answers it as an error) and answers the rest as `epicServer` does. */
function refusing(project: string, refused: string): typeof fetch {
  const base = epicServer(project);
  return async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (body?.params?.arguments?.tool_name !== refused) return base(input, init);
    const content = [{ type: "text", text: `${refused} failed: no level is open.` }];
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { content, isError: true } });
  };
}

/** A crash watch over each call: quiet, or (once `crashes` says so) one that sees Unreal crash under it. */
type CrashWatchOf = () => Promise<{ crashed: Promise<{ detail: string | undefined }>; stop: () => Promise<void> }>;

/** The game's editor connector, as the host runs it for the game, with an agent at its other end. */
async function connector(w: World, over: { fetch?: typeof fetch; watchCrash?: CrashWatchOf } = {}) {
  const found = { project: w.project, name: "DirtTrack", port: PORT };
  const marker = agentPlayMarker(bridgeFolder(w), w.editor.deps.now);
  const quiet = async () => ({ crashed: new Promise<never>(() => {}), stop: async () => {} });
  const bridge = createEditorMcp(
    async () => ({ chosen: found, setUp: [found] }),
    over.fetch ?? epicServer(w.project),
    over.watchCrash ?? quiet,
    undefined,
    marker,
  );
  const [local, hosted] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "agent", version: "1" });
  await bridge.server.connect(hosted);
  await client.connect(local);
  const play = (tool_name: string) =>
    client.callTool({
      name: EditorTool.CallTool,
      arguments: { toolset_name: PLAY_TOOLSET, tool_name, arguments: {} },
    });
  return {
    play,
    close: async () => {
      await client.close();
      await bridge.close();
    },
  };
}

/** The game's own folder in the plugin's storage, where its connector runs. */
const bridgeFolder = (w: World) => agentPlayFolder(w.storage, GAME) ?? "";

/** The files beside the game's storage that tell the agent's play. */
const markers = async (w: World) =>
  readdir(bridgeFolder(w)).then(
    (names) => names.filter((name) => name === AGENT_PLAY_FILE),
    () => [],
  );

describe("the Unreal editor's lock asks the person first", () => {
  it("no editor running: nobody is using it and nothing is unsaved", async () => {
    const w = await personWorld({ answering: false, running: false });
    assert.deepEqual(await w.probe(), { personActive: false, unsaved: 0, pie: false, dirty: 0 });
  });

  it("a play the person started counts; one the agent started through the editor connector, or the plugin's own play-check, does not", async () => {
    const w = await personWorld();
    w.state.dirty = 2;
    w.editor.editor.state.pie = true;
    assert.deepEqual(await w.probe(), { personActive: true, unsaved: 2, pie: true, dirty: 2 }, "the person's play");

    const agent = await connector(w);
    try {
      await agent.play("StartPIE");
      assert.deepEqual(await markers(w), [AGENT_PLAY_FILE], "the connector marked the agent's play");
      assert.equal((await w.probe()).personActive, false, "the agent's own play");
      await agent.play("StopPIE");
      assert.deepEqual(await markers(w), [], "stopping it clears the mark");
      assert.equal((await w.probe()).personActive, true, "a play after it is the person's again");
      await agent.play("StartPIE");
    } finally {
      await agent.close();
    }
    assert.deepEqual(await markers(w), [], "the connector closing clears the mark");

    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const checked = await personWorld({ held });
    const { id } = (await checked.call(LiveLoopToolName.PlayCheck, { checks: {} })) as { id: string };
    for (let i = 0; i < 2_000; i += 1) {
      const run = (await checked.call(LoopToolName.PartResult, { id })) as { state: string };
      if (run.state === PartRunState.Playing && checked.editor.editor.state.pie) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(checked.editor.editor.state.pie, true, "the play-check is playing");
    assert.equal((await checked.probe()).personActive, false, "the plugin's own play-check");
    release();
  });

  it("a play start the editor refused leaves no mark: a play under way is the person's", async () => {
    const w = await personWorld();
    w.editor.editor.state.pie = true;
    const agent = await connector(w, { fetch: refusing(w.project, "StartPIE") });
    try {
      await agent.play("StartPIE");
      assert.deepEqual(await markers(w), [], "no mark for a start that didn't take");
      assert.equal((await w.probe()).personActive, true);
    } finally {
      await agent.close();
    }
  });

  it("Unreal crashing under the agent's call clears the mark of its play", async () => {
    const w = await personWorld();
    let crashes = false;
    const watchCrash: CrashWatchOf = async () => ({
      crashed: crashes ? Promise.resolve({ detail: "the editor quit" }) : new Promise<never>(() => {}),
      stop: async () => {},
    });
    const agent = await connector(w, { watchCrash });
    try {
      await agent.play("StartPIE");
      assert.deepEqual(await markers(w), [AGENT_PLAY_FILE], "the agent's play is marked");
      crashes = true;
      await agent.play("GetPIEState");
      assert.deepEqual(await markers(w), [], "the crash cleared the mark");
      w.editor.editor.state.pie = true;
      assert.equal((await w.probe()).personActive, true, "a play after it is the person's");
    } finally {
      await agent.close();
    }
  });

  it("the agent's play that ended any other way than its stop is forgotten once the probe sees no play", async () => {
    const w = await personWorld();
    const agent = await connector(w);
    try {
      await agent.play("StartPIE");
      w.editor.editor.state.pie = true;
      assert.equal((await w.probe()).personActive, false, "the agent's own play");
      // The person pressed Stop in Unreal (or the game ended play): no StopPIE reached the connector.
      w.editor.editor.state.pie = false;
      assert.equal((await w.probe()).pie, false);
      assert.deepEqual(await markers(w), [], "a probe that sees no play clears the mark");
      w.editor.editor.state.pie = true;
      assert.equal((await w.probe()).personActive, true, "the person's play after it is theirs");
    } finally {
      await agent.close();
    }
  });

  it("a game without an Unreal project, or whose Unreal Genex is still opening, has nobody in its editor", async () => {
    const idle = { personActive: false, unsaved: 0, pie: false, dirty: 0 };
    const unlinked = await personWorld({ answering: false, running: null, unlinked: true });
    assert.deepEqual(await unlinked.probe(), idle);
    const opening = await personWorld({ answering: false, running: true, starting: EditorStart.Starting });
    assert.deepEqual(await opening.probe(), idle, "the editor answers nobody yet, the person included");
    const notOpening = await personWorld({ answering: false, running: true, starting: EditorStart.NotStarting });
    await assert.rejects(notOpening.probe(), /isn't answering/, "a busy editor Genex isn't opening can't tell");
  });

  it("an editor that runs but doesn't answer can't tell", async () => {
    for (const running of [true, null]) {
      const w = await personWorld({ answering: false, running });
      await assert.rejects(w.probe(), /isn't answering/, String(running));
    }
  });

  it("an agent's play marker older than half an hour is not believed", async () => {
    const w = await personWorld();
    w.editor.editor.state.pie = true;
    await w.editor.deps.sleep(AGENT_PLAY_MAX_MS + 60_000);
    const folder = bridgeFolder(w);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, AGENT_PLAY_FILE), JSON.stringify({ startedAt: 0 }));
    assert.equal((await w.probe()).personActive, true, "a stale mark");
    await writeFile(
      path.join(folder, AGENT_PLAY_FILE),
      JSON.stringify({ startedAt: w.editor.deps.now() - AGENT_PLAY_MAX_MS + 60_000 }),
    );
    assert.equal((await w.probe()).personActive, false, "a fresh one");
  });

  it("believes no mark that isn't a plain, small, fresh, well-formed file in the connector's folder", async () => {
    const w = await personWorld();
    w.editor.editor.state.pie = true;
    await w.editor.deps.sleep(60_000);
    const now = w.editor.deps.now();
    const folder = bridgeFolder(w);
    const marker = path.join(folder, AGENT_PLAY_FILE);
    const elsewhere = path.join(await realpath(await tmpDir("agent-play-elsewhere-")), "fresh.json");
    const fresh = JSON.stringify({ startedAt: now });
    await writeFile(elsewhere, fresh);
    const hostile: Array<[string, () => Promise<void>]> = [
      ["a link to a fresh mark elsewhere", () => symlink(elsewhere, marker)],
      ["a folder named as the mark", () => mkdir(marker)],
      ["a mark over a kilobyte", () => writeFile(marker, JSON.stringify({ startedAt: now, pad: "x".repeat(2048) }))],
      ["a mark from the future", () => writeFile(marker, JSON.stringify({ startedAt: now + 3_600_000 }))],
      ["a stamp that is text", () => writeFile(marker, JSON.stringify({ startedAt: String(now) }))],
      ["a mark that is no JSON", () => writeFile(marker, "{startedAt:")],
    ];
    for (const [name, plant] of hostile) {
      await rm(marker, { recursive: true, force: true });
      await mkdir(folder, { recursive: true });
      await plant();
      assert.equal((await w.probe()).personActive, true, `${name}: the play is the person's`);
    }
    assert.equal(await readFile(elsewhere, "utf8"), fresh, "the file the link pointed at is untouched");
    await rm(marker, { recursive: true, force: true });
    await writeFile(marker, fresh);
    assert.equal((await w.probe()).personActive, false, "a plain fresh mark is the agent's play");
  });

  it("reads no mark for a game whose name isn't a plain folder name", () => {
    for (const game of ["../x", "a/b", "", ".."]) assert.equal(agentPlayFolder("/storage", game), null, game);
    assert.equal(agentPlayFolder("/storage", GAME), path.join("/storage", "mcp", GAME));
  });
});
