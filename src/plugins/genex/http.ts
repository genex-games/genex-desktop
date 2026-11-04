/** Talking to Genex over HTTPS: the API call, the hosts Studio trusts and bounded downloads. */
import { SECOND_MS } from "../../shared/duration.ts";

/** One Genex API request, including reading its answer. */
export const API_REQUEST_TIMEOUT_MS = 20 * SECOND_MS;
/** The HTTP status Genex answers for an expired or revoked sign-in. */
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_FORBIDDEN = 403;
export const HTTP_NOT_FOUND = 404;
/** The longest refusal code kept from a failed answer's `error`. */
const ERROR_CODE_MAX_CHARS = 64;
/** A refusal code as Genex spells one: lowercase words joined by `_`. */
const ERROR_CODE = /^[a-z][a-z0-9_]*$/;

const DASHBOARD_HOSTS = new Set(["genex.games", "dev.genex.games"]);
const ASSET_HOSTS = new Set(["assets.genex.technology", "assets.genex.games"]);
/** Where a signed-in user accepts Genex's terms. */
export const ACCEPT_URL = "https://genex.games/accept";
/** The dashboard to link when Genex names none of its own. */
export const DEFAULT_DASHBOARD = "https://genex.games";
/** What a website page Studio opens in the browser carries: one constant campaign tag, never an id. */
const DESKTOP_TAG = { name: "s", value: "desktop" } as const;

/** A link Studio is willing to hand to the browser: Genex's own pages only. */
export const isGenexLink = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && (DASHBOARD_HOSTS.has(url.hostname) || url.hostname.endsWith(".genex.technology"))
    );
  } catch {
    return false;
  }
};

/** A page of Genex's website (the dashboard), over https. */
const isWebsitePage = (url: URL) => url.protocol === "https:" && DASHBOARD_HOSTS.has(url.hostname);

/** A sign-in page Genex's device flow may send the user to. */
export const isGenexAuthorizationUrl = (url: URL) => isWebsitePage(url);

/**
 * A link on its way to the browser, tagged `s=desktop` when it is a page of Genex's website, so
 * the site can tell the visit came from the app. An `s` the link already has stays; its path,
 * other parameters and hash are kept. Any other link, or one that does not parse, comes back as it came.
 */
export function tagGenexLink(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (!isWebsitePage(url) || url.searchParams.has(DESKTOP_TAG.name)) return value;
  // Appended to the query as written: rebuilding it through searchParams would re-encode the rest.
  const tag = `${DESKTOP_TAG.name}=${DESKTOP_TAG.value}`;
  url.search = url.search ? `${url.search}&${tag}` : tag;
  return url.href;
}

/**
 * An address the app may open in the person's browser for Genex (a sign-in to finish, the terms, a
 * game's page): https only, tagged as `tagGenexLink` tags it; anything else throws, so nothing opens.
 */
export function browserGenexLink(address: string): string {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error(`Not an address the browser may open for Genex: ${address}`);
  }
  if (url.protocol !== "https:") throw new Error(`Not an address the browser may open for Genex: ${address}`);
  return tagGenexLink(url.href);
}

/** A file Studio may download: https on one of Genex's asset hosts. */
export const isGenexAssetUrl = (url: URL) => url.protocol === "https:" && ASSET_HOSTS.has(url.hostname);

/** Where Genex's device sign-in stands, as its poll answers. Wire values: never rename one. */
export const DeviceStatus = { Approved: "approved", Denied: "denied", Expired: "expired" } as const;
export type DeviceStatus = (typeof DeviceStatus)[keyof typeof DeviceStatus];

/** Genex's device flow is never polled faster than this, whatever it asks. */
export const MIN_POLL_INTERVAL_S = 5;

/** The Genex API routes Studio calls. */
export const GenexRoute = {
  DeviceStart: "/api/cli/device/start",
  DevicePoll: "/api/cli/device/poll",
  LegalStatus: "/api/legal/status",
  Session: "/api/auth/get-session",
  Credits: "/api/credits/me",
  /** The public price list: the cheapest price of each kind of generation. */
  Prices: "/api/credits/prices",
  Lanes: "/api/generations/lanes",
  /** A game's own record on Genex: `PATCH { title }` renames it, moving no link. */
  project: (id: string) => `/api/projects/${encodeURIComponent(id)}`,
  /** Move a game to a new link (`POST { name }`): its old link keeps opening it. */
  rename: (id: string) => `/api/projects/${encodeURIComponent(id)}/rename`,
  projectBySlug: (slug: string) => `/api/projects/by-slug/${encodeURIComponent(slug)}`,
  /** Whether a published game is open to remixers (`{ private }`), as its owner sets it on genex.games. */
  visibility: (id: string) => `/api/projects/${encodeURIComponent(id)}/visibility`,
  generation: (id: string) => `/api/generations/${encodeURIComponent(id)}`,
  generationRequest: (id: string) => `/api/generations/requests/${encodeURIComponent(id)}`,
  /** Take a game's web version off Genex, keeping its apps (`DELETE`). */
  web: (id: string) => `/api/games/${encodeURIComponent(id)}/web`,
} as const;

/** Request options carrying `signal` only when there is one. */
export const withSignal = (signal: AbortSignal | undefined): RequestInit => (signal ? { signal } : {});

/**
 * An HTTP failure that keeps its status, so callers can tell an expired sign-in from an outage, and
 * the refusal code Genex answered with (`{ error: "no_native_build" }`), when it gave one.
 */
export const httpError = (route: string, status: number, code?: string) =>
  Object.assign(new Error(`Genex ${route}: HTTP ${status}`), { status, ...(code ? { code } : {}) });

/** The HTTP status of a failed Genex call, when it had one. */
export const statusOf = (error: unknown): number | undefined => (error as { status?: number } | null)?.status;

/** The refusal code of a failed Genex call, when Genex answered one. */
export const codeOf = (error: unknown): string | undefined => (error as { code?: string } | null)?.code;

/** The refusal code a failed answer's JSON names in `error`, when it is one; never its words. */
async function refusalCode(res: Response): Promise<string | undefined> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const code = body?.error;
  const isCode = typeof code === "string" && code.length <= ERROR_CODE_MAX_CHARS && ERROR_CODE.test(code);
  return isCode ? code : undefined;
}

/** An authenticated Genex API call; any non-2xx answer throws {@link httpError}. */
export async function genexFetch(api: string, route: string, token: string | null, init: RequestInit = {}) {
  const timeout = AbortSignal.timeout(API_REQUEST_TIMEOUT_MS);
  const res = await fetch(api + route, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
  if (!res.ok) throw httpError(route, res.status, await refusalCode(res));
  return res.json() as Promise<any>;
}

/** Read a response body into memory, refusing it once it passes `maxBytes`. */
export async function readCapped(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxBytes: number,
  tooLarge: string,
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) throw new Error(tooLarge);
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
