/**
 * GLB-embedded images to per-family KTX2 sidecars (game systems C-13). A GLB carries most of a
 * model's textures inside it, and the runtime decodes those as RGBA8; this step writes them out
 * the way the loose-texture step (`texture-encode.ts`, C-12) does for a PNG or JPEG beside a model.
 *
 * Every embedded PNG or JPEG a material samples is encoded once per usage its slots give it
 * (`texture-usage.ts`: base colour and emissive are colour, normal is a normal map,
 * metallic-roughness and occlusion are data), so an image sampled in two usages is encoded twice.
 * Each encode is one fixed-format KTX2 per texture family the destinations may pick, written beside
 * the GLB as `<stem>.<family>.ktx2`, where the stem is `<model>.t<image>` (`<model>.t<image>.<usage>`
 * for an image with more than one usage). Two images with the same bytes and usage share the first
 * one's stem. The GLB then names its sidecars in `asset.extras.genex_textures` (the schema in
 * `native/genex-rust/crates/genex-render/README.md`), never as an extension, so any glTF reader
 * still loads it. The embedded image stays: it is the fallback a device without the family, or a
 * reader that ignores the extras, decodes.
 *
 * Everything is a pure function of the GLB's bytes and the families, so an unchanged model imports
 * to the same bytes. An image this step cannot encode (a file beside the GLB, a WebP, a KTX2, a
 * damaged or oversized one, one the encoder fails on) is left out with its reason and keeps loading
 * from the GLB.
 */
import { createHash } from "node:crypto";
import { type BasisEncoderModule, TextureUsage } from "./basis-encoder.ts";
import { readGlb, writeGlb } from "./glb.ts";
import { index, isObject, type Json, objects } from "./gltf-json.ts";
import { AssetImportRefusal } from "./import-plan.ts";
import type { Ktx2FamilyFile } from "./ktx2.ts";
import { type EncodedTexture, encodeTexture, TextureDecodeError } from "./texture-encode.ts";
import { TextureCompression } from "./texture-table.ts";
import { gltfImageSlots, isTextureUsage, MATERIAL_SLOT_USAGE } from "./texture-usage.ts";

/** The member of a GLB's `asset.extras` that names its image sidecars: never an extension. */
export const GLB_TEXTURES_EXTRAS_KEY = "genex_textures";
/** The `genex_textures` schema version this step writes and the runtime reads. */
export const GLB_TEXTURES_SCHEMA_VERSION = 1;
/** The longest stem a sidecar may have (the model's name plus its image suffix). */
export const GLB_TEXTURE_STEM_MAX_CHARS = 200;

/** The members of the `genex_textures` object: its schema version and its images. Wire values. */
export const GlbTexturesKey = { Version: "v", Images: "images" } as const;
export type GlbTexturesKey = (typeof GlbTexturesKey)[keyof typeof GlbTexturesKey];

/**
 * The members of one image row: the glTF image index, the usage it was encoded for (`color`,
 * `data`, `normal`) and the sidecar stem, a file name in the GLB's own folder. Wire values.
 */
export const GlbTextureImageKey = { Image: "image", Kind: "kind", Stem: "stem" } as const;
export type GlbTextureImageKey = (typeof GlbTextureImageKey)[keyof typeof GlbTextureImageKey];

/** Why {@link addGlbTextures} returned the GLB unchanged. Wire values in the import receipt. */
export const GlbTexturesSkip = {
  /** No material samples an embedded PNG or JPEG this step could encode. */
  NoImages: "no-images",
  /** The GLB already names its sidecars (an imported GLB imported again). */
  AlreadyEncoded: "already-encoded",
  /** `asset` or `asset.extras` is there but not an object a key can join. */
  ExtrasNotObject: "extras-not-object",
  /** The model's name cannot start a sidecar's file name. */
  UnsafeName: "unsafe-name",
} as const;
export type GlbTexturesSkip = (typeof GlbTexturesSkip)[keyof typeof GlbTexturesSkip];

/** Why one sampled image got no sidecar; it keeps loading from the GLB. Wire values in the import receipt. */
export const GlbImageSkip = {
  /** The image is a file beside the GLB or a data URI, not a view of its binary chunk. */
  NotEmbedded: "not-embedded",
  /** Its view is not a range of the GLB's binary chunk. */
  OutOfBuffer: "out-of-buffer",
  /** Not a PNG or JPEG (a WebP, a KTX2 named by `KHR_texture_basisu`). */
  NotEncodable: "not-encodable",
  /** A PNG or JPEG the decoder cannot read. */
  Malformed: "malformed",
  /** More pixels than the importer decodes (`TEXTURE_SOURCE_PIXELS_MAX`). */
  TooLarge: "too-large",
  /**
   * The encoder or transcoder failed on it, or could not start (an importer without its tools): the
   * model still imports, its images load from the GLB.
   */
  EncodeFailed: "encode-failed",
} as const;
export type GlbImageSkip = (typeof GlbImageSkip)[keyof typeof GlbImageSkip];

/** One row of `genex_textures`: image `image`, encoded for `kind`, has its family files at `<stem>.<family>.ktx2`. */
export interface GlbTextureEntry {
  image: number;
  kind: TextureUsage;
  stem: string;
}

/** One encode's family files, written once per stem. */
export interface GlbTextureSidecar {
  stem: string;
  files: Ktx2FamilyFile[];
  /** The usage, source size and class it was encoded at (C-12's record). */
  texture: EncodedTexture;
}

/** A sampled image left out, and why. */
export interface GlbImageSkipped {
  image: number;
  reason: GlbImageSkip;
}

/** What {@link addGlbTextures} did: the GLB to deliver, its rows and the sidecars to write beside it. */
export type GlbTexturesOutcome =
  | {
      bytes: Uint8Array;
      encoded: true;
      entries: GlbTextureEntry[];
      sidecars: GlbTextureSidecar[];
      skipped: GlbImageSkipped[];
    }
  | { bytes: Uint8Array; encoded: false; reason: GlbTexturesSkip; skipped: GlbImageSkipped[] };

/** The order an image's usages are encoded and listed in: the usage table's. */
const USAGE_ORDER: readonly TextureUsage[] = Object.values(TextureUsage);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47] as const;
const JPEG_START = [0xff, 0xd8, 0xff] as const;
/** The binary chunk of a GLB is its buffer 0. */
const GLB_BUFFER = 0;
const KTX2_SUFFIX = ".ktx2";
const FAMILIES: readonly TextureCompression[] = Object.values(TextureCompression);
/** A stem is a file name: no folder separator, no NUL, never hidden or a climb. */
const UNSAFE_STEM = /[/\\\0]/;

const startsWith = (bytes: Uint8Array, prefix: readonly number[]) => prefix.every((byte, i) => bytes[i] === byte);
const isEncodableImage = (bytes: Uint8Array) => startsWith(bytes, PNG_SIGNATURE) || startsWith(bytes, JPEG_START);

/** Whether `stem` names a file in the GLB's own folder. */
export function isGlbTextureStem(stem: unknown): stem is string {
  if (typeof stem !== "string" || stem === "" || stem.length > GLB_TEXTURE_STEM_MAX_CHARS) return false;
  return !UNSAFE_STEM.test(stem) && !stem.startsWith(".");
}

/** The usages image slots give, once each, in {@link USAGE_ORDER}. */
function slotUsages(slots: readonly string[]): TextureUsage[] {
  const usages = new Set(slots.map((slot) => (MATERIAL_SLOT_USAGE as Readonly<Record<string, TextureUsage>>)[slot]));
  return USAGE_ORDER.filter((usage) => usages.has(usage));
}

/** An embedded image's bytes, or why it has none this step reads. */
function imageBytes(json: Json, bin: Uint8Array, image: number): Uint8Array | GlbImageSkip {
  const entry = objects(json.images)[image];
  const at = entry ? index(entry.bufferView) : null;
  if (entry === undefined || at === null) return GlbImageSkip.NotEmbedded;
  const view = objects(json.bufferViews)[at];
  const offset = view ? (index(view.byteOffset) ?? (view.byteOffset === undefined ? 0 : null)) : null;
  const length = view ? index(view.byteLength) : null;
  const inBuffer = view !== undefined && index(view.buffer) === GLB_BUFFER;
  if (!inBuffer || offset === null || length === null || offset + length > bin.byteLength) {
    return GlbImageSkip.OutOfBuffer;
  }
  const bytes = bin.subarray(offset, offset + length);
  return isEncodableImage(bytes) ? bytes : GlbImageSkip.NotEncodable;
}

/** The skip an encode's failure maps to: a decode refusal's own, else `encode-failed`. */
function encodeSkip(error: unknown): GlbImageSkip {
  if (!(error instanceof TextureDecodeError)) return GlbImageSkip.EncodeFailed;
  return error.refusal === AssetImportRefusal.TooLarge ? GlbImageSkip.TooLarge : GlbImageSkip.Malformed;
}

/** What the encode loop builds up, and the stem each (image digest, usage) already has. */
interface Encoded {
  entries: GlbTextureEntry[];
  sidecars: GlbTextureSidecar[];
  skipped: GlbImageSkipped[];
  stems: Map<string, string>;
}

/** What the encode of every image shares. */
interface EncodeContext {
  name: string;
  families: readonly TextureCompression[];
  module: BasisEncoderModule | undefined;
}

/**
 * One embedded image's usages encoded into `out`, each once; a usage whose bytes and kind another
 * image already has reuses that stem. A failed encode leaves the whole image out, never the model.
 */
async function encodeImage(
  out: Encoded,
  context: EncodeContext,
  image: number,
  bytes: Uint8Array,
  usages: readonly TextureUsage[],
): Promise<void> {
  const digest = createHash("sha256").update(bytes).digest("hex");
  for (const kind of usages) {
    const key = `${digest}:${kind}`;
    const known = out.stems.get(key);
    const stem = known ?? (usages.length > 1 ? `${context.name}.t${image}.${kind}` : `${context.name}.t${image}`);
    if (known === undefined) {
      try {
        const { files, texture } = await encodeTexture(bytes, kind, context.families, context.module);
        out.sidecars.push({ stem, files, texture });
      } catch (error) {
        out.skipped.push({ image, reason: encodeSkip(error) });
        return;
      }
      out.stems.set(key, stem);
    }
    out.entries.push({ image, kind, stem });
  }
}

/** Every sampled image's usages encoded, in image then usage order. */
async function encodeImages(json: Json, bin: Uint8Array, context: EncodeContext): Promise<Encoded> {
  const out: Encoded = { entries: [], sidecars: [], skipped: [], stems: new Map() };
  for (const [image, slots] of gltfImageSlots(json)) {
    const bytes = imageBytes(json, bin, image);
    if (typeof bytes === "string") out.skipped.push({ image, reason: bytes });
    else await encodeImage(out, context, image, bytes, slotUsages(slots));
  }
  return out;
}

/** The `asset` object a key can join, or null when it (or its extras) is of another shape. */
function extrasHolder(json: Json): Json | null {
  const asset = json.asset;
  if (!isObject(asset)) return null;
  return asset.extras === undefined || isObject(asset.extras) ? asset : null;
}

/**
 * The GLB `glb` (named `name`, its file's stem) with `asset.extras.genex_textures` naming a sidecar
 * per embedded image and usage, and those sidecars' family files, one per `families` entry in that
 * order; or the GLB unchanged with the reason. Throws `glb.ts`'s errors for a file that is not a GLB;
 * an image the encoder fails on is left out with its reason. Deterministic.
 */
export async function addGlbTextures(
  glb: Uint8Array,
  name: string,
  families: readonly TextureCompression[],
  module?: BasisEncoderModule,
): Promise<GlbTexturesOutcome> {
  const { json, bin } = readGlb(glb);
  const unchanged = (reason: GlbTexturesSkip, skipped: GlbImageSkipped[] = []): GlbTexturesOutcome => ({
    bytes: glb,
    encoded: false,
    reason,
    skipped,
  });
  const asset = extrasHolder(json);
  if (!asset) return unchanged(GlbTexturesSkip.ExtrasNotObject);
  if (isObject(asset.extras) && GLB_TEXTURES_EXTRAS_KEY in asset.extras)
    return unchanged(GlbTexturesSkip.AlreadyEncoded);
  if (!isGlbTextureStem(`${name}.t0`)) return unchanged(GlbTexturesSkip.UnsafeName);
  const { entries, sidecars, skipped } = await encodeImages(json, bin, { name, families, module });
  if (!entries.length) return unchanged(GlbTexturesSkip.NoImages, skipped);
  const rows = entries.map(({ image, kind, stem }) => ({
    [GlbTextureImageKey.Image]: image,
    [GlbTextureImageKey.Kind]: kind,
    [GlbTextureImageKey.Stem]: stem,
  }));
  asset.extras = {
    ...(isObject(asset.extras) ? asset.extras : {}),
    [GLB_TEXTURES_EXTRAS_KEY]: {
      [GlbTexturesKey.Version]: GLB_TEXTURES_SCHEMA_VERSION,
      [GlbTexturesKey.Images]: rows,
    },
  };
  return { bytes: writeGlb(json, bin), encoded: true, entries, sidecars, skipped };
}

/** One row of `genex_textures` checked against a document of `imageCount` images, or null. */
function parseEntry(value: unknown, imageCount: number): GlbTextureEntry | null {
  if (!isObject(value)) return null;
  const image = index(value[GlbTextureImageKey.Image]);
  const kind = value[GlbTextureImageKey.Kind];
  const stem = value[GlbTextureImageKey.Stem];
  if (image === null || image >= imageCount || !isTextureUsage(kind) || !isGlbTextureStem(stem)) return null;
  return { image, kind, stem };
}

/**
 * A glTF document's `genex_textures` rows as a reader takes them, or null when it has none, names
 * another schema version, or any row is malformed (an image out of range, an unknown kind, a stem
 * that is not a file name, an image and kind named twice). A reader that gets null loads the
 * embedded images, as if the extras were absent.
 */
export function parseGlbTextures(json: unknown): GlbTextureEntry[] | null {
  if (!isObject(json) || !isObject(json.asset) || !isObject(json.asset.extras)) return null;
  const block = json.asset.extras[GLB_TEXTURES_EXTRAS_KEY];
  if (!isObject(block) || block[GlbTexturesKey.Version] !== GLB_TEXTURES_SCHEMA_VERSION) return null;
  const rows = block[GlbTexturesKey.Images];
  if (!Array.isArray(rows)) return null;
  const imageCount = Array.isArray(json.images) ? json.images.length : 0;
  const entries = rows.map((row) => parseEntry(row, imageCount));
  if (entries.some((entry) => entry === null)) return null;
  const parsed = entries as GlbTextureEntry[];
  const distinct = new Set(parsed.map(({ image, kind }) => `${image}:${kind}`)).size === parsed.length;
  return distinct ? parsed : null;
}

/** A sidecar's file for `family`, beside the GLB at `glbFile` (a `/`-separated path): `assets/crate.glb`, `crate.t0` → `assets/crate.t0.bc.ktx2`. */
export function glbTextureFileName(glbFile: string, stem: string, family: TextureCompression): string {
  const slash = glbFile.lastIndexOf("/");
  return `${slash >= 0 ? glbFile.slice(0, slash + 1) : ""}${stem}.${family}.ktx2`;
}

/** The model name a GLB at `glbFile` is imported as: its file's stem (`assets/crate.glb` → `crate`). */
function modelName(glbFile: string): string {
  const base = glbFile.slice(glbFile.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * Whether `stem` is one this step writes for the GLB at `glbFile`: `<model>.t<image>` or
 * `<model>.t<image>.<usage>`. The host holds an importer's receipt to this, so a sidecar never
 * takes the name of another file's family file.
 */
export function isGlbTextureStemOf(glbFile: string, stem: unknown): stem is string {
  if (!isGlbTextureStem(stem)) return false;
  const prefix = `${modelName(glbFile)}.t`;
  if (!stem.startsWith(prefix)) return false;
  const [image, kind, ...rest] = stem.slice(prefix.length).split(".");
  const imageOk = image !== undefined && /^(0|[1-9]\d*)$/.test(image);
  return imageOk && rest.length === 0 && (kind === undefined || isTextureUsage(kind));
}

/** The stem and family of a sidecar file of the GLB at `glbFile` ({@link glbTextureFileName} read back), or null. */
export function glbTextureFamilyOf(
  glbFile: string,
  file: string,
): { stem: string; compression: TextureCompression } | null {
  const folder = glbFile.slice(0, glbFile.lastIndexOf("/") + 1);
  if (!file.startsWith(folder) || !file.endsWith(KTX2_SUFFIX)) return null;
  const name = file.slice(folder.length, -KTX2_SUFFIX.length);
  const dot = name.lastIndexOf(".");
  const stem = name.slice(0, Math.max(dot, 0));
  const compression = FAMILIES.find((family) => family === name.slice(dot + 1));
  return compression && isGlbTextureStemOf(glbFile, stem) ? { stem, compression } : null;
}
