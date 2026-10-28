/**
 * Where Play talks to genex.games: its API, which main calls, its website, which the app links
 * to and opens in the browser, and the host its games are served under. A release always uses
 * genex.games. A development profile (`studio:dev`, never a packaged app, never a fixture launch)
 * may point Play at a local or test copy of genex.games, a stand, through {@link PlayOriginEnv},
 * read here in main only. Each origin must be a bare origin, https anywhere or plain http on this
 * Mac; anything else is ignored and that side stays on genex.games, so a typo never sends the
 * account's token somewhere new. A stand's game host, the Genex host tools' CLI and the trust of a
 * stand's own CA follow the stand only while Play's API is the stand's (`devStand`), so genex.games'
 * account and its sign-in tickets never reach a stand.
 */
import path from "node:path";
import { browserGenexLink, tagGenexLink } from "../../plugins/genex/http.ts";
import { PLAY_ORIGIN, type PlayOrigins } from "../../shared/play.ts";

/** The environment variables a development profile points Play with. */
export const PlayOriginEnv = {
  /** The API main calls, e.g. `http://localhost:3000`. */
  Api: "GENEX_DEV_PLAY_API_ORIGIN",
  /** The website the app links to and signs in on, e.g. `http://localhost:5173`. */
  Web: "GENEX_DEV_PLAY_WEB_ORIGIN",
  /** Where the stand serves its games, e.g. `https://localhost:8443`: a game plays at `https://<slug>.localhost:8443/`. */
  Games: "GENEX_DEV_PLAY_GAMES_ORIGIN",
  /**
   * A local CA's certificate (a PEM file's absolute path): the viewer trusts it for the stand's game
   * hosts only, and the Genex plugin's publish (its backend and CLI runs) beside the system's.
   */
  GamesCa: "GENEX_DEV_PLAY_GAMES_CA",
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

/**
 * Play's origins for this launch: genex.games', or (`development` only) what the profile's
 * environment names. A stand's game host counts only with the stand's API.
 */
export function playOrigins(env: Readonly<Record<string, string | undefined>>, development: boolean): PlayOrigins {
  if (!development) return PLAY_ORIGIN;
  const api = devOrigin(env[PlayOriginEnv.Api]) ?? PLAY_ORIGIN.api;
  const games = api === PLAY_ORIGIN.api ? null : devOrigin(env[PlayOriginEnv.Games]);
  return {
    api,
    web: devOrigin(env[PlayOriginEnv.Web]) ?? PLAY_ORIGIN.web,
    games: games ?? PLAY_ORIGIN.games,
  };
}

/** What main knows of its launch at start. */
export interface LaunchKind {
  /** Started as a `studio:dev` profile. */
  developerProfile: boolean;
  packaged: boolean;
  /** A fixture launch (fixture providers, a smoke or a self-test), which answers Play from its own data. */
  fixture: boolean;
}

/** Whether a launch takes a development profile's Play variables: a `studio:dev` profile, never packaged, never a fixture. */
export const developmentLaunch = (launch: LaunchKind): boolean =>
  launch.developerProfile && !launch.packaged && !launch.fixture;

/** What a development profile's environment changes in a launch: nothing but genex.games' own outside one. */
export interface DevStand {
  origins: PlayOrigins;
  /**
   * The stand's API the Genex host tools run the CLI against with the stand's own account (the
   * one the profile signed in to); null: genex.games, with the Genex plugin's account.
   */
  hostToolsApi: string | null;
  /**
   * The stand's own CA file: the viewer trusts it for the stand's game hosts only, and the Genex
   * plugin's publish to the stand beside the system's (`genex-cli.ts` `launchStand`); null trusts
   * nothing more.
   */
  gamesCaFile: string | null;
}

/** The longest CA file path taken. */
const CA_PATH_MAX = 1024;

/** A CA file as named: one absolute path with no control character; else null. */
function caFile(raw: string | undefined): string | null {
  const value = raw?.trim() ?? "";
  const plain = value !== "" && value.length <= CA_PATH_MAX && !UNSAFE_CHARACTERS.test(value);
  return plain && path.isAbsolute(value) ? value : null;
}

/** This launch's stand, from the profile's environment; genex.games' own for any other launch. */
export function devStand(env: Readonly<Record<string, string | undefined>>, launch: LaunchKind): DevStand {
  const origins = playOrigins(env, developmentLaunch(launch));
  const onStand = origins.api !== PLAY_ORIGIN.api;
  const gamesOnStand = origins.games !== PLAY_ORIGIN.games;
  return {
    origins,
    hostToolsApi: onStand ? origins.api : null,
    gamesCaFile: gamesOnStand ? caFile(env[PlayOriginEnv.GamesCa]) : null,
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

/**
 * Open a genex.games page the app links to (Get Nex): a page of the website at `web` the way a
 * sign-in page opens (`openWebsite`, which takes a development website's plain http), anything else
 * the way every other link opens (`openOther`).
 */
export function websitePageOpener(
  web: string,
  openWebsite: (url: string) => void,
  openOther: (url: string) => void,
): (url: string) => void {
  return (url) => (onWebsite(url, web) ? openWebsite(url) : openOther(url));
}
