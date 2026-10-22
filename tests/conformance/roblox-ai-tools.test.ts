/**
 * Roblox's own AI tools and uploads as the Roblox Studio plugin's ask-first tools
 * (`plugins/roblox/ai-tools.ts`): each declares a card that asks the person every call, in every
 * mode, and says what goes to Roblox and that it runs on their Roblox account; the connection never
 * offers the Studio tools behind them. Each call goes to the game's own Studio with `studio_id`
 * filled; lists arrive as comma or JSON strings and are checked; anything refused reaches no Studio;
 * images come only from the game folder (never through a link) or an https address; Studio's own
 * refusals, such as the daily cap on generated models, reach the agent in Studio's words.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type AiTool,
  type AskFirstAnswer,
  type AskFirstGame,
  createAiTools,
  MAX_IMAGE_BYTES,
  serveImages,
} from "../../src/plugins/roblox/ai-tools.ts";
import { AGENT_BUSY_FILE, AGENT_PLAY_FILE } from "../../src/plugins/roblox/agent-marks.ts";
import { createRobloxBackend, RobloxTool } from "../../src/plugins/roblox/backend.ts";
import type { MomentServices } from "../../src/plugins/roblox/moment-ops.ts";
import type { StudioClient, StudioToolResult } from "../../src/plugins/roblox/studio-client.ts";
import { createStudioMcp } from "../../src/plugins/roblox/studio-mcp.ts";
import { createStudioWatch } from "../../src/plugins/roblox/studio-moments.ts";
import { ASK_FIRST_STUDIO_TOOL, AskFirstTool } from "../../src/plugins/roblox/studio-tools.ts";
import { toEntries } from "../../src/renderer/chat-entries.ts";
import { ConsentChoice, consentChoices, consentTitle } from "../../src/renderer/chat/consent-card.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import type { PluginManifest } from "../../src/shared/plugins.ts";
import { UiEvent, type UiEvent as UiEventData } from "../../src/shared/ui-events.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { hostFor, makeGame, robloxMac } from "../helpers/roblox-mac.ts";
import { tmpDir } from "../helpers/tmp.ts";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures");
const MANIFEST = path.resolve(import.meta.dirname, "../../src/plugins/roblox/plugin.json");
const STUDIO = "studio-7";
const NOW = 1_800_000_000_000;
/** A real PNG's first bytes, then filler: enough for the image check. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);

const text = (value: string, isError = false): StudioToolResult => ({
  content: [{ type: "text", text: value }],
  isError,
});

type Call = { name: string; args: Record<string, unknown> };

/** A stand-in Studio that records every call and answers with `answer`. */
function standIn(answer: (call: Call) => Promise<StudioToolResult> | StudioToolResult = () => text("ok")) {
  const calls: Call[] = [];
  const studio: Pick<StudioClient, "callTool"> = {
    async callTool(name, args) {
      const call = { name, args };
      calls.push(call);
      return answer(call);
    },
  };
  return { studio, calls };
}

/** A game with a folder, the plugin's storage and the agent's marks folder, its Studio bound or not. */
async function gameIn(bound = true): Promise<AskFirstGame & { folder: string; storage: string; marks: string }> {
  const root = await tmpDir("roblox-ai-");
  const folder = path.join(root, "game");
  const storage = path.join(root, "storage");
  const marks = path.join(storage, "mcp", "game-1");
  await mkdir(path.join(folder, "art"), { recursive: true });
  await mkdir(marks, { recursive: true });
  return { folder, storage, marks, studio: () => (bound ? STUDIO : undefined) };
}

const ai = (studio: Pick<StudioClient, "callTool">) => createAiTools({ studio, now: () => NOW });

const done = (answer: AskFirstAnswer) => assert.equal(answer.done, true, answer.message);
const refused = (answer: AskFirstAnswer, pattern?: RegExp) => {
  assert.equal(answer.done, false, "refused");
  if (pattern) assert.match(answer.message, pattern);
};

async function manifest(): Promise<PluginManifest> {
  return validateManifest(JSON.parse(await readFile(MANIFEST, "utf8")));
}

describe("the manifest's ask-first tools", () => {
  it("declares one card per tool: at most 300 characters, what goes to Roblox, and the person's Roblox account", async () => {
    const { tools } = await manifest();
    for (const name of Object.values(AskFirstTool)) {
      const tool = tools.find((one) => one.name === name);
      assert.ok(tool, `${name} is declared`);
      const card = tool.confirmation ?? "";
      assert.ok(card.length > 0 && card.length <= 300, `${name}: a card of 1-300 characters (${card.length})`);
      assert.match(card, /your Roblox account/, `${name}: runs on the person's Roblox account`);
      assert.match(card, /\bgoes to Roblox\b|\bgo to Roblox\b/, `${name}: says what leaves the computer`);
      assert.notEqual(tool.audience, "harness", `${name}: an agent's tool`);
      assert.deepEqual(tool.facts, ["roblox-project"], `${name}: only in Roblox games`);
    }
  });

  it("holds the Studio lock for every tool that changes or plays the place, and for none that only sends a picture or reads", async () => {
    const { tools } = await manifest();
    const needing = Object.values(AskFirstTool).filter((name) =>
      tools.find((tool) => tool.name === name)?.needs?.includes("studio"),
    );
    assert.deepEqual(needing, [
      AskFirstTool.GenerateMesh,
      AskFirstTool.GenerateModel,
      AskFirstTool.GenerateTexture,
      AskFirstTool.GenerateMaterial,
      AskFirstTool.SegmentMesh,
      AskFirstTool.RobloxPlaytest,
      AskFirstTool.InsertAsset,
    ]);
  });

  it("the connection offers none of the Studio tools behind them, and names the plugin's tool when one is called", async () => {
    const recorded = JSON.parse(await readFile(path.join(FIXTURES, "roblox-studio", "tools.json"), "utf8"));
    const reached: string[] = [];
    const client = {
      listTools: async () => recorded.tools,
      callTool: async (name: string) => {
        reached.push(name);
        return text("reached");
      },
      studios: async () => [],
      close: async () => undefined,
    } as unknown as StudioClient;
    const folder = await tmpDir("roblox-ai-bridge-");
    const bridge = createStudioMcp({
      client,
      folder,
      link: async () => undefined,
      running: async () => true,
      shrink: async (bytes) => bytes,
      now: () => NOW,
    });
    const [ours, theirs] = InMemoryTransport.createLinkedPair();
    const agent = new Client({ name: "test", version: "0" });
    await Promise.all([bridge.server.connect(theirs), agent.connect(ours)]);
    try {
      const listed = new Set((await agent.listTools()).tools.map((tool) => tool.name));
      for (const [tool, studio] of Object.entries(ASK_FIRST_STUDIO_TOOL)) {
        assert.ok(!listed.has(studio), `${studio} is not listed`);
        const answer = await agent.callTool({ name: studio, arguments: {} });
        assert.equal(answer.isError, true);
        const words = (answer.content as Array<{ text?: string }>).map((part) => part.text).join("\n");
        assert.ok(words.includes(`roblox__${tool}`), `${studio} names roblox__${tool}: ${words}`);
      }
      assert.deepEqual(reached, [], "no call reached Studio");
    } finally {
      await agent.close();
      await bridge.close();
    }
  });
});

describe("each tool's call to the game's Studio", () => {
  const CASES: Array<[AiTool, Record<string, unknown>, string, Record<string, unknown>]> = [
    [
      AskFirstTool.GenerateMesh,
      { prompt: "a red barrel", parts: "lid, body", triangles: 4000, width: 2, height: 3, depth: 2, background: true },
      "generate_mesh",
      {
        textPrompt: "a red barrel",
        partNames: '["lid","body"]',
        segmentation: "explicit",
        maxTriangles: 4000,
        size: { x: 2, y: 3, z: 2 },
        async: true,
      },
    ],
    [AskFirstTool.GenerateMesh, { prompt: "a crate" }, "generate_mesh", { textPrompt: "a crate" }],
    [
      AskFirstTool.GenerateModel,
      {
        prompt: "a go-kart with wheel size",
        image: "IMAGEID_42",
        parts: '["body", "wheels"]',
        segmentation: "explicit",
      },
      "generate_procedural_model",
      {
        prompt: "a go-kart with wheel size",
        attachedImageUri: "IMAGEID_42",
        partNames: '["body","wheels"]',
        segmentation: "explicit",
      },
    ],
    [
      AskFirstTool.GenerateModel,
      { prompt: "", image: "IMAGEID_7", segmentation: "none" },
      "generate_procedural_model",
      { prompt: "", attachedImageUri: "IMAGEID_7", segmentation: "none" },
    ],
    [
      AskFirstTool.GenerateTexture,
      { prompt: "rusty metal", instance: "Workspace.Barrel" },
      "generate_texture",
      { textPrompt: "rusty metal", instance_path: "Workspace.Barrel" },
    ],
    [
      AskFirstTool.GenerateMaterial,
      { name: "MossyBrick", base: "Brick", pattern: "Organic", description: "old bricks with moss" },
      "generate_material",
      {
        materialId: "MossyBrick",
        baseMaterial: "Brick",
        materialPattern: "Organic",
        materialDescription: "old bricks with moss",
      },
    ],
    [
      AskFirstTool.SegmentMesh,
      { parts: '["head", "body", "tail"]', instance: "Workspace.Dragon" },
      "segment_mesh",
      { parts: ["head", "body", "tail"], instance_path: "Workspace.Dragon" },
    ],
    [
      AskFirstTool.RobloxPlaytest,
      { task: "Play the obby to the end and say where a player gets stuck." },
      "subagent",
      {
        task: "Play the obby to the end and say where a player gets stuck.",
        description: "Playtesting the game",
        subagent_type: "playtest",
      },
    ],
    [
      AskFirstTool.RobloxExplore,
      { task: "Find every script that changes Coins.", title: "Finding coin scripts" },
      "subagent",
      { task: "Find every script that changes Coins.", description: "Finding coin scripts", subagent_type: "explore" },
    ],
    [
      AskFirstTool.UploadImage,
      { images: "https://cdn.example.com/a.png, https://cdn.example.com/b.jpg" },
      "upload_image",
      { imagePaths: ["https://cdn.example.com/a.png", "https://cdn.example.com/b.jpg"] },
    ],
  ];

  for (const [tool, args, studioTool, sent] of CASES)
    it(`${tool} ${JSON.stringify(args).slice(0, 60)} calls ${studioTool} in the game's Studio`, async () => {
      const game = await gameIn();
      const { studio, calls } = standIn();
      done(await ai(studio)[tool](args, game));
      assert.deepEqual(calls, [{ name: studioTool, args: { ...sent, studio_id: STUDIO } }]);
    });

  it("store-image hands Studio a private copy of the game's picture, removed once Studio answers", async () => {
    const game = await gameIn();
    await writeFile(path.join(game.folder, "art", "icon.png"), PNG);
    let seen: Buffer | undefined;
    const { studio, calls } = standIn(async (call) => {
      seen = await readFile(String(call.args.filePath));
      return text("IMAGEID_99");
    });
    const answer = await ai(studio)[AskFirstTool.StoreImage]({ file: "art/icon.png" }, game);
    done(answer);
    assert.match(answer.message, /IMAGEID_99/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, "store_image");
    assert.equal(calls[0]?.args.studio_id, STUDIO);
    const copy = String(calls[0]?.args.filePath);
    assert.ok(copy.startsWith(path.join(game.storage, "images") + path.sep), copy);
    assert.match(copy, /\.png$/);
    assert.deepEqual(seen, PNG, "Studio read the checked bytes");
    assert.deepEqual(await readdir(path.join(game.storage, "images")), [], "the copy is gone");
  });

  it("upload-image serves the game's own pictures to Studio on this computer only for the call, and answers by their names", async () => {
    const game = await gameIn();
    await writeFile(path.join(game.folder, "art", "coin.png"), PNG);
    await writeFile(path.join(game.folder, "art", "gem.jpg"), JPEG);
    const fetched: Buffer[] = [];
    const { studio, calls } = standIn(async (call) => {
      const urls = call.args.imagePaths as string[];
      const map: Record<string, string> = {};
      for (const [i, url] of urls.entries()) {
        if (url.startsWith("http://127.0.0.1:")) fetched.push(Buffer.from(await (await fetch(url)).arrayBuffer()));
        map[url] = `rbxassetid://${1000 + i}`;
      }
      return text(JSON.stringify(map));
    });
    const answer = await ai(studio)[AskFirstTool.UploadImage](
      { images: '["art/coin.png", "https://cdn.example.com/sky.png", "art/gem.jpg"]' },
      game,
    );
    done(answer);
    assert.deepEqual(answer.result, {
      "art/coin.png": "rbxassetid://1000",
      "https://cdn.example.com/sky.png": "rbxassetid://1001",
      "art/gem.jpg": "rbxassetid://1002",
    });
    assert.deepEqual(fetched, [PNG, JPEG]);
    const urls = calls[0]?.args.imagePaths as string[];
    assert.match(urls[0] ?? "", /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\.png$/);
    await assert.rejects(fetch(urls[0] ?? ""), "nothing is served once the call ended");
  });

  it("the image server answers only its own paths, and only GET", async () => {
    const server = await serveImages([{ name: "a.png", bytes: PNG, mime: "image/png", ext: ".png" }]);
    try {
      const [url] = server.urls;
      assert.equal((await fetch(url ?? "")).status, 200);
      const origin = new URL(url ?? "").origin;
      for (const other of ["/", "/a.png", "/../a.png", `${new URL(url ?? "").pathname}x`])
        assert.equal((await fetch(`${origin}${other}`)).status, 404, other);
      assert.equal((await fetch(url ?? "", { method: "POST", body: "x" })).status, 404);
      assert.equal(new URL(url ?? "").hostname, "127.0.0.1");
    } finally {
      await server.close();
    }
  });
});

describe("refused before anything reaches Studio", () => {
  const REFUSED: Array<[string, AiTool, Record<string, unknown>]> = [
    ["no prompt", AskFirstTool.GenerateMesh, { prompt: "" }],
    ["a prompt that isn't text", AskFirstTool.GenerateMesh, { prompt: 7 }],
    ["nine parts for a mesh", AskFirstTool.GenerateMesh, { prompt: "x", parts: "a,b,c,d,e,f,g,h,i" }],
    ["parts that aren't a list", AskFirstTool.GenerateMesh, { prompt: "x", parts: '["a", 2]' }],
    ["broken JSON parts", AskFirstTool.GenerateMesh, { prompt: "x", parts: '["a", "b"' }],
    ["a part name with a line break", AskFirstTool.GenerateMesh, { prompt: "x", parts: '["a\\nb"]' }],
    ["explicit parts with no names", AskFirstTool.GenerateMesh, { prompt: "x", segmentation: "explicit" }],
    ["parts with no segmentation", AskFirstTool.GenerateMesh, { prompt: "x", parts: "a", segmentation: "none" }],
    ["an unknown segmentation", AskFirstTool.GenerateMesh, { prompt: "x", segmentation: "some" }],
    ["too few triangles", AskFirstTool.GenerateMesh, { prompt: "x", triangles: 5 }],
    ["too many triangles", AskFirstTool.GenerateMesh, { prompt: "x", triangles: 20001 }],
    ["half a size", AskFirstTool.GenerateMesh, { prompt: "x", width: 2 }],
    ["a size of nothing", AskFirstTool.GenerateMesh, { prompt: "x", width: 0, height: 1, depth: 1 }],
    ["a model with no prompt and no picture", AskFirstTool.GenerateModel, { prompt: "" }],
    ["a picture that isn't Roblox's image id", AskFirstTool.GenerateModel, { prompt: "x", image: "/Users/a.png" }],
    ["an instance path with a line break", AskFirstTool.GenerateTexture, { prompt: "x", instance: "Workspace\nA" }],
    [
      "an unknown base material",
      AskFirstTool.GenerateMaterial,
      {
        name: "A",
        base: "Unobtainium",
        pattern: "Regular",
        description: "x",
      },
    ],
    [
      "an unknown pattern",
      AskFirstTool.GenerateMaterial,
      { name: "A", base: "Brick", pattern: "Wavy", description: "x" },
    ],
    [
      "a material name with a slash",
      AskFirstTool.GenerateMaterial,
      {
        name: "a/b",
        base: "Brick",
        pattern: "Regular",
        description: "x",
      },
    ],
    ["six parts to segment", AskFirstTool.SegmentMesh, { parts: "a,b,c,d,e,f" }],
    ["no parts to segment", AskFirstTool.SegmentMesh, { parts: " , " }],
    ["no task", AskFirstTool.RobloxPlaytest, { task: "" }],
    ["a task past its length", AskFirstTool.RobloxExplore, { task: "x".repeat(4001) }],
    ["no images", AskFirstTool.UploadImage, { images: "" }],
    [
      "eleven images",
      AskFirstTool.UploadImage,
      {
        images: Array.from({ length: 11 }, (_, i) => `https://cdn.example.com/${i}.png`).join(","),
      },
    ],
    ["an http address", AskFirstTool.UploadImage, { images: "http://cdn.example.com/a.png" }],
    ["localhost", AskFirstTool.UploadImage, { images: "https://localhost/a.png" }],
    ["a name under localhost", AskFirstTool.UploadImage, { images: "https://api.localhost/a.png" }],
    ["a loopback address", AskFirstTool.UploadImage, { images: "https://127.0.0.1/a.png" }],
    ["a private address", AskFirstTool.UploadImage, { images: "https://10.0.0.1/a.png" }],
    ["an IPv6 address", AskFirstTool.UploadImage, { images: "https://[::1]/a.png" }],
    ["an address with a password", AskFirstTool.UploadImage, { images: "https://ann:pw@cdn.example.com/a.png" }],
    ["a file address", AskFirstTool.UploadImage, { images: "file:///etc/passwd" }],
    ["a local network name", AskFirstTool.UploadImage, { images: "https://printer.local/a.png" }],
  ];

  for (const [why, tool, args] of REFUSED)
    it(`${tool}: ${why}`, async () => {
      const game = await gameIn();
      const { studio, calls } = standIn();
      refused(await ai(studio)[tool](args, game));
      assert.deepEqual(calls, [], "no Studio call");
    });

  it("with no Studio bound to the game, says so in plain words and calls nothing", async () => {
    const game = await gameIn(false);
    const { studio, calls } = standIn();
    refused(await ai(studio)[AskFirstTool.GenerateMesh]({ prompt: "a barrel" }, game), /isn't open in Roblox Studio/);
    assert.deepEqual(calls, []);
  });
});

describe("pictures from the game folder", () => {
  /** Each row lays out the folder, then names the picture the agent asks for. */
  const HOSTILE: Array<[string, (game: { folder: string; outside: string }) => Promise<string>]> = [
    ["a path out of the folder", async () => "../outside.png"],
    ["an absolute path", async ({ outside }) => outside],
    [
      "a link to a picture inside",
      async ({ folder }) => {
        await writeFile(path.join(folder, "art", "real.png"), PNG);
        await symlink(path.join(folder, "art", "real.png"), path.join(folder, "art", "alias.png"));
        return "art/alias.png";
      },
    ],
    [
      "a link to a picture outside",
      async ({ folder, outside }) => {
        await symlink(outside, path.join(folder, "art", "away.png"));
        return "art/away.png";
      },
    ],
    [
      "a linked folder on the way",
      async ({ folder, outside }) => {
        await symlink(path.dirname(outside), path.join(folder, "linked"));
        return `linked/${path.basename(outside)}`;
      },
    ],
    [
      "not a picture's extension",
      async ({ folder }) => {
        await writeFile(path.join(folder, "art", "notes.txt"), PNG);
        return "art/notes.txt";
      },
    ],
    [
      "text named like a picture",
      async ({ folder }) => {
        await writeFile(path.join(folder, "art", "fake.png"), "not a picture");
        return "art/fake.png";
      },
    ],
    [
      "a picture past 5 MB",
      async ({ folder }) => {
        await writeFile(path.join(folder, "art", "huge.png"), Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]));
        return "art/huge.png";
      },
    ],
    ["a missing picture", async () => "art/missing.png"],
    [
      "a folder",
      async ({ folder }) => {
        await mkdir(path.join(folder, "art", "dir.png"));
        return "art/dir.png";
      },
    ],
    ["a backslash path", async () => "art\\icon.png"],
  ];

  for (const [why, lay] of HOSTILE)
    for (const tool of [AskFirstTool.StoreImage, AskFirstTool.UploadImage])
      it(`${tool} refuses ${why}: no Studio call, no copy`, { skip: process.platform === "win32" }, async () => {
        const game = await gameIn();
        const outside = path.join(path.dirname(game.folder), "secret.png");
        await writeFile(outside, PNG);
        const file = await lay({ folder: game.folder, outside });
        const { studio, calls } = standIn();
        const args = tool === AskFirstTool.StoreImage ? { file } : { images: JSON.stringify([file]) };
        refused(await ai(studio)[tool](args, game));
        assert.deepEqual(calls, []);
        const copies = await readdir(path.join(game.storage, "images")).catch(() => []);
        assert.deepEqual(copies, []);
      });
});

describe("Studio's answers", () => {
  it("passes Studio's own refusal through in plain words: the daily cap on generated models", async () => {
    const game = await gameIn();
    const cap = "You have reached the limit of 50 procedural models in 24 hours. Try again later.";
    const { studio } = standIn(() => text(cap, true));
    const answer = await ai(studio)[AskFirstTool.GenerateModel]({ prompt: "a tower" }, game);
    refused(answer);
    assert.ok(answer.message.includes(cap), answer.message);
  });

  it("a Studio that stops answering mid-call says whether it finished is unknown", async () => {
    const game = await gameIn();
    const { studio } = standIn(() => {
      throw new Error("timed out");
    });
    refused(await ai(studio)[AskFirstTool.GenerateMesh]({ prompt: "a tower" }, game), /look at the place/i);
  });

  it("marks the agent busy around a generation, and the play test the playtest agent runs", async () => {
    const game = await gameIn();
    const seen: string[] = [];
    const { studio } = standIn(async (call) => {
      const files = await readdir(game.marks);
      seen.push(`${call.name}:${files.sort().join(",")}`);
      return text("done");
    });
    done(await ai(studio)[AskFirstTool.GenerateMesh]({ prompt: "a tower" }, game));
    const busy = JSON.parse(await readFile(path.join(game.marks, AGENT_BUSY_FILE), "utf8"));
    assert.deepEqual(busy, { since: NOW, until: NOW });
    done(await ai(studio)[AskFirstTool.RobloxPlaytest]({ task: "Play it." }, game));
    assert.deepEqual(seen, [
      `generate_mesh:${AGENT_BUSY_FILE}`,
      `subagent:${[AGENT_BUSY_FILE, AGENT_PLAY_FILE].sort()}`,
    ]);
    await assert.rejects(lstat(path.join(game.marks, AGENT_PLAY_FILE)), "the play mark is gone once it answers");
  });

  it("a playtest agent run during the agent's own play test leaves that play's mark as it was", async () => {
    const game = await gameIn();
    const running = JSON.stringify({ since: NOW - 60_000 });
    await writeFile(path.join(game.marks, AGENT_PLAY_FILE), running);
    const { studio } = standIn(async () => text("done"));
    done(await ai(studio)[AskFirstTool.RobloxPlaytest]({ task: "Play it." }, game));
    assert.equal(await readFile(path.join(game.marks, AGENT_PLAY_FILE), "utf8"), running);
  });
});

describe("through the backend", () => {
  // The fake Mac's paths are POSIX ones; the tools' own cases above hold on every system.
  const onMacWorld = { skip: process.platform === "win32" ? "the fake Mac helper is POSIX-only" : false };
  it(
    "each ask-first tool reaches the game's bound Studio, a worker copy's folder never handed to the script sync",
    onMacWorld,
    async () => {
      const mac = await robloxMac();
      const game = await makeGame(mac, "sky-race", "Sky race");
      const { studio, calls } = standIn((call) =>
        call.name === "search_asset"
          ? text(JSON.stringify({ results: [{ assetId: "580221169", isFree: true, priceCents: 0, name: "Tree" }] }))
          : text("{}"),
      );
      mac.deps.studio = studio as StudioClient;
      const seen: string[] = [];
      mac.deps.gameSeen = async (_storage, id) => {
        seen.push(id);
      };
      mac.deps.moments = {
        ask: () => () => Promise.reject(new Error("no helper calls in this case")),
        bound: (id) => (id === game.project ? STUDIO : undefined),
        flush: async () => {},
        reapply: async () => true,
        watch: createStudioWatch(mac.deps.now),
      } satisfies MomentServices;
      const backend = createRobloxBackend(mac.deps);
      const { context } = hostFor(mac, game);
      const answer = (await backend.tool?.(RobloxTool.GenerateMesh, { prompt: "a barrel" }, context)) as AskFirstAnswer;
      done(answer);
      const inserted = (await backend.tool?.(RobloxTool.InsertAsset, { id: "580221169" }, context)) as AskFirstAnswer;
      done(inserted);
      assert.ok(calls.length > 2);
      for (const call of calls) assert.equal(call.args.studio_id, STUDIO, call.name);
      assert.deepEqual(seen, [], "the script sync isn't told of a folder an ask-first call came with");
    },
  );
});

describe("each card in a chat, through a real core", () => {
  let lite: CoreLite;
  let threadId: string;
  let dir: string;

  before(async () => {
    lite = await coreLite({
      onUiEvent: (event: UiEventData) => {
        if (event.type !== UiEvent.PluginConsent) return;
        const payload = event.payload as { consentId: string; state: string };
        if (payload.state !== "pending") return;
        // Declined: nothing reaches the plugin, so no Studio is touched.
        void Promise.resolve().then(() => lite.core.resolveConsent(payload.consentId, false));
      },
    });
    await lite.core.plugins.setEnabled("roblox", true);
    dir = (await lite.core.games.scaffold("obby")).dir;
    threadId = await lite.core.threadForGame("obby");
    await lite.core.setPermissionMode(threadId, PermissionMode.Bypass);
  });

  after(async () => {
    lite.core.plugins.cancel();
    await lite.close();
  });

  it("in Bypass every ask-first tool still shows its card, and a no runs nothing", async () => {
    const { tools } = await manifest();
    const binding = { project: "obby", directory: dir, threadId };
    const ARGS: Record<AskFirstTool, Record<string, unknown>> = {
      [AskFirstTool.GenerateMesh]: { prompt: "a barrel" },
      [AskFirstTool.GenerateModel]: { prompt: "a tower" },
      [AskFirstTool.GenerateTexture]: { prompt: "rust" },
      [AskFirstTool.GenerateMaterial]: { name: "A", base: "Brick", pattern: "Regular", description: "x" },
      [AskFirstTool.SegmentMesh]: { parts: "a,b" },
      [AskFirstTool.RobloxPlaytest]: { task: "Play it." },
      [AskFirstTool.RobloxExplore]: { task: "Look." },
      [AskFirstTool.UploadImage]: { images: "https://cdn.example.com/a.png" },
      [AskFirstTool.StoreImage]: { file: "art/a.png" },
      [AskFirstTool.InsertAsset]: { id: "580221169" },
    };
    for (const tool of Object.values(AskFirstTool))
      await assert.rejects(lite.core.plugins.tool(`roblox__${tool}`, ARGS[tool], binding), /declin|not allow/i, tool);
    const events = await lite.core.store.listEvents(threadId);
    const asked = events.flatMap((event) => {
      const data = event.data as { event_type?: string; payload?: { state?: string; tool?: string } };
      return data.event_type === "plugin_consent" && data.payload?.state === "pending" ? [data.payload.tool] : [];
    });
    assert.deepEqual(
      asked,
      Object.values(AskFirstTool).map((tool) => `roblox__${tool}`),
      "each tool asked once, in the order called",
    );
    const cards = toEntries(events).filter((entry) => (entry as { consentId?: string }).consentId) as Array<
      Parameters<typeof consentTitle>[0] & { pending?: boolean }
    >;
    assert.equal(cards.length, Object.values(AskFirstTool).length);
    for (const [i, tool] of Object.values(AskFirstTool).entries()) {
      const card = cards[i];
      assert.ok(card);
      assert.equal(consentTitle(card), tools.find((one) => one.name === tool)?.confirmation, tool);
      assert.deepEqual(
        consentChoices(card).map((choice) => choice.id),
        [ConsentChoice.Once, ConsentChoice.Decline],
        `${tool}: no Always allow`,
      );
      assert.equal(card.pending, false, `${tool}: answered`);
    }
  });
});
