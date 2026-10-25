/**
 * Where Play's viewer takes a game's page: its own address carrying the sign-in ticket (or the
 * guest marker) in the fragment, and which addresses the page may move to afterwards.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import { PLAY_ORIGIN, type PlayOrigins, playGameUrl } from "../../shared/play.ts";
import { onWebsite } from "./origins.ts";

/** At most one link a game asks for opens in the browser in this long. */
export const EXTERNAL_LINK_GAP_MS = 3 * SECOND_MS;

/**
 * Where the game's sign-in hop goes when a ticket could not be redeemed. Only its guest form stays
 * in the viewer (it returns at once); a hop that would show genex.games' sign-in page goes to the
 * browser, so no sign-in form ever appears in the studio's chrome without an address bar.
 */
const AUTHORIZE = { path: "/play/authorize", guest: { name: "guest", value: "ok" } } as const;

/**
 * The page address that plays `slug` from the game host `games` (genex.games' unless a development
 * profile's stand serves its own): signed in with `ticket`, else as a guest.
 */
export function playAddress(slug: string, ticket: string | undefined, games: string = PLAY_ORIGIN.games): string {
  const fragment = ticket ? `genex_ticket=${encodeURIComponent(ticket)}` : "genex_guest=1";
  return `${playGameUrl(slug, games)}?genex_r=1#${fragment}`;
}

/** Whether `url` is a game's own address under the game host `games`: its scheme and port, any subdomain. */
function onGameHost(url: URL, games: string): boolean {
  const host = new URL(games);
  const sameServer = url.protocol === host.protocol && url.port === host.port && !url.username && !url.password;
  return sameServer && url.hostname.endsWith(`.${host.hostname}`);
}

/**
 * The website a game's page hops to for its guest sign-in: the one its game host belongs to. That is
 * genex.games' own even when a development profile points Play's links at another website, unless
 * the profile's stand serves its games too.
 */
const hopWebsite = (origins: Pick<PlayOrigins, "web" | "games">): string =>
  origins.games === PLAY_ORIGIN.games ? PLAY_ORIGIN.web : origins.web;

/** Whether `url` is the guest form of the sign-in hop on `web`. */
function guestHop(url: URL, web: string): boolean {
  const { guest } = AUTHORIZE;
  return (
    onWebsite(url.href, web) && url.pathname === AUTHORIZE.path && url.searchParams.get(guest.name) === guest.value
  );
}

/**
 * Whether a game's page may go to `raw`: a Genex game's address on the game host Play serves games
 * from, or the guest sign-in hop on the website that host belongs to.
 */
export function playNavigationAllowed(
  raw: string,
  offline: boolean,
  origins: Pick<PlayOrigins, "web" | "games"> = PLAY_ORIGIN,
): boolean {
  if (offline) return raw.startsWith("data:text/html");
  if (!URL.canParse(raw)) return false;
  const url = new URL(raw);
  // Any Genex game's own address: a renamed game answers from its new one.
  return onGameHost(url, origins.games) || guestHop(url, hopWebsite(origins));
}

/**
 * A link a game asked for, as it may go to the browser: https only, and without its fragment, which
 * on a game's first address carries the single-use sign-in ticket. Anything else goes nowhere.
 */
export function externalAddress(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/** Opens links in the browser at most once per {@link EXTERNAL_LINK_GAP_MS}, so a game cannot flood it. */
export function linkGate(open: (url: string) => void, now: () => number = Date.now): (raw: string) => void {
  let last = Number.NEGATIVE_INFINITY;
  return (raw) => {
    const url = externalAddress(raw);
    if (!url || now() - last < EXTERNAL_LINK_GAP_MS) return;
    last = now();
    open(url);
  };
}
