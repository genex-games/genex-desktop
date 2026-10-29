/**
 * Where Play's viewer takes a game's page: its own address carrying the sign-in ticket (or the
 * guest marker) in the fragment, and which addresses the page may move to afterwards.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import { PLAY_GAMES_DOMAIN, PLAY_ORIGIN, playGameUrl } from "../../shared/play.ts";

/** At most one link a game asks for opens in the browser in this long. */
export const EXTERNAL_LINK_GAP_MS = 3 * SECOND_MS;

/**
 * Where the game's sign-in hop goes when a ticket could not be redeemed. Only its guest form stays
 * in the viewer (it returns at once); a hop that would show genex.games' sign-in page goes to the
 * browser, so no sign-in form ever appears in the studio's chrome without an address bar.
 */
const AUTHORIZE = { path: "/play/authorize", guest: { name: "guest", value: "ok" } } as const;

/** The page address that plays `slug`: signed in with `ticket`, else as a guest. */
export function playAddress(slug: string, ticket: string | undefined): string {
  const fragment = ticket ? `genex_ticket=${encodeURIComponent(ticket)}` : "genex_guest=1";
  return `${playGameUrl(slug)}?genex_r=1#${fragment}`;
}

/**
 * Whether a game's page may go to `raw`: a Genex game's address, or Genex's guest sign-in hop. The
 * hop is genex.games' own even when a development profile points Play at another website: a game
 * is served from Genex's game hosts, and its page hops to the website those hosts belong to.
 */
export function playNavigationAllowed(raw: string, offline: boolean): boolean {
  if (offline) return raw.startsWith("data:text/html");
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return false;
    // Any Genex game's own address: a renamed game answers from its new one.
    if (url.hostname.endsWith(`.${PLAY_GAMES_DOMAIN}`)) return true;
    const { guest } = AUTHORIZE;
    return (
      url.origin === PLAY_ORIGIN.web &&
      url.pathname === AUTHORIZE.path &&
      url.searchParams.get(guest.name) === guest.value
    );
  } catch {
    return false;
  }
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
