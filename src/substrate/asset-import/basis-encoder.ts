/**
 * Texture encoding at import (renderer pass 2, A6.6): a square, power-of-two PNG or JPEG becomes
 * a mipmapped Basis Universal KTX2 (UASTC LDR 4x4, Zstandard-supercompressed), which the import
 * step then transcodes once per texture family (`transcodeKtx2Families`, A6.5). The encoder is
 * Basis Universal v2.50's WebAssembly build (Apache-2.0, with its NOTICE), a pinned download that
 * is never committed: {@link basisEncoder} checks both files against {@link BASIS_ENCODER}'s sha256
 * before anything is evaluated, then starts it with its WebAssembly handed over as bytes, inside
 * the importer's own sandbox like the decoders. Encoding is single-threaded, so the output is a
 * pure function of the input and the usage.
 *
 * Which files are encoded, and as what usage, is the caller's: the importer never guesses a
 * texture's use from its name. TODO(A6.6 wiring): the store recipe that installs the encoder and
 * the import-plan step that encodes a game's textures with the usage its materials give them.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";

/** The encoder build the importer runs, pinned by sha256 and size at its release commit. */
export const BASIS_ENCODER = {
  version: "2.50",
  upstream: "https://github.com/BinomialLLC/basis_universal",
  license: "Apache-2.0",
  /** The `v2_50` tag's commit; the files are under `webgl/encoder/build/`. */
  source:
    "https://raw.githubusercontent.com/BinomialLLC/basis_universal/9bebe16726b3a61c8c213eeee3b7cffb462ef34e/webgl/encoder/build/",
  files: [
    {
      name: "basis_encoder.js",
      sha256: "d225ce1e7012609bcfbe338351c8778d95eb1c19d404314d513b2b2df94a6ffb",
      bytes: 103_878,
    },
    {
      name: "basis_encoder.wasm",
      sha256: "48d4e39ccaa1e290a17d00c13b353a728227bb439108d5e6c944fe6ab80552db",
      bytes: 3_287_321,
    },
  ],
} as const;

/** How a texture is used, which sets its colour space and the encoder's weighting. */
export const TextureUsage = {
  /** Base colour or emission: sRGB, perceptual error, mips filtered in linear light. */
  Color: "color",
  /** Metallic-roughness, occlusion and other data: linear. */
  Data: "data",
  /** A tangent-space normal map: linear, mips renormalized. */
  Normal: "normal",
} as const;
export type TextureUsage = (typeof TextureUsage)[keyof typeof TextureUsage];

/** Why an image got no KTX2. Wire values: never rename one. */
export const Ktx2EncodeSkip = {
  /** The runtime's size-class arrays hold square, power-of-two layers. */
  NotSquare: "not-square-power-of-two",
} as const;
export type Ktx2EncodeSkip = (typeof Ktx2EncodeSkip)[keyof typeof Ktx2EncodeSkip];

/** Why the encoder could not be started, or an image could not be encoded. */
export class BasisEncoderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BasisEncoderError";
  }
}

/** The parts of the encoder's embind API the importer calls. */
interface EncoderInstance {
  controlThreading(multithreaded: boolean, threads: number): void;
  setCreateKTX2File(on: boolean): void;
  setKTX2UASTCSupercompression(on: boolean): void;
  setPerceptual(on: boolean): void;
  setKTX2AndBasisSRGBTransferFunc(on: boolean): void;
  setMipSRGB(on: boolean): void;
  setMipRenormalize(on: boolean): void;
  setNormalMapPreset(): void;
  setSliceSourceImage(slice: number, bytes: Uint8Array, width: number, height: number, type: number): boolean;
  setFormatMode(mode: number): void;
  setMipGen(on: boolean): void;
  setMipSmallestDimension(side: number): void;
  setCheckForAlpha(on: boolean): void;
  setDebug(on: boolean): void;
  setPrintStats(on: boolean): void;
  setStatusOutput(on: boolean): void;
  encode(out: Uint8Array): number;
  delete(): void;
}

/** An embind enum value. */
interface EnumValue {
  value: number;
}

/** The encoder module, started. */
export interface BasisEncoderModule {
  initializeBasis(): void;
  BasisEncoder: new () => EncoderInstance;
  basis_tex_format: { cUASTC_LDR_4x4: EnumValue };
  ldr_image_type: { cPNGImage: EnumValue; cJPGImage: EnumValue };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Both files of `dir`, read and held to their pins; throws before anything is evaluated. */
async function pinnedFiles(dir: string): Promise<{ js: string; wasm: Uint8Array }> {
  const read = async (name: string) =>
    new Uint8Array(await readFile(path.join(dir, name)).catch(() => Buffer.alloc(0)));
  const [js, wasm] = await Promise.all(BASIS_ENCODER.files.map((file) => read(file.name)));
  BASIS_ENCODER.files.forEach((file, at) => {
    const bytes = at === 0 ? js : wasm;
    if (!bytes || bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
      throw new BasisEncoderError(
        `${file.name} in ${dir} is not the pinned Basis Universal ${BASIS_ENCODER.version} build`,
      );
    }
  });
  return { js: new TextDecoder().decode(js), wasm: wasm ?? new Uint8Array(0) };
}

/**
 * The encoder in `dir` (its two pinned files), started once per call: the loader is evaluated as
 * the CommonJS-shaped script it is, with its WebAssembly given as bytes so it reads nothing itself.
 */
export async function basisEncoder(dir: string): Promise<BasisEncoderModule> {
  const { js, wasm } = await pinnedFiles(dir);
  const file = path.join(dir, BASIS_ENCODER.files[0].name);
  const module: { exports: unknown } = { exports: {} };
  const load = vm.compileFunction(js, ["module", "exports", "require", "__dirname", "__filename"], { filename: file });
  load(module, module.exports, createRequire(file), dir, file);
  const factory = module.exports as (options: { wasmBinary: Uint8Array }) => Promise<BasisEncoderModule>;
  const encoder = await factory({ wasmBinary: wasm });
  encoder.initializeBasis();
  return encoder;
}

/** The PNG file signature, and where its IHDR width and height sit. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const PNG_SIZE_AT = 16;
const JPEG_START = [0xff, 0xd8] as const;
/** Room for the encoded file: a 4096-texel UASTC chain is at most 16 MiB a level 0 and a third more. */
const OUTPUT_BYTES_PER_TEXEL = 2;
const OUTPUT_FLOOR_BYTES = 64 * 1024;

/** Whether a JPEG marker starts a frame (SOF0..SOF15 but DHT, JPG and DAC). */
const isStartOfFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);

/** A JPEG's frame size from its first start-of-frame segment, or null. */
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
    const length = data.getUint16(at + 2);
    if (isStartOfFrame(marker)) return { width: data.getUint16(at + 7), height: data.getUint16(at + 5) };
    at += 2 + length;
  }
  return null;
}

/** An image's kind and size from its header, or null when it is not a PNG or a JPEG. */
function imageHeader(bytes: Uint8Array): { png: boolean; width: number; height: number } | null {
  if (PNG_SIGNATURE.every((byte, i) => bytes[i] === byte) && bytes.byteLength >= PNG_SIZE_AT + 8) {
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { png: true, width: data.getUint32(PNG_SIZE_AT), height: data.getUint32(PNG_SIZE_AT + 4) };
  }
  if (JPEG_START.every((byte, i) => bytes[i] === byte)) {
    const size = jpegSize(bytes);
    return size ? { png: false, ...size } : null;
  }
  return null;
}

const squarePowerOfTwo = (width: number, height: number) =>
  width === height && width > 0 && Number.isInteger(Math.log2(width));

/** Set an encoder for `usage`: colour space, weighting and mip filtering. */
function configure(encoder: EncoderInstance, module: BasisEncoderModule, usage: TextureUsage): void {
  const color = usage === TextureUsage.Color;
  encoder.controlThreading(false, 0);
  // Quiet: the importer's output is its receipt, and its stderr is kept only for the log.
  encoder.setDebug(false);
  encoder.setPrintStats(false);
  encoder.setStatusOutput(false);
  encoder.setCreateKTX2File(true);
  encoder.setKTX2UASTCSupercompression(true);
  encoder.setFormatMode(module.basis_tex_format.cUASTC_LDR_4x4.value);
  encoder.setPerceptual(color);
  encoder.setKTX2AndBasisSRGBTransferFunc(color);
  encoder.setMipSRGB(color);
  if (usage === TextureUsage.Normal) {
    encoder.setNormalMapPreset();
    encoder.setMipRenormalize(true);
  }
  encoder.setMipGen(true);
  encoder.setMipSmallestDimension(1);
  encoder.setCheckForAlpha(true);
}

/**
 * `image` (a PNG or JPEG) as a mipmapped UASTC KTX2 for `usage`, or why it gets none; throws
 * {@link BasisEncoderError} for bytes that are not a whole PNG or JPEG the encoder reads.
 */
export async function encodeKtx2(
  module: BasisEncoderModule,
  image: Uint8Array,
  usage: TextureUsage,
): Promise<{ bytes: Uint8Array } | { skipped: Ktx2EncodeSkip }> {
  const header = imageHeader(image);
  if (!header) throw new BasisEncoderError("not a PNG or JPEG file");
  if (!squarePowerOfTwo(header.width, header.height)) return { skipped: Ktx2EncodeSkip.NotSquare };
  const encoder = new module.BasisEncoder();
  try {
    configure(encoder, module, usage);
    const type = header.png ? module.ldr_image_type.cPNGImage.value : module.ldr_image_type.cJPGImage.value;
    if (!encoder.setSliceSourceImage(0, image, 0, 0, type))
      throw new BasisEncoderError("the encoder cannot read this image");
    const out = new Uint8Array(Math.max(OUTPUT_FLOOR_BYTES, header.width * header.height * OUTPUT_BYTES_PER_TEXEL));
    const length = encoder.encode(out);
    if (!length) throw new BasisEncoderError("the encoder cannot encode this image");
    return { bytes: out.slice(0, length) };
  } finally {
    encoder.delete();
  }
}
