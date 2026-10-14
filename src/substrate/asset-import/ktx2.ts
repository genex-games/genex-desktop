/**
 * KTX2 textures at import: the container's header read, and a Basis Universal texture (ETC1S or
 * UASTC) transcoded once per texture family its game's destinations may pick, so a texture that
 * cannot reach one is refused at import instead of on the device. The file itself is kept as
 * delivered; the runtime transcodes it again on load for the family the device has.
 */
import { createHash } from "node:crypto";
import { type BasisKtx2File, basisTranscoder } from "./decoders.ts";
import { BASIS_TRANSCODE_FORMAT, type TextureCompression, type TranscodedTexture } from "./texture-table.ts";

/** «KTX 20», then `\r\n\x1a\n`. */
const KTX2_IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const KTX2_HEADER_BYTES = 80;
/** `VK_FORMAT_UNDEFINED`: the payload is Basis Universal (or another supercompressed form). */
const VK_FORMAT_UNDEFINED = 0;
const MAX_TEXTURE_SIDE = 16384;

/** What the header says. */
export interface Ktx2Header {
  vkFormat: number;
  width: number;
  height: number;
  levels: number;
  /** 0 none, 1 BasisLZ (ETC1S), 2 Zstandard, 3 ZLIB. */
  supercompression: number;
}

/** The header of a KTX2 file, or null when `bytes` are not one. */
export function readKtx2Header(bytes: Uint8Array): Ktx2Header | null {
  if (bytes.byteLength < KTX2_HEADER_BYTES) return null;
  if (KTX2_IDENTIFIER.some((byte, i) => bytes[i] !== byte)) return null;
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = {
    vkFormat: data.getUint32(12, true),
    width: data.getUint32(20, true),
    height: data.getUint32(24, true),
    levels: data.getUint32(40, true),
    supercompression: data.getUint32(44, true),
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
