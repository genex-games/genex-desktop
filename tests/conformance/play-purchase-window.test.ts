import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { GameOpenRequest } from "../../src/main/play/purchase-address.ts";
import {
  type CapturePage,
  type CaptureSession,
  isPurchaseWindow,
  type OpenAnswer,
  type PageNavigation,
  type PageRequest,
  PURCHASE_RESERVE_MS,
  purchaseConfirmOrigin,
  wirePurchaseCapture,
} from "../../src/main/play/purchase-window.ts";
import { PLAY_ORIGIN } from "../../src/shared/play.ts";
import { fakeClock } from "../helpers/play-viewer-rig.ts";

/** A confirm website that resolves nowhere, as a fixture's would. */
const CONFIRM = "https://confirm.genex.invalid";
const GAME_URL = "https://moon.genex.technology/?genex_r=1";
/** The embed SDK's own popup features. */
const SDK_FEATURES = "popup,width=420,height=640";

/** What a page's events carry, by event. */
interface PageEvents {
  "will-frame-navigate": PageNavigation;
  "will-redirect": { preventDefault(): void };
  "did-navigate": undefined;
}

/** A page in Play's session as Electron's WebContents behaves for the capture: events, opens, closing. */
class FakePage implements CapturePage<FakePage> {
  static #next = 1;
  readonly id = FakePage.#next++;
  readonly mainFrame = { frameOf: this.id };
  opener: unknown = null;
  url = "about:blank";
  muted = false;
  #destroyed = false;
  #handler: ((open: GameOpenRequest) => OpenAnswer<FakePage>) | null = null;
  readonly #listeners: { [E in keyof PageEvents]: Array<(arg: PageEvents[E]) => void> } = {
    "will-frame-navigate": [],
    "will-redirect": [],
    "did-navigate": [],
  };
  readonly #gone: Array<() => void> = [];

  getURL(): string {
    return this.url;
  }
  isDestroyed(): boolean {
    return this.#destroyed;
  }
  /** Closing a page destroys it: Electron says so once. */
  close(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    for (const listener of this.#gone) listener();
  }
  setAudioMuted(muted: boolean): void {
    this.muted = muted;
  }
  setWindowOpenHandler(handler: (open: GameOpenRequest) => OpenAnswer<FakePage>): void {
    this.#handler = handler;
  }
  on<E extends keyof PageEvents>(event: E, listener: (arg: PageEvents[E]) => void): this {
    this.#listeners[event].push(listener);
    return this;
  }
  once(_event: "destroyed", listener: () => void): this {
    this.#gone.push(listener);
    return this;
  }
  emit<E extends keyof PageEvents>(event: E, arg: PageEvents[E]): void {
    for (const listener of this.#listeners[event]) listener(arg);
  }
  /** The page asks to open a window: what its handler answers. */
  opens(request: Partial<GameOpenRequest> & { url: string }): OpenAnswer<FakePage> {
    if (!this.#handler) throw new Error("no window-open handler");
    const open = { frameName: "", features: SDK_FEATURES, disposition: "new-window", referrer: { url: "" } };
    return this.#handler({ ...open, ...request });
  }
  /** The page starts a navigation of its top frame (or of a frame in it): whether something stopped it. */
  navigates(url: string, isMainFrame = true): boolean {
    let prevented = false;
    this.emit("will-frame-navigate", { url, isMainFrame, preventDefault: () => (prevented = true) });
    return prevented;
  }
}

/** Play's session with its one request listener, and what that listener answers a request. */
function fakeSession() {
  type Listener = (request: PageRequest, answer: (response: { cancel?: boolean }) => void) => void;
  let listener: Listener | null = null;
  const filters: string[][] = [];
  const session: CaptureSession = {
    webRequest: {
      onBeforeRequest: (filter, next) => {
        filters.push(next ? filter.urls : []);
        listener = next;
      },
    },
  };
  return {
    session,
    /** Each listener set, by its addresses; a removal is `[]`. */
    filters,
    /** What the listener answers a request: `pass` with no listener at all. */
    request(url: string, webContentsId?: number, resourceType = "mainFrame"): "cancel" | "pass" {
      let cancel = false;
      listener?.({ url, webContentsId, resourceType }, (response) => (cancel = response.cancel === true));
      return cancel ? "cancel" : "pass";
    },
  };
}

interface CaptureOptions {
  confirmOrigin?: string | null;
  mayReserve?: boolean;
}

/** A game's page wired for capture, with the viewer's and the browser's side recorded in `log`. */
function capture(options: CaptureOptions = {}) {
  const { clock, advance } = fakeClock();
  const pages = new Map<number, FakePage>();
  const page = (): FakePage => {
    const made = new FakePage();
    pages.set(made.id, made);
    return made;
  };
  const game = page();
  game.url = GAME_URL;
  const net = fakeSession();
  const log: string[] = [];
  let may = options.mayReserve ?? true;
  wirePurchaseCapture(net.session, game, {
    confirmOrigin: options.confirmOrigin === undefined ? CONFIRM : options.confirmOrigin,
    sendOut: (url) => log.push(`out ${url}`),
    mayReserve: () => may,
    purchase: (id) => log.push(`purchase ${id}`),
    page: (id) => pages.get(id),
    clock,
  });
  /** The game opens a window; Electron makes its page, opened by `opener`, when the open is allowed. */
  const open = (request: Partial<GameOpenRequest> & { url: string }, opener: unknown = game.mainFrame) => {
    const answer = game.opens(request);
    if (answer.action === "deny") return { answer, popup: null };
    const popup = page();
    popup.opener = opener;
    assert.equal(answer.createWindow({ show: false, webContents: popup }), popup, "Electron needs its own page back");
    return { answer, popup };
  };
  /** requestPayment()'s reservation: a blank popup. */
  const reserve = (opener?: unknown) => open({ url: "about:blank" }, opener);
  const reserved = (opener?: unknown): FakePage => {
    const { popup } = reserve(opener);
    if (!popup) throw new Error("the reservation was refused");
    return popup;
  };
  return {
    game,
    net,
    log,
    open,
    reserve,
    reserved,
    advance,
    mayReserve: (value: boolean) => {
      may = value;
    },
  };
}

const confirmPage = (id: string) => `${CONFIRM}/confirm/${id}`;

describe("which of a game's opens make a purchase popup", () => {
  test("requestPayment()'s blank popup is allowed as a hidden page that runs nothing, sounds nothing and opens nothing", () => {
    const c = capture();
    const { answer, popup } = c.reserve();
    assert.equal(answer.action, "allow");
    assert.ok(answer.action === "allow");
    assert.equal(answer.overrideBrowserWindowOptions.show, false);
    assert.equal(answer.overrideBrowserWindowOptions.webPreferences.javascript, false);
    assert.equal(answer.overrideBrowserWindowOptions.webPreferences.sandbox, true);
    assert.ok(popup);
    assert.equal(popup.muted, true);
    assert.deepEqual(popup.opens({ url: "https://example.com/" }), { action: "deny" });
    assert.deepEqual(c.log, [], "nothing is heard or opened until it moves");
  });

  test("buy()'s confirm page is allowed, and the viewer hears its purchase at once", () => {
    const c = capture();
    const { answer } = c.open({
      url: confirmPage("in_buy1"),
      frameName: "genex_confirm_in_buy1",
      referrer: { url: GAME_URL },
    });
    assert.equal(answer.action, "allow");
    assert.deepEqual(c.log, ["purchase in_buy1"]);
  });

  test("every other open is a link, as before: to the browser's gate, with no popup", () => {
    const opens: Array<Partial<GameOpenRequest> & { url: string }> = [
      { url: "https://example.com/" },
      { url: "about:blank", features: "width=420" },
      { url: "about:blank", features: "popup=0" },
      { url: confirmPage("in_tab"), disposition: "foreground-tab" },
      { url: `${confirmPage("in_q")}?x=1` },
      { url: "https://genex.games.evil.example/confirm/in_1" },
      { url: confirmPage("in_ref"), referrer: { url: "https://ads.example/frame" } },
      { url: "javascript:alert(1)" },
    ];
    for (const request of opens) {
      const c = capture();
      const { answer, popup } = c.open(request);
      assert.deepEqual(answer, { action: "deny" }, request.url);
      assert.equal(popup, null);
      assert.deepEqual(c.log, [`out ${request.url}`], request.url);
    }
  });

  test("with nowhere to confirm (a development API, a fixture), even a purchase's opens stay links", () => {
    const c = capture({ confirmOrigin: null });
    assert.deepEqual(c.open({ url: confirmPage("in_1") }).answer, { action: "deny" });
    assert.deepEqual(c.reserve().answer, { action: "deny" });
    assert.deepEqual(c.log, [`out ${confirmPage("in_1")}`, "out about:blank"]);
  });

  test("while the viewer may not show a sheet, a purchase's opens get nothing: no popup, no browser", () => {
    const c = capture({ mayReserve: false });
    assert.deepEqual(c.reserve().answer, { action: "deny" });
    assert.deepEqual(c.open({ url: confirmPage("in_1") }).answer, { action: "deny" });
    assert.deepEqual(c.log, []);
  });

  test("a game holds at most one popup: fifty reservations in a row make one", () => {
    const c = capture();
    const allowed = Array.from({ length: 50 }, () => c.reserve().answer.action).filter((action) => action === "allow");
    assert.equal(allowed.length, 1);
    assert.deepEqual(c.open({ url: confirmPage("in_2") }).answer, { action: "deny" });
    assert.deepEqual(c.log, []);
  });

  test("a popup opened by a frame inside the game, or by no one (noopener), is not caught and closes", () => {
    for (const opener of [{ frameOf: "an ad" }, null]) {
      const c = capture();
      const { popup } = c.open({ url: confirmPage("in_frame") }, opener);
      assert.ok(popup);
      c.advance(0);
      assert.equal(popup.isDestroyed(), true);
      assert.deepEqual(c.log, [`out ${confirmPage("in_frame")}`], "it is a link");
      assert.equal(c.reserve().answer.action, "allow", "it held nothing");
    }
  });

  test("a window Electron opens itself (no page made yet) stays a link and holds nothing", () => {
    const c = capture();
    const answer = c.game.opens({ url: confirmPage("in_link") });
    assert.ok(answer.action === "allow");
    answer.createWindow({ show: false });
    assert.deepEqual(c.log, [`out ${confirmPage("in_link")}`]);
    assert.equal(c.reserve().answer.action, "allow");
  });
});

describe("where a reserved popup may go: its first move ends it", () => {
  test("to a confirm page: stopped before it loads, its purchase heard once, the popup closed", () => {
    const c = capture();
    const popup = c.reserved();
    assert.equal(popup.navigates(confirmPage("in_pay1")), true);
    assert.equal(popup.navigates(confirmPage("in_pay1")), true);
    assert.deepEqual(c.log, ["purchase in_pay1"]);
    assert.equal(popup.isDestroyed(), false, "closed after the navigation, not inside it");
    c.advance(0);
    assert.equal(popup.isDestroyed(), true);
  });

  test("anywhere else on https: stopped, sent to the browser instead, the popup closed", () => {
    const c = capture();
    const popup = c.reserved();
    assert.equal(popup.navigates("https://example.com/x"), true);
    c.advance(0);
    assert.deepEqual(c.log, ["out https://example.com/x"]);
    assert.equal(popup.isDestroyed(), true);
  });

  test("hostile addresses are never heard as a purchase: each goes where the game's links go (the gate keeps https)", () => {
    const hostile = [
      `${confirmPage("in_1")}?x=1`,
      `${confirmPage("in_1")}#genex_ticket=T1`,
      `${CONFIRM}/confirm/`,
      `${CONFIRM}/confirm/a/b`,
      `${CONFIRM}/confirm/%2e%2e`,
      `${CONFIRM}/Confirm/in_1`,
      "https://user:pw@confirm.genex.invalid/confirm/in_1",
      "https://confirm.genex.invalid:444/confirm/in_1",
      "http://confirm.genex.invalid/confirm/in_1",
      "javascript:location='https://confirm.genex.invalid/confirm/in_1'",
      "data:text/html,<p>pay",
      "about:srcdoc",
    ];
    for (const url of hostile) {
      const c = capture();
      const popup = c.reserved();
      assert.equal(popup.navigates(url), true, url);
      c.advance(0);
      assert.equal(popup.isDestroyed(), true, url);
      assert.deepEqual(c.log, [`out ${url}`], url);
    }
  });

  test("a frame inside the popup never navigates, not even to a confirm page, and ends it", () => {
    const c = capture();
    const popup = c.reserved();
    assert.equal(popup.navigates(confirmPage("in_sub"), false), true);
    c.advance(0);
    assert.deepEqual(c.log, []);
    assert.equal(popup.isDestroyed(), true);
  });

  test("a redirect in the popup is stopped", () => {
    const c = capture();
    const popup = c.reserved();
    let prevented = false;
    popup.emit("will-redirect", { preventDefault: () => (prevented = true) });
    assert.equal(prevented, true);
  });

  test("buy()'s popup, already heard, is stopped on its way to the confirm page and not heard again", () => {
    const c = capture();
    const { popup } = c.open({ url: confirmPage("in_buy2"), frameName: "genex_confirm_in_buy2" });
    assert.ok(popup);
    assert.equal(popup.navigates(confirmPage("in_buy2")), true);
    c.advance(0);
    assert.deepEqual(c.log, ["purchase in_buy2"]);
    assert.equal(popup.isDestroyed(), true);
  });
});

describe("Play's session while a purchase popup lives", () => {
  test("only then it hears every request: the popup's are all canceled, a confirm page's from anyone too", () => {
    const c = capture();
    assert.deepEqual(c.net.filters, [], "no listener before a popup");
    assert.equal(c.net.request(confirmPage("in_1"), c.game.id, "subFrame"), "pass");
    const popup = c.reserved();
    assert.deepEqual(c.net.filters, [["<all_urls>"]]);
    for (const type of ["image", "subFrame", "xhr", "script"]) {
      assert.equal(c.net.request("https://example.com/pixel", popup.id, type), "cancel", type);
    }
    assert.equal(c.net.request(confirmPage("in_1"), c.game.id, "subFrame"), "cancel");
    assert.equal(c.net.request("https://moon.genex.technology/asset.png", c.game.id, "image"), "pass");
    assert.equal(c.net.request("https://example.com/", undefined, "other"), "pass");
    assert.deepEqual(c.log, [], "a subresource ends nothing");
  });

  test("a top-level load of the popup that no navigation event announced is decided the same way", () => {
    const c = capture();
    const popup = c.reserved();
    assert.equal(c.net.request(confirmPage("in_req"), popup.id, "mainFrame"), "cancel");
    c.advance(0);
    assert.deepEqual(c.log, ["purchase in_req"]);
    assert.equal(popup.isDestroyed(), true);
    const next = c.reserved();
    assert.equal(c.net.request("https://example.com/y", next.id, "mainFrame"), "cancel");
    c.advance(0);
    assert.deepEqual(c.log, ["purchase in_req", "out https://example.com/y"]);
  });

  test("the listener goes with the last popup, and a page is a purchase popup only while it lives", () => {
    const c = capture();
    const popup = c.reserved();
    assert.equal(isPurchaseWindow(popup), true);
    assert.equal(isPurchaseWindow(c.game), false);
    popup.close();
    assert.deepEqual(c.net.filters, [["<all_urls>"], []]);
    assert.equal(isPurchaseWindow(popup), false);
    assert.equal(c.net.request(confirmPage("in_1"), c.game.id, "subFrame"), "pass");
  });
});

describe("how a purchase popup ends", () => {
  test("a reservation the SDK never points anywhere closes after its time, and frees the game's one popup", () => {
    const c = capture();
    const popup = c.reserved();
    c.advance(PURCHASE_RESERVE_MS - 1);
    assert.equal(popup.isDestroyed(), false);
    assert.equal(c.reserve().answer.action, "deny");
    c.advance(1);
    assert.equal(popup.isDestroyed(), true);
    assert.equal(c.reserve().answer.action, "allow");
  });

  test("the game closing its own popup (a refused payment) frees it at once, and its timer with it", () => {
    const c = capture();
    const popup = c.reserved();
    popup.close();
    const next = c.reserved();
    c.advance(PURCHASE_RESERVE_MS - 1);
    assert.equal(next.isDestroyed(), false, "the first popup's timer is gone");
    assert.deepEqual(c.log, []);
  });

  test("the game's page moving on, or closing, closes its popup", () => {
    const moved = capture();
    const first = moved.reserved();
    moved.game.emit("did-navigate", undefined);
    assert.equal(first.isDestroyed(), true);
    const closed = capture();
    const second = closed.reserved();
    closed.game.close();
    assert.equal(second.isDestroyed(), true);
    assert.deepEqual([...moved.log, ...closed.log], []);
  });
});

describe("where a game's purchases are confirmed", () => {
  test("genex.games' own website whenever Studio reads genex.games' coin; a stand's own when its games are; else nowhere", () => {
    const games = PLAY_ORIGIN.games;
    const standGames = "https://localhost:8443";
    const rows: Array<[{ api: string; web: string; games: string }, string | null]> = [
      [PLAY_ORIGIN, PLAY_ORIGIN.web],
      [{ api: PLAY_ORIGIN.api, web: "http://localhost:5173", games }, PLAY_ORIGIN.web],
      [{ api: "http://localhost:3000", web: PLAY_ORIGIN.web, games }, null],
      [{ api: "http://localhost:3000", web: "http://localhost:5173", games }, null],
      // A stand's own games pay on the stand's website.
      [{ api: "http://localhost:3000", web: "http://localhost:5173", games: standGames }, "http://localhost:5173"],
    ];
    for (const [origins, expected] of rows) assert.equal(purchaseConfirmOrigin(origins), expected, origins.api);
  });
});
