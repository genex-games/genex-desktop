/** Talking to Genex over HTTPS: the API call, the hosts Studio trusts and bounded downloads. */
import { SECOND_MS } from "../../shared/duration.ts";

/** One Genex API request, including reading its answer. */
export const API_REQUEST_TIMEOUT_MS = 20 * SECOND_MS;
/** The HTTP status Genex answers for an expired or revoked sign-in. */
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_FORBIDDEN = 403;
export const HTTP_NOT_FOUND = 404;

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

/** A file Studio may download: https on one of Genex's asset hosts. */
export const isGenexAssetUrl = (url: URL) => url.protocol === "https:" && ASSET_HOSTS.has(url.hostname);

/** The Genex API routes Studio calls. */
export const GenexRoute = {
  DeviceStart: "/api/cli/device/start",
  DevicePoll: "/api/cli/device/poll",
  LegalStatus: "/api/legal/status",
  Session: "/api/auth/get-session",
  Credits: "/api/credits/me",
  Lanes: "/api/generations/lanes",
  projectBySlug: (slug: string) => `/api/projects/by-slug/${encodeURIComponent(slug)}`,
  generation: (id: string) => `/api/generations/${encodeURIComponent(id)}`,
  generationRequest: (id: string) => `/api/generations/requests/${encodeURIComponent(id)}`,
} as const;

/** Request options carrying `signal` only when there is one. */
export const withSignal = (signal: AbortSignal | undefined): RequestInit => (signal ? { signal } : {});

/** An HTTP failure that keeps its status, so callers can tell an expired sign-in from an outage. */
export const httpError = (route: string, status: number) =>
  Object.assign(new Error(`Genex ${route}: HTTP ${status}`), { status });

/** The HTTP status of a failed Genex call, when it had one. */
export const statusOf = (error: unknown): number | undefined => (error as { status?: number } | null)?.status;

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
  if (!res.ok) throw httpError(route, res.status);
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
