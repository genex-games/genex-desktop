/**
 * The relay building with Genex runs Claude Code through. Claude Code is pointed at this server
 * on 127.0.0.1 (`ANTHROPIC_BASE_URL`) with a key that works for one session only (a lease). The
 * relay takes the key off, puts the person's Genex sign-in on, names the model and the chat, and
 * sends the call to genex.games, which runs it and bills the person's credits. So the session
 * never holds anything that can spend money once it ends, and the person's Genex token never
 * enters an agent's environment.
 *
 * Only the two Messages routes pass, and only with a live lease's key: anything else is refused
 * here and reaches nobody. genex.games's refusals carry `reason`, which the relay hands on
 * (`onRefusal`) so the app can show the right line. Electron-free.
 */
import { randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GenexAccess, GenexBuildRoute, isGenexAccess } from "../../shared/genex-build.ts";

const LOOPBACK = "127.0.0.1";
/** The most of a request the relay reads; genex.games refuses more than this anyway. */
export const RELAY_MAX_REQUEST_BYTES = 24 * 1024 * 1024;
/** The most of a refusal read to find its `reason`; anything longer is passed on unread. */
const REFUSAL_MAX_BYTES = 64 * 1024;
/** Random bytes in a lease's key. */
const KEY_BYTES = 32;
/** The chat id genex.games keeps one conversation per; anything else reads as its default. */
const CHAT_ID = /^[A-Za-z0-9_-]{1,80}$/;
const BEARER = /^Bearer\s+(.+)$/i;

/** The local routes and the genex.games route each one goes to. Nothing else passes. */
const ROUTES: Readonly<Record<string, string>> = {
  "/v1/messages": GenexBuildRoute.Messages,
  "/v1/messages/count_tokens": GenexBuildRoute.CountTokens,
};

/** The request headers passed on: what Claude Code says about the call itself. */
const PASSED_HEADERS = ["anthropic-version", "anthropic-beta", "accept"] as const;
/** The answer headers passed back. */
const RETURNED_HEADERS = ["content-type", "request-id", "retry-after", "x-should-retry"] as const;

const MESSAGE = {
  NoRoute: "Not found.",
  NoKey: "This key is not valid.",
  TooLarge: "Request too large.",
  NotJson: "The request body is not JSON.",
  SignIn: "Sign in to Genex in the app to build with credits.",
  Unreachable: "Genex didn't answer.",
} as const;

/** What a lease names: the chat genex.games keeps the session's calls under. */
export interface GenexLeaseRequest {
  chat: string;
}

/** One session's way to the relay: the variables Claude Code is started with, and the end of the lease. */
export interface GenexLease {
  readonly env: Record<string, string>;
  /** Why genex.games last refused one of this session's calls, if it did. */
  refusal(): GenexAccess | undefined;
  close(): void;
}

export interface GenexRelayDeps {
  /** genex.games's API origin. */
  api: string;
  /** The person's Genex token while signed in. */
  token(): Promise<string | undefined>;
  /** The model ids genex.games offers now; the first is the default and every helper's. */
  models(): readonly string[];
  /** genex.games refused a call (or the relay did, signed out): why, and the token it refused. */
  onRefusal?(reason: GenexAccess, token: string | undefined): void;
  fetch?: typeof fetch;
}

interface Lease {
  chat: string;
  refused?: GenexAccess;
}

/** An Anthropic-shaped error body, which Claude Code reads and stops on. */
function anthropicError(type: string, message: string, reason?: GenexAccess): string {
  return JSON.stringify({ type: "error", error: { type, message }, ...(reason ? { reason } : {}) });
}

function answer(res: ServerResponse, status: number, body: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

/** The key a request carries: `x-api-key`, or a bearer. */
function keyOf(req: IncomingMessage): string | undefined {
  const header = req.headers["x-api-key"];
  if (typeof header === "string" && header) return header;
  const bearer = BEARER.exec(req.headers.authorization ?? "");
  return bearer?.[1]?.trim() || undefined;
}

/** The request body, or null past the cap. */
async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > RELAY_MAX_REQUEST_BYTES) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > RELAY_MAX_REQUEST_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** The model a call names, when the body is a JSON object; undefined for one it cannot read. */
function modelNamed(body: Buffer): { model: unknown } | undefined {
  try {
    const parsed: unknown = JSON.parse(body.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { model: (parsed as { model?: unknown }).model }
      : undefined;
  } catch {
    return undefined;
  }
}

/** The `reason` of a genex.games refusal, when it names one. */
function reasonOf(body: Buffer): GenexAccess | undefined {
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { reason?: unknown };
    return isGenexAccess(parsed?.reason) ? parsed.reason : undefined;
  } catch {
    return undefined;
  }
}

/** The local path and query of a request, or null for one that names no plain path. */
function pathOf(url: string | undefined): { path: string; search: string } | null {
  if (!url?.startsWith("/") || url.startsWith("//")) return null;
  const parsed = new URL(url, `http://${LOOPBACK}`);
  return { path: parsed.pathname, search: parsed.search };
}

/** The headers genex.games is sent: the person's sign-in, the model and chat, and Claude Code's own. */
function upstreamHeaders(req: IncomingMessage, token: string, model: string, chat: string): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    "x-genex-model": model,
    "x-genex-chat": chat,
  };
  for (const name of PASSED_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  return headers;
}

/** The headers of genex.games's answer that are passed back. */
function returnedHeaders(upstream: Response): Record<string, string> {
  const returned: Record<string, string> = {};
  for (const name of RETURNED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) returned[name] = value;
  }
  return returned;
}

/** One call on its way: the request, its answer, the route it goes to and the lease it came with. */
interface RelayCall {
  req: IncomingMessage;
  res: ServerResponse;
  route: string;
  lease: Lease;
}

/** genex.games's refusal passed back as it came, its reason kept on the lease and handed on. */
async function passRefusal(call: RelayCall, upstream: Response, token: string, deps: GenexRelayDeps): Promise<void> {
  const text = Buffer.from(await upstream.arrayBuffer().catch(() => new ArrayBuffer(0)));
  const reason = text.length <= REFUSAL_MAX_BYTES ? reasonOf(text) : undefined;
  if (reason) {
    call.lease.refused = reason;
    deps.onRefusal?.(reason, token);
  }
  call.res.writeHead(upstream.status, returnedHeaders(upstream));
  call.res.end(text);
}

/** Send a call on to genex.games and stream its answer back; a closed session stops the call. */
async function forward(call: RelayCall, deps: GenexRelayDeps, doFetch: typeof fetch): Promise<void> {
  const { req, res, lease } = call;
  const body = await readBody(req);
  if (!body) return answer(res, 413, anthropicError("request_too_large", MESSAGE.TooLarge));
  const named = modelNamed(body);
  if (!named) return answer(res, 400, anthropicError("invalid_request_error", MESSAGE.NotJson));
  const token = await deps.token();
  if (!token) {
    lease.refused = GenexAccess.SignIn;
    deps.onRefusal?.(GenexAccess.SignIn, undefined);
    return answer(res, 401, anthropicError("authentication_error", MESSAGE.SignIn, GenexAccess.SignIn));
  }
  const offered = deps.models();
  // Claude Code's helpers name its own aliases; every name genex.games does not offer runs on the default.
  const model = offered.find((id) => id === named.model) ?? offered[0] ?? "";
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  let upstream: Response;
  try {
    upstream = await doFetch(new URL(call.route, deps.api), {
      method: "POST",
      headers: upstreamHeaders(req, token, model, lease.chat),
      body: new Uint8Array(body),
      signal: controller.signal,
    });
  } catch {
    return answer(res, 502, anthropicError("api_error", MESSAGE.Unreachable));
  }
  if (!upstream.ok) return passRefusal(call, upstream, token, deps);
  res.writeHead(upstream.status, returnedHeaders(upstream));
  if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as never), res).catch(() => controller.abort());
  else res.end();
}

/** The relay over `deps`, started on the first lease. */
export function createGenexRelay(deps: GenexRelayDeps) {
  const leases = new Map<string, Lease>();
  const doFetch = deps.fetch ?? fetch;
  let server: http.Server | null = null;
  let listening: Promise<number> | null = null;

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const target = pathOf(req.url);
    const route = target && req.method === "POST" && Object.hasOwn(ROUTES, target.path) ? ROUTES[target.path] : null;
    if (!target || !route) {
      answer(res, 404, anthropicError("not_found_error", MESSAGE.NoRoute));
      return;
    }
    const key = keyOf(req);
    const lease = key ? leases.get(key) : undefined;
    if (!lease) {
      answer(res, 401, anthropicError("authentication_error", MESSAGE.NoKey));
      return;
    }
    forward({ req, res, route: `${route}${target.search}`, lease }, deps, doFetch).catch(() => {
      answer(res, 502, anthropicError("api_error", MESSAGE.Unreachable));
    });
  };

  const port = (): Promise<number> => {
    listening ??= new Promise<number>((resolve, reject) => {
      const made = http.createServer(handle);
      made.once("error", (error) => {
        listening = null;
        reject(error);
      });
      made.listen(0, LOOPBACK, () => {
        server = made;
        resolve((made.address() as AddressInfo).port);
      });
    });
    return listening;
  };

  return {
    /** A key for one session, and the variables that point its Claude Code here. */
    async open(request: GenexLeaseRequest): Promise<GenexLease> {
      const at = await port();
      const key = randomBytes(KEY_BYTES).toString("hex");
      const lease: Lease = { chat: CHAT_ID.test(request.chat) ? request.chat : "default" };
      leases.set(key, lease);
      return {
        env: leaseEnv(at, key, deps.models()[0] ?? ""),
        refusal: () => lease.refused,
        close: () => {
          leases.delete(key);
        },
      };
    },
    /** Stop serving: every lease ends with it. */
    async close(): Promise<void> {
      leases.clear();
      const running = server;
      server = null;
      listening = null;
      if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
    },
  };
}

/** The variables a session's Claude Code is started with: the relay's address and the lease's key. */
function leaseEnv(port: number, key: string, helper: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: `http://${LOOPBACK}:${port}`,
    ANTHROPIC_AUTH_TOKEN: key,
    // Claude Code's own aliases (a helper, a subagent asked for by family) run on the default.
    ANTHROPIC_DEFAULT_HAIKU_MODEL: helper,
    ANTHROPIC_DEFAULT_SONNET_MODEL: helper,
    ANTHROPIC_DEFAULT_OPUS_MODEL: helper,
    ANTHROPIC_SMALL_FAST_MODEL: helper,
    CLAUDE_CODE_SUBAGENT_MODEL: helper,
    // No telemetry, error reports or update checks: the session talks to the relay only.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

/** The relay as `createGenexRelay` makes it. */
export type GenexRelay = ReturnType<typeof createGenexRelay>;
