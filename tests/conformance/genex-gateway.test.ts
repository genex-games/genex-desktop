/**
 * A native game's way out of its sandbox to Genex (`main/play/genex-gateway.ts`), against fake Genex
 * hosts on this machine: requests reach only the port's own Genex host, relay addresses in JSON
 * answers come back pointed at the gateway (so the next connection does too), on the port the address
 * named, a WebSocket is joined end to end, and anything else (another host, a port with no host yet, a full pool, an oversized
 * request) is refused or left unreachable, with nothing sent on.
 */
import assert from "node:assert/strict";
import http, { type IncomingMessage } from "node:http";
import net, { type AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import {
  authorityHostsOf,
  type GenexGateway,
  relayHostsOf,
  rewriteRelays,
  startGenexGateway,
} from "../../src/main/play/genex-gateway.ts";

/** One fake Genex host: what it was asked, and its JSON answer for a path. */
type Seen = { method: string; url: string; host: string; origin: string | undefined; body: string };

/**
 * Fake Genex servers on 127.0.0.1, each answering JSON by path and echoing on a WebSocket; one is
 * named by its host (port 443) or `host:port`.
 */
async function fakeGenex(answers: Record<string, Record<string, unknown>>) {
  const seen = new Map<string, Seen[]>();
  const ports = new Map<string, number>();
  const servers: http.Server[] = [];
  // A WebSocket leaves the server's own connection list, so the fake ends each one itself.
  const sockets = new Set<net.Socket>();
  for (const [host, byPath] of Object.entries(answers)) {
    seen.set(host, []);
    const server = http.createServer(async (req: IncomingMessage, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      seen.get(host)?.push({
        method: req.method ?? "",
        url: req.url ?? "",
        host: req.headers.host ?? "",
        origin: req.headers.origin,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const body = byPath[(req.url ?? "").split("?")[0] ?? ""];
      if (body === undefined) res.writeHead(404).end();
      else res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    server.on("upgrade", (req, socket: net.Socket) => {
      sockets.add(socket);
      seen
        .get(host)
        ?.push({ method: "WS", url: req.url ?? "", host: req.headers.host ?? "", origin: undefined, body: "" });
      socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
      socket.on("data", (data: Buffer) => socket.write(Buffer.concat([Buffer.from(`${host}:`), data])));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    ports.set(host, (server.address() as AddressInfo).port);
    servers.push(server);
  }
  const upstream = (host: string, port: number) => ({
    host: "127.0.0.1",
    port: ports.get(port === 443 ? host : `${host}:${port}`) ?? 1,
    secure: false,
  });
  const close = async () => {
    for (const socket of sockets) socket.destroy();
    for (const server of servers) server.closeAllConnections();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  };
  return { seen, upstream, close };
}

const RELAYS = relayHostsOf("api.genex.games");
const opened: Array<() => Promise<void>> = [];
after(async () => {
  for (const close of opened) await close();
});

/** A gateway over fake hosts, closed after the file. */
async function gatewayOver(answers: Record<string, Record<string, unknown>>, relayPorts = 3) {
  const genex = await fakeGenex(answers);
  const gateway = await startGenexGateway({
    api: "https://api.genex.games",
    relay: RELAYS,
    authority: authorityHostsOf("api.genex.games"),
    relayPorts,
    authorityPorts: 3,
    upstream: genex.upstream,
  });
  opened.push(gateway.close, genex.close);
  return { genex, gateway };
}

/** A JSON request to the gateway; its status and parsed body. */
async function call(url: string, init: RequestInit = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  const json = (response.headers.get("content-type") ?? "").includes("json");
  return { status: response.status, body: json ? JSON.parse(text) : null, text };
}

/** A raw WebSocket handshake to the gateway, then one message; what came back. */
function wsRoundTrip(port: number, path: string, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nOrigin: http://evil.test\r\n\r\n`,
      );
    });
    let got = "";
    socket.on("data", (data: Buffer) => {
      got += data.toString("utf8");
      if (got.includes("\r\n\r\n") && !got.includes(message)) socket.write(message);
      if (got.includes(message) || got.startsWith("HTTP/1.1 403")) {
        socket.destroy();
        resolve(got);
      }
    });
    socket.on("error", reject);
  });
}

const portOf = (gateway: GenexGateway, url: string) => Number(new URL(url.replace(/^ws/, "http")).port);

describe("a native game's gateway to Genex", () => {
  it("passes a request to Genex's API and points the relays it names back at the gateway", async () => {
    const urls = ["wss://relay-eu.genex.games", "wss://relay-asia.genex.games"];
    const { genex, gateway } = await gatewayOver({
      "api.genex.games": { "/api/embed/guest-session": { token: "t", colyseus: { urls }, other: "wss://evil.test" } },
    });
    const { status, body } = await call(`${gateway.apiUrl}/api/embed/guest-session`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.test" },
      body: JSON.stringify({ slug: "rain" }),
    });
    assert.equal(status, 200);
    const local = body.colyseus.urls as string[];
    assert.equal(local.length, 2);
    for (const url of local) assert.match(url, /^ws:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(local[0], local[1], "each relay its own port");
    assert.ok(
      local.every((url) => gateway.ports.includes(portOf(gateway, url))),
      "ports the sandbox allows",
    );
    assert.equal(body.other, "wss://evil.test", "another host is never mapped");
    const [request] = genex.seen.get("api.genex.games") ?? [];
    assert.equal(request?.host, "api.genex.games");
    assert.equal(request?.origin, undefined, "no Origin goes on");
    assert.equal(request?.body, JSON.stringify({ slug: "rain" }));
  });

  it("sends matchmaking to the relay and the game's socket after it, through the seat's rewritten address", async () => {
    const { genex, gateway } = await gatewayOver({
      "api.genex.games": { "/api/embed/session": { colyseus: { urls: ["wss://relay-eu.genex.games"] } } },
      "relay-eu.genex.games": {},
      "relay-asia.genex.games": {
        "/matchmake/joinOrCreate/play": {
          name: "play",
          roomId: "R1",
          processId: "P1",
          publicAddress: "relay-asia.genex.games/2567",
        },
      },
    });
    await call(`${gateway.apiUrl}/api/embed/session`, { method: "POST" });
    // Global matchmaking can seat a player on another region's relay: the seat names it.
    const asia = gateway.ports[2] ?? 0;
    const seat = await call(`http://127.0.0.1:${asia}/matchmake/joinOrCreate/play`, { method: "POST" });
    assert.equal(seat.status, 403, "asia has no port until an answer names it");
    const viaApi = await gatewayOver({
      "api.genex.games": {
        "/api/embed/session": { colyseus: { urls: ["wss://relay-eu.genex.games", "wss://relay-asia.genex.games"] } },
      },
      "relay-asia.genex.games": {
        "/matchmake/joinOrCreate/play": { roomId: "R1", processId: "P1", publicAddress: "relay-asia.genex.games/2567" },
      },
    });
    const session = await call(`${viaApi.gateway.apiUrl}/api/embed/session`, { method: "POST" });
    const asiaPort = portOf(viaApi.gateway, session.body.colyseus.urls[1]);
    const joined = await call(`http://127.0.0.1:${asiaPort}/matchmake/joinOrCreate/play`, { method: "POST" });
    assert.equal(joined.body.publicAddress, `127.0.0.1:${asiaPort}/2567`);
    const echoed = await wsRoundTrip(asiaPort, "/2567/P1/R1?sessionId=S1", "hello");
    assert.match(echoed, /^HTTP\/1\.1 101/);
    assert.match(echoed, /relay-asia\.genex\.games:hello/, "the relay's own socket answered");
    const socket = viaApi.genex.seen.get("relay-asia.genex.games")?.find((one) => one.method === "WS");
    assert.equal(socket?.url, "/2567/P1/R1?sessionId=S1");
    assert.equal(socket?.host, "relay-asia.genex.games");
    assert.equal(genex.seen.get("relay-asia.genex.games")?.length, 0, "the refused call reached nobody");
  });

  it("refuses a port with no Genex host, a socket to it, and an oversized request, sending nothing on", async () => {
    const { genex, gateway } = await gatewayOver({ "api.genex.games": { "/api/x": { ok: true } } });
    const idle = gateway.ports[3] ?? 0;
    assert.equal((await call(`http://127.0.0.1:${idle}/matchmake/joinOrCreate/play`, { method: "POST" })).status, 403);
    assert.match(await wsRoundTrip(idle, "/2567/P/R", "x"), /^HTTP\/1\.1 403/);
    const big = await call(`${gateway.apiUrl}/api/x`, { method: "POST", body: "x".repeat(1024 * 1024 + 1) });
    assert.equal(big.status, 413);
    assert.equal(genex.seen.get("api.genex.games")?.length, 0);
  });

  it("leaves a relay unreachable once its reserved ports are taken", async () => {
    const urls = ["wss://relay-eu.genex.games", "wss://relay-asia.genex.games"];
    const { gateway } = await gatewayOver({ "api.genex.games": { "/api/s": { urls } } }, 1);
    const { body } = await call(`${gateway.apiUrl}/api/s`);
    assert.match(body.urls[0], /^ws:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(body.urls[1], "wss://relay-asia.genex.games", "no port left: the game can't reach it");
  });
});

describe("a gateway to a server its address names on a port", () => {
  it("points an address that names a port at a local port of its own, and reaches it on that port", async () => {
    const { genex, gateway } = await gatewayOver({
      "api.genex.games": {
        "/api/embed/session": {
          colyseus: {
            authorityUrls: ["wss://authority-eu.genex.games", "wss://authority-us.genex.games:22"],
            authorityRegions: [
              { region: "eu", urls: ["wss://authority-eu.genex.games:2053", "wss://authority-eu.genex.games"] },
            ],
          },
        },
      },
      "authority-eu.genex.games:2053": { "/": { on: 2053 } },
      "authority-eu.genex.games": { "/": { on: 443 } },
    });
    const { body } = await call(`${gateway.apiUrl}/api/embed/session`, { method: "POST" });
    const [named, plain] = body.colyseus.authorityRegions[0].urls;
    assert.match(named, /^ws:\/\/127\.0\.0\.1:\d+$/, "the named port replaced, not kept after the local one");
    assert.equal(body.colyseus.authorityUrls[0], plain, "one server and port, one local port");
    assert.notEqual(named, plain, "another port of the same host is another server");
    assert.equal(
      body.colyseus.authorityUrls[1],
      "wss://authority-us.genex.games:22",
      "a port Genex isn't on: not mapped",
    );
    assert.deepEqual((await call(`http://127.0.0.1:${portOf(gateway, named)}/`)).body, { on: 2053 });
    assert.deepEqual((await call(`http://127.0.0.1:${portOf(gateway, plain)}/`)).body, { on: 443 });
    const echoed = await wsRoundTrip(portOf(gateway, named), "/P1/R1", "ping-7");
    assert.match(echoed, /authority-eu\.genex\.games:2053:ping-7/, "the server on the named port answered");
    const seen = genex.seen.get("authority-eu.genex.games:2053") ?? [];
    assert.deepEqual(
      seen.map((one) => one.host),
      ["authority-eu.genex.games:2053", "authority-eu.genex.games:2053"],
      "the Host a browser sends there",
    );
  });
});

describe("which hosts a gateway maps", () => {
  it("maps only Genex's relays, by exact host", () => {
    const rows: Array<[string, boolean]> = [
      ["relay-eu.genex.games", true],
      ["relay.genex.games", true],
      ["relay-asia2.genex.games", true],
      ["api.genex.games", false],
      ["evil-relay.genex.games", false],
      ["relay-eu.genex.games.evil.test", false],
      ["relay-eu.genex.gamesx", false],
      ["RELAY-EU.genex.games", false],
    ];
    for (const [host, expected] of rows) assert.equal(RELAYS.test(host), expected, host);
  });

  it("rewrites relay lists and seat addresses, and nothing it can't map", () => {
    const local: Record<string, number> = { "relay-eu.genex.games:443": 4100, "relay-eu.genex.games:2053": 4101 };
    const port = (host: string, named: number) => local[`${host}:${named}`];
    const rows: Array<[string, string]> = [
      ['{"urls":["wss://relay-eu.genex.games:2053"]}', '{"urls":["ws://127.0.0.1:4101"]}'],
      ['{"urls":["wss://relay-eu.genex.games:2053/x?y=1"]}', '{"urls":["ws://127.0.0.1:4101/x?y=1"]}'],
      ['{"urls":["wss://relay-eu.genex.games:443"]}', '{"urls":["ws://127.0.0.1:4100"]}'],
      ['{"urls":["wss://relay-eu.genex.games:2083"]}', '{"urls":["wss://relay-eu.genex.games:2083"]}'],
      ['{"urls":["wss://relay-eu.genex.games:2053x"]}', '{"urls":["wss://relay-eu.genex.games:2053x"]}'],
      ['{"urls":["wss://relay-eu.genex.games:"]}', '{"urls":["wss://relay-eu.genex.games:"]}'],
      ['{"publicAddress":"relay-eu.genex.games:2053/2567"}', '{"publicAddress":"127.0.0.1:4101/2567"}'],
      ['{"publicAddress":"relay-eu.genex.games:2053"}', '{"publicAddress":"127.0.0.1:4101"}'],
      ['{"publicAddress":"relay-eu.genex.games:x/2567"}', '{"publicAddress":"relay-eu.genex.games:x/2567"}'],
      ['{"urls":["wss://relay-eu.genex.games"]}', '{"urls":["ws://127.0.0.1:4100"]}'],
      ['{"publicAddress":"relay-eu.genex.games/2567"}', '{"publicAddress":"127.0.0.1:4100/2567"}'],
      ['{"publicAddress" : "relay-eu.genex.games"}', '{"publicAddress" : "127.0.0.1:4100"}'],
      ['{"urls":["wss://relay-eu.genex.games.evil.test"]}', '{"urls":["wss://relay-eu.genex.games.evil.test"]}'],
      ['{"urls":["wss://relay-us.genex.games"]}', '{"urls":["wss://relay-us.genex.games"]}'],
      ['{"note":"https://relay-eu.genex.games"}', '{"note":"https://relay-eu.genex.games"}'],
    ];
    for (const [input, expected] of rows) assert.equal(rewriteRelays(input, port), expected, input);
  });
});
