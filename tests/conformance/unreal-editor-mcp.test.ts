import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { recordStarting } from "../../src/plugins/unreal/editor-launch.ts";
import {
  crashIn,
  type EditorLog,
  editorLogPath,
  PortBlockedError,
  userHome,
} from "../../src/plugins/unreal/editor-log.ts";
import {
  type CrashWatcher,
  callProjectTool,
  EditorTool,
  createEditorMcp,
  liftImages,
  logCrashWatcher,
  type StartWait,
} from "../../src/plugins/unreal/editor-mcp.ts";
import { editorEndpoint } from "../../src/plugins/unreal/editor-port.ts";
import { EditorStart, editorStart } from "../../src/plugins/unreal/editor-status.ts";
import { decodePng, encodePng } from "../../src/plugins/unreal/tone.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ENDPOINT = "http://127.0.0.1:8000/mcp";
/** The set-up project the bridge finds in storage, unless a test names others. */
const DRIFT = { project: "/Games/Drift/Drift.uproject", name: "Drift", port: 8000 };
const PNG = Buffer.from("\x89PNG\r\n\x1a\nfake-pixels").toString("base64");

type Seen = { url: string; method?: string; body: any; session: string | null; redirect?: RequestRedirect };

/** An answer the stand-in editor gives as a failed tool call. */
class Refusal {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** A tool result the way Epic's toolsets answer: the value as JSON text, or a failed call. */
const toolResult = (value: unknown) =>
  value instanceof Refusal
    ? { isError: true, content: [{ type: "text", text: value.text }] }
    : { content: [{ type: "text", text: JSON.stringify(value) }] };

/** An answer a crashed editor never gives: the request stays open until the bridge lets it go. */
function never(signal?: AbortSignal | null): Promise<never> {
  return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
}

/**
 * A stand-in for the editor's Unreal MCP: sessions per `initialize`, a stale session refused with
 * 404 (as after an editor restart), and `call_tool` answering the way Epic's toolsets do — one text
 * part holding `{"returnValue": …}` with any picture inline as `{mimeType, data}`.
 */
/** The Genex editor helper's tool that names the project the editor has open. */
const PROJECT_FILE = "project_file";
const isIdentity = (body: any) => body?.params?.arguments?.tool_name === PROJECT_FILE;

/** Marks a stand-in editor's answer as a JSON-RPC error it sends back, in place of a tool result. */
const RPC_ERROR = Symbol("json-rpc error");

/** A JSON-RPC error the stand-in editor answers a call with (its code is the server's own). */
const rpcError = (code: number, message: string) => ({ [RPC_ERROR]: { code, message } });

/** The JSON-RPC error an answer stands for, if it is one. */
const rpcErrorOf = (value: unknown) =>
  value && typeof value === "object" && RPC_ERROR in value ? (value as ReturnType<typeof rpcError>)[RPC_ERROR] : null;

function editor(
  answer: (params: any, signal?: AbortSignal | null) => unknown = () => ({ returnValue: null }),
  project: string = DRIFT.project,
) {
  const seen: Seen[] = [];
  const live = new Set<string>();
  let sessions = 0;
  let mode: "up" | "closed" | "held" | "redirect" | "impostor" | "no-tools" | "named" = "up";
  /**
   * A closed editor refuses the connection; a held port (a crashed editor's) takes it and never
   * answers; a redirecting one points elsewhere; an impostor is another app's web server on the
   * port; "no-tools" is an MCP server that is not Unreal's, and "named" another app's MCP server
   * that names itself where Epic's leaves the name empty.
   */
  const unreachable = (signal?: AbortSignal | null) => {
    if (mode === "closed") throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    if (mode === "held") return never(signal);
    if (mode === "impostor") return new Response("<html>another app</html>", { status: 200 });
    return new Response("", { status: 307, headers: { Location: "http://untrusted.invalid/" } });
  };
  const stale = (session: string | null) => !session || !live.has(session);
  const end = (session: string | null) => {
    if (session) live.delete(session);
    return new Response(null, { status: 200 });
  };
  const initialize = (body: any) => {
    const id = `s${++sessions}`;
    live.add(id);
    // UE 5.8.3 never fills serverInfo, so Epic's name is empty; its tools capability is what tells.
    const result = {
      protocolVersion: body.params.protocolVersion,
      capabilities: mode === "no-tools" ? { resources: {} } : { resources: {}, tools: { listChanged: true } },
      serverInfo:
        mode === "named" ? { name: "some-other-mcp-app", version: "1.0.0" } : { name: "", title: "", version: "" },
    };
    return Response.json({ jsonrpc: "2.0", id: body.id, result }, { headers: { "mcp-session-id": id } });
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const session = new Headers(init?.headers).get("mcp-session-id");
    seen.push({ url: String(input), method: init?.method, body, session, redirect: init?.redirect });
    if (mode !== "up" && mode !== "no-tools" && mode !== "named") return unreachable(init?.signal);
    if (init?.method === "GET") return new Response("", { status: 405 });
    if (init?.method === "DELETE") return end(session);
    if (body?.method === "initialize") return initialize(body);
    if (stale(session)) return new Response("Session not found", { status: 404 });
    if (body?.id === undefined) return new Response(null, { status: 202 });
    // The helper names the project this editor has open; Epic answers a str tool as its returnValue.
    const value = isIdentity(body) ? { returnValue: project } : await answer(body.params, init?.signal);
    const error = rpcErrorOf(value);
    if (error) return Response.json({ jsonrpc: "2.0", id: body.id, error });
    return Response.json({ jsonrpc: "2.0", id: body.id, result: toolResult(value) });
  };
  return {
    seen,
    fetchImpl,
    restart: () => live.clear(),
    set: (next: typeof mode) => {
      mode = next;
    },
  };
}

/** One stand-in editor per port; a port with none refuses the connection. */
function byPort(editors: Record<number, ReturnType<typeof editor>>): typeof fetch {
  return async (input, init) => {
    const target = editors[Number(new URL(String(input)).port)];
    if (!target) throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    return target.fetchImpl(input, init);
  };
}

type Project = { project: string; name: string; port: number };
type Found = { chosen?: { project: string; name: string; port?: number }; setUp: Project[] };

/** How often the tests' bridges read an editor log for a crash; the real bridge reads it every second. */
const POLL_MS = 10;
/** A home with no Unreal logs, so a bridge never reads this computer's own. */
const quietHome = tmpDir("studio-unreal-quiet-");

/**
 * The bridge over `found`; a plain list means its first project is the one chosen in the panel.
 * Its editors' logs are `watch`'s, or none; Genex's starts of them are `starts`', or none.
 */
async function connected(
  fetchImpl: typeof fetch,
  found: Found | Project[] = [DRIFT],
  watch?: CrashWatcher,
  starts?: StartWait,
  platform?: NodeJS.Platform,
) {
  const projects = Array.isArray(found) ? { chosen: found[0], setUp: found } : found;
  const logs = watch ?? logCrashWatcher(await quietHome, "darwin", POLL_MS);
  const bridge = createEditorMcp(async () => projects, fetchImpl, logs, starts, undefined, platform);
  const [local, hosted] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "studio-test", version: "1" });
  await bridge.server.connect(hosted);
  await client.connect(local);
  return {
    client,
    close: async () => {
      await client.close();
      await bridge.close();
    },
  };
}

const textOf = (result: any) => result.content.find((part: any) => part.type === "text")?.text as string;

test("the editor bridge lists Epic's meta-tools before the editor is open", async () => {
  const unreal = editor();
  unreal.set("closed");
  const { client, close } = await connected(unreal.fetchImpl);
  try {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      Object.values(EditorTool),
    );
    assert.equal(unreal.seen.length, 0, "listing never needs the editor");
  } finally {
    await close();
  }
});

test("the editor bridge forwards a call and hands the agent Epic's inline picture as an image", async () => {
  const unreal = editor(() => ({ returnValue: { mimeType: "image/png", data: PNG } }));
  const { client, close } = await connected(unreal.fetchImpl);
  try {
    const args = { toolset_name: "EditorToolset.EditorAppToolset", tool_name: "CaptureEditorImage", arguments: {} };
    const result: any = await client.callTool({ name: EditorTool.CallTool, arguments: args });
    assert.equal(result.isError, undefined);
    assert.deepEqual(
      result.content.filter((part: any) => part.type === "image"),
      [{ type: "image", mimeType: "image/png", data: PNG }],
    );
    assert.doesNotMatch(textOf(result), new RegExp(PNG.slice(0, 12)));
    const call = unreal.seen.find((s) => s.body?.method === "tools/call" && !isIdentity(s.body));
    assert.deepEqual(call?.body.params, { name: EditorTool.CallTool, arguments: args });
    for (const request of unreal.seen) {
      assert.equal(request.url, ENDPOINT);
      assert.equal(request.redirect, "error");
    }
  } finally {
    await close();
  }
});

test("every call opens its own editor session, so a restarted editor answers the next call", async () => {
  const unreal = editor((params) => ({ returnValue: params.arguments.tool_name }));
  const { client, close } = await connected(unreal.fetchImpl);
  try {
    const call = (tool: string) =>
      client.callTool({ name: EditorTool.CallTool, arguments: { tool_name: tool, arguments: {} } });
    assert.match(textOf(await call("IsPIERunning")), /IsPIERunning/);
    unreal.restart();
    assert.match(textOf(await call("StartPIE")), /StartPIE/);
    const initializes = unreal.seen.filter((s) => s.body?.method === "initialize").length;
    assert.equal(initializes, 2);
    assert.equal(toolCalls(unreal).length, 2, "nothing was sent twice");
  } finally {
    await close();
  }
});

test("a closed or redirecting editor fails the call with how to open it, sending nothing elsewhere", async () => {
  for (const mode of ["closed", "redirect"] as const) {
    const unreal = editor();
    unreal.set(mode);
    const { client, close } = await connected(unreal.fetchImpl);
    try {
      const result: any = await client.callTool({ name: EditorTool.ListToolsets, arguments: {} });
      assert.equal(result.isError, true, mode);
      assert.match(textOf(result), /127\.0\.0\.1:8000/);
      assert.match(textOf(result), /Unreal MCP/);
      assert.ok(unreal.seen.every((s) => s.url === ENDPOINT));
      assert.ok(!unreal.seen.some((s) => s.body?.method === "tools/call"));
      assert.equal(toolCalls(unreal).length, 0);
    } finally {
      await close();
    }
  }
});

/** The calls forwarded to an editor, without the bridge's own check of which project it has open. */
const toolCalls = (unreal: ReturnType<typeof editor>) =>
  unreal.seen.filter((s) => s.body?.method === "tools/call" && !isIdentity(s.body));
const initializes = (unreal: ReturnType<typeof editor>) =>
  unreal.seen.filter((s) => s.body?.method === "initialize").length;
const ALPHA = { project: "/Games/Alpha/Alpha.uproject", name: "Alpha", port: 18_101 };
const BETA = { project: "/Games/Beta/Beta.uproject", name: "Beta", port: 18_102 };
const MINE = { project: "/Games/Mine/Mine.uproject", name: "Mine" };
const SET_LABEL = {
  name: EditorTool.CallTool,
  arguments: { toolset_name: "editor_toolset.toolsets.actor.ActorTools", tool_name: "set_label", arguments: {} },
};
const LIST_TOOLSETS = { name: EditorTool.ListToolsets, arguments: {} };

test("the bridge reaches the chosen project's editor with no extra round-trips, and names it", async () => {
  const alpha = editor(() => ({ returnValue: "alpha" }), ALPHA.project);
  const beta = editor(() => ({ returnValue: "beta" }), BETA.project);
  const { client, close } = await connected(byPort({ [ALPHA.port]: alpha, [BETA.port]: beta }), [ALPHA, BETA]);
  try {
    const result: any = await client.callTool({ name: EditorTool.ListToolsets, arguments: {} });
    assert.equal(result.isError, undefined);
    assert.match(textOf(result), /alpha/);
    assert.ok(result.content.some((part: any) => part.type === "text" && /Alpha/.test(part.text)));
    assert.equal(initializes(alpha), 1, "one session, opened by the call itself");
    assert.deepEqual(beta.seen, [], "another set-up project is never asked while the chosen one answers");
  } finally {
    await close();
  }
});

test("with no project chosen, the bridge uses the set-up project that answers", async () => {
  const alpha = editor(() => ({ returnValue: "alpha" }), ALPHA.project);
  alpha.set("closed");
  const beta = editor(() => ({ returnValue: "beta" }), BETA.project);
  const { client, close } = await connected(byPort({ [ALPHA.port]: alpha, [BETA.port]: beta }), {
    setUp: [ALPHA, BETA],
  });
  try {
    const result: any = await client.callTool({ name: EditorTool.ListToolsets, arguments: {} });
    assert.equal(result.isError, undefined);
    assert.match(textOf(result), /beta/);
    assert.ok(result.content.some((part: any) => part.type === "text" && /Beta/.test(part.text)));
    assert.equal(toolCalls(alpha).length, 0);
    assert.equal(toolCalls(beta).length, 1, "nothing was sent twice");
  } finally {
    await close();
  }
});

for (const tool of [SET_LABEL, LIST_TOOLSETS])
  test(`with a chosen project closed, ${tool.name} never reaches another open project, and says which is open`, async () => {
    const alpha = editor(() => ({ returnValue: "alpha" }), ALPHA.project);
    alpha.set("closed");
    const beta = editor(() => ({ returnValue: "beta" }), BETA.project);
    const { client, close } = await connected(byPort({ [ALPHA.port]: alpha, [BETA.port]: beta }), {
      chosen: ALPHA,
      setUp: [ALPHA, BETA],
    });
    try {
      const result: any = await client.callTool(tool);
      assert.equal(result.isError, true);
      assert.equal(toolCalls(beta).length, 0, "the open project gets nothing");
      assert.match(textOf(result), /Alpha/, "names the chosen project");
      assert.match(textOf(result), /Beta is open/, "names the project that is open instead");
      assert.match(textOf(result), /Unreal button/);
    } finally {
      await close();
    }
  });

test("a chosen project that isn't set up gets the set-up message, and no editor gets a call", async () => {
  for (const betaMode of ["closed", "up"] as const) {
    const alpha = editor(() => ({ returnValue: "alpha" }), ALPHA.project);
    alpha.set("closed");
    const beta = editor(() => ({ returnValue: "beta" }), BETA.project);
    beta.set(betaMode);
    const { client, close } = await connected(byPort({ [ALPHA.port]: alpha, [BETA.port]: beta }), {
      chosen: MINE,
      setUp: [ALPHA, BETA],
    });
    try {
      for (const tool of [LIST_TOOLSETS, SET_LABEL]) {
        const result: any = await client.callTool(tool);
        assert.equal(result.isError, true, betaMode);
        assert.match(textOf(result), /Mine/);
        assert.match(textOf(result), /set up/i);
        assert.match(textOf(result), /Unreal button/);
        assert.doesNotMatch(textOf(result), /Alpha/);
      }
      assert.deepEqual([toolCalls(alpha).length, toolCalls(beta).length], [0, 0], betaMode);
      assert.deepEqual([alpha.seen, beta.seen], [[], []], "no editor is even asked");
    } finally {
      await close();
    }
  }
});

test("another project's editor on the chosen project's port gets no call", async () => {
  // Alpha is chosen; the editor answering on Alpha's port has Beta open.
  const impostor = editor(() => ({ returnValue: "beta" }), BETA.project);
  const { client, close } = await connected(byPort({ [ALPHA.port]: impostor }), { chosen: ALPHA, setUp: [ALPHA] });
  try {
    for (const tool of [LIST_TOOLSETS, SET_LABEL]) {
      const result: any = await client.callTool(tool);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /Alpha/);
      assert.match(textOf(result), /Unreal button/);
    }
    assert.equal(toolCalls(impostor).length, 0, "only the check of which project is open reached it");
  } finally {
    await close();
  }
});

test("another app on a project's port is never taken for Unreal", async () => {
  for (const mode of ["impostor", "no-tools", "named"] as const) {
    const alpha = editor();
    alpha.set(mode);
    const beta = editor();
    beta.set(mode);
    const { client, close } = await connected(byPort({ [ALPHA.port]: alpha, [BETA.port]: beta }), [ALPHA, BETA]);
    try {
      const result: any = await client.callTool({ name: EditorTool.ListToolsets, arguments: {} });
      assert.equal(result.isError, true, mode);
      assert.match(textOf(result), /Alpha/, "the message names the chosen project");
      assert.match(textOf(result), /Unreal button/, "and where the user opens it");
      assert.deepEqual([toolCalls(alpha).length, toolCalls(beta).length], [0, 0], mode);
    } finally {
      await close();
    }
  }
});

test("with no project set up, the bridge says so and names the Unreal button, asking nothing", async () => {
  const unreal = editor();
  const { client, close } = await connected(unreal.fetchImpl, []);
  try {
    const result: any = await client.callTool({ name: EditorTool.ListToolsets, arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /set up/i);
    assert.match(textOf(result), /Unreal button/);
    assert.deepEqual(unreal.seen, []);
  } finally {
    await close();
  }
});

test("an unknown tool is refused without reaching the editor", async () => {
  const unreal = editor();
  const { client, close } = await connected(unreal.fetchImpl);
  try {
    const result: any = await client.callTool({ name: "run_python", arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(unreal.seen.length, 0);
  } finally {
    await close();
  }
});

const SETTINGS = "/Script/UnrealEd.Default__EditorPerformanceSettings";
const OBJECT_TOOLS = "editor_toolset.toolsets.object.ObjectTools";
const PLAY_TOOLSET = "EditorToolset.EditorAppToolset";

/**
 * The stand-in editor with Unreal's "Use Less CPU when in Background" setting, read and written the
 * way Epic's ObjectTools do it: `get_properties` answers a JSON string, `set_properties` takes one.
 */
function throttledEditor(
  options: {
    throttle?: boolean;
    /** Whether the editor ray-traces (`r.RayTracing`); off unless a test says so. */
    rayTracing?: boolean;
    refuse?: string[];
    project?: string;
    /** The editor's crash on `tool`, if this call crashes it. */
    crash?: (tool: string, signal?: AbortSignal | null) => Promise<never> | undefined;
  } = {},
) {
  const settings = { throttle: options.throttle ?? true };
  const unreal = editor((params, signal) => {
    const { tool_name: tool, arguments: args } = params.arguments;
    const crashed = options.crash?.(tool, signal);
    if (crashed) return crashed;
    if (options.refuse?.includes(tool)) return new Refusal(`${tool} failed`);
    if (tool === "get_properties")
      return { returnValue: JSON.stringify({ bThrottleCPUWhenNotForeground: settings.throttle }) };
    if (tool === "set_properties") {
      settings.throttle = JSON.parse(args.values).bThrottleCPUWhenNotForeground;
      return { returnValue: true };
    }
    if (tool === "SearchCVars")
      return { returnValue: JSON.stringify({ "r.RayTracing": { help: "", value: options.rayTracing ? 1 : 0 } }) };
    return { returnValue: null };
  }, options.project);
  const calls = () => toolCalls(unreal).map((s) => s.body.params.arguments.tool_name);
  return { ...unreal, settings, calls };
}

/** A forwarded call to `tool_name`, in the play toolset unless another (or `null`, none) is given. */
const play = (tool_name: string, toolset_name: string | null = PLAY_TOOLSET) => ({
  name: EditorTool.CallTool,
  arguments: { ...(toolset_name === null ? {} : { toolset_name }), tool_name, arguments: {} },
});

test("a play test runs at full speed behind Genex, and the user's setting comes back after it", async () => {
  const unreal = throttledEditor();
  const { client, close } = await connected(unreal.fetchImpl);
  try {
    await client.callTool(play("StartPIE"));
    assert.deepEqual(unreal.calls(), ["get_properties", "SearchCVars", "set_properties", "StartPIE"]);
    assert.equal(unreal.settings.throttle, false, "a background editor would otherwise play at 3 frames/s");
    const lift = unreal.seen.find((s) => s.body?.params?.arguments?.tool_name === "set_properties");
    assert.deepEqual(lift?.body.params.arguments, {
      toolset_name: OBJECT_TOOLS,
      tool_name: "set_properties",
      arguments: { instance: SETTINGS, values: JSON.stringify({ bThrottleCPUWhenNotForeground: false }) },
    });

    await client.callTool(play("CaptureEditorImage"));
    await client.callTool(play("StopPIE"));
    assert.deepEqual(unreal.calls().slice(4), ["CaptureEditorImage", "StopPIE", "set_properties"]);
    assert.equal(unreal.settings.throttle, true);

    await client.callTool(play("StopPIE"));
    assert.deepEqual(unreal.calls().slice(7), ["StopPIE"], "nothing left to put back");
  } finally {
    await close();
  }
});

test("a user who already turned background throttling off keeps it off", async () => {
  const unreal = throttledEditor({ throttle: false });
  const { client, close } = await connected(unreal.fetchImpl);
  try {
    await client.callTool(play("StartPIE"));
    await client.callTool(play("StopPIE"));
    assert.deepEqual(unreal.calls(), ["get_properties", "StartPIE", "StopPIE"]);
    assert.equal(unreal.settings.throttle, false);
  } finally {
    await close();
  }
});

test("a play start that fails, or the bridge closing mid-test, puts the user's setting back", async () => {
  const failed = throttledEditor({ refuse: ["StartPIE"] });
  const first = await connected(failed.fetchImpl);
  try {
    const result: any = await first.client.callTool(play("StartPIE"));
    assert.equal(result.isError, true);
    assert.deepEqual(failed.calls(), ["get_properties", "SearchCVars", "set_properties", "StartPIE", "set_properties"]);
    assert.equal(failed.settings.throttle, true);
  } finally {
    await first.close();
  }

  const abandoned = throttledEditor();
  const second = await connected(abandoned.fetchImpl);
  await second.client.callTool(play("StartPIE"));
  assert.equal(abandoned.settings.throttle, false);
  await second.close();
  assert.equal(abandoned.settings.throttle, true);
  assert.equal(abandoned.calls().at(-1), "set_properties");
});

// UE 5.8 on a Mac hangs the GPU rendering a ray-traced level at full speed behind another app.
test("on a Mac, the agent's play of a ray-traced editor keeps the user's throttle; elsewhere it is lifted", async () => {
  for (const [platform, lifted] of [
    ["darwin", false],
    ["win32", true],
  ] as const) {
    const unreal = throttledEditor({ rayTracing: true });
    const { client, close } = await connected(unreal.fetchImpl, [DRIFT], undefined, undefined, platform);
    try {
      await client.callTool(play("StartPIE"));
      assert.equal(unreal.settings.throttle, !lifted, platform);
      assert.equal(unreal.calls().at(-1), "StartPIE", `${platform}: the play still starts`);
    } finally {
      await close();
    }
  }
});

test("the throttle setting goes back only to the editor it was taken from", async () => {
  const alpha = throttledEditor({ project: ALPHA.project });
  const beta = throttledEditor({ project: BETA.project });
  // With nothing chosen, a call can move to another answering editor between StartPIE and StopPIE.
  const bridge = await connected(byPort({ [ALPHA.port]: alpha, [BETA.port]: beta }), { setUp: [ALPHA, BETA] });
  await bridge.client.callTool(play("StartPIE"));
  assert.deepEqual([alpha.settings.throttle, beta.settings.throttle], [false, true]);
  alpha.set("closed");
  await bridge.client.callTool(play("StopPIE"));
  assert.deepEqual(beta.calls(), ["StopPIE"], "Beta's own setting is never written");
  alpha.set("up");
  await bridge.close();
  assert.deepEqual([alpha.settings.throttle, beta.settings.throttle], [true, true]);
});

test("a setting the editor can't read or write never blocks play, and is never written back", async () => {
  for (const refuse of [["get_properties"], ["set_properties"]]) {
    const unreal = throttledEditor({ refuse });
    const { client, close } = await connected(unreal.fetchImpl);
    try {
      const started: any = await client.callTool(play("StartPIE"));
      assert.equal(started.isError, undefined, refuse[0]);
      await client.callTool(play("StopPIE"));
      assert.deepEqual(unreal.calls().slice(-2), ["StartPIE", "StopPIE"], refuse[0]);
      assert.equal(unreal.settings.throttle, true, refuse[0]);
    } finally {
      await close();
    }
  }
});

test("a play start is recognised however Unreal would resolve its name", async () => {
  const cases: Array<[string, string | null, boolean]> = [
    ["StartPIE", PLAY_TOOLSET, true],
    ["startpie", PLAY_TOOLSET.toLowerCase(), true],
    [`${PLAY_TOOLSET}.StartPIE`, null, true],
    ["StartPIE", null, false],
    ["StartPIE", "SomeOther.Toolset", false],
    ["StartPIEExtra", PLAY_TOOLSET, false],
  ];
  for (const [tool, toolset, lifts] of cases) {
    const unreal = throttledEditor();
    const { client, close } = await connected(unreal.fetchImpl);
    try {
      await client.callTool(play(tool, toolset));
      assert.equal(unreal.settings.throttle, !lifts, `${toolset} ${tool}`);
    } finally {
      await close();
    }
  }
});

const SECOND = 1000;
/** A crash answered within this is fast: without the watch the call waits out its five minutes. */
const CRASH_ANSWER_MS = 2 * SECOND;
const LINKS = process.platform === "win32" && "links need privileges on Windows";

/** Unreal's log for `project` as the editor starts it: a byte-order mark, the open line, the command line. */
const unrealLog = (project: string) =>
  [
    "﻿Log file open, 01/01/26 12:00:00",
    `LogCsvProfiler: Display: Metadata set : commandline="" ${project}""`,
    "[2026.01.01-12.00.01:001][  0]LogLoad: (Engine Initialization) Total time: 44.12 seconds",
    "",
  ].join("\n");

const SOURCE = "[File:./Editor/LevelEditor/Private/SLevelViewport.cpp] [Line: 5196]";
/** What UE 5.8.3 wrote when StopPIE crashed it on a Mac. */
const CRASH = [
  `[2026.01.01-12.00.44:628][262]LogMac: Error: appError called: Assertion failed: GameViewport.IsUnique() ${SOURCE} `,
  "[2026.01.01-12.00.44:629][262]LogMac: Error: === Critical error: ===",
  "LogMac: Error: ",
  `LogMac: Error: Assertion failed: GameViewport.IsUnique() ${SOURCE} `,
  "LogMac: Error: [Callstack] 0x0000000123456789 UnrealEditor-LevelEditor.dylib!SLevelViewport::EndPlayInEditorSession() []",
  "",
].join("\n");
const CRASHED =
  "Unreal crashed while this call ran (Assertion failed: GameViewport.IsUnique()), so whether it took effect is unknown. Ask the user to reopen it from the Unreal button; once it answers, look before you repeat the call.";

/** `project`'s editor log (none when `text` is null) in a home of its own, and a watch of it. */
async function projectLog(project: Project = DRIFT, text: string | null = unrealLog(project.project)) {
  const home = await tmpDir("studio-unreal-crash-");
  const directory = path.posix.dirname(project.project);
  const file = editorLogPath({ file: project.project, directory }, home, "darwin");
  await mkdir(path.dirname(file), { recursive: true });
  if (text !== null) await writeFile(file, text);
  return { home, file, watch: logCrashWatcher(home, "darwin", POLL_MS), crash: () => appendFile(file, CRASH) };
}

/**
 * An editor that crashes on `tool` (every tool when none is named): the crash goes into `log`, and
 * the editor's port is then `after` ("held" while the crashed editor keeps it, "closed" once gone).
 */
function crashingEditor(
  log: { crash: () => Promise<void> },
  options: { tool?: string; after?: "held" | "closed"; project?: string } = {},
) {
  const unreal = editor((params, signal) => {
    if (options.tool && params.arguments?.tool_name !== options.tool) return { returnValue: "played" };
    unreal.set(options.after ?? "held");
    return log.crash().then(() => never(signal));
  }, options.project);
  return unreal;
}

/** The timers this process has running. */
const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;

test("an editor that crashes during a call answers within seconds, with Unreal's own assert", {
  timeout: 20 * SECOND,
}, async () => {
  const log = await projectLog();
  const unreal = crashingEditor(log, { tool: "StopPIE" });
  const { client, close } = await connected(unreal.fetchImpl, [DRIFT], log.watch);
  try {
    const started = performance.now();
    const result: any = await client.callTool(play("StopPIE"));
    assert.ok(performance.now() - started < CRASH_ANSWER_MS, "not the call's own five-minute wait");
    assert.equal(result.isError, true, "a tool failure, never a protocol error");
    assert.equal(textOf(result), CRASHED);
    assert.equal(toolCalls(unreal).length, 1, "nothing was sent twice");
    assert.ok(!unreal.seen.some((s) => s.method === "DELETE"), "a crashed editor is not asked to end the session");
  } finally {
    await close();
  }
});

test("a call Unreal crashed under answers that its outcome is unknown", { timeout: 20 * SECOND }, async () => {
  const log = await projectLog();
  const unreal = crashingEditor(log, { tool: "StopPIE" });
  const { client, close } = await connected(unreal.fetchImpl, [DRIFT], log.watch);
  try {
    const result: any = await client.callTool(play("StopPIE"));
    assert.equal(result._meta?.["genex/outcome"], "unknown", "the host records it as outcome unknown");
    assert.doesNotMatch(textOf(result), /then retry/);
    assert.match(textOf(result), /look before you repeat/);
    const refused: any = await client.callTool({ name: "run_python", arguments: {} });
    assert.equal(refused.isError, true);
    assert.equal(refused._meta?.["genex/outcome"], undefined, "a call that never reached the editor is not marked");
  } finally {
    await close();
  }
});

test("a call whose connection to the editor broke answers that its outcome is unknown", async () => {
  const unreal = editor(async () => {
    throw new Error("socket closed");
  });
  const { client, close } = await connected(unreal.fetchImpl);
  try {
    const result: any = await client.callTool(play("StopPIE"));
    assert.equal(result.isError, true);
    assert.equal(result._meta?.["genex/outcome"], "unknown", "the host records it as outcome unknown");
    assert.match(textOf(result), /look before you repeat/i);
    assert.doesNotMatch(textOf(result), /then retry/);
  } finally {
    await close();
  }
});

test("a call the editor answered with a JSON-RPC error is the editor's own answer, never that Unreal went away", async () => {
  for (const [label, code] of [
    ["invalid params", -32602],
    ["internal error", -32603],
  ] as const) {
    const unreal = editor(() => rpcError(code, `Epic's server says: ${label}`));
    const { client, close } = await connected(unreal.fetchImpl);
    try {
      const result: any = await client.callTool(play("StopPIE"));
      assert.equal(result.isError, true, label);
      assert.equal(result._meta?.["genex/outcome"], undefined, `${label}: the editor answered, so it is still there`);
      assert.match(textOf(result), /did not complete the call/, label);
      assert.match(textOf(result), new RegExp(label), label);
    } finally {
      await close();
    }
  }
});

test("a call whose answer fails in Genex's own handling after the editor answered is never marked", async () => {
  const { captures, project } = await captureProject();
  const file = path.join(captures, "shot-GX_Shot_Hall.png");
  const unreal = editor(async () => {
    await writeFile(file, frame());
    return { returnValue: JSON.stringify({ queued: true, file, camera: "GX_Shot_Hall", width: 160, height: 90 }) };
  }, project.project);
  // The capture's settle wait is Genex's own, after the editor answered.
  const broken: StartWait = {
    check: async () => EditorStart.NotStarting,
    now: () => 0,
    sleep: async () => {
      throw new Error("the wait broke");
    },
  };
  const { client, close } = await connected(unreal.fetchImpl, [project], undefined, broken);
  try {
    const result: any = await client.callTool(
      captureCall("capture_shot", { camera: "Hall", width: 160, height: 90, delay_s: 2 }),
    );
    assert.equal(result.isError, true);
    assert.match(textOf(result), /did not complete the call: the wait broke/);
    assert.equal(result._meta?.["genex/outcome"], undefined, "the editor answered and is still there");
    assert.equal(toolCalls(unreal).length, 1, "the call reached the editor once");
  } finally {
    await close();
  }
});

test("a call the editor has not answered in time says its outcome is unknown, but never that Unreal went away", async () => {
  const unreal = editor((_params, signal) => never(signal));
  // The call's time is all but spent waiting for the editor to start: 50 ms of it are left.
  let reads = 0;
  const starts: StartWait = {
    check: async () => EditorStart.NotStarting,
    now: () => (reads++ === 0 ? 0 : 5 * 60_000 - 50),
    sleep: async () => {},
  };
  const { client, close } = await connected(unreal.fetchImpl, [DRIFT], undefined, starts);
  try {
    const result: any = await client.callTool(play("StopPIE"));
    assert.equal(result.isError, true);
    assert.match(textOf(result), /whether it took effect is unknown/);
    assert.equal(result._meta?.["genex/outcome"], undefined, "a slow editor is still there: not app-lost");
  } finally {
    await close();
  }
});

test("a crash already in the log before the call started is not this call's", async () => {
  const log = await projectLog(DRIFT, unrealLog(DRIFT.project) + CRASH);
  const unreal = editor(async () => {
    await sleep(5 * POLL_MS);
    return { returnValue: "played" };
  });
  const { client, close } = await connected(unreal.fetchImpl, [DRIFT], log.watch);
  try {
    const result: any = await client.callTool(play("StopPIE"));
    assert.equal(result.isError, undefined);
    assert.match(textOf(result), /played/);
  } finally {
    await close();
  }
});

/** Every file and link under `dir` with its bytes: a no-side-effect witness. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const key = path.relative(dir, full).split(path.sep).join("/");
    if (entry.isSymbolicLink()) out[key] = "link";
    else if (entry.isFile()) out[key] = await readFile(full, "utf8");
  }
  return out;
}

/** Logs the bridge must not read a crash from; each arrangement returns where the crash then gets written. */
const unreadLogs: Array<{
  name: string;
  links?: boolean;
  arrange: (log: Awaited<ReturnType<typeof projectLog>>) => Promise<string | undefined>;
}> = [
  { name: "no log at all", arrange: async () => undefined },
  {
    name: "a log that links to a crashing log",
    links: true,
    arrange: async (log) => {
      const other = path.join(log.home, "other.log");
      await writeFile(other, unrealLog(DRIFT.project));
      await symlink(other, log.file);
      return other;
    },
  },
  {
    name: "a folder where the log should be",
    arrange: async (log) => {
      await mkdir(log.file);
      return undefined;
    },
  },
  {
    name: "the log of another project with the same name",
    arrange: async (log) => {
      await writeFile(log.file, unrealLog("/Games/Elsewhere/Drift.uproject"));
      return log.file;
    },
  },
];
for (const row of unreadLogs)
  test(`with ${row.name}, the call goes through as before and nothing is written`, {
    skip: row.links ? LINKS : false,
  }, async () => {
    const log = await projectLog(DRIFT, null);
    const target = await row.arrange(log);
    const unreal = editor(async () => {
      if (target) await appendFile(target, CRASH);
      await sleep(5 * POLL_MS);
      return { returnValue: "played" };
    });
    const witness = await tree(log.home);
    const { client, close } = await connected(unreal.fetchImpl, [DRIFT], log.watch);
    try {
      const result: any = await client.callTool(play("StopPIE"));
      assert.equal(result.isError, undefined);
      assert.match(textOf(result), /played/);
    } finally {
      await close();
    }
    const written = target ? path.relative(log.home, target).split(path.sep).join("/") : undefined;
    const expected = written ? { ...witness, [written]: witness[written] + CRASH } : witness;
    assert.deepEqual(await tree(log.home), expected);
  });

test("every call's watch of the log ends with the call, leaving no timer behind", {
  timeout: 20 * SECOND,
}, async () => {
  const log = await projectLog();
  const unreal = editor((params, signal) => {
    const tool = params.arguments?.tool_name;
    if (tool === "Refused") return new Refusal("Refused failed");
    if (tool === "Dropped") throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    if (tool !== "Crash") return { returnValue: tool };
    return log.crash().then(() => never(signal));
  });
  let started = 0;
  let running = 0;
  const counted: CrashWatcher = async (project) => {
    const watch = await log.watch(project);
    started++;
    running++;
    return {
      crashed: watch.crashed,
      stop: async () => {
        await watch.stop();
        running--;
      },
    };
  };
  const { client, close } = await connected(unreal.fetchImpl, [DRIFT], counted);
  try {
    const before = timers();
    for (const tool of ["Answered", "Refused", "Dropped", "Crash"]) {
      await client.callTool(play(tool, null));
      assert.equal(running, 0, tool);
      assert.equal(timers(), before, `${tool}: no timer left running`);
    }
    assert.equal(started, 4, "every call was watched");
  } finally {
    await close();
  }
});

for (const after of ["closed", "held"] as const)
  test(`after a crash, the next call for the chosen project reaches no other editor (port ${after})`, {
    timeout: 30 * SECOND,
  }, async () => {
    const log = await projectLog(ALPHA);
    const alpha = crashingEditor(log, { after, project: ALPHA.project });
    const beta = editor(() => ({ returnValue: "beta" }), BETA.project);
    const { client, close } = await connected(
      byPort({ [ALPHA.port]: alpha, [BETA.port]: beta }),
      { chosen: ALPHA, setUp: [ALPHA, BETA] },
      log.watch,
    );
    try {
      assert.equal(textOf(await client.callTool(SET_LABEL)), CRASHED);
      const next: any = await client.callTool(SET_LABEL);
      assert.equal(next.isError, true);
      assert.match(textOf(next), /open Alpha/, "the chosen project is the one to reopen");
      assert.match(textOf(next), /Unreal button/);
      assert.equal(toolCalls(beta).length, 0, "the open project gets nothing");
      assert.equal(toolCalls(alpha).length, 1, "nothing was sent twice");
    } finally {
      await close();
    }
  });

test("a crashed editor is owed nothing back: reopened, its next play test runs at full speed again", {
  timeout: 20 * SECOND,
}, async () => {
  const log = await projectLog();
  let crashes = 1;
  const unreal = throttledEditor({
    crash: (tool, signal) => {
      if (tool !== "StopPIE" || crashes-- <= 0) return undefined;
      unreal.set("held");
      return log.crash().then(() => never(signal));
    },
  });
  const { client, close } = await connected(unreal.fetchImpl, [DRIFT], log.watch);
  try {
    await client.callTool(play("StartPIE"));
    assert.equal(unreal.settings.throttle, false);
    assert.equal(textOf(await client.callTool(play("StopPIE"))), CRASHED);
    // The user reopens Drift: a new run of the editor, with the user's own setting.
    unreal.set("up");
    unreal.restart();
    unreal.settings.throttle = true;
    await client.callTool(play("StartPIE"));
    assert.equal(unreal.settings.throttle, false, "the reopened editor plays at full speed behind Genex");
  } finally {
    await close();
  }
  assert.equal(unreal.settings.throttle, true, "and gets the user's setting back");
});

const MINUTE = 60 * SECOND;
/** How often and how long a call waits for an editor Genex is starting. */
const START_POLL = 2 * SECOND;
const START_WAIT = 150 * SECOND;

/**
 * Genex's start of the chosen project's editor as `states` say it, one per check (the last one
 * repeats), on a clock only the bridge's own pauses move; `onPoll` runs after each pause.
 */
function startWait(states: EditorStart[], onPoll: (polls: number, advance: (ms: number) => void) => void = () => {}) {
  let now = 0;
  const seen = { polls: 0, checks: 0 };
  const advance = (ms: number) => {
    now += ms;
  };
  const starts: StartWait = {
    check: async () => states[Math.min(seen.checks++, states.length - 1)] ?? EditorStart.NotStarting,
    now: () => now,
    sleep: async (ms) => {
      advance(ms);
      seen.polls++;
      onPoll(seen.polls, advance);
    },
  };
  return { starts, seen, elapsed: () => now };
}

test("a call while Genex is starting the chosen project's editor waits for it, then goes through once", async () => {
  // new-game opens the game's project, and the agent may call list_toolsets seconds later.
  const alpha = editor(() => ({ returnValue: "alpha toolsets" }), ALPHA.project);
  alpha.set("closed");
  const beta = editor(() => ({ returnValue: "beta" }), BETA.project);
  const start = startWait([EditorStart.Starting], (polls) => {
    if (polls === 3) alpha.set("up");
  });
  const { client, close } = await connected(
    byPort({ [ALPHA.port]: alpha, [BETA.port]: beta }),
    { chosen: ALPHA, setUp: [ALPHA, BETA] },
    undefined,
    start.starts,
  );
  try {
    const result: any = await client.callTool(LIST_TOOLSETS);
    assert.equal(result.isError, undefined);
    assert.match(textOf(result), /alpha toolsets/);
    assert.equal(start.elapsed(), 3 * START_POLL, "asked again every two seconds until it answered");
    assert.equal(toolCalls(alpha).length, 1, "sent once, once it answered");
    assert.equal(toolCalls(beta).length, 0, "another open project gets nothing while the chosen one starts");
  } finally {
    await close();
  }
});

test("a call whose editor is still starting after the wait says so, and to call again", async () => {
  const unreal = editor();
  unreal.set("closed");
  const start = startWait([EditorStart.Starting]);
  const { client, close } = await connected(unreal.fetchImpl, [DRIFT], undefined, start.starts);
  try {
    const result: any = await client.callTool(LIST_TOOLSETS);
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Unreal is still starting Drift/);
    assert.match(textOf(result), /call again in a minute/i);
    assert.doesNotMatch(textOf(result), /Ask the user|open Drift/, "Genex is opening it: the user has nothing to do");
    assert.equal(start.elapsed(), START_WAIT, "its bound, inside the host's limit for a bridge call");
    assert.equal(toolCalls(unreal).length, 0);
  } finally {
    await close();
  }
});

test("a call whose editor nothing is starting fails at once with how to open it", async () => {
  const unreal = editor();
  unreal.set("closed");
  const start = startWait([EditorStart.NotStarting]);
  const { client, close } = await connected(unreal.fetchImpl, [DRIFT], undefined, start.starts);
  try {
    const result: any = await client.callTool(LIST_TOOLSETS);
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Ask the user to open Drift in Unreal from the Unreal button/);
    assert.equal(start.seen.polls, 0, "no wait");
  } finally {
    await close();
  }
});

test("an editor that stops starting without answering gets a few seconds more, then how to open it", async () => {
  const unreal = editor();
  unreal.set("closed");
  const start = startWait([EditorStart.Starting, EditorStart.NotStarting]);
  const { client, close } = await connected(unreal.fetchImpl, [DRIFT], undefined, start.starts);
  try {
    const result: any = await client.callTool(LIST_TOOLSETS);
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Ask the user to open Drift in Unreal from the Unreal button/);
    assert.ok(start.elapsed() > START_POLL, "Epic's server answers about a second after the editor says it loaded");
    assert.ok(start.elapsed() <= 15 * SECOND, `not the whole wait (${start.elapsed()} ms)`);
  } finally {
    await close();
  }
});

for (const [when, states] of [
  ["before the wait", [EditorStart.PortBlocked]],
  ["during the wait", [EditorStart.Starting, EditorStart.Starting, EditorStart.PortBlocked]],
] as const)
  test(`an editor whose log says its port is blocked gets that message ${when}`, async () => {
    const unreal = editor();
    unreal.set("closed");
    const start = startWait([...states]);
    const { client, close } = await connected(unreal.fetchImpl, [DRIFT], undefined, start.starts);
    try {
      const result: any = await client.callTool(LIST_TOOLSETS);
      assert.equal(result.isError, true);
      assert.equal(textOf(result), new PortBlockedError(DRIFT.port).message);
      assert.equal(start.seen.polls, states.length - 1, "the wait ends at once");
    } finally {
      await close();
    }
  });

test("a call that waited for its editor has only the rest of its five minutes", {
  timeout: 20 * SECOND,
}, async () => {
  const unreal = editor((_params, signal) => never(signal));
  unreal.set("closed");
  // The clock reads nearly five minutes by the time the editor answers.
  const start = startWait([EditorStart.Starting], (_polls, advance) => {
    unreal.set("up");
    advance(5 * MINUTE - START_POLL - 100);
  });
  const { client, close } = await connected(unreal.fetchImpl, [DRIFT], undefined, start.starts);
  try {
    const began = performance.now();
    const result: any = await client.callTool(LIST_TOOLSETS);
    assert.equal(result.isError, true);
    assert.match(textOf(result), /timed out/i);
    assert.ok(performance.now() - began < 5 * SECOND, "not five more minutes, past the host's limit for the call");
  } finally {
    await close();
  }
});

/** When the editor-start rows below are read. */
const NOW = Date.UTC(2026, 9, 5, 3, 0, 0);
const editorLog = (fields: Partial<EditorLog>): EditorLog => ({
  open: true,
  openedAt: NOW - MINUTE,
  mtime: NOW - 2 * SECOND,
  mcpStarted: false,
  loaded: false,
  ...fields,
});
const startRows: Array<{
  name: string;
  record?: { project: string; at: number };
  running: boolean;
  log?: EditorLog;
  start: EditorStart;
}> = [
  { name: "nothing recorded and no editor runs", running: false, start: EditorStart.NotStarting },
  {
    name: "Genex opened it 5 s ago, before its editor is listed",
    record: { project: ALPHA.project, at: NOW - 5 * SECOND },
    running: false,
    start: EditorStart.Starting,
  },
  {
    name: "Genex opened it 3 min ago and an editor runs",
    record: { project: ALPHA.project, at: NOW - 3 * MINUTE },
    running: true,
    start: EditorStart.Starting,
  },
  {
    name: "Genex opened it 3 min ago and no editor runs",
    record: { project: ALPHA.project, at: NOW - 3 * MINUTE },
    running: false,
    start: EditorStart.NotStarting,
  },
  {
    name: "Genex opened another project",
    record: { project: BETA.project, at: NOW - 5 * SECOND },
    running: true,
    start: EditorStart.NotStarting,
  },
  {
    name: "it was opened outside Genex and its own log is loading",
    running: true,
    log: editorLog({}),
    start: EditorStart.Starting,
  },
  {
    name: "its own log says it loaded",
    record: { project: ALPHA.project, at: NOW - 3 * MINUTE },
    running: true,
    log: editorLog({ loaded: true }),
    start: EditorStart.NotStarting,
  },
  {
    name: "its own open log says Epic's server couldn't listen on its port",
    record: { project: ALPHA.project, at: NOW - 5 * SECOND },
    running: true,
    log: editorLog({ portBlocked: true }),
    start: EditorStart.PortBlocked,
  },
  {
    name: "a closed log said the port was blocked",
    running: true,
    log: editorLog({ open: false, portBlocked: true }),
    start: EditorStart.NotStarting,
  },
];
for (const row of startRows)
  test(`an unanswering editor's start, as the toolbar's Starting reads it: ${row.name}`, async () => {
    const storage = await tmpDir("studio-unreal-start-");
    if (row.record) await recordStarting(storage, row.record);
    const asked: Array<{ file: string; port?: number }> = [];
    const env = {
      editorRunning: async () => row.running,
      editorLog: async (project: { file: string; directory: string; port?: number }) => {
        asked.push({ file: project.file, port: project.port });
        return row.log;
      },
    };
    assert.equal(await editorStart(env, storage, ALPHA, NOW), row.start);
    const read = row.running ? [{ file: ALPHA.project, port: ALPHA.port }] : [];
    assert.deepEqual(asked, read, "its own log, for its own port, only while an editor runs");
  });

test("the bridge reads Unreal's logs in the account's own home, not the HOME Studio starts it with", async () => {
  // Studio starts a plugin's MCP server with HOME inside the plugin's storage.
  const saved = process.env.HOME;
  process.env.HOME = await tmpDir("studio-unreal-plugin-home-");
  try {
    assert.notEqual(userHome(), process.env.HOME);
    assert.equal(userHome(), os.userInfo().homedir);
  } finally {
    if (saved === undefined) Reflect.deleteProperty(process.env, "HOME");
    else process.env.HOME = saved;
  }
});

test("Unreal's crash lines give its own text for what failed; other lines are no crash", () => {
  const crashes: Array<[string[], string | undefined]> = [
    [CRASH.split("\n"), "Assertion failed: GameViewport.IsUnique()"],
    [
      [
        "[2026.01.01-12.00.44:629][262]LogWindows: Error: === Critical error: ===",
        "LogWindows: Error: ",
        "LogWindows: Error: Unhandled Exception: EXCEPTION_ACCESS_VIOLATION reading address 0x0000000000000000",
        "LogWindows: Error: [Callstack] 0x00007ffd12345678 UnrealEditor-Engine.dll!UWorld::Tick() []",
      ],
      "Unhandled Exception: EXCEPTION_ACCESS_VIOLATION reading address 0x0000000000000000",
    ],
    [["[2026.01.01-12.00.44:629][262]LogMac: Error: === Critical error: ===", "Fatal error!", ""], "Fatal error"],
    [["[2026.01.01-12.00.44:629][262]LogMac: Error: === Critical error: ==="], undefined],
  ];
  for (const [lines, detail] of crashes) assert.deepEqual(crashIn(lines), { detail }, lines[0]);
  const quiet = [
    "[2026.01.01-12.00.44:629][262]LogOutputDevice: Error: === Handled ensure: ===",
    "[2026.01.01-12.00.44:629][262]LogBlueprintUserMessages: [BP_Car_C_0] appError called: from a game",
    "[2026.01.01-12.00.44:629][262]LogTemp: Warning: Critical error in my game",
    "LogTemp: Display: === Critical error: === is how Unreal opens a crash report",
    "",
  ];
  assert.equal(crashIn(quiet), undefined);
});

test("the editor endpoint is 127.0.0.1 on a plain user port, and nothing else", () => {
  assert.equal(editorEndpoint("8000").href, ENDPOINT);
  assert.equal(editorEndpoint("65535").href, "http://127.0.0.1:65535/mcp");
  const hostile = [
    undefined,
    "",
    " 8000",
    "8000 ",
    "08000",
    "80",
    "1023",
    "65536",
    "-8000",
    "8000.5",
    "1e4",
    "0x1f40",
    "8000/evil",
    "8000@untrusted.invalid",
    "8000#",
    "untrusted.invalid:8000",
  ];
  for (const port of hostile) assert.throws(() => editorEndpoint(port), /port/i, String(port));
});

test("Epic's inline pictures become images; every other part stays as it was", () => {
  const plain = [{ type: "text", text: "not json {" }];
  assert.deepEqual(liftImages(plain), plain);
  const noImage = [{ type: "text", text: JSON.stringify({ returnValue: { mimeType: "text/plain", data: "x" } }) }];
  assert.deepEqual(liftImages(noImage), noImage);
  const empty = [{ type: "text", text: JSON.stringify({ returnValue: { mimeType: "image/png", data: "" } }) }];
  assert.deepEqual(liftImages(empty), empty);
  const other = { type: "image", mimeType: "image/jpeg", data: PNG };
  assert.deepEqual(liftImages([other]), [other]);

  const capture = { returnValue: { image: { mimeType: "image/png", data: PNG }, cameraFOV: 90 } };
  const [text, image] = liftImages([{ type: "text", text: JSON.stringify(capture) }]);
  assert.deepEqual(image, { type: "image", mimeType: "image/png", data: PNG });
  const kept = JSON.parse(String(text?.text));
  assert.equal(kept.returnValue.cameraFOV, 90);
  assert.equal(kept.returnValue.image.mimeType, "image/png");
  assert.notEqual(kept.returnValue.image.data, PNG);

  const many = { returnValue: Array.from({ length: 6 }, () => ({ mimeType: "image/png", data: PNG })) };
  const lifted = liftImages([{ type: "text", text: JSON.stringify(many) }]);
  assert.equal(lifted.filter((part) => part.type === "image").length, 4, "at most four pictures per answer");
  assert.doesNotMatch(JSON.stringify(lifted[0]), new RegExp(PNG.slice(0, 12)), "the rest leave the text too");
});

test("the bundled Unreal manifest runs one bridge per game from the plugin's storage, with no port to set", async () => {
  const manifest = validateManifest(
    JSON.parse(await readFile(new URL("../../src/plugins/unreal/plugin.json", import.meta.url), "utf8")),
  );
  const [server] = manifest.mcpServers ?? [];
  assert.equal(server?.id, "editor");
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["editor-mcp.mjs"]);
  assert.equal(server.cwd, "storage:project", "one bridge per game, reading its link and the ports in storage");
  assert.equal(server.env, undefined, "each project has its own port, so the bridge needs no setting");
  assert.deepEqual(manifest.settings, [], "no port for the user to pick");
  assert.deepEqual(manifest.capabilities, ["game-engine"], "it links games to their Unreal project");
});

test("a project call that names its own timeout fails once that passes, not at the bridge's five minutes", async () => {
  const stand = editor((_params, signal) => never(signal));
  const started = Date.now();
  const call = { toolset: "genex_loop.tools.GenexLoopTools", tool: "recompile_module", args: {}, timeoutMs: 50 };
  await assert.rejects(callProjectTool(DRIFT, call, stand.fetchImpl), /timed out/i);
  assert.ok(Date.now() - started < 10_000, "it ended at its own timeout");
});

test("a project call that names its own timeout keeps its whole session within it: the helper's identity call and the session's end too", async () => {
  const stand = editor();
  // An editor whose game thread got busy: the helper never names its project, and ending the session hangs.
  const busy: typeof fetch = async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (isIdentity(body) || init?.method === "DELETE") return never(init?.signal);
    return stand.fetchImpl(input, init);
  };
  const call = { toolset: "genex_loop.tools.GenexLoopTools", tool: "save_all", args: {}, timeoutMs: 100 };
  const started = Date.now();
  const outcome = await Promise.race([
    callProjectTool(DRIFT, call, busy).then(
      () => "answered",
      (error: unknown) => `refused: ${String(error)}`,
    ),
    sleep(5_000).then(() => "still waiting"),
  ]);
  assert.match(outcome, /^refused/, outcome);
  assert.ok(Date.now() - started < 5_000, "it ended within its own limit, not the bridge's five minutes");
});

/** The Genex editor helper's Loop toolset, which only Genex's own editor queue calls. */
const LOOP_TOOLSET = "genex_loop.tools.GenexLoopTools";

test("an agent's call to the Genex Loop toolset is refused however it is spelled, and nothing reaches the editor", async () => {
  const hostile: Array<[string, Record<string, unknown>]> = [
    ["by its name", { toolset_name: LOOP_TOOLSET, tool_name: "apply_part" }],
    ["in capitals", { toolset_name: LOOP_TOOLSET.toUpperCase(), tool_name: "apply_part" }],
    ["in lower case", { toolset_name: LOOP_TOOLSET.toLowerCase(), tool_name: "save_all" }],
    ["with whitespace around it", { toolset_name: `  ${LOOP_TOOLSET}\n`, tool_name: "apply_part" }],
    ["with a space inside it", { toolset_name: "genex_loop.tools. GenexLoopTools", tool_name: "apply_part" }],
    ["with a zero-width space inside it", { toolset_name: "genex_​loop.tools.GenexLoopTools", tool_name: "x" }],
    ["in full-width letters", { toolset_name: "ｇｅｎｅｘ_ｌｏｏｐ.tools.GenexLoopTools", tool_name: "apply_part" }],
    ["by its module alone", { toolset_name: "genex_loop.tools", tool_name: "apply_part" }],
    ["by its class alone", { toolset_name: "GenexLoopTools", tool_name: "apply_part" }],
    ["behind a prefix", { toolset_name: `Python.${LOOP_TOOLSET}`, tool_name: "apply_part" }],
    ["with a suffix", { toolset_name: `${LOOP_TOOLSET}.Tools`, tool_name: "apply_part" }],
    ["named in the tool, without a toolset", { tool_name: `${LOOP_TOOLSET}.apply_part` }],
    ["named in the tool, with an empty toolset", { toolset_name: "", tool_name: `${LOOP_TOOLSET}.apply_part` }],
    ["named in the tool, with a blank toolset", { toolset_name: "  ", tool_name: `${LOOP_TOOLSET}.apply_part` }],
    ["named in the tool, with a null toolset", { toolset_name: null, tool_name: `${LOOP_TOOLSET}.apply_part` }],
    ["named in the tool, in capitals", { tool_name: `${LOOP_TOOLSET}.APPLY_PART`.toUpperCase() }],
    [
      "named in the tool, behind another toolset",
      { toolset_name: PLAY_TOOLSET, tool_name: `${LOOP_TOOLSET}.save_all` },
    ],
    ["as a list", { toolset_name: [LOOP_TOOLSET], tool_name: "apply_part" }],
  ];
  const calls: Array<[string, { name: string; arguments: Record<string, unknown> }]> = [
    ...hostile.map(([label, args]): [string, { name: string; arguments: Record<string, unknown> }] => [
      label,
      { name: EditorTool.CallTool, arguments: { ...args, arguments: {} } },
    ]),
    ["described", { name: EditorTool.DescribeToolset, arguments: { toolset_name: LOOP_TOOLSET } }],
    [
      "described in capitals",
      { name: EditorTool.DescribeToolset, arguments: { toolset_name: ` ${LOOP_TOOLSET.toUpperCase()}` } },
    ],
  ];
  for (const [label, call] of calls) {
    const unreal = editor();
    const { client, close } = await connected(unreal.fetchImpl);
    try {
      const result: any = await client.callTool(call);
      assert.equal(result.isError, true, label);
      assert.match(textOf(result), /Genex's own Unreal Loop toolset/, label);
      assert.match(textOf(result), /genex_build/, `${label}: it names what to use instead`);
      assert.deepEqual(unreal.seen, [], `${label}: no request reached the editor`);
    } finally {
      await close();
    }
  }
});

test("the helper's build and play toolsets, and Genex's own queue calls to the Loop toolset, still reach the editor", async () => {
  const open: Array<[string, Record<string, unknown>]> = [
    ["the build toolset", { toolset_name: "genex_build.tools.GenexBuildTools", tool_name: "set_route" }],
    ["the play toolset", { toolset_name: "genex_play.tools.GenexPlayTools", tool_name: "probe_route" }],
    ["a tool whose arguments only mention it", { ...SET_LABEL.arguments, arguments: { label: "genex_loop notes" } }],
  ];
  for (const [label, args] of open) {
    const unreal = editor(() => ({ returnValue: { ok: true } }));
    const { client, close } = await connected(unreal.fetchImpl);
    try {
      const result: any = await client.callTool({ name: EditorTool.CallTool, arguments: { arguments: {}, ...args } });
      assert.equal(result.isError, undefined, label);
      assert.equal(toolCalls(unreal).length, 1, label);
    } finally {
      await close();
    }
  }
  const queue = editor(() => ({ returnValue: { saved: true, dirty: [], ms: 9 } }));
  const call = { toolset: LOOP_TOOLSET, tool: "save_all", args: {} };
  assert.deepEqual(await callProjectTool(DRIFT, call, queue.fetchImpl), { saved: true, dirty: [], ms: 9 });
});

/* ---- Captures: the build tools' frames reach the agent as images with their tone numbers ---- */

const BUILD_TOOLSET = "genex_build.tools.GenexBuildTools";

/** A game's Unreal project in a temporary folder, with its captures folder. */
async function captureProject() {
  const root = await tmpDir("studio-unreal-captures-");
  const folder = path.join(root, "Drift");
  const captures = path.join(folder, "Saved", "Genex", "captures");
  await mkdir(captures, { recursive: true });
  const project = { project: path.join(folder, "Drift.uproject"), name: "Drift", port: 8000 };
  await writeFile(project.project, "{}");
  return { root, captures, project };
}

/** A synthetic frame: a dark field with a bright band at `shift` px, so frames that move differ. */
function frame(shift = 0): Buffer {
  const width = 160;
  const height = 90;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const lit = (x + shift) % 40 < 12 && y > 30 ? 230 : 6;
      rgb.set([lit, lit, lit], (y * width + x) * 3);
    }
  return encodePng({ width, height, rgb });
}

/** A clock that only moves when the bridge waits, so a capture's settle and a lost frame's wait take no time. */
function stillClock(): StartWait {
  let now = 0;
  return {
    check: async () => EditorStart.NotStarting,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
}

const captureCall = (tool: string, args: Record<string, unknown>) => ({
  name: EditorTool.CallTool,
  arguments: { toolset_name: BUILD_TOOLSET, tool_name: tool, arguments: args },
});

test("a capture_shot answer reaches the agent as the image and its tone numbers", async () => {
  const { captures, project } = await captureProject();
  const file = path.join(captures, "shot-GX_Shot_Hall.png");
  const unreal = editor(async () => {
    await writeFile(file, frame());
    return { returnValue: JSON.stringify({ queued: true, file, camera: "GX_Shot_Hall", width: 160, height: 90 }) };
  }, project.project);
  const { client, close } = await connected(unreal.fetchImpl, [project], undefined, stillClock());
  try {
    const result: any = await client.callTool(
      captureCall("capture_shot", { camera: "Hall", width: 160, height: 90, delay_s: 2 }),
    );
    const images = result.content.filter((part: any) => part.type === "image");
    assert.equal(images.length, 1);
    assert.equal(images[0].mimeType, "image/png");
    assert.deepEqual(decodePng(Buffer.from(images[0].data, "base64")), decodePng(await readFile(file)));
    const text = result.content.map((part: any) => part.text ?? "").join("\n");
    assert.match(text, /black point p2 0\.0\d+/);
    assert.match(text, /contrast std/);
    assert.match(text, /far std .* near std/);
  } finally {
    await close();
  }
});

test("a capture outside the project's captures folder, through a link, or never written is never read", async () => {
  const { root, captures, project } = await captureProject();
  const outside = path.join(root, "outside.png");
  await writeFile(outside, frame(7));
  await symlink(outside, path.join(captures, "linked.png"));
  const cases = {
    "a file elsewhere": outside,
    "a link out of the captures folder": path.join(captures, "linked.png"),
    "a path climbing out": path.join(captures, "..", "..", "..", "..", "outside.png"),
    "a file that never comes": path.join(captures, "missing.png"),
    "not a path": 42,
  };
  for (const [label, file] of Object.entries(cases)) {
    const unreal = editor(() => ({ returnValue: JSON.stringify({ queued: true, file }) }), project.project);
    const { client, close } = await connected(unreal.fetchImpl, [project], undefined, stillClock());
    try {
      const result: any = await client.callTool(captureCall("capture_play", { name: "x", width: 160, height: 90 }));
      assert.deepEqual(
        result.content.filter((part: any) => part.type === "image"),
        [],
        label,
      );
      const text = result.content.map((part: any) => part.text ?? "").join("\n");
      assert.match(text, /no image/i, label);
    } finally {
      await close();
    }
  }
});

test("a character check's pictures reach the agent as one sheet with each shot's view, beside its numbers", async () => {
  const { captures, project } = await captureProject();
  const files = ["idle-front", "idle-side", "walk-0"].map((name) => path.join(captures, `character-1-${name}.png`));
  const record = path.join(captures, "character-1.json");
  const unreal = editor(async () => {
    for (const file of files) await writeFile(file, frame(0));
    const frames = [{ label: "idle front" }, { label: "idle side" }, { label: "walk 0.00 s" }];
    await writeFile(record, JSON.stringify({ frames, files }));
    const pictures = { record, files, waitS: 60 };
    return { returnValue: JSON.stringify({ passed: false, reasons: ["idle: arms out"], pictures }) };
  }, project.project);
  const { client, close } = await connected(unreal.fetchImpl, [project], undefined, stillClock());
  try {
    const call = captureCall("character_check", {
      mesh: "/Game/Cast/SK_Hero",
      idle: "",
      walk: "",
      driver: "",
      pictures: true,
    });
    const result: any = await client.callTool(call);
    const images = result.content.filter((part: any) => part.type === "image");
    assert.equal(images.length, 1, "one sheet");
    const text = result.content.map((part: any) => part.text ?? "").join("\n");
    assert.match(text, /idle: arms out/, "the numbers stay in the answer");
    assert.match(text, /shot 0: idle front/);
    assert.match(text, /shot 2: walk 0\.00 s/);
  } finally {
    await close();
  }
});

test("a character sheet whose record or shots lie outside the captures folder is never read", async () => {
  const { root, captures, project } = await captureProject();
  const outside = path.join(root, "outside.png");
  const outsideRecord = path.join(root, "outside.json");
  await writeFile(outside, frame(7));
  await writeFile(outsideRecord, JSON.stringify({ frames: [{ label: "idle front" }], files: [outside] }));
  await symlink(outsideRecord, path.join(captures, "linked.json"));
  const pointingOut = path.join(captures, "character-2.json");
  await writeFile(pointingOut, JSON.stringify({ frames: [{ label: "idle front" }], files: [outside] }));
  const cases = {
    "a record elsewhere": outsideRecord,
    "a record linked out": path.join(captures, "linked.json"),
    "a record climbing out": path.join(captures, "..", "..", "..", "..", "outside.json"),
    "a record that names shots elsewhere": pointingOut,
    "not a path": 42,
  };
  for (const [label, record] of Object.entries(cases)) {
    const pictures = { record, files: [outside], waitS: 1 };
    const unreal = editor(() => ({ returnValue: JSON.stringify({ passed: true, pictures }) }), project.project);
    const { client, close } = await connected(unreal.fetchImpl, [project], undefined, stillClock());
    try {
      const call = captureCall("character_check", { mesh: "x", idle: "", walk: "", driver: "", pictures: true });
      const result: any = await client.callTool(call);
      assert.deepEqual(
        result.content.filter((part: any) => part.type === "image"),
        [],
        label,
      );
    } finally {
      await close();
    }
  }
});

test("a character check without pictures, or one refused, gets no picture", async () => {
  const { project } = await captureProject();
  for (const answer of [{ passed: true, reasons: [] }, { error: "mesh must be a SkeletalMesh asset" }]) {
    const unreal = editor(() => ({ returnValue: JSON.stringify(answer) }), project.project);
    const { client, close } = await connected(unreal.fetchImpl, [project], undefined, stillClock());
    try {
      const call = captureCall("character_check", { mesh: "x", idle: "", walk: "", driver: "", pictures: false });
      const result: any = await client.callTool(call);
      assert.deepEqual(
        result.content.filter((part: any) => part.type === "image"),
        [],
      );
    } finally {
      await close();
    }
  }
});

test("a motion strip reaches the agent as one contact sheet with each frame's pose and how much it moved", async () => {
  const { captures, project } = await captureProject();
  const files = [0, 1, 2].map((i) => path.join(captures, `strip-1-${i}.png`));
  const poses = path.join(captures, "strip-1.json");
  const unreal = editor(async () => {
    await writeFile(files[0] ?? "", frame(0));
    await writeFile(files[1] ?? "", frame(0));
    await writeFile(files[2] ?? "", frame(17));
    const frames = [0, 1, 2].map((i) => ({
      gameSeconds: 4 + i * 0.5,
      fps: 40,
      pawn: [i < 2 ? 0 : 300, 0, 90],
      pawnYaw: 0,
      view: [i < 2 ? -400 : -100, 0, 300],
      viewYawPitch: [0, -10],
    }));
    await writeFile(poses, JSON.stringify({ frames, files, intervalS: 0.5 }));
    return { returnValue: JSON.stringify({ strip: "strip-1", files, poses, intervalS: 0.5, waitS: 30 }) };
  }, project.project);
  const { client, close } = await connected(unreal.fetchImpl, [project], undefined, stillClock());
  try {
    const result: any = await client.callTool(captureCall("motion_strip", { frames: 3, interval_s: 0.5 }));
    const images = result.content.filter((part: any) => part.type === "image");
    assert.equal(images.length, 1, "one contact sheet");
    const sheet = decodePng(Buffer.from(images[0].data, "base64"));
    assert.ok(sheet.width > sheet.height, `${sheet.width}x${sheet.height}`);
    const text = result.content.map((part: any) => part.text ?? "").join("\n");
    assert.match(text, /frame 0 .*pawn \[0, 0, 90\]/);
    assert.match(text, /frame 2 .*pawn \[300, 0, 90\].*moved 300 cm/);
    assert.match(text, /frame 1 .*same picture as the frame before/);
  } finally {
    await close();
  }
});
