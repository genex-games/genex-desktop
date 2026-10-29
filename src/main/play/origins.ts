/**
 * Where Play talks to genex.games: its API, which main calls, and its website, which the app links
 * to and opens in the browser. A release always uses genex.games. A development profile
 * (`studio:dev`, never a packaged app) may point Play at a local or test copy of either through
 * {@link PlayOriginEnv}, read here in main only. Each value must be a bare origin, https anywhere
 * or plain http on this Mac; anything else is ignored and that side stays on genex.games, so a
 * typo never sends the account's token somewhere new.
 */
import { browserGenexLink, tagGenexLink } from "../../plugins/genex/http.ts";
import { PLAY_ORIGIN, type PlayOrigins } from "../../shared/play.ts";

/** The environment variables a development profile points Play with. */
export const PlayOriginEnv = {
  /** The API main calls, e.g. `http://localhost:3000`. */
  Api: "GENEX_DEV_PLAY_API_ORIGIN",
  /** The website the app links to and signs in on, e.g. `http://localhost:5173`. */
  Web: "GENEX_DEV_PLAY_WEB_ORIGIN",
} as const;
export type PlayOriginEnv = (typeof PlayOriginEnv)[keyof typeof PlayOriginEnv];

/** The hosts plain http is taken for: this Mac only. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Whitespace or a control character anywhere: the URL parser would quietly drop some of them. */
const UNSAFE_CHARACTERS = /[\s\u0000-\u001f\u007f]/;

/** A parsed address with no user, password, query or fragment. */
const bare = (url: URL): boolean => !url.username && !url.password && !url.search && !url.hash;

/** A development origin as written: a bare https origin, or plain http on this Mac; else null. */
export function devOrigin(raw: string | undefined): string | null {
  const value = raw?.trim() ?? "";
  if (!value || UNSAFE_CHARACTERS.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  return secure && bare(url) && url.pathname === "/" ? url.origin : null;
}

/** Play's origins for this launch: genex.games', or (`development` only) what the profile's environment names. */
export function playOrigins(env: Readonly<Record<string, string | undefined>>, development: boolean): PlayOrigins {
  if (!development) return PLAY_ORIGIN;
  return {
    api: devOrigin(env[PlayOriginEnv.Api]) ?? PLAY_ORIGIN.api,
    web: devOrigin(env[PlayOriginEnv.Web]) ?? PLAY_ORIGIN.web,
  };
}

/**
 * Whether `raw` is a page of the website at `web`: its scheme and host exactly, with no user or
 * password. Compared part by part rather than by `origin`, which a `blob:` address borrows from the
 * address inside it.
 */
export function onWebsite(raw: string, web: string): boolean {
  try {
    const url = new URL(raw);
    const site = new URL(web);
    return url.protocol === site.protocol && url.host === site.host && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Whether the renderer may have `raw` opened in the browser: any https address, or a page of the website at `web`. */
export function browserMayOpen(raw: string, web: string): boolean {
  return /^https:\/\//i.test(raw) || onWebsite(raw, web);
}

/**
 * The address the browser opens for a Genex page (a sign-in to finish, the terms, a game's page):
 * a page of the website at `web` as it is, else an https address; both tagged as the app's visit.
 * Anything else throws, so nothing opens.
 */
export function genexPageAddress(address: string, web: string): string {
  return onWebsite(address, web) ? tagGenexLink(address) : browserGenexLink(address);
}
