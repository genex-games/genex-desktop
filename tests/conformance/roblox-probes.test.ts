/**
 * The Roblox judges' probes (`plugins/roblox/probes.ts`) over a stand-in Roblox Studio with a play
 * test running: the cheater's hostile calls to every remote and the server's state before and after
 * each (skipped when the play reaches the live game's saved data), the phone check's four screen
 * sizes with their pictures, interface findings and memory against a phone's budget (the simulated
 * device always put back), and the multiplayer check of what each client sees of every player. Then
 * the three judges as the manifest declares them and as the built package carries them.
 */
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { before, describe, it } from "node:test";
import type { PlayGame } from "../../src/plugins/roblox/computer-play.ts";
import {
  CHEAT_MAX_MS,
  createProbes,
  type PhoneMeasure,
  PHONE_MEMORY_BUDGET_MB,
  PHONE_SIZES,
  phoneFindings,
  placeMemoryMb,
  type PlayView,
  ProbeLuauFile,
  probeCode,
  RobloxProbe,
  serverState,
  stateChanges,
} from "../../src/plugins/roblox/probes.ts";
import { PLAY_LUAU } from "../../src/plugins/roblox/play-luau.ts";
import type { StudioToolResult } from "../../src/plugins/roblox/studio-client.ts";
import { MAX_PLAY_PLAYERS } from "../../src/shared/engine-play.ts";
import type { PluginManifest } from "../../src/shared/plugins.ts";
import { inspectPackage } from "../../src/substrate/plugins/manifest.ts";
import { makeResources } from "../helpers/resources.ts";

/** A stand-in for a probe's Luau file: the stand-in Studio reads only the step's arguments. */
const standIn = async (file: ProbeLuauFile) => `-- ${file}, a stand-in\nreturn function(args) return args end`;
const SHOP = ["ReplicatedStorage", "Shop", "BuyItem"];
const PRICE = ["ReplicatedStorage", "Shop", "GetPrice"];
const EDIT = "edit-1";

const text = (value: string, isError = false): StudioToolResult => ({
  content: [{ type: "text", text: value }],
  isError,
});
const picture = (bytes = 1_000): StudioToolResult => ({
  content: [{ type: "image", data: Buffer.alloc(bytes, 7).toString("base64"), mimeType: "image/jpeg" }],
});

/** The arguments a probe's Luau step was sent with: the JSON in its last long string. */
function stepArgs(code: string): Record<string, unknown> {
  const found = /JSONDecode\(\[(=*)\[([\s\S]*)\]\1\]\)\)$/.exec(code);
  assert.ok(found, "the step's arguments close the code");
  return JSON.parse(found[2] ?? "{}");
}

/** The play the probes measure: the game's Studio, its server and its players, as `computer-play` holds it. */
function playOf(players = 1, liveData = false): PlayView {
  if (players === 1) return { server: EDIT, players: [EDIT], liveData };
  return { server: "server", players: Array.from({ length: players }, (_, i) => `client-${i + 1}`), liveData };
}

const GAME: PlayGame = {
  storage: "/storage",
  game: "shop",
  edit: () => EDIT,
  ask: (async () => ({})) as never,
};

interface Call {
  name: string;
  args: Record<string, unknown>;
}

/** A stand-in Studio playing a sample shop whose BuyItem trusts the price a client sends, unless fixed. */
function shopWorld(
  options: { fixed?: boolean; sells?: boolean; remotes?: string[][]; dropsAfter?: string; stepMs?: number } = {},
) {
  const calls: Call[] = [];
  const read: string[] = [];
  let clock = 1_000_000;
  let coins = 100;
  let answering = true;
  const remotes = options.remotes ?? [SHOP, PRICE];
  const callTool = async (name: string, args: Record<string, unknown>): Promise<StudioToolResult> => {
    calls.push({ name, args });
    clock += options.stepMs ?? 100;
    if (name !== "execute_luau") return text(`no ${name}`, true);
    const code = String(args.code);
    const step = stepArgs(code);
    if (args.datamodel_type === "Server" && step.op === "state")
      return text(
        JSON.stringify({
          players: { "9172881962": { name: "Builder", leaderstats: { Coins: coins }, attributes: [] } },
          server: [],
        }),
      );
    if (!answering) return text("Client datamodel is not available", true);
    if (args.datamodel_type === "Client" && step.op === "list")
      return text(JSON.stringify({ remotes, words: ["Sword", "Shield"] }));
    if (args.datamodel_type === "Client" && step.op === "fire") {
      const remote = (step.remote as string[]).join(".");
      if (remote === SHOP.join(".") && !options.fixed) coins += 500;
      // A fixed shop that sells at its own price: a request naming a real item buys it.
      if (remote === SHOP.join(".") && options.sells) coins -= 50;
      if (remote === options.dropsAfter) answering = false;
      return text(JSON.stringify({ fired: 230 }));
    }
    return text("Target is not reachable", true);
  };
  const deps = {
    studio: { callTool },
    shrink: async (bytes: Buffer) => bytes,
    now: () => clock,
    luau: async (file: ProbeLuauFile) => {
      read.push(file);
      return standIn(file);
    },
  };
  return { calls, read, deps, coins: () => coins };
}

const fired = (calls: Call[]) =>
  calls
    .filter((one) => one.name === "execute_luau" && stepArgs(String(one.args.code)).op === "fire")
    .map((one) => (stepArgs(String(one.args.code)).remote as string[]).join("."));

describe("Roblox probes: the step code", () => {
  it("wraps the package's Luau as a function and sends its arguments in a long string no value can close", () => {
    const code = probeCode("return function(args) return args.op end", { op: "list", word: "]]" });
    assert.match(code, /^return \(function\(\)\n/);
    assert.match(code, /return function\(args\) return args\.op end/);
    assert.deepEqual(stepArgs(code), { op: "list", word: "]]" });
    const nasty = probeCode("return function(a) end", { word: "]=]]==]" });
    assert.deepEqual(stepArgs(nasty), { word: "]=]]==]" });
  });
});

describe("Roblox probes: the cheater", () => {
  it("fires hostile values at every remote from the player's client and reports the planted negative price", async () => {
    const world = shopWorld();
    const probes = createProbes(world.deps, () => playOf());
    const answer = (await probes[RobloxProbe.CheatRemotes]({}, GAME)) as { note: string; images: unknown[] };
    assert.deepEqual(fired(world.calls), ["ReplicatedStorage.Shop.BuyItem", "ReplicatedStorage.Shop.GetPrice"]);
    assert.deepEqual(world.read, [ProbeLuauFile.CheatRemotes], "the Luau is read from the package");
    for (const call of world.calls) {
      const op = stepArgs(String(call.args.code)).op;
      assert.equal(call.args.studio_id, EDIT);
      assert.equal(call.args.datamodel_type, op === "state" ? "Server" : "Client", `${op} runs where it belongs`);
      assert.match(String(call.args.code), /cheat-remotes/, "the code is the package's file");
    }
    const firstFire = world.calls.find((one) => stepArgs(String(one.args.code)).op === "fire");
    assert.deepEqual(
      stepArgs(String(firstFire?.args.code)).words,
      ["Sword", "Shield"],
      "the game's own words go first",
    );
    assert.match(answer.note, /2 remotes/);
    assert.match(answer.note, /ReplicatedStorage\.Shop\.BuyItem: Builder's Coins went from 100 to 600/);
    assert.doesNotMatch(answer.note, /GetPrice:/, "a remote that changed nothing isn't named as a change");
  });

  it("passes the fixed shop: no server state changed", async () => {
    const world = shopWorld({ fixed: true });
    const answer = (await createProbes(world.deps, () => playOf())[RobloxProbe.CheatRemotes]({}, GAME)) as {
      note: string;
    };
    assert.equal(world.coins(), 100);
    assert.match(answer.note, /The server's state didn't change after any of them\./);
  });

  it("tells a payment a normal purchase makes apart from a cheat: the fixed shop sells at its own price", async () => {
    const world = shopWorld({ fixed: true, sells: true });
    const answer = (await createProbes(world.deps, () => playOf())[RobloxProbe.CheatRemotes]({}, GAME)) as {
      note: string;
    };
    assert.match(answer.note, /No change looked like a cheat\./);
    assert.match(answer.note, /only spent, as a normal purchase does/);
    assert.match(answer.note, /ReplicatedStorage\.Shop\.BuyItem: Builder's Coins went from 100 to 50/);
  });

  it("reads gains, negatives, broken numbers, text and a player gone as a cheat's changes", () => {
    const before = serverState({
      players: { "1": { name: "Ann", leaderstats: { Coins: 100, Rank: "Bronze", Gems: 5, Hp: 10 } } },
    });
    const cases: Array<[after: Record<string, unknown>, cheat: boolean]> = [
      [{ players: { "1": { name: "Ann", leaderstats: { Coins: 600, Rank: "Bronze", Gems: 5, Hp: 10 } } } }, true],
      [{ players: { "1": { name: "Ann", leaderstats: { Coins: -5, Rank: "Bronze", Gems: 5, Hp: 10 } } } }, true],
      [{ players: { "1": { name: "Ann", leaderstats: { Coins: "NaN", Rank: "Bronze", Gems: 5, Hp: 10 } } } }, true],
      [{ players: { "1": { name: "Ann", leaderstats: { Coins: 100, Rank: "Gold", Gems: 5, Hp: 10 } } } }, true],
      [{ players: {} }, true],
      [{ players: { "1": { name: "Ann", leaderstats: { Coins: 40, Rank: "Bronze", Gems: 5, Hp: 10 } } } }, false],
    ];
    for (const [after, cheat] of cases) {
      const changes = stateChanges(before, serverState(after));
      assert.equal(changes.length, 1, JSON.stringify(after));
      assert.equal(changes[0]?.cheat, cheat, changes[0]?.words);
    }
  });

  it("skips with a plain note, firing nothing, when the play reaches the live game's saved data", async () => {
    const world = shopWorld();
    const answer = (await createProbes(world.deps, () => playOf(1, true))[RobloxProbe.CheatRemotes]({}, GAME)) as {
      note: string;
    };
    assert.deepEqual(world.calls, [], "nothing is asked of Studio, nothing fired");
    assert.match(answer.note, /didn't send anything/);
    assert.match(answer.note, /live game's saved data/);
    assert.match(answer.note, /Game Settings › Security › Enable Studio Access to API Services/);
    assert.equal(world.coins(), 100);
  });

  it("says so when the game has no remotes a client reaches", async () => {
    const world = shopWorld({ remotes: [] });
    const answer = (await createProbes(world.deps, () => playOf())[RobloxProbe.CheatRemotes]({}, GAME)) as {
      note: string;
    };
    assert.match(answer.note, /no remotes a player's client can reach/);
    assert.deepEqual(fired(world.calls), []);
  });

  it(`stops starting remotes after ${CHEAT_MAX_MS / 1000} s on its clock, naming those not tried`, async () => {
    const many = Array.from({ length: 30 }, (_, i) => ["ReplicatedStorage", `Remote${i + 1}`]);
    const world = shopWorld({ remotes: many, stepMs: 4_000 });
    const answer = (await createProbes(world.deps, () => playOf())[RobloxProbe.CheatRemotes]({}, GAME)) as {
      note: string;
    };
    const tried = fired(world.calls).length;
    assert.ok(tried > 0 && tried < 30, `some remotes, not all: ${tried}`);
    assert.match(answer.note, new RegExp(`${30 - tried} not tried in time`));
    assert.match(answer.note, new RegExp(`ReplicatedStorage\\.Remote${tried + 1}`));
  });

  it("stops when the player's client stops answering after a remote, naming it", async () => {
    const world = shopWorld({ dropsAfter: SHOP.join("."), fixed: true });
    const answer = (await createProbes(world.deps, () => playOf())[RobloxProbe.CheatRemotes]({}, GAME)) as {
      note: string;
    };
    assert.deepEqual(fired(world.calls), ["ReplicatedStorage.Shop.BuyItem", "ReplicatedStorage.Shop.GetPrice"]);
    assert.match(answer.note, /After ReplicatedStorage\.Shop\.BuyItem the player's client stopped answering/);
  });

  it("answers in words when no play is running", async () => {
    const world = shopWorld();
    const answer = (await createProbes(world.deps, () => undefined)[RobloxProbe.CheatRemotes]({}, GAME)) as {
      note: string;
    };
    assert.match(answer.note, /No play test is running/);
    assert.deepEqual(world.calls, []);
  });
});

/** A phone measure: the view, the safe area, Roblox's top-bar buttons, elements and memory. */
function measure(fields: Partial<PhoneMeasure> = {}): PhoneMeasure {
  return {
    device: "iphone_13",
    orientation: "LandscapeRight",
    view: [749, 388],
    safe: [47, 0, 655, 367],
    roblox: [0, 0, 164, 58],
    elements: [],
    memory: { Instances: 40, GraphicsTexture: 20, LuaHeap: 900, Internal: 800, Script: 300 },
    ...fields,
  };
}

const element = (id: number, path: string, box: number[], extra: Record<string, unknown> = {}) => ({
  id,
  path,
  class: "TextButton",
  box,
  pressable: true,
  clipped: false,
  touch: false,
  ...extra,
});

describe("Roblox probes: phone findings", () => {
  const cases: Array<[name: string, elements: ReturnType<typeof element>[], words: RegExp | null]> = [
    [
      "a button under the jump button",
      [
        element(1, "ShopGui.Buy", [640, 280, 90, 90]),
        element(2, "TouchGui.TouchControlFrame.JumpButton", [650, 290, 70, 70], { class: "ImageButton", touch: true }),
      ],
      /ShopGui\.Buy overlaps Roblox's jump button/,
    ],
    [
      "two of the game's buttons on each other",
      [element(1, "Hud.Sell", [100, 100, 80, 40]), element(2, "Hud.Buy", [110, 110, 80, 40])],
      /Hud\.Sell and Hud\.Buy overlap/,
    ],
    [
      "a button past the screen's right edge",
      [element(1, "Hud.Close", [720, 10, 60, 30])],
      /Hud\.Close runs off the screen/,
    ],
    [
      "text outside the safe area",
      [element(1, "Hud.Title", [10, 200, 30, 20], { class: "TextLabel", pressable: false, text: "Coins" })],
      /Hud\.Title \("Coins"\) is outside the safe area/,
    ],
    [
      "a button under Roblox's own top-bar buttons",
      [element(1, "Hud.Menu", [60, 10, 40, 30])],
      /Hud\.Menu sits under Roblox's own buttons/,
    ],
    [
      "a label inside its own button",
      [
        element(1, "Hud.Buy", [300, 100, 80, 40]),
        element(2, "Hud.Buy.Label", [305, 105, 70, 30], { under: 1, pressable: false, text: "Buy" }),
      ],
      null,
    ],
    [
      "a clipped item in a scrolling list",
      [element(1, "Shop.List.Item9", [300, 380, 80, 40], { clipped: true })],
      null,
    ],
    [
      "Roblox's move stick and jump button near each other",
      [
        element(1, "TouchGui.TouchControlFrame.JumpButton", [650, 290, 70, 70], { touch: true }),
        element(2, "TouchGui.TouchControlFrame.ThumbstickFrame", [660, 300, 60, 60], { touch: true }),
      ],
      null,
    ],
  ];
  for (const [name, elements, words] of cases) {
    it(words ? `finds ${name}` : `finds nothing for ${name}`, () => {
      const found = phoneFindings(measure({ elements }));
      if (words) assert.match(found.join("\n"), words);
      else assert.deepEqual(found, []);
    });
  }

  it("counts the place's own memory, not Studio's", () => {
    assert.equal(
      placeMemoryMb({ Instances: 40, GraphicsTexture: 20.4, LuaHeap: 900, Internal: 800, Script: 300 }),
      60.4,
    );
  });
});

/** A stand-in Studio for the phone check: a device it remembers, a layout per device, pictures. */
function phoneWorld(
  options: { layout?: PhoneMeasure["elements"]; memory?: PhoneMeasure["memory"]; failAt?: number } = {},
) {
  const calls: Call[] = [];
  let device = { device: "iphone_6_Plus", orientation: "Portrait" as string | undefined };
  let measures = 0;
  const callTool = async (name: string, args: Record<string, unknown>): Promise<StudioToolResult> => {
    calls.push({ name, args });
    if (name === "screen_capture") return picture();
    const step = stepArgs(String(args.code));
    if (args.datamodel_type !== "Client") return text("Target is not reachable", true);
    if (step.op === "current") return text(JSON.stringify(device));
    if (step.op === "restore") {
      device = { device: String(step.device), orientation: step.orientation as string | undefined };
      return text(JSON.stringify({ device: device.device }));
    }
    if (step.op === "measure") {
      measures++;
      if (measures === options.failAt) return text("StudioDeviceSimulatorService: busy", true);
      device = { device: String(step.device), orientation: String(step.orientation) };
      const portrait = step.orientation === "Portrait";
      return text(
        JSON.stringify(
          measure({
            device: String(step.device),
            orientation: String(step.orientation),
            view: portrait ? [388, 762] : [749, 388],
            elements: options.layout ?? [],
            memory: options.memory ?? { Instances: 40, GraphicsTexture: 20 },
          }),
        ),
      );
    }
    return text("unknown step", true);
  };
  const deps = {
    studio: { callTool },
    shrink: async (bytes: Buffer) => bytes,
    now: () => 0,
    luau: standIn,
  };
  return { calls, deps, device: () => device };
}

describe("Roblox probes: the phone check", () => {
  it("measures a phone and a tablet upright and sideways, a picture each, then puts the device back", async () => {
    const overlap = [
      element(1, "ShopGui.Buy", [640, 280, 90, 90]),
      element(2, "TouchGui.TouchControlFrame.JumpButton", [650, 290, 70, 70], { touch: true }),
    ];
    const world = phoneWorld({ layout: overlap });
    const answer = (await createProbes(world.deps, () => playOf())[RobloxProbe.PhoneCheck]({}, GAME)) as {
      note: string;
      images: Array<{ mimeType: string; data: string; label: string }>;
    };
    const measured = world.calls
      .filter((one) => one.name === "execute_luau" && stepArgs(String(one.args.code)).op === "measure")
      .map((one) => {
        const step = stepArgs(String(one.args.code));
        return `${step.device} ${step.orientation}`;
      });
    assert.deepEqual(
      measured,
      PHONE_SIZES.map((size) => `${size.device} ${size.orientation}`),
    );
    assert.equal(PHONE_SIZES.length, 4);
    assert.deepEqual(
      answer.images.map((image) => [image.mimeType, image.label]),
      PHONE_SIZES.map((size) => ["image/jpeg", size.label]),
    );
    assert.equal(world.calls.filter((one) => one.name === "screen_capture").length, 4);
    assert.deepEqual(
      world.device(),
      { device: "iphone_6_Plus", orientation: "Portrait" },
      "the earlier device is back",
    );
    assert.match(answer.note, /ShopGui\.Buy overlaps Roblox's jump button/);
    assert.match(answer.note, new RegExp(`within a phone's budget of ${PHONE_MEMORY_BUDGET_MB} MB`));
  });

  it("reports memory over a phone's budget", async () => {
    const world = phoneWorld({ memory: { Instances: PHONE_MEMORY_BUDGET_MB, GraphicsTexture: 150 } });
    const answer = (await createProbes(world.deps, () => playOf())[RobloxProbe.PhoneCheck]({}, GAME)) as {
      note: string;
    };
    assert.match(answer.note, new RegExp(`over a phone's budget of ${PHONE_MEMORY_BUDGET_MB} MB`));
    assert.match(answer.note, new RegExp(`about ${PHONE_MEMORY_BUDGET_MB + 150} MB`));
  });

  it("puts the device back even when a size fails, and names what it couldn't measure", async () => {
    const world = phoneWorld({ failAt: 2 });
    const answer = (await createProbes(world.deps, () => playOf())[RobloxProbe.PhoneCheck]({}, GAME)) as {
      note: string;
      images: unknown[];
    };
    assert.deepEqual(world.device(), { device: "iphone_6_Plus", orientation: "Portrait" });
    assert.match(answer.note, new RegExp(`${PHONE_SIZES[1]?.label}: Studio couldn't show this size`));
    assert.equal(answer.images.length, 3);
  });
});

describe("Roblox probes: the multiplayer check", () => {
  /** Every player as one data model sees them. */
  const seen = (players: Array<{ userId: number; name: string; leaderstats?: Record<string, unknown> }>) =>
    text(
      JSON.stringify({ players: players.map((one) => ({ attributes: [], leaderstats: [], ...one })), gameSeconds: 9 }),
    );
  const SERVER_VIEW = [
    { userId: -1, name: "Player1", leaderstats: { Coins: 5 } },
    { userId: -2, name: "Player2", leaderstats: { Coins: 50 } },
    { userId: -3, name: "Player3", leaderstats: { Coins: 0 } },
  ];

  it("gives each player's picture and names what a client sees differently from the server", async () => {
    const calls: Call[] = [];
    const callTool = async (name: string, args: Record<string, unknown>): Promise<StudioToolResult> => {
      calls.push({ name, args });
      if (name === "screen_capture") return picture();
      if (args.code !== PLAY_LUAU.ServerState) return text("unknown", true);
      if (args.studio_id === "server" && args.datamodel_type === "Server") return seen(SERVER_VIEW);
      if (args.studio_id === "client-1") return seen(SERVER_VIEW);
      if (args.studio_id === "client-2") return seen(SERVER_VIEW.slice(0, 2));
      if (args.studio_id === "client-3")
        return seen(SERVER_VIEW.map((one) => (one.userId === -2 ? { ...one, leaderstats: { Coins: 0 } } : one)));
      return text("Target is not reachable", true);
    };
    const deps = { studio: { callTool }, shrink: async (b: Buffer) => b, now: () => 0, luau: async () => "" };
    const answer = (await createProbes(deps, () => playOf(3))[RobloxProbe.PlayersState]({ players: 3 }, GAME)) as {
      note: string;
      images: Array<{ label: string }>;
    };
    assert.deepEqual(
      answer.images.map((image) => image.label),
      ["Player 1", "Player 2", "Player 3"],
    );
    assert.deepEqual(
      calls.filter((one) => one.name === "screen_capture").map((one) => one.args.studio_id),
      ["client-1", "client-2", "client-3"],
    );
    assert.match(answer.note, /3 players joined: Player1, Player2, Player3/);
    assert.match(answer.note, /Player 2 doesn't see Player3/);
    assert.match(answer.note, /Player 3 sees Player2's Coins as 0; the server has 50/);
    assert.doesNotMatch(answer.note, /Player 1 (doesn't|sees)/, "player 1 sees what the server sees");
  });

  it("says when fewer players joined than the play opened", async () => {
    const callTool = async (name: string, args: Record<string, unknown>): Promise<StudioToolResult> => {
      if (name === "screen_capture") return picture();
      return args.datamodel_type === "Server" || args.studio_id ? seen(SERVER_VIEW.slice(0, 2)) : text("", true);
    };
    const deps = { studio: { callTool }, shrink: async (b: Buffer) => b, now: () => 0, luau: async () => "" };
    const answer = (await createProbes(deps, () => playOf(3))[RobloxProbe.PlayersState]({ players: 3 }, GAME)) as {
      note: string;
    };
    assert.match(answer.note, /The server has 2 of the 3 players/);
    assert.match(answer.note, /^2 players joined: Player1, Player2\./);
  });
});

describe("Roblox judges in the built package", () => {
  let roblox = "";
  let manifest: PluginManifest;
  before(async () => {
    roblox = path.join(await makeResources({ tsc: false }), "plugins", "roblox");
    manifest = await inspectPackage(roblox);
  });

  it("declares the multiplayer, cheater and phone judges, each within the players the engine plays", () => {
    assert.deepEqual(
      manifest.judges?.map(({ id, label, players, probe, facts }) => ({ id, label, players, probe, facts })),
      [
        { id: "multiplayer", label: "Multiplayer", players: 3, probe: "players-state", facts: ["roblox-project"] },
        { id: "cheater", label: "Cheater", players: 1, probe: "cheat-remotes", facts: ["roblox-project"] },
        { id: "phone", label: "Phone", players: 1, probe: "phone-check", facts: ["roblox-project"] },
      ],
    );
    for (const judge of manifest.judges ?? [])
      assert.ok(
        (judge.players ?? 1) <= (manifest.engine?.play?.players ?? 1) && (judge.players ?? 1) <= MAX_PLAY_PLAYERS,
      );
  });

  it("gives each judge a brief in the player's words: no code", async () => {
    for (const judge of manifest.judges ?? []) {
      const brief = await readFile(path.join(roblox, judge.brief), "utf8");
      assert.doesNotMatch(
        brief,
        /\b(code|script|scripts|Luau|function|execute_luau|RemoteEvent|RemoteFunction|source)\b/i,
        judge.id,
      );
      assert.doesNotMatch(brief, /\b(overnight|night|morning|tonight)\b/i, judge.id);
    }
  });

  it("ships the probes' Luau beside the backend, where the backend reads it", async () => {
    for (const file of Object.values(ProbeLuauFile)) {
      const shipped = await stat(path.join(roblox, file)).catch(() => null);
      assert.ok(shipped?.isFile() && shipped.size > 0, `${file} is beside backend.mjs`);
    }
  });
});
