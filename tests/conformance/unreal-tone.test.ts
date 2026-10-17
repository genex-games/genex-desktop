/**
 * The tone numbers the Unreal bridge adds to every capture, so an agent judges a frame by more than
 * "reads well": the black point (p2), the white point (p98), the contrast (luminance std), aerial
 * perspective (the far band's std against the near band's) and the mean saturation. The PNG is
 * decoded with node:zlib alone; frames here are synthetic, encoded with every PNG row filter.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateSync } from "node:zlib";
import { toneLine } from "../../src/plugins/unreal/editor-captures.ts";
import {
  contactSheet,
  decodePng,
  encodePng,
  frameDifference,
  type RgbImage,
  ToneCheck,
  toneGate,
  toneOf,
} from "../../src/plugins/unreal/tone.ts";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32 as PNG chunks use it. */
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
};

/** A PNG of 8-bit samples (`channels` per pixel: 1 grey, 2 grey+alpha, 3 RGB, 4 RGBA), each row filtered by `filter`. */
function png(width: number, height: number, channels: number, samples: Uint8Array, filter = 0): Buffer {
  const colorType = { 1: 0, 2: 4, 3: 2, 4: 6 }[channels] ?? 2;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, colorType, 0, 0, 0], 8);
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const left = x >= channels ? samples[at - channels] : 0;
      const up = y > 0 ? samples[at - stride] : 0;
      const upLeft = x >= channels && y > 0 ? samples[at - stride - channels] : 0;
      const predicted = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter] ?? 0;
      raw[y * (stride + 1) + 1 + x] = (samples[at] - predicted) & 0xff;
    }
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** An RGB image whose pixel (x, y) is `color(x, y)`. */
function image(width: number, height: number, color: (x: number, y: number) => [number, number, number]): RgbImage {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgb.set(color(x, y), (y * width + x) * 3);
  return { width, height, rgb };
}

/** A grey-level of 0 to 255 at every channel. */
const grey = (level: number): [number, number, number] => [level, level, level];

test("PNGs decode to the same RGB pixels whatever row filter, channel layout and alpha they use", () => {
  const source = image(7, 5, (x, y) => [(x * 37 + y * 11) % 256, (x * 5 + y * 71) % 256, (x * y * 13) % 256]);
  const layouts = {
    rgb: [3, (r: number, g: number, b: number) => [r, g, b]],
    rgba: [4, (r: number, g: number, b: number) => [r, g, b, 200]],
  } as const;
  for (const [name, [channels, pack]] of Object.entries(layouts))
    for (const filter of [0, 1, 2, 3, 4]) {
      const samples = new Uint8Array(source.width * source.height * channels);
      for (let i = 0; i < source.width * source.height; i++)
        samples.set(pack(source.rgb[i * 3] ?? 0, source.rgb[i * 3 + 1] ?? 0, source.rgb[i * 3 + 2] ?? 0), i * channels);
      const decoded = decodePng(png(source.width, source.height, channels, samples, filter));
      assert.deepEqual([decoded.width, decoded.height], [7, 5], `${name} filter ${filter}`);
      assert.deepEqual([...decoded.rgb], [...source.rgb], `${name} filter ${filter}`);
    }
  const greyPng = png(2, 1, 1, new Uint8Array([10, 250]), 1);
  assert.deepEqual([...decodePng(greyPng).rgb], [10, 10, 10, 250, 250, 250]);
});

test("what the encoder writes, the decoder reads back", () => {
  const source = image(9, 4, (x, y) => [x * 20, y * 60, 255 - x * 10]);
  assert.deepEqual(decodePng(encodePng(source)), source);
});

test("a file that is not a PNG this decoder reads is an error, never a picture", () => {
  const good = png(2, 2, 3, new Uint8Array(12));
  const interlaced = Buffer.from(good);
  interlaced[SIGNATURE.length + 8 + 12] = 1;
  const cases = {
    "not a PNG": Buffer.from("GIF89a................"),
    empty: Buffer.alloc(0),
    "cut short": good.subarray(0, good.length - 20),
    "a corrupt chunk": Buffer.from(good.toString("latin1").replace("IDAT", "IDAX"), "latin1"),
    interlaced,
  };
  for (const [name, data] of Object.entries(cases)) assert.throws(() => decodePng(data), Error, name);
});

test("a flat grey frame fails every tone check: no black point, no contrast, no depth", () => {
  const tone = toneOf(image(640, 360, () => grey(128)));
  assert.ok(Math.abs(tone.p2 - 128 / 255) < 0.01, `p2 ${tone.p2}`);
  assert.ok(tone.std < 0.01, `std ${tone.std}`);
  const gate = toneGate(tone);
  assert.equal(gate.pass, false);
  assert.deepEqual(gate.fails.sort(), Object.values(ToneCheck).sort());
});

test("a high-contrast frame with air (busy near, calm far) passes the tone gate", () => {
  // Near: a black-and-white checker in the lower third; far: a soft fog gradient in the upper middle.
  const frame = image(640, 360, (x, y) => {
    if (y >= 240) return grey((Math.floor(x / 16) + Math.floor(y / 16)) % 2 ? 235 : 4);
    if (y >= 120) return grey(150 + Math.round((y - 120) / 6));
    return grey(30);
  });
  const tone = toneOf(frame);
  assert.ok(tone.p2 <= 0.05, `p2 ${tone.p2}`);
  assert.ok(tone.std >= 0.18, `std ${tone.std}`);
  assert.ok(tone.farStd < tone.nearStd, `far ${tone.farStd} near ${tone.nearStd}`);
  assert.deepEqual(toneGate(tone), { pass: true, fails: [] });
});

test("a frame whose far band is busier than its near band fails on aerial perspective", () => {
  const frame = image(480, 270, (x, y) => {
    const checker = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 ? 250 : 0;
    if (y >= 90 && y < 135) return grey(checker);
    if (y >= 180) return grey(y % 2 ? 0 : 40);
    return grey(checker);
  });
  const gate = toneGate(toneOf(frame));
  assert.equal(gate.pass, false);
  assert.ok(gate.fails.includes(ToneCheck.AerialPerspective), gate.fails.join(", "));
});

test("a nearly black frame is called out as a render to doubt, not a grade to fix; a lit one is not", () => {
  // Editor-world shots went black for the rest of a run after a renderer setting was toggled, while play was fine.
  const black = toneLine(toneOf(image(320, 180, (x, y) => grey(x === 0 && y === 0 ? 255 : 3))));
  assert.match(black, /nearly black[^\n]*capture_play[^\n]*rebuild_unreal/);
  const lit = toneLine(toneOf(image(320, 180, (x) => grey(x % 2 ? 230 : 10))));
  assert.doesNotMatch(lit, /nearly black/);
});

test("saturation is the mean HSV saturation: zero for greys, high for pure colours", () => {
  assert.equal(toneOf(image(64, 36, (x) => grey(x * 4))).saturation, 0);
  const red = toneOf(image(64, 36, () => [200, 0, 0]));
  assert.ok(red.saturation > 0.99, `${red.saturation}`);
});

test("consecutive frames that only differ in the sky count as the same; a moved view does not", () => {
  const scene = (shift: number, sky: number) =>
    image(320, 180, (x, y) => (y < 60 ? grey(sky) : grey(((x + shift) * 7 + y * 3) % 256)));
  const same = frameDifference(scene(0, 100), scene(0, 180));
  const moved = frameDifference(scene(0, 100), scene(24, 100));
  assert.ok(same < 1 / 255, `sky-only change ${same}`);
  assert.ok(moved >= 8 / 255, `moved view ${moved}`);
});

test("a contact sheet lays frames out left to right, then down, at one cell size", () => {
  const frames = [grey(0), grey(80), grey(160), grey(240)].map((level) => image(40, 20, () => level));
  const sheet = contactSheet(frames, 2, 20);
  assert.deepEqual([sheet.width, sheet.height], [40, 20]);
  const at = (x: number, y: number) => sheet.rgb[(y * sheet.width + x) * 3];
  assert.deepEqual([at(5, 5), at(25, 5), at(5, 15), at(25, 15)], [0, 80, 160, 240]);
});
