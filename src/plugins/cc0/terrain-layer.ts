/**
 * `cc0__terrain-layer`: a PBR scan already in the game's assets (a `cc0__fetch` folder, or any
 * maps the caller names) packed into the two textures a Rust `TerrainLayer::textured(albedo,
 * data, tile)` reads (`native/genex-rust/crates/genex/src/terrain.rs`, `terrain.wgsl`):
 *
 * - albedo (RGBA8, sRGB): the colour map's RGB as it is, the height in alpha (the displacement's
 *   luminance stretched over its own range unless asked not to; 128 without one);
 * - data (RGBA8, linear): the OpenGL normal's x and y (a DirectX normal's green flipped), roughness
 *   (a roughness map, else an ARM map's green) and occlusion (an AO map, else ARM's red).
 *
 * Every map is resized to one size (the colour map's, its longer side capped at `size`): a box
 * filter down, bilinear up, the colour in linear light. The packing is pure (`packTerrainLayer`
 * over decoded maps) and the same maps always give the same bytes. The tool around it reads only
 * files whose real path stays inside the game, writes only under the game's `assets/`, and writes
 * nothing until every map has been read and packed.
 */
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { convertIndexedToRgb, decode as decodePng, encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import type { PluginScalar } from "../../plugin-sdk/index.d.ts";
import { Cc0Error } from "../../substrate/cc0-fetch.ts";
import { TextureUsage } from "../../substrate/asset-import/basis-encoder.ts";
import { assertRelativePath, containedReal, isBelow } from "../../substrate/paths.ts";
import { Cc0Map } from "./sources.ts";

/** Why a terrain layer was not packed. */
export const TerrainLayerRefusal = {
  InvalidArgument: "invalid-argument",
  PathRefused: "path-refused",
  MapMissing: "map-missing",
  NoColour: "no-colour-map",
  AmbiguousMap: "ambiguous-map",
  NotImage: "not-image",
  TooLarge: "image-too-large",
  OutsideAssets: "outside-assets",
} as const;
export type TerrainLayerRefusal = (typeof TerrainLayerRefusal)[keyof typeof TerrainLayerRefusal];

/** The scan maps a terrain layer reads, by their role in the CC0 plugin's map vocabulary, in packing order. */
export const TERRAIN_ROLES = [
  Cc0Map.Diff,
  Cc0Map.NorGl,
  Cc0Map.NorDx,
  Cc0Map.Rough,
  Cc0Map.Arm,
  Cc0Map.Ao,
  Cc0Map.Disp,
] as const;
export type TerrainRole = (typeof TERRAIN_ROLES)[number];

/** What each packed channel group holds. */
export const TerrainSlot = {
  Color: "color",
  Height: "height",
  Normal: "normal",
  Roughness: "roughness",
  Occlusion: "occlusion",
} as const;
export type TerrainSlot = (typeof TerrainSlot)[keyof typeof TerrainSlot];

/** The largest output side, the smallest, and the default cap. */
const SIZE_MAX = 4096;
const SIZE_MIN = 256;
const SIZE_DEFAULT = 2048;
/** The default metres per repeat in the Rust line, and the largest accepted. */
const TILE_DEFAULT = 4;
const TILE_MAX = 1000;
/** The most source pixels a map may decode to (an 8192 x 8192 map), and its largest file. */
const MAP_PIXELS_MAX = 8192 * 8192;
const MAP_BYTES_MAX = 256 * 1024 * 1024;
/** Where a PNG's IHDR width sits, and a PNG's and a JPEG's first bytes. */
const PNG_SIZE_AT = 16;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_START = [0xff, 0xd8] as const;
const RGBA = 4;
const BYTE_MAX = 255;
/** The neutral bytes of a missing role: mid height, a flat normal, full roughness and no occlusion. */
const NEUTRAL_HEIGHT = 128;
const FLAT_NORMAL = 128;
const NEUTRAL_FULL = BYTE_MAX;
/** A height range narrower than this is flat. */
const FLAT_RANGE = 1e-9;
/** Rec. 709 luminance weights. */
const LUMA_WEIGHTS = [0.2126, 0.7152, 0.0722] as const;
const ASSETS = "assets";
const OUT_DEFAULT = "assets/terrain";
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SEGMENT = /^[A-Za-z0-9._-]+$/;
const MAP_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg"]);
/** A `cc0__fetch` delivery folder, whose job id names its provenance record. */
const CC0_JOB_FOLDER = /^assets\/cc0\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The words of a map's file name that name its role: Poly Haven's and ambientCG's (lower case). */
const ROLE_WORDS: ReadonlyMap<string, TerrainRole> = new Map([
  ["diff", Cc0Map.Diff],
  ["diffuse", Cc0Map.Diff],
  ["color", Cc0Map.Diff],
  ["basecolor", Cc0Map.Diff],
  ["albedo", Cc0Map.Diff],
  ["normalgl", Cc0Map.NorGl],
  ["normaldx", Cc0Map.NorDx],
  ["rough", Cc0Map.Rough],
  ["roughness", Cc0Map.Rough],
  ["arm", Cc0Map.Arm],
  ["orm", Cc0Map.Arm],
  ["ao", Cc0Map.Ao],
  ["ambientocclusion", Cc0Map.Ao],
  ["disp", Cc0Map.Disp],
  ["displacement", Cc0Map.Disp],
]);
/** Two-word roles (Poly Haven's `nor_gl`, `nor_dx`). */
const ROLE_PAIRS: ReadonlyMap<string, TerrainRole> = new Map([
  ["nor gl", Cc0Map.NorGl],
  ["nor dx", Cc0Map.NorDx],
]);

const MESSAGE = {
  Refused: (code: string, detail: string) => `cc0 ${code}: ${detail}. Nothing was written.`,
  NoGame: "Open a game first: cc0__terrain-layer packs maps inside the bound game.",
  Name: "name is a plain name of letters, digits, _ and - (at most 64)",
  NotString: (key: string) => `${key} is a path relative to the game folder`,
  Size: `size is a power of two from ${SIZE_MIN} to ${SIZE_MAX}`,
  Tile: `tile is the metres one repeat covers, above 0 and at most ${TILE_MAX}`,
  Normalize: "normalize_height is true or false",
  Out: "out is a folder under assets/ (letters, digits, ., _ and -)",
  Path: (rel: string) => `${rel} is not a path inside the game folder`,
  Missing: (rel: string) => `${rel} does not exist in the game`,
  NotFolder: (rel: string) => `${rel} is not a folder`,
  NotFile: (rel: string) => `${rel} is not a regular file`,
  TooLarge: (rel: string) => `${rel} is larger than a map may be`,
  NotImage: "a map is not a whole PNG or JPEG",
  PixelsTooMany: "a map has more pixels than the packer decodes",
  NoColour: "no colour map (diff, Color): pass folder with one, or diff",
  Ambiguous: (role: string, a: string, b: string) => `two ${role} maps: ${a} and ${b}; name the one to use`,
  NotWritable: (rel: string) => `${rel} exists and is not a regular file`,
  Use: "Draw it with the rust line inside terrain.with_layers(..) in on_reset and declare the two textures in genex.toml (textures holds the rows) so they are GPU-compressed. albedo carries height in alpha for the layer blend; data is the normal's x and y, roughness and occlusion.",
} as const;

/** A decoded map: its samples as stored (1 to 4 channels, 8 or 16 bit) and their largest value. */
export interface MapImage {
  width: number;
  height: number;
  channels: number;
  max: number;
  data: Uint8Array | Uint8ClampedArray | Uint16Array;
}

/** One channel of an image, as numbers from 0 to 1. */
export interface Plane {
  width: number;
  height: number;
  data: Float32Array;
}

/** The two packed textures, their size and which map fed each channel group. */
export interface PackedTerrainLayer {
  width: number;
  height: number;
  albedo: Uint8Array;
  data: Uint8Array;
  channels: Record<TerrainSlot, TerrainRole | null>;
  missing: TerrainSlot[];
}

/** How to pack: the output's longest side, and whether the height spans its own range. */
export interface PackOptions {
  size: number;
  normalizeHeight: boolean;
}

/** The maps a layer packs, by role. */
export type TerrainMaps = Partial<Record<TerrainRole, MapImage>>;

const refusal = (code: TerrainLayerRefusal, detail: string) => new Cc0Error<TerrainLayerRefusal>(code, detail);

/** A map's role from its file name: the last word in it that names one, or null (not a PNG or JPEG, no role). */
export function terrainRoleOf(name: string): TerrainRole | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || !MAP_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())) return null;
  const words = name
    .slice(0, dot)
    .toLowerCase()
    .split(/[_\-\s.]+/);
  let role: TerrainRole | null = null;
  for (let i = 0; i < words.length; i++) {
    role = ROLE_PAIRS.get(`${words[i]} ${words[i + 1]}`) ?? ROLE_WORDS.get(words[i] ?? "") ?? role;
  }
  return role;
}

/** The map of each role among a folder's file names; two files of one role are refused. */
export function rolesInFolder(names: readonly string[]): Partial<Record<TerrainRole, string>> {
  const found: Partial<Record<TerrainRole, string>> = {};
  for (const name of [...names].sort()) {
    const role = terrainRoleOf(name);
    if (role === null) continue;
    const earlier = found[role];
    if (earlier !== undefined) throw refusal(TerrainLayerRefusal.AmbiguousMap, MESSAGE.Ambiguous(role, earlier, name));
    found[role] = name;
  }
  return found;
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[]) => prefix.every((byte, i) => bytes[i] === byte);

function decodePngMap(bytes: Uint8Array): MapImage {
  if (bytes.byteLength < PNG_SIZE_AT + 8) throw refusal(TerrainLayerRefusal.NotImage, MESSAGE.NotImage);
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(PNG_SIZE_AT) * header.getUint32(PNG_SIZE_AT + 4) > MAP_PIXELS_MAX)
    throw refusal(TerrainLayerRefusal.TooLarge, MESSAGE.PixelsTooMany);
  const png = decodePng(bytes);
  if (png.palette) {
    const channels = png.transparency ? RGBA : 3;
    return { width: png.width, height: png.height, channels, max: BYTE_MAX, data: convertIndexedToRgb(png) };
  }
  return { width: png.width, height: png.height, channels: png.channels, max: 2 ** png.depth - 1, data: png.data };
}

function decodeJpegMap(bytes: Uint8Array): MapImage {
  const image = jpeg.decode(bytes, {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: MAP_PIXELS_MAX / 1e6,
    maxMemoryUsageInMB: Math.ceil((MAP_PIXELS_MAX * RGBA * 2) / 1e6),
  });
  return { width: image.width, height: image.height, channels: RGBA, max: BYTE_MAX, data: image.data };
}

/** A PNG (any depth, grey to RGBA, palette) or JPEG decoded with its samples as stored; anything else is refused. */
export function decodeMap(bytes: Uint8Array): MapImage {
  let image: MapImage | null = null;
  try {
    if (startsWith(bytes, PNG_SIGNATURE)) image = decodePngMap(bytes);
    else if (startsWith(bytes, JPEG_START)) image = decodeJpegMap(bytes);
  } catch (error) {
    if (error instanceof Cc0Error) throw error;
    throw refusal(TerrainLayerRefusal.NotImage, error instanceof Error ? error.message : String(error));
  }
  const whole = image !== null && image.width > 0 && image.height > 0;
  if (!whole || image === null) throw refusal(TerrainLayerRefusal.NotImage, MESSAGE.NotImage);
  return image;
}

/** Which value of a texel a plane takes: a colour channel (0-2) or the luminance. */
const LUMA = "luma";
type ChannelPick = 0 | 1 | 2 | typeof LUMA;

/** Colour channel `channel` (0-2) of texel `pixel`, from 0 to 1; a grey map answers its grey for each. */
function sampleAt(image: MapImage, pixel: number, channel: number): number {
  const colourChannel = image.channels < 3 ? 0 : channel;
  return (image.data[pixel * image.channels + colourChannel] ?? 0) / image.max;
}

/** One channel (or the luminance) of `image` as a plane. */
function planeOf(image: MapImage, pick: ChannelPick): Plane {
  const pixels = image.width * image.height;
  const data = new Float32Array(pixels);
  for (let p = 0; p < pixels; p++) {
    data[p] =
      pick === LUMA
        ? LUMA_WEIGHTS[0] * sampleAt(image, p, 0) +
          LUMA_WEIGHTS[1] * sampleAt(image, p, 1) +
          LUMA_WEIGHTS[2] * sampleAt(image, p, 2)
        : sampleAt(image, p, pick);
  }
  return { width: image.width, height: image.height, data };
}

/** `plane` with `f` applied to every value. */
function mapPlane(plane: Plane, f: (value: number) => number): Plane {
  return { width: plane.width, height: plane.height, data: plane.data.map(f) };
}

/** One output texel's source indices along an axis and their weights (summing to 1). */
interface Tap {
  at: number[];
  weight: number[];
}

/** Output texel `i`'s box: the exact area-weighted mean of the source texels it covers. */
function boxTap(i: number, scale: number, from: number): Tap {
  const start = i * scale;
  const end = start + scale;
  const tap: Tap = { at: [], weight: [] };
  for (let j = Math.floor(start); j < Math.min(from, Math.ceil(end)); j++) {
    const cover = Math.min(end, j + 1) - Math.max(start, j);
    if (cover <= 0) continue;
    tap.at.push(j);
    tap.weight.push(cover / scale);
  }
  return tap;
}

/** Output texel `i` between its two nearest source texels (centres aligned, edges clamped). */
function linearTap(i: number, scale: number, from: number): Tap {
  const x = (i + 0.5) * scale - 0.5;
  const j = Math.floor(x);
  const t = x - j;
  const clamp = (k: number) => Math.min(from - 1, Math.max(0, k));
  return { at: [clamp(j), clamp(j + 1)], weight: [1 - t, t] };
}

function axisTaps(from: number, to: number): Tap[] {
  const scale = from / to;
  return Array.from({ length: to }, (_, i) => (scale >= 1 ? boxTap(i, scale, from) : linearTap(i, scale, from)));
}

/** Where texel `i` of line `line` sits in a buffer: the distance between lines and between texels. */
interface Stride {
  line: number;
  texel: number;
}

/** One tap's weighted sum of a line's source texels. */
function tapSum(source: Float32Array, tap: Tap, base: number, step: number): number {
  let sum = 0;
  for (let k = 0; k < tap.at.length; k++) sum += (source[base + (tap.at[k] ?? 0) * step] ?? 0) * (tap.weight[k] ?? 0);
  return sum;
}

/** `plane` resized along one axis: rows when `horizontal`, else columns. */
function resizeAxis(plane: Plane, to: number, horizontal: boolean): Plane {
  const from = horizontal ? plane.width : plane.height;
  if (from === to) return plane;
  const width = horizontal ? to : plane.width;
  const height = horizontal ? plane.height : to;
  const lines = horizontal ? plane.height : plane.width;
  const source: Stride = horizontal ? { line: plane.width, texel: 1 } : { line: 1, texel: plane.width };
  const target: Stride = horizontal ? { line: width, texel: 1 } : { line: 1, texel: width };
  const taps = axisTaps(from, to);
  const data = new Float32Array(width * height);
  for (let line = 0; line < lines; line++) {
    taps.forEach((tap, i) => {
      data[line * target.line + i * target.texel] = tapSum(plane.data, tap, line * source.line, source.texel);
    });
  }
  return { width, height, data };
}

/** `plane` at `width` x `height`: a box filter on an axis that shrinks, bilinear on one that grows; the same plane when it is that size. */
export function resizePlane(plane: Plane, width: number, height: number): Plane {
  if (plane.width === width && plane.height === height) return plane;
  return resizeAxis(resizeAxis(plane, width, true), height, false);
}

/** The output size: the colour map's, its longer side brought down to `cap`. */
export function outputSize(width: number, height: number, cap: number): { width: number; height: number } {
  const longer = Math.max(width, height);
  if (longer <= cap) return { width, height };
  const scale = cap / longer;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
const toByte = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * BYTE_MAX);

/** A colour channel at the output size, filtered in linear light when it is resized. */
function colourPlane(image: MapImage, channel: 0 | 1 | 2, width: number, height: number): Plane {
  const plane = planeOf(image, channel);
  if (plane.width === width && plane.height === height) return plane;
  return mapPlane(resizePlane(mapPlane(plane, srgbToLinear), width, height), linearToSrgb);
}

/** `plane` stretched so its own lowest value is 0 and highest 1; a flat one is 0.5 throughout. */
function stretched(plane: Plane): Plane {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const value of plane.data) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  const range = high - low;
  if (range <= FLAT_RANGE) return mapPlane(plane, () => 0.5);
  return mapPlane(plane, (value) => (value - low) / range);
}

/** Where a channel group may come from, in order of preference: a role and the value it takes. */
type Source = readonly [TerrainRole, ChannelPick];
const HEIGHT_SOURCES: readonly Source[] = [[Cc0Map.Disp, LUMA]];
const NORMAL_X_SOURCES: readonly Source[] = [
  [Cc0Map.NorGl, 0],
  [Cc0Map.NorDx, 0],
];
const NORMAL_Y_SOURCES: readonly Source[] = [
  [Cc0Map.NorGl, 1],
  [Cc0Map.NorDx, 1],
];
const ROUGHNESS_SOURCES: readonly Source[] = [
  [Cc0Map.Rough, 0],
  [Cc0Map.Arm, 1],
];
const OCCLUSION_SOURCES: readonly Source[] = [
  [Cc0Map.Ao, 0],
  [Cc0Map.Arm, 0],
];

interface Fed {
  plane: Plane;
  role: TerrainRole;
}

/** The first source `maps` holds, at the output size. */
function firstOf(maps: TerrainMaps, sources: readonly Source[], width: number, height: number): Fed | null {
  for (const [role, pick] of sources) {
    const image = maps[role];
    if (image) return { plane: resizePlane(planeOf(image, pick), width, height), role };
  }
  return null;
}

/** The two textures' bytes from the planes (null: the role's neutral value). */
function interleave(colour: Plane[], groups: Array<Plane | null>, neutral: number[], pixels: number) {
  const albedo = new Uint8Array(pixels * RGBA);
  const data = new Uint8Array(pixels * RGBA);
  const [heightPlane, ...dataPlanes] = groups;
  for (let p = 0; p < pixels; p++) {
    const at = p * RGBA;
    for (let c = 0; c < 3; c++) albedo[at + c] = toByte(colour[c]?.data[p] ?? 0);
    albedo[at + 3] = heightPlane ? toByte(heightPlane.data[p] ?? 0) : (neutral[0] ?? 0);
    for (let c = 0; c < RGBA; c++) {
      const plane = dataPlanes[c];
      data[at + c] = plane ? toByte(plane.data[p] ?? 0) : (neutral[c + 1] ?? 0);
    }
  }
  return { albedo, data };
}

/**
 * The two textures of a terrain layer packed from `maps` (see the module comment). Refuses a
 * layer with no colour map (`no-colour-map`); every other missing role takes its neutral value.
 */
export function packTerrainLayer(maps: TerrainMaps, options: PackOptions): PackedTerrainLayer {
  const diff = maps[Cc0Map.Diff];
  if (!diff) throw refusal(TerrainLayerRefusal.NoColour, MESSAGE.NoColour);
  const { width, height } = outputSize(diff.width, diff.height, options.size);
  const colour = ([0, 1, 2] as const).map((channel) => colourPlane(diff, channel, width, height));
  const heightFed = firstOf(maps, HEIGHT_SOURCES, width, height);
  const x = firstOf(maps, NORMAL_X_SOURCES, width, height);
  const y = firstOf(maps, NORMAL_Y_SOURCES, width, height);
  const rough = firstOf(maps, ROUGHNESS_SOURCES, width, height);
  const occlusion = firstOf(maps, OCCLUSION_SOURCES, width, height);
  const heightPlane = heightFed && options.normalizeHeight ? stretched(heightFed.plane) : (heightFed?.plane ?? null);
  // A DirectX normal's green points down the texture: OpenGL's points up.
  const yPlane = y?.role === Cc0Map.NorDx ? mapPlane(y.plane, (value) => 1 - value) : (y?.plane ?? null);
  const groups = [heightPlane, x?.plane ?? null, yPlane, rough?.plane ?? null, occlusion?.plane ?? null];
  const neutral = [NEUTRAL_HEIGHT, FLAT_NORMAL, FLAT_NORMAL, NEUTRAL_FULL, NEUTRAL_FULL];
  const { albedo, data } = interleave(colour, groups, neutral, width * height);
  const channels: Record<TerrainSlot, TerrainRole | null> = {
    [TerrainSlot.Color]: Cc0Map.Diff,
    [TerrainSlot.Height]: heightFed?.role ?? null,
    [TerrainSlot.Normal]: x?.role ?? null,
    [TerrainSlot.Roughness]: rough?.role ?? null,
    [TerrainSlot.Occlusion]: occlusion?.role ?? null,
  };
  const missing = Object.values(TerrainSlot).filter((slot) => channels[slot] === null);
  return { width, height, albedo, data, channels, missing };
}

/** A checked `cc0__terrain-layer` call. */
interface TerrainLayerRequest {
  name: string;
  folder: string | null;
  paths: Partial<Record<TerrainRole, string>>;
  out: string;
  size: number;
  normalizeHeight: boolean;
  tile: number;
}

const invalid = (detail: string) => refusal(TerrainLayerRefusal.InvalidArgument, detail);

function optionalString(args: Record<string, PluginScalar>, key: string): string | null {
  const value = args[key];
  if (value === undefined) return null;
  if (typeof value !== "string" || !value) throw invalid(MESSAGE.NotString(key));
  return value;
}

function optionalNumber(args: Record<string, PluginScalar>, key: string, fallback: number, detail: string): number {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid(detail);
  return value;
}

const isSize = (size: number) =>
  Number.isInteger(size) && size >= SIZE_MIN && size <= SIZE_MAX && Number.isInteger(Math.log2(size));

/** The output folder: `assets` or a plain folder under it. */
function checkedOut(out: string): string {
  const segments = out.split("/");
  const plain = segments.every((segment) => SEGMENT.test(segment) && segment !== "." && segment !== "..");
  if (!plain || segments[0] !== ASSETS) throw refusal(TerrainLayerRefusal.OutsideAssets, MESSAGE.Out);
  return out;
}

/** `args` checked: types, ranges, names and the output folder's shape, before any file is touched. */
export function checkedTerrainRequest(args: Record<string, PluginScalar>): TerrainLayerRequest {
  const name = args.name;
  if (typeof name !== "string" || !NAME.test(name)) throw invalid(MESSAGE.Name);
  const paths: Partial<Record<TerrainRole, string>> = {};
  for (const role of TERRAIN_ROLES) {
    const given = optionalString(args, role);
    if (given !== null) paths[role] = given;
  }
  const size = optionalNumber(args, "size", SIZE_DEFAULT, MESSAGE.Size);
  if (!isSize(size)) throw invalid(MESSAGE.Size);
  const tile = optionalNumber(args, "tile", TILE_DEFAULT, MESSAGE.Tile);
  if (tile <= 0 || tile > TILE_MAX) throw invalid(MESSAGE.Tile);
  const normalize = args.normalize_height ?? true;
  if (typeof normalize !== "boolean") throw invalid(MESSAGE.Normalize);
  const out = checkedOut(optionalString(args, "out") ?? OUT_DEFAULT);
  return { name, folder: optionalString(args, "folder"), paths, out, size, normalizeHeight: normalize, tile };
}

const isMissing = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code === "ENOENT";

/** The real path of game-relative `rel`, refused unless it exists strictly inside the game once links are followed. */
async function gameFile(game: string, rel: string): Promise<string> {
  try {
    assertRelativePath(rel);
    return await containedReal(game, rel);
  } catch (error) {
    if (isMissing(error)) throw refusal(TerrainLayerRefusal.MapMissing, MESSAGE.Missing(rel));
    throw refusal(TerrainLayerRefusal.PathRefused, MESSAGE.Path(rel));
  }
}

/** Each role's game-relative path: the folder's maps by name, then the ones named explicitly. */
async function rolePaths(game: string, request: TerrainLayerRequest): Promise<Partial<Record<TerrainRole, string>>> {
  const paths: Partial<Record<TerrainRole, string>> = {};
  if (request.folder !== null) {
    const folder = request.folder.replace(/\/+$/, "");
    const real = await gameFile(game, folder);
    if (!(await stat(real)).isDirectory()) throw refusal(TerrainLayerRefusal.PathRefused, MESSAGE.NotFolder(folder));
    const named = rolesInFolder(await readdir(real));
    for (const role of TERRAIN_ROLES) {
      const name = named[role];
      if (name !== undefined) paths[role] = `${folder}/${name}`;
    }
  }
  return { ...paths, ...request.paths };
}

/** Every role's map read and decoded; any path, size or format problem refuses the whole call. */
async function readMaps(game: string, paths: Partial<Record<TerrainRole, string>>): Promise<TerrainMaps> {
  const maps: TerrainMaps = {};
  for (const role of TERRAIN_ROLES) {
    const rel = paths[role];
    if (rel === undefined) continue;
    const real = await gameFile(game, rel);
    const info = await stat(real);
    if (!info.isFile()) throw refusal(TerrainLayerRefusal.PathRefused, MESSAGE.NotFile(rel));
    if (info.size > MAP_BYTES_MAX) throw refusal(TerrainLayerRefusal.TooLarge, MESSAGE.TooLarge(rel));
    maps[role] = decodeMap(new Uint8Array(await readFile(real)));
  }
  return maps;
}

/**
 * The real output folder, made where missing: each part of `out` is checked by real path before
 * anything is made under it, `assets` inside the game and the rest inside `assets`.
 */
async function outputFolder(game: string, out: string): Promise<string> {
  const base = await realpath(game);
  let at = base;
  let assets: string | null = null;
  for (const segment of out.split("/")) {
    const next = path.join(at, segment);
    if (!(await lstat(next).catch(() => null))) await mkdir(next);
    const real = await realpath(next);
    const inside = isBelow(assets ?? base, real) && (await stat(real)).isDirectory();
    if (!inside) throw refusal(TerrainLayerRefusal.PathRefused, MESSAGE.Path(out));
    assets ??= real;
    at = real;
  }
  return at;
}

/** Writes each file through a fresh sibling and a rename, after checking every destination is a regular file or absent. */
async function writeOutputs(files: ReadonlyArray<{ file: string; rel: string; bytes: Uint8Array }>): Promise<void> {
  for (const { file, rel } of files) {
    const info = await lstat(file).catch(() => null);
    if (info && !info.isFile()) throw refusal(TerrainLayerRefusal.PathRefused, MESSAGE.NotWritable(rel));
  }
  for (const { file, bytes } of files) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

/** The CC0 delivery a packed layer derives from (its record's source facts), when its colour map came from one. */
export interface TerrainDerivation {
  jobId: string;
  source: string;
  id: string;
  licence: string;
  page: string;
  authors: string[];
}

/** Reads a delivery record by job id (the plugin's `jobs.read`). */
export type ReadJob = (id: string) => Promise<unknown>;

async function derivationOf(colour: string | undefined, readJob: ReadJob): Promise<TerrainDerivation | null> {
  const jobId = CC0_JOB_FOLDER.exec(path.posix.dirname(colour ?? ""))?.[1];
  if (jobId === undefined) return null;
  const record = (await readJob(jobId)) as Partial<TerrainDerivation> | null;
  if (!record || typeof record.source !== "string" || typeof record.id !== "string") return null;
  const authors = Array.isArray(record.authors) ? record.authors.filter((a) => typeof a === "string") : [];
  return {
    jobId,
    source: record.source,
    id: record.id,
    licence: String(record.licence ?? ""),
    page: String(record.page ?? ""),
    authors,
  };
}

/** The Rust line that draws the layer, its tile always written as an f32 literal. */
const rustLine = (albedo: string, data: string, tile: number) =>
  `TerrainLayer::textured(${JSON.stringify(albedo)}, ${JSON.stringify(data)}, ${Number.isInteger(tile) ? tile.toFixed(1) : String(tile)})`;

/** The genex.toml rows that have Studio compress the two textures. */
const textureRows = (albedo: string, data: string) =>
  `[[texture]]\npath = ${JSON.stringify(albedo)}\nusage = "${TextureUsage.Color}"\n\n[[texture]]\npath = ${JSON.stringify(data)}\nusage = "${TextureUsage.Data}"\n`;

async function packIntoGame(args: Record<string, PluginScalar>, game: string, readJob: ReadJob) {
  const request = checkedTerrainRequest(args);
  const paths = await rolePaths(game, request);
  const maps = await readMaps(game, paths);
  const packed = packTerrainLayer(maps, { size: request.size, normalizeHeight: request.normalizeHeight });
  const albedoPng = encodePng({
    width: packed.width,
    height: packed.height,
    data: packed.albedo,
    depth: 8,
    channels: RGBA,
  });
  const dataPng = encodePng({
    width: packed.width,
    height: packed.height,
    data: packed.data,
    depth: 8,
    channels: RGBA,
  });
  const folder = await outputFolder(game, request.out);
  const under = request.out === ASSETS ? "" : `${request.out.slice(ASSETS.length + 1)}/`;
  const albedo = `${under}${request.name}_albedo.png`;
  const data = `${under}${request.name}_data.png`;
  await writeOutputs([
    { file: path.join(folder, path.posix.basename(albedo)), rel: `${ASSETS}/${albedo}`, bytes: albedoPng },
    { file: path.join(folder, path.posix.basename(data)), rel: `${ASSETS}/${data}`, bytes: dataPng },
  ]);
  const derivedFrom = await derivationOf(paths[Cc0Map.Diff], readJob);
  return {
    albedo,
    data,
    files: [`${ASSETS}/${albedo}`, `${ASSETS}/${data}`],
    size: { width: packed.width, height: packed.height },
    found: TERRAIN_ROLES.filter((role) => maps[role] !== undefined),
    missing: packed.missing,
    channels: packed.channels,
    ...(derivedFrom ? { derivedFrom } : {}),
    rust: rustLine(albedo, data, request.tile),
    textures: textureRows(albedo, data),
    use: MESSAGE.Use,
  };
}

/**
 * The `cc0__terrain-layer` tool in the game at `directory`: checks the call, reads and packs the
 * maps, then writes the two PNGs under `assets/`. A refusal is `cc0 <code>: <detail>` with
 * nothing written.
 */
export async function terrainLayer(
  args: Record<string, PluginScalar>,
  directory: string | undefined,
  readJob: ReadJob,
) {
  if (!directory) throw new Error(MESSAGE.NoGame);
  try {
    return await packIntoGame(args, directory, readJob);
  } catch (error) {
    if (error instanceof Cc0Error) throw new Error(MESSAGE.Refused(error.code, error.message));
    throw error;
  }
}
