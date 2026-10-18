/**
 * KTX2 textures at import: the container's header read, and a Basis Universal texture (ETC1S or
 * UASTC) transcoded once per texture family its game's destinations may pick, so a texture that
 * cannot reach one is refused at import instead of on the device. The file itself is kept as
 * delivered. A square, power-of-two texture with its whole mip chain is also transcoded level by
 * level into one fixed-format KTX2 per family (A6.5, `ktx2-write.ts`), the files the runtime
 * loads: it carries no transcoder.
 */
import { createHash } from "node:crypto";
import { type BasisKtx2File, basisTranscoder } from "./decoders.ts";
import { writeKtx2 } from "./ktx2-write.ts";
import { BASIS_TRANSCODE_FORMAT, type TextureCompression, type TranscodedTexture } from "./texture-table.ts";

/** «KTX 20», then `\r\n\x1a\n`. */
const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const KTX2_HEADER_BYTES = 80;
/** `VK_FORMAT_UNDEFINED`: the payload is Basis Universal (or another supercompressed form). */
const VK_FORMAT_UNDEFINED = 0;
const MAX_TEXTURE_SIDE = 16384;
/** Where the data format descriptor's transfer function sits past the section's start. */
const DFD_TRANSFER_AT = 14;
/** The descriptor's sRGB transfer function. */
const TRANSFER_SRGB = 2;

/** Why a Basis texture got no per-family files. Wire values in the import receipt: never rename one. */
export const Ktx2FamilySkip = {
  /** The runtime's size-class arrays hold square, power-of-two layers. */
  NotSquare: "not-square-power-of-two",
  /** A compressed chain is never resampled, so every level down to 1 x 1 must be in the file. */
  IncompleteMips: "incomplete-mip-chain",
} as const;
export type Ktx2FamilySkip = (typeof Ktx2FamilySkip)[keyof typeof Ktx2FamilySkip];

/** One family's KTX2 file. */
export interface Ktx2FamilyFile {
  compression: TextureCompression;
  bytes: Uint8Array;
}

/** What the header says. */
export interface Ktx2Header {
  vkFormat: number;
  width: number;
  height: number;
  levels: number;
  /** 0 none, 1 BasisLZ (ETC1S), 2 Zstandard, 3 ZLIB. */
  supercompression: number;
  /** Whether its descriptor says its colour is sRGB-encoded. */
  srgb: boolean;
}

/** The header of a KTX2 file, or null when `bytes` are not one. */
export function readKtx2Header(bytes: Uint8Array): Ktx2Header | null {
  if (bytes.byteLength < KTX2_HEADER_BYTES) return null;
  if (KTX2_IDENTIFIER.some((byte, i) => bytes[i] !== byte)) return null;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dfdAt = data.getUint32(48, true) + DFD_TRANSFER_AT;
  const header = {
    vkFormat: data.getUint32(12, true),
    width: data.getUint32(20, true),
    height: data.getUint32(24, true),
    levels: data.getUint32(40, true),
    supercompression: data.getUint32(44, true),
    srgb: dfdAt < bytes.byteLength && bytes[dfdAt] === TRANSFER_SRGB,
  };
  const sized = header.width > 0 && header.width <= MAX_TEXTURE_SIDE && header.height <= MAX_TEXTURE_SIDE;
  return sized ? header : null;
}

/** Why a KTX2 texture could not be checked. */
export class Ktx2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Ktx2Error";
  }
}

/** Whether a KTX2 file's payload is Basis Universal, which the transcoder reads. */
export function isBasisKtx2(header: Ktx2Header): boolean {
  return header.vkFormat === VK_FORMAT_UNDEFINED;
}

/**
 * The texture's first level transcoded to each of `families`, in that order; throws
 * {@link Ktx2Error} when the transcoder refuses the file or a family. Deterministic: the same
 * bytes give the same digests on every run (the golden corpus holds it to that).
 */
export async function transcodeKtx2(
  bytes: Uint8Array,
  families: readonly TextureCompression[],
): Promise<TranscodedTexture[]> {
  const basis = await basisTranscoder();
  const file = new basis.KTX2File(new Uint8Array(bytes));
  try {
    if (!file.isValid() || !file.startTranscoding()) throw new Ktx2Error("the transcoder cannot read this KTX2 file");
    return families.map((compression) => transcodeLevel0(file, compression));
  } finally {
    file.close();
    file.delete();
  }
}

function transcodeLevel0(file: BasisKtx2File, compression: TextureCompression): TranscodedTexture {
  const format = BASIS_TRANSCODE_FORMAT[compression];
  const out = new Uint8Array(file.getImageTranscodedSizeInBytes(0, 0, 0, format));
  if (!out.byteLength || !file.transcodeImage(out, 0, 0, 0, format, 0, -1, -1)) {
    throw new Ktx2Error(`the transcoder cannot write ${compression}`);
  }
  return { compression, format, bytes: out.byteLength, sha256: createHash("sha256").update(out).digest("hex") };
}

/** Why `header`'s texture cannot have per-family files, or null when it can. */
function familySkip(header: Ktx2Header): Ktx2FamilySkip | null {
  const side = header.width;
  if (side !== header.height || !Number.isInteger(Math.log2(side))) return Ktx2FamilySkip.NotSquare;
  return header.levels === Math.log2(side) + 1 ? null : Ktx2FamilySkip.IncompleteMips;
}

/** Every level of `file` transcoded to `compression`, level 0 first. */
function transcodeLevels(file: BasisKtx2File, levels: number, compression: TextureCompression): Uint8Array[] {
  const format = BASIS_TRANSCODE_FORMAT[compression];
  return Array.from({ length: levels }, (_, level) => {
    const out = new Uint8Array(file.getImageTranscodedSizeInBytes(level, 0, 0, format));
    if (!out.byteLength || !file.transcodeImage(out, level, 0, 0, format, 0, -1, -1)) {
      throw new Ktx2Error(`the transcoder cannot write level ${level} as ${compression}`);
    }
    return out;
  });
}

/**
 * A Basis texture as one fixed-format KTX2 per family in `families` (in that order), every level
 * transcoded and written plain in the source's colour space; or why it gets none. Throws
 * {@link Ktx2Error} when the transcoder refuses the file or a level. Deterministic.
 */
export async function transcodeKtx2Families(
  bytes: Uint8Array,
  families: readonly TextureCompression[],
): Promise<{ files: Ktx2FamilyFile[] } | { skipped: Ktx2FamilySkip }> {
  const header = readKtx2Header(bytes);
  if (!header || !isBasisKtx2(header)) throw new Ktx2Error("not a Basis Universal KTX2 file");
  const skipped = familySkip(header);
  if (skipped) return { skipped };
  const basis = await basisTranscoder();
  const file = new basis.KTX2File(new Uint8Array(bytes));
  try {
    if (!file.isValid() || !file.startTranscoding()) throw new Ktx2Error("the transcoder cannot read this KTX2 file");
    const files = families.map((compression) => {
      const levels = transcodeLevels(file, header.levels, compression);
      return { compression, bytes: writeKtx2({ compression, srgb: header.srgb, side: header.width, levels }) };
    });
    return { files };
  } finally {
    file.close();
    file.delete();
  }
}
