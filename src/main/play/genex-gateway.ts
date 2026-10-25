/**
 * The way out of a native game's sandbox to Genex, and nowhere else. A game from Play may connect
 * only to this gateway's ports on 127.0.0.1 (macOS's sandbox names no host but "localhost"): the
 * first is Genex's API, each other one a relay as the API's and the relays' own answers name them.
 * Every request and WebSocket goes on to that one host over TLS; relay addresses in JSON answers
 * (an API's relay list, a seat reservation's `publicAddress`) are rewritten to their local port, so
 * the game's next connection comes back through the gateway too. A port with no Genex host behind
 * it, or a relay the reserved ports can't hold, is refused: the game fails safe. The gateway adds no
 * credential of its own; a game signs in with its own token or the ticket its launcher passed it.
 */
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net, { type AddressInfo, type Socket } from "node:net";
import tls from "node:tls";

/** Relay ports a game's gateway reserves beside the API's: Genex's regions, with room to grow. */
export const GATEWAY_RELAY_PORTS = 6;
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

/** One game's gateway: the API's local address, every reserved port (its sandbox's), and its end. */
export interface GenexGateway {
  apiUrl: string;
  ports: number[];
  close(): Promise<void>;
}

/** What a gateway serves: Genex's API origin and the pattern its relay hosts match. */
export interface GenexGatewayOptions {
  api: string;
  relay: RegExp;
  relayPorts?: number;
  upstream?: Upstream;
}

/** The relay host pattern for an API host: `relay.<domain>` and `relay-<region>.<domain>`. */
export function relayHostsOf(apiHost: string): RegExp {
  const domain = apiHost.split(".").slice(1).join(".").replaceAll(".", "\\.");
  return new RegExp(`^relay(-[a-z0-9]+)?\\.${domain}$`);
}

/** Which Genex host each local port reaches; relay ports are given out as relays are first named. */
class PortMap {
  readonly #hostOf = new Map<number, string>();
  readonly #portOf = new Map<string, number>();
  readonly #free: number[];
  readonly #relay: RegExp;

  readonly #apiHost: string;

  constructor(apiHost: string, relay: RegExp) {
    this.#apiHost = apiHost;
    this.#free = [];
    this.#relay = relay;
  }

  /** The ports the gateway listens on: the first reaches the API, the rest wait for relays. */
  open(apiPort: number, relayPorts: readonly number[]): void {
    this.#hostOf.set(apiPort, this.#apiHost);
    this.#free.push(...relayPorts);
  }

  host(port: number): string | undefined {
    return this.#hostOf.get(port);
  }

  /** The local port for a relay host, given out now if one is free; undefined for any other host. */
  relayPort(host: string): number | undefined {
    if (!this.#relay.test(host)) return undefined;
    const known = this.#portOf.get(host);
    if (known !== undefined) return known;
    const port = this.#free.shift();
    if (port === undefined) return undefined;
    this.#portOf.set(host, port);
    this.#hostOf.set(port, host);
    return port;
  }
}

/** JSON text with each relay address pointed at its local port; one it can't map stays as it was. */
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
  const text = Buffer.from(rewriteRelays(body.toString("utf8"), (host) => ports.relayPort(host)));
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

/** One WebSocket to the port's Genex host: its upgrade sent on as asked, then both ends joined. */
function tunnel(req: IncomingMessage, client: Socket, head: Buffer, host: string, upstream: Upstream): void {
  const to = upstream(host);
  const lines = [`GET ${req.url ?? "/"} HTTP/1.1`, `Host: ${host}`];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i] ?? "";
    if (!["host", "origin"].includes(name.toLowerCase())) lines.push(`${name}: ${req.rawHeaders[i + 1] ?? ""}`);
  }
  const onReady = () => {
    genex.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) genex.write(head);
    genex.pipe(client);
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
function portServer(ports: PortMap, upstream: Upstream) {
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
    tunnel(req, client, head, host, upstream);
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

/** Starts one game's gateway: the API's port and `relayPorts` more, each reaching only its Genex host. */
export async function startGenexGateway(options: GenexGatewayOptions): Promise<GenexGateway> {
  const api = new URL(options.api);
  const upstream = options.upstream ?? genexUpstream;
  const count = 1 + (options.relayPorts ?? GATEWAY_RELAY_PORTS);
  const map = new PortMap(api.hostname, options.relay);
  const servers: http.Server[] = [];
  const ports: number[] = [];
  // Every socket a game opened, its WebSockets too, so closing ends them all at once.
  const sockets = new Set<Socket>();
  for (let i = 0; i < count; i += 1) {
    const server = portServer(map, upstream);
    server.on("connection", (socket: Socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    servers.push(server);
    ports.push(await listen(server));
  }
  // Until here every port refuses: none has a host yet.
  map.open(ports[0] ?? 0, ports.slice(1));
  return {
    apiUrl: `http://${LOOPBACK}:${ports[0]}`,
    ports,
    close: async () => {
      const closed = servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())));
      for (const socket of sockets) socket.destroy();
      await Promise.all(closed);
    },
  };
}
