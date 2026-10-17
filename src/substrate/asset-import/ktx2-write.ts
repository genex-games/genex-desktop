/**
 * KTX2 files in one fixed GPU format, written by the import step (A6.5): the 80-byte header, the
 * level index (level 0 first), a basic data format descriptor for the format, a `KTXwriter` key,
 * then the levels from the smallest to the largest, each at a 16-byte boundary, never
 * supercompressed (KTX 2.0 specification §3–§4; the descriptor per the Khronos Data Format
 * specification 1.3, the same bytes the `ktx2` crate's `Basic::from_format` builds, which the
 * runtime's tests hold it to). The output is a pure function of the input.
 */
import { KTX2_VK_FORMAT, TextureCompression } from "./texture-table.ts";

/** «KTX 20», then `\r\n\x1a\n`. */
const IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const HEADER_BYTES = 80;
const LEVEL_INDEX_BYTES = 24;
/** Every level starts at a multiple of this: lcm of the 16-byte blocks and 4. */
const LEVEL_ALIGN = 16;
const WRITER_KEY = "KTXwriter";
const WRITER = "Genex asset import";

/** Khronos data format descriptor numbers. */
const DFD = {
  /** Basic descriptor block, version 1.3. */
  Version: 2,
  BlockHeaderBytes: 8,
  BasicFixedBytes: 16,
  SampleBytes: 16,
  ModelRgbsda: 1,
  ModelBc7: 134,
  ModelEtc2: 161,
  ModelAstc: 162,
  PrimariesBt709: 1,
  TransferLinear: 1,
  TransferSrgb: 2,
  ChannelRed: 0,
  ChannelGreen: 1,
  ChannelBlue: 2,
  ChannelAlpha: 15,
  ChannelBlockData: 0,
  ChannelEtc2Color: 2,
  /** The sample's qualifier bits (in the channel byte's high nibble): linear. */
  QualifierLinear: 0x10,
} as const;

/** One sample of a descriptor: where its bits are, which channel, and its range. */
interface Sample {
  bitOffset: number;
  bitLength: number;
  channel: number;
  upper: number;
}

/** A family's descriptor: model, block size and bytes, and samples. */
interface Descriptor {
  model: number;
  block: number;
  bytes: number;
  samples: readonly Sample[];
}

const WHOLE_BLOCK = 0xffffffff;
const BYTE_MAX = 255;

const DESCRIPTORS: Readonly<Record<TextureCompression, Descriptor>> = {
  [TextureCompression.Bc]: {
    model: DFD.ModelBc7,
    block: 4,
    bytes: 16,
    samples: [{ bitOffset: 0, bitLength: 128, channel: DFD.ChannelBlockData, upper: WHOLE_BLOCK }],
  },
  [TextureCompression.Astc]: {
    model: DFD.ModelAstc,
    block: 4,
    bytes: 16,
    samples: [{ bitOffset: 0, bitLength: 128, channel: DFD.ChannelBlockData, upper: WHOLE_BLOCK }],
  },
  [TextureCompression.Etc2]: {
    model: DFD.ModelEtc2,
    block: 4,
    bytes: 16,
    samples: [
      { bitOffset: 0, bitLength: 64, channel: DFD.ChannelAlpha, upper: WHOLE_BLOCK },
      { bitOffset: 64, bitLength: 64, channel: DFD.ChannelEtc2Color, upper: WHOLE_BLOCK },
    ],
  },
  [TextureCompression.Rgba8]: {
    model: DFD.ModelRgbsda,
    block: 1,
    bytes: 4,
    samples: [
      { bitOffset: 0, bitLength: 8, channel: DFD.ChannelRed, upper: BYTE_MAX },
      { bitOffset: 8, bitLength: 8, channel: DFD.ChannelGreen, upper: BYTE_MAX },
      { bitOffset: 16, bitLength: 8, channel: DFD.ChannelBlue, upper: BYTE_MAX },
      { bitOffset: 24, bitLength: 8, channel: DFD.ChannelAlpha, upper: BYTE_MAX },
    ],
  },
};

/** The data format descriptor section: its total length, then one basic block. */
function descriptor(compression: TextureCompression, srgb: boolean): Uint8Array {
  const { model, block, bytes, samples } = DESCRIPTORS[compression];
  const blockBytes = DFD.BlockHeaderBytes + DFD.BasicFixedBytes + DFD.SampleBytes * samples.length;
  const out = new Uint8Array(4 + blockBytes);
  const data = new DataView(out.buffer);
  data.setUint32(0, out.byteLength, true);
  data.setUint32(4, 0, true); // Khronos vendor, basic descriptor type
  data.setUint16(8, DFD.Version, true);
  data.setUint16(10, blockBytes, true);
  out.set([model, DFD.PrimariesBt709, srgb ? DFD.TransferSrgb : DFD.TransferLinear, 0], 12);
  out.set([block - 1, block - 1, 0, 0], 16);
  out[20] = bytes;
  for (const [at, sample] of samples.entries()) {
    const start = 4 + DFD.BlockHeaderBytes + DFD.BasicFixedBytes + at * DFD.SampleBytes;
    // An sRGB format's alpha is stored linear.
    const linear = srgb && sample.channel === DFD.ChannelAlpha;
    data.setUint16(start, sample.bitOffset, true);
    out[start + 2] = sample.bitLength - 1;
    out[start + 3] = sample.channel | (linear ? DFD.QualifierLinear : 0);
    data.setUint32(start + 8, 0, true);
    data.setUint32(start + 12, sample.upper, true);
  }
  return out;
}

/** The key/value section: `KTXwriter` and its value, NUL-terminated, padded to 4 bytes. */
function keyValues(): Uint8Array {
  const pair = new TextEncoder().encode(`${WRITER_KEY}\0${WRITER}\0`);
  const out = new Uint8Array(4 + Math.ceil(pair.byteLength / 4) * 4);
  new DataView(out.buffer).setUint32(0, pair.byteLength, true);
  out.set(pair, 4);
  return out;
}

const align = (at: number, to: number) => Math.ceil(at / to) * to;

/** A square texture of `side` texels in `compression`'s format, `levels` level 0 first. */
export interface Ktx2Image {
  compression: TextureCompression;
  srgb: boolean;
  side: number;
  levels: readonly Uint8Array[];
}

/** The KTX2 file of `image`: header, level index, descriptor, key/values, levels smallest first. */
export function writeKtx2(image: Ktx2Image): Uint8Array {
  const dfd = descriptor(image.compression, image.srgb);
  const kvd = keyValues();
  const indexEnd = HEADER_BYTES + LEVEL_INDEX_BYTES * image.levels.length;
  const dfdAt = indexEnd;
  const kvdAt = dfdAt + dfd.byteLength;
  let at = align(kvdAt + kvd.byteLength, LEVEL_ALIGN);
  const offsets: number[] = new Array(image.levels.length).fill(0);
  for (let level = image.levels.length - 1; level >= 0; level--) {
    offsets[level] = at;
    at = align(at + (image.levels[level]?.byteLength ?? 0), LEVEL_ALIGN);
  }
  const last = image.levels.length ? (offsets[0] ?? 0) + (image.levels[0]?.byteLength ?? 0) : at;
  const out = new Uint8Array(last);
  const data = new DataView(out.buffer);
  out.set(IDENTIFIER, 0);
  const vk = KTX2_VK_FORMAT[image.compression];
  const header = [image.srgb ? vk.srgb : vk.linear, 1, image.side, image.side, 0, 0, 1, image.levels.length, 0];
  header.forEach((word, i) => data.setUint32(12 + i * 4, word, true));
  data.setUint32(48, dfdAt, true);
  data.setUint32(52, dfd.byteLength, true);
  data.setUint32(56, kvdAt, true);
  data.setUint32(60, kvd.byteLength, true);
  // No supercompression global data: offset and length 0 (bytes 64..80).
  image.levels.forEach((level, i) => {
    const entry = HEADER_BYTES + i * LEVEL_INDEX_BYTES;
    data.setBigUint64(entry, BigInt(offsets[i] ?? 0), true);
    data.setBigUint64(entry + 8, BigInt(level.byteLength), true);
    data.setBigUint64(entry + 16, BigInt(level.byteLength), true);
    out.set(level, offsets[i] ?? 0);
  });
  out.set(dfd, dfdAt);
  out.set(kvd, kvdAt);
  return out;
}
