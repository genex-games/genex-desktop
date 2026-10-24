/**
 * A game's coin purchase in Play's viewer (`shared/play-purchase.ts`). Main hears the game ask to pay
 * for a purchase (genex.games calls it an intent), reads it, and draws Studio's own sheet over the
 * dimmed game in the bar's layer, only for a purchase of the game on screen that is still open to pay.
 * Pay counts once the page has shown Ask for {@link PURCHASE_ARM_MS} with no press in it; main then
 * confirms or cancels the purchase it holds, never one the page names. Every way a payment ends is
 * shown conservatively: a sheet never says nothing was charged when it cannot know, and no timer moves
 * a sheet out of Paying (only genex.games' answer to the confirm does). Electron-free: the coin client,
 * the sign-in, the browser and the clock come in as deps.
 */
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { type PlayBarState, PlayViewerPhase } from "../../shared/play.ts";
import {
  isIntentId,
  type PlayPurchaseSheet,
  PURCHASE_ARM_MS,
  PurchaseAnswer,
  PurchaseProblem,
  PurchaseRecovery,
  PurchaseStep,
  playCoinPageUrl,
  purchaseOver,
  readPurchaseAnswer,
} from "../../shared/play-purchase.ts";
import { CoinFailure, type CoinIntent, CoinIntentStatus, CoinRefused, type PlayCoin } from "./coin.ts";
import { type PlayWorld, SignInNeeded } from "./gallery.ts";

/** How often a payment genex.games has not answered is asked after. */
export const PURCHASE_SETTLE_POLL_MS = 2 * SECOND_MS;
/** The longest a pending payment is asked after; past it the sheet stays Pending (the game still learns). */
export const PURCHASE_SETTLE_MS = 3 * MINUTE_MS;
/** How often the balance (after Get coin) or the purchase (after Sign in) is checked again. */
export const PURCHASE_RECHECK_MS = 3 * SECOND_MS;
/** How long past its time a purchase is read again, so genex.games has let it lapse by then. */
export const PURCHASE_EXPIRY_GRACE_MS = SECOND_MS;
/**
 * The soonest a lapsing purchase is read again, and how often while genex.games still holds it open
 * past its time by the app's clock: a clock ahead of genex.games' never ends a sheet at once.
 */
export const PURCHASE_EXPIRY_MIN_MS = 5 * SECOND_MS;
/**
 * How long genex.games keeps a purchase open to pay (its intent TTL). It made the purchase before the
 * game asked, so a purchase it still holds open is taken as lapsed no sooner than this after the ask,
 * by the app's own clock, which may run ahead of genex.games'; one the sheet could not read lapses then.
 */
export const PURCHASE_TTL_MS = 2 * MINUTE_MS;
/**
 * How long a game waits to open a sheet after the player closed one, or after it asked for a purchase
 * it may not (another game's, one already over, one unreadable): a game can neither trap the player in
 * sheets nor spend the account's calls to genex.games by asking again and again.
 */
export const PURCHASE_COOLDOWN_MS = 5 * SECOND_MS;

/** Electron's input kinds that press something (a button, a key or a touch going down): they restart Pay's wait. */
const PRESSES: ReadonlySet<string> = new Set(["mouseDown", "rawKeyDown", "keyDown", "touchStart", "gestureTapDown"]);

/** What the sheet needs of genex.games' coin client. */
export type ViewerCoin = Pick<PlayCoin, "intent" | "balance" | "confirm" | "cancel">;

/** Input in the bar's layer as Electron reports it: its kind, and whether a held key repeats it. */
export interface SheetInput {
  type: string;
  isAutoRepeat?: boolean;
}

/** The viewer's session a purchase belongs to. */
interface PurchaseHolder {
  epoch: number;
  title: string;
  phase: PlayViewerPhase;
  worldRead: Promise<PlayWorld | null>;
  state: PlayBarState;
  /** No Genex account can sign the player in: the bar offers Sign in. */
  signedOut: boolean;
}

/** What the sheet needs of the viewer: genex.games, the sign-in, the browser, the clock, the views and the bar's layer. */
export interface PurchaseContext {
  deps: {
    coin: ViewerCoin;
    /** Sign in to Genex in the browser. */
    account: { signIn(): void };
    /** Open a genex.games page in the browser (Get coin). */
    openPage(url: string): void;
    /** The website Play links to. */
    web: string;
    clock: { setTimeout(run: () => void, ms: number): unknown; clearTimeout(handle: unknown): void; now(): number };
    bar: { focus(): void };
    game: { focus(): void };
  };
  session(): PurchaseHolder | null;
  current(epoch: number): PurchaseHolder | null;
  draw(): void;
  layer: { sheet(open: boolean): void; covering(): boolean };
}

/** What a sheet shows, apart from its purchase: its step and how it got there. */
interface Face {
  step: PurchaseStep;
  problem: PurchaseProblem | null;
  recovery: PurchaseRecovery | null;
}

const at = (step: PurchaseStep): Face => ({ step, problem: null, recovery: null });
const failedFor = (problem: PurchaseProblem): Face => ({ step: PurchaseStep.Failed, problem, recovery: null });
const notEnough = (recovery: PurchaseRecovery): Face => ({ step: PurchaseStep.NotEnough, problem: null, recovery });
const signedOut = (recovery: PurchaseRecovery): Face => ({ step: PurchaseStep.SignedOut, problem: null, recovery });

/**
 * The sheet a purchase genex.games reports shows; null while it is still open to pay. Every status
 * has one, and none says a refusal where coin may have moved.
 */
const SETTLED: Record<CoinIntentStatus, (intent: CoinIntent) => Face | null> = {
  [CoinIntentStatus.RequiresConfirmation]: () => null,
  [CoinIntentStatus.Processing]: () => at(PurchaseStep.Pending),
  [CoinIntentStatus.Succeeded]: () => at(PurchaseStep.Paid),
  [CoinIntentStatus.Consumed]: () => at(PurchaseStep.Paid),
  [CoinIntentStatus.Expired]: () => failedFor(PurchaseProblem.Expired),
  [CoinIntentStatus.Canceled]: () => failedFor(PurchaseProblem.Canceled),
  [CoinIntentStatus.Failed]: (intent) =>
    intent.failure === CoinFailure.InsufficientBalance
      ? notEnough(PurchaseRecovery.Over)
      : failedFor(PurchaseProblem.Refused),
  [CoinIntentStatus.Refunded]: () => failedFor(PurchaseProblem.Refunded),
};

/** Statuses a canceled purchase may answer with that mean it was paid after all. */
const PAID: ReadonlySet<CoinIntentStatus> = new Set([CoinIntentStatus.Succeeded, CoinIntentStatus.Consumed]);

/** A sheet whose purchase may still be paid here: Ask, or a way back to it. */
const payable = (face: Face): boolean =>
  face.step === PurchaseStep.Ask ||
  face.step === PurchaseStep.SignedOut ||
  (face.step === PurchaseStep.NotEnough && face.recovery !== PurchaseRecovery.Over);

/** A NotEnough or SignedOut sheet whose missing coin or sign-in came in: Review shows the purchase again. */
const reviewable = (face: Face): boolean =>
  face.recovery === PurchaseRecovery.Ready &&
  (face.step === PurchaseStep.NotEnough || face.step === PurchaseStep.SignedOut);

type TimerName = "arm" | "lapse" | "recheck" | "settle";
const TIMERS: readonly TimerName[] = ["arm", "lapse", "recheck", "settle"];
const noTimers = (): Record<TimerName, unknown> => ({ arm: null, lapse: null, recheck: null, settle: null });

/** The purchase on screen and its sheet. */
interface Held {
  epoch: number;
  id: string;
  world: PlayWorld;
  game: PlayPurchaseSheet["game"];
  /** Null while the account cannot read it (signed out). */
  intent: CoinIntent | null;
  /** When the game asked, by the app's clock: genex.games made the purchase no later. */
  askedAt: number;
  face: Face;
  sheet: number;
  /** The page has shown this sheet: Pay's wait starts from here. */
  shown: boolean;
  armed: boolean;
  balance: number | null;
  /** Get coin or Sign in was pressed: the balance or the purchase is checked again. */
  rechecking: boolean;
  /** When Pending began. */
  pendingSince: number;
  timers: Record<TimerName, unknown>;
}

/** The sheet's state across purchases in one viewer. */
interface Machine {
  ctx: PurchaseContext;
  held: Held | null;
  /** The read of a game's purchase before its sheet opens, by its turn; null with none. */
  reading: number | null;
  turns: number;
  /** Sheets shown so far: each new one is numbered one more. */
  sheets: number;
  /** No sheet opens before this time: the player just closed one. */
  cooldownUntil: number;
}

/** How to close a sheet: whether its purchase is canceled if still unpaid, and whether the next one waits. */
interface Closing {
  cancel: boolean;
  cooldown: boolean;
}
const PLAYER_CLOSE: Closing = { cancel: true, cooldown: true };
const PAGE_LEFT: Closing = { cancel: true, cooldown: false };
const QUIETLY: Closing = { cancel: false, cooldown: false };

/** A call's answer, or null when it fails: each caller says what an unreadable answer means. */
const attempt = <T>(call: () => Promise<T>): Promise<T | null> =>
  Promise.resolve()
    .then(call)
    .catch(() => null);

/** The sheet as the bar's layer draws it. */
const sheetOf = (h: Held): PlayPurchaseSheet => ({
  sheet: h.sheet,
  ...h.face,
  armed: h.armed,
  game: h.game,
  item: h.intent && {
    name: h.intent.name,
    description: h.intent.description,
    imageUrl: h.intent.iconUrl,
    quantity: h.intent.quantity,
    unitPriceCoins: h.intent.unitPriceCoins,
  },
  price: h.intent && { coins: h.intent.totalCoins, usdCents: h.intent.usdCents },
  balance: h.balance,
});

/** A purchase the game on screen may ask for: its own and still open to pay, or one the account cannot read yet. */
const askable = (intent: CoinIntent | null, world: PlayWorld): boolean =>
  intent === null || (intent.projectId === world.id && intent.status === CoinIntentStatus.RequiresConfirmation);

/** An Ask the page has shown: presses in the bar's layer and the window's focus bear on arming its Pay. */
const shownAsk = (h: Held | null): h is Held => h !== null && h.face.step === PurchaseStep.Ask && h.shown;

/** The balance is known and short of the purchase's price. */
const short = (h: Held): boolean => h.balance !== null && h.intent !== null && h.balance < h.intent.totalCoins;

/** A purchase still open to pay first shows Ask, or Not enough coin when the balance is short. */
const askOrShort = (h: Held): Face => (short(h) ? notEnough(PurchaseRecovery.Waiting) : at(PurchaseStep.Ask));

/** When the sheet first reads its purchase again to see whether it lapsed: genex.games' time, or a TTL after the ask unread. */
const lapseDue = (h: Held): number => h.intent?.expiresAt ?? h.askedAt + PURCHASE_TTL_MS;

/**
 * Whether a purchase genex.games still says is open has surely lapsed by `now`: past its time, and a
 * whole TTL after the game asked by the app's own clock. genex.games lets a game's own item lapse only
 * once someone tries to pay it, so a read alone may never say so.
 */
const surelyLapsed = (h: Held, now: number): boolean =>
  now >= Math.max(lapseDue(h), h.askedAt + PURCHASE_TTL_MS) + PURCHASE_EXPIRY_GRACE_MS;

/** A session's account turned out to be signed out: the bar offers Sign in from now on. */
function markSignedOut(s: PurchaseHolder): void {
  s.signedOut = true;
  s.state = { ...s.state, signedIn: false };
}

/** A session's account reads genex.games again (signed in from the sheet): the bar is signed in, its guest card gone. */
function markSignedIn(s: PurchaseHolder): void {
  s.signedOut = false;
  s.state = { ...s.state, signedIn: true, guestCard: false };
}

/** No sheet opens for a while: the player just closed one, or the game asked for a purchase it may not. */
function coolDown(m: Machine): void {
  m.cooldownUntil = m.ctx.deps.clock.now() + PURCHASE_COOLDOWN_MS;
}

/** The session `h` is drawn in, while `h` is still the sheet on screen. */
const live = (m: Machine, h: Held): PurchaseHolder | null => (m.held === h ? m.ctx.current(h.epoch) : null);
/** `h` still shows the sheet numbered `sheet`: what arrives for an earlier sheet is dropped. */
const still = (m: Machine, h: Held, sheet: number): boolean => live(m, h) !== null && h.sheet === sheet;

function stopTimers(m: Machine, h: Held): void {
  for (const name of TIMERS) {
    if (h.timers[name] !== null) m.ctx.deps.clock.clearTimeout(h.timers[name]);
    h.timers[name] = null;
  }
}

/** Run `run` in `ms`, in place of `name`'s last timer, while `h` is still on screen. */
function later(m: Machine, h: Held, name: TimerName, ms: number, run: () => unknown): void {
  const { clock } = m.ctx.deps;
  if (h.timers[name] !== null) clock.clearTimeout(h.timers[name]);
  h.timers[name] = clock.setTimeout(() => {
    h.timers[name] = null;
    if (live(m, h)) run();
  }, ms);
}

function draw(m: Machine, h: Held): void {
  const s = live(m, h);
  if (!s) return;
  s.state = { ...s.state, purchase: sheetOf(h) };
  m.ctx.draw();
}

/** Show `face` as a new sheet: the last one's timers stop, and Pay waits to be armed again. */
function show(m: Machine, h: Held, face: Face): void {
  const { clock } = m.ctx.deps;
  stopTimers(m, h);
  m.sheets += 1;
  Object.assign(h, { face, sheet: m.sheets, shown: false, armed: false, rechecking: false });
  if (payable(face)) {
    const due = Math.max(lapseDue(h) + PURCHASE_EXPIRY_GRACE_MS - clock.now(), PURCHASE_EXPIRY_MIN_MS);
    later(m, h, "lapse", due, () => lapsed(m, h));
  }
  if (face.step === PurchaseStep.Pending) {
    h.pendingSince = clock.now();
    later(m, h, "settle", PURCHASE_SETTLE_POLL_MS, () => poll(m, h));
  }
  draw(m, h);
}

/** The balance read afresh into the sheet on screen, if it still is. */
function freshBalance(m: Machine, h: Held): void {
  const { sheet } = h;
  void attempt(() => m.ctx.deps.coin.balance()).then((balance) => {
    if (balance === null || !still(m, h, sheet)) return;
    h.balance = balance;
    draw(m, h);
  });
}

/** genex.games took the coin: Paid, with what is left (reckoned until it is read afresh). */
function paid(m: Machine, h: Held): void {
  const total = h.intent?.totalCoins ?? 0;
  if (h.balance !== null) h.balance = Math.max(0, h.balance - total);
  show(m, h, at(PurchaseStep.Paid));
  freshBalance(m, h);
}

/** Show where genex.games says a purchase ended up. */
function settleOn(m: Machine, h: Held, face: Face): void {
  if (face.step === PurchaseStep.Paid) {
    paid(m, h);
    return;
  }
  show(m, h, face);
  if (face.recovery === PurchaseRecovery.Over) freshBalance(m, h);
}

/** The purchase read again: null when it cannot be read, undefined when the sheet moved on meanwhile. */
async function reread(m: Machine, h: Held): Promise<CoinIntent | null | undefined> {
  const { sheet } = h;
  const intent = await attempt(() => m.ctx.deps.coin.intent(h.id));
  if (!still(m, h, sheet)) return undefined;
  if (intent?.projectId !== h.world.id) return null;
  h.intent = intent;
  return intent;
}

/**
 * The purchase's time came by the app's clock: it is read again rather than assumed. Unreadable, it
 * timed out. One genex.games still holds open stays as it is, read again every few seconds, until it
 * has surely lapsed: then it timed out unpaid.
 */
async function lapsed(m: Machine, h: Held): Promise<void> {
  const intent = await reread(m, h);
  if (intent === undefined) return;
  const face = intent ? SETTLED[intent.status](intent) : failedFor(PurchaseProblem.Expired);
  if (face) return settleOn(m, h, face);
  if (surelyLapsed(h, m.ctx.deps.clock.now())) return settleOn(m, h, failedFor(PurchaseProblem.Expired));
  later(m, h, "lapse", PURCHASE_EXPIRY_MIN_MS, () => lapsed(m, h));
}

/** A payment genex.games has not answered: asked after until it settles, its purchase lapses, or long enough. */
async function poll(m: Machine, h: Held): Promise<void> {
  const { clock } = m.ctx.deps;
  const intent = await reread(m, h);
  if (intent === undefined) return;
  const face = intent && SETTLED[intent.status](intent);
  const lapsedUnpaid = intent !== null && face === null && surelyLapsed(h, clock.now());
  if (lapsedUnpaid) return show(m, h, failedFor(PurchaseProblem.Expired));
  if (face && face.step !== PurchaseStep.Pending) return settleOn(m, h, face);
  if (clock.now() - h.pendingSince < PURCHASE_SETTLE_MS)
    later(m, h, "settle", PURCHASE_SETTLE_POLL_MS, () => poll(m, h));
}

/** Open `h`'s sheet over the game at `face`. */
function open(m: Machine, h: Held, face: Face): void {
  m.held = h;
  m.ctx.layer.sheet(true);
  show(m, h, face);
}

/** Close the sheet: the layer goes back to the bar, and the keyboard to a playing game. */
function close(m: Machine, h: Held, how: Closing): void {
  stopTimers(m, h);
  if (how.cancel) cancelUnpaid(m, h);
  m.held = null;
  if (how.cooldown) coolDown(m);
  m.ctx.layer.sheet(false);
  const s = m.ctx.current(h.epoch);
  if (!s) return;
  s.state = { ...s.state, purchase: null };
  m.ctx.draw();
  if (s.phase === PlayViewerPhase.Playing && !m.ctx.layer.covering()) m.ctx.deps.game.focus();
}

/** Cancel a purchase still open to pay, best effort; one genex.games answers was paid after all shows Paid. */
function cancelUnpaid(m: Machine, h: Held): void {
  const { intent } = h;
  if (!intent || !payable(h.face)) return;
  void attempt(() => m.ctx.deps.coin.cancel(intent.id)).then((status) => {
    if (status === null || !PAID.has(status)) return;
    const nothingOpen = m.ctx.current(h.epoch) !== null && m.held === null && m.reading === null;
    if (!nothingOpen) return;
    const again: Held = { ...h, intent, timers: noTimers() };
    m.held = again;
    m.ctx.layer.sheet(true);
    paid(m, again);
  });
}

/**
 * What the game's request reads before a sheet opens: the purchase and the game's own id, then the
 * balance, only for a purchase the game may ask for and the account can read.
 */
async function readPurchase(m: Machine, s: PurchaseHolder, id: string): Promise<Held | null> {
  const { coin, clock } = m.ctx.deps;
  const askedAt = clock.now();
  const [world, intent] = await Promise.all([
    s.worldRead,
    Promise.resolve()
      .then(() => coin.intent(id))
      .catch((error: unknown) => (error instanceof SignInNeeded ? null : undefined)),
  ]);
  // Only the game on screen may ask, for a purchase of its own still open to pay; anything else draws nothing.
  if (!world || intent === undefined) return null;
  if (!askable(intent, world)) return null;
  const balance = intent ? await attempt(() => coin.balance()) : null;
  return {
    epoch: s.epoch,
    id,
    world,
    game: { title: s.title || world.title, coverUrl: world.coverUrl },
    intent,
    askedAt,
    face: at(PurchaseStep.Ask),
    sheet: 0,
    shown: false,
    armed: false,
    balance,
    rechecking: false,
    pendingSince: 0,
    timers: noTimers(),
  };
}

/** Whether the game on screen may ask to pay now: no sheet open or being read, and no wait running. */
const mayReserve = (m: Machine): boolean =>
  m.ctx.session() !== null && m.held === null && m.reading === null && m.ctx.deps.clock.now() >= m.cooldownUntil;

/** The game on screen asked to pay for the purchase `id`: read it, and open its sheet if it is the game's own. */
function request(m: Machine, id: unknown): void {
  const s = m.ctx.session();
  if (!s || !isIntentId(id)) return;
  if (!mayReserve(m)) return;
  m.turns += 1;
  const turn = m.turns;
  m.reading = turn;
  void readPurchase(m, s, id).then((h) => {
    if (m.reading !== turn) return;
    m.reading = null;
    // One it may not ask for draws nothing, and the game waits as after a Cancel before it asks again.
    if (!h) return coolDown(m);
    if (!m.ctx.current(h.epoch)) return;
    if (!h.intent) markSignedOut(s);
    open(m, h, h.intent ? askOrShort(h) : signedOut(PurchaseRecovery.Waiting));
  });
}

/** Pay waits {@link PURCHASE_ARM_MS} again from now, unarmed meanwhile. */
function rearm(m: Machine, h: Held): void {
  const was = h.armed;
  h.armed = false;
  later(m, h, "arm", PURCHASE_ARM_MS, () => {
    h.armed = true;
    draw(m, h);
  });
  if (was) draw(m, h);
}

/** genex.games refused the payment, or did not answer: show what can be known of where it stands. */
async function refusedPay(m: Machine, h: Held, error: unknown): Promise<void> {
  if (error instanceof SignInNeeded) {
    const s = live(m, h);
    if (s) markSignedOut(s);
    return show(m, h, signedOut(PurchaseRecovery.Waiting));
  }
  // No refusal to read (an outage, a timeout): the payment may still land.
  if (!(error instanceof CoinRefused)) return show(m, h, at(PurchaseStep.Pending));
  if (error.code === CoinFailure.InsufficientBalance) return settleOn(m, h, notEnough(PurchaseRecovery.Over));
  if (error.code === CoinFailure.IntentExpired) return show(m, h, failedFor(PurchaseProblem.Expired));
  // Already moving elsewhere, the purchase may still be paid; any other refusal charged nothing.
  const unread =
    error.code === CoinFailure.IntentNotPending ? at(PurchaseStep.Pending) : failedFor(PurchaseProblem.Refused);
  const intent = await reread(m, h);
  if (intent === undefined) return;
  settleOn(m, h, intent ? (SETTLED[intent.status](intent) ?? failedFor(PurchaseProblem.Refused)) : unread);
}

/** Pay: confirm the purchase on screen as the app's Genex account, and show how it went. */
async function pay(m: Machine, h: Held): Promise<void> {
  const { intent } = h;
  if (!intent) return;
  show(m, h, at(PurchaseStep.Paying));
  const { sheet } = h;
  try {
    await m.ctx.deps.coin.confirm(intent);
  } catch (error) {
    if (still(m, h, sheet)) await refusedPay(m, h, error);
    return;
  }
  if (still(m, h, sheet)) paid(m, h);
}

/** After Get coin: the balance checked again until it covers the price (Review), or the purchase lapses. */
async function recheckBalance(m: Machine, h: Held): Promise<void> {
  const { sheet } = h;
  const balance = await attempt(() => m.ctx.deps.coin.balance());
  if (!still(m, h, sheet)) return;
  if (balance !== null) h.balance = balance;
  if (balance !== null && !short(h)) return show(m, h, notEnough(PurchaseRecovery.Ready));
  draw(m, h);
  later(m, h, "recheck", PURCHASE_RECHECK_MS, () => recheckBalance(m, h));
}

/** After Sign in: the purchase read again until the account can read it (Review), or it lapses. */
async function recheckIntent(m: Machine, h: Held): Promise<void> {
  const { sheet } = h;
  const intent = await attempt(() => m.ctx.deps.coin.intent(h.id));
  const s = still(m, h, sheet) ? live(m, h) : null;
  if (!s) return;
  if (!intent) return later(m, h, "recheck", PURCHASE_RECHECK_MS, () => recheckIntent(m, h));
  // The account reads genex.games again: the bar is signed in too, and its Sign in no longer leaves the game.
  markSignedIn(s);
  // Signed in at last, it turns out to be another game's: it was never this game's to ask for.
  if (intent.projectId !== h.world.id) return close(m, h, QUIETLY);
  h.intent = intent;
  h.balance = await attempt(() => m.ctx.deps.coin.balance());
  if (!still(m, h, sheet)) return;
  settleOn(m, h, SETTLED[intent.status](intent) ?? signedOut(PurchaseRecovery.Ready));
}

/** Start checking again for what the sheet waits on, once. */
function recheck(m: Machine, h: Held, check: (m: Machine, h: Held) => Promise<void>): void {
  if (h.rechecking) return;
  h.rechecking = true;
  later(m, h, "recheck", PURCHASE_RECHECK_MS, () => check(m, h));
}

/** What each answer from the bar's page does to the sheet on screen. */
const ANSWERS: Record<PurchaseAnswer, (m: Machine, h: Held) => void> = {
  [PurchaseAnswer.Shown]: (m, h) => {
    h.shown = true;
    m.ctx.deps.bar.focus();
    if (h.face.step === PurchaseStep.Ask) rearm(m, h);
  },
  [PurchaseAnswer.Pay]: (m, h) => {
    if (h.face.step === PurchaseStep.Ask && h.armed) void pay(m, h);
  },
  [PurchaseAnswer.Cancel]: (m, h) => {
    if (h.face.step !== PurchaseStep.Paying) close(m, h, PLAYER_CLOSE);
  },
  [PurchaseAnswer.Back]: (m, h) => {
    if (purchaseOver(h.face)) close(m, h, PLAYER_CLOSE);
  },
  [PurchaseAnswer.GetCoin]: (m, h) => {
    if (h.face.step !== PurchaseStep.NotEnough) return;
    m.ctx.deps.openPage(playCoinPageUrl(m.ctx.deps.web));
    if (h.face.recovery === PurchaseRecovery.Waiting) recheck(m, h, recheckBalance);
  },
  [PurchaseAnswer.SignIn]: (m, h) => {
    if (h.face.step !== PurchaseStep.SignedOut || h.face.recovery !== PurchaseRecovery.Waiting) return;
    m.ctx.deps.account.signIn();
    recheck(m, h, recheckIntent);
  },
  [PurchaseAnswer.Review]: (m, h) => {
    if (reviewable(h.face) && h.intent) show(m, h, askOrShort(h));
  },
};

/** An answer from the bar's page, taken only for the sheet on screen. */
function answer(m: Machine, value: unknown): void {
  const said = readPurchaseAnswer(value);
  const h = m.held;
  if (!said || !h) return;
  if (said.sheet === h.sheet && live(m, h)) ANSWERS[said.answer](m, h);
}

/** A press in the bar's layer while Ask waits to arm, or a held key repeating, starts Pay's wait again. */
function barInput(m: Machine, input: SheetInput): void {
  const h = m.held;
  if (!shownAsk(h) || !PRESSES.has(input.type)) return;
  if (!h.armed || input.isAutoRepeat === true) rearm(m, h);
}

/** The window gained or lost focus: a click bringing it back never pays, so Pay waits again. */
function focusChanged(m: Machine): void {
  const h = m.held;
  if (shownAsk(h)) rearm(m, h);
}

/** The game's page changed or died: a purchase it asked for and nobody paid is canceled with its sheet. */
function pageLeft(m: Machine): void {
  m.reading = null;
  const h = m.held;
  if (h && payable(h.face)) close(m, h, PAGE_LEFT);
}

/** The viewer closed, or opened another game: the sheet goes with it, and an unpaid purchase is canceled. */
function drop(m: Machine): void {
  m.reading = null;
  m.cooldownUntil = 0;
  const h = m.held;
  if (!h) return;
  stopTimers(m, h);
  cancelUnpaid(m, h);
  m.held = null;
}

/** The viewer's purchase sheet over `ctx`. */
export function viewerPurchase(ctx: PurchaseContext) {
  const m: Machine = { ctx, held: null, reading: null, turns: 0, sheets: 0, cooldownUntil: 0 };
  return {
    /** The game on screen asked to pay for the purchase `intentId` (its view caught the confirm page). */
    purchase: (intentId: unknown): void => request(m, intentId),
    /** Whether the game on screen may ask to pay now: no sheet is open or being read, and no wait is running. */
    mayReserve: (): boolean => mayReserve(m),
    /** The bar's page answered the sheet; main acts only on the sheet on screen and the purchase it holds. */
    answerPurchase: (value: unknown): void => answer(m, value),
    /** A press in the bar's layer (Electron's input on its page). */
    barInput: (input: SheetInput): void => barInput(m, input),
    /** The window gained or lost focus. */
    focusChanged: (): void => focusChanged(m),
    /** The game's page committed a new document (a reload, another Genex game) or died. */
    pageLeft: (): void => pageLeft(m),
    /** The viewer closed or opened another game. */
    drop: (): void => drop(m),
  };
}

/** The sheet as `viewerPurchase` makes it. */
export type ViewerPurchase = ReturnType<typeof viewerPurchase>;
