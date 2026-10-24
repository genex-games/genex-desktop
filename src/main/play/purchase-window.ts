/**
 * Catching a game's coin purchase in Play's viewer: Electron's side of `purchase-address.ts`. The
 * embed SDK opens genex.games' confirm page in a popup, at once for one purchase (`buy()`), or by
 * reserving a blank popup before it asks to be paid and pointing it there afterwards
 * (`requestPayment()`). Either way the game gets its popup, so the SDK goes on to wait for the outcome:
 * a page Electron makes and nothing shows, at most one per game, made only while the viewer may show a
 * sheet. The popup's first move ends it: a confirm page's purchase goes to the viewer, which shows its
 * own sheet, any other https address goes to the browser through the game's link gate, and anything
 * else nowhere; it never loads a thing. While one lives, Play's session cancels its every request, and
 * any request for a confirm page at all. A popup opened by a frame inside the game, or opened without
 * an opener, is not the SDK's: it is a link. Electron-free at runtime (the session and the pages come
 * in by the little of them this needs): tested on fakes (`play-purchase-window.test.ts`) and in Electron
 * (`tests/e2e/play-purchase-electron.ts`), where Electron 43.7.6 reports both of the SDK's navigations
 * as the popup's own `will-frame-navigate`.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import { PLAY_ORIGIN, type PlayOrigins } from "../../shared/play.ts";
import {
  classifyGameOpen,
  confirmIntentId,
  GameOpen,
  type GameOpenRequest,
  type GameOpenVerdict,
} from "./purchase-address.ts";

/**
 * How long a reserved popup waits for its confirm page before it is closed. The SDK gives creating
 * the payment 15 s before it points the popup; a popup closed by then is skipped, and the game waits on.
 */
export const PURCHASE_RESERVE_MS = 20 * SECOND_MS;

/** A window open refused. */
const DENY = { action: "deny" } as const;
/** A purchase popup's own settings: a page that is never shown, runs nothing of its own and draws nothing. */
const HIDDEN_POPUP = {
  show: false,
  webPreferences: { javascript: false, images: false, sandbox: true, contextIsolation: true, nodeIntegration: false },
} as const;
/** What Play's session listens to while a popup lives: every request, so the popup's own are all heard. */
const ALL_URLS = { urls: ["<all_urls>"] };
/** A request answered. */
const CANCEL = { cancel: true } as const;
const PASS = {} as const;
/** The request that loads a page's top document. */
const MAIN_FRAME = "mainFrame";
/** A popup ends after the navigation that ended it, never inside Electron's call about it. */
const END_DELAY_MS = 0;
const LINK: GameOpenVerdict = { kind: GameOpen.Link };

/**
 * What a page answers a window open with (Electron's window-open handler's answer). A popup allowed is
 * made by `createWindow`, which is handed Electron's options, the page Electron made among them.
 */
export type OpenAnswer<Page> =
  | typeof DENY
  | { action: "allow"; overrideBrowserWindowOptions: typeof HIDDEN_POPUP; createWindow(options: object): Page };

/** A navigation a purchase popup is about to make, as Electron reports it (`will-frame-navigate`). */
export interface PageNavigation {
  url: string;
  isMainFrame: boolean;
  preventDefault(): void;
}

/** A page in Play's session, as catching a purchase needs it: the game's, or a popup it opened. */
export interface CapturePage<Self> {
  readonly id: number;
  /** The page's top frame: a popup opened by it names it as its opener. */
  readonly mainFrame: unknown;
  /** The frame that opened this page, if another page did and did not give it up (`noopener`). */
  readonly opener: unknown;
  getURL(): string;
  isDestroyed(): boolean;
  close(): void;
  setAudioMuted(muted: boolean): void;
  setWindowOpenHandler(handler: (open: GameOpenRequest) => OpenAnswer<Self>): void;
  on(event: "will-frame-navigate", listener: (navigation: PageNavigation) => void): unknown;
  on(event: "will-redirect", listener: (redirect: { preventDefault(): void }) => void): unknown;
  on(event: "did-navigate", listener: () => void): unknown;
  once(event: "destroyed", listener: () => void): unknown;
}

/** A request in Play's session, as its request listener hears it. */
export interface PageRequest {
  url: string;
  webContentsId?: number;
  resourceType: string;
}

/** Play's session, as catching a purchase needs it: its one request listener (Electron keeps one per session). */
export interface CaptureSession {
  webRequest: {
    onBeforeRequest(
      filter: { urls: string[] },
      listener: ((request: PageRequest, answer: (response: { cancel?: boolean }) => void) => void) | null,
    ): void;
  };
}

/** What catching a game's purchase needs of the viewer and the app. */
export interface PurchaseCaptureDeps<Page> {
  /** Where genex.games confirms a purchase ({@link purchaseConfirmOrigin}), or null: no open is caught. */
  confirmOrigin: string | null;
  /** A link the game asked for, to the browser through its view's link gate. */
  sendOut(url: string): void;
  /** Whether the viewer may show a purchase sheet now: no sheet, no purchase being read, none just closed. */
  mayReserve(): boolean;
  /** The game asked to pay for the purchase `intentId`: the viewer reads it and shows its sheet. */
  purchase(intentId: string): void;
  /** A page of the app by its id (Electron's `webContents.fromId`). */
  page(id: number): Page | undefined;
  clock: { setTimeout(run: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
}

/** A live purchase popup: where it may confirm, whom it tells, and whether its one move is spent. */
interface Popup {
  /** The popup page's id, kept: a destroyed page may no longer say it. */
  id: number;
  page: { isDestroyed(): boolean; close(): void };
  confirmOrigin: string;
  sendOut(url: string): void;
  purchase(intentId: string): void;
  clock: PurchaseCaptureDeps<unknown>["clock"];
  /** Its purchase was heard, or it moved, or it is not the SDK's: it only waits to close. */
  spent: boolean;
  timer: unknown;
}

/** Each live purchase popup by its page's id: Play's session finds a request's popup by `webContentsId`. */
const popups = new Map<number, Popup>();
/** Each game page's one live popup. */
const popupOf = new WeakMap<object, Popup>();
/** How many popups live in each session: its request listener lives as long as one does. */
const liveIn = new WeakMap<CaptureSession, number>();

/**
 * Where a game's purchases are confirmed: genex.games' own website, the one its API names in a game's
 * confirm address, whatever website a development profile points Studio's links at. Null (nothing is
 * caught) when Studio reads coin from another API than genex.games': it could never read the purchase
 * of a published game, which always pays on genex.games.
 */
export function purchaseConfirmOrigin(origins: PlayOrigins): string | null {
  return origins.api === PLAY_ORIGIN.api ? PLAY_ORIGIN.web : null;
}

/** Whether `page` is a purchase popup: Play's session grants it nothing. */
export const isPurchaseWindow = (page: { id: number }): boolean => popups.has(page.id);

/** The origin of `raw`, or "" when it has none worth comparing. */
function originOf(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
}

/** Close the popup's page unless it is gone. */
function closePopup(popup: Popup): void {
  if (!popup.page.isDestroyed()) popup.page.close();
}

/** The popup's move is spent: it closes right after the call that spent it. */
function spend(popup: Popup): void {
  popup.spent = true;
  popup.clock.clearTimeout(popup.timer);
  popup.timer = popup.clock.setTimeout(() => closePopup(popup), END_DELAY_MS);
}

/**
 * The popup moves to `url`: a confirm page's purchase goes to the viewer, another https address to the
 * browser, a frame inside it nowhere. Only its first move counts, and it ends the popup.
 */
function moved(popup: Popup, url: string, isMainFrame: boolean): void {
  if (popup.spent) return;
  spend(popup);
  if (!isMainFrame) return;
  const intentId = confirmIntentId(url, popup.confirmOrigin);
  if (intentId) popup.purchase(intentId);
  else popup.sendOut(url);
}

/** What Play's session answers a request while a popup lives. */
function answerRequest(request: PageRequest): typeof CANCEL | typeof PASS {
  const popup = request.webContentsId === undefined ? undefined : popups.get(request.webContentsId);
  if (popup) {
    // A load of its top document that no navigation event announced is decided all the same.
    if (request.resourceType === MAIN_FRAME) moved(popup, request.url, true);
    return CANCEL;
  }
  const confirm = [...popups.values()].some((live) => confirmIntentId(request.url, live.confirmOrigin) !== null);
  return confirm ? CANCEL : PASS;
}

/** A popup came to life in `session`: its first turns the session's request listener on. */
function listen(session: CaptureSession): void {
  const live = (liveIn.get(session) ?? 0) + 1;
  liveIn.set(session, live);
  if (live === 1) session.webRequest.onBeforeRequest(ALL_URLS, (request, answer) => answer(answerRequest(request)));
}

/** A popup in `session` is gone: with the last, the session hears no request again. */
function unlisten(session: CaptureSession): void {
  const live = Math.max(0, (liveIn.get(session) ?? 0) - 1);
  liveIn.set(session, live);
  if (live === 0) session.webRequest.onBeforeRequest(ALL_URLS, null);
}

/** Whether a value is an object with an `id` of its own to read. */
const hasId = (value: unknown): value is { id: unknown } =>
  typeof value === "object" && value !== null && "id" in value;

/** The page Electron made for an allowed open: in its options, untyped there, so found again by its id. */
function madePage<Page>(options: object, page: (id: number) => Page | undefined): Page | null {
  const made = "webContents" in options ? options.webContents : null;
  const id = hasId(made) ? made.id : null;
  const found = typeof id === "number" ? page(id) : undefined;
  return found !== undefined && found === made ? found : null;
}

/**
 * Hold `page`, the popup made for one of `game`'s opens, under every rule: nothing of its own sounds or
 * opens, a redirect goes nowhere, its first navigation is stopped and ends it, and it closes after
 * {@link PURCHASE_RESERVE_MS} if nothing moves it. It is let go when its page is destroyed, whoever
 * closed it (the SDK closes its own on a refused payment).
 */
function hold<Page extends CapturePage<Page>>(
  session: CaptureSession,
  game: Page,
  page: Page,
  deps: PurchaseCaptureDeps<Page> & { confirmOrigin: string },
): Popup {
  const { confirmOrigin, sendOut, purchase, clock } = deps;
  const popup: Popup = { id: page.id, page, confirmOrigin, sendOut, purchase, clock, spent: false, timer: null };
  popups.set(popup.id, popup);
  popupOf.set(game, popup);
  listen(session);
  page.setAudioMuted(true);
  page.setWindowOpenHandler(() => DENY);
  page.on("will-redirect", (redirect) => redirect.preventDefault());
  page.on("will-frame-navigate", (navigation) => {
    navigation.preventDefault();
    moved(popup, navigation.url, navigation.isMainFrame);
  });
  page.once("destroyed", () => {
    clock.clearTimeout(popup.timer);
    popups.delete(popup.id);
    if (popupOf.get(game) === popup) popupOf.delete(game);
    unlisten(session);
  });
  popup.timer = clock.setTimeout(() => closePopup(popup), PURCHASE_RESERVE_MS);
  return popup;
}

/** What one of the game's opens is: nothing is caught without a confirm website to catch it for. */
function verdictOf(game: { getURL(): string }, confirmOrigin: string | null, open: GameOpenRequest): GameOpenVerdict {
  if (confirmOrigin === null) return LINK;
  return classifyGameOpen(open, { confirmOrigin, gameOrigin: originOf(game.getURL()) });
}

/**
 * Make the popup for an open the SDK asked for. A popup that the game's own top frame did not open (a
 * frame inside it, or an open that gave its opener up) is a link and closes at once; a confirm page's
 * purchase is heard at once, before its page could load.
 */
function adopt<Page extends CapturePage<Page>>(
  session: CaptureSession,
  game: Page,
  deps: PurchaseCaptureDeps<Page> & { confirmOrigin: string },
  open: { url: string; verdict: GameOpenVerdict },
  options: object,
): Page {
  const page = madePage(options, deps.page);
  if (!page) {
    // Electron makes no page here (it opens the address itself) and ignores the page answered.
    deps.sendOut(open.url);
    return game;
  }
  const popup = hold(session, game, page, deps);
  if (page.opener !== game.mainFrame) {
    spend(popup);
    deps.sendOut(open.url);
  } else if (open.verdict.kind === GameOpen.Confirm) {
    spend(popup);
    deps.purchase(open.verdict.intentId);
  }
  return page;
}

/** How `game` answers a window open: a link, refused, or a hidden popup for its purchase. */
function answerOpen<Page extends CapturePage<Page>>(
  session: CaptureSession,
  game: Page,
  deps: PurchaseCaptureDeps<Page>,
  open: GameOpenRequest,
): OpenAnswer<Page> {
  const { confirmOrigin } = deps;
  const verdict = verdictOf(game, confirmOrigin, open);
  if (verdict.kind === GameOpen.Link || confirmOrigin === null) {
    deps.sendOut(open.url);
    return DENY;
  }
  // The SDK hears a refused popup as `popup_blocked`; a game's purchase never goes to the browser.
  if (popupOf.has(game) || !deps.mayReserve()) return DENY;
  const caught = { ...deps, confirmOrigin };
  return {
    action: "allow",
    overrideBrowserWindowOptions: HIDDEN_POPUP,
    createWindow: (options) => adopt(session, game, caught, { url: open.url, verdict }, options),
  };
}

/**
 * Catch the coin purchases `game` asks for in `session`, its every other window open a link. Its
 * popup closes when its page moves on to another document or closes.
 */
export function wirePurchaseCapture<Page extends CapturePage<Page>>(
  session: CaptureSession,
  game: Page,
  deps: PurchaseCaptureDeps<Page>,
): void {
  const closeOwn = (): void => {
    const popup = popupOf.get(game);
    if (popup) closePopup(popup);
  };
  game.setWindowOpenHandler((open) => answerOpen(session, game, deps, open));
  game.on("did-navigate", closeOwn);
  game.once("destroyed", closeOwn);
}
