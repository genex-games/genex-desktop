/**
 * The way out of a native game's sandbox to Genex, and nowhere else. A game from Play may connect
 * only to this gateway's ports on 127.0.0.1 (macOS's sandbox names no host but "localhost"): the
 * first is Genex's API, each other one a relay or an authority server as the API's and their own
 * answers name them. Every request and WebSocket goes on to that one host over TLS; relay and
 * authority addresses in JSON answers (an API's relay and authority lists and regions, a seat
 * reservation's `publicAddress`) are rewritten to their local port, so the game's next connection
 * (a region probe, a join, the room's socket) comes back through the gateway too. An authority
 * room's fast@1 binding, which names its UDP endpoint inside the room's WebSocket, is pointed at
 * one of the gateway's datagram ports (`gateway-frames.ts`), which carry the game's datagrams to
 * that endpoint and back (`gateway-datagrams.ts`). A port with no Genex host behind it, or a host
 * the reserved ports can't hold, is refused: the game fails safe. The gateway adds no credential
 * of its own; a game signs in with its own token or the ticket its launcher passed it.
 */
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net, { type AddressInfo, type Socket } from "node:net";
import tls from "node:tls";
import {
  type DatagramClock,
  type DatagramResolve,
  GATEWAY_DATAGRAM_PORTS,
  isPublicAddress,
  openDatagramRelay,
} from "./gateway-datagrams.ts";
import { type DatagramPortOf, serverFrames } from "./gateway-frames.ts";

/** Relay ports a game's gateway reserves beside the API's: Genex's regions, with room to grow. */
export const GATEWAY_RELAY_PORTS = 6;
/** Authority ports it reserves: Genex's regions, each with a few nodes once the fleet scales. */
export const GATEWAY_AUTHORITY_PORTS = 12;
/** The lowest port a fast endpoint may name: an unprivileged one. */
const MIN_FAST_PORT = 1024;
/** The most of a request body forwarded, and of a JSON answer read to rewrite. */
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const LOOPBACK = "127.0.0.1";
const HTTPS_PORT = 443;
/** Headers that belong to one connection, never passed on. */
const HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "host",
  "origin",
  "accept-encoding",
]);

const MESSAGE = {
  NotGenex: "This port reaches no Genex service.",
  TooLarge: "Request too large.",
  Upstream: "Genex didn't answer.",
} as const;

/** How the gateway reaches a Genex host: TLS on 443, or (tests) plain TCP on a local port. */
export type Upstream = (host: string) => { host: string; port: number; secure: boolean };
const genexUpstream: Upstream = (host) => ({ host, port: HTTPS_PORT, secure: true });

/**
 * One game's gateway: the API's local address, every reserved TCP port and datagram port (its
 * sandbox's), and its end.
 */
export interface GenexGateway {
  apiUrl: string;
  ports: number[];
  datagramPorts: number[];
  close(): Promise<void>;
}

/**
 * What a gateway serves: Genex's API origin, the patterns its relay and authority hosts match, and
 * which fast endpoints' hosts it carries datagrams to (`fastHostsOf`).
 */
export interface GenexGatewayOptions {
  api: string;
  relay: RegExp;
  authority?: RegExp;
  fast?: (host: string) => boolean;
  relayPorts?: number;
  authorityPorts?: number;
  datagramPorts?: number;
  upstream?: Upstream;
  /** How a fast endpoint's host is found (`publicLookup`: public addresses only). */
  resolve?: DatagramResolve;
  clock?: DatagramClock;
}

/** The API host's domain, escaped for a pattern: `genex\\.games` of `api.genex.games`. */
const domainOf = (apiHost: string) => apiHost.split(".").slice(1).join(".").replaceAll(".", "\\.");

/** The relay host pattern for an API host: `relay.<domain>` and `relay-<region>.<domain>`. */
export function relayHostsOf(apiHost: string): RegExp {
  return new RegExp(`^relay(-[a-z0-9]+)?\\.${domainOf(apiHost)}$`);
}

/** The authority host pattern for an API host: `authority.<domain>`, `authority-<region>[-<node>].<domain>`. */
export function authorityHostsOf(apiHost: string): RegExp {
  return new RegExp(`^authority(-[a-z0-9]+){0,3}\\.${domainOf(apiHost)}$`);
}

/**
 * Which fast endpoints' hosts a game's datagrams may go to: `fast[-<region>…].<domain>`, or a
 * public address (a scaled node is named by its own), never a name or address of this computer
 * or its network. A name is looked up only by `publicLookup`, which refuses any but a public address.
 */
export function fastHostsOf(apiHost: string): (host: string) => boolean {
  const named = new RegExp(`^fast(-[a-z0-9]+){0,3}\\.${domainOf(apiHost)}$`);
  return (host) => named.test(host) || (net.isIP(host) !== 0 && isPublicAddress(host));
}

/** One pool of local ports: the hosts a pattern matches, each given a port as it is first named. */
interface Pool {
  hosts: RegExp;
  free: number[];
}

/**
 * Which Genex host each local port reaches: the API's, then relays' and authority servers', each
 * given out from its own pool as an answer first names it; and which ports reach an authority server.
 */
class PortMap {
  readonly #hostOf = new Map<number, string>();
  readonly #portOf = new Map<string, number>();
  readonly #authority = new Set<number>();
  readonly #pools: { relay: Pool; authority: Pool };
  readonly #apiHost: string;

  constructor(apiHost: string, relay: RegExp, authority: RegExp | undefined) {
    this.#apiHost = apiHost;
    // With no authority pattern, no host is an authority server's.
    this.#pools = { relay: { hosts: relay, free: [] }, authority: { hosts: authority ?? /(?!)/, free: [] } };
  }

  /** The ports the gateway listens on: the first reaches the API, the rest wait for relays and authority servers. */
  open(apiPort: number, relayPorts: readonly number[], authorityPorts: readonly number[]): void {
    this.#hostOf.set(apiPort, this.#apiHost);
    this.#pools.relay.free.push(...relayPorts);
    this.#pools.authority.free.push(...authorityPorts);
    for (const port of authorityPorts) this.#authority.add(port);
  }

  host(port: number): string | undefined {
    return this.#hostOf.get(port);
  }

  /** Whether `port` reaches an authority server: its WebSocket carries a fast binding. */
  isAuthority(port: number): boolean {
    return this.#authority.has(port) && this.#hostOf.has(port);
  }

  /** The local port for a relay or authority host, given out now if its pool has one free; undefined for any other host. */
  portFor(host: string): number | undefined {
    const known = this.#portOf.get(host);
    if (known !== undefined) return known;
    const pool = [this.#pools.relay, this.#pools.authority].find((one) => one.hosts.test(host));
    const port = pool?.free.shift();
    if (port === undefined) return undefined;
    this.#portOf.set(host, port);
    this.#hostOf.set(port, host);
    return port;
  }
}

/** JSON text with each relay and authority address pointed at its local port; one it can't map stays as it was. */
export function rewriteRelays(text: string, portOf: (host: string) => number | undefined): string {
  return text
    .replace(/wss:\/\/([a-z0-9.-]+)(?![\w.-])/g, (all, host: string) => {
      const port = portOf(host);
      return port === undefined ? all : `ws://${LOOPBACK}:${port}`;
    })
    .replace(
      /("publicAddress"\s*:\s*")([a-z0-9.-]+)((?:[:/][^"]*)?")/g,
      (all, key: string, host: string, rest: string) => {
        const port = portOf(host);
        return port === undefined ? all : `${key}${LOOPBACK}:${port}${rest}`;
      },
    );
}

/** A request's headers as they go on to `host`: one connection's own left out, its host set. */
function forwardHeaders(headers: IncomingHttpHeaders, host: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = { host };
  for (const [name, value] of Object.entries(headers))
    if (value !== undefined && !HOP_HEADERS.has(name)) out[name] = value;
  return out;
}

/** Reads a body up to `max` bytes; null when it is longer. */
function readBody(stream: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= max) {
        chunks.push(chunk);
        return;
      }
      // Read no more of it; the caller answers, then ends the connection.
      stream.off("data", onData);
      stream.pause();
      resolve(null);
    };
    stream.on("data", onData);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** An answer passed back: a JSON one read whole and rewritten, any other streamed as it comes. */
async function answer(upstream: IncomingMessage, res: ServerResponse, ports: PortMap): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(upstream.headers))
    if (value !== undefined && !HOP_HEADERS.has(name)) headers[name] = value;
  const status = upstream.statusCode ?? 502;
  if (!String(upstream.headers["content-type"] ?? "").includes("json")) {
    res.writeHead(status, headers);
    upstream.pipe(res);
    return;
  }
  const body = await readBody(upstream, MAX_JSON_BYTES);
  if (body === null) {
    res.writeHead(502).end(MESSAGE.Upstream);
    return;
  }
  const text = Buffer.from(rewriteRelays(body.toString("utf8"), (host) => ports.portFor(host)));
  res.writeHead(status, { ...headers, "content-length": String(text.length) }).end(text);
}

/** One HTTP request to the port's Genex host. */
async function forward(req: IncomingMessage, res: ServerResponse, host: string, ports: PortMap, upstream: Upstream) {
  const body = await readBody(req, MAX_REQUEST_BYTES);
  if (body === null) {
    res.writeHead(413, { connection: "close" }).end(MESSAGE.TooLarge, () => req.destroy());
    return;
  }
  const to = upstream(host);
  const send = to.secure ? https.request : http.request;
  const outgoing = send({
    host: to.host,
    port: to.port,
    servername: to.secure ? to.host : undefined,
    method: req.method,
    path: req.url ?? "/",
    headers: { ...forwardHeaders(req.headers, host), "content-length": String(body.length) },
  });
  outgoing.on("response", (incoming) => void answer(incoming, res, ports).catch(() => res.destroy()));
  outgoing.on("error", () => {
    if (!res.headersSent) res.writeHead(502).end(MESSAGE.Upstream);
    else res.destroy();
  });
  outgoing.end(body);
}

/** Upgrade headers never sent on: one connection's own, and (to an authority server) compression, which would hide a binding. */
const TUNNEL_DROPPED = ["host", "origin"];
const AUTHORITY_TUNNEL_DROPPED = [...TUNNEL_DROPPED, "sec-websocket-extensions"];

/** How a tunnel treats the room's side: as it comes, or (an authority server's) with each fast binding pointed at the gateway. */
type RoomSide = ((genex: Socket) => NodeJS.ReadableStream) | null;

/** One WebSocket to the port's Genex host: its upgrade sent on as asked, then both ends joined. */
function tunnel(req: IncomingMessage, client: Socket, head: Buffer, host: string, upstream: Upstream, room: RoomSide) {
  const to = upstream(host);
  const dropped = room ? AUTHORITY_TUNNEL_DROPPED : TUNNEL_DROPPED;
  const lines = [`GET ${req.url ?? "/"} HTTP/1.1`, `Host: ${host}`];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i] ?? "";
    if (!dropped.includes(name.toLowerCase())) lines.push(`${name}: ${req.rawHeaders[i + 1] ?? ""}`);
  }
  const onReady = () => {
    genex.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) genex.write(head);
    (room ? room(genex) : genex).pipe(client);
    client.pipe(genex);
  };
  const genex = to.secure
    ? tls.connect({ host: to.host, port: to.port, servername: to.host }, onReady)
    : net.connect({ host: to.host, port: to.port }, onReady);
  const end = () => {
    genex.destroy();
    client.destroy();
  };
  for (const socket of [genex, client]) {
    socket.on("error", end);
    socket.on("close", end);
  }
}

/** A server on 127.0.0.1 for one port of the gateway: the Genex host behind it, or a refusal. */
function portServer(ports: PortMap, upstream: Upstream, fastPortOf: DatagramPortOf) {
  const server = http.createServer((req, res) => {
    const host = ports.host((req.socket.localPort as number | undefined) ?? 0);
    if (!host) {
      res.writeHead(403).end(MESSAGE.NotGenex);
      return;
    }
    void forward(req, res, host, ports, upstream).catch(() => res.destroy());
  });
  server.on("upgrade", (req, client: Socket, head: Buffer) => {
    const host = ports.host(client.localPort ?? 0);
    if (!host) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const port = client.localPort ?? 0;
    const room: RoomSide = ports.isAuthority(port) ? (genex) => genex.pipe(serverFrames(fastPortOf)) : null;
    tunnel(req, client, head, host, upstream, room);
  });
  return server;
}

/** A server listening on a free port of 127.0.0.1, and that port. */
async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, LOOPBACK, () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

/**
 * Starts one game's gateway: the API's port, `relayPorts` and `authorityPorts` more, each reaching
 * only its Genex host, and `datagramPorts` for the fast endpoints its authority rooms name.
 */
export async function startGenexGateway(options: GenexGatewayOptions): Promise<GenexGateway> {
  const api = new URL(options.api);
  const upstream = options.upstream ?? genexUpstream;
  const relayCount = options.relayPorts ?? GATEWAY_RELAY_PORTS;
  const authorityCount = options.authority ? (options.authorityPorts ?? GATEWAY_AUTHORITY_PORTS) : 0;
  const count = 1 + relayCount + authorityCount;
  const map = new PortMap(api.hostname, options.relay, options.authority);
  const fast = options.fast;
  const datagrams = await openDatagramRelay({
    count: fast ? (options.datagramPorts ?? GATEWAY_DATAGRAM_PORTS) : 0,
    ...(options.resolve ? { resolve: options.resolve } : {}),
    ...(options.clock ? { clock: options.clock } : {}),
  });
  const fastPortOf: DatagramPortOf = (host, port) =>
    fast?.(host) && port >= MIN_FAST_PORT ? datagrams.portOf(host, port) : undefined;
  const servers: http.Server[] = [];
  const ports: number[] = [];
  // Every socket a game opened, its WebSockets too, so closing ends them all at once.
  const sockets = new Set<Socket>();
  for (let i = 0; i < count; i += 1) {
    const server = portServer(map, upstream, fastPortOf);
    server.on("connection", (socket: Socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    servers.push(server);
    ports.push(await listen(server));
  }
  // Until here every port refuses: none has a host yet.
  map.open(ports[0] ?? 0, ports.slice(1, 1 + relayCount), ports.slice(1 + relayCount));
  return {
    apiUrl: `http://${LOOPBACK}:${ports[0]}`,
    ports,
    datagramPorts: datagrams.ports,
    close: async () => {
      const closed = servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())));
      for (const socket of sockets) socket.destroy();
      await Promise.all([...closed, datagrams.close()]);
    },
  };
}
