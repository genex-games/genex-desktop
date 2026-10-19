/**
 * SHA-256, synchronously. A saved playtest answers a call by its key (`callKey` in
 * `shared/game-ai-tape.ts`, SHA-256 of the call's canonical JSON through WebCrypto), but WebCrypto
 * only answers in a later task, and the studio steps a game many frames in one synchronous
 * `step()`. Hashing here, in the call itself, is what lets a replay hold each answer for exactly
 * the frames it took live. `tests/conformance/genex-ai-inbox.test.ts` holds both to the same keys.
 */
import { canonicalJson } from "../../shared/game-ai-schema.ts";
import type { CallKeyInput } from "../../shared/game-ai-tape.ts";

/** The first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const ROUND = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);
/** The first 32 bits of the fractional parts of the square roots of the first 8 primes. */
const INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const BLOCK_BYTES = 64;

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** The message padded to whole blocks: a 1 bit, zeros, and its length in bits, big-endian. */
function padded(bytes: Uint8Array): DataView {
  const blocks = Math.ceil((bytes.length + 9) / BLOCK_BYTES);
  const out = new Uint8Array(blocks * BLOCK_BYTES);
  out.set(bytes);
  out[bytes.length] = 0x80;
  const view = new DataView(out.buffer);
  const bits = bytes.length * 8;
  view.setUint32(out.length - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(out.length - 4, bits >>> 0);
  return view;
}

/** One 64-byte block folded into the running state. */
function compress(state: Uint32Array, view: DataView, offset: number, w: Uint32Array): void {
  for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
  for (let i = 16; i < 64; i += 1) {
    const a = w[i - 15] ?? 0;
    const b = w[i - 2] ?? 0;
    const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
    const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
    w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
  }
  const h = Array.from(state);
  for (let i = 0; i < 64; i += 1) {
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, k = 0] = h;
    const t1 =
      (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + (ROUND[i] ?? 0) + (w[i] ?? 0)) >>> 0;
    const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
    h.splice(0, 8, (t1 + t2) >>> 0, a, b, c, (d + t1) >>> 0, e, f, g);
  }
  for (let i = 0; i < 8; i += 1) state[i] = ((state[i] ?? 0) + (h[i] ?? 0)) >>> 0;
}

/** SHA-256 of bytes, as 32 bytes. */
export function sha256(bytes: Uint8Array): Uint8Array {
  const view = padded(bytes);
  const state = new Uint32Array(INITIAL);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < view.byteLength; offset += BLOCK_BYTES) compress(state, view, offset, w);
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, state[i] ?? 0);
  return out;
}

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));
const encoder = new TextEncoder();

/** SHA-256 of a string's UTF-8, lowercase hex. */
export const sha256Hex = (text: string): string => Array.from(sha256(encoder.encode(text)), (b) => HEX[b]).join("");

/** A call's tape key, now: the same hex `callKey` answers later. */
export const callKeyNow = (input: CallKeyInput): string => sha256Hex(canonicalJson(input));
