/**
 * Which of a game's window opens are its coin purchase. The embed SDK opens genex.games' confirm page
 * for one intent in a popup (`buy()`), or reserves a blank popup before it asks to be paid and points
 * it at that page afterwards (`requestPayment()`). Main captures those two and shows Studio's own
 * sheet; every other open stays a link. A confirm address is held to the SDK's own rule for one. Pure:
 * the viewer's view (Electron) asks, and acts on the answer.
 */
import { isIntentId } from "../../shared/play-purchase.ts";

/** The confirm page's path, before the intent's id. */
const CONFIRM_PATH = "/confirm/";
/** The only address a reserved popup starts on. */
const BLANK = "about:blank";
/** The one way a popup opens: its own window, not a tab. */
const NEW_WINDOW = "new-window";
/** The window feature that asks for a popup. */
const POPUP_FEATURE = "popup";
/** Hosts a confirm website may be served from over plain http: this machine, as the SDK allows. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** A boolean window feature's values that mean yes besides a non-zero number (the HTML standard's rule). */
const FEATURE_YES: ReadonlySet<string> = new Set(["", "yes", "true"]);

/** What a game's window open is to Play. Main's own words: never sent anywhere. */
export const GameOpen = {
  /** Anything else: it goes where a game's links go (the browser, or nowhere). */
  Link: "link",
  /** A blank popup the SDK holds for the confirm page it has yet to learn: a hidden window may take it. */
  Reserve: "reserve",
  /** genex.games' confirm page for one intent: Studio shows its own sheet for it. */
  Confirm: "confirm",
} as const;
export type GameOpen = (typeof GameOpen)[keyof typeof GameOpen];

/** What a game's window open is, with the intent a confirm is for. */
export type GameOpenVerdict =
  | { kind: typeof GameOpen.Link }
  | { kind: typeof GameOpen.Reserve }
  | { kind: typeof GameOpen.Confirm; intentId: string };

/** A window open as Electron describes it (its window-open handler's details). */
export interface GameOpenRequest {
  url: string;
  frameName: string;
  features: string;
  disposition: string;
  /** The opening document's address, "" when its referrer policy keeps it back. */
  referrer: { url: string };
}

/** Whose opens these are, and where genex.games confirms a purchase. */
export interface GameOpenScope {
  /** The website genex.games' confirm page is served from: https, or plain http on a loopback host. */
  confirmOrigin: string;
  /** The game page's own origin: an open from any other document (a frame in it) is a link. */
  gameOrigin: string;
}

const LINK: GameOpenVerdict = { kind: GameOpen.Link };

const parsed = (raw: string): URL | null => {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
};

/** The confirm website's origin when Studio may trust it, else null. */
function trustedOrigin(confirmOrigin: string): string | null {
  const url = parsed(confirmOrigin);
  if (!url) return null;
  const secure = url.protocol === "https:";
  const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  return secure || loopback ? url.origin : null;
}

/**
 * The intent `raw` confirms, when it is exactly `<confirmOrigin>/confirm/<id>`: no credentials, query
 * or fragment (not even an empty one), and an id genex.games could have handed out. Else null.
 */
export function confirmIntentId(raw: string, confirmOrigin: string): string | null {
  const origin = trustedOrigin(confirmOrigin);
  const url = parsed(raw);
  if (!origin || !url) return null;
  const onConfirmPage = url.origin === origin && url.pathname.startsWith(CONFIRM_PATH);
  if (!onConfirmPage) return null;
  const id = url.pathname.slice(CONFIRM_PATH.length);
  // The whole address must be the plain one: this also refuses `user@`, a bare `?` and a bare `#`.
  return isIntentId(id) && url.href === `${origin}${CONFIRM_PATH}${id}` ? id : null;
}

/** Whether a window-features string asks for a popup by name, as the HTML standard reads a boolean feature. */
function asksForPopup(features: string): boolean {
  for (const token of features.split(",")) {
    const [rawKey = "", ...rest] = token.split("=");
    if (rawKey.trim().toLowerCase() !== POPUP_FEATURE) continue;
    const value = rest.join("=").trim().toLowerCase();
    if (FEATURE_YES.has(value)) return true;
    const number = Number.parseInt(value, 10);
    return Number.isFinite(number) && number !== 0;
  }
  return false;
}

/** Whether the open came from the game's own page: a referrer held back counts, one elsewhere does not. */
function fromGame(referrer: string, gameOrigin: string): boolean {
  if (referrer === "") return true;
  const url = parsed(referrer);
  const web = url?.protocol === "https:" || url?.protocol === "http:";
  return web && url?.origin === gameOrigin;
}

/**
 * What a game's window open is: genex.games' confirm page for one intent, a blank popup the SDK
 * reserves for it, or (anything else, and anything from another document or as a tab) a link.
 */
export function classifyGameOpen(open: GameOpenRequest, scope: GameOpenScope): GameOpenVerdict {
  const captured = open.disposition === NEW_WINDOW && fromGame(open.referrer.url, scope.gameOrigin);
  if (!captured || !trustedOrigin(scope.confirmOrigin)) return LINK;
  const intentId = confirmIntentId(open.url, scope.confirmOrigin);
  if (intentId) return { kind: GameOpen.Confirm, intentId };
  return open.url === BLANK && asksForPopup(open.features) ? { kind: GameOpen.Reserve } : LINK;
}
