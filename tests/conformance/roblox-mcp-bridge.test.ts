import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { MAX_PLAY_SHOT_BYTES } from "../../src/shared/engine-play.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { AGENT_BUSY_FILE } from "../../src/plugins/roblox/agent-marks.ts";
import { BINDING_FILE, BINDING_MAX_AGE_MS, type PlaceLink } from "../../src/plugins/roblox/studio-binding.ts";
import { createStudioClient, type StudioClient } from "../../src/plugins/roblox/studio-client.ts";
import { createStudioMcp, type StudioMcpDeps } from "../../src/plugins/roblox/studio-mcp.ts";
import { shrinkCommand, systemShrink } from "../../src/plugins/roblox/studio-shot.ts";
import { classOf, READ_TOOLS, STUDIO_TOOLS, StudioToolClass } from "../../src/plugins/roblox/studio-tools.ts";
import { tmpDir } from "../helpers/tmp.ts";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures");
const FAKE = path.join(FIXTURES, "fake-roblox-studio-mcp.mjs");
const MCP = "/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP";
const PLAIN_FILE = { file: true, directory: false, link: false, mtimeMs: 0 };
const NOW = 1_800_000_000_000;
const TWO_STUDIOS = JSON.stringify([
  { id: "studio-1", name: "Place1" },
  { id: "studio-2", name: "Obby.rbxl" },
]);

const realSleep = (ms: number, signal?: AbortSignal) => sleep(ms, undefined, { signal }).catch(() => undefined);

/** The real client on the stand-in StudioMCP, its join waits on a clock that moves at once. */
function standInClient(flags: string[]) {
  const clock = { t: NOW };
  const starts: number[] = [];
  const client = createStudioClient({
    platform: "darwin",
    env: { PATH: process.env.PATH },
    home: "/Users/ann",
    mcp: async () => MCP,
    fs: { lstat: async () => PLAIN_FILE, realpath: async (file) => file },
    spawn: (_file, _args, options) => {
      starts.push(clock.t);
      return spawn(process.execPath, [FAKE, ...flags], { env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    },
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    limit: realSleep,
  });
  return { client, clock, starts };
}

type Setup = {
  flags?: string[];
  link?: PlaceLink;
  running?: boolean;
  shrink?: StudioMcpDeps["shrink"];
  wrap?: (client: StudioClient, folder: string) => StudioClient;
};

async function connect(setup: Setup = {}) {
  const dir = await tmpDir("roblox-bridge-");
  const folder = path.join(dir, "mcp", "game-1");
  await mkdir(folder, { recursive: true });
  const log = path.join(dir, "calls.jsonl");
  const stand = standInClient(["--log", log, ...(setup.flags ?? [])]);
  const client = setup.wrap ? setup.wrap(stand.client, folder) : stand.client;
  const bridge = createStudioMcp({
    client,
    folder,
    link: async () => setup.link,
    running: async () => setup.running ?? true,
    shrink: setup.shrink ?? (async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
    now: () => stand.clock.t,
  });
  const [ours, theirs] = InMemoryTransport.createLinkedPair();
  const agent = new Client({ name: "test", version: "0" });
  await Promise.all([bridge.server.connect(theirs), agent.connect(ours)]);
  const close = async () => {
    await agent.close();
    await bridge.close();
  };
  const calls = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.tool && entry.tool !== "list_roblox_studios");
  return {
    agent,
    folder,
    close,
    calls,
    stand,
    bind: (studioId: string, at = stand.clock.t) => bindIn(folder, studioId, at),
  };
}

async function bindIn(folder: string, studioId: string, at: number) {
  await writeFile(path.join(folder, BINDING_FILE), JSON.stringify({ studioId, session: "s-1", at }));
}

const textOf = (result: any) =>
  (result.content as Array<{ type: string; text?: string }>)
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");

const HIDDEN = [
  "http_get",
  "multi_edit",
  "start_stop_play",
  "user_keyboard_input",
  "user_mouse_input",
  "character_navigation",
  "list_roblox_studios",
];
const CONFIRMED = [
  "insert_asset",
  "generate_mesh",
  "generate_procedural_model",
  "generate_texture",
  "generate_material",
  "segment_mesh",
  "subagent",
  "upload_image",
  "store_image",
];

test("contract pin: the class table covers every recorded Studio tool with the arguments it requires", async () => {
  const contract = JSON.parse(await readFile(path.join(FIXTURES, "roblox-studio", "tools.json"), "utf8"));
  const recorded = new Map<string, any>(contract.tools.map((tool: any) => [tool.name, tool]));
  assert.equal(recorded.size, 30);
  assert.deepEqual(Object.keys(STUDIO_TOOLS).sort(), [...recorded.keys()].sort());
  for (const [name, entry] of Object.entries(STUDIO_TOOLS)) {
    const required = recorded.get(name).inputSchema.required ?? [];
    assert.deepEqual([...entry.required].sort(), [...required].sort(), name);
  }
  assert.deepEqual(
    [...HIDDEN, ...CONFIRMED].filter(
      (name) => classOf(name) === StudioToolClass.Read || classOf(name) === StudioToolClass.Write,
    ),
    [],
  );
  assert.equal(classOf("a_tool_from_a_newer_studio"), StudioToolClass.Unknown);
});

test("the manifest's Roblox Studio connection reads exactly the read class and holds the studio lock", async () => {
  const raw = JSON.parse(await readFile(path.resolve("src/plugins/roblox/plugin.json"), "utf8"));
  const manifest = validateManifest(raw);
  const server = manifest.mcpServers?.find((entry) => entry.id === "studio");
  assert.ok(server);
  assert.deepEqual([...(server.reads ?? [])].sort(), [...READ_TOOLS].sort());
  assert.deepEqual(server.needs, ["studio"]);
  assert.equal(server.cwd, "storage:project");
  assert.deepEqual(server.args, ["studio-mcp.mjs"]);
  assert.match(server.description, /^Roblox Studio, for this game's open place\./);
});

test("the connection lists reads and writes only, with studio_id left for it to fill", async () => {
  const bridge = await connect({ flags: ["--extra-tool", "future_tool"] });
  try {
    const { tools } = await bridge.agent.listTools();
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [...READ_TOOLS, "execute_luau"].sort());
    for (const hidden of [...HIDDEN, ...CONFIRMED]) assert.ok(!names.includes(hidden), hidden);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.properties?.studio_id, undefined, tool.name);
      assert.ok(!(tool.inputSchema.required ?? []).includes("studio_id"), tool.name);
    }
    const luau = tools.find((tool) => tool.name === "execute_luau");
    assert.ok(!(luau?.inputSchema.required ?? []).includes("datamodel_type"), "Edit unless the agent names another");
    const shot = tools.find((tool) => tool.name === "screen_capture");
    assert.ok(!(shot?.inputSchema.required ?? []).includes("capture_id"));
  } finally {
    await bridge.close();
  }
});

test("calls go to the Studio the binding file names, with studio_id and Edit filled in", async () => {
  const bridge = await connect({ flags: ["--studios", TWO_STUDIOS] });
  try {
    await bridge.bind("studio-2");
    const state = await bridge.agent.callTool({ name: "get_studio_state", arguments: {} });
    assert.notEqual(state.isError, true, textOf(state));
    const luau = await bridge.agent.callTool({ name: "execute_luau", arguments: { code: "return 1" } });
    assert.notEqual(luau.isError, true, textOf(luau));
    const shot = await bridge.agent.callTool({ name: "screen_capture", arguments: {} });
    assert.notEqual(shot.isError, true, textOf(shot));
    const calls = await bridge.calls();
    assert.deepEqual(
      calls.map((call) => [call.tool, call.args.studio_id, call.args.datamodel_type]),
      [
        ["get_studio_state", "studio-2", undefined],
        ["execute_luau", "studio-2", "Edit"],
        ["screen_capture", "studio-2", undefined],
      ],
    );
    assert.match(calls[2].args.capture_id, /^ScreenCapture_\d+$/);
  } finally {
    await bridge.close();
  }
});

test("a call naming another Studio is refused before it reaches Studio", async () => {
  const bridge = await connect({ flags: ["--studios", TWO_STUDIOS] });
  try {
    await bridge.bind("studio-2");
    const result = await bridge.agent.callTool({ name: "get_studio_state", arguments: { studio_id: "studio-1" } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /leave studio_id out/);
    assert.deepEqual(await bridge.calls(), []);
  } finally {
    await bridge.close();
  }
});

test("a stale binding answers that Studio isn't open for this game, and reaches no Studio", async () => {
  const rows: Array<{ name: string; bind: (b: Awaited<ReturnType<typeof connect>>) => Promise<void> }> = [
    { name: "too old", bind: (b) => b.bind("studio-1", NOW - BINDING_MAX_AGE_MS - 1) },
    { name: "from the future", bind: (b) => b.bind("studio-1", NOW + BINDING_MAX_AGE_MS + 1) },
    { name: "not a binding", bind: (b) => writeFile(path.join(b.folder, BINDING_FILE), "[1,2]") },
    { name: "a Studio no longer listed", bind: (b) => b.bind("studio-9") },
  ];
  for (const row of rows) {
    const bridge = await connect({ link: { project: "/Games/Place1.rbxl" } });
    try {
      await row.bind(bridge);
      const result = await bridge.agent.callTool({ name: "get_studio_state", arguments: {} });
      assert.equal(result.isError, true, row.name);
      assert.match(textOf(result), /Roblox Studio isn't open for this game/, row.name);
      assert.deepEqual(await bridge.calls(), [], row.name);
    } finally {
      await bridge.close();
    }
  }
});

test("a bound Studio a proxy StudioMCP lost is found again after one fresh start", async () => {
  const bridge = await connect({ flags: ["--lose-after", "1"] });
  try {
    await bridge.bind("studio-1");
    const first = await bridge.agent.callTool({ name: "get_studio_state", arguments: {} });
    assert.notEqual(first.isError, true, textOf(first));
    const again = await bridge.agent.callTool({ name: "get_studio_state", arguments: {} });
    assert.notEqual(again.isError, true, textOf(again));
    assert.equal(bridge.stand.starts.length, 2, "StudioMCP started afresh once");
    assert.deepEqual(
      (await bridge.calls()).map((call) => call.args.studio_id),
      ["studio-1", "studio-1"],
    );
  } finally {
    await bridge.close();
  }
});

test("hidden and ask-first tools are refused by name and never reach Studio", async () => {
  const bridge = await connect();
  try {
    await bridge.bind("studio-1");
    for (const name of [...HIDDEN, ...CONFIRMED]) {
      const result = await bridge.agent.callTool({ name, arguments: {} });
      assert.equal(result.isError, true, name);
    }
    const network = await bridge.agent.callTool({ name: "http_get", arguments: { url: "https://example.test" } });
    assert.match(textOf(network), /Genex's own web tools/);
    const edit = await bridge.agent.callTool({ name: "multi_edit", arguments: {} });
    assert.match(textOf(edit), /\.luau files/);
    assert.deepEqual(await bridge.calls(), []);
  } finally {
    await bridge.close();
  }
});

test("execute_luau code that reaches the person's account is refused with the asking tool, and never reaches Studio", async () => {
  const bridge = await connect();
  try {
    await bridge.bind("studio-1");
    const cases: Array<[string, RegExp]> = [
      ['game:GetObjects("rbxassetid://123")[1].Parent = workspace', /roblox__insert-asset/],
      ['game:GetService("AssetService"):CreateAssetAsync(model, Enum.AssetType.Model, {})', /roblox__upload-image/],
      ["game:SavePlaceAsync()", /roblox__publish-update/],
      ['game:GetService("HttpService"):GetAsync("https://example.test")', /Genex's own web tools/],
      ['game:GetService("DataStoreService"):GetDataStore("Coins")', /live/],
      ['game["Get" .. "Objects"](game, "rbxassetid://123")', /plainly/],
    ];
    for (const [code, words] of cases) {
      const result = await bridge.agent.callTool({ name: "execute_luau", arguments: { code } });
      assert.equal(result.isError, true, code);
      assert.match(textOf(result), words, code);
    }
    assert.deepEqual(await bridge.calls(), [], "nothing reached Studio");
    await assert.rejects(readFile(path.join(bridge.folder, AGENT_BUSY_FILE)), "nothing ran, so no mark");
    const built = await bridge.agent.callTool({ name: "execute_luau", arguments: { code: "return 1" } });
    assert.notEqual(built.isError, true);
  } finally {
    await bridge.close();
  }
});

test("a write marks the agent busy around the call; a read marks nothing", async () => {
  const seen: Array<{ tool: string; mark: any }> = [];
  const wrap = (client: StudioClient, folder: string): StudioClient => ({
    ...client,
    callTool: async (name, args, options) => {
      const mark = await readFile(path.join(folder, AGENT_BUSY_FILE), "utf8").then(JSON.parse, () => null);
      seen.push({ tool: name, mark });
      return client.callTool(name, args, options);
    },
  });
  const bridge = await connect({ wrap });
  try {
    await bridge.bind("studio-1");
    await bridge.agent.callTool({ name: "inspect_instance", arguments: { path: "Workspace" } });
    assert.equal(seen.at(-1)?.mark, null, "a read leaves no mark");
    await bridge.agent.callTool({ name: "execute_luau", arguments: { code: "return 1" } });
    assert.deepEqual(seen.at(-1)?.mark, { since: NOW }, "busy while the write runs");
    const after = JSON.parse(await readFile(path.join(bridge.folder, AGENT_BUSY_FILE), "utf8"));
    assert.deepEqual(after, { since: NOW, until: NOW });
  } finally {
    await bridge.close();
  }
});

test("a tool a newer Studio adds is never listed, and a call to it is refused before any Studio is asked", async () => {
  const unknown = ["publish_place", "generate_avatar", "upload_asset"];
  const bridge = await connect({ flags: unknown.flatMap((name) => ["--extra-tool", name]) });
  try {
    await bridge.bind("studio-1");
    const names = (await bridge.agent.listTools()).tools.map((tool) => tool.name);
    for (const name of unknown) assert.ok(!names.includes(name), `${name} is not listed`);
    for (const name of unknown) {
      const result: any = await bridge.agent.callTool({ name, arguments: {} });
      assert.equal(result.isError, true, name);
      assert.match(textOf(result), new RegExp(`^${name} isn't offered yet`), name);
    }
    assert.deepEqual(await bridge.calls(), [], "no Studio was asked to run them");
  } finally {
    await bridge.close();
  }
});

test("a 1.2 MB shot is shrunk under 1 MB; a shrink that fails or stays too large is a plain refusal", async () => {
  const small = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const shrinks: number[] = [];
  const rows: Array<{ name: string; shrink: StudioMcpDeps["shrink"]; ok: boolean }> = [
    {
      name: "shrunk",
      shrink: async (jpeg) => {
        shrinks.push(jpeg.length);
        return small;
      },
      ok: true,
    },
    {
      name: "shrink failed",
      shrink: async () => {
        throw new Error("sips failed");
      },
      ok: false,
    },
    { name: "still too large", shrink: async () => Buffer.alloc(MAX_PLAY_SHOT_BYTES + 1), ok: false },
  ];
  for (const row of rows) {
    const bridge = await connect({ flags: ["--big-shot"], shrink: row.shrink });
    try {
      await bridge.bind("studio-1");
      const result = await bridge.agent.callTool({ name: "screen_capture", arguments: {} });
      const images = (result.content as any[]).filter((part) => part.type === "image");
      if (row.ok) {
        assert.notEqual(result.isError, true, row.name);
        assert.equal(images.length, 1);
        assert.equal(images[0].mimeType, "image/jpeg");
        assert.deepEqual(Buffer.from(images[0].data, "base64"), small);
      } else {
        assert.equal(result.isError, true, row.name);
        assert.equal(images.length, 0, row.name);
        assert.match(textOf(result), /too large/, row.name);
      }
    } finally {
      await bridge.close();
    }
  }
  assert.deepEqual(shrinks, [1_200_000]);
});

test("with no binding yet, the linked place is matched by name, and two matches are refused", async () => {
  const bridge = await connect({ flags: ["--studios", TWO_STUDIOS], link: { project: "/Games/Obby/Obby.rbxl" } });
  try {
    const result = await bridge.agent.callTool({ name: "get_studio_state", arguments: {} });
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal((await bridge.calls())[0]?.args.studio_id, "studio-2");
  } finally {
    await bridge.close();
  }
  const twice = JSON.stringify([
    { id: "a", name: "Obby.rbxl" },
    { id: "b", name: "Obby.rbxl" },
  ]);
  const ambiguous = await connect({ flags: ["--studios", twice], link: { project: "/Games/Obby/Obby.rbxl" } });
  try {
    const result = await ambiguous.agent.callTool({ name: "get_studio_state", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /Two Roblox Studio windows/);
    assert.deepEqual(await ambiguous.calls(), []);
  } finally {
    await ambiguous.close();
  }
});

test("Studio's absence is told in plain words: not linked, not open, or open with the MCP server off", async () => {
  // Each names the agent's own tool for the step: setup is the agent's job, never the person's clicks.
  const rows: Array<{ name: string; setup: Setup; words: RegExp; tool: RegExp }> = [
    {
      name: "no link",
      setup: {},
      words: /isn't linked to a Roblox place/,
      tool: /roblox__places.*roblox__use-project/,
    },
    {
      name: "not running",
      setup: { flags: ["--no-studio"], link: { project: "/Games/Place1.rbxl" }, running: false },
      words: /Roblox Studio isn't open for this game/,
      tool: /roblox__open-studio/,
    },
    {
      name: "running, not listed",
      setup: { flags: ["--no-studio"], link: { project: "/Games/Place1.rbxl" }, running: true },
      words: /Enable Studio as MCP server/,
      tool: /roblox__do-it-for-me/,
    },
  ];
  for (const row of rows) {
    const bridge = await connect(row.setup);
    try {
      const result = await bridge.agent.callTool({ name: "get_studio_state", arguments: {} });
      assert.equal(result.isError, true, row.name);
      assert.match(textOf(result), row.words, row.name);
      assert.match(textOf(result), row.tool, row.name);
      assert.doesNotMatch(textOf(result), /Ask the person|the Roblox Studio button/, row.name);
    } finally {
      await bridge.close();
    }
  }
});

test("the system shrink runs sips or PowerShell with no path inside a command, and cleans up", async () => {
  const mac = shrinkCommand("darwin", {}, "/tmp/a/shot.jpeg", "/tmp/a/small.jpeg");
  assert.equal(mac.file, "/usr/bin/sips");
  assert.deepEqual(mac.args.slice(-3), ["/tmp/a/shot.jpeg", "--out", "/tmp/a/small.jpeg"]);
  const hostile = "C:\\Users\\A'; Remove-Item -Recurse C:\\ ;'\\shot.jpeg";
  const windows = shrinkCommand("win32", { SystemRoot: "C:\\Windows" }, hostile, "C:\\out.jpeg");
  assert.equal(windows.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.ok(!windows.args.join(" ").includes(hostile), "the path is never part of the command");
  assert.deepEqual(windows.env, { GENEX_SHOT_IN: hostile, GENEX_SHOT_OUT: "C:\\out.jpeg" });

  const seen: string[] = [];
  const shrink = systemShrink("darwin", {}, async (_file, args) => {
    const [input, , output] = args.slice(-3);
    seen.push(input ?? "", output ?? "");
    await writeFile(output ?? "", Buffer.from([1, 2, 3]));
  });
  assert.deepEqual(await shrink(Buffer.alloc(10)), Buffer.from([1, 2, 3]));
  const failing = systemShrink("darwin", {}, async () => {
    throw new Error("sips failed");
  });
  await assert.rejects(failing(Buffer.alloc(10)));
  for (const file of seen) await assert.rejects(readFile(file), "the temporary folder is gone");
});
