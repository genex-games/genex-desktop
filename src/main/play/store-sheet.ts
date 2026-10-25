/**
 * Buying an item from a game's page (marketplace plan 10.1, P7). Main starts the purchase on
 * genex.games for the game whose page it is (`POST /api/store/items/:id/purchase`, `store.ts`), then
 * shows Play's own purchase sheet for it in the studio window. The sheet is the viewer's
 * (`viewer-purchase.ts`), run by the same machine over this context instead of the bar's layer: Pay
 * counts only once the page has shown Ask for `PURCHASE_ARM_MS`, and main confirms on
 * `STUDIO_CONFIRM_SURFACE` or cancels only the purchase it started, never one the page names. Main
 * pushes each sheet to the studio window with its item and game; `buy` answers when the sheet
 * closes, with how it ended, and a refusal before any sheet answers its code. Electron-free: the
 * store and coin clients, the game's page facts, the browser, the clock and the push come in as deps.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import { isPlaySlug, type PlayBarState, PlayViewerPhase } from "../../shared/play.ts";
import { PurchaseStep } from "../../shared/play-purchase.ts";
import {
  isItemId,
  isStoreRefused,
  StoreBuyOutcome,
  type StoreBuyResult,
  type StoreRefused,
  type StoreSheet,
} from "../../shared/store-items.ts";
import { type CoinIntent, CoinIntentStatus } from "./coin.ts";
import { type PlayWorld, SignInNeeded } from "./gallery.ts";
import { type PurchaseContext, type ViewerCoin, type ViewerPurchase, viewerPurchase } from "./viewer-purchase.ts";

/**
 * The longest a started purchase waits for its sheet to open: its read back and the balance each
 * have the network's own bounded wait, so past this something hangs, and the purchase is canceled.
 */
export const STORE_SHEET_OPEN_MS = 45 * SECOND_MS;

/** A malformed call from Studio's own renderer: stays English for its developer. */
const MESSAGE = {
  BadItem: "Not an item on genex.games",
  BadGame: "Not a game address",
  Busy: "A purchase is already being started",
} as const;

/** The session a sheet belongs to, as the viewer's machine reads one. */
type Holder = NonNullable<ReturnType<PurchaseContext["session"]>>;

/** The bar's state the machine writes its sheet into: only `purchase` is read here. */
const IDLE_BAR: PlayBarState = {
  title: "",
  liked: false,
  likes: 0,
  remixable: false,
  multiplayer: false,
  note: null,
  guestCard: false,
  facts: null,
  mic: null,
  comments: null,
  signedIn: true,
  remixing: false,
  nativeApp: null,
  purchase: null,
  store: null,
};

/** How a sheet that closed on each step ended for its buyer. */
const OUTCOME: Record<PurchaseStep, StoreBuyOutcome> = {
  [PurchaseStep.Ask]: StoreBuyOutcome.NotPaid,
  [PurchaseStep.Paying]: StoreBuyOutcome.Pending,
  [PurchaseStep.Paid]: StoreBuyOutcome.Paid,
  [PurchaseStep.NotEnough]: StoreBuyOutcome.NotPaid,
  [PurchaseStep.SignedOut]: StoreBuyOutcome.NotPaid,
  [PurchaseStep.Pending]: StoreBuyOutcome.Pending,
  [PurchaseStep.Failed]: StoreBuyOutcome.NotPaid,
};

/** What a store purchase's sheet needs. */
export interface StoreSheetDeps {
  /** Start the purchase on genex.games for the game whose page it is (`PlayStore.purchase`). */
  purchase(itemId: string, slug: string): Promise<CoinIntent | StoreRefused>;
  /** The game's page facts: its id, title and cover (`PlayGallery.world`). */
  world(slug: string): Promise<PlayWorld>;
  /** genex.games' coin, as the viewer's sheet reads, confirms and cancels it (`coin.ts`). */
  coin: ViewerCoin;
  /** The sheet's Sign in: the app's own Genex sign-in in the browser. */
  account: { signIn(): void };
  /** Get Nex: genex.games' coin page in the browser (a fixture launch tops its balance up instead). */
  openPage(url: string): void;
  /** The website Play links to. */
  web: string;
  clock: { setTimeout(run: () => void, ms: number): unknown; clearTimeout(handle: unknown): void; now(): number };
  /** Draw the sheet in the studio window, or take it away (null). */
  push(sheet: StoreSheet | null): void;
}

/** The sheet on screen: its item and game, kept after its buy answered (a cancel may yet turn out paid). */
interface Shown {
  epoch: number;
  itemId: string;
  slug: string;
  holder: Holder;
}

/** A buy waiting for its sheet to close. */
interface Waiting {
  epoch: number;
  intentId: string;
  /** The sheet has been drawn at least once. */
  shown: boolean;
  /** The step it showed last. */
  last: PurchaseStep;
  timer: unknown;
  resolve(result: StoreBuyResult): void;
}

/** A purchase the sheet may show: this game's, still open to pay. */
const sheetable = (intent: CoinIntent, world: PlayWorld | null): world is PlayWorld =>
  world !== null && intent.projectId === world.id && intent.status === CoinIntentStatus.RequiresConfirmation;

/** One studio window's store sheet: what is on screen, the buy waiting on it, and the viewer's machine running it. */
interface Sheet {
  deps: StoreSheetDeps;
  shown: Shown | null;
  waiting: Waiting | null;
  /** A purchase is being started: another waits for it. */
  starting: boolean;
  epochs: number;
  /** Made right after the sheet, over a context that reads it. */
  machine: ViewerPurchase | null;
}

/** Answer the buy waiting on the sheet, once. */
function finish(sheet: Sheet, result: StoreBuyResult): void {
  const buyer = sheet.waiting;
  if (!buyer) return;
  sheet.waiting = null;
  sheet.deps.clock.clearTimeout(buyer.timer);
  buyer.resolve(result);
}

/** Cancel a purchase main started, best effort: nothing waits on it. */
function cancel(sheet: Sheet, intentId: string): void {
  void sheet.deps.coin.cancel(intentId).catch(() => null);
}

/** The machine wrote a sheet (or none) into the session: push it, and answer the buy once it closes. */
function draw(sheet: Sheet): void {
  const { shown, waiting } = sheet;
  if (!shown) return;
  const drawn = shown.holder.state.purchase;
  sheet.deps.push(drawn && { ...drawn, itemId: shown.itemId, slug: shown.slug });
  if (waiting?.epoch !== shown.epoch) return;
  if (drawn) {
    waiting.shown = true;
    waiting.last = drawn.step;
    sheet.deps.clock.clearTimeout(waiting.timer);
  } else if (waiting.shown) finish(sheet, { outcome: OUTCOME[waiting.last] });
}

/** The purchase could not be read to show: no sheet will open, so the purchase is canceled. */
function notShown(sheet: Sheet): void {
  const buyer = sheet.waiting;
  if (!buyer || buyer.shown) return;
  sheet.machine?.drop();
  cancel(sheet, buyer.intentId);
  finish(sheet, { outcome: StoreBuyOutcome.NotShown });
}

/** The coin client, telling apart a failed read of the purchase being opened (not a sign-in): it will never show. */
function watchedCoin(sheet: Sheet): ViewerCoin {
  const { coin } = sheet.deps;
  return {
    intent: (id) =>
      coin.intent(id).catch((error: unknown) => {
        const opening = sheet.waiting !== null && !sheet.waiting.shown && sheet.waiting.intentId === id;
        if (opening && !(error instanceof SignInNeeded)) notShown(sheet);
        throw error;
      }),
    balance: () => coin.balance(),
    // The earned coin on hold, for a short sheet's line under the balance, when the coin client reads it.
    ...(coin.wallet ? { wallet: coin.wallet } : {}),
    confirm: (intent) => coin.confirm(intent),
    cancel: (id) => coin.cancel(id),
  };
}

/** The viewer's machine's context: the studio window's page draws the sheet, with no bar's layer and no game under it. */
function contextOf(sheet: Sheet): PurchaseContext {
  const { deps } = sheet;
  return {
    deps: {
      coin: watchedCoin(sheet),
      account: deps.account,
      openPage: deps.openPage,
      web: deps.web,
      clock: deps.clock,
      // The studio window's own page already has the keyboard, and no game sits under it.
      bar: { focus: () => {} },
      game: { focus: () => {} },
    },
    session: () => sheet.shown?.holder ?? null,
    current: (epoch) => (sheet.shown?.epoch === epoch ? sheet.shown.holder : null),
    draw: () => draw(sheet),
    layer: { sheet: () => {}, covering: () => false },
  };
}

/** Show `intent`'s sheet for `itemId` on `world`'s page; answers when it closes. */
function open(sheet: Sheet, intent: CoinIntent, world: PlayWorld, item: { itemId: string; slug: string }) {
  return new Promise<StoreBuyResult>((resolve) => {
    sheet.epochs += 1;
    const epoch = sheet.epochs;
    const state = { ...IDLE_BAR, title: world.title };
    const holder: Holder = {
      epoch,
      title: world.title,
      phase: PlayViewerPhase.Loading,
      worldRead: Promise.resolve(world),
      state,
      signedOut: false,
    };
    sheet.shown = { epoch, ...item, holder };
    const timer = sheet.deps.clock.setTimeout(() => notShown(sheet), STORE_SHEET_OPEN_MS);
    sheet.waiting = { epoch, intentId: intent.id, shown: false, last: PurchaseStep.Ask, timer, resolve };
    // The player chose this item on Studio's own page: no wait after a sheet they just closed.
    sheet.machine?.drop();
    sheet.machine?.purchase(intent.id);
  });
}

/** The studio window closed or reloaded: the sheet goes, and a purchase still unpaid is canceled. */
function drop(sheet: Sheet): void {
  const buyer = sheet.waiting;
  if (buyer && !buyer.shown) {
    notShown(sheet);
    return;
  }
  sheet.machine?.drop();
  sheet.shown = null;
  sheet.deps.push(null);
  if (buyer) finish(sheet, { outcome: OUTCOME[buyer.last] });
}

/** A purchase started and its game's page, ready for the sheet. */
interface Started {
  intent: CoinIntent;
  world: PlayWorld;
}

/** Start the purchase and read the game's page: the purchase to show, or how the buy already ended. */
async function start(sheet: Sheet, itemId: string, slug: string): Promise<Started | StoreBuyResult> {
  const { deps } = sheet;
  const [started, world] = await Promise.all([deps.purchase(itemId, slug), deps.world(slug).catch(() => null)]);
  if (isStoreRefused(started)) return started;
  if (sheetable(started, world)) return { intent: started, world };
  cancel(sheet, started.id);
  return { outcome: StoreBuyOutcome.NotShown };
}

/**
 * Start buying `itemId` on the page of the game `slug`, and show its sheet; answers how it ended.
 * One starts at a time; a sheet still open (the page that drew it reloaded, say) gives way to it.
 */
async function buy(sheet: Sheet, itemId: unknown, slug: unknown): Promise<StoreBuyResult> {
  if (!isItemId(itemId)) throw new Error(MESSAGE.BadItem);
  if (!isPlaySlug(slug)) throw new Error(MESSAGE.BadGame);
  if (sheet.starting) throw new Error(MESSAGE.Busy);
  sheet.starting = true;
  const started = await start(sheet, itemId, slug).finally(() => {
    sheet.starting = false;
  });
  if (!("intent" in started)) return started;
  if (sheet.shown) drop(sheet);
  return open(sheet, started.intent, started.world, { itemId, slug });
}

/** A store purchase's sheet over `deps`: one at a time. */
export function storeSheet(deps: StoreSheetDeps) {
  const sheet: Sheet = { deps, shown: null, waiting: null, starting: false, epochs: 0, machine: null };
  const machine = viewerPurchase(contextOf(sheet));
  sheet.machine = machine;
  return {
    buy: (itemId: unknown, slug: unknown): Promise<StoreBuyResult> => buy(sheet, itemId, slug),
    /** The studio window's answer to the sheet on screen (`PlayPurchaseAnswer`); any other is dropped. */
    answer: (value: unknown): void => machine.answerPurchase(value),
    /** The studio window gained or lost focus: a click bringing it back never pays, so Pay waits again. */
    focusChanged: (): void => machine.focusChanged(),
    /** The studio window closed or reloaded: the sheet goes, and a purchase still unpaid is canceled. */
    drop: (): void => drop(sheet),
  };
}

/** A store purchase's sheet as `storeSheet` makes it. */
export type StoreSheetControl = ReturnType<typeof storeSheet>;

/** The studio window's events, as following it needs: Electron's `BrowserWindow` and its page. */
export interface StudioWindowEvents {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  webContents: { on(event: string, listener: (...args: unknown[]) => void): unknown };
}

/**
 * Keep the store sheet with the studio window it is drawn in. A focus change makes Pay wait again,
 * as the viewer's does: a click that brings the window back never pays. The page committing a new
 * document (a reload), dying, or the window closing takes the sheet away and cancels a purchase
 * still unpaid: no page is left to draw it or answer it.
 */
export function followStudioWindow(
  win: StudioWindowEvents,
  sheet: Pick<StoreSheetControl, "focusChanged" | "drop">,
): void {
  win.on("focus", () => sheet.focusChanged());
  win.on("blur", () => sheet.focusChanged());
  win.on("closed", () => sheet.drop());
  win.webContents.on("did-start-navigation", (_event: unknown, _url: unknown, inPlace: unknown, mainFrame: unknown) => {
    if (mainFrame === true && inPlace !== true) sheet.drop();
  });
  win.webContents.on("render-process-gone", () => sheet.drop());
}
