/**
 * OpenRouter's browser sign-in: OAuth with PKCE, as OpenRouter offers it to apps. Connect opens
 * OpenRouter's authorization page in the person's browser; when they approve Genex there,
 * OpenRouter sends the browser back to a one-time callback on this Mac's loopback interface with
 * a code, which is redeemed exactly once (with the verifier only this process holds) for an API
 * key. The key goes straight to the engine's `saveKey`, which checks it with OpenRouter and keeps
 * it in the OS secret store; it is never logged, shown in the browser or sent to the renderer.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { MINUTE_MS, SECOND_MS } from "../shared/duration.ts";
import { type EngineStatus, EngineStatusCode } from "../shared/engine-descriptor.ts";
import { OpenRouterSignInOutcome, type OpenRouterSignInResult } from "../shared/openrouter-login.ts";
import { OPENROUTER_API } from "../substrate/engines/openrouter.ts";

/** OpenRouter's authorization page. */
export const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
/** Where a code is redeemed for a key. */
const OPENROUTER_EXCHANGE_URL = `${OPENROUTER_API}/auth/keys`;
/** OpenRouter's codes live ten minutes; a sign-in waits as long for the browser to come back. */
const SIGN_IN_TIMEOUT_MS = 10 * MINUTE_MS;
/** One code exchange with OpenRouter. */
const EXCHANGE_TIMEOUT_MS = 30 * SECOND_MS;
/** The callback's path; OpenRouter accepts a `localhost` callback on any port. */
const CALLBACK_PATH = "/openrouter/callback";
/** Random bytes behind the PKCE verifier and the `state` parameter. */
const VERIFIER_BYTES = 32;
const STATE_BYTES = 32;
/** How many ports to try before giving up on one free on both loopback addresses. */
const LISTEN_TRIES = 3;
/** The name the key gets in the person's OpenRouter key list (they may change it there). */
const KEY_LABEL = "Genex";

/** What the person reads, in the app and on the page the browser lands on. */
const MESSAGE = {
  denied: "OpenRouter didn't connect Genex. Connect again, or paste a key instead.",
  noKey: "OpenRouter didn't give Genex a key. Connect again.",
  unreachable: "OpenRouter couldn't be reached. Check your connection and connect again.",
  expired: "The sign-in took too long. Connect again.",
  noBrowser: "Couldn't open your browser. Paste a key instead.",
  noCallback: "Couldn't start the sign-in on this Mac. Paste a key instead.",
  connectedTitle: "Genex is connected to OpenRouter",
  connectedLine: "You can close this tab and go back to Genex.",
  failedTitle: "OpenRouter didn't connect",
  failedLine: (reason: string) => `${reason} Go back to Genex to try again.`,
  notThisSignIn: "This page isn't from the sign-in Genex started.",
  alreadyAnswered: "This sign-in is already finishing in Genex.",
} as const;

/** What the sign-in needs from the app around it. */
export interface OpenRouterLoginDeps {
  /** Open a page in the person's browser. */
  openExternal(url: string): Promise<unknown>;
  /** The browser came back with an answer: bring the app forward. */
  onReturn?(): void;
  /** Test seams: OpenRouter's code exchange, its addresses and how long a sign-in waits. */
  fetch?: typeof fetch;
  authUrl?: string;
  exchangeUrl?: string;
  timeoutMs?: number;
}

/** One browser sign-in at a time: start it, open its page again, or stop it. */
export interface OpenRouterLogin {
  /** Open OpenRouter's page and settle when the person approved Genex (key saved), cancelled, or it failed. */
  start(saveKey: SaveKey): Promise<OpenRouterSignInResult>;
  /** Open the sign-in's page again; false when no sign-in is waiting for the browser. */
  reopen(): Promise<boolean>;
  /** Stop the sign-in under way; false when there is none. */
  cancel(): boolean;
}

/** Hands a key to the engine, which checks it with OpenRouter and keeps it when it is good. */
export type SaveKey = (key: string) => Promise<EngineStatus>;

/** One sign-in under way. */
interface Pending {
  state: string;
  verifier: string;
  authUrl: string;
  servers: Server[];
  timer: ReturnType<typeof setTimeout>;
  abort: AbortController;
  /** The browser came back with this sign-in's answer; any later return is refused. */
  answered: boolean;
  settle(result: OpenRouterSignInResult): void;
}

const failed = (error: string): OpenRouterSignInResult => ({ outcome: OpenRouterSignInOutcome.Failed, error });

/** The S256 challenge of a PKCE verifier. */
const challengeOf = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

/** A random PKCE verifier, in URL-safe base64. */
const newVerifier = (): string => randomBytes(VERIFIER_BYTES).toString("base64url");

/** Does the callback carry this sign-in's own `state`? Compared in constant time. */
function stateMatches(url: URL, expected: string): boolean {
  const supplied = Buffer.from(url.searchParams.get("state") ?? "");
  const own = Buffer.from(expected);
  return supplied.length === own.length && timingSafeEqual(supplied, own);
}

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The small page the browser lands on: no scripts, nothing loaded from anywhere. */
function page(response: ServerResponse, status: number, title: string, line: string): void {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-content:center;gap:8px;text-align:center;font:15px/22px -apple-system,system-ui,sans-serif;background:#fafafa;color:#0c0c0c}h1{margin:0;font-size:22px;font-weight:500}p{margin:0;color:#707172}@media (prefers-color-scheme:dark){body{background:#0e0d0f;color:#eeeef0}p{color:#a8a9ac}}</style>
</head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(line)}</p></body></html>`;
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
    "Referrer-Policy": "no-referrer",
    Connection: "close",
  });
  response.end(body);
}

/** Start `server` on one loopback address and port (0: any free port). */
function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const failedToListen = (error: Error) => {
      server.off("listening", ready);
      reject(error);
    };
    const ready = () => {
      server.off("error", failedToListen);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", failedToListen);
    server.once("listening", ready);
    server.listen(port, host);
  });
}

/** Stop taking callbacks; a page being written still finishes, as every answer closes its connection. */
const closeAll = (servers: Server[]) => {
  for (const server of servers) server.close();
};

/**
 * The callback's servers: a free port on 127.0.0.1 and the same port on ::1, because a browser
 * may reach `localhost` over either. When another program already holds that port on ::1 the
 * whole pair moves to a new port; a Mac without IPv6 keeps the 127.0.0.1 one alone.
 */
async function listenOnLoopback(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  for (let tries = 0; tries < LISTEN_TRIES; tries++) {
    const v4 = createServer(handler);
    const port = await listen(v4, 0, "127.0.0.1");
    const v6 = createServer(handler);
    try {
      await listen(v6, port, "::1");
      return { port, servers: [v4, v6] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") return { port, servers: [v4] };
      closeAll([v4]);
    }
  }
  throw new Error(MESSAGE.noCallback);
}

/** Where codes are redeemed, and how. */
interface Exchange {
  fetchImpl: typeof fetch;
  url: string;
}

/** Redeem the code for a key, once, with this sign-in's verifier. */
async function redeem(exchange: Exchange, sign: Pending, code: string): Promise<string> {
  let response: Response;
  try {
    response = await exchange.fetchImpl(exchange.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: sign.verifier, code_challenge_method: "S256" }),
      signal: AbortSignal.any([sign.abort.signal, AbortSignal.timeout(EXCHANGE_TIMEOUT_MS)]),
    });
  } catch {
    throw new Error(MESSAGE.unreachable);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(MESSAGE.noKey);
  }
  const body = (await response.json().catch(() => null)) as { key?: unknown } | null;
  if (typeof body?.key !== "string" || !body.key) throw new Error(MESSAGE.noKey);
  return body.key;
}

/** The code the browser brought back: a saved key, or why there is none. */
async function connectWithCode(
  exchange: Exchange,
  sign: Pending,
  code: string,
  saveKey: SaveKey,
): Promise<OpenRouterSignInResult> {
  try {
    const status = await saveKey(await redeem(exchange, sign, code));
    if (status.code === EngineStatusCode.Ready) return { outcome: OpenRouterSignInOutcome.Connected };
    return failed(status.detail);
  } catch (error) {
    return failed(error instanceof Error ? error.message : MESSAGE.noKey);
  }
}

/** What answering one sign-in's callback needs. */
interface Answering {
  exchange: Exchange;
  saveKey: SaveKey;
  onReturn?: () => void;
  finish: (sign: Pending, result: OpenRouterSignInResult) => void;
}

/** The browser's return: only this sign-in's, only once, only on the callback's path. */
async function answerCallback(
  request: IncomingMessage,
  response: ServerResponse,
  sign: Pending,
  answering: Answering,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method !== "GET" || url.pathname !== CALLBACK_PATH) {
    response.writeHead(404, { Connection: "close" }).end();
    return;
  }
  const code = url.searchParams.get("code");
  // OpenRouter returns no state when the person declines; an answer without a code ends only this sign-in.
  const declined = !code && url.searchParams.has("error") && !url.searchParams.has("state");
  if (!declined && !stateMatches(url, sign.state)) {
    page(response, 400, MESSAGE.failedTitle, MESSAGE.notThisSignIn);
    return;
  }
  if (sign.answered) {
    page(response, 409, MESSAGE.failedTitle, MESSAGE.alreadyAnswered);
    return;
  }
  sign.answered = true;
  answering.onReturn?.();
  const result = code
    ? await connectWithCode(answering.exchange, sign, code, answering.saveKey)
    : failed(MESSAGE.denied);
  if (result.outcome === OpenRouterSignInOutcome.Failed)
    page(response, 200, MESSAGE.failedTitle, MESSAGE.failedLine(result.error));
  else page(response, 200, MESSAGE.connectedTitle, MESSAGE.connectedLine);
  answering.finish(sign, result);
}

/** OpenRouter's authorization page for one sign-in, returning to the callback on `port`. */
function authorizationUrl(base: string, port: number, challenge: string, state: string): string {
  const auth = new URL(base);
  auth.search = new URLSearchParams({
    callback_url: `http://localhost:${port}${CALLBACK_PATH}`,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    key_label: KEY_LABEL,
  }).toString();
  return auth.href;
}

/** A sign-in not yet listening: its secrets, its deadline, and the promise its end settles. */
function newSignIn(
  timeoutMs: number,
  expire: (sign: Pending) => void,
): { sign: Pending; ended: Promise<OpenRouterSignInResult> } {
  let settle: (result: OpenRouterSignInResult) => void = () => {};
  const ended = new Promise<OpenRouterSignInResult>((resolve) => {
    settle = resolve;
  });
  const sign: Pending = {
    state: randomBytes(STATE_BYTES).toString("hex"),
    verifier: newVerifier(),
    authUrl: "",
    servers: [],
    timer: setTimeout(() => expire(sign), timeoutMs),
    abort: new AbortController(),
    answered: false,
    settle,
  };
  sign.timer.unref();
  return { sign, ended };
}

/** Create the one OpenRouter browser sign-in main keeps. */
export function createOpenRouterLogin(deps: OpenRouterLoginDeps): OpenRouterLogin {
  const exchange: Exchange = { fetchImpl: deps.fetch ?? fetch, url: deps.exchangeUrl ?? OPENROUTER_EXCHANGE_URL };
  const authBase = deps.authUrl ?? OPENROUTER_AUTH_URL;
  let pending: Pending | null = null;

  const finish = (sign: Pending, result: OpenRouterSignInResult) => {
    if (pending === sign) pending = null;
    clearTimeout(sign.timer);
    sign.abort.abort();
    closeAll(sign.servers);
    sign.settle(result);
  };

  return {
    async start(saveKey) {
      if (pending) finish(pending, { outcome: OpenRouterSignInOutcome.Cancelled });
      const { sign, ended } = newSignIn(deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS, (late) =>
        finish(late, failed(MESSAGE.expired)),
      );
      pending = sign;
      const answering: Answering = { exchange, saveKey, onReturn: deps.onReturn, finish };
      try {
        const loopback = await listenOnLoopback((request, response) => {
          void answerCallback(request, response, sign, answering);
        });
        sign.servers = loopback.servers;
        for (const server of sign.servers) server.unref();
        // Replaced or cancelled while the ports opened: nothing is left to wait for.
        if (pending !== sign) closeAll(sign.servers);
        sign.authUrl = authorizationUrl(authBase, loopback.port, challengeOf(sign.verifier), sign.state);
      } catch {
        finish(sign, failed(MESSAGE.noCallback));
        return ended;
      }
      if (pending === sign) await deps.openExternal(sign.authUrl).catch(() => finish(sign, failed(MESSAGE.noBrowser)));
      return ended;
    },
    async reopen() {
      const sign = pending;
      if (!sign?.authUrl || sign.answered) return false;
      await deps.openExternal(sign.authUrl);
      return true;
    },
    cancel() {
      if (!pending) return false;
      finish(pending, { outcome: OpenRouterSignInOutcome.Cancelled });
      return true;
    },
  };
}
