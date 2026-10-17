/**
 * Play's game viewer: a published game fills the window under the studio's own header, which the
 * app draws above the game's view (`PlayViewerBar.tsx`): Back, the game's name and facts, Like,
 * Share, Invite a friend, Remix and Exit. Main keeps what the header shows and acts on what it asks
 * (`studio:play.control`). Holding Esc in the game moves the keyboard to the header (a tap still
 * reaches the game: pause menus, mouse lock); Esc there gives it back. A guest with no Genex account
 * is offered a Genex account in the header until its ×. A game in voice chat gets the header's mic
 * switch and its menu (`mic.ts`). Electron-free: the game's view, the window, the clipboard, the
 * microphone and the clock come in as deps.
 */
import { ESC_HOLD_MS, type FullScreenKey, type Rect } from "../game-full-screen.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import {
  isPlayControl,
  isPlaySlug,
  PLAY_BAR_HEIGHT,
  type PlayBarState,
  PlayControl,
  PlayNote,
  type PlayPoint,
  playPageUrl,
  type PlayViewerEvent,
  PlayViewerPhase,
} from "../../shared/play.ts";
import type { PlayMicReport } from "../../shared/play-mic.ts";
import { mintedTicket, type PlayGallery, type PlayWorld, SignInNeeded, TicketStatus } from "./gallery.ts";
import { chooseMic, freshMic, heardMic, type MicSession, type PlayMicDeps, toggleMic } from "./mic.ts";

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
  window: { contentSize(): { width: number; height: number } };
  /** A fresh view for each game; `close` destroys it (its sound and memory go with it). */
  game: {
    /** Load `url`, the page that plays `slug`, in a new view. */
    open(url: string, slug: string): void;
    show(bounds: Rect): void;
    hide(): void;
    focus(): void;
    close(): void;
  };
  /** Give the keyboard to the app's own page, where the header is (the game lets go of the mouse). */
  focusApp(): void;
  clipboard(text: string): void;
  /** The website Play links to: Share and Invite copy the game's page there. */
  web: string;
  emit(event: PlayViewerEvent): void;
  clock: { setTimeout(run: () => void, ms: number): unknown; clearTimeout(handle: unknown): void };
  /** The game's voice chat: the system, the page's microphone, the menu and what is remembered. */
  mic: PlayMicDeps;
}

interface Session {
  slug: string;
  /** Bumped on every open, so an answer for an earlier game is dropped. */
  epoch: number;
  phase: PlayViewerPhase;
  world: PlayWorld | null;
  state: PlayBarState;
  /** A like is on its way: another press waits for it. */
  liking: boolean;
  /** No Genex account was unlocked when the game opened: it plays as a guest who may install Genex. */
  signedOut: boolean;
  mic: MicSession;
}

const IDLE_STATE: PlayBarState = {
  liked: false,
  likes: 0,
  remixable: false,
  note: null,
  guestCard: false,
  facts: null,
  mic: null,
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

/** What a closing tells the app beyond the closing itself: Genex to install. */
type ClosedNews = Pick<PlayViewerEvent, "install">;

/** What the header's actions share: the session they act for and how they report back. */
interface ViewerContext {
  deps: PlayViewerDeps;
  session(): Session | null;
  /** The session, if it is still the one opened as `epoch`. */
  current(epoch: number): Session | null;
  /** Tell the app how the header looks now. */
  draw(): void;
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
  facts: { author: world.author, authorId: world.authorId, plays: world.plays, online: world.online },
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
  gallery.world(s.slug).then(
    (world) => {
      const live = ctx.current(epoch);
      if (!live) return;
      live.world = world;
      live.state = withWorld(live.state, world);
      ctx.draw();
    },
    () => undefined,
  );
  const ticket = await gallery.ticket(s.slug);
  if (!ctx.current(epoch)) return null;
  // Only a missing account earns the guest card: a ticket the account could not mint is no reason to install Genex.
  s.signedOut = ticket.status === TicketStatus.SignedOut;
  ctx.deps.game.open(ctx.deps.gameUrl(s.slug, mintedTicket(ticket)), s.slug);
  return ctx.deps.clock.setTimeout(showAnyway, SHOW_GAME_AFTER_MS);
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

/** Where the game's view goes: under the header, across the rest of the window. */
function gameBounds(deps: PlayViewerDeps): Rect {
  const { width, height } = deps.window.contentSize();
  return { x: 0, y: PLAY_BAR_HEIGHT, width, height: Math.max(0, height - PLAY_BAR_HEIGHT) };
}

/**
 * An Esc held in the game: the keyboard moves to the app's header, so a game holding the mouse lets
 * go and Tab reaches Exit. Only once the game is on screen; before that Esc is the app's.
 */
function focusBarByKeyboard(ctx: ViewerContext): void {
  const s = ctx.session();
  if (s?.phase !== PlayViewerPhase.Playing) return;
  ctx.deps.focusApp();
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
    [PlayControl.Remix]: () => ctx.close(),
    [PlayControl.Install]: () => {
      if (ctx.session()?.signedOut) ctx.close({ install: true });
    },
    [PlayControl.DismissCard]: () => {
      const s = ctx.session();
      if (s) dropGuestCard(ctx, s);
    },
    // The keyboard goes back to the game once it is on screen; while it loads, it stays with the app.
    [PlayControl.Resume]: () => {
      if (ctx.session()?.phase === PlayViewerPhase.Playing) ctx.deps.game.focus();
    },
    [PlayControl.Mic]: () => void toggleMic(ctx).catch(() => ctx.note(PlayNote.MicFailed)),
    [PlayControl.MicDevices]: (at) => chooseMic(ctx, at),
  };
}

/** A game just opened: loading, nothing read about it yet, its mic switch as it was left. */
const freshSession = (slug: string, epoch: number, micOn: boolean): Session => ({
  slug,
  epoch,
  phase: PlayViewerPhase.Loading,
  world: null,
  state: { ...IDLE_STATE },
  liking: false,
  signedOut: false,
  mic: freshMic(micOn),
});

/** The viewer over `deps`. */
export function playViewer(deps: PlayViewerDeps) {
  const { game, clock } = deps;
  let session: Session | null = null;
  let epoch = 0;
  let showTimer: unknown = null;
  let noteTimer: unknown = null;

  const place = (): void => {
    if (session?.phase === PlayViewerPhase.Playing) game.show(gameBounds(deps));
  };
  const setPhase = (phase: PlayViewerPhase): void => {
    if (!session || session.phase === phase) return;
    session.phase = phase;
    if (phase === PlayViewerPhase.Failed) game.hide();
    place();
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
    note: (value) => {
      if (!session) return;
      noteTimer = stop(clock, noteTimer);
      session.state = { ...session.state, note: value };
      ctx.draw();
      if (value) noteTimer = clock.setTimeout(() => ctx.note(null), NOTE_MS);
    },
    close,
  };

  const open = (slug: string): void => {
    if (!isPlaySlug(slug)) return;
    if (session) close();
    epoch += 1;
    const opened = epoch;
    session = freshSession(slug, opened, deps.mic.store.on(slug));
    // The first news of the opening: loading, with the header as it starts.
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
  const actions = barActions(ctx);
  const heldEsc = heldEscape(clock, () => focusBarByKeyboard(ctx));

  return {
    open,
    close: () => close(),
    /** The game's page finished loading: it takes the window under the header. */
    loaded: (): void => {
      if (session?.phase !== PlayViewerPhase.Loading) return;
      showTimer = stop(clock, showTimer);
      setPhase(PlayViewerPhase.Playing);
      game.focus();
    },
    /** The game's page could not load, or its renderer went away. */
    failed: (): void => {
      showTimer = stop(clock, showTimer);
      setPhase(PlayViewerPhase.Failed);
    },
    /** A control the header asked for; a menu opens at `at`. */
    control: (value: unknown, at?: PlayPoint): void => {
      if (session && isPlayControl(value)) actions[value](at);
    },
    /** The game's page said how its microphone is. */
    mic: (report: PlayMicReport): void => heardMic(ctx, report),
    /** A key pressed in the game's view: a held Esc moves the keyboard to the header. */
    key: (input: FullScreenKey): void => {
      if (session) heldEsc.key(input);
    },
    /** The window changed size: the game follows. */
    resized: place,
    /** The slug on screen, or null. */
    showing: (): string | null => session?.slug ?? null,
  };
}

/** The viewer as `playViewer` makes it. */
export type PlayViewer = ReturnType<typeof playViewer>;
