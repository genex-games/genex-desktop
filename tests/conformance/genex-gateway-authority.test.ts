/**
 * A native game's way to Genex's authority rooms through its gateway (`main/play/genex-gateway.ts`),
 * against fake Genex hosts and a stand-in fast endpoint on this machine: the authority servers an
 * answer names come back pointed at the gateway, a WebSocket to one reaches it, the room's fast@1
 * binding inside that socket is pointed at one of the gateway's datagram ports, and datagrams
 * round-trip through that port to the endpoint. The hostile rows: a host that isn't Genex's, a port
 * never given out, an oversized datagram and a flood of senders, each refused or kept from a seat,
 * with nothing sent on.
 */
import assert from "node:assert/strict";
import { createSocket, type RemoteInfo, type Socket as DatagramSocket } from "node:dgram";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  DATAGRAM_MAX_BYTES,
  DATAGRAM_SENDERS_MAX,
  isPublicAddress,
  openDatagramRelay,
} from "../../src/main/play/gateway-datagrams.ts";
import { fastEndpointOf, rewriteFastBinding, serverFrames } from "../../src/main/play/gateway-frames.ts";
import { authorityHostsOf, fastHostsOf, relayHostsOf, startGenexGateway } from "../../src/main/play/genex-gateway.ts";

const API_HOST = "api.genex.games";
const AUTHORITY = authorityHostsOf(API_HOST);
const FAST = fastHostsOf(API_HOST);
const closing: Array<() => unknown> = [];
after(async () => {
  for (const close of closing.reverse()) await close();
});

/** A msgpack string as Colyseus's packer writes it: fixstr to 31 bytes, str8 beyond. */
function str(text: string): Buffer {
  const body = Buffer.from(text, "latin1");
  return Buffer.concat([Buffer.from(body.length < 32 ? [0xa0 + body.length] : [0xd9, body.length]), body]);
}

/** A room's `__fast` binding message as Colyseus sends it: ROOM_DATA, the type, then `{ sid, key, url, rev }`. */
function binding(url: string): Buffer {
  const sid = Buffer.from([0xce, 0, 0, 0x30, 0x39]);
  return Buffer.concat([
    Buffer.from([13]),
    str("__fast"),
    Buffer.from([0x84]),
    str("sid"),
    sid,
    str("key"),
    str("0123456789abcdef"),
    str("url"),
    str(url),
    str("rev"),
    Buffer.from([0x01]),
  ]);
}

/** The url a binding names, read back the way a client reads it. */
function urlOf(payload: Buffer): string {
  const at = payload.indexOf("udp://");
  const head = payload[at - 1] ?? 0;
  const length = head >= 0xa0 && head <= 0xbf ? head - 0xa0 : head;
  return payload.subarray(at, at + length).toString("latin1");
}

/** A server's binary frame (unmasked, final) around `payload`. */
function frame(payload: Buffer): Buffer {
  const head = payload.length < 126 ? Buffer.from([0x82, payload.length]) : Buffer.from([0x82, 126, 0, 0]);
  if (payload.length >= 126) head.writeUInt16BE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

/** Reads server frames from a byte stream after its HTTP head: each frame's payload. */
function payloads(bytes: Buffer): Buffer[] {
  let at = bytes.indexOf("\r\n\r\n") + 4;
  const out: Buffer[] = [];
  while (at + 2 <= bytes.length) {
    let length = (bytes[at + 1] ?? 0) & 0x7f;
    let head = 2;
    if (length === 126) {
      length = bytes.readUInt16BE(at + 2);
      head = 4;
    }
    out.push(bytes.subarray(at + head, at + head + length));
    at += head + length;
  }
  return out;
}

/**
 * A stand-in fast endpoint: it answers each datagram `answers` takes (as a room answers only its
 * seats' keys) with `ack:` and what came, and keeps what it heard.
 */
async function standIn(answers: (bytes: Buffer) => boolean = () => true) {
  const socket = createSocket("udp4");
  const heard: Array<{ bytes: Buffer; from: RemoteInfo }> = [];
  socket.on("message", (bytes, from) => {
    heard.push({ bytes, from });
    if (answers(bytes)) socket.send(Buffer.concat([Buffer.from("ack:"), bytes]), from.port, from.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", () => resolve()));
  closing.push(() => socket.close());
  return { port: socket.address().port, heard };
}

/** A game socket of its own, connected to a gateway datagram port: what it heard back. */
async function gameSocket(port: number) {
  const socket: DatagramSocket = createSocket("udp4");
  const heard: Buffer[] = [];
  socket.on("message", (bytes) => heard.push(bytes));
  /** The next answer, as soon as it arrives. */
  const next = () => new Promise<Buffer>((resolve) => socket.once("message", resolve));
  await new Promise<void>((resolve) => socket.connect(port, "127.0.0.1", () => resolve()));
  closing.push(() => socket.close());
  return { socket, heard, next, local: socket.address().port };
}

/** Waits until `ready`, polling, for at most `ms`. */
async function until(ready: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!ready() && Date.now() < end) await sleep(5);
}

/** Fake Genex: the API's JSON answer, and an authority host whose WebSocket says `frames` once it opens. */
async function fakeGenex(api: Record<string, unknown>, frames: Buffer[]) {
  const upgrades: http.IncomingHttpHeaders[] = [];
  const sockets = new Set<net.Socket>();
  const serve = async (server: http.Server) => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    closing.push(async () => {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    return (server.address() as AddressInfo).port;
  };
  const apiPort = await serve(
    http.createServer((_req, res) =>
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(api)),
    ),
  );
  const room = http.createServer((_req, res) => res.writeHead(404).end());
  room.on("upgrade", (req, socket: net.Socket) => {
    sockets.add(socket);
    upgrades.push(req.headers);
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    for (const one of frames) socket.write(one);
  });
  const roomPort = await serve(room);
  const upstream = (host: string) => ({
    host: "127.0.0.1",
    port: host === API_HOST ? apiPort : roomPort,
    secure: false,
  });
  return { upstream, upgrades };
}

/** A raw WebSocket upgrade to `port`; every byte that comes back, once `bytes` have. */
function upgrade(port: number, bytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () =>
      socket.write(
        `GET /2567/P/R?sessionId=S HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Extensions: permessage-deflate\r\n\r\n`,
      ),
    );
    let got = Buffer.alloc(0);
    socket.on("data", (data: Buffer) => {
      got = Buffer.concat([got, data]);
      if (got.length >= bytes) {
        socket.destroy();
        resolve(got);
      }
    });
    socket.on("error", reject);
  });
}

const REGIONS = {
  colyseus: {
    urls: ["wss://relay-eu.genex.games"],
    authorityUrls: [
      "wss://authority-eu.genex.games",
      "wss://authority-asia.genex.games",
      "wss://authority-us.genex.games",
    ],
    authorityRegions: [
      { region: "eu", urls: ["wss://authority-eu.genex.games"] },
      { region: "asia", urls: ["wss://authority-asia.genex.games"] },
      { region: "us", urls: ["wss://authority-us.genex.games"] },
      { region: "evil", urls: ["wss://authority-eu.genex.games.evil.test", "wss://evil.test"] },
    ],
  },
};

describe("a native game's gateway to Genex's authority rooms", () => {
  it("points every authority server an answer names at a port of its own, and nothing else", async () => {
    const genex = await fakeGenex(REGIONS, []);
    const gateway = await startGenexGateway({
      api: `https://${API_HOST}`,
      relay: relayHostsOf(API_HOST),
      authority: AUTHORITY,
      fast: FAST,
      upstream: genex.upstream,
    });
    closing.push(gateway.close);
    const body = await (await fetch(`${gateway.apiUrl}/api/embed/guest-session`, { method: "POST" })).json();
    const urls: string[] = body.colyseus.authorityUrls;
    for (const url of urls) assert.match(url, /^ws:\/\/127\.0\.0\.1:\d+$/);
    const ports = urls.map((url) => Number(new URL(url.replace(/^ws/, "http")).port));
    assert.equal(new Set(ports).size, 3, "each server its own port");
    assert.ok(
      ports.every((port) => gateway.ports.includes(port)),
      "ports the sandbox allows",
    );
    const regions: Array<{ region: string; urls: string[] }> = body.colyseus.authorityRegions;
    assert.deepEqual(
      regions.slice(0, 3).map((one) => one.urls[0]),
      urls,
      "a region's url is its server's port: probes and joins both come through",
    );
    assert.deepEqual(regions[3]?.urls, ["wss://authority-eu.genex.games.evil.test", "wss://evil.test"], "never mapped");
    assert.match(body.colyseus.urls[0], /^ws:\/\/127\.0\.0\.1:\d+$/, "relays as before");
    assert.ok(gateway.datagramPorts.length > 0, "datagram ports reserved before the game starts");
  });

  it("joins a WebSocket to the authority server and points the room's fast binding at a datagram port", async () => {
    const other = frame(Buffer.from([13, 0xa4, ...Buffer.from("tick"), 0x01]));
    const big = frame(Buffer.alloc(900, 7));
    const bind = frame(binding("udp://fast-eu.genex.games:4434"));
    const genex = await fakeGenex(REGIONS, [other, big, bind]);
    const gateway = await startGenexGateway({
      api: `https://${API_HOST}`,
      relay: relayHostsOf(API_HOST),
      authority: AUTHORITY,
      fast: FAST,
      upstream: genex.upstream,
      resolve: async () => "127.0.0.1",
    });
    closing.push(gateway.close);
    const body = await (await fetch(`${gateway.apiUrl}/api/embed/guest-session`, { method: "POST" })).json();
    const port = Number(new URL(body.colyseus.authorityUrls[0].replace(/^ws/, "http")).port);
    const head = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n".length;
    const rewritten = binding("udp://127.0.0.1:65535").length + 2;
    const got = await upgrade(port, head + other.length + big.length + rewritten - 5);
    await until(() => genex.upgrades.length > 0);
    assert.equal(genex.upgrades[0]?.host, "authority-eu.genex.games", "the port's own server");
    assert.equal(genex.upgrades[0]?.["sec-websocket-extensions"], undefined, "no compression to hide a binding");
    const [first, second, third] = payloads(got);
    assert.deepEqual(first, other.subarray(2), "another message byte for byte");
    assert.deepEqual(second, big.subarray(4), "a long frame streamed on as it came");
    const url = urlOf(third ?? Buffer.alloc(0));
    const local = fastEndpointOf(url);
    assert.equal(local?.host, "127.0.0.1");
    assert.ok(gateway.datagramPorts.includes(local?.port ?? 0), `${url}: one of the sandbox's datagram ports`);
    assert.ok(third?.includes(Buffer.from("0123456789abcdef")), "the seat's key unchanged");
  });

  it("carries a game socket's datagrams to the endpoint and only the endpoint's answers back, in well under a millisecond", async () => {
    const endpoint = await standIn();
    const relay = await openDatagramRelay({ count: 2, resolve: async () => "127.0.0.1" });
    closing.push(relay.close);
    const port = relay.portOf("fast-eu.genex.games", endpoint.port) ?? 0;
    assert.equal(relay.portOf("fast-eu.genex.games", endpoint.port), port, "the same endpoint, the same port");
    const game = await gameSocket(port);
    const rtts: number[] = [];
    const direct = await gameSocket(endpoint.port);
    const directRtts: number[] = [];
    for (let i = 0; i < 200; i += 1) {
      const answered = game.next();
      const start = performance.now();
      game.socket.send(Buffer.from(`d${i}`));
      await answered;
      rtts.push(performance.now() - start);
      const straight = direct.next();
      const from = performance.now();
      direct.socket.send(Buffer.from(`d${i}`));
      await straight;
      directRtts.push(performance.now() - from);
    }
    assert.equal(game.heard.length, 200, "every datagram answered");
    assert.equal(game.heard[7]?.toString(), "ack:d7");
    const viaGateway = endpoint.heard.filter((one) => one.from.port !== direct.local);
    assert.equal(new Set(viaGateway.map((one) => one.from.port)).size, 1, "one stable address per game socket");
    rtts.sort((a, b) => a - b);
    directRtts.sort((a, b) => a - b);
    const added = (rtts[100] ?? 0) - (directRtts[100] ?? 0);
    console.log(
      `datagram round trip on loopback: through the gateway median ${rtts[100]?.toFixed(3)} ms (p99 ${rtts[198]?.toFixed(3)}), direct ${directRtts[100]?.toFixed(3)} ms: ${added.toFixed(3)} ms added`,
    );
    assert.ok(added < 1, `the gateway adds under a millisecond (${added.toFixed(3)} ms)`);
    // A stray sender to the gateway's upstream socket is never passed back.
    const stray = createSocket("udp4");
    closing.push(() => stray.close());
    const upstreamPort = viaGateway[0]?.from.port ?? 0;
    const heardBefore = game.heard.length;
    stray.send(Buffer.from("spoof"), upstreamPort, "127.0.0.1");
    await sleep(100);
    assert.equal(game.heard.length, heardBefore, "an answer from anyone but the endpoint is dropped");
  });
});

describe("what the gateway refuses, sending nothing on", () => {
  it("leaves a binding to a host that isn't Genex's fast endpoint as it was", () => {
    const given: string[] = [];
    const portOf = (host: string, port: number) => {
      given.push(host);
      return FAST(host) && port >= 1024 ? 40000 : undefined;
    };
    const rows: Array<[string, string]> = [
      ["udp://fast-eu.genex.games:4434", "udp://127.0.0.1:40000"],
      ["udp://fast-asia.genex.games:4437", "udp://127.0.0.1:40000"],
      ["udp://203.0.113.9:4434", "udp://127.0.0.1:40000"],
      ["udp://evil.test:4434", "udp://evil.test:4434"],
      ["udp://fast-eu.genex.games.evil.test:4434", "udp://fast-eu.genex.games.evil.test:4434"],
      ["udp://127.0.0.1:4434", "udp://127.0.0.1:4434"],
      ["udp://10.0.0.5:4434", "udp://10.0.0.5:4434"],
      ["udp://192.168.1.2:4434", "udp://192.168.1.2:4434"],
      ["udp://[::1]:4434", "udp://[::1]:4434"],
      ["udp://fast-eu.genex.games:53", "udp://fast-eu.genex.games:53"],
      ["udp://fast-eu.genex.games:99999", "udp://fast-eu.genex.games:99999"],
      ["udp://user@fast-eu.genex.games:4434", "udp://user@fast-eu.genex.games:4434"],
      ["https://fast-eu.genex.games", "https://fast-eu.genex.games"],
    ];
    for (const [url, expected] of rows) {
      const out = rewriteFastBinding(binding(url), portOf);
      assert.equal(out ? urlOf(out) : url, expected, url);
    }
    const notBinding = Buffer.concat([Buffer.from([13]), str("chat"), str("udp://fast-eu.genex.games:4434")]);
    assert.equal(rewriteFastBinding(notBinding, portOf), null, "a game's own message is never touched");
  });

  it("rewrites a binding however its bytes arrive, and passes masked, compressed and fragmented frames on as they are", async () => {
    const bind = frame(binding("udp://fast-eu.genex.games:4434"));
    const compressed = Buffer.from(bind);
    compressed[0] = 0xc2;
    const fragment = Buffer.from(bind);
    fragment[0] = 0x02;
    const head = Buffer.from("HTTP/1.1 101 Switching Protocols\r\n\r\n");
    const input = Buffer.concat([head, bind, compressed, fragment]);
    const transform = serverFrames(() => 40001);
    const out: Buffer[] = [];
    transform.on("data", (chunk: Buffer) => out.push(chunk));
    for (const byte of input) transform.write(Buffer.from([byte]));
    transform.end();
    await new Promise((resolve) => transform.once("end", resolve));
    const got = Buffer.concat(out);
    assert.ok(got.subarray(0, head.length).equals(head), "the HTTP head untouched");
    const rewritten = frame(binding("udp://127.0.0.1:40001"));
    assert.deepEqual(got.subarray(head.length), Buffer.concat([rewritten, compressed, fragment]));
  });

  it("maps only Genex's authority and fast hosts, by exact host", () => {
    const authority: Array<[string, boolean]> = [
      ["authority-eu.genex.games", true],
      ["authority.genex.games", true],
      ["authority-eu-2.genex.games", true],
      ["authority-eu.genex.games.evil.test", false],
      ["evil-authority.genex.games", false],
      ["relay-eu.genex.games", false],
      ["AUTHORITY-EU.genex.games", false],
    ];
    for (const [host, expected] of authority) assert.equal(AUTHORITY.test(host), expected, host);
    const fast: Array<[string, boolean]> = [
      ["fast-eu.genex.games", true],
      ["fast-us-3.genex.games", true],
      ["fast-eu.genex.games.evil.test", false],
      ["authority-eu.genex.games", false],
      ["203.0.113.9", true],
      ["2001:db8::1", true],
      ["127.0.0.1", false],
      ["0.0.0.0", false],
      ["10.1.2.3", false],
      ["172.16.0.1", false],
      ["192.168.0.1", false],
      ["169.254.169.254", false],
      ["100.64.0.1", false],
      ["224.0.0.1", false],
      ["::1", false],
      ["fe80::1", false],
      ["fd00::1", false],
      ["::ffff:127.0.0.1", false],
      ["localhost", false],
    ];
    for (const [host, expected] of fast) assert.equal(FAST(host), expected, host);
    assert.equal(isPublicAddress("not-an-address"), false);
  });

  it("sends nothing on from a port never given out, or a datagram past the channel's largest", async () => {
    const endpoint = await standIn();
    const relay = await openDatagramRelay({ count: 2, resolve: async () => "127.0.0.1" });
    closing.push(relay.close);
    const idle = await gameSocket(relay.ports[1] ?? 0);
    idle.socket.send(Buffer.from("nobody's"));
    const port = relay.portOf("fast-eu.genex.games", endpoint.port) ?? 0;
    const game = await gameSocket(port);
    game.socket.send(Buffer.alloc(DATAGRAM_MAX_BYTES + 1, 1));
    await sleep(100);
    assert.equal(endpoint.heard.length, 0, "nothing reached the endpoint");
    game.socket.send(Buffer.alloc(DATAGRAM_MAX_BYTES, 2));
    await until(() => endpoint.heard.length === 1);
    assert.equal(endpoint.heard[0]?.bytes.length, DATAGRAM_MAX_BYTES, "the largest the channel sends goes on");
  });

  it("refuses an endpoint whose name leads to this computer or its network", async () => {
    const endpoint = await standIn();
    const relay = await openDatagramRelay({ count: 1 });
    closing.push(relay.close);
    // `localhost` resolves to loopback: the default lookup gives it no address, so nothing is sent.
    const game = await gameSocket(relay.portOf("localhost", endpoint.port) ?? 0);
    game.socket.send(Buffer.from("x"));
    await sleep(150);
    assert.equal(endpoint.heard.length, 0);
  });

  it("keeps a seat its address through a flood of more senders than a port keeps", async () => {
    const endpoint = await standIn((bytes) => bytes.toString().startsWith("seat"));
    const relay = await openDatagramRelay({ count: 1, resolve: async () => "127.0.0.1" });
    closing.push(relay.close);
    const port = relay.portOf("fast-eu.genex.games", endpoint.port) ?? 0;
    const seat = await gameSocket(port);
    seat.socket.send(Buffer.from("seat"));
    await until(() => seat.heard.length === 1);
    const seatAddress = endpoint.heard[0]?.from.port;
    // Strangers the room never answers (no seat's key): they take each other's places.
    const strangers = await Promise.all(Array.from({ length: DATAGRAM_SENDERS_MAX * 3 }, () => gameSocket(port)));
    endpoint.heard.length = 0;
    for (let round = 0; round < 3; round += 1) {
      for (const one of strangers) one.socket.send(Buffer.from("flood"));
      seat.socket.send(Buffer.from(`seat${round}`));
      await sleep(30);
    }
    await until(() => seat.heard.length === 4);
    assert.equal(seat.heard.length, 4, "the seat heard every answer");
    const seatFrom = endpoint.heard
      .filter((one) => one.bytes.toString().startsWith("seat"))
      .map((one) => one.from.port);
    assert.deepEqual(new Set(seatFrom), new Set([seatAddress]), "the seat's address at the room never moved");
  });
});
