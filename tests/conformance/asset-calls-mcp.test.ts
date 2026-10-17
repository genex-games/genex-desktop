/**
 * An MCP server's tool says what its calls make in its own `tools/list` entry
 * (`_meta: { "genex/asset": { kind, prompt?, tool? } }`), so any server, a plugin's or one the
 * person added, shows its calls being made as Genex's own do: the host stamps the call's
 * `connector_tool_started` record and lists the call as its game's waiting job until it answers.
 * A malformed declaration says nothing, and a tool that declares nothing is no job.
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, it } from "node:test";
import { MakingKind, type MakingJob, MakingPhase } from "../../src/shared/asset-making.ts";
import { CustomEvent, customEvent } from "../../src/shared/custom-events.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";

const PROJECT = "painted";
const PLUGIN = "paintshop";

/**
 * A plugin's MCP server, dependency-free: `paint` declares it makes an image and holds until its
 * release file exists; `smudge` declares a kind nobody draws; `echo` declares nothing.
 */
const SERVER = `
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
const props = { type: "object", properties: { text: { type: "string" }, release: { type: "string" } } };
const TOOLS = [
  { name: "paint", description: "Paint.", inputSchema: props, _meta: { "genex/asset": { kind: "image", prompt: "text", tool: "Brush" } } },
  { name: "smudge", description: "Smudge.", inputSchema: props, _meta: { "genex/asset": { kind: "hologram" } } },
  { name: "echo", description: "Echo.", inputSchema: props },
];
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
async function answer(name, args) {
  if (name === "paint") for (let tries = 0; tries < 500 && !existsSync(args.release); tries++) await sleep(20);
  return { content: [{ type: "text", text: String(args?.text ?? "") }] };
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
    if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "paint-fixture", version: "1.0.0" } } });
    else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    else if (method === "tools/call") answer(params?.name, params?.arguments).then((result) => send({ jsonrpc: "2.0", id, result }));
    else send({ jsonrpc: "2.0", id, result: {} });
  }
}
`;

let lite: CoreLite;
let threadId: string;
let scratch: string;

before(async () => {
  lite = await coreLite();
  scratch = await mkdtemp(path.join(os.tmpdir(), "studio-paint-plugin-"));
  const manifest = {
    apiVersion: 3,
    id: PLUGIN,
    version: "1.0.0",
    name: "Paint Shop",
    publisher: "Studio tests",
    description: "Paints through its MCP server.",
    backend: "backend.mjs",
    capabilities: [],
    tools: [],
    skills: [],
    panels: [],
    settings: [],
    actions: [],
    mcpServers: [
      {
        id: "brush",
        transport: "stdio",
        command: "node",
        args: ["server.mjs"],
        cwd: "storage",
        description: "Paints.",
      },
    ],
  };
  await writeFile(path.join(scratch, "plugin.json"), JSON.stringify(manifest));
  await writeFile(path.join(scratch, "backend.mjs"), "export async function activate(){return {};}\n");
  await writeFile(path.join(scratch, "server.mjs"), SERVER);
  await lite.core.games.scaffold(PROJECT);
  threadId = await lite.core.createGameThread(PROJECT);
  await lite.core.setPermissionMode(threadId, PermissionMode.Bypass);
  // From GitHub, so its server follows the chat's mode: a local plugin's server asks every call.
  await lite.core.plugins.installLocal(scratch, "github", [], {
    kind: "github",
    repo: "studio-tests/paint",
    sha: "b".repeat(40),
  });
  await lite.core.plugins.setEnabled(PLUGIN, true);
  await lite.core.mcp.toolsFor(PROJECT);
});

after(async () => {
  lite.core.plugins.cancel();
  await lite.core.mcp.close();
  await lite.close();
});

const invoke = (tool: string, args: Record<string, unknown>) => {
  const api = lite.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
  return api["mcp.invoke"]!({ project: PROJECT, threadId, name: `${PLUGIN}-brush__${tool}`, args });
};
const waiting = async (): Promise<MakingJob[]> =>
  ((await lite.core.projectAssets(PROJECT)).jobs ?? []).filter((job) => job.source === PLUGIN);
const lastStarted = async () =>
  (await lite.core.listAllEvents())
    .flatMap((event) => customEvent(event, CustomEvent.ConnectorToolStarted) ?? [])
    .at(-1);

it("stamps a declared tool's call and lists it as its game's waiting job until it answers", async () => {
  const release = path.join(scratch, "release");
  const call = invoke("paint", { text: "A mossy cobblestone", release });
  let jobs: MakingJob[] = [];
  for (let reads = 0; reads < 200 && !jobs.length; reads++) {
    jobs = await waiting();
    if (!jobs.length) await new Promise((resolve) => setImmediate(resolve));
  }
  const [job] = jobs;
  assert.ok(job, "the call is a waiting job while it runs");
  const started = await lastStarted();
  assert.deepEqual(started?.making, { kind: MakingKind.Image, tool: "Brush", prompt: "A mossy cobblestone" });
  assert.equal(job.jobId, started?.callId);
  assert.deepEqual(
    [job.kind, job.phase, job.tool, job.prompt, job.sourceName],
    [MakingKind.Image, MakingPhase.Making, "Brush", "A mossy cobblestone", "Paint Shop"],
  );
  await writeFile(release, "");
  assert.equal(await call, "A mossy cobblestone");
  assert.deepEqual(await waiting(), [], "an answered call is no longer waiting");
});

it("takes a malformed declaration, or none, as saying nothing", async () => {
  for (const tool of ["smudge", "echo"]) {
    await invoke(tool, { text: tool });
    assert.equal((await lastStarted())?.making, undefined, tool);
  }
  assert.deepEqual(await waiting(), []);
});
