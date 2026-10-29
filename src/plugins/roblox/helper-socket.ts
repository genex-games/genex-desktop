/**
 * The helper link's WebSocket server: the smallest RFC 6455 server the Genex helper in Roblox
 * Studio needs, written over `node:http`'s upgrade so the plugin adds no dependency.
 *
 * - It listens on 127.0.0.1 only, on the first free port of the fixed range the helper also knows.
 * - It refuses any handshake that carries an `Origin`: browsers always send one (`http:`, `https:`,
 *   `file:`, `null`, an extension's), so a web page can never reach the helper link. A Host other
 *   than this computer's own name for the port is refused as well.
 * - It speaks text frames only. A client frame must be masked; an unmasked frame, a reserved bit,
 *   a binary frame, a frame or message past the cap, or text that isn't UTF-8 closes the
 *   connection with the matching close code.
 * - It pings every {@link HELPER_PING_MS}; a connection that sent nothing since the last ping is
 *   ended. Time runs on an injected clock.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { SECOND_MS } from "../../shared/duration.ts";
import { type JobClock, SYSTEM_CLOCK } from "../../substrate/job-process.ts";
import { HELPER_PORTS, MAX_HELPER_FRAME_BYTES } from "./helper-protocol.ts";

/** The only address the server listens on. */
export const HELPER_HOST = "127.0.0.1";
/** The path the helper connects to; any other is refused. */
export const HELPER_PATH = "/genex-helper";
/** How often the server pings; a connection silent for a whole period is ended. */
export const HELPER_PING_MS = 15 * SECOND_MS;
/** How long a closing connection may take to answer the close before it is cut. */
const CLOSE_GRACE_MS = SECOND_MS;
/** RFC 6455's key suffix for the handshake's accept value. */
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** A control frame's largest payload. */
const MAX_CONTROL_BYTES = 125;
/** The close code a close frame with no code stands for; it is never sent. */
const NO_STATUS = 1005;
/** A handshake key: 16 random bytes in base64. */
const KEY_BYTES = 16;
const WEBSOCKET_VERSION = "13";
/** Errors that mean a port is taken (or not ours to take), so the next one is tried. */
const PORT_TAKEN = new Set(["EADDRINUSE", "EACCES"]);
/** The names this computer answers to on the server's port. */
const LOCAL_NAMES = [HELPER_HOST, "localhost"] as const;

/** Close codes the server sends. Wire values: never rename. */
export const WsClose = {
  Normal: 1000,
  GoingAway: 1001,
  Protocol: 1002,
  Unsupported: 1003,
  BadData: 1007,
  Policy: 1008,
  TooBig: 1009,
} as const;
export type WsClose = (typeof WsClose)[keyof typeof WsClose];

/** Frame opcodes. */
const Opcode = {
  Continuation: 0x0,
  Text: 0x1,
  Binary: 0x2,
  Close: 0x8,
  Ping: 0x9,
  Pong: 0xa,
} as const;
type Opcode = (typeof Opcode)[keyof typeof Opcode];

/** Why the server didn't start or a send didn't go. Wire values: never rename. */
export const HelperSocketFailure = {
  NoFreePort: "no-free-port",
  TooBig: "too-big",
  Closed: "closed",
} as const;
export type HelperSocketFailure = (typeof HelperSocketFailure)[keyof typeof HelperSocketFailure];

const MESSAGE = {
  NoFreePort: (ports: readonly number[]) => `Every helper port is taken (${ports.join(", ")}).`,
  TooBig: "The message is larger than the helper link carries.",
  Closed: "The helper connection is closed.",
} as const;

/** A failure with its code. */
export class HelperSocketError extends Error {
  code: HelperSocketFailure;
  constructor(code: HelperSocketFailure, message: string) {
    super(message);
    this.name = "HelperSocketError";
    this.code = code;
  }
}

/** One helper's connection, as the link sees it. */
export interface HelperConnection {
  readonly id: number;
  readonly open: boolean;
  /** Sends one text message; throws when it is past the cap or the connection is closed. */
  send(text: string): void;
  close(code?: WsClose, reason?: string): void;
}

/** What the link does with a connection's messages and its end. */
export interface HelperHandlers {
  message(text: string): void;
  closed(): void;
}

/** How the server runs; tests give their own ports, caps and clock. */
export interface HelperSocketOptions {
  /** The connection's handlers, given when its handshake is accepted. */
  accept(connection: HelperConnection): HelperHandlers;
  ports?: readonly number[];
  maxFrameBytes?: number;
  pingMs?: number;
  clock?: JobClock;
}

/** The running server. */
export interface HelperServer {
  port: number;
  /** Ends every connection and stops listening. */
  close(): Promise<void>;
}

/** The handshake's answer to a key. */
export function websocketAccept(key: string): string {
  return createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
}

/** How many bytes a frame's length takes after its second byte: none, two or eight. */
function extraLengthBytes(length: number): number {
  if (length < 126) return 0;
  return length < 0x10000 ? 2 : 8;
}

/** One frame as the server sends it: whole, unmasked. */
function encodeFrame(opcode: Opcode, payload: Buffer): Buffer {
  const length = payload.length;
  const lengthBytes = extraLengthBytes(length);
  const header = Buffer.alloc(2 + lengthBytes);
  header[0] = 0x80 | opcode;
  if (lengthBytes === 0) header[1] = length;
  else if (lengthBytes === 2) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function closePayload(code: WsClose, reason = ""): Buffer {
  const text = Buffer.from(reason, "utf8").subarray(0, MAX_CONTROL_BYTES - 2);
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return payload;
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/** The text a buffer holds, or undefined when it isn't UTF-8. */
function utf8(bytes: Buffer): string | undefined {
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

/** A frame's header, read once enough bytes have arrived. */
interface FrameHead {
  fin: boolean;
  opcode: number;
  reserved: boolean;
  masked: boolean;
  length: number;
  /** The header's own size, mask key included. */
  size: number;
}

/** The bytes after the second that a frame's 7-bit length field announces. */
const announcedLengthBytes = (short: number) => ({ 126: 2, 127: 8 })[short] ?? 0;

/** The next frame's header in `buffer`, undefined until it is all there; `Infinity` length past 2^53. */
function frameHead(buffer: Buffer): FrameHead | undefined {
  if (buffer.length < 2) return undefined;
  const first = buffer[0] ?? 0;
  const second = buffer[1] ?? 0;
  const short = second & 0x7f;
  const lengthBytes = announcedLengthBytes(short);
  const masked = (second & 0x80) !== 0;
  const size = 2 + lengthBytes + (masked ? 4 : 0);
  if (buffer.length < 2 + lengthBytes) return undefined;
  let length = short;
  if (lengthBytes === 2) length = buffer.readUInt16BE(2);
  if (lengthBytes === 8) {
    const big = buffer.readBigUInt64BE(2);
    length = big > BigInt(Number.MAX_SAFE_INTEGER) ? Number.POSITIVE_INFINITY : Number(big);
  }
  return { fin: (first & 0x80) !== 0, opcode: first & 0x0f, reserved: (first & 0x70) !== 0, masked, length, size };
}

/** Why a handshake is refused, as an HTTP status, or undefined when it is a helper's. */
function handshakeRefusal(request: IncomingMessage, port: number): number | undefined {
  const headers = request.headers;
  if (headers.origin !== undefined) return 403;
  const hosts = LOCAL_NAMES.map((name) => `${name}:${port}`);
  if (!hosts.includes(String(headers.host ?? "").toLowerCase())) return 403;
  if (request.method !== "GET" || request.url !== HELPER_PATH) return 404;
  const upgrade = String(headers.upgrade ?? "").toLowerCase() === "websocket";
  const connection = String(headers.connection ?? "")
    .toLowerCase()
    .split(",")
    .some((token) => token.trim() === "upgrade");
  const key = String(headers["sec-websocket-key"] ?? "");
  const keyOk = Buffer.from(key, "base64").length === KEY_BYTES && key.length === 24;
  const handshake = upgrade && connection && keyOk;
  if (!handshake) return 400;
  return headers["sec-websocket-version"] === WEBSOCKET_VERSION ? undefined : 426;
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  426: "Upgrade Required",
};

function refuseHandshake(socket: Socket, status: number): void {
  const extra = status === 426 ? `Sec-WebSocket-Version: ${WEBSOCKET_VERSION}\r\n` : "";
  socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`);
}

interface Limits {
  maxFrameBytes: number;
  pingMs: number;
  clock: JobClock;
}

/** One accepted socket and what it keeps between frames. */
interface Conn {
  socket: Socket;
  limits: Limits;
  handlers: HelperHandlers;
  buffer: Buffer;
  /** A text message's fragments while it arrives in pieces. */
  fragments: Buffer[] | undefined;
  fragmentBytes: number;
  /** Something arrived since the last ping. */
  heard: boolean;
  closing: boolean;
  ended: boolean;
  ping: unknown;
  cut: unknown;
}

function write(conn: Conn, opcode: Opcode, payload: Buffer): void {
  if (!conn.socket.destroyed) conn.socket.write(encodeFrame(opcode, payload));
}

/** Sends the close, ends the socket, and cuts it if the client doesn't answer in time. */
function closeConn(conn: Conn, code: WsClose = WsClose.Normal, reason = ""): void {
  if (conn.closing || conn.ended) return;
  conn.closing = true;
  write(conn, Opcode.Close, closePayload(code, reason));
  conn.socket.end();
  conn.cut = conn.limits.clock.setTimeout(() => conn.socket.destroy(), CLOSE_GRACE_MS);
}

function deliver(conn: Conn, bytes: Buffer): void {
  const text = utf8(bytes);
  if (text === undefined) closeConn(conn, WsClose.BadData);
  else conn.handlers.message(text);
}

/** A data frame: a whole message, or a piece of one. */
function onData(conn: Conn, head: FrameHead, payload: Buffer) {
  if (head.opcode === Opcode.Binary) return closeConn(conn, WsClose.Unsupported);
  const starts = head.opcode === Opcode.Text;
  if (starts === (conn.fragments !== undefined)) return closeConn(conn, WsClose.Protocol);
  if (starts && head.fin) return deliver(conn, payload);
  conn.fragments = [...(conn.fragments ?? []), payload];
  conn.fragmentBytes += payload.length;
  if (conn.fragmentBytes > conn.limits.maxFrameBytes) return closeConn(conn, WsClose.TooBig);
  if (!head.fin) return;
  const whole = Buffer.concat(conn.fragments);
  conn.fragments = undefined;
  conn.fragmentBytes = 0;
  deliver(conn, whole);
}

/** A ping is answered; a client's close is answered with its own code, then the socket ends. */
function onControl(conn: Conn, head: FrameHead, payload: Buffer) {
  if (head.opcode === Opcode.Ping) return write(conn, Opcode.Pong, payload);
  if (head.opcode === Opcode.Pong) return;
  const code = payload.length >= 2 ? payload.readUInt16BE(0) : WsClose.Normal;
  if (!conn.closing) {
    conn.closing = true;
    write(conn, Opcode.Close, closePayload(code === NO_STATUS ? WsClose.Normal : (code as WsClose)));
  }
  conn.socket.end();
}

const KNOWN_OPCODES: ReadonlySet<number> = new Set(Object.values(Opcode));

/** Why a frame's header ends the connection, or undefined when it may be read. */
function headRefusal(head: FrameHead, maxFrameBytes: number): WsClose | undefined {
  if (head.reserved || !head.masked || !KNOWN_OPCODES.has(head.opcode)) return WsClose.Protocol;
  const control = head.opcode >= Opcode.Close;
  const badControl = control && (!head.fin || head.length > MAX_CONTROL_BYTES);
  if (badControl) return WsClose.Protocol;
  return head.length > maxFrameBytes ? WsClose.TooBig : undefined;
}

/** The next whole frame's header and unmasked payload, taken off the buffer; undefined until it is there. */
function takeFrame(conn: Conn, head: FrameHead): Buffer | undefined {
  if (conn.buffer.length < head.size + head.length) return undefined;
  const mask = conn.buffer.subarray(head.size - 4, head.size);
  const payload = Buffer.from(conn.buffer.subarray(head.size, head.size + head.length));
  for (let at = 0; at < payload.length; at++) payload[at] = (payload[at] ?? 0) ^ (mask[at % 4] ?? 0);
  conn.buffer = conn.buffer.subarray(head.size + head.length);
  return payload;
}

/** Reads every whole frame that has arrived. */
function drain(conn: Conn) {
  while (!conn.closing && !conn.ended) {
    const head = frameHead(conn.buffer);
    if (!head) return;
    const refused = headRefusal(head, conn.limits.maxFrameBytes);
    if (refused !== undefined) return closeConn(conn, refused);
    const payload = takeFrame(conn, head);
    if (!payload) return;
    conn.heard = true;
    if (head.opcode >= Opcode.Close) onControl(conn, head, payload);
    else onData(conn, head, payload);
  }
}

/** Pings each period; a connection that sent nothing since the last ping is cut. */
function schedulePing(conn: Conn): void {
  conn.ping = conn.limits.clock.setTimeout(() => {
    if (conn.ended) return;
    if (!conn.heard) {
      conn.socket.destroy();
      return;
    }
    conn.heard = false;
    write(conn, Opcode.Ping, Buffer.alloc(0));
    schedulePing(conn);
  }, conn.limits.pingMs);
}

/** The link's view of a connection. */
function connectionOf(conn: Conn, id: number): HelperConnection {
  const connection: HelperConnection = {
    id,
    get open() {
      return !conn.closing && !conn.ended;
    },
    send(text) {
      if (!connection.open) throw new HelperSocketError(HelperSocketFailure.Closed, MESSAGE.Closed);
      const payload = Buffer.from(text, "utf8");
      if (payload.length > conn.limits.maxFrameBytes)
        throw new HelperSocketError(HelperSocketFailure.TooBig, MESSAGE.TooBig);
      write(conn, Opcode.Text, payload);
    },
    close: (code, reason) => closeConn(conn, code, reason),
  };
  return connection;
}

/**
 * Serves one accepted socket: frames in (starting with `head`, any bytes that came with the
 * handshake), frames out, pings, and the close.
 */
function serveConnection(
  socket: Socket,
  connection: { id: number; head: Buffer },
  limits: Limits,
  accept: HelperSocketOptions["accept"],
): HelperConnection {
  const conn: Conn = {
    socket,
    limits,
    handlers: { message: () => undefined, closed: () => undefined },
    buffer: Buffer.alloc(0),
    fragments: undefined,
    fragmentBytes: 0,
    heard: true,
    closing: false,
    ended: false,
    ping: undefined,
    cut: undefined,
  };
  const served = connectionOf(conn, connection.id);
  conn.handlers = accept(served);
  const feed = (chunk: Buffer) => {
    conn.buffer = conn.buffer.length ? Buffer.concat([conn.buffer, chunk]) : chunk;
    drain(conn);
  };
  socket.on("data", feed);
  socket.on("error", () => socket.destroy());
  socket.once("close", () => {
    conn.ended = true;
    limits.clock.clearTimeout(conn.ping);
    limits.clock.clearTimeout(conn.cut);
    conn.handlers.closed();
  });
  schedulePing(conn);
  if (connection.head.length) feed(connection.head);
  return served;
}

/** Listens on `port` of this computer only; rejects with the listen error. */
function listenOn(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(port, HELPER_HOST, () => {
      server.off("error", failed);
      resolve();
    });
  });
}

/** The server on the first free port of the range; refuses when every one is taken. */
export async function startHelperSocket(options: HelperSocketOptions): Promise<HelperServer> {
  const ports = options.ports ?? HELPER_PORTS;
  const limits: Limits = {
    maxFrameBytes: options.maxFrameBytes ?? MAX_HELPER_FRAME_BYTES,
    pingMs: options.pingMs ?? HELPER_PING_MS,
    clock: options.clock ?? SYSTEM_CLOCK,
  };
  for (const port of ports) {
    const sockets = new Set<Socket>();
    const connections = new Set<HelperConnection>();
    let nextId = 0;
    const server = createServer((_request, response) => {
      response.writeHead(404, { connection: "close" }).end();
    });
    server.on("upgrade", (request: IncomingMessage, socket: Socket, head: Buffer) => {
      const refused = handshakeRefusal(request, port);
      if (refused !== undefined) return refuseHandshake(socket, refused);
      const key = String(request.headers["sec-websocket-key"]);
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`,
      );
      socket.setNoDelay(true);
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      const connection = serveConnection(socket, { id: ++nextId, head }, limits, options.accept);
      connections.add(connection);
      socket.once("close", () => connections.delete(connection));
    });
    try {
      await listenOn(server, port);
    } catch (error) {
      if (PORT_TAKEN.has((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw error;
    }
    let closing: Promise<void> | undefined;
    return {
      port,
      close: () => {
        closing ??= (async () => {
          for (const connection of connections) connection.close(WsClose.GoingAway);
          const closed = new Promise<void>((resolve) => server.close(() => resolve()));
          for (const socket of sockets) socket.destroy();
          server.closeAllConnections();
          await closed;
        })();
        return closing;
      },
    };
  }
  throw new HelperSocketError(HelperSocketFailure.NoFreePort, MESSAGE.NoFreePort(ports));
}
