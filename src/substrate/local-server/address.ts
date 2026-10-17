/**
 * The address a person types for a model server they run themselves (LM Studio, llama.cpp,
 * TabbyAPI, vLLM, …): read into the base URL of its OpenAI-compatible API, and accepted only when
 * every address it names is on this computer or the local network. A server elsewhere is a hosted
 * API that may bill per token, which the app never treats as local (`shared/providers.ts`).
 *
 * Reading is pure; only a name (not a number) is looked up, and a refused address is never looked
 * up or reached.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { SECOND_MS } from "../../shared/duration.ts";
import { AddressProblem } from "../../shared/local-server.ts";

export { AddressProblem };

/** The longest address read; a real one is a few dozen characters. */
const MAX_ADDRESS_CHARS = 2048;
/** How long looking a name up may take (a `.local` name asks the network). */
const LOOKUP_TIMEOUT_MS = 5 * SECOND_MS;
/** The API path almost every server uses, for an address typed without one. */
const DEFAULT_API_PATH = "/v1";
/** Endpoint paths a pasted address may end in; the base URL is what comes before them. */
const ENDPOINT_SUFFIXES = ["/chat/completions", "/completions", "/models"] as const;
/** What a server prints for "every interface", and the same computer it reaches from here. */
const ANY_HOST: Readonly<Record<string, string>> = { "0.0.0.0": "127.0.0.1", "[::]": "[::1]" };

/** This computer, the private ranges, link-local, and the shared range tailnets use. */
const LOCAL_RANGES: ReadonlyArray<readonly [string, number, "ipv4" | "ipv6"]> = [
  ["127.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["::1", 128, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
];

const LOCAL = new BlockList();
for (const [network, prefix, family] of LOCAL_RANGES) LOCAL.addSubnet(network, prefix, family);

/** A typed address read: the base URL to call, and the host to check; or why it cannot be one. */
export type ReadAddress = { ok: true; baseUrl: string; host: string } | { ok: false; problem: AddressProblem };

/** A local server's address, checked: its base URL, or why it is refused. */
export type LocalAddress = { ok: true; baseUrl: string } | { ok: false; problem: AddressProblem };

/** One address a name resolves to, as `dns.lookup` gives it. */
export type ResolvedAddress = { address: string; family: number };
/** Looks a host name up; injected in tests so no test asks the real network. */
export type HostLookup = (host: string) => Promise<ResolvedAddress[]>;

const refused = (problem: AddressProblem): { ok: false; problem: AddressProblem } => ({ ok: false, problem });

/** Is this IP address on this computer or the local network? Anything unreadable is not. */
export function isLocalIp(ip: string): boolean {
  const bare = ip.replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 0) return false;
  return LOCAL.check(bare, family === 4 ? "ipv4" : "ipv6");
}

/** `host:port` or `[v6]:port` at the start of an address typed without a scheme. */
const HOST_AND_PORT = /^(\[[^\]]*\]|[^:/[\]]+):\d+(\/|$)/;
/** A scheme other than a host and port: `javascript:`, `file:`, `mailto:`. */
const OTHER_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** The address as a URL string with a scheme, or the problem with it as typed. */
function withScheme(typed: string): string | AddressProblem {
  if (typed.includes("://")) return typed;
  if (HOST_AND_PORT.test(typed) || !OTHER_SCHEME.test(typed)) return `http://${typed}`;
  return AddressProblem.Scheme;
}

/** The API's path: a pasted endpoint and trailing slashes taken off, `/v1` when there is none. */
function apiPath(pathname: string): string {
  let path = pathname.replace(/\/+$/, "");
  const endpoint = ENDPOINT_SUFFIXES.find((suffix) => path.endsWith(suffix));
  if (endpoint) path = path.slice(0, -endpoint.length).replace(/\/+$/, "");
  return path || DEFAULT_API_PATH;
}

/** Parse what was typed into a URL, or say what is wrong with it. */
function parsedUrl(input: unknown): URL | AddressProblem {
  const typed = typeof input === "string" ? input.trim() : "";
  if (!typed) return AddressProblem.Empty;
  // Whitespace or a control character inside an address is never a server's: it is an injection.
  if (typed.length > MAX_ADDRESS_CHARS || /[\s\p{Cc}]/u.test(typed)) return AddressProblem.Malformed;
  const full = withScheme(typed);
  if (full === AddressProblem.Scheme) return full;
  let url: URL;
  try {
    url = new URL(full);
  } catch {
    return AddressProblem.Malformed;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return AddressProblem.Scheme;
  if (url.username || url.password) return AddressProblem.Credentials;
  if (!url.hostname || typed.includes("?") || typed.includes("#")) return AddressProblem.Malformed;
  return url;
}

/**
 * Read a typed address ("127.0.0.1:5000", "http://localhost:1234/v1/chat/completions") into its
 * API base URL. Nothing is looked up or reached.
 */
export function readServerAddress(input: unknown): ReadAddress {
  const url = parsedUrl(input);
  if (typeof url === "string") return refused(url);
  const hostname = ANY_HOST[url.hostname] ?? url.hostname;
  const port = url.port ? `:${url.port}` : "";
  return {
    ok: true,
    baseUrl: `${url.protocol}//${hostname}${port}${apiPath(url.pathname)}`,
    host: hostname.replace(/^\[|\]$/g, ""),
  };
}

/** The system resolver, every address of the name, given up on after a few seconds. */
const systemLookup: HostLookup = async (host) => {
  const timeout = new AbortController();
  try {
    return await Promise.race([
      dnsLookup(host, { all: true, verbatim: true }),
      sleep(LOOKUP_TIMEOUT_MS, undefined, { signal: timeout.signal }).then(() => {
        throw new Error(`lookup of ${host} timed out`);
      }),
    ]);
  } finally {
    timeout.abort();
  }
};

/**
 * Read a typed address and check it is local: a number by its range, a name by every address it
 * resolves to (one outside is enough to refuse it).
 */
export async function localServerAddress(input: unknown, lookup: HostLookup = systemLookup): Promise<LocalAddress> {
  const read = readServerAddress(input);
  if (!read.ok) return read;
  if (isIP(read.host) !== 0)
    return isLocalIp(read.host) ? { ok: true, baseUrl: read.baseUrl } : refused(AddressProblem.NotLocal);
  let resolved: ResolvedAddress[];
  try {
    resolved = await lookup(read.host);
  } catch {
    return refused(AddressProblem.NotFound);
  }
  if (resolved.length === 0) return refused(AddressProblem.NotFound);
  return resolved.every(({ address }) => isLocalIp(address))
    ? { ok: true, baseUrl: read.baseUrl }
    : refused(AddressProblem.NotLocal);
}
