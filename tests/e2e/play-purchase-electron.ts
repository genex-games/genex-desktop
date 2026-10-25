/**
 * A game's coin purchase popup in real Electron (`src/main/play/purchase-window.ts`). A disposable
 * profile and an in-memory session whose every https request is answered here and recorded: nothing
 * reaches the network. A game page replays the embed SDK's own calls, `requestPayment()` (a reserved
 * blank popup pointed at the confirm page later) and `buy()` (the confirm page opened at once), and
 * hostile pages try to use the popup. The report records the Electron version and every event the
 * popups' pages raised.
 */
import { app, BrowserWindow, session, type WebContents, WebContentsView, webContents } from "electron";
import { mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { linkGate } from "../../src/main/play/game-address.ts";
import { wirePurchaseCapture } from "../../src/main/play/purchase-window.ts";
import { preparePlaySession } from "../../src/main/play/viewer-view.ts";

const root = mkdtempSync(path.join(os.tmpdir(), "studio-play-purchase-"));
app.setPath("userData", path.join(root, "profile"));
app.on("window-all-closed", () => {});

/** A confirm website that resolves nowhere: were anything to leave the session, it would die in DNS. */
const CONFIRM = "https://confirm.genex.invalid";
const GAME = "https://moon.genex.technology/";
const AD = "https://ads.example/frame";
/** How long the replayed SDK takes to create its payment before it points the popup. */
const CREATE_MS = 150;
/** Long enough for a popup's navigation and its close to happen. */
const SETTLE_MS = 400;

const GAME_PAGE = `<!doctype html><title>game</title><canvas width=64 height=64></canvas>
<iframe id=ad src="${AD}"></iframe>
<script>
  window.frames_drawn = 0;
  (function draw() { window.frames_drawn++; requestAnimationFrame(draw); })();
  const CONFIRM = ${JSON.stringify(CONFIRM)};
  // requestPayment(): reserve before anything is created, then point the popup once the payment exists.
  window.requestPayment = (id) => new Promise((resolve) => {
    const target = CONFIRM + "/confirm/" + encodeURIComponent(id);
    let popup = null;
    try { popup = window.open("about:blank", "_blank", "popup,width=420,height=640"); if (popup) popup.opener = null; }
    catch { popup?.close(); return resolve("popup_blocked"); }
    if (!popup) return resolve("popup_blocked");
    window.lastPopup = popup;
    setTimeout(() => { if (!popup.closed) popup.location.href = target; resolve("opened"); }, ${CREATE_MS});
  });
  // buy(): the intent exists already; its confirm page opens at once.
  window.buy = (id) => window.open(CONFIRM + "/confirm/" + encodeURIComponent(id), "genex_confirm_" + id, "popup,width=420,height=640") === null ? "popup_blocked" : "opened";
</script>`;
/** A third party's frame in the game that replays the SDK's reservation. */
const AD_PAGE = `<!doctype html><body>ad<script>
  window.requestPayment = (id) => new Promise((resolve) => {
    const popup = window.open("about:blank", "_blank", "popup,width=420,height=640");
    if (!popup) return resolve("popup_blocked");
    setTimeout(() => { if (!popup.closed) popup.location.href = ${JSON.stringify(CONFIRM)} + "/confirm/" + id; resolve("opened"); }, ${CREATE_MS});
  });
</script>`;

/** What the session answers, by address; anything else is a plain page. */
const PAGES = new Map([
  [GAME, GAME_PAGE],
  [AD, AD_PAGE],
]);

const checks: { name: string; ok: boolean }[] = [];
const events: unknown[] = [];
const mark = (event: string, details = {}) => events.push({ at: Date.now(), event, ...details });
const check = (name: string, ok: boolean) => checks.push({ name, ok });
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every https request the session made, by address. */
const requested: string[] = [];
/** What the viewer heard, and what went to the browser. */
const heard: string[] = [];
const sentOut: string[] = [];
let mayReserve = true;
/** Pages made for a window open that took the keyboard. */
let popupFocus = 0;

/** Every live page but `keep`. */
const popupsBut = (keep: readonly WebContents[]): WebContents[] =>
  webContents.getAllWebContents().filter((page) => !keep.includes(page) && !page.isDestroyed());

/** Record what each page Electron makes for a window open raises, as evidence of which hook fired. */
function observePopups(): void {
  app.on("web-contents-created", (_event, page) => {
    const opener = page.opener?.url ?? null;
    mark("page-created", { id: page.id, opener });
    page.on("will-frame-navigate", (event) => mark("will-frame-navigate", { id: page.id, url: event.url }));
    page.on("did-start-navigation", (event) => mark("did-start-navigation", { id: page.id, url: event.url }));
    page.on("focus", () => {
      if (page.opener === null) return;
      popupFocus++;
      mark("popup-focus", { id: page.id });
    });
    page.once("destroyed", () => mark("destroyed", { id: page.id }));
  });
}

/** The game's view in Play's rules, its purchases caught, and what each row needs of it. */
async function setUp() {
  const play = preparePlaySession(session.fromPartition(`play-purchase-${process.pid}`));
  play.protocol.handle("https", (request) => {
    requested.push(request.url);
    return new Response(PAGES.get(request.url) ?? "<!doctype html><p>page", {
      headers: { "content-type": "text/html" },
    });
  });
  const win = new BrowserWindow({ width: 320, height: 240, show: false, skipTaskbar: true });
  const view = new WebContentsView({ webPreferences: { session: play, sandbox: true, contextIsolation: true } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 320, height: 240 });
  const game = view.webContents;
  // Evidence only: a macOS session may take the app's focus away on its own a second or two after a
  // window shows, with no popup at all, so the game's own focus over the run proves nothing.
  win.on("blur", () => mark("window-blur"));
  game.on("blur", () => mark("game-blur"));
  game.on("focus", () => mark("game-focus"));
  wirePurchaseCapture(play, game, {
    confirmOrigin: CONFIRM,
    sendOut: linkGate((url) => sentOut.push(url)),
    mayReserve: () => mayReserve,
    purchase: (id) => heard.push(id),
    page: (id) => webContents.fromId(id),
    // Node clears a timer by the number its handle stands for.
    clock: { setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: (handle) => clearTimeout(Number(handle)) },
  });
  await game.loadURL(GAME);
  win.show();
  game.focus();
  await pause(SETTLE_MS);
  mark("focus", { focused: game.isFocused() });
  return {
    win,
    game,
    /** The purchase popups still alive. */
    popups: () => popupsBut([win.webContents, game]),
    run: (code: string): Promise<unknown> => game.executeJavaScript(code),
  };
}
type Rig = Awaited<ReturnType<typeof setUp>>;

/** How many requests reached a confirm page. */
const confirmRequests = () => requested.filter((url) => url.includes("/confirm/")).length;

/** The SDK's two ways to ask: each gets its popup, the viewer hears the purchase, the popup closes. */
async function sdkPurchases(rig: Rig): Promise<void> {
  const paid = await rig.run(`window.requestPayment("in_req1")`);
  await pause(SETTLE_MS);
  check("requestPayment: the reserved popup is not refused (the SDK says popup_blocked if it is)", paid === "opened");
  check("requestPayment: the viewer hears its purchase", heard.join() === "in_req1");
  check("requestPayment: its popup is closed once heard", rig.popups().length === 0);
  const bought = await rig.run(`window.buy("in_buy1")`);
  await pause(SETTLE_MS);
  check("buy: the confirm popup is not refused", bought === "opened");
  check("buy: the viewer hears its purchase", heard.join() === "in_req1,in_buy1");
  check("buy: its popup is closed once heard", rig.popups().length === 0);
}

/** A game holds one popup: fifty reservations in a row make one, and closing it frees it. */
async function onePopup(rig: Rig): Promise<void> {
  const burst = await rig.run(
    `(() => { const opened = []; for (let i = 0; i < 50; i++) { const p = window.open("about:blank", "_blank", "popup"); if (p) opened.push(p); } window.burst = opened; return opened.length; })()`,
  );
  check("fifty reservations in a row make one popup", burst === 1 && rig.popups().length === 1);
  await rig.run(`window.burst.forEach((p) => p.close())`);
  await pause(SETTLE_MS);
  check("the game closing its popup frees it", rig.popups().length === 0);
}

/** A popup the game drives elsewhere: granted nothing, loads nothing, and its address goes to the browser. */
async function hostilePopup(rig: Rig): Promise<void> {
  const clipboard = `(target) => target.navigator.permissions.query({ name: "clipboard-write" }).then((s) => s.state)`;
  const gameMay = await rig.run(`(${clipboard})(window)`);
  const popupMay = await rig.run(
    `(() => { const p = window.open("about:blank", "_blank", "popup"); window.held = p; return (${clipboard})(p).catch((e) => String(e)); })()`,
  );
  mark("permission", { gameMay, popupMay });
  check(
    "a purchase popup is granted nothing the game is (clipboard writes)",
    gameMay === "granted" && popupMay !== "granted",
  );
  await rig.run(`window.held.location.href = "https://example.com/x"`);
  await pause(SETTLE_MS);
  check(
    "a popup sent to https://example.com makes no request",
    !requested.some((url) => url.startsWith("https://example.com")),
  );
  check("and that address goes to the browser instead", sentOut.join() === "https://example.com/x");
  check("and the popup is closed", rig.popups().length === 0);
}

/** Opens that are not the game's purchase now: a frame's inside the game, and any while a sheet is open. */
async function notCaught(rig: Rig): Promise<void> {
  const ad = rig.game.mainFrame.frames.find((frame) => frame.url === AD);
  const adPaid = ad ? await ad.executeJavaScript(`window.requestPayment("in_ad1")`) : "no frame";
  await pause(SETTLE_MS);
  mark("iframe", { adPaid });
  check(
    "an iframe's open is not caught: the viewer hears nothing",
    ad !== undefined && heard.join() === "in_req1,in_buy1",
  );
  check("and its popup is closed", rig.popups().length === 0);
  mayReserve = false;
  const refused = await rig.run(`window.requestPayment("in_req2")`);
  mayReserve = true;
  check("while a sheet is open the game gets no popup", refused === "popup_blocked" && rig.popups().length === 0);
}

/** After it all: nothing loaded a confirm page, no window showed, the game played on, and nothing lingers. */
async function afterwards(rig: Rig, framesBefore: number): Promise<void> {
  check("no request ever reached a confirm page", confirmRequests() === 0);
  check("no window is listed but the test's own", BrowserWindow.getAllWindows().length === 1);
  mark("focus-after", { focused: rig.game.isFocused() });
  check("no purchase popup ever took the keyboard", popupFocus === 0);
  check("the game kept drawing", Number(await rig.run("window.frames_drawn")) > framesBefore);
  await rig.run(`document.getElementById("ad").src = ${JSON.stringify(`${CONFIRM}/confirm/in_frame`)}`);
  await pause(SETTLE_MS);
  check(
    "with no popup alive, Play's session cancels nothing: a frame loads a confirm page as before",
    confirmRequests() === 1,
  );
  await rig.run(`(window.waiting = window.open("about:blank", "_blank", "popup")) !== null`);
  const before = rig.popups().length;
  rig.game.close();
  await pause(SETTLE_MS);
  check("the game's page closing closes its popup", before === 1 && popupsBut([rig.win.webContents]).length === 0);
}

async function main(): Promise<void> {
  await app.whenReady();
  observePopups();
  let rig: Rig | null = null;
  try {
    rig = await setUp();
    const framesBefore = Number(await rig.run("window.frames_drawn"));
    await sdkPurchases(rig);
    await onePopup(rig);
    await hostilePopup(rig);
    await notCaught(rig);
    await afterwards(rig, framesBefore);
  } catch (error) {
    mark("error", { error: String(error) });
    check("fixture completed", false);
  } finally {
    const result = {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      passed: checks.length > 0 && checks.every((c) => c.ok),
      checks,
      heard,
      sentOut,
      requested,
      events,
    };
    const report = process.env.STUDIO_PLAY_PURCHASE_REPORT;
    if (report) await writeFile(report, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ electron: result.electron, passed: result.passed, checks }, null, 2));
    rig?.win.destroy();
    app.exit(result.passed ? 0 : 1);
  }
}
void main();
