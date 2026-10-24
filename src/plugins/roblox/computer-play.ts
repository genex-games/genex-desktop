/**
 * The studio's `computer` tool playing a Roblox game (`shared/engine-play.ts`): a play test in the
 * game's own Roblox Studio, driven through Studio's own MCP server, with the Genex helper starting
 * multiplayer tests. Every tool takes the Studio lock for its call (`needs: ["studio"]`), the
 * person first.
 *
 * - One player is Play Solo (`start_stop_play`) in the game's Studio, which plays as the signed-in
 *   account; its client and server are that Studio's Client and Server data models.
 * - More players is the helper's multiplayer test (`play.multiplayer`): Studio opens a server and
 *   one window per client, each listed by its MCP server as a Studio of its own with no name. A
 *   client answers its Client data model as test player `Player<k>` with UserId `-k`, which makes it
 *   player k; the server answers only its Server data model.
 * - Keys are held in one `user_keyboard_input` call (down, wait, up) in the player's Client data
 *   model; mouse buttons and the wheel go through `user_mouse_input` at the player's aim, which a
 *   frame of mouse motion moves.
 * - A shot is `screen_capture` on the player's Studio: a JPEG, shrunk when it is over the 1 MB a
 *   tool answer may carry, refused when it can't be. A test's server has no picture.
 * - Studio can't hold a play test still (only a server's own clock stops), so a pause answers
 *   `unsupported` unless the helper says otherwise.
 * - At every open of a game whose link names a published place, the server is asked once whether
 *   the game's live saved data can be reached, and the answer is kept for the Set up panel.
 *
 * A session joins a play already running rather than starting another, and ends only a play it
 * started. A play it started carries the agent's play mark (`agent-marks.ts`) from just before it
 * starts until it ends or a play tool finds it stopped, so the Studio lock's probe never reads it
 * as the person's; a session whose plugin restarted takes over the play the mark still claims, and
 * a play the person started is never marked. A new play starts once the game's script changes on
 * their way to Studio are sent.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import {
  ENGINE_PLAY_VIEW,
  type EnginePlayInputAnswer,
  type EnginePlayOpened,
  EnginePlayRefusal,
  type EnginePlayRefused,
  type EnginePlayShot,
  EnginePlayTool,
  MAX_PLAY_INPUT_SECONDS,
  MAX_PLAY_PLAYERS,
  MAX_PLAY_SHOT_BYTES,
  playerArg,
  playersArg,
  playInputKeys,
} from "../../shared/engine-play.ts";
import { StillMimeType } from "../../shared/preview-contract.ts";
import { clearAgentPlay, markAgentPlay, readAgentMarks } from "./agent-marks.ts";
import { type HelperAsk, HelperLinkError } from "./helper-link.ts";
import { HelperErrorCode, HelperMessage } from "./helper-protocol.ts";
import { type RobloxMouseButton, robloxKey, robloxMouseButton } from "./keys.ts";
import { writeLiveData } from "./live-data.ts";
import { PLAY_LUAU } from "./play-luau.ts";
import type { StudioClient, StudioEntry } from "./studio-client.ts";
import type { ShrinkShot } from "./studio-shot.ts";
import { CAPTURE_ID_ARG, DATAMODEL_ARG, DataModel, STUDIO_ID_ARG, StudioTool } from "./studio-tools.ts";

/** How long Play Solo may take to give a client: it answered in about 2 s live. */
export const PLAY_START_MS = 30 * SECOND_MS;
/** How long a multiplayer test may take to list its server and every client: about 11 s live for three. */
export const TEST_START_MS = 60 * SECOND_MS;
/** How often a starting play is looked at. */
export const PLAY_POLL_MS = SECOND_MS / 2;
/** One Studio call's limit, past a hold's own time. */
const CALL_MS = 30 * SECOND_MS;
/** The shortest hold, in seconds: about a tap. */
const MIN_HOLD_SECONDS = 0.05;
/** The most wheel notches one input turns. */
const MAX_WHEEL_NOTCHES = 10;
/** How much of a Studio's output the state carries: its last lines, at most this many characters. */
const CONSOLE_TAIL_LINES = 20;
const CONSOLE_TAIL_CHARS = 2000;
/** A play shot's name in Studio. */
const CAPTURE_PREFIX = "GenexPlay_";
/** What Studio's state answer says of its data models, line by line. */
const STATE_MODE = /Current Studio Mode:\s*(\w+)/;
const STATE_DATAMODELS = /Available DataModels:\s*([^\n]*)/;

const MESSAGE = {
  noStudio:
    "This game's place isn't open in Roblox Studio, or the Genex helper there isn't connected; open it (the Roblox Studio button) and try again.",
  notPlaying: "No play test is running in Roblox Studio (it ended, or the person stopped it); look again to start one.",
  notStarted: "Roblox Studio didn't start the play test in time; look again to try once more.",
  unknownKey: (keys: string[]) => `Roblox Studio has no key for ${keys.join(", ")}.`,
  players: `Roblox Studio plays 1 to ${MAX_PLAY_PLAYERS} players in one test.`,
  noPlayer: (player: unknown, count: number) =>
    `This play test has ${count === 1 ? "1 player" : `${count} players`}; player ${String(player)} isn't in it.`,
  noTest: (why: string) => `Roblox Studio didn't start a multiplayer test: ${why}`,
  noPicture: "Roblox Studio gave no picture of the play test.",
  tooLarge: "Roblox Studio's picture is too large to show and couldn't be made smaller.",
  noPause: "Roblox Studio can't hold a play test still; its clock runs on.",
} as const;

/** What the adapter needs of the computer: Studio's MCP server, a shrink for big pictures, a clock. */
export interface PlayDeps {
  studio?: Pick<StudioClient, "studios" | "callTool">;
  shrink: ShrinkShot;
  now(): number;
  /** Waits `ms`; ends early once `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<unknown>;
}

/** The game a play tool's call is for, as the backend reads it. */
export interface PlayGame {
  /** The plugin's storage and the game's id: together they name the game's session. */
  storage: string;
  game: string;
  /** The game's own Studio, as its helper is connected from it now. */
  edit(): string | undefined;
  ask: HelperAsk;
  /** The game's connection folder, where the agent's marks live; absent for a name that isn't a game id. */
  marks?: string;
  /** Sends the game's script changes still on their way to Studio (refused while a play ran, too). */
  flush?(): Promise<void>;
  signal?: AbortSignal;
}

/** Where a player is aiming, in the view's pixels. */
interface Aim {
  x: number;
  y: number;
}

/** A play the session holds: the game's Studio, the test's server, each player's Studio and aim. */
interface PlaySession {
  edit: string;
  server: string;
  players: string[];
  aims: Aim[];
  multi: boolean;
  started: boolean;
  view: { width: number; height: number };
  /** Whether the play reaches the live game's saved data, as its open last found. */
  liveData: boolean;
}

/** A Studio call's outcome: its text, a picture, and whether Studio refused it. */
interface Called {
  ok: boolean;
  text: string;
  image?: { data: string; mime: string };
}

const refused = (code: EnginePlayRefusal, message: string): EnginePlayRefused => ({ refused: code, message });

/** A Studio's state answer: its mode and the data models it has now. */
export function parseStudioState(text: string): { mode?: string; dataModels: string[] } {
  const mode = STATE_MODE.exec(text)?.[1];
  const listed = STATE_DATAMODELS.exec(text)?.[1] ?? "";
  const dataModels = listed
    .split(",")
    .map((one) => one.trim())
    .filter(Boolean);
  return mode ? { mode, dataModels } : { dataModels };
}

/** A JSON object out of a Luau answer, or null. */
function jsonOf(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The width and height a JPEG says it has (its first frame header), or null. */
export function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  let at = 2;
  while (at + 9 < bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1] ?? 0;
    // SOF0 to SOF3: baseline, extended, progressive and lossless frames carry the size.
    if (marker >= 0xc0 && marker <= 0xc3)
      return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return null;
}

/** A test player's number from its UserId (`-k` is player k), or null for anyone else. */
function testPlayer(userId: unknown): number | null {
  return typeof userId === "number" ? playerArg(-userId) : null;
}

/** The view's size from a client's answer, or the default view's. */
function viewOf(who: Record<string, unknown> | null): { width: number; height: number } {
  const view = who?.view;
  if (!Array.isArray(view) || typeof view[0] !== "number" || typeof view[1] !== "number")
    return { ...ENGINE_PLAY_VIEW };
  return { width: Math.round(view[0]), height: Math.round(view[1]) };
}

const centre = (view: { width: number; height: number }): Aim => ({
  x: Math.round(view.width / 2),
  y: Math.round(view.height / 2),
});

/** A finite number argument, else 0. */
const numberArg = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** A test's server and its clients by player, as far as they have answered. */
interface TestMap {
  server?: string;
  players: Map<number, string>;
  view?: { width: number; height: number };
  /** Studios already told apart, by id. */
  known: Set<string>;
}

/** The sessions the adapter holds, one per game, and its picture count. */
interface PlayBook {
  sessions: Map<string, PlaySession>;
  captures: number;
}

/** One call's reach: the computer, the game it is for, and the adapter's sessions. */
interface Ctx {
  deps: PlayDeps;
  game: PlayGame;
  book: PlayBook;
}

const keyOf = (game: PlayGame) => `${game.storage}\u0000${game.game}`;

/** One Studio call; never throws: Studio's refusal or a dead StudioMCP is an answer that isn't ok. */
async function call(c: Ctx, name: string, args: Record<string, unknown>, timeoutMs = CALL_MS): Promise<Called> {
  if (!c.deps.studio) return { ok: false, text: MESSAGE.noStudio };
  try {
    const options = c.game.signal ? { timeoutMs, signal: c.game.signal } : { timeoutMs };
    const result = await c.deps.studio.callTool(name, args, options);
    const text = result.content.map((part) => (typeof part.text === "string" ? part.text : "")).join("\n");
    const part = result.content.find((one) => one.type === "image" && typeof one.data === "string");
    const called: Called = { ok: !result.isError, text };
    if (part) called.image = { data: String(part.data), mime: String(part.mimeType ?? StillMimeType.Jpeg) };
    return called;
  } catch (error) {
    return { ok: false, text: errorMessage(error) };
  }
}

function luau(c: Ctx, studio: string, dataModel: DataModel, code: string): Promise<Called> {
  return call(c, StudioTool.ExecuteLuau, { [STUDIO_ID_ARG]: studio, [DATAMODEL_ARG]: dataModel, code });
}

async function studioState(c: Ctx, studio: string) {
  const answer = await call(c, StudioTool.GetStudioState, { [STUDIO_ID_ARG]: studio });
  return answer.ok ? parseStudioState(answer.text) : null;
}

async function playingIn(c: Ctx, studio: string): Promise<boolean> {
  return (await studioState(c, studio))?.dataModels.includes(DataModel.Client) ?? false;
}

/** Waits until `ready` answers, polling; null once the time is up or the call is stopped. */
async function until<T>(c: Ctx, limitMs: number, ready: () => Promise<T | null>): Promise<T | null> {
  const deadline = c.deps.now() + limitMs;
  for (;;) {
    const found = await ready();
    if (found !== null) return found;
    if (c.deps.now() >= deadline || c.game.signal?.aborted) return null;
    await c.deps.sleep(PLAY_POLL_MS, c.game.signal);
  }
}

/** The client of a Play Solo in the game's Studio, once its player has joined. */
function soloClient(c: Ctx, edit: string) {
  return until(c, PLAY_START_MS, async () => {
    const who = await luau(c, edit, DataModel.Client, PLAY_LUAU.WhoAmI);
    const parsed = who.ok ? jsonOf(who.text) : null;
    return parsed && typeof parsed.userId === "number" ? parsed : null;
  });
}

/** Tells one listed Studio apart: a test's client (by its player) or its server; nothing while it isn't ready. */
async function placeStudio(c: Ctx, studio: StudioEntry, map: TestMap): Promise<void> {
  const who = await luau(c, studio.id, DataModel.Client, PLAY_LUAU.WhoAmI);
  if (who.ok) {
    const parsed = jsonOf(who.text);
    const player = testPlayer(parsed?.userId);
    if (player === null) return;
    map.known.add(studio.id);
    if (!map.players.has(player)) map.players.set(player, studio.id);
    if (player === 1 || !map.view) map.view = viewOf(parsed);
    return;
  }
  const server = await luau(c, studio.id, DataModel.Server, PLAY_LUAU.IsServer);
  if (server.ok && server.text.trim() === "server") {
    map.known.add(studio.id);
    map.server = studio.id;
  }
}

/** Looks once at the nameless Studios not seen before the test, telling apart each not yet told. */
async function lookAtTest(c: Ctx, before: ReadonlySet<string>, map: TestMap): Promise<void> {
  if (!c.deps.studio) return;
  const listed = await c.deps.studio.studios({ timeoutMs: CALL_MS }).catch(() => []);
  for (const studio of listed) {
    if (studio.name || before.has(studio.id) || map.known.has(studio.id)) continue;
    await placeStudio(c, studio, map);
  }
}

/** A test's server and its first `players` clients, once all are listed; what answered when the time is up. */
async function mapTest(c: Ctx, before: ReadonlySet<string>, players: number): Promise<TestMap> {
  const map: TestMap = { players: new Map(), known: new Set() };
  const complete = () => map.server !== undefined && players <= map.players.size;
  await until(c, TEST_START_MS, async () => {
    await lookAtTest(c, before, map);
    return complete() ? map : null;
  });
  return map;
}

/** Each player's Studio in order from player 1, up to the first player missing. */
function inOrder(map: TestMap, players: number): string[] {
  const ids: string[] = [];
  for (let player = 1; player <= players && map.players.has(player); player++) ids.push(map.players.get(player) ?? "");
  return ids;
}

/**
 * Whether the live saved data can be reached from the play's server, always asked of the server
 * (read only): the link's ids can't say, as the person's own first publish in Studio never updates
 * them. A server that doesn't answer counts as reachable, so no probe writes to it.
 */
async function liveData(c: Ctx, server: string): Promise<boolean> {
  const answer = await luau(c, server, DataModel.Server, PLAY_LUAU.LiveData);
  return !(answer.ok && answer.text.trim() === "false");
}

/** Whether the agent's play mark still claims a play: one a session started before its plugin restarted. */
async function agentsPlay(c: Ctx): Promise<boolean> {
  return c.game.marks ? (await readAgentMarks(c.game.marks, c.deps.now())).play !== undefined : false;
}

async function markPlay(c: Ctx): Promise<void> {
  if (c.game.marks) await markAgentPlay(c.game.marks, c.deps.now());
}

async function clearPlay(c: Ctx): Promise<void> {
  if (c.game.marks) await clearAgentPlay(c.game.marks);
}

/** Ends the Play Solo this session started, and the agent's mark with it. */
async function stopSolo(c: Ctx, edit: string): Promise<void> {
  await call(c, StudioTool.StartStopPlay, { [STUDIO_ID_ARG]: edit, is_start: false }, PLAY_START_MS);
  await clearPlay(c);
}

/** Starts Play Solo, or joins the one already running: the session, or why not. */
async function openSolo(c: Ctx, edit: string, running: boolean): Promise<PlaySession | EnginePlayRefused> {
  if (!running) {
    // Marked before play starts: a probe between the two would read the play as the person's.
    await markPlay(c);
    await call(c, StudioTool.StartStopPlay, { [STUDIO_ID_ARG]: edit, is_start: true }, PLAY_START_MS);
  }
  const who = await soloClient(c, edit);
  if (!who) {
    if (!running) await stopSolo(c, edit);
    return refused(EnginePlayRefusal.NoEditor, MESSAGE.notStarted);
  }
  const view = viewOf(who);
  const started = !running || (await agentsPlay(c));
  return { edit, server: edit, players: [edit], aims: [centre(view)], multi: false, started, view, liveData: false };
}

/** Ends a multiplayer test: the helper first, else from the test's own server. */
async function endTest(c: Ctx, server: string | undefined): Promise<void> {
  const ended = await c.game
    .ask(HelperMessage.PlayEnd, {})
    .then(() => true)
    .catch(() => false);
  if (!ended && server) await luau(c, server, DataModel.Server, PLAY_LUAU.EndTest);
  await clearPlay(c);
}

/** The helper's word on a multiplayer test: started, already running (joined), or why it can't. */
async function startTest(c: Ctx, players: number): Promise<{ joined: boolean; why?: string }> {
  try {
    await c.game.ask(HelperMessage.PlayMultiplayer, { players });
    return { joined: false };
  } catch (error) {
    const busy = error instanceof HelperLinkError && error.helperCode === HelperErrorCode.Busy;
    return busy ? { joined: true } : { joined: false, why: errorMessage(error) };
  }
}

/** A test that never answered: ended when it is the agent's, the mark let go either way. */
async function giveUp(c: Ctx, server: string | undefined, started: boolean): Promise<EnginePlayRefused> {
  if (started) await endTest(c, server);
  else await clearPlay(c);
  return refused(EnginePlayRefusal.NoEditor, MESSAGE.notStarted);
}

/** A play the session opened: what it holds, and whether it joined one already running. */
type Opening = { session: PlaySession; joined: boolean } | EnginePlayRefused;

/** Starts the helper's multiplayer test (or joins the one running) and maps its players. */
async function openTest(c: Ctx, edit: string, players: number): Promise<Opening> {
  const before = c.deps.studio ? await c.deps.studio.studios({ timeoutMs: CALL_MS }).catch(() => []) : [];
  // Read before marking: a test this session joins is the agent's only when the mark claimed it already.
  const claimed = await agentsPlay(c);
  await markPlay(c);
  const start = await startTest(c, players);
  if (start.why !== undefined) {
    await clearPlay(c);
    return refused(EnginePlayRefusal.Unsupported, MESSAGE.noTest(start.why));
  }
  // A test already running was there before: every nameless Studio may be one of its own.
  const seen = start.joined ? new Set<string>() : new Set(before.map((studio) => studio.id));
  const map = await mapTest(c, seen, players);
  const ids = inOrder(map, players);
  const started = !start.joined || claimed;
  if (!map.server || ids.length === 0) return giveUp(c, map.server, started);
  if (!started) await clearPlay(c);
  const view = map.view ?? { ...ENGINE_PLAY_VIEW };
  const aims = ids.map(() => centre(view));
  return {
    session: { edit, server: map.server, players: ids, aims, multi: true, started, view, liveData: false },
    joined: start.joined,
  };
}

/** The answer to an open, with the live-data check kept for the Set up panel. */
async function opened(c: Ctx, session: PlaySession, joined: boolean): Promise<EnginePlayOpened> {
  const reachable = await liveData(c, session.server);
  session.liveData = reachable;
  await writeLiveData(c.game.storage, c.game.game, { reachable, at: c.deps.now() }).catch(() => undefined);
  const players = session.players.length;
  return { ...session.view, joined, players, capabilities: { players }, liveData: reachable };
}

/** A play the session doesn't hold yet: the one running joined, else Play Solo or a multiplayer test started. */
async function openFresh(c: Ctx, edit: string, players: number): Promise<Opening> {
  const state = await studioState(c, edit);
  if (!state) return refused(EnginePlayRefusal.NoEditor, MESSAGE.noStudio);
  const running = state.dataModels.includes(DataModel.Client);
  // A play runs the code Studio holds when it starts: changes held back while one ran go first.
  if (!running) await c.game.flush?.();
  if (players > 1 && !running) return openTest(c, edit, players);
  const solo = await openSolo(c, edit, running);
  return "refused" in solo ? solo : { session: solo, joined: running };
}

async function open(c: Ctx, args: Record<string, unknown>) {
  if (args.players !== undefined && playerArg(args.players) === null)
    return refused(EnginePlayRefusal.Unsupported, MESSAGE.players);
  const edit = c.game.edit();
  if (!edit) return refused(EnginePlayRefusal.NoEditor, MESSAGE.noStudio);
  const key = keyOf(c.game);
  const known = c.book.sessions.get(key);
  if (known && (await playingIn(c, known.players[0] ?? edit))) return opened(c, known, true);
  await forget(c);
  const fresh = await openFresh(c, edit, playersArg(args.players));
  if ("refused" in fresh) return fresh;
  c.book.sessions.set(key, fresh.session);
  return opened(c, fresh.session, fresh.joined);
}

/** The session and the player's number a call is for, or the refusal. */
function playerOf(c: Ctx, args: Record<string, unknown>) {
  const session = c.book.sessions.get(keyOf(c.game));
  if (!session) return refused(EnginePlayRefusal.NotPlaying, MESSAGE.notPlaying);
  const player = args.player === undefined ? 1 : playerArg(args.player);
  if (player === null || player > session.players.length)
    return refused(EnginePlayRefusal.Unsupported, MESSAGE.noPlayer(args.player, session.players.length));
  return { session, player, studio: session.players[player - 1] ?? session.edit };
}

/**
 * Lets go of the session's play once it is found ended (the person stopped it): the agent's mark
 * goes with a play the session started, so the person's next edits count as theirs.
 */
async function forget(c: Ctx): Promise<void> {
  const key = keyOf(c.game);
  const session = c.book.sessions.get(key);
  c.book.sessions.delete(key);
  if (session?.started) await clearPlay(c);
}

/** A play that is found ended: the session lets go of it, and the answer says so. */
async function notPlaying(c: Ctx): Promise<EnginePlayRefused> {
  await forget(c);
  return refused(EnginePlayRefusal.NotPlaying, MESSAGE.notPlaying);
}

/** A call that failed: not playing any more, or Studio's own words. */
async function failed(c: Ctx, studio: string, answer: Called): Promise<EnginePlayRefused> {
  if (!(await playingIn(c, studio))) return notPlaying(c);
  throw new Error(answer.text || MESSAGE.notPlaying);
}

/** The mouse's frame first: the aim moved (kept inside the view) and the wheel turned. */
function mouseFrame(session: PlaySession, player: number, args: Record<string, unknown>) {
  const aim = session.aims[player - 1] ?? centre(session.view);
  const dx = numberArg(args.dx);
  const dy = numberArg(args.dy);
  const wheel = Math.max(-MAX_WHEEL_NOTCHES, Math.min(MAX_WHEEL_NOTCHES, Math.round(numberArg(args.wheel))));
  if (!dx && !dy && !wheel) return { aim, actions: [] };
  const moved = {
    x: Math.max(0, Math.min(session.view.width - 1, Math.round(aim.x + dx))),
    y: Math.max(0, Math.min(session.view.height - 1, Math.round(aim.y + dy))),
  };
  session.aims[player - 1] = moved;
  const scroll = { action: wheel > 0 ? "scrollUp" : "scrollDown" };
  return {
    aim: moved,
    actions: [{ action: "moveTo", ...moved }, ...Array.from({ length: Math.abs(wheel) }, () => scroll)],
  };
}

/** Keys and mouse buttons held together, in Roblox's names. */
interface Held {
  keys: string[];
  buttons: RobloxMouseButton[];
}

/** Holds keys (and mouse buttons, at the aim) together for `ms`, then lets go: one call each. */
function holdAll(c: Ctx, studio: string, held: Held, ms: number, aim: Aim): Array<Promise<Called>> {
  const base = { [STUDIO_ID_ARG]: studio, [DATAMODEL_ARG]: DataModel.Client };
  const limit = ms + CALL_MS;
  const wait = { action: "wait", wait_time_ms: ms };
  const calls: Array<Promise<Called>> = [];
  if (held.keys.length) {
    const down = held.keys.map((key) => ({ action: "keyDown", key_code: key }));
    const up = held.keys.map((key) => ({ action: "keyUp", key_code: key }));
    calls.push(call(c, StudioTool.UserKeyboardInput, { ...base, actions: [...down, wait, ...up] }, limit));
  }
  if (held.buttons.length) {
    const down = held.buttons.map((button) => ({ action: "mouseButtonDown", mouse_button: button }));
    const up = held.buttons.map((button) => ({ action: "mouseButtonUp", mouse_button: button }));
    const actions = [{ action: "moveTo", ...aim }, ...down, wait, ...up];
    calls.push(call(c, StudioTool.UserMouseInput, { ...base, actions }, limit));
  }
  return calls;
}

/** The keys an input names, in Roblox's names, and any it has no name for. */
function namesOf(keys: unknown): { held: Held; unknown: string[] } {
  const held: Held = { keys: [], buttons: [] };
  const unknown: string[] = [];
  for (const code of playInputKeys(keys)) {
    const button = robloxMouseButton(code);
    const key = button ? null : robloxKey(code);
    if (button) held.buttons.push(button);
    else if (key) held.keys.push(key);
    else unknown.push(code);
  }
  return { held, unknown };
}

/** How long a hold lasts, in milliseconds: the seconds asked, from a tap up to the longest one call holds. */
function holdMs(seconds: unknown): number {
  const asked = typeof seconds === "number" && Number.isFinite(seconds) ? seconds : MIN_HOLD_SECONDS;
  return Math.round(Math.min(MAX_PLAY_INPUT_SECONDS, Math.max(MIN_HOLD_SECONDS, asked)) * SECOND_MS);
}

/** The game's own clock in the player's client, or null when it doesn't say. */
async function gameSeconds(c: Ctx, studio: string): Promise<number | null> {
  const clock = await luau(c, studio, DataModel.Client, PLAY_LUAU.GameSeconds);
  const seconds = clock.ok ? Number(clock.text) : Number.NaN;
  return Number.isFinite(seconds) ? seconds : null;
}

async function input(c: Ctx, args: Record<string, unknown>) {
  const { held, unknown } = namesOf(args.keys);
  if (unknown.length) return refused(EnginePlayRefusal.UnknownKey, MESSAGE.unknownKey(unknown));
  const target = playerOf(c, args);
  if ("refused" in target) return target;
  const { session, player, studio } = target;
  const ms = holdMs(args.seconds);
  const frame = mouseFrame(session, player, args);
  if (frame.actions.length) {
    const base = { [STUDIO_ID_ARG]: studio, [DATAMODEL_ARG]: DataModel.Client };
    const moved = await call(c, StudioTool.UserMouseInput, { ...base, actions: frame.actions });
    if (!moved.ok) return failed(c, studio, moved);
  }
  const calls = holdAll(c, studio, held, ms, frame.aim);
  if (calls.length === 0) await c.deps.sleep(ms, c.game.signal);
  const miss = (await Promise.all(calls)).find((answer) => !answer.ok);
  if (miss) return failed(c, studio, miss);
  const answer: EnginePlayInputAnswer = {
    held: [...held.keys, ...held.buttons],
    gameSeconds: await gameSeconds(c, studio),
  };
  return answer;
}

/** A picture that fits a tool answer: as taken, or shrunk; null when it can't be made to fit. */
async function fitting(c: Ctx, bytes: Buffer, mime: string): Promise<{ bytes: Buffer; mime: string } | null> {
  if (bytes.length <= MAX_PLAY_SHOT_BYTES) return { bytes, mime };
  const small = await c.deps.shrink(bytes).catch(() => null);
  return small && small.length <= MAX_PLAY_SHOT_BYTES ? { bytes: small, mime: StillMimeType.Jpeg } : null;
}

async function shot(c: Ctx, args: Record<string, unknown>) {
  const target = playerOf(c, args);
  if ("refused" in target) return target;
  c.book.captures += 1;
  const capture = { [STUDIO_ID_ARG]: target.studio, [CAPTURE_ID_ARG]: `${CAPTURE_PREFIX}${c.book.captures}` };
  const taken = await call(c, StudioTool.ScreenCapture, capture);
  if (!taken.image)
    return taken.ok ? refused(EnginePlayRefusal.NoEditor, MESSAGE.noPicture) : failed(c, target.studio, taken);
  const fit = await fitting(c, Buffer.from(taken.image.data, "base64"), taken.image.mime);
  if (!fit) return refused(EnginePlayRefusal.Unsupported, MESSAGE.tooLarge);
  const size = jpegSize(fit.bytes) ?? target.session.view;
  const mime = fit.mime === StillMimeType.Png ? StillMimeType.Png : StillMimeType.Jpeg;
  const answer: EnginePlayShot = { data: fit.bytes.toString("base64"), mime, ...size };
  return answer;
}

/** The last lines of a Studio's output, at most a few thousand characters. */
async function consoleTail(c: Ctx, studio: string): Promise<string[]> {
  const output = await call(c, StudioTool.GetConsoleOutput, { [STUDIO_ID_ARG]: studio });
  if (!output.ok) return [];
  const lines = output.text.split("\n").filter((line) => line.trim());
  return lines.slice(-CONSOLE_TAIL_LINES).map((line) => line.slice(0, CONSOLE_TAIL_CHARS / CONSOLE_TAIL_LINES));
}

async function state(c: Ctx, args: Record<string, unknown>) {
  const target = playerOf(c, args);
  if ("refused" in target) return target;
  const { session, player, studio } = target;
  const [studioNow, client, server, consoleLines] = await Promise.all([
    studioState(c, studio),
    luau(c, studio, DataModel.Client, PLAY_LUAU.ClientState),
    luau(c, session.server, DataModel.Server, PLAY_LUAU.ServerState),
    consoleTail(c, studio),
  ]);
  if (!studioNow?.dataModels.includes(DataModel.Client)) return notPlaying(c);
  return {
    player,
    players: session.players.length,
    mode: studioNow.mode ?? null,
    client: client.ok ? jsonOf(client.text) : null,
    server: server.ok ? jsonOf(server.text) : null,
    console: consoleLines,
  };
}

async function pause(c: Ctx, args: Record<string, unknown>) {
  if (!c.book.sessions.has(keyOf(c.game))) return refused(EnginePlayRefusal.NotPlaying, MESSAGE.notPlaying);
  const paused = args.paused === true;
  return c.game
    .ask(HelperMessage.PlayPause, { paused })
    .then(() => ({ paused }))
    .catch(() => refused(EnginePlayRefusal.Unsupported, MESSAGE.noPause));
}

async function close(c: Ctx) {
  const key = keyOf(c.game);
  const session = c.book.sessions.get(key);
  c.book.sessions.delete(key);
  if (!session) return { closed: false };
  // A play the person started goes on; one this session started always ends, and its mark with it.
  if (session.started) {
    try {
      if (session.multi) await endTest(c, session.server);
      else await stopSolo(c, session.edit);
    } finally {
      await clearPlay(c);
    }
  }
  return { closed: true };
}

/** A play tool's handler: its arguments and the game the call is for. */
export type PlayHandler = (args: Record<string, unknown>, game: PlayGame) => Promise<unknown>;

/** A play a session holds, as the judges' probes read it: the server's Studio, each player's, and live data. */
export interface PlayingView {
  server: string;
  players: readonly string[];
  liveData: boolean;
}

/** The play tools over Studio's MCP server and the Genex helper, and the play each game holds now. */
export function createComputerPlay(deps: PlayDeps): {
  handlers: Record<EnginePlayTool, PlayHandler>;
  playing(game: PlayGame): PlayingView | undefined;
} {
  const book: PlayBook = { sessions: new Map(), captures: 0 };
  const on =
    (handler: (c: Ctx, args: Record<string, unknown>) => Promise<unknown>): PlayHandler =>
    (args, game) =>
      handler({ deps, game, book }, args);
  const handlers = {
    [EnginePlayTool.Open]: on(open),
    [EnginePlayTool.Input]: on(input),
    [EnginePlayTool.Shot]: on(shot),
    [EnginePlayTool.State]: on(state),
    [EnginePlayTool.Pause]: on(pause),
    [EnginePlayTool.Close]: on(close),
  } as const satisfies Record<EnginePlayTool, PlayHandler>;
  const playing = (game: PlayGame): PlayingView | undefined => {
    const session = book.sessions.get(keyOf(game));
    return session && { server: session.server, players: [...session.players], liveData: session.liveData };
  };
  return { handlers, playing };
}
