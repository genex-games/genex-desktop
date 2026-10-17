import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import {
  HELPER_PATH,
  type HelperConnection,
  type HelperServer,
  HelperSocketError,
  HelperSocketFailure,
  startHelperSocket,
  websocketAccept,
  WsClose,
} from "../../src/plugins/roblox/helper-socket.ts";
import { manualClock } from "../helpers/roblox-helper.ts";

const SMALL_CAP = 64 * 1024;
const PING_MS = 15_000;

/** Ports nothing listens on now. */
async function freePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from({ length: count }, () => {
      const server = createServer();
      return new Promise<Server>((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
    }),
  );
  const ports = servers.map((server) => (server.address() as { port: number }).port);
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

/** A server whose connections echo every message back, recording what arrived and what closed. */
async function echoServer(t: TestContext, options: { ports?: number[]; clock?: ReturnType<typeof manualClock> } = {}) {
  const messages: string[] = [];
  const connections: HelperConnection[] = [];
  let closedCount = 0;
  const server = await startHelperSocket({
    ports: options.ports ?? (await freePorts(1)),
    maxFrameBytes: SMALL_CAP,
    pingMs: PING_MS,
    ...(options.clock ? { clock: options.clock } : {}),
    accept: (connection) => {
      connections.push(connection);
      return {
        message: (text) => {
          messages.push(text);
          connection.send(`echo:${text}`);
        },
        closed: () => {
          closedCount += 1;
        },
      };
    },
  });
  // Stopped even when the test fails, so a failure never holds the file open.
  t.after(() => server.close());
  return { server, messages, connections, closed: () => closedCount };
}

/** Node's own WebSocket client, opened. */
async function open(server: HelperServer): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}${HELPER_PATH}`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error("refused")), { once: true });
  });
  return socket;
}

const nextMessage = (socket: WebSocket) =>
  new Promise<string>((resolve) =>
    socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true }),
  );
const closeCode = (socket: WebSocket) =>
  new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code), { once: true }));

/** A frame as a client sends it: masked unless told otherwise. */
function clientFrame(
  opcode: number,
  payload: Buffer,
  options: { masked?: boolean; fin?: boolean; length?: number } = {},
) {
  const masked = options.masked ?? true;
  const length = options.length ?? payload.length;
  const lengthBytes = length < 126 ? 0 : length < 0x10000 ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes);
  header[0] = ((options.fin ?? true) ? 0x80 : 0) | opcode;
  header[1] = (masked ? 0x80 : 0) | (lengthBytes === 0 ? length : lengthBytes === 2 ? 126 : 127);
  if (lengthBytes === 2) header.writeUInt16BE(length, 2);
  if (lengthBytes === 8) header.writeBigUInt64BE(BigInt(length), 2);
  if (!masked) return Buffer.concat([header, payload]);
  const mask = randomBytes(4);
  const body = Buffer.from(payload.map((byte, at) => byte ^ (mask[at % 4] ?? 0)));
  return Buffer.concat([header, mask, body]);
}

/** A hand-made client: the raw handshake, then frames read as the server sends them. */
async function rawClient(port: number, headers: Record<string, string> = {}, url = HELPER_PATH) {
  const socket: Socket = connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  const key = randomBytes(16).toString("base64");
  const lines = {
    Host: `127.0.0.1:${port}`,
    Upgrade: "websocket",
    Connection: "Upgrade",
    "Sec-WebSocket-Key": key,
    "Sec-WebSocket-Version": "13",
    ...headers,
  };
  const head = Object.entries(lines)
    .filter(([, value]) => value !== "")
    .map(([name, value]) => `${name}: ${value}`)
    .join("\r\n");
  socket.write(`GET ${url} HTTP/1.1\r\n${head}\r\n\r\n`);
  let buffer = Buffer.alloc(0);
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  // A server that never closes fails the test instead of holding it.
  const ended = Promise.race([
    closed,
    new Promise<void>((_resolve, reject) =>
      setTimeout(() => reject(new Error("the server kept the connection")), 5_000).unref(),
    ),
  ]);
  void ended.catch(() => undefined);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
  });
  socket.on("error", () => undefined);
  const response = async () => {
    for (let tries = 0; tries < 200 && !buffer.includes("\r\n\r\n"); tries++)
      await new Promise((r) => setTimeout(r, 10));
    const end = buffer.indexOf("\r\n\r\n");
    const text = buffer.subarray(0, end).toString("latin1");
    buffer = buffer.subarray(end + 4);
    return text;
  };
  /** The server's frames so far, as {opcode, payload}. */
  const frames = () => {
    const out: Array<{ opcode: number; payload: Buffer }> = [];
    let at = 0;
    while (at + 2 <= buffer.length) {
      const opcode = (buffer[at] ?? 0) & 0x0f;
      let length = (buffer[at + 1] ?? 0) & 0x7f;
      let start = at + 2;
      if (length === 126) {
        length = buffer.readUInt16BE(start);
        start += 2;
      } else if (length === 127) {
        length = Number(buffer.readBigUInt64BE(start));
        start += 8;
      }
      if (start + length > buffer.length) break;
      out.push({ opcode, payload: buffer.subarray(start, start + length) });
      at = start + length;
    }
    return out;
  };
  return { socket, key, response, frames, ended };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test("the handshake answers RFC 6455's accept, and a masked text message goes round trip", async (t) => {
  const { server, messages } = await echoServer(t);
  const raw = await rawClient(server.port);
  const response = await raw.response();
  assert.match(response, /^HTTP\/1\.1 101 /);
  assert.match(response, new RegExp(`Sec-WebSocket-Accept: ${websocketAccept(raw.key).replace(/[+/]/g, "\\$&")}`));
  assert.doesNotMatch(response, /Sec-WebSocket-Extensions/i, "no extension is taken");
  raw.socket.destroy();

  const socket = await open(server);
  const echoed = nextMessage(socket);
  socket.send("héllo, Studio");
  assert.equal(await echoed, "echo:héllo, Studio");
  assert.deepEqual(messages.at(-1), "héllo, Studio");
  // A message in pieces arrives whole.
  const pieces = await rawClient(server.port);
  await pieces.response();
  pieces.socket.write(clientFrame(0x1, Buffer.from("one "), { fin: false }));
  pieces.socket.write(clientFrame(0x0, Buffer.from("message")));
  await settle();
  assert.equal(messages.at(-1), "one message");
  pieces.socket.destroy();
  socket.close();
  await server.close();
});

const CLOSE_ROWS: Array<{ name: string; frame: () => Buffer; code: number }> = [
  {
    name: "an unmasked client frame",
    frame: () => clientFrame(0x1, Buffer.from("hi"), { masked: false }),
    code: WsClose.Protocol,
  },
  {
    name: "a frame over the cap",
    frame: () => clientFrame(0x1, Buffer.alloc(SMALL_CAP + 1, 0x61)),
    code: WsClose.TooBig,
  },
  {
    name: "a frame that only says it is over the cap",
    frame: () => clientFrame(0x1, Buffer.alloc(0), { length: SMALL_CAP + 1 }),
    code: WsClose.TooBig,
  },
  { name: "a binary frame", frame: () => clientFrame(0x2, Buffer.from([1, 2, 3])), code: WsClose.Unsupported },
  { name: "text that isn't UTF-8", frame: () => clientFrame(0x1, Buffer.from([0xff, 0xfe])), code: WsClose.BadData },
  { name: "an unknown opcode", frame: () => clientFrame(0x3, Buffer.from("x")), code: WsClose.Protocol },
  { name: "a reserved bit", frame: () => Buffer.from([0xc1, 0x80, 0, 0, 0, 0]), code: WsClose.Protocol },
  { name: "a stray continuation", frame: () => clientFrame(0x0, Buffer.from("x")), code: WsClose.Protocol },
  {
    name: "a fragmented ping",
    frame: () => clientFrame(0x9, Buffer.from("x"), { fin: false }),
    code: WsClose.Protocol,
  },
  {
    name: "pieces that add up past the cap",
    frame: () =>
      Buffer.concat([
        clientFrame(0x1, Buffer.alloc(SMALL_CAP - 10, 0x61), { fin: false }),
        clientFrame(0x0, Buffer.alloc(20, 0x61)),
      ]),
    code: WsClose.TooBig,
  },
];

test("a frame the link doesn't speak closes the connection with its code, delivering nothing", async (t) => {
  const { server, messages, closed } = await echoServer(t);
  for (const row of CLOSE_ROWS) {
    const before = messages.length;
    const closedBefore = closed();
    const raw = await rawClient(server.port);
    await raw.response();
    raw.socket.write(row.frame());
    await raw.ended;
    const close = raw.frames().find((frame) => frame.opcode === 0x8);
    assert.ok(close, `${row.name}: a close frame was sent`);
    assert.equal(close.payload.readUInt16BE(0), row.code, row.name);
    assert.equal(messages.length, before, `${row.name}: nothing was delivered`);
    await settle();
    assert.equal(closed(), closedBefore + 1, `${row.name}: the link heard the close`);
  }
  await server.close();
});

const REFUSED_HANDSHAKES: Array<{ name: string; headers?: Record<string, string>; url?: string; status: number }> = [
  { name: "a web page's Origin", headers: { Origin: "http://evil.test" }, status: 403 },
  { name: "a secure page's Origin", headers: { Origin: "https://evil.test" }, status: 403 },
  { name: "a file's Origin", headers: { Origin: "file://" }, status: 403 },
  { name: "an opaque Origin", headers: { Origin: "null" }, status: 403 },
  { name: "an extension's Origin", headers: { Origin: "chrome-extension://abc" }, status: 403 },
  { name: "another host's name", headers: { Host: "evil.test" }, status: 403 },
  { name: "another path", url: "/", status: 404 },
  { name: "no key", headers: { "Sec-WebSocket-Key": "" }, status: 400 },
  { name: "a short key", headers: { "Sec-WebSocket-Key": "c2hvcnQ=" }, status: 400 },
  { name: "no upgrade", headers: { Upgrade: "h2c" }, status: 400 },
  { name: "another version", headers: { "Sec-WebSocket-Version": "8" }, status: 426 },
];

test("a handshake from a browser, another host or a broken client is refused before any connection", async (t) => {
  const { server, connections } = await echoServer(t);
  for (const row of REFUSED_HANDSHAKES) {
    const raw = await rawClient(server.port, row.headers, row.url);
    const response = await raw.response();
    assert.match(response, new RegExp(`^HTTP/1\\.1 ${row.status} `), row.name);
    await raw.ended;
  }
  assert.equal(connections.length, 0, "no connection was handed to the link");
  // A plain web request gets nothing either.
  const page = await fetch(`http://127.0.0.1:${server.port}${HELPER_PATH}`);
  assert.equal(page.status, 404);
  await server.close();
});

/** Roblox Studio's own upgrade request, recorded: its headers in order, and no Origin among them. */
const STUDIO_HANDSHAKE = JSON.parse(
  await readFile(path.resolve(import.meta.dirname, "../fixtures/roblox-studio/studio-handshake.json"), "utf8"),
) as { path: string; headers: Array<[string, string]> };

/** Studio's recorded request sent byte for byte to `port`, with `extra` headers after its own. */
async function studioHandshake(port: number, extra: Array<[string, string]> = []) {
  const socket: Socket = connect(port, "127.0.0.1");
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  const lines = [...STUDIO_HANDSHAKE.headers, ...extra].map(([name, value]) =>
    name === "Host" ? `${name}: 127.0.0.1:${port}` : `${name}: ${value}`,
  );
  let received = "";
  socket.on("data", (chunk: Buffer) => {
    received += chunk.toString("latin1");
  });
  socket.on("error", () => undefined);
  socket.write(`GET ${STUDIO_HANDSHAKE.path} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
  for (let tries = 0; tries < 200 && !received.includes("\r\n\r\n"); tries++) await settle();
  return { socket, response: received.slice(0, received.indexOf("\r\n\r\n")) };
}

test("Roblox Studio's own handshake, as recorded, is accepted: it carries no Origin, and any Origin is refused", async (t) => {
  assert.equal(
    STUDIO_HANDSHAKE.headers.some(([name]) => name.toLowerCase() === "origin"),
    false,
    "Studio sends no Origin header",
  );
  const { server, connections, messages } = await echoServer(t);
  const studio = await studioHandshake(server.port);
  const key = STUDIO_HANDSHAKE.headers.find(([name]) => name === "Sec-WebSocket-Key")?.[1] ?? "";
  assert.match(studio.response, /^HTTP\/1\.1 101 /);
  assert.ok(studio.response.includes(`Sec-WebSocket-Accept: ${websocketAccept(key)}`));
  studio.socket.write(clientFrame(0x1, Buffer.from("hello from Studio")));
  await settle();
  assert.deepEqual(messages, ["hello from Studio"]);
  assert.equal(connections.length, 1);
  studio.socket.destroy();
  const withOrigin = await studioHandshake(server.port, [["Origin", "null"]]);
  assert.match(withOrigin.response, /^HTTP\/1\.1 403 /);
  withOrigin.socket.destroy();
  assert.equal(connections.length, 1, "the handshake with an Origin reached no connection");
  await server.close();
});

test("a client's ping is answered with its payload, and the server's ping ends a silent connection", async (t) => {
  const clock = manualClock();
  const { server, closed } = await echoServer(t, { clock });
  const raw = await rawClient(server.port);
  await raw.response();
  raw.socket.write(clientFrame(0x9, Buffer.from("are you there")));
  await settle();
  const pong = raw.frames().find((frame) => frame.opcode === 0xa);
  assert.equal(pong?.payload.toString(), "are you there");

  // The server pings; the client answers, so the next ping finds it alive.
  clock.advance(PING_MS);
  await settle();
  assert.ok(
    raw.frames().some((frame) => frame.opcode === 0x9),
    "the server pinged",
  );
  raw.socket.write(clientFrame(0xa, Buffer.alloc(0)));
  await settle();
  clock.advance(PING_MS);
  await settle();
  assert.equal(closed(), 0, "a connection that answered stays");
  // Now it stays silent through a whole period: it is ended.
  clock.advance(PING_MS);
  await raw.ended;
  await settle();
  assert.equal(closed(), 1);
  await server.close();
});

test("a close from either side ends the connection with a close frame", async (t) => {
  const { server, connections, closed } = await echoServer(t);
  const socket = await open(server);
  const code = closeCode(socket);
  socket.close(4001, "bye");
  assert.equal(await code, 4001, "the server answered the client's close with its code");
  await settle();
  assert.equal(closed(), 1);

  const second = await open(server);
  const secondCode = closeCode(second);
  await settle();
  connections.at(-1)?.close(WsClose.Policy, "replaced");
  assert.equal(await secondCode, WsClose.Policy);
  assert.throws(
    () => connections.at(-1)?.send("late"),
    (error: unknown) => error instanceof HelperSocketError && error.code === HelperSocketFailure.Closed,
  );
  await server.close();
});

test("a busy port moves the server to the next one, and a full range is refused", async (t) => {
  const ports = await freePorts(2);
  const holder = createServer();
  await new Promise<void>((resolve) => holder.listen(ports[0], "127.0.0.1", () => resolve()));
  t.after(() => new Promise((resolve) => holder.close(resolve)));
  const { server } = await echoServer(t, { ports });
  assert.equal(server.port, ports[1]);
  await assert.rejects(
    startHelperSocket({ ports, accept: () => ({ message: () => undefined, closed: () => undefined }) }),
    (error: unknown) => error instanceof HelperSocketError && error.code === HelperSocketFailure.NoFreePort,
  );
});

test("a message past the cap is never sent", async (t) => {
  const { server, connections } = await echoServer(t);
  const socket = await open(server);
  await settle();
  assert.throws(
    () => connections[0]?.send("x".repeat(SMALL_CAP + 1)),
    (error: unknown) => error instanceof HelperSocketError && error.code === HelperSocketFailure.TooBig,
  );
  socket.close();
  await server.close();
});
