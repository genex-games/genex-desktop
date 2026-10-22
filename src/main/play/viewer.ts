/**
 * Play's game viewer: the studio's own bar is a strip of its own across the window's top, in a layer above
 * the game's view (`PlayViewerBar.tsx`): Back, the game's name and facts, Like, Comments, Share, Invite a
 * friend, Remix, Full screen and Exit. A published game fills the window below it, never under it, and the
 * bar stays up for the whole game; only its page's full screen gives it the whole window, asked for by the
 * game or by the bar's Full screen (`bar-layout.ts`). Its Comments opens over the dimmed game
 * (`viewer-comments.ts`), and so does a game's coin purchase sheet (`viewer-purchase.ts`). Main keeps what
 * the bar shows and acts on what it asks (`studio:play.control`, `studio:play.purchase`). Holding Esc in
 * the game moves the keyboard to the bar (a tap still reaches the game: pause menus, mouse lock); Esc there
 * gives it back. A guest with no Genex account is offered a Genex account in the bar until its ×. A game in
 * voice chat gets the bar's mic switch and its menu (`mic.ts`). Electron-free: the game's view, the bar's
 * layer, the window, the clipboard, the microphone, genex.games' coin and the clock come in as deps.
 */
import { ESC_HOLD_MS, type FullScreenKey, type Rect } from "../game-full-screen.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import type { PlayBarHold } from "../../shared/play-bar.ts";
import {
  isPlayControl,
  isPlaySlug,
  PLAY_BAR_HEIGHT,
  PLAY_TITLE_MAX,
  type PlayBarState,
  PlayControl,
  PlayNote,
  type PlayPoint,
  playPageUrl,
  type PlayViewerEvent,
  PlayViewerPhase,
} from "../../shared/play.ts";
import type { PlayMicReport } from "../../shared/play-mic.ts";
import { NativeAppOffer, type PlayBarNative } from "../../shared/play-native.ts";
import { mintedTicket, type PlayGallery, type PlayWorld, SignInNeeded, TicketStatus } from "./gallery.ts";
import { BarLayout, barLayout } from "./bar-layout.ts";
import type { PlayComments } from "./comments.ts";
import { chooseMic, freshMic, heardMic, type MicSession, type PlayMicDeps, toggleMic } from "./mic.ts";
import { viewerComments } from "./viewer-comments.ts";
import { type ViewerCoin, type ViewerPurchase, viewerPurchase } from "./viewer-purchase.ts";

export type { PlayMicDeps } from "./mic.ts";

/** The longest the cover waits for the game's page to finish loading before the game is shown anyway. */
export const SHOW_GAME_AFTER_MS = 8 * SECOND_MS;
/** How long a note ("Link copied") stays in the header. */
export const NOTE_MS = 2.2 * SECOND_MS;

/** Everything the viewer moves or asks: the game's view, the window, the gallery, the clipboard and the clock. */
export interface PlayViewerDeps {
  gallery: Pick<PlayGallery, "world" | "setLiked" | "ticket" | "inviteCode">;
  /** The game's page address: its play URL carrying the sign-in ticket, or the guest marker. */
  gameUrl(slug: string, ticket: string | undefined): string;
  window: {
    contentSize(): { width: number; height: number };
    /** Show or hide the window's own buttons (macOS's traffic lights), which sit in the bar. */
    buttons(visible: boolean): void;
  };
  /** A fresh view for each game; `close` destroys it (its sound and memory go with it). */
  game: {
    /** Load `url`, the page that plays `slug`, in a new view laid at `bounds`, where it will play. */
    open(url: string, slug: string, bounds: Rect): void;
    show(bounds: Rect): void;
    hide(): void;
    focus(): void;
    /** Ask the game's page for its own full screen, as if the player had asked it: its Esc and the bar's return follow. */
    fullScreen(): void;
    close(): void;
  };
  /** The bar's layer above the game's view: where it lies, and the keyboard (the game lets go of the mouse). */
  bar: {
    show(bounds: Rect): void;
    hide(): void;
    focus(): void;
    /** Whether the layer's page has the keyboard. */
    focused(): boolean;
    /** Make the layer and load its page ahead of the first game, so the bar is there as it opens. */
    warm(): void;
    /** Load the layer's page again, if it has one: it reads the app's words when it loads. */
    reload(): void;
  };
  /** The game's comments on genex.games. */
  comments: Pick<PlayComments, "list" | "post" | "remove">;
  /** genex.games' coin, for a game's purchase sheet: the purchase and the balance read, a payment confirmed or canceled. */
  coin: ViewerCoin;
  /** The app's Genex account: the purchase sheet's Sign in signs in to it in the browser. */
  account: { signIn(): void };
  /** Open a genex.games page in the browser (the purchase sheet's Get coin); a fixture launch opens nothing. */
  openPage(url: string): void;
  clipboard(text: string): void;
  /** The website Play links to: Share and Invite copy the game's page there. */
  web: string;
  emit(event: PlayViewerEvent): void;
  clock: { setTimeout(run: () => void, ms: number): unknown; clearTimeout(handle: unknown): void; now(): number };
  /** The game's voice chat: the system, the page's microphone, the menu and what is remembered. */
  mic: PlayMicDeps;
  /** A web game's native app on this computer (`PlayControl.NativeApp`); none where Genex plays no native game. */
  nativeApp?: {
    /** What the bar offers for `slug`'s app, or null when this computer has none. */
    offer(slug: string): Promise<PlayBarNative | null>;
    /** Install it, or play it in its own window. */
    press(slug: string): Promise<void>;
  };
}

interface Session {
  slug: string;
  title: string;
  /** Bumped on every open, so an answer for an earlier game is dropped. */
  epoch: number;
  phase: PlayViewerPhase;
  world: PlayWorld | null;
  /** The game's page facts on their way: Comments waits for the game's id. */
  worldRead: Promise<PlayWorld | null>;
  state: PlayBarState;
  /** A like is on its way: another press waits for it. */
  liking: boolean;
  /** No Genex account was unlocked when the game opened: it plays as a guest who may install Genex. */
  signedOut: boolean;
  mic: MicSession;
}

const IDLE_STATE: PlayBarState = {
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
  signedIn: null,
  remixing: false,
  nativeApp: null,
  purchase: null,
};

type Clock = PlayViewerDeps["clock"];

/** A timer that may be running: clearing it stops it, and answers the cleared handle. */
const stop = (clock: Clock, timer: unknown): null => {
  if (timer !== null) clock.clearTimeout(timer);
  return null;
};

/** Esc held for `ESC_HOLD_MS` calls `onHeld`; a shorter press, or one that repeats, does nothing. */
function heldEscape(clock: Clock, onHeld: () => void) {
  let timer: unknown = null;
  return {
    key(input: FullScreenKey): void {
      if (input.key !== "Escape") return;
      if (input.type === "keyUp") timer = stop(clock, timer);
      if (input.type !== "keyDown" || input.isAutoRepeat || timer !== null) return;
      timer = clock.setTimeout(() => {
        timer = null;
        onHeld();
      }, ESC_HOLD_MS);
    },
    clear(): void {
      timer = stop(clock, timer);
    },
  };
}

/** What a closing tells the app beyond the closing itself: Genex to install, a remix to make, a profile to show. */
type ClosedNews = Pick<PlayViewerEvent, "install" | "remix" | "profile">;

/** What the header's actions share: the session they act for and how they report back. */
interface ViewerContext {
  deps: PlayViewerDeps;
  session(): Session | null;
  /** The session, if it is still the one opened as `epoch`. */
  current(epoch: number): Session | null;
  /** Tell the app how the header looks now. */
  draw(): void;
  /** Comments or a purchase sheet covers the window: the keyboard stays with the bar's layer. */
  covering(): boolean;
  /** Where the game's view goes now: below the bar, or the whole window while its page is full screen. */
  gameBounds(): Rect;
  note(value: PlayNote | null): void;
  close(news?: ClosedNews): void;
}

/** Like or unlike at once, keep what the server answers, and take it back with a note when it cannot be saved. */
async function toggleLike(ctx: ViewerContext): Promise<void> {
  const s = ctx.session();
  if (!s?.world || s.liking) return;
  const before = s.state;
  const liked = !before.liked;
  s.liking = true;
  s.state = { ...before, liked, likes: Math.max(0, before.likes + (liked ? 1 : -1)), note: null };
  ctx.draw();
  try {
    const saved = await ctx.deps.gallery.setLiked(s.world.id, liked);
    if (ctx.current(s.epoch)) s.state = { ...s.state, liked: saved.liked, likes: saved.likes };
    ctx.draw();
  } catch (error) {
    if (!ctx.current(s.epoch)) return;
    s.state = { ...s.state, liked: before.liked, likes: before.likes };
    ctx.note(error instanceof SignInNeeded ? PlayNote.SignIn : PlayNote.LikeFailed);
  } finally {
    s.liking = false;
  }
}

/** Copy the game's page with the player's referral code on it (the page alone when signed out). */
async function copyInvite(ctx: ViewerContext): Promise<void> {
  const s = ctx.session();
  if (!s) return;
  // A code that can't be read leaves the page alone, as signed out.
  const code = await ctx.deps.gallery.inviteCode().catch(() => undefined);
  if (!ctx.current(s.epoch)) return;
  const page = playPageUrl(ctx.deps.web, s.slug);
  ctx.deps.clipboard(code ? `${page}?ref=${encodeURIComponent(code)}` : page);
  ctx.note(PlayNote.InviteCopied);
}

/** The header's state once the game's page facts are read. */
const withWorld = (state: PlayBarState, world: PlayWorld): PlayBarState => ({
  ...state,
  liked: world.liked,
  likes: world.likes,
  remixable: world.remixable,
  multiplayer: world.multiplayer,
  facts: { author: world.author, authorId: world.authorId, plays: world.plays, online: world.online },
  comments: world.comments,
});

/**
 * Load the game opened as `epoch`: its page once a sign-in ticket is minted (or known not to be),
 * shown after `SHOW_GAME_AFTER_MS` even if it has not finished loading; its page facts for the
 * header arrive beside it and never hold the game up.
 */
async function loadGame(ctx: ViewerContext, epoch: number, showAnyway: () => void): Promise<unknown> {
  const s = ctx.current(epoch);
  if (!s) return null;
  const { gallery } = ctx.deps;
  s.worldRead = gallery.world(s.slug).then(
    (world) => {
      const live = ctx.current(epoch);
      if (!live) return null;
      live.world = world;
      live.state = withWorld(live.state, world);
      ctx.draw();
      return world;
    },
    () => null,
  );
  void readNativeApp(ctx, epoch);
  const ticket = await gallery.ticket(s.slug);
  if (!ctx.current(epoch)) return null;
  // Only a missing account earns the guest card: a ticket the account could not mint is no reason to install Genex.
  s.signedOut = ticket.status === TicketStatus.SignedOut;
  s.state = { ...s.state, signedIn: !s.signedOut };
  ctx.draw();
  ctx.deps.game.open(ctx.deps.gameUrl(s.slug, mintedTicket(ticket)), s.slug, ctx.gameBounds());
  return ctx.deps.clock.setTimeout(showAnyway, SHOW_GAME_AFTER_MS);
}

/** What the bar offers for the game opened as `epoch`'s native app, read again whenever an install changes. */
async function readNativeApp(ctx: ViewerContext, epoch: number): Promise<void> {
  const s = ctx.current(epoch);
  const native = ctx.deps.nativeApp;
  if (!s || !native) return;
  const offer = await native.offer(s.slug).catch(() => null);
  const live = ctx.current(epoch);
  if (!live) return;
  live.state = { ...live.state, nativeApp: offer };
  ctx.draw();
}

/**
 * The native-app pill pressed: install the app, or play it, the viewer giving way first (one copy
 * of a game at a time). Nothing while it installs.
 */
function pressNativeApp(ctx: ViewerContext): void {
  const s = ctx.session();
  const native = ctx.deps.nativeApp;
  const offer = s?.state.nativeApp?.offer;
  if (!s || !native || !offer || offer === NativeAppOffer.Installing) return;
  if (offer === NativeAppOffer.Ready) ctx.close();
  void native.press(s.slug).catch(() => undefined);
}

/** Offer a signed-out guest a Genex account in the header, until its × or the game closes. */
function offerGuestCard(ctx: ViewerContext, s: Session): void {
  if (!s.signedOut) return;
  s.state = { ...s.state, guestCard: true };
  ctx.draw();
}

/** Take the guest card away; it is offered once per game, so it stays away. */
function dropGuestCard(ctx: ViewerContext, s: Session): void {
  if (!s.state.guestCard || !ctx.current(s.epoch)) return;
  s.state = { ...s.state, guestCard: false };
  ctx.draw();
}

/** Where the game's view goes: the window below the bar's strip, or all of it while its page is full screen. */
function gameBounds(deps: PlayViewerDeps, fullScreen: boolean): Rect {
  const { width, height } = deps.window.contentSize();
  if (fullScreen) return { x: 0, y: 0, width, height };
  const top = Math.min(height, PLAY_BAR_HEIGHT);
  return { x: 0, y: top, width, height: height - top };
}

/** Where the bar's layer goes for `layout`: its strip across the top, or the whole window for Comments. */
function barBounds(deps: PlayViewerDeps, layout: BarLayout): Rect {
  const { width, height } = deps.window.contentSize();
  return { x: 0, y: 0, width, height: layout === BarLayout.Full ? height : Math.min(height, PLAY_BAR_HEIGHT) };
}

/** A game's name as the bar shows it: a line of text, cut to {@link PLAY_TITLE_MAX}. */
const barTitle = (title: unknown): string =>
  typeof title === "string" ? title.replace(/\s+/g, " ").trim().slice(0, PLAY_TITLE_MAX) : "";

/**
 * An Esc held in the game: the keyboard moves to the bar, so a game holding the mouse lets go and
 * Tab reaches Exit. Only once the game is on screen; before that Esc is the app's.
 */
function focusBarByKeyboard(ctx: ViewerContext): void {
  const s = ctx.session();
  if (s?.phase !== PlayViewerPhase.Playing) return;
  ctx.deps.bar.focus();
  ctx.deps.emit({ slug: s.slug, openId: s.epoch, phase: s.phase, focusBar: true });
}

/** What each of the header's controls does; a menu opens at `at`. */
function barActions(ctx: ViewerContext): Record<PlayControl, (at?: PlayPoint) => void> {
  return {
    [PlayControl.Back]: () => ctx.close(),
    [PlayControl.Exit]: () => ctx.close(),
    [PlayControl.Like]: () => void toggleLike(ctx),
    [PlayControl.Share]: () => {
      const s = ctx.session();
      if (!s) return;
      ctx.deps.clipboard(playPageUrl(ctx.deps.web, s.slug));
      ctx.note(PlayNote.Copied);
    },
    [PlayControl.Invite]: () => void copyInvite(ctx),
    // The app makes the copy, as a card's (`studio:play.remix`); the viewer gives way to it.
    [PlayControl.Remix]: () => {
      const state = ctx.session()?.state;
      if (state?.remixable && !state.remixing) ctx.close({ remix: true });
    },
    [PlayControl.Maker]: () => {
      const maker = ctx.session()?.world?.authorId;
      if (maker) ctx.close({ profile: maker });
    },
    [PlayControl.Install]: () => {
      if (ctx.session()?.signedOut) ctx.close({ install: true });
    },
    [PlayControl.DismissCard]: () => {
      const s = ctx.session();
      if (s) dropGuestCard(ctx, s);
    },
    // The keyboard goes back to the game once it is on screen; while it loads, or while Comments or a
    // purchase sheet covers it, it stays where it is.
    [PlayControl.Resume]: () => {
      if (ctx.session()?.phase === PlayViewerPhase.Playing && !ctx.covering()) ctx.deps.game.focus();
    },
    [PlayControl.Mic]: () => void toggleMic(ctx).catch(() => ctx.note(PlayNote.MicFailed)),
    [PlayControl.NativeApp]: () => pressNativeApp(ctx),
    [PlayControl.MicDevices]: (at) => chooseMic(ctx, at),
    // Only a game on screen, with nothing over it, has a page to fill the window with.
    [PlayControl.FullScreen]: () => {
      if (ctx.session()?.phase === PlayViewerPhase.Playing && !ctx.covering()) ctx.deps.game.fullScreen();
    },
  };
}

/** A game just opened: loading, nothing read about it yet, its mic switch as it was left. */
const freshSession = (slug: string, title: string, epoch: number, micOn: boolean, remixing: boolean): Session => ({
  slug,
  title,
  epoch,
  phase: PlayViewerPhase.Loading,
  world: null,
  worldRead: Promise.resolve(null),
  state: { ...IDLE_STATE, title, remixing },
  liking: false,
  signedOut: false,
  mic: freshMic(micOn),
});

/** Put the bar's layer where `layout` says, with the window's own buttons shown only while it is. */
function placeBar(deps: PlayViewerDeps, layout: BarLayout): void {
  if (layout === BarLayout.Hidden) deps.bar.hide();
  else deps.bar.show(barBounds(deps, layout));
  deps.window.buttons(layout !== BarLayout.Hidden);
}

/** Place the bar's layer; put away during play while it holds the keyboard (a menu it opened, say), it gives it back to the game. */
function placeBarInPlay(deps: PlayViewerDeps, layout: BarLayout, playing: boolean): void {
  const handBack = layout === BarLayout.Hidden && playing && deps.bar.focused();
  placeBar(deps, layout);
  if (handBack) deps.game.focus();
}

/** What the bar's layer says, as main accepts it: booleans, anything else false. */
const readHold = (value: unknown): PlayBarHold => {
  const hold = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return { comments: hold.comments === true, ready: hold.ready === true };
};

/**
 * The bar's layer laid over the window for the viewer's session. The context comes later than the
 * layout, so it is asked for when the layer moves.
 */
function layBar(deps: PlayViewerDeps, viewer: () => ViewerContext) {
  return barLayout({
    place: (layout) => placeBarInPlay(deps, layout, viewer().session()?.phase === PlayViewerPhase.Playing),
  });
}

/** What the viewer's own loop moves beyond the context: the bar's layer, its phase and its timers. */
interface ViewerLoop {
  ctx: ViewerContext;
  layer: ReturnType<typeof barLayout>;
  /** A game's coin purchase sheet. */
  purchases: ViewerPurchase;
  setPhase(phase: PlayViewerPhase): void;
  stopShowTimer(): void;
}

/**
 * The bar's layer said whether Comments is open: opening takes the keyboard, closing gives it back to
 * the game unless a purchase sheet still covers it. A page that has just mounted is drawn the bar
 * again, whatever news it missed loading.
 */
function holdBar(loop: ViewerLoop, value: unknown): void {
  const s = loop.ctx.session();
  if (!s) return;
  const next = readHold(value);
  if (next.ready) loop.ctx.draw();
  const was = loop.layer.comments();
  loop.layer.hold(next);
  if (next.comments && !was) loop.ctx.deps.bar.focus();
  const closedOverGame = !next.comments && was && s.phase === PlayViewerPhase.Playing;
  if (closedOverGame && !loop.layer.covering()) loop.ctx.deps.game.focus();
}

/** What the viewer answers beyond opening and closing: its view's news, the bar's asks and the window. */
function viewerCalls(loop: ViewerLoop, heldEsc: ReturnType<typeof heldEscape>) {
  const { ctx, layer, purchases } = loop;
  const { deps } = ctx;
  const actions = barActions(ctx);
  const playing = () => ctx.session()?.phase === PlayViewerPhase.Playing;
  return {
    /**
     * The game's page finished loading: it takes the window under the bar, and the keyboard unless
     * Comments or a purchase sheet has it.
     */
    loaded: (): void => {
      if (ctx.session()?.phase !== PlayViewerPhase.Loading) return;
      loop.stopShowTimer();
      loop.setPhase(PlayViewerPhase.Playing);
      if (!layer.covering()) deps.game.focus();
    },
    /** The game's page could not load, or its renderer went away: an unpaid purchase sheet goes with it. */
    failed: (): void => {
      loop.stopShowTimer();
      loop.setPhase(PlayViewerPhase.Failed);
      purchases.pageLeft();
    },
    /** The game's page committed a new document (it reloaded, or moved to another Genex game). */
    navigated: (): void => purchases.pageLeft(),
    /** A control the bar asked for; a menu opens at `at`. */
    control: (value: unknown, at?: PlayPoint): void => {
      if (ctx.session() && isPlayControl(value)) actions[value](at);
    },
    /** Whether the bar's Comments is open, and whether its page has just mounted. */
    hold: (value: unknown): void => holdBar(loop, value),
    /** The game's page said how its microphone is. */
    mic: (report: PlayMicReport): void => heardMic(ctx, report),
    /** A key pressed in the game's view: Esc held there gives the bar the keyboard. */
    key: (input: FullScreenKey): void => {
      if (ctx.session()) heldEsc.key(input);
    },
    /**
     * The game's page took the screen in full screen, or gave it back: it has the whole window
     * meanwhile, and the bar's strip comes back after.
     */
    fullScreen: (on: boolean): void => {
      if (!ctx.session()) return;
      layer.fullScreen(on);
      if (playing()) deps.game.show(ctx.gameBounds());
    },
    /** The window changed size: the game and the bar follow. */
    resized: (): void => {
      if (playing()) deps.game.show(ctx.gameBounds());
      if (ctx.session() && layer.layout() !== BarLayout.Hidden) deps.bar.show(barBounds(deps, layer.layout()));
    },
    ...viewerComments(ctx),
    /** An install changed: the bar's native-app pill reads what it offers again. */
    nativeChanged: (): void => {
      const s = ctx.session();
      if (s) void readNativeApp(ctx, s.epoch);
    },
    purchase: purchases.purchase,
    mayReserve: purchases.mayReserve,
    answerPurchase: purchases.answerPurchase,
    barInput: purchases.barInput,
    focusChanged: purchases.focusChanged,
    /** The slug on screen, or null. */
    showing: (): string | null => ctx.session()?.slug ?? null,
  };
}

/** The viewer over `deps`. */
export function playViewer(deps: PlayViewerDeps) {
  const { game, clock } = deps;
  let session: Session | null = null;
  let epoch = 0;
  let showTimer: unknown = null;
  let noteTimer: unknown = null;
  /** Remixes being made: the bar's Remix waits for them. */
  let remixes = 0;

  const layer = layBar(deps, () => ctx);
  const setPhase = (phase: PlayViewerPhase): void => {
    if (!session || session.phase === phase) return;
    session.phase = phase;
    if (phase === PlayViewerPhase.Failed) game.hide();
    if (phase === PlayViewerPhase.Playing) game.show(ctx.gameBounds());
    deps.emit({ slug: session.slug, openId: session.epoch, phase });
    if (phase === PlayViewerPhase.Playing) offerGuestCard(ctx, session);
  };
  const close = (news: ClosedNews = {}): void => {
    if (!session) return;
    const { slug, epoch: openId } = session;
    session = null;
    showTimer = stop(clock, showTimer);
    noteTimer = stop(clock, noteTimer);
    heldEsc.clear();
    loop.purchases.drop();
    layer.close();
    deps.window.buttons(true);
    game.close();
    deps.emit({ slug, openId, phase: PlayViewerPhase.Closed, ...news });
  };
  const ctx: ViewerContext = {
    deps,
    session: () => session,
    current: (at) => (session && session.epoch === at ? session : null),
    draw: () => {
      if (session) deps.emit({ slug: session.slug, openId: session.epoch, phase: session.phase, bar: session.state });
    },
    covering: () => layer.covering(),
    gameBounds: () => gameBounds(deps, layer.isFullScreen()),
    note: (value) => {
      if (!session) return;
      noteTimer = stop(clock, noteTimer);
      session.state = { ...session.state, note: value };
      ctx.draw();
      if (value) noteTimer = clock.setTimeout(() => ctx.note(null), NOTE_MS);
    },
    close,
  };

  const open = (slug: string, title?: unknown): void => {
    if (!isPlaySlug(slug)) return;
    if (session) close();
    epoch += 1;
    const opened = epoch;
    layer.opened();
    session = freshSession(slug, barTitle(title), opened, deps.mic.store.on(slug), remixes > 0);
    // The first news of the opening: loading, with the bar as it starts.
    ctx.draw();
    void loadGame(ctx, opened, () => {
      showTimer = null;
      if (ctx.current(opened)?.phase === PlayViewerPhase.Loading) setPhase(PlayViewerPhase.Playing);
    }).then(
      (timer) => {
        if (timer !== null) showTimer = timer;
      },
      // No ticket read, or no window to open the game in: the game failed, never loading for good.
      () => {
        if (ctx.current(opened)) setPhase(PlayViewerPhase.Failed);
      },
    );
  };
  const heldEsc = heldEscape(clock, () => focusBarByKeyboard(ctx));
  const loop: ViewerLoop = {
    ctx,
    layer,
    purchases: viewerPurchase({ ...ctx, layer }),
    setPhase,
    stopShowTimer: () => (showTimer = stop(clock, showTimer)),
  };

  return {
    open,
    close: () => close(),
    /** Play's dashboard is open: the bar's layer gets ready for the first game. */
    warm: (): void => deps.bar.warm(),
    /** The app's language changed: the bar's page loads again in it, and says it is ready as a late page does. */
    languageChanged: (): void => deps.bar.reload(),
    /** A remix began or ended (a card's, or the viewer's own): the bar's Remix waits while one is made. */
    remixing: (on: boolean): void => {
      remixes = Math.max(0, remixes + (on ? 1 : -1));
      if (!session) return;
      session.state = { ...session.state, remixing: remixes > 0 };
      ctx.draw();
    },
    ...viewerCalls(loop, heldEsc),
  };
}

/** The viewer as `playViewer` makes it. */
export type PlayViewer = ReturnType<typeof playViewer>;
