/**
 * Roblox's own AI tools and uploads, as the Roblox Studio plugin's tools that ask the person first.
 * Each is declared with a `confirmation` card, so Genex asks every call, in every chat mode: they run
 * on the person's Roblox account, its limits apply, and moderation of what they make or upload lands
 * on that account. Studio's own tools behind them are never offered through the Roblox Studio
 * connection, whose cards Auto and Bypass skip (`studio-tools.ts`).
 *
 * - Every call goes to the game's own Studio, as its Genex helper is connected from it now:
 *   `studio_id` is filled here and is never the agent's.
 * - Lists (part names, images) arrive as one string, comma-separated or a JSON array, and are
 *   checked before anything is sent. Anything refused reaches no Studio.
 * - Pictures come from the game folder, never through a link, checked as PNG or JPEG of at most
 *   5 MB, or from an https address on a public name. Studio reads a game's picture from a private
 *   copy (`store-image`) or from this computer's loopback, served only for the call (`upload-image`).
 * - Generation and the playtest agent change or play the place, so they run under the agent's marks
 *   (`agent-marks.ts`): the Studio lock tells them from the person's own work.
 * - Studio's refusals, such as the daily cap on generated models, reach the agent in Studio's words.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { isIP } from "node:net";
import path from "node:path";
import { MINUTE_MS } from "../../shared/duration.ts";
import { readRegularFile } from "../../substrate/fsx.ts";
import { assertRelativePath } from "../../substrate/paths.ts";
import { agentBusyMarker, clearAgentPlay, markAgentPlay, readAgentMarks } from "./agent-marks.ts";
import { type StudioClient, StudioClientError, StudioClientFailure, type StudioToolResult } from "./studio-client.ts";
import { AskFirstTool, STUDIO_ID_ARG, StudioTool } from "./studio-tools.ts";

/** One Studio call's limit: a generation run in the foreground can take minutes. */
export const ASK_FIRST_CALL_MS = 5 * MINUTE_MS;
/** The longest prompt or description sent to Roblox's generators. */
const MAX_PROMPT_CHARS = 1000;
/** The longest task handed to Roblox's playtest or explore agent. */
const MAX_TASK_CHARS = 4000;
/** The longest title for an agent's task, as Studio shows it. */
const MAX_TITLE_CHARS = 60;
/** Part names a generated mesh or model may be split into (Studio cuts the rest). */
const MAX_GENERATED_PARTS = 8;
/** Part names a mesh may be segmented into. */
const MAX_SEGMENT_PARTS = 5;
const MAX_PART_NAME_CHARS = 60;
/** The longest Studio path to an instance (`Workspace.Model.Part`). */
const MAX_INSTANCE_PATH_CHARS = 300;
/** A generated material's name, as Studio names the MaterialVariant. */
const MATERIAL_NAME = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,49}$/;
/** A picture `store-image` gave back, the only kind of picture a generated model takes. */
const IMAGE_ID = /^IMAGEID_[A-Za-z0-9_-]{1,64}$/;
/** Triangles a generated mesh may be asked to stay under, as Studio bounds them. */
const MIN_TRIANGLES = 12;
const MAX_TRIANGLES = 20_000;
/** The largest side of a generated mesh's box, in studs. */
const MAX_SIZE_STUDS = 2048;
/** Images one upload sends. */
const MAX_IMAGES = 10;
/** The largest picture sent: Studio's own limit for `store_image`. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_URL_CHARS = 2048;
/** Where `store-image` keeps its private copies, in the plugin's storage. */
const IMAGE_COPIES = "images";

/** The tools here: every ask-first tool but the Creator Store insert (`insert-asset.ts`). */
export type AiTool = Exclude<AskFirstTool, typeof AskFirstTool.InsertAsset>;

/** How a generated mesh or model is split into parts, in Studio's words. Wire values: never rename. */
const Segmentation = { Auto: "auto", None: "none", Explicit: "explicit" } as const;
type Segmentation = (typeof Segmentation)[keyof typeof Segmentation];

/** A generated material's pattern, in Studio's words. Wire values: never rename. */
const MATERIAL_PATTERNS = ["Regular", "Organic"] as const;
/** The base materials Studio 0.743 generates from. Wire values: never rename. */
const BASE_MATERIALS = [
  "Plastic",
  "SmoothPlastic",
  "Wood",
  "WoodPlanks",
  "Marble",
  "Basalt",
  "Slate",
  "CrackedLava",
  "Concrete",
  "Limestone",
  "Granite",
  "Pavement",
  "Brick",
  "Pebble",
  "Cobblestone",
  "Rock",
  "Sandstone",
  "CorrodedMetal",
  "DiamondPlate",
  "Foil",
  "Metal",
  "Grass",
  "LeafyGrass",
  "Sand",
  "Fabric",
  "Snow",
  "Mud",
  "Ground",
  "Asphalt",
  "Salt",
  "Ice",
  "Glacier",
  "Cardboard",
  "Carpet",
  "CeramicTiles",
  "ClayRoofTiles",
  "RoofShingles",
  "Leather",
  "Plaster",
  "Rubber",
] as const;

/** Studio's own agents behind `subagent`. Wire values: never rename. */
const SubagentType = { Playtest: "playtest", Explore: "explore" } as const;
type SubagentType = (typeof SubagentType)[keyof typeof SubagentType];

/** The picture types Genex sends, by extension, with their first bytes. */
const IMAGE_TYPES = {
  ".png": { mime: "image/png", magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  ".jpg": { mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  ".jpeg": { mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
} as const;
type ImageExtension = keyof typeof IMAGE_TYPES;
const isImageExtension = (ext: string): ext is ImageExtension => Object.hasOwn(IMAGE_TYPES, ext);

const MESSAGE = {
  noStudio:
    "This game's place isn't open in Roblox Studio, or the Genex helper there isn't connected; ask the person to open it (the Roblox Studio button), then try again.",
  unanswered:
    "Roblox Studio stopped answering during the call, so whether it finished is unknown; look at the place before you repeat it.",
  refusedByRoblox: (words: string) => `Roblox Studio didn't do it: ${words}`,
  noFolder: "This call has no game folder to read a picture from.",
  needText: (name: string) => `${name} must be text.`,
  empty: (name: string) => `${name} can't be empty.`,
  tooLong: (name: string, max: number) => `${name} is longer than ${max} characters.`,
  oneLine: (name: string) => `${name} must be one line, with no control characters.`,
  list: (name: string) => `${name} must be names separated by commas, or a JSON array of names.`,
  tooMany: (name: string, max: number) => `${name} takes at most ${max}.`,
  oneOf: (name: string, options: readonly string[]) => `${name} must be one of: ${options.join(", ")}.`,
  partsWithoutExplicit: "Part names need segmentation explicit (or leave segmentation out).",
  explicitWithoutParts: "Segmentation explicit needs the part names in parts.",
  triangles: `triangles must be a whole number from ${MIN_TRIANGLES} to ${MAX_TRIANGLES}.`,
  size: `width, height and depth go together, each more than 0 and at most ${MAX_SIZE_STUDS} studs.`,
  needPromptOrImage: "Give a prompt, a picture from store-image, or both.",
  imageId: "image must be the IMAGEID_… that store-image answered.",
  instance: `instance must be a Studio path such as Workspace.Model.Part, one line of at most ${MAX_INSTANCE_PATH_CHARS} characters.`,
  materialName: "name must be letters, digits, spaces, _ or -, at most 50 characters, starting with a letter or digit.",
  boolean: (name: string) => `${name} must be true or false.`,
  address: (url: string) =>
    `${url.slice(0, 80)} isn't an image Genex sends: use an https address on a public name (no passwords, no local or private addresses), or a .png or .jpg file in the game folder.`,
  picture: (name: string) =>
    `${name.slice(0, 80)} isn't a picture Genex sends: it must be a .png or .jpg file of at most 5 MB in the game folder, reached with no link on the way.`,
} as const;

/** The game an ask-first call is for, as the backend reads it. */
export interface AskFirstGame {
  /** The game's own Studio, as its helper is connected from it now. */
  studio(): string | undefined;
  /** The game folder the call is bound to: where pictures are read from. */
  folder?: string;
  /** The plugin's storage: where private copies of pictures are kept for a call. */
  storage: string;
  /** The game's connection folder, where the agent's marks live. */
  marks?: string;
  signal?: AbortSignal;
}

/** What the ask-first tools need of the computer: Studio's MCP server, a clock, and a way to serve pictures. */
export interface AskFirstDeps {
  studio?: Pick<StudioClient, "callTool">;
  now(): number;
  /** Serves checked pictures on this computer's loopback for one call; the system's by default. */
  serve?(images: ServedImage[]): Promise<ImageServer>;
}

/** An ask-first tool's answer: done, Studio's words, and what Studio gave back when it can be read. */
export interface AskFirstAnswer {
  done: boolean;
  message: string;
  result?: unknown;
}

/** A picture checked and read, ready to be sent. */
export interface ServedImage {
  /** How the agent named it. */
  name: string;
  bytes: Buffer;
  mime: string;
  ext: ImageExtension;
}

/** Pictures served on this computer's loopback: one address each, in order, until closed. */
export interface ImageServer {
  urls: string[];
  close(): Promise<void>;
}

/** A refusal of the agent's arguments, caught before any Studio call. */
export class Refused extends Error {}
/** Refuses the agent's arguments in plain words. */
export const refuse = (message: string): never => {
  throw new Refused(message);
};

/** Which of the agent's marks (`agent-marks.ts`) a Studio call runs under. */
export const CallMark = {
  /** It changes the place: the busy mark. */
  Busy: "busy",
  /** It plays the game: the play mark. */
  Play: "play",
  /** It leaves the place as it is. */
  None: "none",
} as const;
export type CallMark = (typeof CallMark)[keyof typeof CallMark];

/** What a call needs besides its arguments: its marks, and anything to undo once it answers. */
interface Prepared {
  tool: StudioTool;
  args: Record<string, unknown>;
  mark: CallMark;
  cleanup?: () => Promise<void>;
  /** Studio's answer read back for the agent, when it can be. */
  read?: (text: string) => unknown;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them.
const LINE_BREAK_OR_CONTROL = /[\u0000-\u001f\u007f]/;

/** A text argument: present (unless optional), within its length, free of control characters. */
function textArg(
  args: Record<string, unknown>,
  name: string,
  max: number,
  options: { oneLine?: boolean; empty?: boolean } = {},
): string {
  const value = args[name];
  if (typeof value !== "string") return refuse(MESSAGE.needText(name));
  if (!value.trim() && !options.empty) return refuse(MESSAGE.empty(name));
  if (value.length > max) return refuse(MESSAGE.tooLong(name, max));
  if ((options.oneLine ? LINE_BREAK_OR_CONTROL : CONTROL).test(value)) return refuse(MESSAGE.oneLine(name));
  return value;
}

/** A text argument the agent may leave out. */
function optionalText(
  args: Record<string, unknown>,
  name: string,
  max: number,
  options: { oneLine?: boolean; empty?: boolean } = {},
) {
  return args[name] === undefined ? undefined : textArg(args, name, max, options);
}

function choiceArg<T extends string>(
  args: Record<string, unknown>,
  name: string,
  options: readonly T[],
): T | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  return options.includes(value as T) ? (value as T) : refuse(MESSAGE.oneOf(name, options));
}

function booleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || typeof value === "boolean") return value;
  return refuse(MESSAGE.boolean(name));
}

/** The items of a list string: a JSON array, or the pieces between commas; undefined when it is neither. */
function listItems(raw: string): unknown[] | undefined {
  if (!raw.startsWith("[")) return raw.split(",");
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A list that arrives as one string: a JSON array of strings, or names separated by commas. */
export function listArg(value: unknown, name: string, max: number, maxChars: number): string[] {
  const items = typeof value === "string" ? listItems(value.trim()) : undefined;
  if (!items?.every((item) => typeof item === "string")) return refuse(MESSAGE.list(name));
  const kept = items.map((item) => item.trim()).filter(Boolean);
  if (!kept.length) return refuse(MESSAGE.empty(name));
  if (kept.length > max) return refuse(MESSAGE.tooMany(name, max));
  if (kept.some((one) => one.length > maxChars)) return refuse(MESSAGE.tooLong(name, maxChars));
  if (kept.some((one) => LINE_BREAK_OR_CONTROL.test(one))) return refuse(MESSAGE.oneLine(name));
  return kept;
}

/** An instance's Studio path, when given: dotted names on one line. */
function instanceArg(args: Record<string, unknown>): Record<string, string> {
  const value = args.instance;
  if (value === undefined) return {};
  const ok =
    typeof value === "string" &&
    value.length <= MAX_INSTANCE_PATH_CHARS &&
    !LINE_BREAK_OR_CONTROL.test(value) &&
    value.split(".").every((name) => name.trim().length > 0);
  return ok ? { instance_path: value } : refuse(MESSAGE.instance);
}

/** Part names and how the result is split, as Studio's generators take them. */
function partsArgs(args: Record<string, unknown>): Record<string, string> {
  const segmentation = choiceArg(args, "segmentation", Object.values(Segmentation));
  if (args.parts === undefined) {
    if (segmentation === Segmentation.Explicit) refuse(MESSAGE.explicitWithoutParts);
    return segmentation ? { segmentation } : {};
  }
  if (segmentation && segmentation !== Segmentation.Explicit) refuse(MESSAGE.partsWithoutExplicit);
  const parts = listArg(args.parts, "parts", MAX_GENERATED_PARTS, MAX_PART_NAME_CHARS);
  return { partNames: JSON.stringify(parts), segmentation: Segmentation.Explicit };
}

/** Whether to answer a job id at once (Studio's `async`), when asked. */
function backgroundArg(args: Record<string, unknown>): Record<string, boolean> {
  const background = booleanArg(args, "background");
  return background === undefined ? {} : { async: background };
}

function trianglesArg(args: Record<string, unknown>): Record<string, number> {
  const value = args.triangles;
  if (value === undefined) return {};
  const ok = typeof value === "number" && Number.isInteger(value) && value >= MIN_TRIANGLES && value <= MAX_TRIANGLES;
  return ok ? { maxTriangles: value } : refuse(MESSAGE.triangles);
}

const isSide = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_SIZE_STUDS;

/** The box a generated mesh fits in, when all three sides are given. */
function sizeArg(args: Record<string, unknown>): Record<string, { x: number; y: number; z: number }> {
  const sides = [args.width, args.height, args.depth];
  if (sides.every((side) => side === undefined)) return {};
  const [x, y, z] = sides;
  if (!isSide(x) || !isSide(y) || !isSide(z)) return refuse(MESSAGE.size);
  return { size: { x, y, z } };
}

function generateMesh(args: Record<string, unknown>): Prepared {
  const textPrompt = textArg(args, "prompt", MAX_PROMPT_CHARS);
  return {
    tool: StudioTool.GenerateMesh,
    args: { textPrompt, ...partsArgs(args), ...trianglesArg(args), ...sizeArg(args), ...backgroundArg(args) },
    mark: CallMark.Busy,
  };
}

function generateModel(args: Record<string, unknown>): Prepared {
  const prompt = optionalText(args, "prompt", MAX_PROMPT_CHARS, { empty: true }) ?? "";
  const image = args.image;
  if (image !== undefined && (typeof image !== "string" || !IMAGE_ID.test(image))) refuse(MESSAGE.imageId);
  if (!prompt.trim() && image === undefined) refuse(MESSAGE.needPromptOrImage);
  return {
    tool: StudioTool.GenerateProceduralModel,
    args: {
      prompt,
      ...(image === undefined ? {} : { attachedImageUri: image }),
      ...partsArgs(args),
      ...backgroundArg(args),
    },
    mark: CallMark.Busy,
  };
}

function generateTexture(args: Record<string, unknown>): Prepared {
  const textPrompt = textArg(args, "prompt", MAX_PROMPT_CHARS);
  return { tool: StudioTool.GenerateTexture, args: { textPrompt, ...instanceArg(args) }, mark: CallMark.Busy };
}

function generateMaterial(args: Record<string, unknown>): Prepared {
  const materialId = textArg(args, "name", 50, { oneLine: true });
  if (!MATERIAL_NAME.test(materialId)) refuse(MESSAGE.materialName);
  const baseMaterial = choiceArg(args, "base", BASE_MATERIALS) ?? refuse(MESSAGE.oneOf("base", BASE_MATERIALS));
  const materialPattern =
    choiceArg(args, "pattern", MATERIAL_PATTERNS) ?? refuse(MESSAGE.oneOf("pattern", MATERIAL_PATTERNS));
  const materialDescription = textArg(args, "description", MAX_PROMPT_CHARS);
  return {
    tool: StudioTool.GenerateMaterial,
    args: { materialId, baseMaterial, materialPattern, materialDescription, ...backgroundArg(args) },
    mark: CallMark.Busy,
  };
}

function segmentMesh(args: Record<string, unknown>): Prepared {
  const parts = listArg(args.parts, "parts", MAX_SEGMENT_PARTS, MAX_PART_NAME_CHARS);
  return { tool: StudioTool.SegmentMesh, args: { parts, ...instanceArg(args) }, mark: CallMark.Busy };
}

/** The title Studio shows for an agent's task when the agent gives none. */
const SUBAGENT_TITLE = {
  [SubagentType.Playtest]: "Playtesting the game",
  [SubagentType.Explore]: "Exploring the place",
} as const satisfies Record<SubagentType, string>;

function subagent(type: SubagentType) {
  return (args: Record<string, unknown>): Prepared => {
    const task = textArg(args, "task", MAX_TASK_CHARS);
    const description = optionalText(args, "title", MAX_TITLE_CHARS, { oneLine: true }) ?? SUBAGENT_TITLE[type];
    // The playtest agent plays the game in Studio: what Studio reports meanwhile is the agent's play.
    const mark = type === SubagentType.Playtest ? CallMark.Play : CallMark.None;
    return { tool: StudioTool.Subagent, args: { task, description, subagent_type: type }, mark };
  };
}

const startsWith = (bytes: Buffer, magic: readonly number[]) => magic.every((byte, i) => bytes[i] === byte);

/**
 * A picture in the game folder by the agent's relative path: no link anywhere on the way, a regular
 * file of at most 5 MB with a picture's extension and a picture's first bytes. Read once, here.
 */
export async function gamePicture(folder: string, name: string): Promise<ServedImage> {
  const refused = () => refuse(MESSAGE.picture(name));
  try {
    assertRelativePath(name);
  } catch {
    return refused();
  }
  const ext = path.extname(name).toLowerCase();
  if (!isImageExtension(ext)) return refused();
  const segments = name.split("/");
  let at = folder;
  for (const segment of segments) {
    at = path.join(at, segment);
    const info = await lstat(at).catch(() => undefined);
    if (!info || info.isSymbolicLink()) return refused();
  }
  const bytes = await readRegularFile(at, MAX_IMAGE_BYTES).catch(() => undefined);
  if (!bytes || !startsWith(bytes, IMAGE_TYPES[ext].magic)) return refused();
  return { name, bytes, mime: IMAGE_TYPES[ext].mime, ext };
}

/** Whether an https address names a public host: no password, no IP address, nothing local. */
function publicImageUrl(value: string): boolean {
  if (value.length > MAX_URL_CHARS) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const local = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local");
  const ok = url.protocol === "https:" && !url.username && !url.password && host.includes(".");
  return ok && !local && isIP(host) === 0;
}

/** Each picture an upload names: an https address kept as is, else a game picture read and checked. */
async function uploadSources(args: Record<string, unknown>, game: AskFirstGame) {
  const names = listArg(args.images, "images", MAX_IMAGES, MAX_URL_CHARS);
  const sources: Array<{ name: string; url?: string; image?: ServedImage }> = [];
  for (const name of names) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(name)) {
      if (!publicImageUrl(name)) refuse(MESSAGE.address(name));
      sources.push({ name, url: name });
      continue;
    }
    if (!game.folder) refuse(MESSAGE.noFolder);
    sources.push({ name, image: await gamePicture(game.folder ?? "", name) });
  }
  return sources;
}

/** Studio's map of address to asset id, read back by the names the agent gave. */
function byName(text: string, names: Map<string, string>): unknown {
  try {
    const map: unknown = JSON.parse(text);
    if (!map || typeof map !== "object" || Array.isArray(map)) return undefined;
    return Object.fromEntries(Object.entries(map).map(([url, id]) => [names.get(url) ?? url, id]));
  } catch {
    return undefined;
  }
}

async function uploadImage(args: Record<string, unknown>, game: AskFirstGame, deps: AskFirstDeps): Promise<Prepared> {
  const sources = await uploadSources(args, game);
  const local = sources.flatMap((source) => (source.image ? [source.image] : []));
  const server = local.length ? await (deps.serve ?? serveImages)(local) : undefined;
  const served = new Map(local.map((image, i) => [image.name, server?.urls[i] ?? ""]));
  const urls = sources.map((source) => source.url ?? served.get(source.name) ?? "");
  const names = new Map(sources.map((source, i) => [urls[i] ?? "", source.name]));
  return {
    tool: StudioTool.UploadImage,
    args: { imagePaths: urls },
    mark: CallMark.None,
    ...(server ? { cleanup: () => server.close() } : {}),
    read: (text) => byName(text, names),
  };
}

async function storeImage(args: Record<string, unknown>, game: AskFirstGame): Promise<Prepared> {
  const name = textArg(args, "file", MAX_URL_CHARS, { oneLine: true });
  if (!game.folder) return refuse(MESSAGE.noFolder);
  const image = await gamePicture(game.folder, name);
  // Studio reads the bytes Genex checked, from a copy no one else writes to.
  const copies = path.join(game.storage, IMAGE_COPIES);
  await mkdir(copies, { recursive: true });
  const copy = path.join(copies, `${randomUUID()}${image.ext}`);
  await writeFile(copy, image.bytes, { flag: "wx", mode: 0o600 });
  return {
    tool: StudioTool.StoreImage,
    args: { filePath: copy },
    mark: CallMark.None,
    cleanup: () => rm(copy, { force: true }),
  };
}

/** Serves pictures on 127.0.0.1 at random paths, GET only, until closed. */
export async function serveImages(images: ServedImage[]): Promise<ImageServer> {
  const routes = new Map(images.map((image) => [`/${randomBytes(16).toString("hex")}${image.ext}`, image]));
  const server = createServer((request, response) => {
    const image = request.method === "GET" ? routes.get(request.url ?? "") : undefined;
    if (!image) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": image.mime, "content-length": image.bytes.length }).end(image.bytes);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    urls: [...routes.keys()].map((route) => `http://127.0.0.1:${port}${route}`),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The text of Studio's answer, its pictures left out. */
export const answerText = (result: StudioToolResult) =>
  result.content
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");

/** How a Studio call ended: done, refused in Studio's own words, or not reached or not answered. */
export interface StudioOutcome {
  ok: boolean;
  text: string;
  /** The words are Studio's own: its refusal, passed on as it said it. */
  studiosWords: boolean;
}

/** Runs one Studio call for the game under the marks its tool asks for. */
export async function askStudio(
  deps: AskFirstDeps,
  game: AskFirstGame,
  call: Pick<Prepared, "tool" | "args" | "mark">,
): Promise<StudioOutcome> {
  const studio = game.studio();
  if (!deps.studio || !studio) return { ok: false, text: MESSAGE.noStudio, studiosWords: false };
  const client = deps.studio;
  const limit = { timeoutMs: ASK_FIRST_CALL_MS };
  const options = game.signal ? { ...limit, signal: game.signal } : limit;
  const send = () => client.callTool(call.tool, { ...call.args, [STUDIO_ID_ARG]: studio }, options);
  const marks = game.marks;
  try {
    let result: StudioToolResult;
    if (!marks || call.mark === CallMark.None) result = await send();
    else if (call.mark === CallMark.Busy) result = await agentBusyMarker(marks, deps.now).around(send);
    else result = await asAgentsPlay(marks, deps.now, send);
    return { ok: !result.isError, text: answerText(result), studiosWords: true };
  } catch (error) {
    // Studio's own refusal, as its MCP server worded it; anything else left the outcome unknown.
    if (error instanceof StudioClientError && error.code === StudioClientFailure.Failed)
      return { ok: false, text: error.message, studiosWords: true };
    return { ok: false, text: MESSAGE.unanswered, studiosWords: false };
  }
}

/**
 * Runs `send` under the agent's play mark. A play the agent already runs keeps its own mark: this
 * call neither restamps nor ends it.
 */
async function asAgentsPlay<T>(marks: string, now: () => number, send: () => Promise<T>): Promise<T> {
  if ((await readAgentMarks(marks, now())).play) return send();
  await markAgentPlay(marks, now());
  return send().finally(() => clearAgentPlay(marks));
}

/** A refused call's words: Studio's own after a plain lead, or Genex's. */
export const refusedWords = (outcome: StudioOutcome) =>
  outcome.studiosWords ? MESSAGE.refusedByRoblox(outcome.text) : outcome.text;

/** Studio's answer to the agent: done with its words, or why not. */
function answered(prepared: Prepared, outcome: StudioOutcome): AskFirstAnswer {
  if (!outcome.ok) return { done: false, message: refusedWords(outcome) };
  const result = prepared.read?.(outcome.text);
  return { done: true, message: outcome.text, ...(result === undefined ? {} : { result }) };
}

/** The answer when the game has no Studio to call: undefined while it has one. */
export function unbound(deps: AskFirstDeps, game: AskFirstGame): AskFirstAnswer | undefined {
  return deps.studio && game.studio() ? undefined : { done: false, message: MESSAGE.noStudio };
}

/** Builds one tool's call from the agent's arguments; a refusal reaches no Studio. */
type Build = (args: Record<string, unknown>, game: AskFirstGame, deps: AskFirstDeps) => Prepared | Promise<Prepared>;

const BUILDS = {
  [AskFirstTool.GenerateMesh]: generateMesh,
  [AskFirstTool.GenerateModel]: generateModel,
  [AskFirstTool.GenerateTexture]: generateTexture,
  [AskFirstTool.GenerateMaterial]: generateMaterial,
  [AskFirstTool.SegmentMesh]: segmentMesh,
  [AskFirstTool.RobloxPlaytest]: subagent(SubagentType.Playtest),
  [AskFirstTool.RobloxExplore]: subagent(SubagentType.Explore),
  [AskFirstTool.UploadImage]: uploadImage,
  [AskFirstTool.StoreImage]: storeImage,
} as const satisfies Record<AiTool, Build>;

/** Runs a check of the agent's arguments, turning a refusal into the answer. */
export async function refusedOr<T>(work: () => Promise<T>): Promise<T | AskFirstAnswer> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Refused) return { done: false, message: error.message };
    throw error;
  }
}

/** One ask-first tool: the agent's arguments and the game they are for, answered in plain words. */
export type AskFirstHandler = (args: Record<string, unknown>, game: AskFirstGame) => Promise<AskFirstAnswer>;

/** The ask-first AI and upload tools over the computer they are given. */
export function createAiTools(deps: AskFirstDeps): Record<AiTool, AskFirstHandler> {
  const run =
    (tool: AiTool): AskFirstHandler =>
    async (args, game) => {
      const away = unbound(deps, game);
      if (away) return away;
      const prepared = await refusedOr(async () => BUILDS[tool](args, game, deps));
      if ("done" in prepared) return prepared;
      try {
        return answered(prepared, await askStudio(deps, game, prepared));
      } finally {
        await prepared.cleanup?.();
      }
    };
  return Object.fromEntries((Object.keys(BUILDS) as AiTool[]).map((tool) => [tool, run(tool)])) as Record<
    AiTool,
    AskFirstHandler
  >;
}
