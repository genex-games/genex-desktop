import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { controlSocket, secureControlSocket } from "../../src/main/dev/transport.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";

test("developer transport selects distinct Windows pipes and retains Unix filesystem addresses", () => {
  const first = controlSocket("C:/transport", "first", StudioPlatform.Windows);
  const second = controlSocket("C:/transport", "second", StudioPlatform.Windows);
  assert.ok(first.startsWith("\\\\.\\pipe\\"));
  assert.notEqual(first, second);
  assert.equal(controlSocket("/tmp/private", "id", StudioPlatform.Mac), path.join("/tmp/private", "s"));
});

test("developer transport can listen and exchange a request on the current platform", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ags-"));
  const address = controlSocket(directory, randomUUID());
  const server = net.createServer((client) => client.once("data", (data) => client.end(data)));
  t.after(async () => {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(address, resolve);
  });
  await secureControlSocket(address);
  const response = await new Promise<string>((resolve, reject) => {
    const client = net.createConnection(address);
    client.once("error", reject);
    client.once("connect", () => client.write("request\n"));
    client.once("data", (data) => {
      client.destroy();
      resolve(data.toString());
    });
  });
  assert.equal(response, "request\n");
  if (process.platform !== StudioPlatform.Windows) assert.equal((await stat(address)).mode & 0o777, 0o600);
});
