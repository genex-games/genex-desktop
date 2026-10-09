import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Writable } from "node:stream";
import type { McpChange, McpConnector } from "../../src/shared/mcp.ts";
import { McpConnection, resolveExecutable } from "../../src/substrate/mcp/client.ts";
import { McpRegistry } from "../../src/substrate/mcp/registry.ts";
import { launchDigest, memorySecretPort } from "../../src/substrate/mcp/store.ts";
import { MCP_QUALIFIED_TOOL } from "../../src/shared/mcp.ts";
import { createHash } from "node:crypto";

const SERVER = path.resolve("tests/fixtures/mcp/echo-server.mjs");

function draft(overrides: Partial<McpConnector> = {}): McpConnector {
  return {
    id: "echo",
    name: "Echo",
    transport: "stdio",
    command: process.execPath,
    args: [SERVER],
    enabled: true,
    scope: "global",
    toolPolicy: {},
    createdAt: new Date().toISOString(),
    ...overrides,
  } as McpConnector;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-mcp-"));
  const file = path.join(root, "mcp", "connectors.json");
  const values = new Map<string, string>();
  const changes: McpChange[] = [];
  const registry = new McpRegistry({ file, secrets: memorySecretPort(values), onChange: (c) => changes.push(c) });
  await registry.init();
  return {
    root,
    file,
    values,
    changes,
    registry,
    async close() {
      await registry.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** How the fixture reports a secret it received: a fingerprint, so the host has nothing to redact. */
const fingerprint = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;

/** A clock for the idle close: timers wait until the test fires them. */
function manualTimers() {
  const timers: Array<{ run: () => void; ms: number; cancelled: boolean }> = [];
  return {
    timers,
    schedule: (run: () => void, ms: number) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    pending: () => timers.filter((t) => !t.cancelled).length,
    async fire() {
      await Promise.all(
        timers
          .splice(0)
          .filter((timer) => !timer.cancelled)
          .map((timer) => timer.run()),
      );
    },
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a real server over stdio answers text, an image and an error, and stops when the caller stops", async () => {
  const connection = new McpConnection({ connector: draft(), secrets: null });
  try {
    const tools = await connection.listTools();
    assert.deepEqual(
      tools.map((t) => t.name),
      ["echo", "picture", "fail", "sleep", "weird.name/x"],
    );
    assert.equal(connection.health, "ready");
    assert.deepEqual(tools[0]!.inputSchema.required, ["text"]);
    assert.equal(
      await connection.callTool("echo", { text: "hi", tags: ["a", "b"], count: 2, mode: "a" }),
      "hi tags=a,b count=2 mode=a",
    );
    const picture = await connection.callTool("picture", {});
    assert.notEqual(typeof picture, "string");
    assert.equal(typeof picture === "string" ? "" : picture.text, "here it is");
    assert.equal(typeof picture === "string" ? 0 : picture.images?.length, 1);
    assert.equal(typeof picture === "string" ? "" : picture.images![0]!.mimeType, "image/png");
    await assert.rejects(
      connection.callTool("fail", {}),
      /this tool refuses/,
      "isError is a failed tool call, not a result",
    );
    const stop = new AbortController();
    const started = Date.now();
    const sleeping = connection.callTool("sleep", { ms: 30_000 }, { signal: stop.signal });
    setTimeout(() => stop.abort(new Error("stop")), 150);
    await assert.rejects(sleeping);
    assert.ok(Date.now() - started < 5_000, "a cancelled call comes back promptly");
    const pid = connection.pid;
    assert.ok(pid && alive(pid));
    await connection.close();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(alive(pid!), false, "close kills the child");
    assert.equal(connection.health, "idle");
  } finally {
    await connection.close();
  }
});

test("a server that never answers initialize fails at the configured limit instead of hanging a delegation", async () => {
  const connection = new McpConnection({ connector: draft({ args: [SERVER, "--hang"] }), secrets: null });
  try {
    const started = Date.now();
    await assert.rejects(connection.connect({ timeoutMs: 600 }));
    assert.ok(Date.now() - started < 10_000, "it gave up at the limit it was given");
    assert.equal(connection.health, "failed");
    assert.ok(connection.error);
  } finally {
    await connection.close();
  }
});

test("connector tools are namespaced, sanitised and carry both the schema and its flat projection", async () => {
  const f = await fixture();
  try {
    await f.registry.save(draft(), {}, { trust: true });
    const tools = await f.registry.toolsFor("alpha");
    assert.deepEqual(
      tools.map((t) => t.name),
      ["echo__echo", "echo__picture", "echo__fail", "echo__sleep", "echo__weird_name_x"],
    );
    const echo = tools[0]!;
    assert.deepEqual(echo.inputSchema.required, ["text"], "the full schema survives");
    assert.deepEqual(Object.keys(echo.parameters.properties).sort(), ["count", "mode", "tags", "text"]);
    assert.equal(echo.parameters.properties.tags!.type, "array");
    assert.equal(echo.parameters.properties.count!.type, "integer");
    assert.equal(f.registry.owns("echo__echo"), true);
    assert.equal(f.registry.owns("example__greet"), false);
    assert.equal(f.registry.owns("not a tool"), false);
    assert.equal(await f.registry.tool("echo__echo", { text: "hello" }, { project: "alpha" }), "hello");
    assert.equal(
      await f.registry.tool("echo__weird_name_x", {}, { project: "alpha" }),
      "weird tool answered",
      "the server still sees its own name",
    );
    const guidance = f.registry.guidance(tools);
    assert.match(guidance, /CONNECTORS/);
    assert.match(guidance, /Echo: 5 tools/);
    const view = (await f.registry.list())[0]!;
    assert.equal(view.health, "ready");
    assert.equal(view.toolCount, 5);
    assert.equal(view.trusted, true);
    assert.ok(f.changes.some((c) => c.id === "echo"));
  } finally {
    await f.close();
  }
});

test("the tool policy filters the list and the call, and everything unknown fails closed", async () => {
  const f = await fixture();
  try {
    await f.registry.save(draft({ toolPolicy: { deny: ["fail"] } }), {}, { trust: true });
    assert.equal(
      (await f.registry.toolsFor("alpha")).some((t) => t.name === "echo__fail"),
      false,
    );
    await assert.rejects(
      f.registry.tool("echo__fail", {}, { project: "alpha" }),
      /Unknown connector tool/,
      "a denied tool is not merely hidden",
    );
    await f.registry.save(draft({ toolPolicy: { allow: ["echo"] } }), {}, { trust: true });
    assert.deepEqual(
      (await f.registry.toolsFor("alpha")).map((t) => t.name),
      ["echo__echo"],
    );
    await assert.rejects(f.registry.tool("echo__picture", {}, { project: "alpha" }), /Unknown connector tool/);
    await assert.rejects(f.registry.tool("nosuch__thing", {}, { project: "alpha" }), /Unknown connector tool/);
    await assert.rejects(f.registry.tool("echo__echo__extra", {}, { project: "alpha" }), /Unknown connector tool/);
    await f.registry.save(draft({ enabled: false }), {}, { trust: true });
    assert.deepEqual(await f.registry.toolsFor("alpha"), []);
    await assert.rejects(f.registry.tool("echo__echo", { text: "hi" }, { project: "alpha" }), /switched off/);
    assert.equal((await f.registry.list())[0]!.health, "disabled");
  } finally {
    await f.close();
  }
});

test("a connector scoped to one project is invisible to every other project", async () => {
  const f = await fixture();
  try {
    await f.registry.save(draft({ scope: { projects: ["alpha"] } }), {}, { trust: true });
    assert.deepEqual(await f.registry.toolsFor("beta"), []);
    assert.deepEqual(await f.registry.toolsFor(null), []);
    assert.equal((await f.registry.toolsFor("alpha")).length, 5);
    await assert.rejects(
      f.registry.tool("echo__echo", { text: "hi" }, { project: "beta" }),
      /not enabled for this project/,
    );
  } finally {
    await f.close();
  }
});

test("a stdio connector runs only the launch the user approved", async () => {
  const f = await fixture();
  try {
    await f.registry.save(draft(), {});
    assert.equal((await f.registry.list())[0]!.trusted, false, "a save without the dialog is not trusted");
    assert.deepEqual(await f.registry.toolsFor("alpha"), [], "and nothing is started");
    await assert.rejects(f.registry.tool("echo__echo", { text: "hi" }, { project: "alpha" }), /trusted to start/);
    await f.registry.save(draft(), {}, { trust: true });
    assert.equal((await f.registry.list())[0]!.trusted, true);
    const stored = JSON.parse(await readFile(f.file, "utf8")) as { connectors: McpConnector[] };
    assert.equal(stored.connectors[0]!.trustedLaunch, launchDigest(stored.connectors[0]!));
    // A hand-edited file cannot start a different program than the one that was approved.
    stored.connectors[0]!.args = [SERVER, "--hang"];
    await writeFile(f.file, JSON.stringify(stored));
    const reopened = new McpRegistry({ file: f.file, secrets: memorySecretPort() });
    await reopened.init();
    assert.equal((await reopened.list())[0]!.trusted, false);
    assert.deepEqual(await reopened.toolsFor("alpha"), []);
    await reopened.close();
  } finally {
    await f.close();
  }
});

test("a save during a delegation waits for it, and a removal does too", async () => {
  const f = await fixture();
  try {
    await f.registry.save(draft(), {}, { trust: true });
    const release = f.registry.lease();
    await f.registry.save(draft({ name: "Renamed" }), {}, { trust: true });
    assert.equal((await f.registry.list())[0]!.connector.name, "Echo", "a live session keeps the list it started with");
    await f.registry.remove("echo");
    assert.equal((await f.registry.list()).length, 1);
    await release();
    assert.deepEqual(await f.registry.list(), []);
    assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")).connectors, []);
  } finally {
    await f.close();
  }
});

test("the file holds names, the secret store holds values, and only the child sees them", async () => {
  const f = await fixture();
  try {
    await f.registry.save(
      draft({ args: [SERVER, "--env", "WEATHER_TOKEN"], env: ["WEATHER_TOKEN"] }),
      { "env.WEATHER_TOKEN": "s3cret" },
      { trust: true },
    );
    const text = await readFile(f.file, "utf8");
    assert.equal(text.includes("s3cret"), false, "a secret value is never in connectors.json");
    assert.match(text, /WEATHER_TOKEN/);
    // Windows keeps no POSIX mode: only its read-only flag, which this file does not carry.
    if (process.platform !== "win32") assert.equal(((await stat(f.file)).mode & 0o777).toString(8), "600");
    assert.deepEqual([...f.values.keys()], ["mcp.echo.env.WEATHER_TOKEN"]);
    assert.deepEqual((await f.registry.list())[0]!.secrets, ["env.WEATHER_TOKEN"]);
    assert.equal(
      await f.registry.tool("echo__env_digest", {}, { project: "alpha" }),
      `WEATHER_TOKEN ${fingerprint("s3cret")}`,
    );
    await assert.rejects(
      f.registry.save(draft({ env: ["WEATHER_TOKEN"] }), { "env.NOT_DECLARED": "x" }),
      /not declared/,
    );
    await f.registry.remove("echo");
    assert.deepEqual([...f.values.keys()], [], "removing a connector takes its secrets with it");
  } finally {
    await f.close();
  }
});

test("a connector Studio cannot safely run is refused at the save, with a reason", async () => {
  const f = await fixture();
  try {
    const cases: Array<[Partial<McpConnector>, RegExp]> = [
      [{ id: "Echo_1" }, /connector id/],
      [{ id: "" }, /connector id/],
      [{ transport: "carrier-pigeon" as McpConnector["transport"] }, /stdio, http or sse/],
      [{ cwd: "relative/path" }, /absolute path/],
      [{ transport: "http", command: undefined, url: "http://elsewhere.example/mcp" }, /https, or http on localhost/],
      [{ transport: "http", command: undefined, url: "not a url" }, /https, or http on localhost/],
      [{ transport: "http", url: "https://ok.example/mcp" }, /no command/],
      [{ env: ["lowercase"] }, /environment variable name/],
      [{ headers: ["bad header"] }, /header name/],
      [{ args: Array.from({ length: 65 }, () => "x") }, /at most 64 arguments/],
      [{ scope: { projects: "alpha" } as unknown as McpConnector["scope"] }, /scope/],
      [{ name: "" }, /needs a name/],
    ];
    for (const [overrides, message] of cases)
      await assert.rejects(f.registry.save(draft(overrides), {}, { trust: true }), message, JSON.stringify(overrides));
    assert.deepEqual(await f.registry.list(), []);
    await f.registry.save(
      draft({ transport: "http", command: undefined, args: undefined, url: "http://127.0.0.1:8931/mcp" }),
      {},
    );
    assert.equal((await f.registry.list())[0]!.trusted, true, "an http connector needs no launch dialog");
  } finally {
    await f.close();
  }
});

test("Test connects once and puts the server back, and says why when it cannot", async () => {
  const f = await fixture();
  try {
    await f.registry.save(draft(), {}, { trust: true });
    const ok = await f.registry.test("echo");
    assert.equal(ok.ok, true);
    assert.equal(ok.tools.length, 5);
    assert.deepEqual(ok.tools.at(-1), {
      name: "weird.name/x",
      exposedName: "weird_name_x",
      description: "A name an engine will not accept unsanitised.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      allowed: true,
    });
    await f.registry.save(draft({ args: [SERVER, "--hang"] }), {});
    const untrusted = await f.registry.test("echo");
    assert.equal(untrusted.ok, false);
    assert.match(untrusted.error!, /trusted/);
    assert.equal((await f.registry.test("nosuch")).error, "Unknown connector");
  } finally {
    await f.close();
  }
});

test("a plugin-declared server is owned by its plugin: memory only, credential on fd 3, gone with the plugin", async () => {
  const f = await fixture();
  try {
    const connector = await f.registry.registerPluginServer(
      "genex",
      { id: "blender", name: "Genex Blender", command: "ignored", args: [] },
      {
        execPath: process.execPath,
        extraArgs: [SERVER, "--fd3"],
        extraStdio: ["pipe"],
        stdioExtra: (child) => {
          (child.stdio[3] as Writable).end("GENEX_TOKEN=piped\n");
        },
      },
    );
    assert.equal(connector.id, "genex-blender");
    assert.deepEqual(connector.source, { plugin: "genex", server: "blender" });
    assert.equal(connector.trustedLaunch, launchDigest(connector), "the plugin install dialog is the trust gate");
    const tools = await f.registry.toolsFor("alpha");
    assert.ok(tools.some((t) => t.name === "genex-blender__fd3"));
    assert.equal(
      await f.registry.tool("genex-blender__fd3_digest", {}, { project: "alpha" }),
      fingerprint("GENEX_TOKEN=piped"),
    );
    await assert.rejects(f.registry.remove("genex-blender"), /belongs to a plugin/);
    await assert.rejects(
      f.registry.save({ ...connector, name: "Hijacked" }, {}, { trust: true }),
      /belongs to a plugin/,
    );
    assert.equal(
      await readFile(f.file, "utf8").then(
        () => true,
        () => false,
      ),
      false,
      "nothing about it is written to disk",
    );
    await f.registry.unregisterPlugin("genex");
    assert.deepEqual(await f.registry.list(), []);
    assert.deepEqual(await f.registry.toolsFor("alpha"), []);
    await assert.rejects(f.registry.tool("genex-blender__fd3", {}, { project: "alpha" }), /Unknown connector tool/);
  } finally {
    await f.close();
  }
});

test("a connectors file Studio cannot read costs the bad entry, not the good one", async () => {
  const f = await fixture();
  try {
    await mkdir(path.dirname(f.file), { recursive: true });
    await writeFile(
      f.file,
      JSON.stringify({ version: 1, connectors: [draft(), { id: "broken", transport: "stdio" }] }),
    );
    const reopened = new McpRegistry({ file: f.file, secrets: null });
    await reopened.init();
    assert.deepEqual(
      (await reopened.list()).map((v) => v.connector.id),
      ["echo"],
    );
    await reopened.close();
  } finally {
    await f.close();
  }
});

/**
 * The card asks for a connector's tool list the moment Edit is pressed, and listing a stdio
 * server's tools means starting it. That path has to answer to the trust digest like every other.
 */
test("the tool list the card asks for is a launch too: an untrusted stdio connector is refused, not started", async () => {
  const f = await fixture();
  try {
    const marker = path.join(f.root, "launched.txt");
    // A "server" whose only job is to prove it ran: if the guard is missing this file appears.
    await f.registry.save(
      draft({ args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'x')`] }),
      {},
    );
    assert.equal((await f.registry.list())[0]!.trusted, false);
    const started = Date.now();
    await assert.rejects(f.registry.tools("echo"), /has not been trusted to start on this Mac/);
    assert.ok(Date.now() - started < 2_000, "refused outright, not after a connect timeout");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(
      await stat(marker).then(
        () => true,
        () => false,
      ),
      false,
      "nothing was spawned",
    );
    assert.equal((await f.registry.list())[0]!.health, "idle", "and the connector is not marked failed for it");
    await assert.rejects(f.registry.tools("nosuch"), /Unknown connector/);
    // Approved, the same call answers.
    await f.registry.save(draft(), {}, { trust: true });
    assert.equal((await f.registry.tools("echo")).length, 5);
  } finally {
    await f.close();
  }
});

test("a connection dropped by a save does not speak for the entry that replaced it", async () => {
  const f = await fixture();
  try {
    await f.registry.save(draft({ args: [SERVER, "--hang"] }), {}, { trust: true });
    const inflight = f.registry.toolsFor("alpha");
    await new Promise((r) => setTimeout(r, 300));
    // The user fixes the command while the old one is still trying to connect.
    await f.registry.save(draft(), {}, { trust: true });
    await inflight;
    await new Promise((r) => setTimeout(r, 500));
    const view = (await f.registry.list())[0]!;
    assert.equal(view.error, undefined, "the abandoned attempt does not mark the new connector failed");
    assert.notEqual(view.health, "failed");
    assert.equal((await f.registry.toolsFor("alpha")).length, 5, "and the new one answers");
  } finally {
    await f.close();
  }
});

test("a secret a server prints on its way out is not repeated in the message a person reads", async () => {
  const f = await fixture();
  try {
    await f.registry.save(
      draft({ args: [SERVER, "--env", "WEATHER_TOKEN", "--leak"], env: ["WEATHER_TOKEN"] }),
      { "env.WEATHER_TOKEN": "s3cret-value" },
      { trust: true },
    );
    assert.deepEqual(await f.registry.toolsFor("alpha"), [], "a server that will not start contributes nothing");
    const view = (await f.registry.list())[0]!;
    assert.ok(view.error, "and says why");
    assert.equal(
      view.error!.includes("s3cret-value"),
      false,
      "the materialized value never reaches the card, the event or the log",
    );
    assert.match(view.error!, /\[redacted\]/);
    assert.match(view.error!, /WEATHER_TOKEN=/, "what the server actually said is still legible");
    assert.equal(
      f.changes.some((c) => String(c.error ?? "").includes("s3cret-value")),
      false,
      "nor the change events the UI subscribes to",
    );
  } finally {
    await f.close();
  }
});

test("inside one delegation the last answer about a connector is the one that lands", async () => {
  const f = await fixture();
  try {
    await f.registry.save(draft(), {}, { trust: true });
    const release = f.registry.lease();
    await f.registry.remove("echo");
    await f.registry.save(draft({ name: "Changed my mind" }), {}, { trust: true });
    await release();
    const views = await f.registry.list();
    assert.equal(views.length, 1, "the save after the removal is not undone by it");
    assert.equal(views[0]!.connector.name, "Changed my mind");
    assert.equal(JSON.parse(await readFile(f.file, "utf8")).connectors.length, 1, "and it is on disk");
  } finally {
    await f.close();
  }
});

test("disable and remove revoke leased tools immediately and survive reopening before release", async () => {
  const f = await fixture();
  try {
    await f.registry.save(draft(), undefined, { trust: true });
    await f.registry.toolsFor("alpha");
    const release = f.registry.lease("alpha");
    await f.registry.save(draft({ enabled: false }), undefined, { trust: true });
    await assert.rejects(f.registry.tool("echo__echo", { text: "must not run" }, { project: "alpha" }), /switched off/);
    assert.deepEqual(await f.registry.toolsFor("alpha"), []);
    const reopened = new McpRegistry({ file: f.file });
    await reopened.init();
    assert.equal((await reopened.list())[0]!.connector.enabled, false);
    await reopened.close();
    await f.registry.remove("echo");
    assert.deepEqual(
      JSON.parse(await readFile(f.file, "utf8")).connectors,
      [],
      "pending removal is durable immediately",
    );
    await assert.rejects(f.registry.tool("echo__echo", { text: "must not run" }, { project: "alpha" }), /switched off/);
    await release();
    assert.deepEqual(await f.registry.list(), []);
  } finally {
    await f.close();
  }
});

test("a project lease neither blocks another project nor a newly connected source", async () => {
  const f = await fixture();
  try {
    await f.registry.save(draft({ scope: { projects: ["alpha"] } }), undefined, { trust: true });
    await f.registry.save(draft({ id: "beta", scope: { projects: ["beta"] } }), undefined, { trust: true });
    const release = f.registry.lease("alpha");
    await f.registry.save(
      draft({ id: "beta", name: "Changed immediately", scope: { projects: ["beta"] } }),
      undefined,
      { trust: true },
    );
    await f.registry.save(draft({ id: "new", name: "New source" }), undefined, { trust: true });
    assert.equal(
      (await f.registry.list()).find((x) => x.connector.id === "beta")!.connector.name,
      "Changed immediately",
    );
    assert.equal(await f.registry.tool("new__echo", { text: "available now" }, { project: "alpha" }), "available now");
    await f.registry.save(draft({ toolPolicy: { deny: ["echo"] } }), undefined, { trust: true });
    await assert.rejects(
      f.registry.tool("echo__echo", { text: "denied immediately" }, { project: "alpha" }),
      /no longer allowed/,
    );
    await release();
  } finally {
    await f.close();
  }
});

test("parallel project connections retain their own processes and granted roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-mcp-projects-"));
  const registry = new McpRegistry({
    file: path.join(root, "connectors.json"),
    resolveProject: async (project) => path.join(root, project),
  });
  try {
    await registry.init();
    await registry.registerPluginServer(
      "projected",
      { id: "echo", name: "Project context", command: process.execPath, args: [SERVER, "--context"] },
      {
        perProject: true,
        resolve: async (project) => {
          const cwd = path.join(root, project ?? "none");
          await mkdir(cwd, { recursive: true });
          return { cwd };
        },
      },
    );
    await Promise.all([registry.toolsFor("alpha"), registry.toolsFor("beta")]);
    assert.equal((await registry.list("alpha"))[0]!.health, "ready");
    assert.ok((await registry.list("alpha"))[0]!.toolCount > 0);
    assert.equal(
      (await registry.list("unopened"))[0]!.health,
      "idle",
      "another project connection does not establish readiness here",
    );
    assert.equal((await registry.list("unopened"))[0]!.toolCount, 0);
    const a = JSON.parse(String(await registry.tool("projected-echo__context", {}, { project: "alpha" })));
    const b = JSON.parse(String(await registry.tool("projected-echo__context", {}, { project: "beta" })));
    assert.notEqual(a.pid, b.pid);
    assert.equal(a.cwd, await realpath(path.join(root, "alpha")));
    assert.equal(b.cwd, await realpath(path.join(root, "beta")));
    assert.deepEqual(a.roots, [], "project paths are not disclosed without explicit root sharing");
    assert.equal(
      JSON.parse(String(await registry.tool("projected-echo__context", {}, { project: "alpha" }))).pid,
      a.pid,
      "switching projects never restarts the other process",
    );
    await registry.save(draft({ args: [SERVER, "--context"], shareProjectRoot: true }), undefined, { trust: true });
    const result = JSON.parse(String(await registry.tool("echo__context", {}, { project: "alpha" })));
    assert.equal(result.roots.length, 1);
    assert.ok(result.roots[0].uri.endsWith("/alpha"));
    await assert.rejects(registry.tool("echo__echo", { text: 123 }, { project: "alpha" }), /Invalid arguments/);
  } finally {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OAuth browser handoff reports connecting instead of retaining the initial Unauthorized challenge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-mcp-oauth-status-"));
  const issuer = "https://identity.example";
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://service.example/mcp")
      return new Response("", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Bearer resource_metadata="https://service.example/.well-known/oauth-protected-resource"',
        },
      });
    if (url.includes("oauth-protected-resource"))
      return Response.json({ resource: "https://service.example/mcp", authorization_servers: [issuer] });
    if (url.includes("/.well-known/"))
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
      });
    if (url === `${issuer}/register`)
      return Response.json({
        ...JSON.parse(String(init?.body)),
        client_id: "fixture-studio-client",
        token_endpoint_auth_method: "none",
      });
    throw new Error(`Unexpected fixture request: ${url}`);
  };
  const registry = new McpRegistry({
    file: path.join(root, "connectors.json"),
    secrets: memorySecretPort(new Map()),
    fetchImpl,
  });
  let opened = 0;
  try {
    await registry.init();
    await registry.save(
      draft({
        transport: "http",
        command: undefined,
        args: undefined,
        url: "https://service.example/mcp",
        authentication: "oauth",
      }),
    );
    const result = await registry.connect("echo", "alpha", async () => {
      opened++;
    });
    assert.equal(result.ok, false, "tools are not authorized before consent");
    assert.equal(opened, 1, `the real SDK reached the browser handoff: ${result.error}`);
    for (const views of [await registry.list(), await registry.list("alpha")]) {
      assert.equal(views[0]!.authentication?.state, "authorizing");
      assert.equal(views[0]!.health, "connecting");
      assert.equal(views[0]!.error, undefined, "the challenge is not a persistent connection failure");
      assert.equal(views[0]!.toolCount, 0);
    }
    await registry.cancelAuthorization("echo");
    assert.notEqual((await registry.list("alpha"))[0]!.authentication?.state, "authorizing");
  } finally {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a connector result or error that repeats a secret comes back redacted, by value and by shape (SEC-4)", async () => {
  const f = await fixture();
  try {
    await f.registry.save(
      draft({ args: [SERVER, "--env", "WEATHER_TOKEN"], env: ["WEATHER_TOKEN"] }),
      { "env.WEATHER_TOKEN": "s3cret-value" },
      { trust: true },
    );
    assert.equal(
      await f.registry.tool("echo__env_digest", {}, { project: "alpha" }),
      `WEATHER_TOKEN ${fingerprint("s3cret-value")}`,
      "the child still gets its value",
    );
    assert.equal(await f.registry.tool("echo__env", {}, { project: "alpha" }), "WEATHER_TOKEN=[redacted]");
    assert.equal(
      await f.registry.tool("echo__echo", { text: "it was s3cret-value all along" }, { project: "alpha" }),
      "it was [redacted] all along",
    );
    assert.equal(
      await f.registry.tool("echo__echo", { text: "key sk-ant-oat01-FAKEFAKE" }, { project: "alpha" }),
      "key [redacted]",
    );
    await assert.rejects(f.registry.tool("echo__env_fail", {}, { project: "alpha" }), (error: Error) => {
      assert.equal(error.message.includes("s3cret-value"), false, error.message);
      assert.match(error.message, /401 invalid key \[redacted\]/);
      assert.equal(String(error.stack).includes("s3cret-value"), false, "nor in the stack a log may print");
      return true;
    });
    assert.ok(f.registry.secretValues().includes("s3cret-value"), "the value is one Studio knows while it is unlocked");
    await f.registry.remove("echo");
    assert.equal(f.registry.secretValues().includes("s3cret-value"), false);
  } finally {
    await f.close();
  }
});

test("a connector's plain config values and ordinary words come back as written; only its credentials are redacted (B1, B2)", async () => {
  const f = await fixture();
  try {
    await f.registry.save(
      draft({ args: [SERVER, "--env", "WEATHER_TOKEN"], env: ["BASE_URL", "WEATHER_TOKEN"] }),
      { "env.BASE_URL": "https://api.example.com", "env.WEATHER_TOKEN": "s3cret-value" },
      { trust: true },
    );
    const text =
      "GET https://api.example.com/forecast; use the api_key field, SPRITE_KEY=hero, ?code=level2; token s3cret-value";
    assert.equal(
      await f.registry.tool("echo__echo", { text }, { project: "alpha" }),
      text.replace("s3cret-value", "[redacted]"),
    );
    assert.deepEqual(
      ["s3cret-value", "https://api.example.com"].map((value) => f.registry.secretValues().includes(value)),
      [true, false],
    );
  } finally {
    await f.close();
  }
});

test("a plugin server's credentials, in its env or on fd 3, are redacted from what it answers (SEC-4)", async () => {
  const f = await fixture();
  try {
    await f.registry.registerPluginServer(
      "genex",
      { id: "blender", name: "Genex Blender", command: "ignored", args: [] },
      {
        execPath: process.execPath,
        extraArgs: [SERVER, "--fd3"],
        extraStdio: ["pipe"],
        stdioExtra: (child) => {
          (child.stdio[3] as Writable).end("piped-credential-value\n");
        },
        resolve: async () => ({
          extraEnv: { PLUGIN_API_KEY: "plugin-env-credential" },
          secrets: ["piped-credential-value"],
        }),
      },
    );
    assert.equal(
      await f.registry.tool("genex-blender__fd3_digest", {}, { project: "alpha" }),
      fingerprint("piped-credential-value"),
    );
    assert.equal(await f.registry.tool("genex-blender__fd3", {}, { project: "alpha" }), "[redacted]");
    assert.equal(
      await f.registry.tool("genex-blender__echo", { text: "env plugin-env-credential" }, { project: "alpha" }),
      "env [redacted]",
    );
    assert.ok(f.registry.secretValues().includes("piped-credential-value"));
  } finally {
    await f.close();
  }
});

test("two tools whose names collide at the length limit both stay callable (MCP-4)", async () => {
  const f = await fixture();
  try {
    await f.registry.save(draft({ args: [SERVER, "--long"] }), {}, { trust: true });
    const names = (await f.registry.toolsFor("alpha")).map((t) => t.name).filter((n) => n.includes("aaaa"));
    assert.equal(names.length, 2);
    assert.notEqual(names[0], names[1]);
    for (const name of names) {
      assert.match(name, MCP_QUALIFIED_TOOL, `${name} (${name.length - "echo__".length} characters)`);
      assert.equal(f.registry.owns(name), true);
    }
    assert.deepEqual((await Promise.all(names.map((n) => f.registry.tool(n, {}, { project: "alpha" })))).sort(), [
      "_one",
      "_two",
    ]);
    const connected = await f.registry.connect("echo", "beta");
    assert.ok(connected.ok);
    assert.equal(
      f.registry.planningToolNames("echo", "beta").every((n) => MCP_QUALIFIED_TOOL.test(`echo__${n}`)),
      true,
      "Connect de-duplicates the same way",
    );
  } finally {
    await f.close();
  }
});

test("a connector that does not need the project is shared across games; a per-project one is not (MCP-2)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-mcp-shared-"));
  const registry = new McpRegistry({
    file: path.join(root, "connectors.json"),
    resolveProject: async (project) => path.join(root, project),
  });
  try {
    await registry.init();
    await registry.save(draft({ args: [SERVER, "--context"] }), undefined, { trust: true });
    await Promise.all([registry.toolsFor("alpha"), registry.toolsFor("beta")]);
    const a = JSON.parse(String(await registry.tool("echo__context", {}, { project: "alpha" })));
    const b = JSON.parse(String(await registry.tool("echo__context", {}, { project: "beta" })));
    assert.equal(a.pid, b.pid, "one process serves every game");
    assert.equal((await registry.list("beta"))[0]!.health, "ready");
    await registry.registerPluginServer(
      "projected",
      { id: "echo", name: "Project context", command: process.execPath, args: [SERVER, "--context"] },
      {
        perProject: true,
        resolve: async (project) => {
          const cwd = path.join(root, project ?? "none");
          await mkdir(cwd, { recursive: true });
          return { cwd };
        },
      },
    );
    const pa = JSON.parse(String(await registry.tool("projected-echo__context", {}, { project: "alpha" })));
    const pb = JSON.parse(String(await registry.tool("projected-echo__context", {}, { project: "beta" })));
    assert.notEqual(pa.pid, pb.pid, "perProject keeps one per game");
  } finally {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an idle connection closes after the idle period and comes back on the next call; a lease keeps it open (PERF-11)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-mcp-idle-"));
  const clock = manualTimers();
  const registry = new McpRegistry({
    file: path.join(root, "connectors.json"),
    idleCloseMs: 60_000,
    schedule: clock.schedule,
  });
  try {
    await registry.init();
    await registry.save(draft({ args: [SERVER, "--context"] }), undefined, { trust: true });
    const release = registry.lease("alpha");
    const first = JSON.parse(String(await registry.tool("echo__context", {}, { project: "alpha" }))).pid;
    await clock.fire();
    assert.ok(alive(first), "a leased connection is never closed for idleness");
    await release();
    assert.ok(clock.pending() > 0, "releasing the last lease starts the idle clock");
    assert.ok(clock.timers.every((t) => t.ms === 60_000));
    await clock.fire();
    assert.equal(alive(first), false, "the idle process is gone");
    assert.equal((await registry.list("alpha"))[0]!.health, "idle");
    const second = JSON.parse(String(await registry.tool("echo__context", {}, { project: "alpha" }))).pid;
    assert.notEqual(second, first, "the next call reconnects");
    assert.ok(clock.pending() > 0, "and the idle clock runs again after it");
    await clock.fire();
    assert.equal(alive(second), false);
  } finally {
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an edit that drops an env name deletes its stored value, and removal deletes every value the connector owned (MCP-6)", async () => {
  const f = await fixture();
  try {
    await f.registry.save(
      draft({ env: ["KEEP_TOKEN", "DROP_TOKEN"] }),
      { "env.KEEP_TOKEN": "keep-value", "env.DROP_TOKEN": "drop-value" },
      { trust: true },
    );
    await f.registry.save(draft({ env: ["KEEP_TOKEN"] }), undefined, { trust: true });
    assert.deepEqual([...f.values.keys()], ["mcp.echo.env.KEEP_TOKEN"]);
    f.values.set("mcp.echo.env.ORPHAN_TOKEN", "left-by-an-old-version");
    f.values.set("mcp.echoes.env.OTHER", "another connector");
    await f.registry.remove("echo");
    assert.deepEqual(
      [...f.values.keys()],
      ["mcp.echoes.env.OTHER"],
      "nothing of the removed connector survives it, and nothing else goes with it",
    );
  } finally {
    await f.close();
  }
});

test("an edit made during a delegation drops the old env value when it is applied (MCP-6)", async () => {
  const f = await fixture();
  try {
    await f.registry.save(
      draft({ env: ["KEEP_TOKEN", "DROP_TOKEN"] }),
      { "env.KEEP_TOKEN": "keep-value", "env.DROP_TOKEN": "drop-value" },
      { trust: true },
    );
    const release = f.registry.lease("alpha");
    await f.registry.save(draft({ env: ["KEEP_TOKEN"] }), undefined, { trust: true });
    assert.ok(f.values.has("mcp.echo.env.DROP_TOKEN"), "the running delegation still has the old configuration");
    await release();
    assert.deepEqual([...f.values.keys()], ["mcp.echo.env.KEEP_TOKEN"]);
  } finally {
    await f.close();
  }
});

test("the program a stdio connector will run is resolved the way Connect resolves it, so the trust dialog can name it (GPX-7)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-mcp-which-"));
  try {
    const first = path.join(root, "first"),
      second = path.join(root, "second");
    await mkdir(first);
    await mkdir(second);
    // Windows runs a file by its PATHEXT name (`tool.cmd`); an extensionless one cannot run there.
    const runnableName = process.platform === "win32" ? "tool.cmd" : "tool";
    await writeFile(path.join(first, "tool"), "not executable", { mode: 0o644 });
    await writeFile(path.join(second, runnableName), "#!/bin/sh\n", { mode: 0o755 });
    const PATH = ["relative/bin", first, second].join(path.delimiter);
    assert.equal(
      await resolveExecutable("tool", PATH),
      path.join(second, runnableName),
      "a relative PATH entry and a file that cannot run are skipped",
    );
    assert.equal(
      await resolveExecutable(path.join(second, runnableName), ""),
      path.join(second, runnableName),
      "an absolute command is itself",
    );
    assert.equal(
      await resolveExecutable(path.join(first, "tool"), PATH),
      undefined,
      "an absolute command that cannot run resolves to nothing",
    );
    assert.equal(await resolveExecutable("missing", PATH), undefined);
    // Windows: `npx` is npm's `npx.cmd`, never the extensionless `sh` launcher beside it.
    const npm = path.join(root, "npm");
    await mkdir(npm);
    for (const name of ["npx", "npx.ps1", "npx.cmd"]) await writeFile(path.join(npm, name), "", { mode: 0o755 });
    assert.equal(await resolveExecutable("npx", ["relative", npm].join(";"), "win32"), path.join(npm, "npx.cmd"));
    assert.equal(await resolveExecutable(path.join(npm, "npx"), "", "win32"), path.join(npm, "npx.cmd"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("closing the registry on quit closes connectors side by side, each within its own bound (B3)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-mcp-close-"));
  const registry = new McpRegistry({
    file: path.join(root, "connectors.json"),
    secrets: memorySecretPort(new Map()),
    closeTimeoutMs: 500,
  });
  const close = McpConnection.prototype.close;
  const ids = ["one", "two", "three", "four"];
  try {
    await registry.init();
    for (const id of ids) await registry.save(draft({ id, name: id }), {}, { trust: true });
    for (const id of ids) assert.equal((await registry.connect(id, "alpha")).ok, true);
    // Each child really goes, but its close reports back only a minute later, like a stuck server.
    McpConnection.prototype.close = function () {
      return close.call(this).then(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, 60_000).unref();
          }),
      );
    };
    const started = Date.now();
    await registry.close();
    const took = Date.now() - started;
    assert.ok(took < 1_500, `four stuck closes took ${took} ms; each is bounded at 500 ms and they run side by side`);
  } finally {
    McpConnection.prototype.close = close;
    await registry.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a server's own name and picture, from its initialize answer, reach the connector list once it connects", async () => {
  const f = await fixture();
  try {
    await f.registry.save(draft({ args: [SERVER, "--identity"] }), {}, { trust: true });
    const before = (await f.registry.list())[0]!;
    assert.equal(before.title, undefined, "nothing is known before it connects");
    await f.registry.connect("echo");
    const view = (await f.registry.list())[0]!;
    assert.equal(view.title, "Echo Tools");
    assert.match(view.icon ?? "", /^data:image\/png;base64,/);
  } finally {
    await f.close();
  }
});
