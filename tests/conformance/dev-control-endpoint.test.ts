import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readdir, stat } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { controlEndpoint, listenControl, removeControlEndpoint } from "../../src/main/dev/control-endpoint.ts";
import { request } from "../../scripts/studio-dev/client.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** A launch's pipe: Windows' pipe namespace, then a fresh random name. */
const LAUNCH_PIPE = /^\\\\\.\\pipe\\ags-[0-9a-f]{32}$/;
/** Windows has no Unix modes: `chmod` there only sets the read-only flag. */
const MODES_APPLY = process.platform !== StudioPlatform.Windows;

test("a Windows launch listens on a fresh named pipe and makes nothing on disk; elsewhere on a private socket", async () => {
  const tempRoot = await tmpDir("ctl-");
  const [a, b] = [
    await controlEndpoint(StudioPlatform.Windows, tempRoot),
    await controlEndpoint(StudioPlatform.Windows, tempRoot),
  ];
  for (const pipe of [a, b]) {
    assert.match(pipe.socket, LAUNCH_PIPE);
    assert.equal(pipe.dir, null, "no folder to remove");
  }
  assert.notEqual(a.socket, b.socket, "each launch has a pipe of its own");
  assert.deepEqual(await readdir(tempRoot), [], "a pipe needs no temporary folder");
  for (const platform of [StudioPlatform.Mac, StudioPlatform.Linux]) {
    const socket = await controlEndpoint(platform, tempRoot);
    assert.ok(socket.dir, platform);
    assert.equal(path.dirname(socket.socket), socket.dir, platform);
    assert.equal(path.dirname(socket.dir), tempRoot, platform);
    if (MODES_APPLY) assert.equal((await stat(socket.dir)).mode & 0o777, 0o700, platform);
    await removeControlEndpoint(socket);
  }
});

test("a temporary folder too deep for a socket path is refused before anything is made; a pipe has no path limit", async () => {
  const tempRoot = await tmpDir("ctl-");
  const deep = path.join(tempRoot, "d".repeat(120));
  const rows = [
    { platform: StudioPlatform.Mac, refused: true },
    { platform: StudioPlatform.Linux, refused: true },
    { platform: StudioPlatform.Windows, refused: false },
  ];
  for (const row of rows) {
    const opened = controlEndpoint(row.platform, deep);
    if (row.refused) await assert.rejects(opened, /temporary IPC path too long/, row.platform);
    else assert.match((await opened).socket, LAUNCH_PIPE, row.platform);
    assert.deepEqual(await readdir(tempRoot), [], `${row.platform}: nothing made`);
  }
});

test("the studio-dev client reaches a launch's control through its endpoint here, and nothing is left after it", async (t) => {
  const endpoint = await controlEndpoint();
  const server = createServer((client) =>
    client.once("data", (line) => {
      const { requestId } = JSON.parse(line.toString());
      client.end(`${JSON.stringify({ version: 1, requestId, ok: true, value: { pid: 7 } })}\n`);
    }),
  );
  t.after(async () => {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeControlEndpoint(endpoint);
  });
  await listenControl(server, endpoint);
  if (MODES_APPLY) assert.equal((await stat(endpoint.socket)).mode & 0o777, 0o600, "owner-only socket");
  const descriptor = { instanceId: "00000000-0000-4000-8000-000000000001", capability: "0".repeat(64), ...endpoint };
  assert.deepEqual(await request(descriptor, { method: "status", params: {} }), { pid: 7 });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await removeControlEndpoint(endpoint);
  if (endpoint.dir) await assert.rejects(access(endpoint.dir), { code: "ENOENT" });
});
