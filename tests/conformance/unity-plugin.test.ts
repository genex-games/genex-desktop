import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import path from "node:path";
import { test } from "node:test";
import { activate, unityTool } from "../../src/plugins/unity/backend.ts";
import type { PluginContext, PluginHostCall } from "../../src/plugin-sdk/index.d.ts";
import { tmpDir } from "../helpers/tmp.ts";

interface WireRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

/** A real bounded loopback transport with synthetic Editor responses, never native Unity evidence. */
async function editorFixture(label: string) {
  const root = await tmpDir(`unity-plugin-${label}-`);
  for (const folder of ["Assets", "Packages", "ProjectSettings", "Library/Genex"])
    await mkdir(path.join(root, folder), { recursive: true });
  await writeFile(path.join(root, "ProjectSettings/ProjectVersion.txt"), "m_EditorVersion: 6000.5.5f1\n");
  await writeFile(path.join(root, "Packages/manifest.json"), '{"dependencies":{}}');
  const requests: WireRequest[] = [],
    sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let line = "";
    socket.on("data", (bytes) => {
      line += bytes.toString("utf8");
      if (!line.includes("\n")) return;
      const request = JSON.parse(line) as WireRequest;
      requests.push(request);
      let result: unknown = { sourceRoot: root };
      if (request.method === "job.start") result = { id: "accepted-job", kind: request.params.kind, state: "queued" };
      if (request.method === "job.status") result = { id: request.params.id, state: "running" };
      if (request.method === "capture.camera") result = { base64: "Zml4dHVyZQ==", width: 64, height: 64 };
      socket.end(`${JSON.stringify({ id: request.id, projectId: label, ok: true, result })}\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await writeFile(
    path.join(root, "Library/Genex/bridge.json"),
    JSON.stringify({
      protocol: 1,
      host: "127.0.0.1",
      port: address.port,
      token: "a".repeat(64),
      projectRoot: root,
      projectId: label,
      pid: process.pid,
      unityVersion: "6000.5.5f1",
    }),
  );
  return {
    root,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function pluginHost(projectRoot: string) {
  const records = new Map<string, unknown>();
  const calls: string[] = [];
  const host = (async (method: string, args?: { id?: string; value?: unknown }) => {
    calls.push(method);
    if (method === "settings.read") return { "project-path": projectRoot };
    if (method === "jobs.read") return records.get(String(args?.id));
    if (method === "jobs.write") {
      assert.match(String(args?.id), /^[a-zA-Z0-9_-]{1,100}$/);
      records.set(String(args?.id), args?.value);
      return true;
    }
    throw new Error(`Unexpected host operation: ${method}`);
  }) as PluginHostCall;
  const context = (directory?: string): PluginContext => ({
    directory,
    project: "fixture-game",
    signal: new AbortController().signal,
    callId: 1,
    host,
  });
  return { host, context, calls, records };
}

test("Unity activation is side-effect-free and unconfigured status explains setup", async () => {
  const fixture = pluginHost("");
  const plugin = await activate({ call: fixture.host });
  assert.equal(fixture.calls.length, 0);
  assert.ok(plugin.action);
  const status = (await plugin.action("status", {}, fixture.context())) as { ready: boolean; code: string };
  assert.equal(status.ready, false);
  assert.equal(status.code, "not_configured");
});

test("the approved create-project action creates source and installs its Editor bridge without launching Unity", async () => {
  const parent = await tmpDir("unity-plugin-created-"),
    root = path.join(parent, "Game");
  const fixture = pluginHost(""),
    plugin = await activate({ call: fixture.host });
  assert.ok(plugin.action);
  const result = (await plugin.action("create-project", { path: root, version: "6000.5.5f1" }, fixture.context())) as {
    created: boolean;
    installed: boolean;
    projectRoot: string;
  };
  assert.equal(result.created, true);
  assert.equal(result.installed, true);
  assert.equal(result.projectRoot, await realpath(root));
  const manifest = JSON.parse(await readFile(path.join(root, "Packages/manifest.json"), "utf8"));
  assert.equal(manifest.dependencies["com.genex.unity-bridge"], "file:com.genex.unity-bridge");
  assert.equal(fixture.calls.length, 0);
});

test("a Unity game uses its own directory while a linked project uses the explicit setting", async () => {
  const linked = await editorFixture("linked"),
    game = await editorFixture("game");
  try {
    const fixture = pluginHost(linked.root);
    const own = (await unityTool("status", {}, fixture.context(game.root))) as { projectRoot: string };
    assert.equal(own.projectRoot, await realpath(game.root));
    const unrelated = await tmpDir("unity-unrelated-game-");
    const fallback = (await unityTool("status", {}, fixture.context(unrelated))) as { projectRoot: string };
    assert.equal(fallback.projectRoot, await realpath(linked.root));
    assert.equal(game.requests.length, 1);
    assert.equal(linked.requests.length, 1);
  } finally {
    await game.close();
    await linked.close();
  }
});

test("disconnect consent is kept per project and reconnect clears only that project's flag", async () => {
  const first = await editorFixture("first"),
    second = await editorFixture("second");
  try {
    const fixture = pluginHost(second.root),
      plugin = await activate({ call: fixture.host });
    assert.ok(plugin.action);
    await plugin.action("disconnect", {}, fixture.context(first.root));
    assert.equal(((await unityTool("status", {}, fixture.context(first.root))) as { ready: boolean }).ready, false);
    assert.equal(first.requests.length, 0);
    assert.equal(((await unityTool("status", {}, fixture.context(second.root))) as { ready: boolean }).ready, true);
    await plugin.action("connect", {}, fixture.context(first.root));
    assert.equal(((await unityTool("status", {}, fixture.context(first.root))) as { ready: boolean }).ready, true);
    assert.equal(fixture.records.size, 1);
  } finally {
    await first.close();
    await second.close();
  }
});

test("confirmation injection and a later destructive batch command are refused before any TCP mutation", async () => {
  const editor = await editorFixture("consent");
  try {
    const context = pluginHost(editor.root).context();
    await assert.rejects(
      () => unityTool("object", { operation: "create", params: '{"name":"Keep","confirmed":true}' }, context),
      /confirmation/,
    );
    await assert.rejects(
      () => unityTool("change", { operation: "object-delete", params: '{"id":"saved-id","confirmed":true}' }, context),
      /confirmation/,
    );
    await assert.rejects(() =>
      unityTool(
        "batch",
        {
          params: JSON.stringify({
            commands: [
              { method: "object.create", params: { name: "Must not be created" } },
              { method: "object.delete", params: { id: "saved-id" } },
            ],
          }),
        },
        context,
      ),
    );
    await assert.rejects(
      () => unityTool("scene", { operation: "open", params: '{"path":"Assets/Main.unity","additive":false}' }, context),
      /confirmed/,
    );
    await assert.rejects(
      () => unityTool("scene", { operation: "build-scenes", params: '{"scenes":[]}' }, context),
      /confirmed/,
    );
    assert.equal(editor.requests.length, 0);
  } finally {
    await editor.close();
  }
});

test("declared confirmed operations add authorization and ordinary writes never carry it", async () => {
  const editor = await editorFixture("routing");
  try {
    const context = pluginHost(editor.root).context();
    await unityTool("change", { operation: "object-delete", params: '{"id":"saved-id"}' }, context);
    await unityTool("build", { params: '{"target":"StandaloneWindows64"}' }, context);
    await unityTool(
      "script",
      { operation: "write", params: '{"path":"Assets/Player.cs","text":"// fixture"}' },
      context,
    );
    assert.deepEqual(
      editor.requests.map((request) => [request.method, request.params.confirmed]),
      [
        ["object.delete", true],
        ["job.start", true],
        ["script.write", undefined],
      ],
    );
    assert.equal(editor.requests[1].params.kind, "build");
  } finally {
    await editor.close();
  }
});

test("accepted tests are polled by the same ID and captures become public SDK images", async () => {
  const editor = await editorFixture("jobs");
  try {
    const context = pluginHost(editor.root).context();
    const accepted = (await unityTool("test", { params: '{"mode":"EditMode"}' }, context)) as {
      id: string;
      state: string;
    };
    assert.equal(accepted.state, "queued");
    for (let index = 0; index < 2; index++)
      await unityTool("jobs", { operation: "status", params: JSON.stringify({ id: accepted.id }) }, context);
    const capture = (await unityTool("capture", { operation: "camera", params: '{"id":"camera-id"}' }, context)) as {
      images: unknown[];
    };
    assert.deepEqual(capture.images, [{ label: "Unity capture", mimeType: "image/png", data: "Zml4dHVyZQ==" }]);
    assert.deepEqual(
      editor.requests.map((request) => request.method),
      ["job.start", "job.status", "job.status", "capture.camera"],
    );
    assert.ok(editor.requests.slice(1, 3).every((request) => request.params.id === accepted.id));
    assert.equal(JSON.stringify(capture).includes("a".repeat(64)), false);
  } finally {
    await editor.close();
  }
});

test("panel inspection actions use read-only scene and native Assets operations", async () => {
  const editor = await editorFixture("panel");
  try {
    const fixture = pluginHost(editor.root),
      plugin = await activate({ call: fixture.host });
    assert.ok(plugin.action);
    await plugin.action("build-scenes", {}, fixture.context());
    await plugin.action("assets", { query: "t:Prefab", limit: 50 }, fixture.context());
    await plugin.action("inspect-asset", { path: "Assets/Tower.prefab" }, fixture.context());
    assert.deepEqual(
      editor.requests.map((request) => request.method),
      ["scene.build-scenes", "asset.search", "asset.inspect"],
    );
    await assert.rejects(() => plugin.action!("build-scenes", { scenes: [] }, fixture.context()), /confirmed/);
    assert.equal(editor.requests.length, 3);
  } finally {
    await editor.close();
  }
});
