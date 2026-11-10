/**
 * An authority room's fast@1 binding, pointed back at a game's gateway (multiplayer PROTOCOL.md
 * §17.12). A room tells each seat where its UDP endpoint is in a reliable message on the WebSocket,
 * `__fast` `{ sid, key, url, … }`, with `url` `udp://<host>:<port>`: a Genex fast host or a node's
 * own address. A game in its sandbox can neither look that host up nor send to it, so the gateway
 * reads the frames the room sends (never the game's), and in a `__fast` message only, replaces the
 * url with one of its own datagram ports on 127.0.0.1. Nothing else changes: the key stays the
 * seat's credential and the room still validates the path the gateway's datagrams come from, so
 * the channel's own checks hold as they are. A frame it does not take apart goes on byte for byte.
 */
import { Transform, type TransformCallback } from "node:stream";

/** Colyseus's code for a room message with a type and a msgpack body (`Protocol.ROOM_DATA`). */
const ROOM_DATA = 13;
/** The binding's message type, as Colyseus writes it: a msgpack string (`FastMessage.Bind`). */
const BIND_TYPE = Buffer.from([0xa6, ...Buffer.from("__fast", "latin1")]);
/** The most of a frame read whole to look for a binding; a longer one is never one and streams on. */
const MAX_BINDING_FRAME_BYTES = 512;
/** The end of an HTTP head: the room's 101 answer comes first, before any frame. */
const HEAD_END = Buffer.from("\r\n\r\n", "latin1");
/** The most of an HTTP head held while it arrives; a longer one is passed on as it is. */
const MAX_HEAD_BYTES = 16 * 1024;
const LOOPBACK = "127.0.0.1";
const URL_SCHEME = Buffer.from("udp://", "latin1");
/** A binding's url: `udp://host:port`, the host a name, an IPv4 address or a bracketed IPv6 one. */
const FAST_URL = /^udp:\/\/([a-z0-9.-]+|\[[0-9a-f:.]+\]):(\d{1,5})$/i;
/** msgpack's string headers: fixstr (to 31 bytes), str8 and str16. */
const FIXSTR = 0xa0;
const FIXSTR_MAX = 31;
const STR8 = 0xd9;
const STR16 = 0xda;
/** WebSocket framing (RFC 6455 §5.2). */
const FIN = 0x80;
const RSV = 0x70;
const OPCODE = 0x0f;
const BINARY = 0x2;
const MASKED = 0x80;
const LEN7 = 0x7f;
const LEN16 = 126;
const LEN64 = 127;

/** Which local datagram port reaches a fast endpoint; undefined when the gateway gives it none. */
export type DatagramPortOf = (host: string, port: number) => number | undefined;

/** A msgpack string's header at `at`, its length and its size, or null when there is none. */
function stringHeaderBefore(bytes: Buffer, text: number): { start: number; length: number } | null {
  const one = bytes[text - 1];
  if (one !== undefined && one >= FIXSTR && one <= FIXSTR + FIXSTR_MAX)
    return { start: text - 1, length: one - FIXSTR };
  if (text >= 2 && bytes[text - 2] === STR8) return { start: text - 2, length: bytes[text - 1] ?? 0 };
  if (text >= 3 && bytes[text - 3] === STR16) return { start: text - 3, length: bytes.readUInt16BE(text - 2) };
  return null;
}

/** `text` as msgpack writes a short string. */
function msgpackString(text: string): Buffer {
  const body = Buffer.from(text, "latin1");
  return Buffer.concat([Buffer.from([FIXSTR + body.length]), body]);
}

/** A url's host without IPv6 brackets, and its port, or null when it isn't `udp://host:port`. */
export function fastEndpointOf(url: string): { host: string; port: number } | null {
  const match = FAST_URL.exec(url);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: (match[1] ?? "").replace(/^\[|\]$/g, "").toLowerCase(), port };
}

/**
 * A room message's payload with its fast binding's url pointed at the gateway, or null when it is
 * no binding or its endpoint has no local port (then it goes on as it was).
 */
export function rewriteFastBinding(payload: Buffer, portOf: DatagramPortOf): Buffer | null {
  if (payload[0] !== ROOM_DATA || !payload.subarray(1, 1 + BIND_TYPE.length).equals(BIND_TYPE)) return null;
  const text = payload.indexOf(URL_SCHEME, 1 + BIND_TYPE.length);
  if (text < 0) return null;
  const header = stringHeaderBefore(payload, text);
  if (!header || text + header.length > payload.length) return null;
  const endpoint = fastEndpointOf(payload.subarray(text, text + header.length).toString("latin1"));
  const local = endpoint ? portOf(endpoint.host, endpoint.port) : undefined;
  if (local === undefined) return null;
  const url = msgpackString(`udp://${LOOPBACK}:${local}`);
  return Buffer.concat([payload.subarray(0, header.start), url, payload.subarray(text + header.length)]);
}

/** A server's (unmasked) frame header for a final binary frame of `length` bytes. */
function binaryHeader(length: number): Buffer {
  if (length < LEN16) return Buffer.from([FIN | BINARY, length]);
  const header = Buffer.from([FIN | BINARY, LEN16, 0, 0]);
  header.writeUInt16BE(length, 2);
  return header;
}

/** One frame's header as read: its size, its payload's length, and whether it may be a binding. */
interface FrameHead {
  size: number;
  length: number;
  candidate: boolean;
}

/** The frame header at the start of `bytes`, or null until all of it has arrived. */
function frameHead(bytes: Buffer): FrameHead | null {
  if (bytes.length < 2) return null;
  const first = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  const short = second & LEN7;
  const extra = { [LEN16]: 2, [LEN64]: 8 }[short] ?? 0;
  const size = 2 + extra + (second & MASKED ? 4 : 0);
  if (bytes.length < size) return null;
  let length = short;
  if (short === LEN16) length = bytes.readUInt16BE(2);
  if (short === LEN64) length = Number(bytes.readBigUInt64BE(2));
  const plainBinary = (first & (FIN | RSV | OPCODE)) === (FIN | BINARY) && !(second & MASKED);
  return { size, length, candidate: plainBinary && length <= MAX_BINDING_FRAME_BYTES };
}

/**
 * The room's side of one authority WebSocket, as it goes on to the game: its HTTP head untouched,
 * then frame by frame, each binding rewritten (`rewriteFastBinding`) and every other frame passed
 * on byte for byte, a long one streamed as it arrives.
 */
export function serverFrames(portOf: DatagramPortOf): Transform {
  const state: Reading = { held: Buffer.alloc(0), inHead: true, streaming: 0 };
  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
      state.held = state.held.length ? Buffer.concat([state.held, chunk]) : chunk;
      const out: Buffer[] = [];
      while (state.held.length > 0 && readStep(state, out, portOf));
      done(null, out.length ? Buffer.concat(out) : undefined);
    },
  });
}

/** Where a reading of the room's side is: what is held, whether in the HTTP head, and a streamed frame's bytes left. */
interface Reading {
  held: Buffer;
  inHead: boolean;
  streaming: number;
}

/** Passes the first `count` held bytes on. */
function passOn(state: Reading, out: Buffer[], count: number): void {
  out.push(state.held.subarray(0, count));
  state.held = state.held.subarray(count);
}

/** Reads the HTTP head through its end (or through all it may be); false until it has arrived. */
function readHead(state: Reading, out: Buffer[]): boolean {
  const end = state.held.indexOf(HEAD_END);
  if (end < 0 && state.held.length <= MAX_HEAD_BYTES) return false;
  passOn(state, out, end < 0 ? state.held.length : end + HEAD_END.length);
  state.inHead = false;
  return true;
}

/** One step through the held bytes; false when it needs more of them. */
function readStep(state: Reading, out: Buffer[], portOf: DatagramPortOf): boolean {
  if (state.inHead) return readHead(state, out);
  if (state.streaming > 0) {
    const take = Math.min(state.streaming, state.held.length);
    passOn(state, out, take);
    state.streaming -= take;
    return true;
  }
  const head = frameHead(state.held);
  if (!head) return false;
  if (!head.candidate) {
    passOn(state, out, head.size);
    state.streaming = head.length;
    return true;
  }
  const whole = head.size + head.length;
  if (state.held.length < whole) return false;
  const rewritten = rewriteFastBinding(state.held.subarray(head.size, whole), portOf);
  if (!rewritten) {
    passOn(state, out, whole);
    return true;
  }
  out.push(binaryHeader(rewritten.length), rewritten);
  state.held = state.held.subarray(whole);
  return true;
}
