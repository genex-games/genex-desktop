import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { mkdir, writeFile, rename, symlink } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { tmpDir } from "../helpers/tmp.ts";
import { bridgeRequest, inspectUnityProject, readBridgeEndpoint } from "../../src/plugins/unity/bridge-client.ts";

async function fixture() {
  const root = await tmpDir("genex-unity-bridge-");
  await mkdir(path.join(root, "ProjectSettings"));
  await mkdir(path.join(root, "Assets"));
  await mkdir(path.join(root, "Packages"));
  await mkdir(path.join(root, "Library", "Genex"), { recursive: true });
  await writeFile(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.5.5f1\n");
  await writeFile(path.join(root, "Packages", "manifest.json"), '{"dependencies":{}}');
  return root;
}

async function endpoint(root: string, port: number, extra: Record<string, unknown> = {}) {
  await writeFile(
    path.join(root, "Library", "Genex", "bridge.json"),
    JSON.stringify({
      protocol: 1,
      host: "127.0.0.1",
      port,
      token: "a".repeat(64),
      projectRoot: root,
      projectId: "fixture-project",
      pid: process.pid,
      unityVersion: "6000.5.5f1",
      ...extra,
    }),
  );
}

test("Unity discovery refuses a linked ancestor even when its target remains inside this project", async () => {
  const root = await fixture();
  await endpoint(root, 12345);
  const original = path.join(root, "Library", "Genex");
  const target = path.join(root, "Assets", "DiscoveryFixture");
  await rename(original, target);
  await symlink(target, original, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => readBridgeEndpoint(root), /linked|inside|discovery|project/i);
});

test("JSON escaped tokens are redacted from successful replies and error codes after parsing", async () => {
  const root = await fixture();
  const token = "a".repeat(64),
    escaped = "\\u0061".repeat(64);
  let failed = false;
  const server = createServer((socket) =>
    socket.once("data", (bytes) => {
      const request = JSON.parse(bytes.toString("utf8"));
      const content = failed ? { error: { code: token, message: token } } : { result: { nested: [token] } };
      const reply = JSON.stringify({ id: request.id, projectId: "fixture-project", ok: !failed, ...content });
      socket.end(`${reply.replaceAll(token, escaped)}\n`);
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await endpoint(root, address.port);
    assert.deepEqual(await bridgeRequest(root, "editor.status"), { nested: ["[redacted]"] });
    failed = true;
    await assert.rejects(
      () => bridgeRequest(root, "editor.status"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(token), false);
        assert.equal(JSON.stringify(error).includes(token), false);
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Unity discovery validates the project and refuses hostile endpoints without making a request", async () => {
  const root = await fixture();
  assert.equal((await inspectUnityProject(root)).version, "6000.5.5f1");
  for (const extra of [
    { host: "example.com" },
    { host: "::1" },
    { port: 0 },
    { port: 65536 },
    { protocol: 2 },
    { token: "short" },
    { projectRoot: path.dirname(root) },
    { projectId: "" },
    { pid: -1 },
  ]) {
    await endpoint(root, 12345, extra);
    await assert.rejects(() => readBridgeEndpoint(root));
  }
});

test("Unity transport binds replies to project and request, handles fragmented UTF-8, and never leaks its token", async () => {
  const root = await fixture();
  let request: Record<string, unknown> | undefined;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", (data) => {
      request = JSON.parse(data.toString());
      const reply = Buffer.from(
        JSON.stringify({ id: request?.id, projectId: "fixture-project", ok: true, result: { name: "Башня" } }) + "\n",
      );
      socket.write(reply.subarray(0, reply.length - 3));
      socket.end(reply.subarray(reply.length - 3));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await endpoint(root, address.port);
    assert.deepEqual(await bridgeRequest(root, "editor.status", {}), { name: "Башня" });
    assert.equal(request?.token, "a".repeat(64));
    assert.equal(request?.method, "editor.status");
    assert.equal(JSON.stringify(await readBridgeEndpoint(root)).includes("a".repeat(64)), false);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a lost mutation reply is reported as uncertain and is never replayed", async () => {
  const root = await fixture();
  let calls = 0;
  const server = createServer((socket) =>
    socket.once("data", () => {
      calls++;
      socket.destroy();
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await endpoint(root, address.port);
    await assert.rejects(() => bridgeRequest(root, "object.create", { name: "Tower" }), /unknown|uncertain|may have/i);
    assert.equal(calls, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("cancellation closes a bounded request without resending it", async () => {
  const root = await fixture();
  let connected: (() => void) | undefined;
  const accepted = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", () => connected?.());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await endpoint(root, address.port);
    const controller = new AbortController();
    const pending = bridgeRequest(root, "editor.status", {}, { signal: controller.signal });
    await accepted;
    controller.abort();
    await assert.rejects(() => pending, /stopped|abort/i);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("an untrusted Unity error cannot expose the bridge token through either its code or message", async () => {
  const root = await fixture();
  const token = "a".repeat(64);
  const server = createServer((socket) =>
    socket.once("data", (bytes) => {
      const request = JSON.parse(bytes.toString("utf8"));
      socket.end(
        `${JSON.stringify({
          id: request.id,
          projectId: "fixture-project",
          ok: false,
          error: { code: token, message: `failed with ${token}` },
        })}\n`,
      );
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await endpoint(root, address.port);
    await assert.rejects(
      () => bridgeRequest(root, "editor.status"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(token), false);
        assert.equal(JSON.stringify(error).includes(token), false, "enumerable error code is also redacted");
        return true;
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
