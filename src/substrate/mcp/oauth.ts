/**
 * Host-owned OAuth session. Only explicit UI Connect may unlock storage or open a browser.
 * Disconnect (and removing the connector) is the other explicit act: it forgets the account here
 * and then asks the authorization server to revoke its tokens (RFC 7009) when it offers that.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { validUrl, type SecretPort } from "./store.ts";
import { redactValues } from "../../shared/redact.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { t } from "../../shared/i18n.ts";

/** Where a connector's browser sign-in stands (`McpConnectorView.authentication.state`). */
export const McpAuthState = {
  Locked: "locked",
  SignedOut: "signed-out",
  Authorizing: "authorizing",
  Connected: "connected",
  Failed: "failed",
} as const;
export type McpAuthState = (typeof McpAuthState)[keyof typeof McpAuthState];
interface Saved {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  redirect?: string;
}
/** A revocation is a courtesy to the server, never a wait on the user: this is all it gets. */
const REVOKE_TIMEOUT_MS = 10 * SECOND_MS;
/** How long a started browser sign-in may take before it is abandoned. */
const SIGN_IN_TIMEOUT_MS = 5 * MINUTE_MS;
/** One request to the authorization server. */
const OAUTH_REQUEST_TIMEOUT_MS = 30 * SECOND_MS;
/** The loopback redirect the browser returns to: `http://127.0.0.1:<port>/mcp/callback`. */
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/mcp/callback";
/** Random bytes behind one sign-in's `state` parameter. */
const STATE_BYTES = 32;
/** The callback page's type: its words are in the person's language, so the browser is told they are UTF-8. */
const PLAIN_TEXT = "text/plain; charset=utf-8";

/**
 * What a sign-in says. The words that are functions are the person's, in their language: the
 * connector card's sign-in line, the page the browser returns to, and a refusal of their own
 * Connect. The plain strings stay English: the connector's transport meets them on every
 * connection, a tool call the agent made included, and the model reads that error.
 */
const MESSAGE = {
  Cancelled: "Connection cancelled",
  NoCallback: () => t("Could not open the local sign-in callback"),
  SignInExpired: () => t("Sign-in expired. Connect again to retry."),
  SignInFailed: () => t("Sign-in could not be completed. Connect again to retry."),
  InvalidState: () => t("Invalid authorization state."),
  NotCompleted: () => t("Sign-in was not completed. Return to Studio."),
  ReturnToStudio: () => t("Return to Studio to see connection status."),
  UnlockFailed: () => t("Could not unlock the saved connection. Retry Connect."),
  SaveFailed: () => t("Could not save the connection. Connect again to retry."),
  ConnectFirst: "Connect this account in Studio first",
  SignInRequired: "Sign-in required. Press Connect in Studio.",
  InsecureBrowserUrl: "The authorization server did not provide a secure browser URL",
  NoSecureStorage: () => t("OAuth requires protected credential storage, which is unavailable in this profile."),
  InvalidSavedAccount: "Invalid saved OAuth account",
  InvalidSavedCallback: "Invalid saved OAuth callback",
  StorageUnavailable: "Protected credential storage is unavailable",
  AuthorizationIncomplete: "Authorization did not complete",
  VerifierExpired: "Sign-in expired",
} as const;

type OpenBrowser = (url: string) => Promise<void>;

/** Start `server` listening on the loopback host at `port` (0: any free port). */
function listenOnce(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const error = (e: Error) => {
      server.off("listening", ready);
      reject(e);
    };
    const ready = () => {
      server.off("error", error);
      resolve();
    };
    server.once("error", error);
    server.once("listening", ready);
    server.listen(port, CALLBACK_HOST);
  });
}

/** A saved redirect is exactly Studio's loopback callback: http, 127.0.0.1, a port, the path, nothing else. */
function isLoopbackCallback(redirect: URL): boolean {
  const exact =
    redirect.protocol === "http:" && redirect.hostname === CALLBACK_HOST && redirect.pathname === CALLBACK_PATH;
  const extras = Boolean(redirect.username || redirect.password || redirect.search || redirect.hash);
  return exact && Boolean(redirect.port) && !extras;
}

/** The SDK's OAuth record schemas, loaded on first use (main's startup does not wait for them). */
const oauthSchemas = () => import("@modelcontextprotocol/sdk/shared/auth.js");

/** The saved account record, checked field by field; an unexpected shape is refused. */
async function parseSaved(raw: string | null): Promise<Saved> {
  const value = raw ? JSON.parse(raw) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(MESSAGE.InvalidSavedAccount);
  const { OAuthTokensSchema, OAuthClientInformationFullSchema, OAuthClientInformationSchema } = await oauthSchemas();
  const parsed: Saved = {};
  if (value.tokens) parsed.tokens = OAuthTokensSchema.parse(value.tokens);
  if (value.client)
    parsed.client = (
      value.client.redirect_uris ? OAuthClientInformationFullSchema : OAuthClientInformationSchema
    ).parse(value.client);
  if (value.redirect) {
    const redirect = new URL(value.redirect);
    if (!isLoopbackCallback(redirect)) throw new Error(MESSAGE.InvalidSavedCallback);
    parsed.redirect = redirect.href;
  }
  return parsed;
}
export class McpOAuthAccount {
  #saved: Saved = {};
  #redactionValues = new Set<string>();
  #rememberSecrets() {
    for (const value of [
      this.#saved.tokens?.access_token,
      this.#saved.tokens?.refresh_token,
      this.#saved.client?.client_secret,
      this.#verifier,
    ])
      if (value) this.#redactionValues.add(String(value));
  }
  #unlocked = false;
  #server?: Server;
  #timer?: ReturnType<typeof setTimeout>;
  #verifier?: string;
  #state = "";
  #epoch = 0;
  #interactive = false;
  #openBrowser?: (url: string) => Promise<void>;
  #unlocking?: Promise<void>;
  #beginning?: Promise<OAuthClientProvider>;
  #io: Promise<unknown> = Promise.resolve();
  #abort = new AbortController();
  state: McpAuthState = McpAuthState.Locked;
  error?: string;
  readonly key: string;
  readonly id: string;
  readonly url: string;
  readonly store: SecretPort | null;
  readonly changed: () => void;
  readonly connected: () => Promise<void>;
  /** Injected in tests so no suite reaches a real authorization server. */
  readonly fetchImpl: typeof fetch;
  constructor(
    id: string,
    url: string,
    store: SecretPort | null,
    changed: () => void,
    connected: () => Promise<void>,
    fetchImpl?: typeof fetch,
  ) {
    this.id = id;
    this.url = url;
    this.store = store;
    this.changed = changed;
    this.connected = connected;
    this.fetchImpl = fetchImpl ?? fetch;
    this.key = `mcp.${id}.oauth.${createHash("sha256").update(url).digest("hex").slice(0, 16)}`;
  }
  #set(state: McpAuthState, error?: string) {
    this.state = state;
    this.error = error;
    this.changed();
  }
  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#io.then(fn, fn);
    this.#io = next.catch(() => {});
    return next;
  }
  async unlock(): Promise<void> {
    if (this.#unlocked) return;
    if (this.#unlocking) return this.#unlocking;
    if (!this.store) throw new Error(MESSAGE.NoSecureStorage());
    const epoch = this.#epoch;
    const store = this.store;
    const pending = this.#serialize(async () => {
      const raw = await store.get(this.key);
      if (epoch !== this.#epoch) throw new Error(MESSAGE.Cancelled);
      const parsed = await parseSaved(raw);
      this.#saved = parsed;
      this.#unlocked = true;
      this.#rememberSecrets();
      this.#set(parsed.tokens ? McpAuthState.Connected : McpAuthState.SignedOut);
    })
      .catch((error) => {
        if (epoch === this.#epoch) this.#set(McpAuthState.Failed, MESSAGE.UnlockFailed());
        throw error;
      })
      .finally(() => {
        if (this.#unlocking === pending) this.#unlocking = undefined;
      });
    this.#unlocking = pending;
    return pending;
  }
  async #persist(epoch: number): Promise<void> {
    const data = JSON.stringify(this.#saved);
    await this.#serialize(async () => {
      if (epoch !== this.#epoch || !this.#unlocked) throw new Error(MESSAGE.Cancelled);
      if (!this.store) throw new Error(MESSAGE.StorageUnavailable);
      await this.store.set(this.key, data);
    });
  }
  /** Called only by Studio's trusted Connect action. Repeated clicks share the pending flow. */
  async begin(openBrowser: (url: string) => Promise<void>): Promise<OAuthClientProvider> {
    if (this.#beginning) return this.#beginning;
    const pending = this.#begin(openBrowser).finally(() => {
      if (this.#beginning === pending) this.#beginning = undefined;
    });
    this.#beginning = pending;
    return pending;
  }
  async #begin(openBrowser: (url: string) => Promise<void>): Promise<OAuthClientProvider> {
    const startingEpoch = this.#epoch;
    await this.unlock();
    if (startingEpoch !== this.#epoch) throw new Error(MESSAGE.Cancelled);
    if (this.#server) return this.provider(openBrowser);
    this.#interactive = true;
    this.#openBrowser = openBrowser;
    this.#abort = new AbortController();
    this.#state = randomBytes(STATE_BYTES).toString("hex");
    const epoch = this.#epoch;
    const server = createServer((request, response) => this.#onCallback(request, response, openBrowser, epoch));
    this.#server = server;
    await this.#listenForCallback(server, epoch);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error(MESSAGE.NoCallback());
    const redirect = `http://${CALLBACK_HOST}:${address.port}${CALLBACK_PATH}`;
    if (this.#saved.redirect && this.#saved.redirect !== redirect) delete this.#saved.client;
    this.#saved.redirect = redirect;
    this.#timer = setTimeout(() => {
      this.cancel();
      this.#set(McpAuthState.Failed, MESSAGE.SignInExpired());
    }, SIGN_IN_TIMEOUT_MS);
    this.#timer.unref();
    server.unref();
    return this.provider(openBrowser);
  }
  /** Whether the callback carries this sign-in's own state, compared in constant time. */
  #stateMatches(url: URL): boolean {
    const supplied = Buffer.from(url.searchParams.get("state") ?? "");
    const expected = Buffer.from(this.#state);
    return supplied.length > 0 && supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }
  /** The browser's return to the loopback callback: check it, then redeem its code exactly once. */
  #onCallback(request: IncomingMessage, response: ServerResponse, openBrowser: OpenBrowser, epoch: number): void {
    const url = new URL(request.url ?? "/", this.#saved.redirect ?? `http://${CALLBACK_HOST}`);
    if (request.method !== "GET" || url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end();
      return;
    }
    if (!this.#stateMatches(url)) {
      response.writeHead(400, { "Content-Type": PLAIN_TEXT }).end(MESSAGE.InvalidState());
      return;
    }
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.has("error")) {
      response.writeHead(200, { "Content-Type": PLAIN_TEXT }).end(MESSAGE.NotCompleted());
      this.cancel();
      this.#set(McpAuthState.SignedOut);
      return;
    }
    // Consume the callback before exchanging: duplicate browser requests cannot redeem it twice.
    this.#state = "";
    response.writeHead(200, { "Content-Type": PLAIN_TEXT, "Cache-Control": "no-store" }).end(MESSAGE.ReturnToStudio());
    void this.#redeem(code, openBrowser, epoch);
  }
  /** Exchange the authorization code for tokens; a cancelled sign-in's late answer changes nothing. */
  async #redeem(code: string, openBrowser: OpenBrowser, epoch: number): Promise<void> {
    try {
      const { auth } = await import("@modelcontextprotocol/sdk/client/auth.js");
      const result = await auth(this.provider(openBrowser), {
        serverUrl: this.url,
        authorizationCode: code,
        fetchFn: this.#fetch,
      });
      if (epoch !== this.#epoch) return;
      if (result !== "AUTHORIZED") throw new Error(MESSAGE.AuthorizationIncomplete);
      this.#finish();
      this.#set(McpAuthState.Connected);
      await this.connected();
    } catch {
      if (epoch !== this.#epoch) return;
      this.#finish();
      this.#set(McpAuthState.Failed, MESSAGE.SignInFailed());
    }
  }
  /** Reuse a registered loopback port when possible; otherwise register the new redirect URI. */
  async #listenForCallback(server: Server, epoch: number): Promise<void> {
    const previous = this.#saved.redirect ? Number(new URL(this.#saved.redirect).port) : 0;
    try {
      await listenOnce(server, previous);
    } catch (error) {
      if (!previous) {
        this.#finish();
        throw error;
      }
      await listenOnce(server, 0);
    }
    if (epoch !== this.#epoch) {
      this.#finish();
      throw new Error(MESSAGE.Cancelled);
    }
  }
  #fetch: typeof fetch = (input, init) =>
    this.fetchImpl(input, {
      ...init,
      signal: AbortSignal.any([
        this.#abort.signal,
        AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
        ...(init?.signal ? [init.signal] : []),
      ]),
    });
  provider(openBrowserArg?: (url: string) => Promise<void>): OAuthClientProvider {
    const openBrowser = openBrowserArg ?? this.#openBrowser;
    const epoch = this.#epoch;
    const active = () => {
      if (epoch !== this.#epoch || !this.#unlocked) throw new Error(MESSAGE.ConnectFirst);
    };
    return {
      redirectUrl: this.#saved.redirect,
      clientMetadata: {
        client_name: "Genex",
        redirect_uris: this.#saved.redirect ? [this.#saved.redirect] : [],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      state: () => this.#state,
      clientInformation: () => {
        active();
        return this.#saved.client;
      },
      saveClientInformation: async (value) => {
        active();
        this.#saved.client = value;
        this.#rememberSecrets();
        await this.#persist(epoch);
      },
      tokens: () => {
        active();
        return this.#saved.tokens;
      },
      saveTokens: async (tokens) => {
        active();
        this.#saved.tokens = (await oauthSchemas()).OAuthTokensSchema.parse(tokens);
        this.#rememberSecrets();
        try {
          await this.#persist(epoch);
          active();
          this.#set(McpAuthState.Connected);
        } catch (error) {
          if (epoch === this.#epoch) {
            delete this.#saved.tokens;
            this.#set(McpAuthState.Failed, MESSAGE.SaveFailed());
          }
          throw error;
        }
      },
      redirectToAuthorization: async (url) => {
        active();
        if (!this.#interactive || !openBrowser || !this.#server) throw new Error(MESSAGE.SignInRequired);
        if (url.protocol !== "https:") throw new Error(MESSAGE.InsecureBrowserUrl);
        this.#set(McpAuthState.Authorizing);
        await openBrowser(url.href);
      },
      saveCodeVerifier: (value) => {
        active();
        this.#verifier = value;
        this.#rememberSecrets();
      },
      codeVerifier: () => {
        active();
        if (!this.#verifier) throw new Error(MESSAGE.VerifierExpired);
        return this.#verifier;
      },
      invalidateCredentials: async (scope) => {
        active();
        if (scope === "all" || scope === "client") delete this.#saved.client;
        if (scope === "all" || scope === "tokens") delete this.#saved.tokens;
        if (scope === "all" || scope === "verifier") this.#verifier = undefined;
        await this.#persist(epoch);
      },
    };
  }
  ready(): void {
    if (this.state !== McpAuthState.Authorizing) this.#finish();
  }
  #finish() {
    this.#interactive = false;
    this.#openBrowser = undefined;
    this.#verifier = undefined;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#server?.close();
    this.#server = undefined;
  }
  cancel(): void {
    this.#epoch++;
    this.#abort.abort();
    this.#finish();
    if (this.state === McpAuthState.Authorizing)
      this.#set(this.#saved.tokens ? McpAuthState.Connected : McpAuthState.SignedOut);
  }
  lock(): void {
    this.cancel();
    this.#saved = {};
    this.#redactionValues = new Set();
    this.#unlocked = false;
    this.#set(McpAuthState.Locked);
  }
  /**
   * Forget the account here, then revoke what it held. The local record goes first, so a server
   * that is slow or down never leaves a token on this Mac; revocation is best effort after it.
   */
  async disconnect(): Promise<void> {
    const saved = await this.#savedForRevocation();
    this.lock();
    await this.#serialize(async () => {
      await this.store?.delete(this.key);
    });
    this.#set(McpAuthState.SignedOut);
    if (saved.tokens)
      await this.#revoke(saved).catch(() => {
        /* the server keeps its copy until it expires */
      });
  }
  /** What is held in memory, or the stored record when this session never unlocked it. */
  async #savedForRevocation(): Promise<Saved> {
    if (this.#unlocked) return this.#saved;
    try {
      const value = JSON.parse((await this.store?.get(this.key)) ?? "{}");
      const { OAuthTokensSchema, OAuthClientInformationSchema } = await oauthSchemas();
      return {
        ...(value?.tokens ? { tokens: OAuthTokensSchema.parse(value.tokens) } : {}),
        ...(value?.client ? { client: OAuthClientInformationSchema.parse(value.client) } : {}),
      };
    } catch {
      return {};
    }
  }
  /** RFC 7009: the refresh token first (it outlives the access token), then the access token. */
  async #revoke(saved: Saved): Promise<void> {
    const signal = AbortSignal.timeout(REVOKE_TIMEOUT_MS);
    const fetchFn: typeof fetch = (input, init) => this.fetchImpl(input, { ...init, signal });
    const { discoverOAuthServerInfo } = await import("@modelcontextprotocol/sdk/client/auth.js");
    const metadata = (await discoverOAuthServerInfo(this.url, { fetchFn })).authorizationServerMetadata;
    // OpenID discovery documents do not declare the field; an OAuth server that revokes does.
    const endpoint =
      metadata && "revocation_endpoint" in metadata && typeof metadata.revocation_endpoint === "string"
        ? metadata.revocation_endpoint
        : undefined;
    if (!endpoint || !validUrl(endpoint)) return;
    const client = saved.client;
    for (const [token, hint] of [
      [saved.tokens?.refresh_token, "refresh_token"],
      [saved.tokens?.access_token, "access_token"],
    ] as const) {
      if (!token) continue;
      const body = new URLSearchParams({ token, token_type_hint: hint });
      if (client?.client_id) body.set("client_id", client.client_id);
      if (client?.client_secret) body.set("client_secret", client.client_secret);
      await fetchFn(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body.toString(),
      }).catch(() => undefined);
    }
  }
  /** Every token and client secret this account has held this session, for Studio's redactor. */
  secretValues(): string[] {
    return [...this.#redactionValues];
  }
  /** The transport retains only this log scrubber after revocation, never token access.
   * Late transport errors still redact secrets used before refresh, disconnect or removal. */
  redactor(): (text: string) => string {
    const values = this.#redactionValues;
    return (text) => redactValues(text, values);
  }
  redact(text: string): string {
    return this.redactor()(text);
  }
}
