/**
 * The Roblox judges' probes: what Genex measures of a play test right after it opens, before a
 * judge's first look (`PluginJudge.probe`). Each is a harness tool that needs the Studio lock, as
 * the play tools do, and answers `{note, images}`: plain lines and pictures, never source.
 *
 * - `players-state` (the multiplayer judge): a picture from each player, and what each client sees
 *   of every player against what the server holds.
 * - `cheat-remotes` (the cheater judge): every remote a player's client can reach, sent hostile
 *   values from that client, with the server's state read before and after each. It never runs when
 *   the play can reach the live game's saved data, where a hostile call could change a real save.
 * - `phone-check` (the phone judge): Studio's Device Simulator set to a phone and a tablet, upright
 *   and sideways, from the player's client during the play; a picture of each, where the interface
 *   overlaps, runs off the screen or under the device's edges and Roblox's buttons, and the place's
 *   memory against a phone's budget. The simulator keeps its last device after a play, so the
 *   device shown before is always put back.
 *
 * The Luau of the cheater and phone steps is read from the plugin's package (`cheat-remotes.luau`,
 * `phone-check.luau`), each a function of its arguments that this module calls step by step.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { MAX_PLAY_SHOT_BYTES } from "../../shared/engine-play.ts";
import { StillMimeType } from "../../shared/preview-contract.ts";
import type { PlayGame, PlayHandler, PlayingView } from "./computer-play.ts";
import { PLAY_LUAU } from "./play-luau.ts";
import type { StudioClient } from "./studio-client.ts";
import type { ShrinkShot } from "./studio-shot.ts";
import { CAPTURE_ID_ARG, DATAMODEL_ARG, DataModel, STUDIO_ID_ARG, StudioTool } from "./studio-tools.ts";
import { LIVE_DATA_CLICK_PATH } from "./words.ts";

/** The probe tools plugin.json declares. Wire values: never rename. */
export const RobloxProbe = {
  PlayersState: "players-state",
  CheatRemotes: "cheat-remotes",
  PhoneCheck: "phone-check",
} as const;
export type RobloxProbe = (typeof RobloxProbe)[keyof typeof RobloxProbe];

/** The probes' Luau files, beside the backend in the package. */
export const ProbeLuauFile = {
  CheatRemotes: "cheat-remotes.luau",
  PhoneCheck: "phone-check.luau",
} as const;
export type ProbeLuauFile = (typeof ProbeLuauFile)[keyof typeof ProbeLuauFile];

/** How long the cheater may start remotes for: the probe's call ends well inside a plugin call's limit. */
export const CHEAT_MAX_MS = 120 * SECOND_MS;
/** One Studio call's limit: a remote's hostile burst waits under a second for the server. */
const CALL_MS = 30 * SECOND_MS;
/** A phone size's call also waits for the simulator to resize and the interface to lay out. */
const PHONE_CALL_MS = 45 * SECOND_MS;

/**
 * The place's own memory a phone should hold, in MB. Low-end phones close a game well before their
 * whole memory is used; Studio counts the place's parts, textures, sounds and interface here.
 */
export const PHONE_MEMORY_BUDGET_MB = 600;

/**
 * Studio's memory kinds that are Studio's own or shared with its plugins (the Lua heap, scripts,
 * signals, its internals and HTTP cache): left out of the place's memory, which a phone would carry.
 */
const STUDIO_MEMORY_TAGS: ReadonlySet<string> = new Set(["Internal", "LuaHeap", "Script", "Signals", "HttpCache"]);

/** The sizes the phone judge sees, by Device Simulator id and orientation. Device ids: Studio 0.743's list. */
export const PHONE_SIZES = [
  { device: "iphone_13", orientation: "Portrait", label: "Phone, upright" },
  { device: "iphone_13", orientation: "LandscapeRight", label: "Phone, sideways" },
  { device: "ipad_10th_generation", orientation: "Portrait", label: "Tablet, upright" },
  { device: "ipad_10th_generation", orientation: "LandscapeRight", label: "Tablet, sideways" },
] as const;

/** How far past an edge a box may reach before it counts, in pixels: rounding, not a fault. */
const EDGE_SLACK_PX = 2;
/** Two boxes overlap when they share at least this much of the smaller one. */
const OVERLAP_SHARE = 0.25;
/** The most findings named per size, and the most names listed of a long list. */
const MAX_FINDINGS = 12;
const MAX_NAMES = 5;
/** Roblox's touch controls, as the phone check names them. */
const TOUCH_NAMES = { JumpButton: "Roblox's jump button", ThumbstickFrame: "Roblox's move stick" } as const;

const MESSAGE = {
  noPlay: "No play test is running in Roblox Studio, so there was nothing to measure.",
  noStudio: "Roblox Studio's MCP server isn't connected, so there was nothing to measure.",
  liveData:
    `The cheater check didn't send anything: this play can reach the live game's saved data, where a hostile ` +
    `request could change real players' saves. Play only as yourself and change nothing saved. To let the ` +
    `check run, turn off ${LIVE_DATA_CLICK_PATH} for this place.`,
  noRemotes: "The game has no remotes a player's client can reach, so there was nothing to send.",
  fired: (count: number) =>
    `Sent hostile values to ${count === 1 ? "1 remote" : `${count} remotes`} from the player's client: no values, ` +
    "wrong types, negative, huge and broken numbers, a very long text, things the player doesn't own, and a burst " +
    "of the same request; the server's leaderstats and attributes were read before and after each.",
  unchanged: "The server's state didn't change after any of them.",
  changed: (count: number) =>
    `The server's state changed the way a cheat would after ${count === 1 ? "1 of them" : `${count} of them`}:`,
  noCheat: "No change looked like a cheat.",
  paid: (count: number) =>
    `After ${count === 1 ? "1 of them" : `${count} of them`} a player only spent, as a normal purchase does: ` +
    "check the game sells that, at that price.",
  noFire: "The player's client didn't answer the first remote's requests, so nothing was checked.",
  stopped: (remote: string) => `After ${remote} the player's client stopped answering, so the check stopped there.`,
  untried: (count: number, names: string) => `${count} not tried in time: ${names}.`,
  left: (name: string) => `${name} left the game`,
  joined: (name: string) => `${name} joined the game`,
  went: (what: string, from: string, to: string) => `${what} went from ${from} to ${to}`,
  sizeFailed: (label: string) => `${label}: Studio couldn't show this size.`,
  sizeClean: (label: string, width: number, height: number) =>
    `${label} (${width}×${height}): nothing overlaps, runs off the screen or under its edges.`,
  sizeFindings: (label: string, width: number, height: number) => `${label} (${width}×${height}):`,
  overlapsTouch: (name: string, control: string) => `${name} overlaps ${control}`,
  overlap: (a: string, b: string) => `${a} and ${b} overlap`,
  offScreen: (name: string) => `${name} runs off the screen`,
  unsafe: (name: string) => `${name} is outside the safe area (under a notch or a rounded corner)`,
  underRoblox: (name: string) => `${name} sits under Roblox's own buttons in the top bar`,
  memoryOver: (mb: number) =>
    `The place takes about ${mb} MB in Studio, over a phone's budget of ${PHONE_MEMORY_BUDGET_MB} MB: phones may close it.`,
  memoryWithin: (mb: number) =>
    `The place takes about ${mb} MB in Studio, within a phone's budget of ${PHONE_MEMORY_BUDGET_MB} MB.`,
  memoryUnread: "Studio didn't say how much memory the place takes.",
  more: (count: number) => `and ${count} more`,
  joinedPlayers: (count: number, names: string) => `${count === 1 ? "1 player" : `${count} players`} joined: ${names}.`,
  fewer: (count: number, opened: number) => `The server has ${count} of the ${opened} players.`,
  sameView: "Every client sees every player, with the server's leaderstats and attributes.",
  unseen: (player: number, name: string) => `Player ${player} doesn't see ${name}`,
  differs: (player: number, name: string, stat: string, value: string, server: string) =>
    `Player ${player} sees ${name}'s ${stat} as ${value}; the server has ${server}`,
  noView: (player: number) => `Player ${player}'s client didn't answer what it sees`,
  noServer: "The server didn't answer which players it has.",
  playerLabel: (player: number) => `Player ${player}`,
} as const;

/** What the probes need of the computer: Studio's MCP server, a shrink for big pictures, a clock, the package. */
export interface ProbeDeps {
  studio?: Pick<StudioClient, "callTool">;
  shrink: ShrinkShot;
  now(): number;
  /** A probe's Luau file, read from the plugin's package. */
  luau(file: ProbeLuauFile): Promise<string>;
}

/** The play a probe measures, as the play tools hold it: the server's Studio, each player's, and live data. */
export type PlayView = PlayingView;

/** A probe's picture, as the host reads one. */
export interface ProbePicture {
  mimeType: string;
  data: string;
  label: string;
}

/** A probe's answer: plain lines, and pictures. */
export interface ProbeAnswer {
  note: string;
  images: ProbePicture[];
}

/** One interface element on the phone's screen: its box (x, y, width, height) and what it is. */
export interface PhoneElement {
  id: number;
  /** The nearest element it sits inside, by id. */
  under?: number;
  path: string;
  class: string;
  box: number[];
  pressable: boolean;
  text?: string;
  /** Inside a scrolling or clipping frame: what lies outside is meant to be hidden. */
  clipped: boolean;
  /** One of Roblox's own touch controls. */
  touch: boolean;
}

/** What the phone check reads at one size. Boxes are x, y, width and height in the view's pixels. */
export interface PhoneMeasure {
  device: string;
  orientation?: string;
  view: number[];
  safe?: number[];
  /** Where Roblox's own top-bar buttons sit. */
  roblox?: number[];
  elements: PhoneElement[];
  memory: Record<string, number>;
}

/** A Studio call's outcome. */
interface Called {
  ok: boolean;
  text: string;
  image?: { data: string; mime: string };
}

/** One probe call's reach, and the probes' picture count. */
interface Ctx {
  deps: ProbeDeps;
  game: PlayGame;
  play: PlayView;
  book: { captures: number };
}

/**
 * The Luau a step runs: the package's file (a function of its arguments) called with `args`, which
 * travel as JSON in a long string whose brackets no value can close.
 */
export function probeCode(source: string, args: Record<string, unknown>): string {
  const json = JSON.stringify(args);
  let level = "";
  while (json.includes(`]${level}]`)) level += "=";
  return `return (function()\n${source}\nend)()(game:GetService("HttpService"):JSONDecode([${level}[${json}]${level}]))`;
}

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

const luau = (c: Ctx, studio: string, dataModel: DataModel, code: string, timeoutMs = CALL_MS) =>
  call(c, StudioTool.ExecuteLuau, { [STUDIO_ID_ARG]: studio, [DATAMODEL_ARG]: dataModel, code }, timeoutMs);

/** A JSON object out of a Luau answer; Luau writes an empty table as [], read here as {}. */
function objectOf(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value) && value.length === 0) return {};
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** A list of names, the first few and how many more. */
function names(list: readonly string[]): string {
  const shown = list.slice(0, MAX_NAMES);
  return list.length > MAX_NAMES ? `${shown.join(", ")} ${MESSAGE.more(list.length - MAX_NAMES)}` : shown.join(", ");
}

/** A picture of one Studio's view that fits a tool answer, labelled; null when Studio gave none. */
async function picture(c: Ctx, studio: string, label: string): Promise<ProbePicture | null> {
  c.book.captures += 1;
  const taken = await call(c, StudioTool.ScreenCapture, {
    [STUDIO_ID_ARG]: studio,
    [CAPTURE_ID_ARG]: `GenexProbe_${c.book.captures}`,
  });
  if (!taken.image) return null;
  const bytes = Buffer.from(taken.image.data, "base64");
  if (bytes.length <= MAX_PLAY_SHOT_BYTES) return { mimeType: taken.image.mime, data: taken.image.data, label };
  const small = await c.deps.shrink(bytes).catch(() => null);
  if (!small || small.length > MAX_PLAY_SHOT_BYTES) return null;
  return { mimeType: StillMimeType.Jpeg, data: small.toString("base64"), label };
}

// The cheater.

/** The server's state the cheater watches, flattened: "Builder's Coins" → "100". */
export type ServerState = Map<string, string>;

/** Reads the server's state from the cheat step's answer: players by id, and ServerStorage's attributes. */
export function serverState(answer: Record<string, unknown>): ServerState {
  const out: ServerState = new Map();
  for (const [id, raw] of Object.entries(record(answer.players))) {
    const player = record(raw);
    const name = typeof player.name === "string" ? player.name : id;
    out.set(`player:${id}`, name);
    for (const [stat, value] of Object.entries(record(player.leaderstats))) out.set(`${name}'s ${stat}`, String(value));
    for (const [attribute, value] of Object.entries(record(player.attributes)))
      out.set(`${name}'s attribute ${attribute}`, String(value));
  }
  for (const [attribute, value] of Object.entries(record(answer.server)))
    out.set(`ServerStorage's attribute ${attribute}`, String(value));
  return out;
}

/** One change on the server: in words, and whether it is a cheat's (anything but a plain payment). */
export interface StateChange {
  words: string;
  cheat: boolean;
}

/** A plain payment: a number that went down and stayed at zero or above, as a normal purchase leaves it. */
function paid(from: string, to: string): boolean {
  const before = Number(from);
  const after = Number(to);
  return Number.isFinite(before) && Number.isFinite(after) && after < before && after >= 0;
}

/** The names of players in one read and not the other. */
const goneFrom = (state: ServerState, other: ServerState) =>
  [...state].filter(([key]) => key.startsWith("player:") && !other.has(key)).map(([, name]) => name);

/** What changed between two reads of the server's state; a player who left or joined is one change, stats and all. */
export function stateChanges(before: ServerState, after: ServerState): StateChange[] {
  const left = goneFrom(before, after);
  const joined = goneFrom(after, before);
  const changes: StateChange[] = [
    ...left.map((name) => ({ words: MESSAGE.left(name), cheat: true })),
    ...joined.map((name) => ({ words: MESSAGE.joined(name), cheat: true })),
  ];
  const owned = (key: string) => [...left, ...joined].some((name) => key.startsWith(`${name}'s `));
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const key of keys) {
    const from = before.get(key);
    const to = after.get(key);
    if (key.startsWith("player:") || owned(key) || from === to) continue;
    const cheat = from === undefined || to === undefined || !paid(from, to);
    changes.push({ words: MESSAGE.went(key, from ?? "nothing", to ?? "nothing"), cheat });
  }
  return changes;
}

/** One cheat step's answer, or null when the client or server didn't give one. */
async function cheatStep(c: Ctx, source: string, studio: string, model: DataModel, args: Record<string, unknown>) {
  const answer = await luau(c, studio, model, probeCode(source, args));
  return answer.ok ? objectOf(answer.text) : null;
}

const remoteName = (path: unknown) => (Array.isArray(path) ? path.map(String).join(".") : String(path));

/** The cheater's run so far: the server's last state, what changed, how many remotes were sent to. */
interface CheatRun {
  before: ServerState | null;
  /** Remotes after which the server changed the way a cheat would, and after which a player only paid. */
  cheats: string[];
  paid: string[];
  tried: number;
}

/** The server's state the cheater watches, or null when the server didn't answer. */
async function stateNow(c: Ctx, source: string): Promise<ServerState | null> {
  const answer = await cheatStep(c, source, c.play.server, DataModel.Server, { op: "state" });
  return answer ? serverState(answer) : null;
}

/** Sends one remote its hostile values and notes what changed on the server; false when the client didn't answer. */
async function tryRemote(c: Ctx, source: string, run: CheatRun, remote: unknown, words: unknown[]) {
  const player = c.play.players[0] ?? c.play.server;
  const sent = await cheatStep(c, source, player, DataModel.Client, { op: "fire", remote, words });
  if (!sent) return false;
  run.tried += 1;
  const after = await stateNow(c, source);
  const changes = run.before && after ? stateChanges(run.before, after) : [];
  const line = `- ${remoteName(remote)}: ${changes.map((change) => change.words).join("; ")}.`;
  if (changes.some((change) => change.cheat)) run.cheats.push(line);
  else if (changes.length) run.paid.push(line);
  run.before = after;
  return true;
}

/** Sends each remote its hostile values, in turn, until the time is up: each one's change, if any. */
async function fireAll(c: Ctx, source: string, remotes: unknown[], words: unknown[]) {
  const deadline = c.deps.now() + CHEAT_MAX_MS;
  const run: CheatRun = { before: await stateNow(c, source), cheats: [], paid: [], tried: 0 };
  let answered = true;
  for (const remote of remotes) {
    if (c.deps.now() >= deadline || c.game.signal?.aborted) break;
    answered = await tryRemote(c, source, run, remote, words);
    if (!answered) break;
  }
  // A client that stopped answering stopped after the last remote it took.
  const stopped = answered || run.tried === 0 ? undefined : remoteName(remotes[run.tried - 1]);
  const untried = answered ? remotes.slice(run.tried).map(remoteName) : [];
  return { ...run, stopped, untried, failed: !answered && run.tried === 0 };
}

/** The findings: changes a cheat would make first, then plain payments, or that nothing changed. */
function cheatLines(run: Pick<CheatRun, "cheats" | "paid">): string[] {
  if (!run.cheats.length && !run.paid.length) return [MESSAGE.unchanged];
  const lines = run.cheats.length ? [MESSAGE.changed(run.cheats.length), ...run.cheats] : [MESSAGE.noCheat];
  return run.paid.length ? [...lines, MESSAGE.paid(run.paid.length), ...run.paid] : lines;
}

async function cheatRemotes(c: Ctx): Promise<ProbeAnswer> {
  if (c.play.liveData) return { note: MESSAGE.liveData, images: [] };
  const source = await c.deps.luau(ProbeLuauFile.CheatRemotes);
  const player = c.play.players[0] ?? c.play.server;
  const listed = await luau(c, player, DataModel.Client, probeCode(source, { op: "list" }));
  const list = listed.ok ? objectOf(listed.text) : null;
  if (!list) throw new Error(listed.text || MESSAGE.noPlay);
  const remotes = Array.isArray(list.remotes) ? list.remotes : [];
  const words = Array.isArray(list.words) ? list.words.filter((word) => typeof word === "string") : [];
  if (remotes.length === 0) return { note: MESSAGE.noRemotes, images: [] };
  const run = await fireAll(c, source, remotes, words);
  if (run.failed) throw new Error(MESSAGE.noFire);
  const lines = [MESSAGE.fired(run.tried)];
  lines.push(...cheatLines(run));
  if (run.stopped) lines.push(MESSAGE.stopped(run.stopped));
  if (run.untried.length) lines.push(MESSAGE.untried(run.untried.length, names(run.untried)));
  return { note: lines.join("\n"), images: [] };
}

// The phone check.

type Box = readonly [x: number, y: number, width: number, height: number];

const boxOf = (value: readonly number[] | undefined): Box | null =>
  value && value.length >= 4 && value.every(Number.isFinite)
    ? [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 0]
    : null;

const area = (box: Box) => Math.max(0, box[2]) * Math.max(0, box[3]);

function shared(a: Box, b: Box): number {
  const width = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const height = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return width > 0 && height > 0 ? width * height : 0;
}

/** Whether `inner` reaches past `outer` by more than the slack on any side. */
const reachesOut = (inner: Box, outer: Box) =>
  inner[0] < outer[0] - EDGE_SLACK_PX ||
  inner[1] < outer[1] - EDGE_SLACK_PX ||
  inner[0] + inner[2] > outer[0] + outer[2] + EDGE_SLACK_PX ||
  inner[1] + inner[3] > outer[1] + outer[3] + EDGE_SLACK_PX;

/** An element as a finding names it: its path, and its text when it shows one. */
const nameOf = (element: PhoneElement) => (element.text ? `${element.path} ("${element.text}")` : element.path);

/** Roblox's touch control an element is, in words. */
function touchName(element: PhoneElement): string {
  const leaf = element.path.split(".").at(-1) ?? "";
  return leaf in TOUCH_NAMES ? TOUCH_NAMES[leaf as keyof typeof TOUCH_NAMES] : "Roblox's touch controls";
}

/** Whether one element sits inside the other. */
function nested(a: PhoneElement, b: PhoneElement, byId: ReadonlyMap<number, PhoneElement>): boolean {
  const within = (inner: PhoneElement, outer: PhoneElement) => {
    for (let at = inner.under; at !== undefined; at = byId.get(at)?.under) if (at === outer.id) return true;
    return false;
  };
  return within(a, b) || within(b, a);
}

/** Two pressable elements' overlap in words, or null when they don't overlap enough to matter. */
function overlapFinding(a: PhoneElement, b: PhoneElement, byId: ReadonlyMap<number, PhoneElement>): string | null {
  const boxA = boxOf(a.box);
  const boxB = boxOf(b.box);
  const bothRoblox = a.touch && b.touch;
  if (!boxA || !boxB || bothRoblox || nested(a, b, byId)) return null;
  const smaller = Math.min(area(boxA), area(boxB));
  if (smaller === 0 || shared(boxA, boxB) < smaller * OVERLAP_SHARE) return null;
  if (!a.touch && !b.touch) return MESSAGE.overlap(nameOf(a), nameOf(b));
  const [own, control] = a.touch ? [b, a] : [a, b];
  return MESSAGE.overlapsTouch(nameOf(own), touchName(control));
}

/** Pressable elements that share much of their boxes, where at least one is the game's own. */
function overlaps(elements: readonly PhoneElement[]): string[] {
  const byId = new Map(elements.map((element) => [element.id, element]));
  const pressable = elements.filter((element) => element.pressable && !element.clipped);
  return pressable.flatMap((a, i) =>
    pressable
      .slice(i + 1)
      .map((b) => overlapFinding(a, b, byId))
      .filter((line) => line !== null),
  );
}

/** Where one of the game's elements lands badly: off the screen, outside the safe area, under Roblox's buttons. */
function edgeFinding(element: PhoneElement, measure: PhoneMeasure): string | null {
  const box = boxOf(element.box);
  const view = boxOf([0, 0, measure.view[0] ?? 0, measure.view[1] ?? 0]);
  if (!box || !view || area(box) === 0) return null;
  if (reachesOut(box, view)) return MESSAGE.offScreen(nameOf(element));
  const safe = boxOf(measure.safe);
  if (safe && reachesOut(box, safe)) return MESSAGE.unsafe(nameOf(element));
  const roblox = boxOf(measure.roblox);
  if (element.pressable && roblox && shared(box, roblox) > 0) return MESSAGE.underRoblox(nameOf(element));
  return null;
}

/** The phone check's findings at one size, in words: overlaps first, then edges. */
export function phoneFindings(measure: PhoneMeasure): string[] {
  const own = measure.elements.filter((element) => !element.touch && !element.clipped);
  const edges = own.map((element) => edgeFinding(element, measure)).filter((line) => line !== null);
  return [...overlaps(measure.elements), ...edges].slice(0, MAX_FINDINGS);
}

/** The place's own memory in MB, Studio's own kinds left out; one decimal. */
export function placeMemoryMb(memory: Record<string, number>): number {
  let total = 0;
  for (const [tag, mb] of Object.entries(memory))
    if (!STUDIO_MEMORY_TAGS.has(tag) && Number.isFinite(mb) && mb > 0) total += mb;
  return Math.round(total * 10) / 10;
}

/** Reads the phone step's measure, or null. */
function measureOf(answer: Record<string, unknown> | null): PhoneMeasure | null {
  if (!answer || !Array.isArray(answer.view)) return null;
  const elements = Array.isArray(answer.elements) ? (answer.elements as PhoneElement[]) : [];
  const memory = record(answer.memory) as Record<string, number>;
  return { ...(answer as unknown as PhoneMeasure), elements, memory };
}

/** One size: the device set from the player's client, measured, and its picture. */
async function measureSize(c: Ctx, source: string, player: string, size: (typeof PHONE_SIZES)[number]) {
  const args = { op: "measure", device: size.device, orientation: size.orientation };
  const answer = await luau(c, player, DataModel.Client, probeCode(source, args), PHONE_CALL_MS);
  const measure = answer.ok ? measureOf(objectOf(answer.text)) : null;
  if (!measure) return { line: MESSAGE.sizeFailed(size.label) };
  const findings = phoneFindings(measure);
  const [width = 0, height = 0] = measure.view.map(Math.round);
  const line = findings.length
    ? [MESSAGE.sizeFindings(size.label, width, height), ...findings.map((one) => `- ${one}.`)].join("\n")
    : MESSAGE.sizeClean(size.label, width, height);
  const image = await picture(c, player, size.label);
  return { line, measure, image };
}

/** Every size in turn: a line each, the pictures, and the most memory the place took. */
async function measureAll(c: Ctx, source: string, player: string) {
  const lines: string[] = [];
  const images: ProbePicture[] = [];
  let memory: number | null = null;
  for (const size of PHONE_SIZES) {
    if (c.game.signal?.aborted) break;
    const measured = await measureSize(c, source, player, size);
    lines.push(measured.line);
    if (measured.image) images.push(measured.image);
    if (measured.measure) memory = Math.max(memory ?? 0, placeMemoryMb(measured.measure.memory));
  }
  return { lines, images, memory };
}

/** The memory line: over or within a phone's budget, or unread. */
function memoryLine(memory: number | null): string {
  if (memory === null) return MESSAGE.memoryUnread;
  return memory > PHONE_MEMORY_BUDGET_MB ? MESSAGE.memoryOver(memory) : MESSAGE.memoryWithin(memory);
}

async function phoneCheck(c: Ctx): Promise<ProbeAnswer> {
  const source = await c.deps.luau(ProbeLuauFile.PhoneCheck);
  const player = c.play.players[0] ?? c.play.server;
  const now = await luau(c, player, DataModel.Client, probeCode(source, { op: "current" }));
  const earlier = now.ok ? objectOf(now.text) : null;
  if (!earlier || typeof earlier.device !== "string") throw new Error(now.text || MESSAGE.noPlay);
  // The simulator keeps its device past the play: the one shown before always goes back.
  const back = {
    op: "restore",
    device: earlier.device,
    ...(earlier.orientation ? { orientation: earlier.orientation } : {}),
  };
  try {
    const measured = await measureAll(c, source, player);
    return { note: [...measured.lines, memoryLine(measured.memory)].join("\n"), images: measured.images };
  } finally {
    await luau(c, player, DataModel.Client, probeCode(source, back), PHONE_CALL_MS);
  }
}

// The multiplayer check.

/** Every player as one data model sees them: name and stats by UserId. */
function playersSeen(answer: Record<string, unknown> | null): Map<string, { name: string; stats: ServerState }> | null {
  if (!answer || !Array.isArray(answer.players)) return null;
  const out = new Map<string, { name: string; stats: ServerState }>();
  for (const raw of answer.players) {
    const player = record(raw);
    const name = typeof player.name === "string" ? player.name : String(player.userId);
    const stats: ServerState = new Map();
    for (const [stat, value] of Object.entries(record(player.leaderstats))) stats.set(stat, String(value));
    for (const [attribute, value] of Object.entries(record(player.attributes)))
      stats.set(`attribute ${attribute}`, String(value));
    out.set(String(player.userId), { name, stats });
  }
  return out;
}

/** What one client sees differently from the server, in words. */
function clientDiffers(
  player: number,
  server: NonNullable<ReturnType<typeof playersSeen>>,
  client: NonNullable<ReturnType<typeof playersSeen>>,
): string[] {
  const found: string[] = [];
  for (const [id, held] of server) {
    const seen = client.get(id);
    if (!seen) {
      found.push(MESSAGE.unseen(player, held.name));
      continue;
    }
    for (const [stat, value] of held.stats) {
      const there = seen.stats.get(stat) ?? "nothing";
      if (there !== value) found.push(MESSAGE.differs(player, held.name, stat, there, value));
    }
  }
  return found;
}

/** Each client's view of every player against the server's, and each player's picture. */
async function clientViews(c: Ctx, held: ReturnType<typeof playersSeen>) {
  const differences: string[] = [];
  const images: ProbePicture[] = [];
  for (const [index, studio] of c.play.players.entries()) {
    const player = index + 1;
    const seen = await luau(c, studio, DataModel.Client, PLAY_LUAU.ServerState);
    const view = seen.ok ? playersSeen(objectOf(seen.text)) : null;
    if (!view) differences.push(MESSAGE.noView(player));
    else if (held) differences.push(...clientDiffers(player, held, view));
    const image = await picture(c, studio, MESSAGE.playerLabel(player));
    if (image) images.push(image);
  }
  return { differences, images };
}

/** Who the server has, and how many of the opened players that is. */
function serverLines(c: Ctx, held: ReturnType<typeof playersSeen>): string[] {
  if (!held) return [MESSAGE.noServer];
  const joined = [...held.values()].map((one) => one.name);
  const lines = [MESSAGE.joinedPlayers(joined.length, joined.join(", "))];
  if (joined.length < c.play.players.length) lines.push(MESSAGE.fewer(joined.length, c.play.players.length));
  return lines;
}

async function playersState(c: Ctx): Promise<ProbeAnswer> {
  const server = await luau(c, c.play.server, DataModel.Server, PLAY_LUAU.ServerState);
  const held = server.ok ? playersSeen(objectOf(server.text)) : null;
  const lines = serverLines(c, held);
  const { differences, images } = await clientViews(c, held);
  if (differences.length) lines.push(...differences.slice(0, MAX_FINDINGS).map((one) => `- ${one}.`));
  else if (held) lines.push(MESSAGE.sameView);
  return { note: lines.join("\n"), images };
}

/** The probes over Studio's MCP server and the play the play tools hold for a game. */
export function createProbes(
  deps: ProbeDeps,
  playing: (game: PlayGame) => PlayView | undefined,
): Record<RobloxProbe, PlayHandler> {
  const book = { captures: 0 };
  const on =
    (probe: (c: Ctx) => Promise<ProbeAnswer>): PlayHandler =>
    async (_args, game) => {
      const play = playing(game);
      if (!play) return { note: MESSAGE.noPlay, images: [] } satisfies ProbeAnswer;
      return probe({ deps, game, play, book });
    };
  return {
    [RobloxProbe.PlayersState]: on(playersState),
    [RobloxProbe.CheatRemotes]: on(cheatRemotes),
    [RobloxProbe.PhoneCheck]: on(phoneCheck),
  };
}
