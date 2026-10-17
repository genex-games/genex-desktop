/**
 * One port per Unreal project, and a real "Unreal is answering" check. Setup gives each project
 * its own port for Epic's MCP server, chosen once from a hash of the project's path, so projects
 * never clash with each other or with another app on Epic's default 8000. "Answering" means Epic's
 * server completes an MCP `initialize` there: a bare TCP connect said yes to any app on the port.
 * The bridge reads the set-up projects and their ports from the plugin's storage.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { type AddressInfo, createConnection, createServer, type Socket } from "node:net";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  bridgeHome,
  bridgeProjects,
  choosePort,
  derivedPort,
  editorAnswers,
  editorEndpoint,
  editorServes,
  heldInListing,
  inProjectBlock,
  listSetUpProjects,
  portFree,
  rememberAnswers,
} from "../../src/plugins/unreal/editor-port.ts";
import { tmpDir } from "../helpers/tmp.ts";

const BLOCK = { first: 18_000, last: 18_999 } as const;
const inBlock = (port: number) => Number.isInteger(port) && port >= BLOCK.first && port <= BLOCK.last;
const DRIFT = "/Users/someone/Documents/Unreal Projects/Drift/Drift.uproject";

/** A project file whose derived port is `port`, found by trying names. */
function projectWithPort(port: number): string {
  for (let i = 0; i < 200_000; i++) {
    const file = `/Games/P${i}/P${i}.uproject`;
    if (derivedPort(file) === port) return file;
  }
  throw new Error(`no project name derives ${port}`);
}

describe("a project's own port", () => {
  it("is derived from the project's path, inside 18000–18999, the same every time", () => {
    const ports = ["A", "B", "C", "D", "E"].map((name) => derivedPort(`/Games/${name}/${name}.uproject`));
    assert.ok(ports.every(inBlock), String(ports));
    assert.equal(derivedPort(DRIFT), derivedPort(DRIFT));
    assert.ok(new Set(ports).size > 1, "different projects start from different ports");
  });

  it("skips ports something listens on and ports other set-up projects hold, wrapping inside the block", async () => {
    const project = projectWithPort(BLOCK.last - 1);
    const probed: number[] = [];
    const listening = new Set([BLOCK.last - 1, BLOCK.first]);
    const port = await choosePort({
      project,
      taken: new Set([BLOCK.last]),
      listening: async (candidate) => {
        probed.push(candidate);
        return listening.has(candidate);
      },
    });
    assert.equal(port, BLOCK.first + 1);
    assert.ok(probed.every(inBlock), "never probes outside Genex's block");
    assert.ok(!probed.includes(BLOCK.last), "a port another project holds needs no probe");
  });

  it("moves a current port outside Genex's block to the derived one: a project leaves Epic's 8000", async () => {
    const none = async () => false;
    const derived = derivedPort(DRIFT);
    assert.equal(await choosePort({ project: DRIFT, current: 8000, taken: new Set(), listening: none }), derived);
    for (const current of [1024, 17_999, 19_000, 65_535])
      assert.equal(
        await choosePort({ project: DRIFT, current, taken: new Set(), listening: none }),
        derived,
        String(current),
      );
  });

  it("keeps a current port inside Genex's block while it is usable", async () => {
    const none = async () => false;
    assert.equal(await choosePort({ project: DRIFT, current: 18_123, taken: new Set(), listening: none }), 18_123);
    const derived = derivedPort(DRIFT);
    const held = await choosePort({ project: DRIFT, current: 18_123, taken: new Set([18_123]), listening: none });
    assert.equal(held, derived, "another set-up project holds it");
    const busy = await choosePort({
      project: DRIFT,
      current: 18_123,
      taken: new Set(),
      listening: async (port) => port === 18_123,
    });
    assert.equal(busy, derived, "another app listens on it while Unreal is closed");
  });

  it("names Genex's block: 18000 to 18999 and nothing else", () => {
    for (const port of [18_000, 18_500, 18_999]) assert.equal(inProjectBlock(port), true, String(port));
    for (const port of [8000, 17_999, 19_000, 18_000.5, Number.NaN, -18_000])
      assert.equal(inProjectBlock(port), false, String(port));
  });

  it("never keeps a port Unreal cannot use, and never probes it", async () => {
    for (const current of [0, 80, 1023, 65_536, 70_000, 8000.5, Number.NaN, -8000]) {
      const probed: number[] = [];
      const port = await choosePort({
        project: DRIFT,
        current,
        taken: new Set(),
        listening: async (candidate) => {
          probed.push(candidate);
          return false;
        },
      });
      assert.equal(port, derivedPort(DRIFT), String(current));
      assert.ok(!probed.includes(current), String(current));
    }
  });

  it("is undefined when every port in the block is taken", async () => {
    const port = await choosePort({ project: DRIFT, taken: new Set(), listening: async () => true });
    assert.equal(port, undefined);
  });
});

type Hit = { method: string; url: string; session: string | undefined };
type Served = { port: number; hits: Hit[]; close: () => Promise<void> };

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

/** A local HTTP server that records every request and answers with `handle`. */
async function serveHttp(handle: (hit: Hit, body: string, response: ServerResponse) => void): Promise<Served> {
  const hits: Hit[] = [];
  const server = createHttpServer(async (request, response) => {
    const session = request.headers["mcp-session-id"];
    const hit = {
      method: request.method ?? "",
      url: request.url ?? "",
      session: session ? String(session) : undefined,
    };
    hits.push(hit);
    handle(hit, await readBody(request), response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return { port, hits, close };
}

/** Epic's initialize answer as UE 5.8.3 builds it: it never fills serverInfo, so the name is empty. */
const EPIC_INITIALIZE = {
  protocolVersion: "2025-06-18",
  capabilities: { resources: {}, tools: { listChanged: true } },
  serverInfo: { name: "", title: "", version: "" },
};

/** A JSON-RPC answer to an MCP request, the way Epic's server sends it. */
function rpc(response: ServerResponse, body: string, result: unknown, session?: string) {
  const { id } = JSON.parse(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (session) headers["mcp-session-id"] = session;
  response.writeHead(200, headers).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

/** An MCP server whose initialize answers `result` and opens a session; DELETE ends it. */
const mcpServer = (result: unknown) =>
  serveHttp((hit, body, response) => {
    if (hit.method === "DELETE") return void response.writeHead(202).end();
    rpc(response, body, result, "epic-session-1");
  });

/** Epic's Unreal MCP. */
const epicMcp = () => mcpServer(EPIC_INITIALIZE);

/** Any other app's MCP server, built with the MCP SDK the way most are: it names itself and offers tools. */
async function sdkMcpServer(): Promise<Served> {
  const hits: Hit[] = [];
  const server = createHttpServer(async (request, response) => {
    hits.push({ method: request.method ?? "", url: request.url ?? "", session: undefined });
    const mcp = new Server({ name: "some-other-mcp-app", version: "1.0.0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    const body = await readBody(request);
    await transport.handleRequest(request, response, body ? JSON.parse(body) : undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return { port, hits, close };
}

/** A port nothing listens on: bound once by the OS, then let go. */
async function closedPort(): Promise<Served> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return { port, hits: [], close: async () => {} };
}

/** A server that accepts the connection and never says anything. */
async function silentServer(): Promise<Served> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => sockets.add(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  };
  return { port, hits: [], close };
}

/** Every way a port can say something that is not Epic's MCP, and Epic's MCP itself. */
const answering: Array<{ name: string; serve: (elsewhere: Served) => Promise<Served>; answers: boolean }> = [
  { name: "nothing listening", serve: closedPort, answers: false },
  {
    name: "a web server that is not MCP",
    serve: () => serveHttp((_hit, _body, response) => response.writeHead(200).end("<html>hello</html>")),
    answers: false,
  },
  {
    name: "a JSON server that answers anything with {}",
    serve: () => serveHttp((_hit, _body, response) => response.writeHead(200).end("{}")),
    answers: false,
  },
  {
    name: "an MCP server without tools",
    serve: () => mcpServer({ ...EPIC_INITIALIZE, capabilities: { resources: {} } }),
    answers: false,
  },
  {
    name: "an MCP server with tools and no resources",
    serve: () => mcpServer({ ...EPIC_INITIALIZE, capabilities: { tools: { listChanged: true } } }),
    answers: false,
  },
  {
    name: "an MCP server that names itself, as every other MCP app does",
    serve: () => mcpServer({ ...EPIC_INITIALIZE, serverInfo: { name: "some-other-mcp-app", version: "1.0.0" } }),
    answers: false,
  },
  { name: "an ordinary MCP SDK server with tools", serve: sdkMcpServer, answers: false },
  {
    name: "a JSON-RPC error",
    serve: () =>
      serveHttp((_hit, body, response) =>
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(body).id, error: { code: -32601, message: "no" } })),
      ),
    answers: false,
  },
  {
    name: "a redirect to another local server",
    serve: (elsewhere) =>
      serveHttp((_hit, _body, response) =>
        response.writeHead(307, { location: `http://127.0.0.1:${elsewhere.port}/mcp` }).end(),
      ),
    answers: false,
  },
  { name: "a server that accepts and never answers", serve: silentServer, answers: false },
  { name: "Epic's Unreal MCP", serve: epicMcp, answers: true },
];

describe("Unreal is answering", () => {
  for (const row of answering) {
    it(`${row.answers ? "is" : "is not"}: ${row.name}`, async () => {
      const elsewhere = await epicMcp();
      const served = await row.serve(elsewhere);
      try {
        const started = Date.now();
        assert.equal(await editorAnswers(editorEndpoint(String(served.port))), row.answers);
        assert.ok(Date.now() - started < 1500, "an answer or a no well under two seconds");
        assert.deepEqual(elsewhere.hits, [], "a redirect is never followed");
        assert.ok(
          served.hits.every((hit) => hit.url === "/mcp"),
          "only Unreal's MCP path is asked",
        );
      } finally {
        await served.close();
        await elsewhere.close();
      }
    });
  }

  it("ends the session its check opened, so the editor keeps no session per check", async () => {
    const epic = await epicMcp();
    try {
      assert.equal(await editorAnswers(editorEndpoint(String(epic.port))), true);
      assert.deepEqual(
        epic.hits.map((hit) => [hit.method, hit.session]),
        [
          ["POST", undefined],
          ["DELETE", "epic-session-1"],
        ],
      );
    } finally {
      await epic.close();
    }
  });
});

/**
 * Epic's Unreal MCP whose Genex editor helper names `open` as the project it has open. With
 * `lagMs`, every answer waits that long first, as a real editor's do while it is in the background.
 */
const epicWithProject = (open: string, lagMs = 0) =>
  serveHttp(async (hit, body, response) => {
    if (lagMs) await delay(lagMs);
    if (hit.method === "DELETE") return void response.writeHead(202).end();
    const message = JSON.parse(body);
    if (message.id === undefined) return void response.writeHead(202).end();
    if (message.method === "initialize") return rpc(response, body, EPIC_INITIALIZE, "epic-session-1");
    const asked = message.params?.arguments?.tool_name;
    const text = JSON.stringify({ returnValue: asked === "project_file" ? open : null });
    rpc(response, body, { content: [{ type: "text", text }] }, "epic-session-1");
  });

describe("Unreal serves this project", () => {
  const DRIFT_FILE = "/Games/Drift/Drift.uproject";
  for (const [name, open, serves] of [
    ["its own editor", DRIFT_FILE, true],
    ["another project's editor", "/Games/Other/Other.uproject", false],
    ["an editor whose helper names nothing", "", false],
  ] as const)
    it(`${serves ? "does" : "does not"}: ${name}`, async () => {
      const epic = await epicWithProject(open);
      try {
        const started = Date.now();
        assert.equal(await editorServes(editorEndpoint(String(epic.port)), DRIFT_FILE), serves);
        assert.ok(Date.now() - started < 1500);
        assert.equal(epic.hits.at(-1)?.method, "DELETE", "the session it opened is ended");
      } finally {
        await epic.close();
      }
    });

  // With the editor behind another app, UE 5.8.3 answers each request in about 400 ms, so three
  // requests sharing one budget under a second would read a connected editor as not answering.
  it("does: its own editor in the background, answering each request after 400 ms", async () => {
    const epic = await epicWithProject(DRIFT_FILE, 400);
    try {
      assert.equal(await editorServes(editorEndpoint(String(epic.port)), DRIFT_FILE), true);
    } finally {
      await epic.close();
    }
  });

  // UE 5.8 answers a tool call as an event stream: the answer comes at once, but the stream stays
  // open until the connection idles out about 15 s later.
  it("does: its own editor answering the tool call in an event stream it keeps open", async () => {
    const epic = await serveHttp((hit, body, response) => {
      if (hit.method === "DELETE") return void response.writeHead(202).end();
      const message = JSON.parse(body);
      if (message.id === undefined) return void response.writeHead(202).end();
      if (message.method === "initialize") return rpc(response, body, EPIC_INITIALIZE, "epic-session-1");
      const text = JSON.stringify({ returnValue: DRIFT_FILE });
      const answer = { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } };
      response.writeHead(200, {
        "content-type": "text/event-stream;charset=utf-8",
        "mcp-session-id": "epic-session-1",
      });
      response.write(`event: message\r\ndata: ${JSON.stringify(answer)}\r\n\r\n`);
    });
    try {
      const started = Date.now();
      assert.equal(await editorServes(editorEndpoint(String(epic.port)), DRIFT_FILE), true);
      assert.ok(Date.now() - started < 1000, "read the answer without waiting for the stream to end");
    } finally {
      await epic.close();
    }
  });

  it("does not, and gives up within a second: a server that accepts and never answers", async () => {
    const silent = await serveHttp(() => undefined);
    try {
      const started = Date.now();
      assert.equal(await editorServes(editorEndpoint(String(silent.port)), DRIFT_FILE), false);
      assert.ok(Date.now() - started < 1000);
    } finally {
      await silent.close();
    }
  });

  it("does not: anything that isn't Epic's server", async () => {
    const plain = await serveHttp((_hit, _body, response) => response.writeHead(200).end("{}"));
    try {
      assert.equal(await editorServes(editorEndpoint(String(plain.port)), DRIFT_FILE), false);
    } finally {
      await plain.close();
    }
  });
});

/** Every file under `dir` with a hash of its bytes (links named, not followed). */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
    const full = path.join(entry.parentPath, entry.name);
    const key = path.relative(dir, full).split(path.sep).join("/");
    if (entry.isSymbolicLink()) out[key] = "link";
    else if (entry.isFile())
      out[key] = createHash("sha256")
        .update(await readFile(full))
        .digest("hex");
  }
  return out;
}

const record = (project: unknown, port: unknown) => ({ project, uproject: { added: [], enabled: [] }, port });

async function writeRecord(storage: string, key: string, value: unknown) {
  await mkdir(path.join(storage, "setup", key), { recursive: true });
  const text = typeof value === "string" ? value : JSON.stringify(value);
  await writeFile(path.join(storage, "setup", key, "record.json"), text);
}

const GOOD = "/Games/Good/Good.uproject";

/** Setup records the bridge must not trust: each is skipped, and reading changes nothing. */
const hostileRecords: Array<{
  name: string;
  links?: boolean;
  arrange: (storage: string, outside: string) => Promise<void>;
}> = [
  { name: "a port Unreal cannot use", arrange: (s) => writeRecord(s, "low", record("/Games/Low/Low.uproject", 80)) },
  {
    name: "a port outside Genex's block, such as Epic's 8000, which any project or app may hold",
    arrange: (s) => writeRecord(s, "epic", record("/Games/Epic/Epic.uproject", 8000)),
  },
  {
    name: "a port above 65535",
    arrange: (s) => writeRecord(s, "high", record("/Games/High/High.uproject", 70_000)),
  },
  {
    name: "a port that is not a whole number",
    arrange: (s) => writeRecord(s, "half", record("/Games/Half/Half.uproject", 18_000.5)),
  },
  {
    name: "a port written as text",
    arrange: (s) => writeRecord(s, "text", record("/Games/Text/Text.uproject", "18001")),
  },
  {
    name: "a record from before ports",
    arrange: (s) => writeRecord(s, "old", record("/Games/Old/Old.uproject", undefined)),
  },
  { name: "a relative project path", arrange: (s) => writeRecord(s, "relative", record("Rel/Rel.uproject", 18_002)) },
  {
    name: "a project that is not a .uproject",
    arrange: (s) => writeRecord(s, "txt", record("/Games/Txt/Txt.txt", 18_003)),
  },
  { name: "a project that is not text", arrange: (s) => writeRecord(s, "num", record(42, 18_004)) },
  { name: "a record that is not JSON", arrange: (s) => writeRecord(s, "broken", "{ not json") },
  { name: "a record that is a list", arrange: (s) => writeRecord(s, "list", "[1, 2]") },
  {
    name: "a record that is a folder",
    arrange: async (s) => {
      await mkdir(path.join(s, "setup", "folder", "record.json"), { recursive: true });
    },
  },
  {
    name: "a record that links to one elsewhere",
    links: true,
    arrange: async (s, outside) => {
      await writeFile(path.join(outside, "record.json"), JSON.stringify(record("/Games/Out/Out.uproject", 18_005)));
      await mkdir(path.join(s, "setup", "linked-file"), { recursive: true });
      await symlink(path.join(outside, "record.json"), path.join(s, "setup", "linked-file", "record.json"));
    },
  },
  {
    name: "a record folder that links elsewhere",
    links: true,
    arrange: async (s, outside) => {
      await mkdir(path.join(outside, "folder"), { recursive: true });
      await writeFile(
        path.join(outside, "folder", "record.json"),
        JSON.stringify(record("/Games/Out2/Out2.uproject", 18_006)),
      );
      await mkdir(path.join(s, "setup"), { recursive: true });
      await symlink(path.join(outside, "folder"), path.join(s, "setup", "linked-folder"));
    },
  },
];

describe("the set-up projects the bridge reads from storage", () => {
  it("lists each set-up project with its port, the panel's choice first", async () => {
    const storage = await tmpDir("studio-unreal-storage-");
    await writeRecord(storage, "a", record("/Games/Alpha/Alpha.uproject", 18_010));
    await writeRecord(storage, "b", record("/Games/Beta/Beta.uproject", 18_011));
    assert.deepEqual(
      (await listSetUpProjects(storage)).map((p) => [p.name, p.port]),
      [
        ["Alpha", 18_010],
        ["Beta", 18_011],
      ],
    );
    await writeFile(path.join(storage, "chosen.json"), JSON.stringify({ project: "/Games/Beta/Beta.uproject" }));
    assert.deepEqual(
      (await listSetUpProjects(storage)).map((p) => p.name),
      ["Beta", "Alpha"],
    );
    await writeFile(path.join(storage, "chosen.json"), JSON.stringify({ project: "/Games/Gone/Gone.uproject" }));
    assert.deepEqual(
      (await listSetUpProjects(storage)).map((p) => p.name),
      ["Alpha", "Beta"],
      "a choice that isn't set up changes nothing",
    );
    await writeFile(path.join(storage, "chosen.json"), "{ not json");
    assert.deepEqual(
      (await listSetUpProjects(storage)).map((p) => p.name),
      ["Alpha", "Beta"],
    );
  });

  it("lists nothing when nothing is set up", async () => {
    const storage = await tmpDir("studio-unreal-storage-");
    assert.deepEqual(await listSetUpProjects(storage), []);
    assert.deepEqual(await listSetUpProjects(path.join(storage, "missing")), []);
  });

  for (const row of hostileRecords) {
    it(`skips ${row.name}, changing nothing`, {
      skip: Boolean(row.links) && process.platform === "win32" && "links need privileges on Windows",
    }, async () => {
      const root = await tmpDir("studio-unreal-storage-");
      const storage = path.join(root, "storage");
      const outside = path.join(root, "outside");
      await mkdir(outside, { recursive: true });
      await writeRecord(storage, "good", record(GOOD, 18_100));
      await row.arrange(storage, outside);
      const witness = [await tree(storage), await tree(outside)];
      assert.deepEqual(
        (await listSetUpProjects(storage)).map((p) => [p.project, p.port]),
        [[GOOD, 18_100]],
      );
      assert.deepEqual([await tree(storage), await tree(outside)], witness);
    });
  }
});

describe("the projects the bridge may reach", () => {
  const ALPHA = "/Games/Alpha/Alpha.uproject";
  const MINE = "/Games/Mine/Mine.uproject";

  it("names the panel's choice with its port when it is set up, and every set-up project", async () => {
    const storage = await tmpDir("studio-unreal-storage-");
    await writeRecord(storage, "a", record(ALPHA, 18_010));
    await writeRecord(storage, "b", record("/Games/Beta/Beta.uproject", 18_011));
    assert.deepEqual((await bridgeProjects(storage)).chosen, undefined, "nothing chosen yet");
    await writeFile(path.join(storage, "chosen.json"), JSON.stringify({ project: ALPHA }));
    const found = await bridgeProjects(storage);
    assert.deepEqual(found.chosen, { project: ALPHA, name: "Alpha", port: 18_010 });
    assert.deepEqual(
      found.setUp.map((p) => p.name),
      ["Alpha", "Beta"],
    );
  });

  it("names a choice that isn't set up without a port, and leaves the set-up list as it is", async () => {
    const storage = await tmpDir("studio-unreal-storage-");
    await writeRecord(storage, "a", record(ALPHA, 18_010));
    await writeFile(path.join(storage, "chosen.json"), JSON.stringify({ project: MINE }));
    const found = await bridgeProjects(storage);
    assert.deepEqual(found.chosen, { project: MINE, name: "Mine" });
    assert.deepEqual(
      found.setUp.map((p) => p.project),
      [ALPHA],
    );
  });

  const hostileChoices: Array<{
    name: string;
    links?: boolean;
    arrange: (storage: string, outside: string) => Promise<void>;
  }> = [
    { name: "a choice that is not JSON", arrange: (s) => writeFile(path.join(s, "chosen.json"), "{ not json") },
    {
      name: "a choice that is not a .uproject",
      arrange: (s) => writeFile(path.join(s, "chosen.json"), JSON.stringify({ project: "/Games/Mine/Mine.txt" })),
    },
    {
      name: "a choice that links to one elsewhere",
      links: true,
      arrange: async (s, outside) => {
        await writeFile(path.join(outside, "chosen.json"), JSON.stringify({ project: ALPHA }));
        await symlink(path.join(outside, "chosen.json"), path.join(s, "chosen.json"));
      },
    },
  ];
  for (const row of hostileChoices) {
    it(`reads no choice from ${row.name}, changing nothing`, {
      skip: Boolean(row.links) && process.platform === "win32" && "links need privileges on Windows",
    }, async () => {
      const root = await tmpDir("studio-unreal-storage-");
      const storage = path.join(root, "storage");
      const outside = path.join(root, "outside");
      await mkdir(outside, { recursive: true });
      await writeRecord(storage, "a", record(ALPHA, 18_010));
      await row.arrange(storage, outside);
      const witness = [await tree(storage), await tree(outside)];
      const found = await bridgeProjects(storage);
      assert.equal(found.chosen, undefined);
      assert.deepEqual(
        found.setUp.map((p) => p.project),
        [ALPHA],
      );
      assert.deepEqual([await tree(storage), await tree(outside)], witness);
    });
  }
});

describe("each game's own project", () => {
  const ALPHA = "/Games/Alpha/Alpha.uproject";
  const BETA = "/Games/Beta/Beta.uproject";
  const link = (storage: string, game: string, project: unknown) =>
    mkdir(path.join(storage, "links"), { recursive: true }).then(() =>
      writeFile(
        path.join(storage, "links", `${game}.json`),
        JSON.stringify({ kind: "unreal", project, linkedAt: "2026-10-04T12:00:00.000Z" }),
      ),
    );

  it("a bridge knows its storage and game from the folder the host runs it in", () => {
    const storage = path.join(path.sep, "data", "plugins", "unreal");
    assert.deepEqual(bridgeHome(path.join(storage, "mcp", "valley")), { storage, game: "valley" });
    assert.deepEqual(bridgeHome(path.join(storage, "mcp", "_shared")), { storage });
  });

  it("two games linked to two projects each reach their own, ahead of the panel's choice", async () => {
    const storage = await tmpDir("studio-unreal-storage-");
    await writeRecord(storage, "a", record(ALPHA, 18_010));
    await writeRecord(storage, "b", record(BETA, 18_011));
    await writeFile(path.join(storage, "chosen.json"), JSON.stringify({ project: BETA }));
    await link(storage, "valley", ALPHA);
    await link(storage, "drift", BETA);
    assert.deepEqual((await bridgeProjects(storage, "valley")).chosen, { project: ALPHA, name: "Alpha", port: 18_010 });
    assert.deepEqual((await bridgeProjects(storage, "drift")).chosen, { project: BETA, name: "Beta", port: 18_011 });
    assert.equal((await bridgeProjects(storage, "unlinked")).chosen?.project, BETA, "no link: the panel's choice");
    assert.equal((await bridgeProjects(storage)).chosen?.project, BETA, "no game: the panel's choice");
  });

  it("a game whose link was undone, or is not a project, reaches the panel's choice", async () => {
    const storage = await tmpDir("studio-unreal-storage-");
    await writeRecord(storage, "a", record(ALPHA, 18_010));
    await writeFile(path.join(storage, "chosen.json"), JSON.stringify({ project: ALPHA }));
    await mkdir(path.join(storage, "links"), { recursive: true });
    await writeFile(
      path.join(storage, "links", "undone.json"),
      JSON.stringify({ unlinkedAt: "2026-10-04T12:00:00.000Z" }),
    );
    await link(storage, "text", "/Games/Mine/Mine.txt");
    await link(storage, "web", 7);
    for (const game of ["undone", "text", "web", "../valley", "a/b", ""]) {
      assert.equal((await bridgeProjects(storage, game)).chosen?.project, ALPHA, game);
    }
  });

  it("reads no link from a link file that is a symbolic link", { skip: process.platform === "win32" }, async () => {
    const root = await tmpDir("studio-unreal-storage-");
    const storage = path.join(root, "storage");
    const outside = path.join(root, "outside");
    await mkdir(outside, { recursive: true });
    await writeRecord(storage, "a", record(ALPHA, 18_010));
    await writeFile(
      path.join(outside, "valley.json"),
      JSON.stringify({ kind: "unreal", project: BETA, linkedAt: "x" }),
    );
    await mkdir(path.join(storage, "links"), { recursive: true });
    await symlink(path.join(outside, "valley.json"), path.join(storage, "links", "valley.json"));
    assert.equal((await bridgeProjects(storage, "valley")).chosen, undefined);
  });
});

/**
 * A stand-in editor check: answers what `answer` says for each port and project, counts the asks,
 * and holds an ask open while `stall` is set, as an editor behind another app sometimes does.
 */
function standInCheck() {
  const asks: Array<[number, string | undefined]> = [];
  const state = { answer: true, stall: false, throws: false };
  const check = async (port: number, project?: string) => {
    asks.push([port, project]);
    if (state.throws) throw new Error("connection reset");
    if (state.stall) await new Promise<never>(() => {});
    return state.answer;
  };
  return { asks, state, check };
}

describe("remembering a project's last good answer", () => {
  const PORT = 18_642;
  const GAME = "/Users/me/Documents/Unreal Projects/Drift/Drift.uproject";

  it("after a good answer, the next check says yes at once while the editor is asked again", async () => {
    const editor = standInCheck();
    let clock = 0;
    const answers = rememberAnswers(editor.check, () => clock);
    assert.equal(await answers(PORT, GAME), true);
    editor.state.stall = true;
    clock += 3_000;
    // A stalled ask must not hold the status call: the remembered answer comes back first.
    const quick = await Promise.race([answers(PORT, GAME), delay(200).then(() => "waited")]);
    assert.equal(quick, true);
    assert.equal(editor.asks.length, 2, "the editor is asked again in the background");
  });

  it("one failed ask after a good one doesn't flip the answer; the next call asks and believes it", async () => {
    const editor = standInCheck();
    let clock = 0;
    const answers = rememberAnswers(editor.check, () => clock);
    assert.equal(await answers(PORT, GAME), true);
    editor.state.answer = false;
    clock += 3_000;
    assert.equal(await answers(PORT, GAME), true, "the remembered answer");
    await delay(10);
    clock += 3_000;
    assert.equal(await answers(PORT, GAME), false, "the failed background ask is not remembered as good");
  });

  it("a good answer stands for 10 s; after that the check waits for the editor again", async () => {
    const editor = standInCheck();
    let clock = 0;
    const answers = rememberAnswers(editor.check, () => clock);
    assert.equal(await answers(PORT, GAME), true);
    editor.state.answer = false;
    clock += 10_000;
    assert.equal(await answers(PORT, GAME), false);
  });

  it("asks one at a time per port and project", async () => {
    const editor = standInCheck();
    const answers = rememberAnswers(editor.check, () => 0);
    assert.deepEqual(await Promise.all([answers(PORT, GAME), answers(PORT, GAME), answers(PORT, GAME)]), [
      true,
      true,
      true,
    ]);
    assert.equal(editor.asks.length, 1);
  });

  it("a check that throws counts as not answering and is not remembered", async () => {
    const editor = standInCheck();
    const answers = rememberAnswers(editor.check, () => 0);
    editor.state.throws = true;
    assert.equal(await answers(PORT, GAME), false);
    editor.state.throws = false;
    editor.state.answer = false;
    assert.equal(await answers(PORT, GAME), false);
  });

  // A good answer belongs to its port and project only: none of these may borrow it.
  const others: Array<[string, number, string | undefined]> = [
    ["another project on the same port", PORT, "/Users/me/Documents/Unreal Projects/Cave/Cave.uproject"],
    ["the same project on another port", PORT + 1, GAME],
    ["the same port with no project named", PORT, undefined],
    ["the same project spelled with another case", PORT, GAME.toLowerCase()],
    ["the same project with a trailing slash", PORT, `${GAME}/`],
    ["a port of 0", 0, GAME],
    ["a negative port", -PORT, GAME],
  ];
  for (const [what, port, project] of others)
    it(`a good answer doesn't stand for ${what}`, async () => {
      const editor = standInCheck();
      const answers = rememberAnswers(editor.check, () => 0);
      assert.equal(await answers(PORT, GAME), true);
      editor.state.answer = false;
      assert.equal(await answers(port, project), false);
      assert.deepEqual(editor.asks.at(-1), [port, project], "the editor itself was asked");
    });
});

describe("whether a project's port is free for Unreal to listen on", () => {
  /** A port the system just gave a listener, and that listener. */
  async function listener() {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, port: (server.address() as AddressInfo).port };
  }
  const close = (server: ReturnType<typeof createServer>) =>
    new Promise<void>((resolve) => server.close(() => resolve()));
  const noSockets = async () => "Active Internet connections (including servers)\n";

  it("a port something listens on is not free; once it stops, it is", async () => {
    const { server, port } = await listener();
    const held = await portFree(port, "darwin", noSockets);
    await close(server);
    assert.equal(held, false);
    assert.equal(await portFree(port, "darwin", noSockets), true);
  });

  it("a quit server's lingering sockets still hold the port on a Mac, though Node itself could bind it", {
    skip: process.platform !== "darwin" && "netstat's socket listing is read on a Mac only",
  }, async () => {
    // The server closes each connection first, so its own end lingers in TIME_WAIT on the port.
    const server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    for (let i = 0; i < 2; i++)
      await new Promise<void>((resolve) => {
        const client = createConnection(port, "127.0.0.1");
        client.on("data", () => {});
        client.on("end", () => client.end());
        client.on("close", () => resolve());
      });
    await close(server);
    assert.equal(await portFree(port, "linux"), true, "Node's own bind passes: it sets SO_REUSEADDR, Unreal doesn't");
    assert.equal(await portFree(port, "darwin"), false, "netstat still lists the port's sockets");
  });

  it("a netstat that can't run leaves the test bind to decide", async () => {
    const { server, port } = await listener();
    await close(server);
    const fails = async () => {
      throw new Error("netstat: not found");
    };
    assert.equal(await portFree(port, "darwin", fails), true);
  });

  it("Windows asks only the test bind, whose bind there matches Unreal's", async () => {
    const { server, port } = await listener();
    await close(server);
    let listed = 0;
    const listing = async () => {
      listed++;
      return `tcp4  0  0  127.0.0.1.${port}  127.0.0.1.50000  TIME_WAIT`;
    };
    assert.equal(await portFree(port, "win32", listing), true);
    assert.equal(listed, 0);
  });

  /** macOS netstat lines (`-an -p tcp`) and whether each holds port 18118 for Unreal's listener. */
  const lines: Array<[string, boolean]> = [
    ["tcp4       0      0  127.0.0.1.18118        127.0.0.1.51914        TIME_WAIT", true],
    ["tcp4       0      0  127.0.0.1.18118        *.*                    LISTEN", true],
    ["tcp46      0      0  *.18118                *.*                    LISTEN", true],
    ["tcp4       0      0  127.0.0.1.18118        127.0.0.1.51915        FIN_WAIT_2", true],
    ["tcp4       0      0  127.0.0.1.51914        127.0.0.1.18118        TIME_WAIT", false],
    ["tcp4       0      0  127.0.0.1.181180       127.0.0.1.51914        TIME_WAIT", false],
    ["tcp4       0      0  127.0.0.1.1811         127.0.0.1.51914        TIME_WAIT", false],
    ["tcp4       0      0  10.0.0.2.18118         10.0.0.9.51914         ESTABLISHED", false],
    ["tcp6       0      0  ::1.18118              ::1.51914              TIME_WAIT", false],
    ["udp4       0      0  *.18118                *.*", false],
    ["tcp4  127.0.0.1.18118", false],
    ["127.0.0.1.18118", false],
    ["Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)", false],
    ["", false],
  ];
  for (const [line, held] of lines)
    it(`${held ? "counts" : "ignores"} ${JSON.stringify(line.replace(/\s+/g, " "))}`, () => {
      assert.equal(heldInListing(`Active Internet connections\n${line}\n`, 18118), held);
    });
});
