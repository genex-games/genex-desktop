/**
 * The loose-texture encode step (game systems C-12): a game's PNG or JPEG whose usage resolved
 * (`texture-usage.ts`: a `[[texture]]` row, a material slot, a provenance role, a Live
 * observation) is encoded once to a mipmapped UASTC KTX2 by the pinned Basis Universal v2.50
 * encoder (`basis-encoder.ts`), then transcoded into one fixed-format KTX2 per texture family its
 * destinations may pick (`transcodeKtx2Families`), written beside the source as
 * `<stem>.<family>.ktx2`. The source stays: it is the fallback a device without the family decodes.
 *
 * Every image is decoded first (fast-png, jpeg-js), so a damaged one is refused typed. A square
 * power-of-two image then goes to the encoder as it is; any other (or one past the largest class)
 * is resampled into its square power-of-two class
 * (`resample.ts`) and handed over as a lossless PNG, and the receipt's texture record names the
 * source size and the class (the issue `resampled`). Everything here is a pure function of the
 * bytes and the usage, so an unchanged texture imports to the same bytes and C-3's cache serves it.
 *
 * fast-png and jpeg-js are loaded on first use, so a step that never decodes an image (and an app
 * that does not carry them yet) never loads them.
 *
 * The importer half ({@link encodeTexture}) runs in the importer's sandbox; the host half
 * ({@link stageTextureUsages}) reads a stage's `genex.toml` and models to say which files to encode.
 */
import path from "node:path";
import type { DecodedPng } from "fast-png";
import { type AssetImportSettings, type ImportIssue, ImportIssueCode } from "../../shared/asset-db.ts";
import { assetExtension } from "../../shared/game-assets.ts";
import { readGenexToml } from "../genex-toml.ts";
import {
  BASIS_ENCODER,
  type BasisEncoderModule,
  basisEncoder,
  encodeKtx2,
  type TextureUsage,
} from "./basis-encoder.ts";
import { decoderFile, ImporterToolFolder } from "./decoders.ts";
import { isGlb, readGlb } from "./glb.ts";
import { AssetImportRefusal } from "./import-plan.ts";
import { type Ktx2FamilyFile, transcodeKtx2Families } from "./ktx2.ts";
import { type RgbaImage, resampleSquare, TEXTURE_SIDE_MAX, textureSideClass } from "./resample.ts";
import { readGameAsset } from "./safe-asset.ts";
import type { TextureCompression } from "./texture-table.ts";
import {
  isEncodableTexture,
  isTextureUsage,
  mergeImageSlots,
  referencedImageSlots,
  resolveTextureUsages,
  type TextureUsageResolution,
  usageLockFacts,
} from "./texture-usage.ts";

/** The most source pixels the step decodes (an 8192 x 8192 image); a larger one is refused `too-large`. */
export const TEXTURE_SOURCE_PIXELS_MAX = 8192 * 8192;
/** The largest model the host reads for its material slots. */
const MODEL_READ_MAX_BYTES = 256 * 1024 * 1024;
/** The extensions of the models whose material slots name loose textures. */
const MODEL_EXTENSIONS: ReadonlySet<string> = new Set(["gltf", "glb"]);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
/** Where a PNG's IHDR width and height sit. */
const PNG_SIZE_AT = 16;
const JPEG_START = [0xff, 0xd8] as const;
const RGBA = 4;
const BYTE_MAX = 255;
const SIXTEEN_BIT_MAX = 65535;

const MESSAGE = {
  NotImage: "not a whole PNG or JPEG file",
  TooLarge: "the image has more pixels than the importer decodes",
  NoUsage: "texture-encode needs a usage",
  Skipped: "the encoder left the texture without a full mip chain",
} as const;

/** Why a texture could not be decoded, with the typed refusal the step answers. */
export class TextureDecodeError extends Error {
  readonly refusal: AssetImportRefusal;
  constructor(refusal: AssetImportRefusal, message: string) {
    super(message);
    this.name = "TextureDecodeError";
    this.refusal = refusal;
  }
}

/** What the receipt records about an encoded texture: its usage, the source size and the class it was encoded at. */
export interface EncodedTexture {
  usage: TextureUsage;
  width: number;
  height: number;
  /** The square power-of-two side every family file has. */
  side: number;
}

/** A texture's family files and its record. */
export interface TextureEncodeResult {
  files: Ktx2FamilyFile[];
  texture: EncodedTexture;
}

const isPng = (bytes: Uint8Array) => PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
const isJpeg = (bytes: Uint8Array) => JPEG_START.every((byte, i) => bytes[i] === byte);
const isSquarePowerOfTwo = (width: number, height: number) =>
  width === height && width > 0 && Number.isInteger(Math.log2(width));
const isSide = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= TEXTURE_SIDE_MAX;
const isPositive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/** A palette PNG's indices as RGBA8 (an entry with no alpha is opaque). */
function paletteToRgba(png: DecodedPng, palette: NonNullable<DecodedPng["palette"]>): Uint8Array {
  const pixels = png.width * png.height;
  const out = new Uint8Array(pixels * RGBA);
  for (let p = 0; p < pixels; p++) {
    const entry = palette[png.data[p] ?? 0] ?? [0, 0, 0];
    out.set([entry[0] ?? 0, entry[1] ?? 0, entry[2] ?? 0, entry[3] ?? BYTE_MAX], p * RGBA);
  }
  return out;
}

/** A decoded PNG's samples as RGBA8, whatever its channels, depth or palette. */
function pngToRgba(png: DecodedPng): Uint8Array {
  if (png.palette) return paletteToRgba(png, png.palette);
  const pixels = png.width * png.height;
  const out = new Uint8Array(pixels * RGBA);
  const max = png.depth === 16 ? SIXTEEN_BIT_MAX : 2 ** png.depth - 1;
  const byte = (at: number) => Math.round(((png.data[at] ?? 0) * BYTE_MAX) / max);
  const { channels } = png;
  for (let p = 0; p < pixels; p++) {
    const at = p * channels;
    const grey = channels < 3;
    const [r, g, b] = grey ? [byte(at), byte(at), byte(at)] : [byte(at), byte(at + 1), byte(at + 2)];
    const hasAlpha = channels === 2 || channels === 4;
    out.set([r, g, b, hasAlpha ? byte(at + channels - 1) : BYTE_MAX], p * RGBA);
  }
  return out;
}

/** A PNG's size from its header, or null when there is no whole header. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < PNG_SIZE_AT + 8) return null;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: data.getUint32(PNG_SIZE_AT), height: data.getUint32(PNG_SIZE_AT + 4) };
}

/** A PNG decoded, its size checked against the cap before any pixel is allocated. */
async function decodePngImage(bytes: Uint8Array): Promise<RgbaImage> {
  const size = pngSize(bytes);
  if (!size) throw new TextureDecodeError(AssetImportRefusal.Malformed, MESSAGE.NotImage);
  if (size.width * size.height > TEXTURE_SOURCE_PIXELS_MAX)
    throw new TextureDecodeError(AssetImportRefusal.TooLarge, MESSAGE.TooLarge);
  const { decode } = await import("fast-png");
  const png = decode(bytes);
  if (!isPositive(png.width) || !isPositive(png.height))
    throw new TextureDecodeError(AssetImportRefusal.Malformed, MESSAGE.NotImage);
  return { width: png.width, height: png.height, data: pngToRgba(png) };
}

/** Whether a JPEG marker starts a frame (SOF0..SOF15 but DHT, JPG and DAC). */
const isStartOfFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);

/** A JPEG's frame size from its first start-of-frame segment, or null when there is none. */
function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = JPEG_START.length;
  while (at + 9 < bytes.byteLength) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (isStartOfFrame(marker)) return { width: data.getUint16(at + 7), height: data.getUint16(at + 5) };
    at += 2 + data.getUint16(at + 2);
  }
  return null;
}

/** A JPEG decoded to RGBA8, its frame size checked against the cap before any pixel is allocated. */
async function decodeJpegImage(bytes: Uint8Array): Promise<RgbaImage> {
  const size = jpegSize(bytes);
  if (!size) throw new TextureDecodeError(AssetImportRefusal.Malformed, MESSAGE.NotImage);
  if (size.width * size.height > TEXTURE_SOURCE_PIXELS_MAX)
    throw new TextureDecodeError(AssetImportRefusal.TooLarge, MESSAGE.TooLarge);
  const { default: jpeg } = await import("jpeg-js");
  const image = jpeg.decode(bytes, {
    useTArray: true,
    formatAsRGBA: true,
    maxResolutionInMP: TEXTURE_SOURCE_PIXELS_MAX / 1e6,
    maxMemoryUsageInMB: Math.ceil((TEXTURE_SOURCE_PIXELS_MAX * RGBA * 2) / 1e6),
  });
  if (!isPositive(image.width) || !isPositive(image.height))
    throw new TextureDecodeError(AssetImportRefusal.Malformed, MESSAGE.NotImage);
  return { width: image.width, height: image.height, data: image.data };
}

/**
 * A PNG or JPEG decoded to RGBA8; throws {@link TextureDecodeError} (`malformed`, or `too-large`
 * past {@link TEXTURE_SOURCE_PIXELS_MAX}) for anything else.
 */
export async function decodeImage(bytes: Uint8Array): Promise<RgbaImage> {
  try {
    if (isPng(bytes)) return await decodePngImage(bytes);
    if (isJpeg(bytes)) return await decodeJpegImage(bytes);
  } catch (error) {
    if (error instanceof TextureDecodeError) throw error;
    throw new TextureDecodeError(AssetImportRefusal.Malformed, error instanceof Error ? error.message : String(error));
  }
  throw new TextureDecodeError(AssetImportRefusal.Malformed, MESSAGE.NotImage);
}

/**
 * The bytes the encoder reads for an image at its class: the file itself when it already is one
 * (decoded first all the same, so a damaged file is refused typed before the encoder sees it),
 * else the image resampled to its class as a lossless PNG.
 */
async function encoderInput(
  bytes: Uint8Array,
  usage: TextureUsage,
): Promise<{ input: Uint8Array; texture: EncodedTexture }> {
  const image = await decodeImage(bytes);
  const side = textureSideClass(image.width, image.height);
  const texture = { usage, width: image.width, height: image.height, side };
  if (image.width === side && image.height === side) return { input: bytes, texture };
  const square = resampleSquare(image, side, usage);
  const { encode: encodePng } = await import("fast-png");
  return { input: encodePng({ width: side, height: side, data: square.data, channels: RGBA, depth: 8 }), texture };
}

let encoder: Promise<BasisEncoderModule> | null = null;

/** The pinned Basis Universal encoder from the importer tools folder, started once per process. */
export function textureEncoder(): Promise<BasisEncoderModule> {
  encoder ??= basisEncoder(path.dirname(decoderFile(`${ImporterToolFolder.Basis}/${BASIS_ENCODER.files[0].name}`)));
  return encoder;
}

/**
 * `bytes` (a PNG or JPEG) encoded for `usage` and transcoded into each of `families` (in that
 * order), with the record of what was encoded. Throws {@link TextureDecodeError} for an image it
 * cannot read, and the encoder's and transcoder's own errors.
 */
export async function encodeTexture(
  bytes: Uint8Array,
  usage: TextureUsage,
  families: readonly TextureCompression[],
  module?: BasisEncoderModule,
): Promise<TextureEncodeResult> {
  const { input, texture } = await encoderInput(bytes, usage);
  const encoded = await encodeKtx2(module ?? (await textureEncoder()), input, usage);
  if (!("bytes" in encoded)) throw new TextureDecodeError(AssetImportRefusal.Malformed, MESSAGE.Skipped);
  const transcoded = await transcodeKtx2Families(encoded.bytes, families);
  if (!("files" in transcoded)) throw new TextureDecodeError(AssetImportRefusal.Malformed, MESSAGE.Skipped);
  return { files: transcoded.files, texture };
}

/** The usage a `texture-encode` step needs; throws when the job carried none. */
export function requireUsage(usage: TextureUsage | undefined): TextureUsage {
  if (usage === undefined) throw new Error(MESSAGE.NoUsage);
  return usage;
}

/** A receipt's texture record, checked; null for anything else. */
export function parseEncodedTexture(value: unknown): EncodedTexture | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { usage, width, height, side } = value as Record<string, unknown>;
  const shaped = isTextureUsage(usage) && isPositive(width) && isPositive(height) && isSide(side);
  if (!shaped || !isSquarePowerOfTwo(side, side)) return null;
  return { usage, width, height, side };
}

/** The issues an encoded texture carries: `resampled` (detail: the source size) when its class is not its own size. */
export function encodedTextureIssues(texture: EncodedTexture): ImportIssue[] {
  const own = texture.width === texture.side && texture.height === texture.side;
  return own ? [] : [{ code: ImportIssueCode.Resampled, detail: `${texture.width}x${texture.height}` }];
}

/** What the lock records for a texture: its resolved usage (`usageLockFacts`) and, once encoded, the encode's issues. */
export function textureLockFacts(
  resolved: TextureUsageResolution,
  texture?: EncodedTexture,
): { settings: AssetImportSettings; issues: ImportIssue[] } {
  const { settings, issues } = usageLockFacts(resolved);
  return { settings, issues: [...issues, ...(texture ? encodedTextureIssues(texture) : [])] };
}

/** A model's glTF JSON from `root`, or null when it cannot be read as one. */
async function modelJson(root: string, file: string): Promise<unknown> {
  const read = await readGameAsset(root, file, MODEL_READ_MAX_BYTES);
  if (!read.ok) return null;
  const bytes = new Uint8Array(read.bytes);
  try {
    if (isGlb(bytes)) return readGlb(bytes).json;
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

/**
 * The usage of every encodable texture among `files` (game-relative, `/`-separated) of the game
 * or stage at `root`, in the order given: its `genex.toml` `[[texture]]` rows and the material
 * slots its glTF and GLB models sample loose images from. A manifest or model that cannot be read
 * says nothing; this never throws for a file's sake.
 */
export async function stageTextureUsages(root: string, files: readonly string[]): Promise<TextureUsageResolution[]> {
  const manifest = await readGenexToml(root);
  const toml = manifest.ok ? (manifest.manifest.textures ?? []) : [];
  const slotMaps = [];
  for (const file of files) {
    if (!MODEL_EXTENSIONS.has(assetExtension(file))) continue;
    const json = await modelJson(root, file);
    if (json !== null) slotMaps.push(referencedImageSlots(file, json));
  }
  const textures = files.filter(isEncodableTexture);
  return resolveTextureUsages(textures, { toml, slots: mergeImageSlots(slotMaps) });
}
