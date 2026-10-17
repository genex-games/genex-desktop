/**
 * The Roblox plugin's play tools (`plugins/roblox/computer-play.ts`) over a stand-in Roblox Studio
 * and Genex helper on the test's clock: Play Solo for one player, the helper's multiplayer test for
 * more with each client told apart by its test player, keys held in one call, shots per player
 * (shrunk or refused past 1 MB), state from the client and the server, no pause, the play always
 * ended, the agent's play mark around it, and the live saved data asked of a published place.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { readAgentMarks } from "../../src/plugins/roblox/agent-marks.ts";
import { createRobloxBackend, RobloxTool } from "../../src/plugins/roblox/backend.ts";
import {
  createComputerPlay,
  jpegSize,
  type PlayGame,
  parseStudioState,
  TEST_START_MS,
} from "../../src/plugins/roblox/computer-play.ts";
import { type HelperAsk, HelperLinkError, HelperLinkFailure } from "../../src/plugins/roblox/helper-link.ts";
import { HelperErrorCode, HelperMessage } from "../../src/plugins/roblox/helper-protocol.ts";
import { robloxKey, robloxKeyNames, robloxMouseButton } from "../../src/plugins/roblox/keys.ts";
import { readLiveData } from "../../src/plugins/roblox/live-data.ts";
import type { MomentServices } from "../../src/plugins/roblox/moment-ops.ts";
import { PLAY_LUAU } from "../../src/plugins/roblox/play-luau.ts";
import type { StudioToolResult } from "../../src/plugins/roblox/studio-client.ts";
import { createStudioWatch } from "../../src/plugins/roblox/studio-moments.ts";
import {
  EnginePlayRefusal,
  EnginePlayTool,
  MAX_PLAY_INPUT_SECONDS,
  MAX_PLAY_SHOT_BYTES,
} from "../../src/shared/engine-play.ts";
import { hostFor, makeGame, robloxMac } from "../helpers/roblox-mac.ts";
import { tmpDir } from "../helpers/tmp.ts";

const GAME = "sky-race";
const EDIT = "edit-1";
const SERVER = "test-server";
/** The signed-in account Play Solo plays as (a real UserId), and a test player's. */
const ACCOUNT = 9172881962;
const KEY_CODES: string[] = JSON.parse(
  await readFile(path.join(import.meta.dirname, "../fixtures/roblox-studio/key-codes.json"), "utf8"),
).keyCodes;

/** A JPEG of `bytes` bytes that says it is `width` by `height` (its first frame header, then padding). */
function jpeg(bytes: number, width = 1684, height = 1080): Buffer {
  const head = Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
  ]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length))]);
}

const text = (value: string, isError = false): StudioToolResult => ({
  content: [{ type: "text", text: value }],
  isError,
});
const PLAYING =
  "- Current Studio Mode: Play\n- Available DataModels: Client, Server\n- Focused DataModel in the viewport: Client";
const EDITING = "- Current Studio Mode: Edit\n- Available DataModels: Edit\n- Focused DataModel in the viewport: Edit";

interface WorldOptions {
  /** Polls of the Studio list before a started test's Studios appear. */
  listAfter?: number;
  /** What the play's server answers on the live-data check; "fails" answers an error. */
  liveData?: boolean | "fails";
  shot?: Buffer;
  shrink?: (bytes: Buffer) => Promise<Buffer>;
  /** What the helper answers a multiplayer test: started, or its own error code. */
  multiplayer?: "start" | typeof HelperErrorCode.Busy | typeof HelperErrorCode.Unsupported;
  stopThrows?: boolean;
  /** A play already running in the game's Studio when the session starts. */
  soloRunning?: boolean;
}

/** A stand-in Studio (the game's own, plus a test's server and clients once one starts) and helper. */
async function playWorld(options: WorldOptions = {}) {
  const storage = await tmpDir("roblox-play-");
  const marks = path.join(storage, "mcp", GAME);
  await mkdir(marks, { recursive: true });
  let clock = 5_000_000;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const asked: string[] = [];
  const studio = {
    mode: options.soloRunning ? ("solo" as const) : ("edit" as "edit" | "solo" | "test"),
    testPlayers: 0,
    lists: 0,
    startedAt: 0,
    markedAtStart: [] as boolean[],
  };
  // The test's Studios in the order Studio lists them: not by player.
  const testIds = () =>
    studio.testPlayers === 0
      ? []
      : [
          "client-2",
          SERVER,
          ...Array.from({ length: studio.testPlayers }, (_, i) => `client-${i + 1}`).filter((id) => id !== "client-2"),
        ];
  const clientOf = (id: string) => (/^client-(\d)$/.exec(id) ? Number(id.slice(7)) : null);
  const playingIn = (id: string) => (id === EDIT ? studio.mode === "solo" : testIds().includes(id));
  const luau = (id: string, dataModel: unknown, code: unknown): StudioToolResult => {
    const client = clientOf(id);
    const isClient = dataModel === "Client" && ((id === EDIT && studio.mode === "solo") || client !== null);
    const isServer = dataModel === "Server" && ((id === EDIT && studio.mode === "solo") || id === SERVER);
    if (code === PLAY_LUAU.WhoAmI && isClient) {
      const who =
        client === null
          ? { userId: ACCOUNT, name: "Builder", view: [1336, 731] }
          : { userId: -client, name: `Player${client}`, view: [1081, 693] };
      return text(JSON.stringify(who));
    }
    if (code === PLAY_LUAU.IsServer && isServer) return text("server");
    if (code === PLAY_LUAU.ClientState && isClient)
      return text(JSON.stringify({ userId: client === null ? ACCOUNT : -client, position: [1, 3, client ?? 0] }));
    if (code === PLAY_LUAU.ServerState && isServer)
      return text(JSON.stringify({ players: [{ userId: -1 }], gameSeconds: 4 }));
    if (code === PLAY_LUAU.GameSeconds && isClient) return text("12.5");
    if (code === PLAY_LUAU.LiveData && isServer && options.liveData === "fails") return text("Script timed out", true);
    if (code === PLAY_LUAU.LiveData && isServer) return text(options.liveData ? "true" : "false");
    if (code === PLAY_LUAU.EndTest && isServer && id === SERVER) {
      studio.testPlayers = 0;
      studio.mode = "edit";
      return text("ended");
    }
    return text("Target is not reachable", true);
  };
  const callTool = async (name: string, args: Record<string, unknown>): Promise<StudioToolResult> => {
    calls.push({ name, args });
    const id = String(args.studio_id);
    switch (name) {
      case "get_studio_state":
        return text(playingIn(id) ? PLAYING : EDITING);
      case "start_stop_play":
        if (args.is_start === false && options.stopThrows) throw new Error("StudioMCP ended");
        studio.markedAtStart.push(existsSync(path.join(marks, "agent-play.json")));
        studio.mode = args.is_start ? "solo" : "edit";
        return text(args.is_start ? "Game Started" : "Game Stopped");
      case "execute_luau":
        return luau(id, args.datamodel_type, args.code);
      case "screen_capture": {
        if (!playingIn(id) || id === SERVER) return text("missing field data", true);
        const shot = options.shot ?? jpeg(120_000);
        return { content: [{ type: "image", data: shot.toString("base64"), mimeType: "image/jpeg" }] };
      }
      case "user_keyboard_input":
      case "user_mouse_input":
        return playingIn(id) ? text("Success") : text("Client datamodel is not available", true);
      case "get_console_output":
        return text(Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"));
      default:
        return text(`no ${name} here`, true);
    }
  };
  const studios = async () => {
    studio.lists++;
    const listed = [
      { id: EDIT, name: `${GAME}.rbxlx` },
      { id: "other", name: "Place1" },
    ];
    const ready = studio.testPlayers > 0 && studio.lists - studio.startedAt > (options.listAfter ?? 2);
    return ready ? [...testIds().map((id) => ({ id, name: "" })), ...listed] : listed;
  };
  const answered = (code: string, message: string) => new HelperLinkError(HelperLinkFailure.Answered, message, code);
  const ask = (async (type: string, body: { players?: number }) => {
    asked.push(type);
    if (type === HelperMessage.PlayMultiplayer) {
      const mode = options.multiplayer ?? "start";
      if (mode !== "start")
        throw answered(
          mode,
          mode === "busy" ? "A multiplayer test is already running." : "This Studio can't start one.",
        );
      studio.testPlayers = body.players ?? 1;
      studio.startedAt = studio.lists;
      studio.mode = "test";
      return { players: studio.testPlayers };
    }
    throw answered(HelperErrorCode.Unsupported, "The Genex helper can't do that from Edit.");
  }) as unknown as HelperAsk;
  const shrunk: number[] = [];
  const play = createComputerPlay({
    studio: { studios, callTool },
    shrink: async (bytes) => {
      shrunk.push(bytes.length);
      return options.shrink ? options.shrink(bytes) : jpeg(200_000, 1280, 820);
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  }).handlers;
  const game: PlayGame = { storage, game: GAME, edit: () => EDIT, ask, marks };
  const run = (tool: EnginePlayTool, args: Record<string, unknown> = {}) =>
    play[tool](args, game) as Promise<Record<string, unknown>>;
  const of = (name: string) => calls.filter((one) => one.name === name);
  return {
    run,
    calls,
    of,
    asked,
    studio,
    storage,
    marks,
    shrunk,
    now: () => clock,
    game,
    studioDeps: { studios, callTool },
  };
}

describe("Roblox play: opening", () => {
  it("one player is Play Solo in the game's own Studio, the agent's play mark set before it starts and cleared at close", async () => {
    const world = await playWorld();
    const opened = await world.run(EnginePlayTool.Open);
    assert.deepEqual(opened, {
      width: 1336,
      height: 731,
      joined: false,
      players: 1,
      capabilities: { players: 1 },
      liveData: false,
    });
    assert.deepEqual(world.studio.markedAtStart, [true], "marked before start_stop_play");
    assert.equal(world.of("start_stop_play")[0]?.args.studio_id, EDIT);
    assert.ok((await readAgentMarks(world.marks, world.now())).play, "the play is the agent's while it runs");
    assert.deepEqual(world.asked, [], "the helper isn't asked for one player");
    assert.deepEqual(await world.run(EnginePlayTool.Close), { closed: true });
    assert.equal(world.of("start_stop_play").at(-1)?.args.is_start, false);
    assert.equal((await readAgentMarks(world.marks, world.now())).play, undefined, "the mark ends with the play");
  });

  it("three players are the helper's multiplayer test, each client told apart by its test player", async () => {
    const world = await playWorld();
    const opened = await world.run(EnginePlayTool.Open, { players: 3 });
    assert.deepEqual(opened, {
      width: 1081,
      height: 693,
      joined: false,
      players: 3,
      capabilities: { players: 3 },
      liveData: false,
    });
    assert.deepEqual(world.asked, [HelperMessage.PlayMultiplayer]);
    assert.deepEqual(world.of("start_stop_play"), [], "no Play Solo");

    const shot = await world.run(EnginePlayTool.Shot, { player: 2 });
    assert.equal(world.of("screen_capture").at(-1)?.args.studio_id, "client-2", "player 2's picture is client 2's");
    assert.deepEqual([shot.mime, shot.width, shot.height], ["image/jpeg", 1684, 1080]);
    await world.run(EnginePlayTool.Shot, { player: 3 });
    assert.equal(world.of("screen_capture").at(-1)?.args.studio_id, "client-3");

    await world.run(EnginePlayTool.Input, { keys: "KeyW", seconds: 1, player: 3 });
    const keys = world.of("user_keyboard_input").at(-1)?.args;
    assert.deepEqual([keys?.studio_id, keys?.datamodel_type], ["client-3", "Client"]);

    const state = await world.run(EnginePlayTool.State, { player: 2 });
    assert.equal(state.player, 2);
    assert.deepEqual(state.client, { userId: -2, position: [1, 3, 2] });
    assert.deepEqual(state.server, { players: [{ userId: -1 }], gameSeconds: 4 });
    assert.equal((state.console as string[]).length, 20, "the output's last lines only");

    const four = await world.run(EnginePlayTool.Shot, { player: 4 });
    assert.equal(four.refused, EnginePlayRefusal.Unsupported);
    assert.match(String(four.message), /3 players; player 4 isn't in it/);

    assert.deepEqual(await world.run(EnginePlayTool.Close), { closed: true });
    assert.deepEqual(world.asked.slice(-1), [HelperMessage.PlayEnd], "the helper is asked first");
    const ended = world.of("execute_luau").at(-1)?.args;
    assert.deepEqual(
      [ended?.code, ended?.studio_id],
      [PLAY_LUAU.EndTest, SERVER],
      "then the test's own server ends it",
    );
    assert.equal((await readAgentMarks(world.marks, world.now())).play, undefined);
  });

  it("a test whose Studios never all appear answers the players that did, and none at all is refused and ended", async () => {
    const none = await playWorld({ listAfter: Number.POSITIVE_INFINITY });
    const refused = await none.run(EnginePlayTool.Open, { players: 3 });
    assert.equal(refused.refused, EnginePlayRefusal.NoEditor);
    assert.ok(none.now() - 5_000_000 >= TEST_START_MS, "it waited the whole start");
    assert.equal((await readAgentMarks(none.marks, none.now())).play, undefined, "no mark left behind");
  });

  it("a helper that can't start a test answers unsupported, and more players than eight are refused", async () => {
    const world = await playWorld({ multiplayer: HelperErrorCode.Unsupported });
    const opened = await world.run(EnginePlayTool.Open, { players: 2 });
    assert.equal(opened.refused, EnginePlayRefusal.Unsupported);
    assert.equal((await readAgentMarks(world.marks, world.now())).play, undefined);
    for (const players of [9, 0, 2.5, "3"]) {
      const asked = await world.run(EnginePlayTool.Open, { players });
      assert.equal(asked.refused, EnginePlayRefusal.Unsupported, `players ${String(players)}`);
    }
  });

  it("joins a Play Solo already running and leaves it running at close", async () => {
    const world = await playWorld({ soloRunning: true });
    const opened = await world.run(EnginePlayTool.Open, { players: 3 });
    assert.equal(opened.joined, true);
    assert.equal(opened.players, 1, "a running Play Solo has one player");
    assert.deepEqual(world.of("start_stop_play"), []);
    assert.deepEqual(await world.run(EnginePlayTool.Close), { closed: true });
    assert.deepEqual(world.of("start_stop_play"), [], "the person's play goes on");
  });

  it("joins a multiplayer test the person started: it isn't the agent's, and close leaves it running", async () => {
    const world = await playWorld({ multiplayer: HelperErrorCode.Busy });
    // The person's own two-player test, listed already.
    Object.assign(world.studio, { mode: "test", testPlayers: 2, startedAt: -10 });
    const opened = await world.run(EnginePlayTool.Open, { players: 2 });
    assert.equal(opened.joined, true);
    assert.equal((await readAgentMarks(world.marks, world.now())).play, undefined, "the person's play is theirs");
    assert.deepEqual(await world.run(EnginePlayTool.Close), { closed: true });
    assert.equal(world.asked.includes(HelperMessage.PlayEnd), false, "the helper isn't asked to end it");
    assert.equal(
      world.of("execute_luau").some((one) => one.args.code === PLAY_LUAU.EndTest),
      false,
      "nor its server",
    );
    assert.equal(world.studio.testPlayers, 2, "the person's test goes on");
  });

  it("the agent's mark ends once the play it started is found stopped by the person", async () => {
    for (const tool of [EnginePlayTool.Input, EnginePlayTool.State, EnginePlayTool.Shot]) {
      const world = await playWorld();
      await world.run(EnginePlayTool.Open);
      world.studio.mode = "edit";
      const args = tool === EnginePlayTool.Input ? { keys: "KeyW", seconds: 0.1 } : {};
      assert.equal((await world.run(tool, args)).refused, EnginePlayRefusal.NotPlaying, tool);
      assert.equal((await readAgentMarks(world.marks, world.now())).play, undefined, `${tool}: the mark is gone`);
      assert.equal((await world.run(tool, args)).refused, EnginePlayRefusal.NotPlaying, `${tool}: and the play`);
    }
  });

  it("the game's script changes reach Studio before a new play starts, never before joining one", async () => {
    const world = await playWorld();
    const order: string[] = [];
    const game = { ...world.game, flush: async () => void order.push("flush") };
    const play = createComputerPlay({
      studio: {
        studios: world.studioDeps.studios,
        callTool: async (name, args) => {
          if (name === "start_stop_play") order.push(`${name}:${String(args.is_start)}`);
          return world.studioDeps.callTool(name, args);
        },
      },
      shrink: async (bytes) => bytes,
      now: world.now,
      sleep: async () => {},
    }).handlers;
    await play[EnginePlayTool.Open]({}, game);
    assert.deepEqual(order, ["flush", "start_stop_play:true"]);
    await play[EnginePlayTool.Close]({}, game);
    world.studio.mode = "solo";
    order.length = 0;
    await play[EnginePlayTool.Open]({}, game);
    assert.deepEqual(order, [], "a play already running is joined as it is");
  });

  it("no Studio connected for the game answers no-editor", async () => {
    const world = await playWorld();
    const opened = await createComputerPlay({
      shrink: async (bytes) => bytes,
      now: () => 0,
      sleep: async () => {},
    }).handlers[EnginePlayTool.Open]({}, { ...world.game, edit: () => undefined });
    assert.equal((opened as { refused: string }).refused, EnginePlayRefusal.NoEditor);
  });

  it("asks the play's server whether the live saved data is reachable, even with no Roblox ids in the link, and keeps it for the panel", async () => {
    // Flipped: a link without remote ids used to answer false without asking Studio.
    const published = await playWorld({ liveData: true });
    assert.equal((await published.run(EnginePlayTool.Open)).liveData, true);
    assert.ok(
      published.of("execute_luau").some((one) => one.args.code === PLAY_LUAU.LiveData),
      "the server was asked",
    );
    assert.equal((await readLiveData(published.storage, GAME))?.reachable, true);
    const local = await playWorld({ liveData: false });
    assert.equal((await local.run(EnginePlayTool.Open)).liveData, false);
    assert.equal((await readLiveData(local.storage, GAME))?.reachable, false);
    const silent = await playWorld({ liveData: "fails" });
    assert.equal((await silent.run(EnginePlayTool.Open)).liveData, true, "a server that can't say counts as reachable");
  });
});

describe("Roblox play: input, pictures, pause and close", () => {
  it("holds keys in one call, down, wait, up; a hold past 10 s is cut to 10 s", async () => {
    const world = await playWorld();
    await world.run(EnginePlayTool.Open);
    const answer = await world.run(EnginePlayTool.Input, { keys: "KeyW,ShiftLeft", seconds: 10.5 });
    assert.deepEqual(answer, { held: ["W", "LeftShift"], gameSeconds: 12.5 });
    assert.deepEqual(world.of("user_keyboard_input").at(-1)?.args.actions, [
      { action: "keyDown", key_code: "W" },
      { action: "keyDown", key_code: "LeftShift" },
      { action: "wait", wait_time_ms: MAX_PLAY_INPUT_SECONDS * 1000 },
      { action: "keyUp", key_code: "W" },
      { action: "keyUp", key_code: "LeftShift" },
    ]);
  });

  it("a key Roblox has no name for is refused before anything reaches Studio", async () => {
    const world = await playWorld();
    await world.run(EnginePlayTool.Open);
    const before = world.calls.length;
    const answer = await world.run(EnginePlayTool.Input, { keys: "KeyW,Fn,MouseMiddle", seconds: 1 });
    assert.equal(answer.refused, EnginePlayRefusal.UnknownKey);
    assert.match(String(answer.message), /no key for Fn, MouseMiddle/);
    assert.equal(world.calls.length, before);
  });

  it("the mouse moves the aim first, within the view, then its buttons are held there", async () => {
    const world = await playWorld();
    await world.run(EnginePlayTool.Open);
    await world.run(EnginePlayTool.Input, { keys: "MouseLeft", seconds: 0.1, dx: 100, dy: -5000, wheel: 2 });
    const [move, press] = world.of("user_mouse_input").map((one) => one.args.actions);
    assert.deepEqual(move, [{ action: "moveTo", x: 768, y: 0 }, { action: "scrollUp" }, { action: "scrollUp" }]);
    assert.deepEqual(press, [
      { action: "moveTo", x: 768, y: 0 },
      { action: "mouseButtonDown", mouse_button: "left" },
      { action: "wait", wait_time_ms: 100 },
      { action: "mouseButtonUp", mouse_button: "left" },
    ]);
  });

  it("no keys is a wait on the clock; input with no play open is not-playing", async () => {
    const world = await playWorld();
    assert.equal(
      (await world.run(EnginePlayTool.Input, { keys: "KeyW", seconds: 1 })).refused,
      EnginePlayRefusal.NotPlaying,
    );
    await world.run(EnginePlayTool.Open);
    const at = world.now();
    await world.run(EnginePlayTool.Input, { keys: "", seconds: 2 });
    assert.equal(world.now() - at, 2000);
    assert.deepEqual(world.of("user_keyboard_input"), []);
  });

  it("a 1.2 MB shot is shrunk under 1 MB, and refused when it can't be", async () => {
    const big = jpeg(1_200_000, 1920, 1050);
    const world = await playWorld({ shot: big });
    await world.run(EnginePlayTool.Open);
    const shot = await world.run(EnginePlayTool.Shot);
    assert.deepEqual(world.shrunk, [1_200_000]);
    assert.ok(Buffer.from(String(shot.data), "base64").length <= MAX_PLAY_SHOT_BYTES);
    assert.deepEqual([shot.mime, shot.width, shot.height], ["image/jpeg", 1280, 820]);

    for (const shrink of [async () => Promise.reject(new Error("no sips")), async () => jpeg(1_100_000)]) {
      const failing = await playWorld({ shot: big, shrink });
      await failing.run(EnginePlayTool.Open);
      const refused = await failing.run(EnginePlayTool.Shot);
      assert.equal(refused.refused, EnginePlayRefusal.Unsupported);
      assert.equal(refused.data, undefined);
    }
  });

  it("a pause the helper can't do answers unsupported", async () => {
    const world = await playWorld();
    await world.run(EnginePlayTool.Open);
    const paused = await world.run(EnginePlayTool.Pause, { paused: true });
    assert.equal(paused.refused, EnginePlayRefusal.Unsupported);
    assert.deepEqual(world.asked, [HelperMessage.PlayPause]);
  });

  it("close always ends the play it started and its mark, even when Studio fails to answer the stop", async () => {
    const world = await playWorld({ stopThrows: true });
    await world.run(EnginePlayTool.Open);
    assert.deepEqual(await world.run(EnginePlayTool.Close), { closed: true });
    assert.equal((await readAgentMarks(world.marks, world.now())).play, undefined);
    assert.deepEqual(await world.run(EnginePlayTool.Close), { closed: false }, "a second close has nothing to end");
  });

  it("a session whose plugin restarted takes over the play the agent's mark still claims, and ends it", async () => {
    const world = await playWorld({ soloRunning: true });
    await writeFile(path.join(world.marks, "agent-play.json"), JSON.stringify({ since: world.now() - 1000 }));
    assert.equal((await world.run(EnginePlayTool.Open)).joined, true);
    await world.run(EnginePlayTool.Close);
    assert.equal(world.of("start_stop_play").at(-1)?.args.is_start, false, "the agent's own play is ended");
  });
});

describe("Roblox play: keys and Studio's answers", () => {
  it("every key name the table gives is one Studio's keyboard input declares", () => {
    const declared = new Set(KEY_CODES);
    assert.deepEqual(
      robloxKeyNames().filter((name) => !declared.has(name)),
      [],
    );
  });

  it("names web key codes as Roblox does, and none it lacks", () => {
    const rows: Array<[string, string | null]> = [
      ["KeyA", "A"],
      ["Digit0", "Zero"],
      ["Numpad7", "KeypadSeven"],
      ["F15", "F15"],
      ["F16", null],
      ["Enter", "Return"],
      ["ArrowLeft", "Left"],
      ["MetaLeft", "LeftSuper"],
      ["Backslash", "BackSlash"],
      ["toString", null],
      ["__proto__", null],
      ["", null],
    ];
    for (const [code, name] of rows) assert.equal(robloxKey(code), name, code);
    assert.equal(robloxMouseButton("MouseRight"), "right");
    assert.equal(robloxMouseButton("MouseMiddle"), null);
  });

  it("reads Studio's state answer and a JPEG's size", () => {
    assert.deepEqual(parseStudioState(PLAYING), { mode: "Play", dataModels: ["Client", "Server"] });
    assert.deepEqual(parseStudioState("nothing"), { dataModels: [] });
    assert.deepEqual(jpegSize(jpeg(64, 640, 480)), { width: 640, height: 480 });
    assert.equal(jpegSize(Buffer.from("not a picture")), null);
  });
});

describe("Roblox play through the backend", () => {
  // The fake Mac's paths are POSIX ones; the adapter's own cases above hold on every system.
  const onMacWorld = { skip: process.platform === "win32" ? "the fake Mac helper is POSIX-only" : false };
  it(
    "the backend's play tools play the game's bound Studio and ask a published place's live saved data",
    onMacWorld,
    async () => {
      const mac = await robloxMac();
      const game = await makeGame(mac, GAME, "Sky race");
      const place = path.join(game.directory, `${GAME}.rbxlx`);
      await writeFile(place, "<roblox/>");
      await mkdir(path.join(mac.storage, "links"), { recursive: true });
      const remote = { placeId: "123", universeId: "456" };
      const link = { kind: "roblox", project: place, linkedAt: new Date(0).toISOString(), remote };
      await writeFile(path.join(mac.storage, "links", `${GAME}.json`), JSON.stringify(link));
      const world = await playWorld({ liveData: true });
      mac.deps.studio = world.studioDeps;
      mac.deps.moments = {
        ask: () => world.game.ask,
        bound: (id) => (id === GAME ? EDIT : undefined),
        flush: async () => {},
        reapply: async () => true,
        watch: createStudioWatch(mac.deps.now),
      } satisfies MomentServices;
      const backend = createRobloxBackend(mac.deps);
      const { context } = hostFor(mac, game);
      const opened = (await backend.tool?.(RobloxTool.PlayOpen, {}, context)) as Record<string, unknown>;
      assert.deepEqual([opened.players, opened.liveData], [1, true]);
      assert.equal((await readLiveData(mac.storage, GAME))?.reachable, true, "the panel's warning reads it");
      assert.ok((await readAgentMarks(path.join(mac.storage, "mcp", GAME), mac.deps.now())).play);
      const shot = (await backend.tool?.(RobloxTool.PlayShot, {}, context)) as Record<string, unknown>;
      assert.equal(shot.mime, "image/jpeg");
      assert.deepEqual(await backend.tool?.(RobloxTool.PlayClose, {}, context), { closed: true });
      assert.equal((await readAgentMarks(path.join(mac.storage, "mcp", GAME), mac.deps.now())).play, undefined);
    },
  );
});
